# Agent Note: The desktop shell supervises `dsh --profile web` through its stdout readiness line

Status: implemented

[English](2026-09-09-desktop-shell-supervises-dsh-web.md) | 中文

## 问题

产品需要一个桌面客户端。第一版 Electron 原型 spawn 了 `dsh --profile web`，却让窗口直接加载裸的 `http://localhost:<port>`——过不了浏览器鉴权，于是原型把 `dsh-client-connection` 里 `BrowserAuth.authorizeIndex` 与 `isAuthenticated` 短路成 `return true`。这让一台回环上的 agent 服务器变成任何本机进程都能无凭据操控的端点，也让桌面客户端变成了 harness 源码的 fork。同一原型还手写固定端口、用硬编码的 5 秒等就绪，并且经 `exec` 启动——`exec` 的 `kill()` 只能收割包装 shell，dsh 进程树成为孤儿并一直占住端口。

## 决策

`apps/desktop` 是 **`dsh` CLI 的监督者（supervisor）**，dsh 仍是唯一的应用启动器；实现它的壳由 [Tauri shell Agent Note](2026-09-14-desktop-shell-runs-on-tauri.zh.md) 记录。壳直接 spawn（不经 shell）dsh CLI，参数为 `--no-open --port 0`；解析 stdout 中的 `dsh web: <authenticatedUrl>` 行——这是 web-app 已为 supervisor 定义的就绪信号——并让窗口导航到该 URL。`?token=` 换 cookie 的交换发生在首次导航内部，由 webview 自己的 cookie jar 完成。harness 源码零改动：`browser-auth` 的旁路已还原，桌面客户端永远不加载未鉴权 URL。

配套裁定：

- **端口 0，URL 取自 stdout。** 端口由 OS 分配；壳从就绪行得知真实 URL。固定端口等于等待端口冲突与不一致。
- **进程树终止。** win32 用 `taskkill /pid <pid> /T /F` 杀整棵树；POSIX 以取负的 pid 对进程组发信号。就绪解析、kill 参数与 runtime 解析都是纯函数；钉住它们的根 vitest 通道随 Electron 源码一并删除（[Tauri shell Agent Note](2026-09-14-desktop-shell-runs-on-tauri.zh.md)）。
- **runtime 解析。** 壳从 `PATH` 取 `node`，运行 checkout 中的构建产物 `apps/cli/lib/bin.js`。Electron 内嵌 Node 低于要求的 `^22.19 || >=24`，所以 `ELECTRON_RUN_AS_NODE` 从来不是捷径，且目前不存在打包 runtime。
- **崩溃与退出语义。** 单实例锁把第二次启动汇聚为聚焦已有窗口，Quit 在应用退出前停掉 dsh 进程树。就绪前失败的 dsh 会把错误写进加载页。

## Alternatives considered

- **保留鉴权旁路。** 否决：它把一台能驱动本机 agent 的服务器的浏览器鉴权整个拆掉，违反固定不变的安全不变量，并把桌面客户端绑死在 harness 源码 fork 上；stdout token 行本来就是为程序化 supervisor 准备的。
- **Electron 进程内引导 web profile。** 否决：Application launch 规则规定 `dsh` CLI 加命名 profile 是唯一受支持的 Node 应用启动器，`verify-application-entrypoints` 也不允许 bin、可执行源与 demo 绕过它。
- **用 `ELECTRON_RUN_AS_NODE` 在 Electron 的 Node 下运行 dsh。** 否决：Electron 33 内嵌 Node 20.x，低于要求的 `^22.19 || >=24`；dsh CLI 将跑在不受支持的引擎上。
- **走 SDK JSON-RPC 客户端、自建原生 UI。** 现阶段否决：等于放弃整个 web GUI。经非 HTTP 载波复用 GUI——渲染层资产走 `file://`，`createWebConnectionRpc(doFetch, openStream)` 在进程内桥接——仍是未决的 future work。
- **固定端口加固定 sleep。** 否决：端口冲突与就绪竞态（慢启动白屏、快启动白等）；announce 行才是权威信号。

## Consequences

- `dsh web: ` 行格式是以桌面壳为消费者的跨包契约：web-app 对该行的任何修改必须在同一次变更中更新桌面端解析器。目前两端都没有测试钉住它。
- 目前不存在打包形态的桌面构建；重新引入路径见 [Tauri shell Agent Note](2026-09-14-desktop-shell-runs-on-tauri.zh.md)。
- 壳当前不在 `verify-application-entrypoints` 的分类清单内（无 `bin`、无 shebang 源、无根 `demo:` 脚本）；若桌面形态日后长出启动器状表面，该门禁的分类清单是登记之处。
- 非 HTTP 载波——渲染层资产走 `file://`/`app://`，`doFetch`/`openStream` 在进程内桥接，消除渲染器与 dsh 之间的回环 HTTP 跳——仍是 future work。
