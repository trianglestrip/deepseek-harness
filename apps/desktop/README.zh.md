# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Desktop：承载 dsh 应用的 Tauri 壳。

壳把 harness web GUI 渲染在操作系统自带的 webview 中。当应用资源携带随附运行时，它从随附的 desktop Host 经私有分帧载体提供该 GUI；否则监督 `dsh --profile desktop`，并加载服务器打印的带鉴权 URL。壳不修改 harness 源码；浏览器鉴权保持完整。相关决策及其让渡掉的东西记录在 [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.zh.md) 与 [Host carrier Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-desktop-host-carrier.zh.md)。

## 架构

```
src-tauri/src
  ├─ shell.rs          window, tray, single instance, resident mode, boot choice
  ├─ supervisor.rs     packaged-runtime and checkout resolution, `dsh` supervision
  └─ host/
       ├─ frame.rs     protocol v4 codec; golden vectors live in apps/desktop-host/fixtures
       ├─ client.rs    Node child, framed streams, readiness handshake, teardown
       └─ bridge.rs    invoke commands and the `dsh-app://` asset handler
```

- **随附 Host 是主路径。** 当应用资源携带 `desktop-runtime/{node,dsh,desktop-transport.js}` 时，壳在随附的 upstream Node.js 可执行文件下 spawn 已安装的 `@deepseek-ai/dsh-desktop-host`，传入 `DSH_DESKTOP_TRANSPORT=stdio`，等待协议 v4 的 readiness 事件，然后把窗口导航到 `dsh-app://localhost/index.html`（Windows 上为 `http://dsh-app.localhost/index.html`）。此后一元 RPC 与 Gateway 流都走壳的私有分帧载体，因此桌面 composition 不打开 Web 服务器、不监听 loopback，也不存在 token URL。
- **renderer 传输由 Host 注入。** `desktop-transport.js` 安装 `__DSH_TRANSPORT__`，其中 `ownsHost: true`，并用 invoke 命令实现 `fetch` 与 `openStream`，正好填上被服务页面用 HTTP 与 WebSocket 填的那个接缝。
- **监督路径保留为回退。** 没有随附运行时的时候，壳 spawn checkout 里构建好的 CLI（`--profile desktop --no-open --port 0`），从 stdout 读取 `dsh web: <authenticatedUrl>` 行，并把窗口导航到该 URL；`?token=` → cookie 的交换发生在这次导航内部。
- **两条路径跑同一个 profile。** `dsh --profile desktop` 是随附 profile：`base` 与 `web-app` 两个 bundle，不含 Harness home 的 MCP patch 行。监督路径在 `~/.dsh/profiles/desktop` 存在时选中它，`DSH_DESKTOP_PROFILE` 可覆盖；Host 则把同一目录当作插件 profile 组装。
- **生命周期归托盘。** 关闭窗口只是隐藏，应用与其会话保持热态；托盘负责 Show、Restart dsh、Quit；`tauri-plugin-single-instance` 在第二次启动时聚焦已有窗口。两条引导路径在 Quit 时都会杀掉整棵 dsh 进程树。
- **失败呈现在加载页上。** 引导失败，或 Host 在 readiness 之后退出，都会把窗口导航回加载页，把消息放进 fragment，并显示 Restart 按钮。
- **本包不发布任何 JavaScript**（`files: []`）；壳以平台安装器的形式触达用户。

## 开发

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

需要 Node `^22.19 || >=24`，以及带 Tauri 2 前置依赖的 Rust 工具链。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime
pnpm --filter @deepseek-ai/dsh-desktop run prepare:packages
pnpm --filter @deepseek-ai/dsh-desktop run prepare:dsh
pnpm --filter @deepseek-ai/dsh-desktop run prepare:resources
pnpm --filter @deepseek-ai/dsh-desktop run build
```

`tauri.conf.json` 把 `src-tauri/resources/desktop-runtime` 作为 `desktop-runtime` 资源目录打进包，`src-tauri/resources/` 是构建产物。未准备资源的 checkout 仍能跑监督路径，因此 `tauri dev` 不需要任何打包步骤。

## 仓库归属

本 fork 用 Tauri 壳替换了 upstream 的 Electron 壳。`apps/desktop` 归 fork 所有：Electron 源码、其测试与 electron-builder 发布管线均已删除，`apps/desktop/scripts/upstream-sync.sh` 会在从 `upstream/master` 合并之后重新施加这些删除。线协议不归任一方壳所有，而是与 Host 包共享：`apps/desktop-host/fixtures/wire-vectors.json` 是 TypeScript、Rust 与 Host 三套编解码各自测试所对照的黄金副本。
