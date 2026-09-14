# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Desktop：监督 `dsh --profile desktop` 的 Tauri 壳。

壳是监督者，不是应用启动器：它 spawn dsh CLI，并加载服务器打印的带鉴权 Web URL。壳不修改 harness 源码；浏览器鉴权保持完整。该决策及其让渡掉的东西记录在 [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.zh.md)。

## 架构

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

- **随附的 profile 是 `dsh --profile desktop`**：`base` 与 `web-app` 两个 bundle，不含 Harness home 的 MCP patch 行。`~/.dsh/profiles/desktop` 不存在时壳改为引导 `web` profile，`DSH_DESKTOP_PROFILE` 可覆盖该选择。
- **GUI 就是 harness web GUI**，渲染在操作系统自带的 WebView2 中，因此壳不携带浏览器引擎。
- **本包不发布任何 JavaScript**（`files: []`）；壳以平台安装器的形式触达用户。

## 开发

```sh
pnpm install
pnpm run build                     # builds the dsh CLI the shell spawns
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

需要 Node `^22.19 || >=24`，以及安装了 Tauri 2 前置依赖的 Rust 工具链。

## 打包

尚未接线：`tauri.conf.json` 将 `bundle.active` 设为 `false`，所以 `tauri build` 不产出安装器；`resolve_dsh_runtime` 解析的是 checkout 路径，所以壳目前只能对已构建的工作区运行。重新引入路径记录在 [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.zh.md)。
