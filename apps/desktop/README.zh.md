# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Desktop：承载 dsh 应用的 Tauri 壳。

壳把 harness web GUI 渲染在操作系统自带的 webview 中。当应用资源携带随附运行时，它从随附的 desktop Host 经私有分帧载体提供该 GUI；否则监督 `dsh --profile desktop`，并加载服务器打印的带鉴权 URL。壳不修改 harness 源码；浏览器鉴权保持完整。相关决策及其让渡掉的东西记录在 [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.zh.md) 与 [Host carrier Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-desktop-host-carrier.zh.md)。

## 架构

```
src-tauri/src
  ├─ shell.rs          window, tray, single instance, resident mode, boot choice
  ├─ supervisor.rs     shell-core and checkout resolution, `dsh` supervision
  ├─ backend.rs        backend availability, retry, and recovery actions
  └─ host/
       ├─ frame.rs     wire codec; golden vectors live in src-tauri/tests/fixtures
       ├─ client.rs    Node child, framed streams, readiness handshake, teardown
       └─ bridge.rs    invoke commands and the `dsh-app://` asset handler
src
  └─ shell-core.ts     Node parent of the installed Host (upstream `host-process.ts`)
```

- **shell core 充当 Host 的父进程。** 当应用资源携带 `desktop-runtime/{node,dsh,shell-core.js}` 时，壳在随附的 upstream Node.js 可执行文件下 spawn core，由 core 通过 Host 期望的描述符 3、4 与 Node IPC 通道驱动已安装的 `@deepseek-ai/dsh-desktop-host`。一元 RPC 与 Gateway 流走壳的私有分帧载体，因此桌面 composition 不打开 Web 服务器、不监听 loopback，也不存在 token URL；`apps/desktop-host` 本身不含任何 fork 改动。
- **renderer 传输归壳。** `desktop-transport.js` 安装 `__DSH_TRANSPORT__`，其中 `ownsHost: true`，并用 invoke 命令实现 `fetch` 与 `openStream`，正好填上被服务页面用 HTTP 与 WebSocket 填的那个接缝。壳把它作为窗口初始化脚本注入，并以不带 setter 的方式定义该全局，因为 Tauri 的 URI scheme responder 无法流式响应，而 Host 为 Electron 系父进程注入的脚本会。
- **监督路径保留为回退。** 没有随附运行时的时候，壳 spawn checkout 里构建好的 CLI（`--profile desktop --no-open --port 0`），从 stdout 读取 `dsh web: <authenticatedUrl>` 行，并把窗口导航到该 URL；`?token=` → cookie 的交换发生在这次导航内部。
- **两条路径各用各自的 profile。** 监督路径启动随附的 `web` profile，因为 desktop profile 的组装会关掉 Web 服务器；`DSH_DESKTOP_PROFILE` 可覆盖。Host 则把 `~/.dsh/profiles/desktop` 当作插件 profile 组装。
- **壳拥有自己页面的 API 与文案。** `shell-api.js` 把 `window.dsh`（`locale`、`backend`、`plugins`、`updates` 以及启动页动作）安装进壳拥有的每个页面，`locale.rs` 用它回答——托盘与对话框读的也是同一份字典。插件窗口是壳自有页面，背后由 `desktop-plugins.js` 支撑，它运行 Electron 主进程曾驱动的同一个 profile 管理器。
- **生命周期归托盘。** 关闭窗口只是隐藏，应用与其会话保持热态；托盘负责 Show、Restart dsh、Quit；`tauri-plugin-single-instance` 在第二次启动时聚焦已有窗口。两条引导路径在 Quit 时都会杀掉整棵 dsh 进程树。
- **失败呈现在加载页上。** 引导失败，或 Host 在 readiness 之后退出，都会把窗口导航回加载页，把消息放进 fragment；页面提供重试、重启应用，以及（当随附运行时能重建 profile 时）禁用全部第三方插件或重置桌面 profile。
- **更新沿用 Electron 协调器的阶段。** 托盘的 Check for Updates… 用原生对话框询问，且壳只安装经过检查验证的版本。没有 `plugins.updater.{endpoints,pubkey}` 的构建报告无可用更新，而不是报错。
- **本包不发布任何 JavaScript**（`files: []`）；壳以平台安装器的形式触达用户。

## 开发

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop run dev        # the packaged resource tree
pnpm --filter @deepseek-ai/dsh-desktop run dev:host   # the packaged path from a linked runtime
pnpm --filter @deepseek-ai/dsh-desktop run app -- --host --fresh   # either mode, clean tree and webview profile
```

`dev:host` 不声明任何 bundle 资源（`src-tauri/tauri.dev.conf.json`）：Tauri 的 build script 会在每次重编时把声明的资源逐个复制到 target 目录——这棵树是 11,674 个文件。它改为让壳指向链接出的运行时，因此改一次 Rust 只需一次编译。`dev` 保留资源树，是发布前该信任的那次运行。`app` 补上卡住时需要的诊断：先停掉上一条进程树，`--fresh` 让 WebView2 换用新的 profile——壳被连子进程一起强杀时会留下仍占用 profile 的进程，下一次窗口就再也不会加载页面。

需要 Node `^22.19 || >=24`，以及带 Tauri 2 前置依赖的 Rust 工具链。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime
pnpm --filter @deepseek-ai/dsh-desktop run prepare:packages
pnpm --filter @deepseek-ai/dsh-desktop run prepare:dsh
pnpm --filter @deepseek-ai/dsh-desktop run prepare:resources
pnpm --filter @deepseek-ai/dsh-desktop run build
```

`tauri.conf.json` 把 `src-tauri/resources/desktop-runtime`——随附的 Node.js 可执行文件、插件事务运行的 pnpm、已安装的 dsh 闭包、`shell-core.js` 与 `desktop-plugins.js`——作为 `desktop-runtime` 资源目录打进包，`src-tauri/resources/` 是构建产物。未准备资源的 checkout 仍能跑监督路径，因此 `tauri dev` 不需要任何打包步骤。发布构建需要填写 `plugins.updater.{endpoints,pubkey}` 以及平台签名与公证设置；本 fork 未配置它们，因此没有这些配置的构建不会安装任何更新。

## 仓库归属

本 fork 用 Tauri 壳替换了 upstream 的 Electron 壳。`apps/desktop` 归 fork 所有：Electron 源码、其测试与 electron-builder 发布管线均已删除，`apps/desktop/scripts/upstream-sync.sh` 会在从 `upstream/master` 合并之后重新施加这些删除。线协议不归任一方壳所有，而是与 Host 包共享：`apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json` 是 TypeScript Host 编码器与 Rust 编解码各自测试所对照的黄金副本，由 `apps/desktop/scripts/generate-host-wire-vectors.ts` 重新生成。[PARITY.md](PARITY.md) 记录了 Electron 壳原本提供了什么、当前这个壳走到哪里。
