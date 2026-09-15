# Agent Note：Tauri 壳通过 shell core 充当 desktop Host 的父进程

Status: implemented

[English](2026-09-15-desktop-host-carrier.md) | 中文

## Problem

[Tauri 壳](2026-09-14-desktop-shell-runs-on-tauri.zh.md)当时只能通过 loopback HTTP 服务器和带鉴权 URL 触达 harness，因为监督者是它在没有一个可寻址 Node 运行时时唯一能实现的形态。这严格弱于它所替换的那套壳：Electron 父进程 spawn 私有的 `@deepseek-ai/dsh-desktop-host` 包，该包在进程内组装桌面 profile，用同一张 handler 表提供 renderer 资产与 `/api`，并在管道上使用一套带版本的帧协议。这些都无法原样保留，因为 Host 的父进程需要描述符 3、4 加一条 Node IPC 通道，而 Windows 上的 Rust 父进程两者都没有：`std::process::Command` 只暴露标准流，Node 的 IPC 通道需要标准库无法转交的可继承句柄。

## Decision

一个 fork 自有的 Node 进程——shell core——充当 Host 的父进程。Rust 壳充当 core 的父进程，而已安装的 Host 包与 upstream 完全一致。

- **复用而非重写上游的父半。** `apps/desktop/src/shell-core.ts` 驱动 `apps/desktop/src/host-process.ts` 的 `DesktopHostProcess`：描述符 3、4、IPC 就绪握手、上传背压、取消与三步 teardown 全部仍是上游代码，并由上游自带的 `host-process.spec.ts` 与 `host-protocol.spec.ts` 继续覆盖。
- **Host 包不含任何 fork 改动。** `apps/desktop-host/src/index.ts` 与 `wire.ts` 与 upstream 逐字节相同，因此从 `upstream/master` 合并时永远不会在这个包里解决语义分歧。core 在 Host 自身线协议之外需要的帧——生命周期事件与控制应答——位于 `apps/desktop/src/shell-core-wire.ts`。
- **帧独占标准输出。** 壳以 `node shell-core.js <runtimeDir> <projectDir> [--allow-linked-profile]` 启动 core，并与其交换 Host 的帧布局：请求 `start`/`data`/`end`/`cancel`，响应 `start`/`data`/`end`/`error`，外加保留 id 上的 `ready`、`fatal` 事件与 `shutdown` 控制帧。其余所有标准输出写入都改道到标准错误，因为 Harness 会自由打日志。
- **渲染层传输由壳自己安装。** Tauri 的 `UriSchemeResponder` 只接受完整实体化的 body，所以传输要经 `fetch('/.dsh/remote-stream')` 流式传输的页面无法工作。窗口改由 Rust 用 `initialization_script` 创建，`desktop-transport.js` 以不带 setter 的方式定义 `__DSH_TRANSPORT__`，于是 Host 为 Electron 系父进程注入的脚本无法把它替换成一份必须穿越非流式 URI scheme 的实现。
- **线格式跨语言钉住。** `apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json` 保存 core 发出的字节；`apps/desktop/scripts/generate-host-wire-vectors.ts` 依据 `shell-core-wire.ts` 重新生成它，Rust 编解码对每个请求向量逐字节重编码、对每个响应向量解码（含按七字节分片），`apps/desktop/scripts/host-smoke.ts` 端到端驱动 core。
- **开发态走同一条载体。** `DSH_DESKTOP_DEV_RUNTIME` 指向 `apps/desktop/scripts/dev-runtime.ts` 链接出的工作区运行时树，于是 `pnpm run dev:host` 启动打包路径，Host 会在收到首个 renderer 请求时记录日志。完全没有运行时资源时，监督者路径仍是回退。

## Alternatives considered

- **在 `apps/desktop-host` 内加一条 stdio 载体。** 否决：它让上游包变成永久 fork 补丁（四个文件，其中一个是入口重写），之后每次合并都要解决语义。
- **用 Rust 实现描述符与 IPC 的父半。** 否决：它需要原始 `CreateProcess` 加可继承管道句柄与 `NODE_CHANNEL_FD` 约定，失败面比驱动上游自己的父半代码更大。
- **重写 `desktop-host` 让壳直接与它对话。** 否决：它那 680 行通过 Cordis loader 启动一个 423 包的 TypeScript 应用，所以重写它等于重写 Harness，而不是重写一个入口。
- **改写被服务的 index 来注入壳的传输脚本。** 否决：它让 core 触碰响应语义——缓冲 HTML、改写 `content-length`——而窗口初始化脚本本就能到达那里。
- **命名管道或 Unix socket 载体。** 否决：与标准流不同，它是一个本机任意进程都能连接的地址，而这正是桌面组装要消除的性质。
- **只保留监督者路径。** 否决：桌面 profile 的组装会关掉 Web 服务器并替换目录选择器，因此回退失去的是桌面功能而不只是传输。

## Consequences

- `apps/desktop-host` 与 upstream 无法区分，fork 只拥有 `apps/desktop`；桌面应用变成"一个 Rust 进程带两个 Node 进程"，而 Electron 是"一个 Node 进程带一个 Node 进程"。
- 每个字节都要走两跳：壳把请求分帧给 core，core 驱动 Host 的描述符。多出的进程约占 40 MB 常驻内存、约 0.1 s 启动，相对以十秒计的 boot 可忽略。
- core 依赖 `DesktopHostProcess` 的构造签名与 `fetch` 契约；上游对该类的改动会立刻暴露而不是静默，因为 core 是本 fork 里唯一的调用方。
- 静态资产 handler 每个请求都实体化整个 body；与流式的 API 路径不同，大的 renderer 下载仍受内存约束。
- 请求 body 路径每块发送一个 invoke payload；多兆字节的上传会以大量消息穿越 IPC 边界，尚未实测。
