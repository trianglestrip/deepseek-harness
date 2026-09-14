# Agent Note: The desktop shell ships as a Tauri binary instead of Electron

Status: implemented

English | [中文](2026-09-14-desktop-shell-runs-on-tauri.zh.md)

## Problem

The Electron shell of the [supervisor Agent Note](2026-09-09-desktop-shell-supervises-dsh-web.md) worked, but it paid for a second browser engine to render a UI it did not own: the electron-builder `--dir` package measured 686 MiB, dominated by the Electron runtime and its Chromium, and the asar layout duplicated the `@deepseek-ai/dsh` closure the shell already had to ship. The shell used no Node API the harness did not reach through the `dsh` CLI, so the embedded engine bought nothing the supervisor role needed.

## Decision

`apps/desktop` is a Rust binary built by Tauri 2, sourced from `apps/desktop/src-tauri/`. It renders the harness web GUI in the operating system's WebView2, keeps the supervision model unchanged, and publishes no JavaScript payload.

- **The supervision contract survives as the fallback path.** `shell.rs` boots the [packaged Host](2026-09-15-desktop-host-carrier.md) when the application carries one, and otherwise `supervisor.rs` spawns `node <checkout>/apps/cli/lib/bin.js` with `--profile desktop --no-open --port 0`, reads stdout for the `dsh web: <authenticatedUrl>` line, and navigates the window to that URL. The `?token=` → cookie exchange still happens inside the first navigation, now in WebView2's cookie jar.
- **No shell, and no first-party authentication path.** The spawn still bypasses a shell, and harness source still carries no desktop-specific authentication bypass.
- **Tree teardown keeps the same two mechanisms.** win32 still runs `taskkill /pid <pid> /T /F`; POSIX signals the child's own process group, which both boot paths establish with `process_group(0)`.
- **Window and lifecycle are the tray's.** The tray menu owns Show, Restart dsh, and Quit; closing the window hides it, so the supervised server and the authenticated session stay warm; `tauri-plugin-single-instance` focuses the existing window on a second launch.
- **The dsh boot runs on its own thread.** `setup` spawns the dsh thread before Tauri finishes initializing the webview, and the shipped `src-tauri/loading/index.html` page ticks elapsed seconds locally, so the plugin-tree boot overlaps the window stack.
- **Profile selection is unchanged.** The shell boots `~/.dsh/profiles/desktop` when it exists, falls back to the shipped `web` profile, and `DSH_DESKTOP_PROFILE` overrides the choice.
- **The package publishes nothing.** `apps/desktop/package.json` declares `files: []`; the shell reaches users as a platform installer, not as an npm artifact.

## Alternatives considered

- **Keep the Electron shell.** Rejected: the shell is a supervisor, so a second browser engine served no role the harness web GUI did not already fill through the system webview, at the cost of a 686 MiB installed tree.
- **Tauri with a bundled Node sidecar as the packaged form.** Not implemented: the Tauri build ships no runtime today and `resolve_dsh_runtime` resolves a checkout CLI, so only a built workspace runs the shell. A sidecar, or an installed `@deepseek-ai/dsh`, is the reintroduction path for a packaged desktop build.
- **`ELECTRON_RUN_AS_NODE`, running dsh under Electron's embedded Node.** Rejected earlier and still rejected: the embedded Node is below the required `^22.19 || >=24`.
- **Drive the SDK JSON-RPC client and build a native UI.** Rejected: it abandons the web GUI.
- **Keep the tsx source launch.** Rejected earlier and still rejected: tsx has no cross-process transform cache, so the tree re-transforms on every boot.
- **Rewrite the harness in Rust.** Rejected: the shell supervises the Node CLI by contract, and the Application launch rule keeps the `dsh` CLI the only supported Node application launcher.

## Consequences

- **The install shrank by roughly fifty times.** The Tauri binary measured 13 MB in the debug profile and ships no browser engine; the Electron `--dir` package was 686 MiB. The release profile, which the repository has not built, is smaller still.
- **The packaged form is wired up again.** The [Host carrier Agent Note](2026-09-15-desktop-host-carrier.md) restored the bundled runtime: `prepare:runtime`, `prepare:packages`, `prepare:dsh`, and `prepare:resources` place the upstream Node.js executable and the installed dsh closure in `src-tauri/resources/desktop-runtime`, `tauri.conf.json` bundles that directory, and the shell boots the packaged Host before it falls back to the supervised CLI. Nothing has measured a release install yet.
- **`NODE_COMPILE_CACHE` reaches dsh again.** `compile_cache_env` seeds the cache under the application cache directory on both boot paths.
- **The readiness parser is pinned again, from the shell's side.** `parse_launch_line` and `resolve_profile_from` carry unit tests in `apps/desktop/src-tauri/src/supervisor.rs`, and the emitter side stays pinned by `packages/bundle/web-app/tests/web-app.spec.ts`. The boot bench is still absent.
- **POSIX teardown signals a real process group.** Both boot paths call `process_group(0)` before spawning, and both escalate to SIGKILL after a three-second grace period, so quitting on macOS or Linux no longer leaves the dsh tree holding its port.
- **The post-readiness watch and the restart affordance exist.** The supervisor watch reports an exit for the generation it was opened for, the loading page renders the failure from its fragment and reveals `#restart`, and the button invokes the shell's `restart_dsh`.
- **The shell still sits outside `verify-application-entrypoints` classifications** (no `bin`, no shebang source, no root `demo:` script); the Rust binary does not change that, and the gate's classification inventory remains the place to record it if that ever changes.
