# Agent Note: Desktop shell boots the built CLI with a desktop-first profile and a V8 compile cache

Status: implemented

[English](2026-09-10-desktop-built-cli-boot-and-compile-cache.md) | 中文

## 问题

壳的 dev 形态经 tsx 启动 checkout CLI，每次 boot 都要重新转换整棵插件树，窗口可导航前要等约 45 秒。此外 home 的 `web` profile 带着镜像来的 stdio MCP 行（github、playwright、codegraph、everything-search），boot 还要等外部 MCP 服务器；约 146 个插件的模块图每次启动都从头解析 JavaScript——CPU profile 显示 boot 的约 66% 花在模块加载上。

## 决策

壳经 `PATH` 上的普通 Node 运行构建产物 `apps/cli/lib/bin.js`。home 中存在 `desktop` profile（`~/.dsh/profiles/desktop`）时壳启动它——与 `web` 相同的 bundle、无 MCP patch 行——不存在时回退到随附的 `web`，`DSH_DESKTOP_PROFILE` 可覆盖选择。本决策的编译缓存那一半没有活到 [Tauri 壳](../architecture/2026-09-14-desktop-shell-runs-on-tauri.zh.md)：`spawn_dsh` 不传任何环境变量，所以 `NODE_COMPILE_CACHE` 未设置，基准脚本也随 Electron 源码一并删除。

## Alternatives considered

- **继续 tsx 源码启动。** 否决：tsx 没有跨进程转换缓存，约 45 秒的重转换每次 boot 都会发生；构建产物 `lib/` 是仓库认可的产物面，个位数秒即可就绪。
- **在壳内嵌 runtime 下运行 dsh。** 否决：当时权衡的 Electron 33 runtime 内嵌 Node 20.x，低于要求的 `^22.19 || >=24`；壳改为从 `PATH` 取 `node`。

## Consequences

一次性 boot 基准（spawn → `dsh web:` 就绪行，Windows，146 插件的 desktop profile；量具本身随 Electron 源码删除）：

| 配置 | time-to-ready |
|---|---|
| tsx + `web` profile + 损坏的 MCP 行 | ~85 s |
| built CLI + `desktop` profile + 无 MCP | ~6–9 s |
| + `NODE_COMPILE_CACHE` 暖态 | 再快 ~1–2 s |

- **编译缓存只在进程优雅退出时落盘。** 壳以树杀结束 dsh（win32 上 `taskkill /T /F`），通过退出壳来结束的会话永远写不回缓存条目。读缓存不受影响，且缓存内容只在 `lib/` 重建后变化，所以每次重建后一次优雅退出（例如被 SIGINT 的 CLI 运行）即可为后续所有 boot 播种。硬杀的 boot 仍读到旧但有效的缓存。在 Tauri 壳这样 `NODE_COMPILE_CACHE` 未设置的情况下，没有任何东西为缓存播种。
- **`NODE_COMPILE_CACHE` 只跳过 parse+compile。** 模块体的求值照常运行；实测上限是约 9 秒地板中的 1–2 秒，不是 CPU profile 归因给模块加载的 66% 全额。
- **`desktop` profile 位于用户的 Harness home，不在仓库里。** 目录不存在时壳回退到随附的 `web` profile，`DSH_DESKTOP_PROFILE` 可覆盖选择。
- win32 上实测 `sigbreak` 式优雅终止不会向隐藏 spawn 的子进程投递控制台控制事件；`taskkill /T /F` 仍是终止路径。
- 本 note 落地后，应用户要求从 home 的 `web` profile 中移除了四行镜像 MCP；去掉后 `web` 与 `desktop` 的 boot 处于同一区间，壳的 profile 回退也不再可能继承 MCP 等待。
