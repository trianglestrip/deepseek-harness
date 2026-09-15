//! Plugin transactions for the desktop profile.
//!
//! The replaced Electron shell ran these in its main process through
//! `DesktopProjectManager`; here the shell spawns `desktop-plugins.js`, which
//! runs the same manager against the same paths. The backend stops first, so no
//! process holds the profile files while pnpm rewrites them, and starts again
//! once the transaction reports its result.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::supervisor;

/// Filesystem the transaction writes and the executables it needs.
struct PluginRuntime {
    /// Bundled upstream Node.js executable.
    node: PathBuf,
    /// Bundled pnpm entry that `node` runs.
    pnpm: PathBuf,
    /// Installed dsh closure the profile resolves against.
    dsh: PathBuf,
    /// Project directory holding the profile manifest and its packages.
    profile: PathBuf,
    /// Transaction program the shell spawns.
    entry: PathBuf,
}

/// Transaction program inside the packaged runtime.
const PLUGIN_ENTRY_FILE: &str = "desktop-plugins.js";

/// Development runtime override, matching the shell core's.
fn dev_runtime_root() -> Option<PathBuf> {
    std::env::var("DSH_DESKTOP_DEV_RUNTIME")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// First existing development pnpm entry under the build target directories.
fn development_pnpm() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DSH_DESKTOP_DEV_PNPM") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    let targets = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join(".desktop-build")
        .join("targets");
    let candidates: &[&str] = if cfg!(windows) {
        &["win-x64", "win-arm64"]
    } else {
        &["mac-arm64", "mac-x64", "linux-x64"]
    };
    candidates
        .iter()
        .map(|target| targets.join(target).join("runtime").join("pnpm").join("bin").join("pnpm.mjs"))
        .find(|candidate| candidate.exists())
}

/// Resolve the transaction program, its executables, and the profile.
fn plugin_runtime(app: &AppHandle) -> Result<PluginRuntime, String> {
    if let Some(dev) = dev_runtime_root() {
        let node = match std::env::var("DSH_DESKTOP_DEV_NODE") {
            Ok(value) if !value.is_empty() => PathBuf::from(value),
            _ => PathBuf::from(executable_name()),
        };
        let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("desktop plugins: the application root is unavailable")?
            .join("lib")
            .join(PLUGIN_ENTRY_FILE);
        let pnpm = development_pnpm()
            .ok_or("desktop plugins: no development pnpm entry; run \"pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime\"")?;
        return Ok(PluginRuntime { node, pnpm, dsh: dev.join("dsh"), profile: dev.join("profile"), entry });
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("desktop plugins: the resources directory is unavailable: {error}"))?;
    let root = resource_dir.join(supervisor::RUNTIME_DIRECTORY);
    Ok(PluginRuntime {
        node: root.join("node").join(executable_name()),
        pnpm: root.join("pnpm").join("bin").join("pnpm.mjs"),
        dsh: root.join("dsh"),
        profile: supervisor::desktop_profile_dir(),
        entry: root.join(PLUGIN_ENTRY_FILE),
    })
}

/// Run one transaction with the backend stopped, then start the backend again.
///
/// The backend restarts whether the transaction succeeded or failed, because a
/// stopped Host leaves the application unusable.
fn run_transaction(app: &AppHandle, command: &str, args: &[String]) -> Result<Value, String> {
    let runtime = plugin_runtime(app)?;
    if !runtime.entry.exists() {
        return Err(format!("desktop plugins: {} is missing", runtime.entry.display()));
    }
    crate::shell::stop_backend(app);
    let output = Command::new(&runtime.node)
        .arg(&runtime.entry)
        .arg("--node")
        .arg(&runtime.node)
        .arg("--pnpm")
        .arg(&runtime.pnpm)
        .arg("--dsh")
        .arg(&runtime.dsh)
        .arg("--profile")
        .arg(&runtime.profile)
        .arg(command)
        .args(args)
        .output();
    crate::shell::restart(app);
    let output = output.map_err(|error| format!("desktop plugins: cannot run the transaction: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_result(&stdout).ok_or_else(|| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!(
            "desktop plugins: the transaction reported nothing usable (exit {}): {}{}",
            output.status.code().map_or_else(|| "signal".to_string(), |code| code.to_string()),
            stdout.trim(),
            stderr.trim(),
        )
    })
}

/// Read the single JSON result the transaction program prints last.
fn parse_result(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
}

/// Turn one result object into the value a page receives.
fn unwrap_result(result: Value) -> Result<Value, String> {
    match result.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(result.get("value").cloned().unwrap_or(Value::Null)),
        Some(false) => Err(result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("desktop plugins: the transaction failed")
            .to_string()),
        None => Err("desktop plugins: the transaction result has no status".to_string()),
    }
}

/// Installed desktop plugins with their activation state.
#[tauri::command]
pub fn plugins_list(app: AppHandle) -> Result<Value, String> {
    run_transaction(&app, "list", &[]).and_then(unwrap_result)
}

/// Install one plugin package into the desktop profile.
#[tauri::command]
pub fn plugins_add(app: AppHandle, spec: String) -> Result<Value, String> {
    run_transaction(&app, "add", &[spec]).and_then(unwrap_result)
}

/// Remove one installed plugin.
#[tauri::command]
pub fn plugins_remove(app: AppHandle, name: String) -> Result<Value, String> {
    run_transaction(&app, "remove", &[name]).and_then(unwrap_result)
}

/// Move one installed plugin to another version.
#[tauri::command]
pub fn plugins_update(app: AppHandle, name: String, version: String) -> Result<Value, String> {
    run_transaction(&app, "update", &[name, version]).and_then(unwrap_result)
}

/// Enable or disable one installed plugin.
#[tauri::command]
pub fn plugins_toggle(app: AppHandle, name: String, enabled: bool) -> Result<Value, String> {
    run_transaction(&app, "toggle", &[name, if enabled { "on".to_string() } else { "off".to_string() }]).and_then(unwrap_result)
}

/// Disable every third-party plugin, as the startup page's recovery action.
#[tauri::command]
pub fn plugins_disable_all(app: AppHandle) -> Result<Value, String> {
    run_transaction(&app, "disable-all", &[]).and_then(unwrap_result)
}

/// Reinitialize the desktop profile without a backup, as the reset recovery action.
#[tauri::command]
pub fn configuration_reset(app: AppHandle) -> Result<Value, String> {
    run_transaction(&app, "reset", &[]).and_then(unwrap_result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_last_json_line_the_transaction_printed() {
        let stdout = "pnpm output\n{\"ok\":true,\"value\":[{\"name\":\"a\"}]}\n";
        assert_eq!(parse_result(stdout), Some(json!({ "ok": true, "value": [{ "name": "a" }] })));
        assert_eq!(parse_result(""), None);
        assert_eq!(parse_result("not json"), None);
    }

    #[test]
    fn unwraps_success_and_failure_results() {
        assert_eq!(unwrap_result(json!({ "ok": true, "value": [1, 2] })).unwrap(), json!([1, 2]));
        assert_eq!(unwrap_result(json!({ "ok": true })).unwrap(), Value::Null);
        assert_eq!(unwrap_result(json!({ "ok": false, "message": "broken" })).unwrap_err(), "broken");
        assert!(unwrap_result(json!({})).is_err());
    }
}
