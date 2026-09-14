# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

DeepSeek Harness Desktop: a Tauri shell supervising `dsh --profile desktop`.

The shell is a supervisor, not an application launcher: it spawns the dsh CLI and loads the authenticated Web URL the server prints. Harness source is not modified by the shell; browser authentication stays intact. The [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.md) records the decision and what it traded away.

## Architecture

```
src-tauri/src/main.rs
  ├─ resolve_dsh_runtime()          `node` from PATH + the checkout's built apps/cli/lib/bin.js
  ├─ spawn_dsh()                    spawn --profile desktop --no-open --port 0 (no shell)
  │    ├─ parse_launch_line()       readiness = the `dsh web: <url>` stdout line (?token=…)
  │    └─ kill_process_tree()       win32: taskkill /T /F · POSIX: negated-pid process-group signal
  ├─ WebviewWindow.navigate(url)    the ?token= → cookie exchange happens in the navigation
  ├─ single-instance plugin         second instance focuses the existing window
  ├─ tray icon                      Show / Restart dsh / Quit
  └─ resident mode                  close window = hide; tray is the control surface
```

- **`dsh --profile desktop`** is the shipped profile: the `base` and `web-app` bundles without the Harness home's MCP patch rows. The shell boots the `web` profile instead when `~/.dsh/profiles/desktop` is absent, and `DSH_DESKTOP_PROFILE` overrides the choice.
- **The GUI is the harness web GUI**, rendered in the operating system's WebView2, so no browser engine ships with the shell.
- **The package publishes no JavaScript** (`files: []`); the shell reaches users as a platform installer.

## Development

```sh
pnpm install
pnpm run build                     # builds the dsh CLI the shell spawns
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

Requires Node `^22.19 || >=24` and a Rust toolchain with the Tauri 2 prerequisites.

## Packaging

Not wired up: `tauri.conf.json` sets `bundle.active` to `false`, so `tauri build` produces no installer, and `resolve_dsh_runtime` resolves a checkout path, so the shell runs only against a built workspace. The [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.md) records the reintroduction path.
