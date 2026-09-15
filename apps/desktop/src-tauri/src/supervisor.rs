//! Supervision of the `dsh --profile desktop` child process: profile and runtime
//! resolution, readiness, the post-readiness crash watch, and tree teardown.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// The readiness line prefix that `dsh web` prints once the server can serve.
pub const LAUNCH_LINE_PREFIX: &str = "dsh web: ";
/// Upper bound on dsh boot.
const READY_TIMEOUT_MS: u64 = 180_000;
/// Grace period between the process-group signal and the forced kill.
const KILL_GRACE_MS: u64 = 3_000;
/// Poll interval while waiting for a killed child to disappear.
const KILL_POLL_MS: u64 = 50;
/// Probe interval of the crashed-server watch.
const WATCH_POLL_MS: u64 = 500;
/// Directory name of the bundled runtime inside the application resources.
/// Directory inside the application resources that carries the runtime.
pub const RUNTIME_DIRECTORY: &str = "desktop-runtime";
/// Shell core entry the bundled Node.js executable runs.
const SHELL_CORE_FILE: &str = "shell-core.js";

/// One packaged Host launch the shell can carry.
pub struct HostLaunch {
    /// Bundled upstream Node.js executable.
    pub node: PathBuf,
    /// Shell core script the shell spawns to parent the installed Host.
    pub entry: PathBuf,
    /// Immutable dsh packages carried by the application.
    pub runtime_dir: PathBuf,
    /// Active desktop plugin profile.
    pub project_dir: PathBuf,
    /// Whether the Host accepts a profile whose packages are linked rather than
    /// installed, which is the case for a development runtime tree.
    pub allow_linked: bool,
}

/**
 * Resolve the packaged Host when the application carries one.
 * @param app - shell handle used for the resource directory.
 * @returns the launch description, or nothing when no packaged runtime is present.
 */
pub fn host_launch(app: &AppHandle) -> Option<HostLaunch> {
    if let Some(launch) = dev_host_launch() {
        return Some(launch);
    }
    let resource_dir = app.path().resource_dir().ok()?;
    let root = resource_dir.join(RUNTIME_DIRECTORY);
    let node = root.join("node").join(node_executable_name());
    let dsh = root.join("dsh");
    let entry = root.join(SHELL_CORE_FILE);
    if !node.exists() || !entry.exists() {
        return None;
    }
    Some(HostLaunch {
        node,
        entry,
        runtime_dir: dsh,
        project_dir: harness_home().join("profiles").join("desktop"),
        allow_linked: false,
    })
}

/// Development override for the packaged runtime.
///
/// `DSH_DESKTOP_DEV_RUNTIME` names a directory holding `dsh/node_modules` and
/// `profile/`, which `apps/desktop/scripts/dev-runtime.ts` links from the
/// workspace, so `tauri dev` exercises the same carrier the packaged
/// application uses. The optional `DSH_DESKTOP_DEV_NODE` names the Node.js
/// executable, defaulting to `node` on `PATH`; the core itself comes from the
/// package build under `apps/desktop/lib`.
fn dev_host_launch() -> Option<HostLaunch> {
    let root = std::env::var("DSH_DESKTOP_DEV_RUNTIME")
        .ok()
        .filter(|value| !value.is_empty())?;
    let root = PathBuf::from(root);
    let node = match std::env::var("DSH_DESKTOP_DEV_NODE") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(node_executable_name()),
    };
    let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("lib")
        .join(SHELL_CORE_FILE);
    if !entry.exists() {
        return None;
    }
    Some(HostLaunch {
        node,
        entry,
        runtime_dir: root.join("dsh"),
        project_dir: root.join("profile"),
        allow_linked: true,
    })
}

/**
 * The child environment for the Host: this process's environment without Node
 * resolution and package-manager overrides, plus the transport script path.
 * @param transport_script - script the Host injects into the served index.
 * @returns the environment pairs applied over the inherited environment.
 */
pub fn host_environment() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(name, _)| {
            name != "NODE_OPTIONS"
                && name != "NODE_PATH"
                && !name.starts_with("DSH_DESKTOP_")
                && !name.starts_with("npm_")
                && !name.starts_with("pnpm_")
                && !name.starts_with("corepack_")
        })
        .collect()
}

/// Supervised-child state shared by the tray, the window, and the commands.
#[derive(Default)]
pub struct AppState {
    child: Mutex<Option<Child>>,
    initial_url: Mutex<Option<url::Url>>,
    shutting_down: AtomicBool,
    run: AtomicU64,
}

impl AppState {
    /// Record the loading page a failed or exited server returns to.
    pub fn set_initial_url(&self, url: url::Url) {
        *self.initial_url.lock().unwrap() = Some(url);
    }

    /// The recorded loading page, absent before the window reports a URL.
    pub fn initial_url(&self) -> Option<url::Url> {
        self.initial_url.lock().unwrap().clone()
    }

    /// Register a freshly spawned child and open a new supervision generation.
    /// A new generation retires the watcher of the previous child.
    fn install(&self, child: Child) -> u64 {
        *self.child.lock().unwrap() = Some(child);
        self.run.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Remove the current child; the caller owns its teardown.
    fn take(&self) -> Option<Child> {
        self.child.lock().unwrap().take()
    }

    /// Mark the shell as shutting down so the crash watch stops reporting exits.
    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }
}

/// One resolved way to start the dsh application.
struct Runtime {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    /// Extra environment for the child, applied over the inherited environment.
    env: Vec<(String, String)>,
}

/// Pick the profile to boot: explicit `DSH_DESKTOP_PROFILE` wins, then the
/// `desktop` profile when it exists in the Harness home, then the shipped `web`.
pub fn resolve_profile() -> String {
    resolve_profile_from(
        std::env::var("DSH_DESKTOP_PROFILE").ok().as_deref(),
        &harness_home(),
    )
}

/// The profile-selection rule without process-global inputs.
/// @param override_value - `DSH_DESKTOP_PROFILE`, when set and non-empty.
/// @param home - Harness home holding `profiles/<name>`.
/// @returns the profile name handed to `--profile`.
pub fn resolve_profile_from(override_value: Option<&str>, _home: &Path) -> String {
    if let Some(name) = override_value {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    // The supervised CLI serves the browser Web UI, so it needs the shipped
    // `web` profile. A `desktop` profile belongs to the packaged Host, whose
    // composition turns the webserver off.
    "web".to_string()
}

/// Desktop plugin profile the Host and the plugin transactions share.
pub fn desktop_profile_dir() -> PathBuf {
    harness_home().join("profiles").join("desktop")
}

/// The shared Harness home, matching the `dsh` CLI default.
fn harness_home() -> PathBuf {
    match std::env::var("DSH_HOME") {
        Ok(home) if !home.is_empty() => PathBuf::from(home),
        _ => home_directory().join(".dsh"),
    }
}

fn home_directory() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// The bundled upstream Node.js executable and dsh package tree.
/// @param resource_dir - the application's resource directory.
/// @returns the runtime root when the packaged runtime is present.
fn packaged_runtime(resource_dir: &Path) -> Option<PathBuf> {
    let root = resource_dir.join(RUNTIME_DIRECTORY);
    let node = root.join("node").join(node_executable_name());
    let cli = root
        .join("dsh")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if node.exists() && cli.exists() {
        Some(root)
    } else {
        None
    }
}

fn node_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// Resolve the dsh application for the current installation.
///
/// The packaged runtime under the application resources wins; a built checkout
/// is the development fallback (`apps/desktop/src-tauri` → repository root).
fn resolve_runtime(app: &AppHandle) -> Result<Runtime, String> {
    let profile = resolve_profile();
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(root) = packaged_runtime(&resource_dir) {
            let node = root.join("node").join(node_executable_name());
            let cli = root
                .join("dsh")
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js");
            return Ok(Runtime {
                program: node.to_string_lossy().into_owned(),
                args: runtime_args(&cli, &profile),
                cwd: root.join("dsh"),
                env: compile_cache_env(app),
            });
        }
    }
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("the desktop shell cannot locate the repository root")?
        .to_path_buf();
    let cli_entry = repo_root.join("apps").join("cli").join("lib").join("bin.js");
    if !cli_entry.exists() {
        return Err(format!(
            "no packaged dsh runtime in the application resources, and the built CLI is missing at {}; \
             run \"pnpm run build\" in the checkout or package the runtime resources.",
            cli_entry.display()
        ));
    }
    Ok(Runtime {
        program: "node".into(),
        args: runtime_args(&cli_entry, &profile),
        cwd: repo_root,
        env: compile_cache_env(app),
    })
}

fn runtime_args(cli: &Path, profile: &str) -> Vec<String> {
    vec![
        cli.to_string_lossy().into_owned(),
        "--profile".into(),
        profile.to_string(),
        "--no-open".into(),
        "--port".into(),
        "0".into(),
    ]
}

/// Seed the V8 compile cache under the application cache directory. A missing
/// cache directory only costs boot time, so a failure to resolve it is silent.
fn compile_cache_env(app: &AppHandle) -> Vec<(String, String)> {
    match app.path().app_cache_dir() {
        Ok(cache) => {
            let directory = cache.join("node-compile-cache");
            let _ = std::fs::create_dir_all(&directory);
            vec![(
                "NODE_COMPILE_CACHE".into(),
                directory.to_string_lossy().into_owned(),
            )]
        }
        Err(_) => Vec::new(),
    }
}

/// Start one supervised child and resolve once it announces readiness.
/// @param app - shell handle used for state, resources, and the cache directory.
/// @returns the authenticated URL the server announced.
pub fn start(app: &AppHandle) -> Result<String, String> {
    let runtime = resolve_runtime(app)?;
    boot_log("spawning dsh");
    let mut command = Command::new(&runtime.program);
    command
        .args(&runtime.args)
        .current_dir(&runtime.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in &runtime.env {
        command.env(name, value);
    }
    // A process group lets the POSIX teardown signal the whole tree by negated pid.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn dsh: {e}"))?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let pid = child.id();
    let state = app.state::<AppState>();
    let generation = state.install(child);

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    boot_log(&line);
                    if let Some(url) = parse_launch_line(&line) {
                        let _ = tx.send(Ok(url));
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("stdout read error: {e}")));
                    return;
                }
            }
        }
        let _ = tx.send(Err("dsh exited before readiness".into()));
    });

    let url = match rx.recv_timeout(Duration::from_millis(READY_TIMEOUT_MS)) {
        Ok(Ok(url)) => url,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(format!(
                "dsh did not report readiness within {READY_TIMEOUT_MS}ms"
            ))
        }
    };
    watch(app.clone(), generation, pid);
    Ok(url)
}

/// Observe the child until it exits or the shell replaces it.
///
/// The watch reports an exit only for the generation it was opened for and only
/// while the shell is not shutting down, so a restart or quit is not a failure.
fn watch(app: AppHandle, generation: u64, pid: u32) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(WATCH_POLL_MS));
        let state = app.state::<AppState>();
        if state.run.load(Ordering::SeqCst) != generation {
            return;
        }
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let exited = {
            let mut guard = state.child.lock().unwrap();
            match guard.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => return,
            }
        };
        if exited {
            let _ = state.take();
            state.run.fetch_add(1, Ordering::SeqCst);
            boot_log(&format!("dsh exited unexpectedly (pid {pid})"));
            crate::shell::report_failure(
                &app,
                "The dsh server stopped. Use Restart dsh to start it again.",
            );
            return;
        }
    });
}

/// Stop the supervised child and its whole tree.
///
/// win32 kills the tree with `taskkill /T /F`; POSIX signals the child's own
/// process group and escalates to SIGKILL once the grace period expires.
pub fn stop(app: &AppHandle) {
    let child = match app.state::<AppState>().take() {
        Some(child) => child,
        None => return,
    };
    let mut child = child;
    kill_process_tree(child.id());
    let deadline = std::time::Instant::now() + Duration::from_millis(KILL_GRACE_MS);
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(KILL_POLL_MS)),
            Err(_) => break,
        }
    }
    force_kill(&mut child);
}

/// Parse one `dsh web` stdout line into the authenticated URL.
///
/// Only the announce line carries `?token=…`; other `dsh web:` lines are not
/// the readiness signal.
/// @param line - one stdout line of the supervised process.
/// @returns the announced URL when the line is the readiness signal.
pub fn parse_launch_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix(LAUNCH_LINE_PREFIX)?;
    let first_token = rest.trim().split_whitespace().next()?;
    if first_token.is_empty() {
        return None;
    }
    let url = url::Url::parse(first_token).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.query_pairs().any(|(k, _)| k == "token") {
        return None;
    }
    Some(url.to_string())
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        // The child leads its own process group, so the negated pid addresses
        // the whole tree.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
}

fn force_kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

static BOOT_T0: OnceLock<std::time::Instant> = OnceLock::new();

/// Trace one boot stage to stderr with seconds since the first stamp.
pub fn boot_log(stage: &str) {
    let t0 = BOOT_T0.get_or_init(std::time::Instant::now);
    eprintln!("[desktop] {stage} at {:.1}s", t0.elapsed().as_secs_f64());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_authenticated_announce_line() {
        let line = "dsh web: http://127.0.0.1:52123/?token=abc.def (press Ctrl+C to stop)";
        assert_eq!(
            parse_launch_line(line).as_deref(),
            Some("http://127.0.0.1:52123/?token=abc.def")
        );
    }

    #[test]
    fn ignores_every_other_line_shape() {
        for line in [
            "dsh web: http://127.0.0.1:52123/",
            "dsh web: not-a-url?token=abc",
            "file:///tmp/index.html?token=abc",
            "dsh web: ",
            "dsh web: http://127.0.0.1:52123/ dsh web: extra?token=abc",
            "listening on http://127.0.0.1:1/?token=abc",
        ] {
            assert_eq!(parse_launch_line(line), None, "accepted {line:?}");
        }
    }

    #[test]
    fn an_explicit_profile_wins() {
        let home = PathBuf::from("/nonexistent-harness-home");
        assert_eq!(
            resolve_profile_from(Some("custom"), &home),
            "custom".to_string()
        );
    }

    #[test]
    fn an_empty_override_falls_back_to_the_shipped_profile() {
        let home = PathBuf::from("/nonexistent-harness-home");
        assert_eq!(resolve_profile_from(Some(""), &home), "web".to_string());
        assert_eq!(resolve_profile_from(None, &home), "web".to_string());
    }

    #[test]
    fn an_installed_desktop_profile_is_not_selected() {
        let home = std::env::temp_dir().join(format!("dsh-profile-test-{}", std::process::id()));
        std::fs::create_dir_all(home.join("profiles").join("desktop")).unwrap();
        assert_eq!(resolve_profile_from(None, &home), "web".to_string());
        let _ = std::fs::remove_dir_all(&home);
    }
}
