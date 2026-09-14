# Agent Note：Tauri 壳在帧传输上承载 desktop Host

Status: implemented

[English](2026-09-15-desktop-host-carrier.md) | 中文

## Problem

[Tauri 壳](2026-09-14-desktop-shell-runs-on-tauri.zh.md)当时只能通过 loopback HTTP 服务器和带鉴权 URL 触达 harness，因为监督者是它在没有一个可寻址 Node 运行时时唯一能实现的形态。这严格弱于它所替换的那套壳：Electron 父进程 spawn 私有的 `@deepseek-ai/dsh-desktop-host` 包，该包在进程内组装桌面 profile，用同一张 handler 表提供 renderer 资产与 `/api`，并在管道上使用一套带版本的帧协议。Electron 的契约无法直接保留，因为它要求描述符 3、4 加一条 Node IPC 通道，而 Windows 上的 Rust 父进程两者都没有：`std::process::Command` 只暴露标准流，Node 的 IPC 通道需要标准库无法转交的可继承句柄。

## Decision

Host 保留组装逻辑与 Fetch 语义。传输变成一条 carrier 缝，其 `fd` 布局仍是 Electron 契约，而壳通过标准流触达 Host。

- **`fd` 保持 Electron 契约。** 描述符 3、4 继续承载请求与响应帧，`ready` 与 `fatal` 继续走 Node IPC 通道，就绪事件继续报告协议版本 3。Electron 系父进程无需任何改动即可监督这个 Host。
- **`stdio` 是增量。** `DSH_DESKTOP_TRANSPORT=stdio` 从标准输入读请求帧、向标准输出写响应帧，并把其他标准输出写入全部改道到标准错误，使日志无法破坏帧流。它把 `ready`、`fatal` 作为 id 0 的响应帧承载，把 `shutdown` 作为请求控制帧，把其应答作为 `controlResult` 帧，于是没有 IPC 通道的父进程能在同一条线上监督 Host。
- **renderer 传输仍由 Host 注入。** `runDesktopHost` 把注入脚本作为选项，默认是 Electron 壳期望的那份；Tauri 壳通过 `DSH_DESKTOP_TRANSPORT_SCRIPT` 提供 `apps/desktop/src-tauri/transport/desktop-transport.js`，因为 Tauri 的 `UriSchemeResponder` 只接受完整实体化的 body，只有 invoke 加 channel 能流式传输。
- **父进程那一半由壳拥有。** `apps/desktop/src-tauri/src/host` 在 Rust 中编解码同一批字节，用随包分发的上游 Node.js 可执行文件 spawn 已安装的 Host，等待就绪，并通过 `dsh-app://` 协议 handler 加 invoke 命令服务 webview：`dsh_request_start` 打开一条流并经 Tauri channel 投递响应帧，body、end、cancel 命令补完整次交换。
- **线格式通过黄金向量共享。** `apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json` 保存 Host 发出的字节；`apps/desktop/scripts/generate-host-wire-vectors.ts` 重新生成它，`apps/desktop/src-tauri/src/host/frame.rs` 对每个请求向量逐字节重编码、对每个响应向量解码，包括按七字节分片；`apps/desktop/scripts/host-smoke.ts` 端到端地以 `stdio` 驱动已安装的 Host。
- **监督者路径保留为回退。** 没有准备好资源的 checkout 仍然启动 `dsh web` 并加载其公布的 URL，所以 `tauri dev` 不需要打包步骤，载体损坏时应用仍能降级可用。

## Alternatives considered

- **只保留 Electron 描述符契约。** 否决：Windows 上的 Rust 父进程无法满足它，而本 fork 已不再附带任何 Node 父进程。
- **用 Rust 手写 Node IPC。** 否决：它需要原始 `CreateProcess` 加可继承管道句柄与 `NODE_CHANNEL_FD` 约定，失败面比壳已经能理解的帧流更大。
- **命名管道或 Unix socket 载体。** 否决：与标准流不同，它是一个本机任意进程都能连接的地址，而这正是 Host 组装要消除的性质。
- **用 Node launcher 把描述符与 IPC 桥接到标准流。** 否决：它给每次壳启动多加一个常驻进程，而且仍需要壳侧的注入覆盖，因为注入的脚本决定流到底能否抵达 Host。
- **只把静态资产走 custom protocol。** 作为终点否决：Tauri 的 `UriSchemeResponder` 只接受完整实体化的 body，流式 RPC 与 Gateway 流反正必须走 IPC；把它们拆到两条载体上没有收益。
- **破坏性提升协议版本。** 否决：提升共享版本会让上游 Electron 父进程拒绝这个 Host，使之后每次 merge 从机械合并变成冲突。
- **把插件与后端控制面搬进 Host。** 此处不取：监督者路径仍通过 `dsh plugin` 覆盖插件事务，而控制帧就是壳将来需要时的扩展点。

## Consequences

- 桌面组装重新不开放 Web 服务器、不开放 loopback 端口、不产出带 token 的 URL，且壳随包分发它所构建时使用的那个 dsh。
- 两条载体共用一套线格式，必须同步演进；协议改动首先更新向量，Host、TypeScript 父进程与 Rust 壳都会对未知帧类型大声失败。
- 上游改动面是两个文件 `apps/desktop-host/src/index.ts` 与 `src/wire.ts`，两处都是增量，fork 合并上游时无需解决语义分歧。
- `serde_json` 启用了 `preserve_order`，所以 Rust 的请求帧与 TypeScript 的逐字节相同，而不只是等价 JSON。
- 静态资产 handler 每个请求都实体化整个 body；与流式的 API 路径不同，大的 renderer 下载仍受内存约束。
- 请求 body 路径每块发送一个 invoke payload；多兆字节的上传会以大量消息穿越 IPC 边界，尚未实测。
- `apps/desktop/scripts/prepare-tauri-resources.ts` 把准备好的运行时拷进 `src-tauri/resources/desktop-runtime`，那是构建产物，不入 git。
