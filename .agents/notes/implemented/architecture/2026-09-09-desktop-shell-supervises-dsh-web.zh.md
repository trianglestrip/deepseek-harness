# Agent Note: The desktop shell supervises `dsh --profile web` through its stdout readiness line

Status: implemented

[English](2026-09-09-desktop-shell-supervises-dsh-web.md) | 中文

## 问题

产品需要一个桌面客户端。第一版 Electron 原型 spawn 了 `dsh --profile web`，却让窗口直接加载裸的 `http://localhost:<port>`——过不了浏览器鉴权，于是原型把 `dsh-client-connection` 里 `BrowserAuth.authorizeIndex` 与 `isAuthenticated` 短路成 `return true`。这让一台回环上的 agent 服务器变成任何本机进程都能无凭据操控的端点，也让桌面客户端变成了 harness 源码的 fork。同一原型还手写固定端口、用硬编码的 5 秒等就绪，并且经 `exec` 启动——`exec` 的 `kill()` 只能收割包装 shell，dsh 进程树成为孤儿并一直占住端口。

## 决策

`apps/desktop` 是 **`dsh --profile web` 的监督者（supervisor）**，dsh 仍是唯一的应用启动器。Electron 主进程直接 spawn（不经 shell）dsh CLI，参数为 `--no-open --port 0`；解析 stdout 中的 `dsh web: <authenticatedUrl>` 行——这是 web-app 已为 supervisor 定义的就绪信号——并让窗口导航到该 URL。`?token=` 换 cookie 的交换发生在首次导航内部，由 Chromium 自己的 cookie jar 完成。harness 源码零改动：`browser-auth` 的旁路已还原，桌面客户端永远不加载未鉴权 URL。

配套裁定：

- **端口 0，URL 取自 stdout。** 端口由 OS 分配；壳从就绪行得知真实 URL。固定端口等于等待端口冲突与不一致。
- **进程树终止。** win32 用 `taskkill /pid <pid> /T /F` 杀整棵树；POSIX 以 detached 方式 spawn，使 dsh 成为自己进程组的组长，终止时对组发信号，3 秒宽限后升级 SIGKILL。就绪解析、kill 参数、runtime 解析都是纯函数，由根 vitest 通道（`apps/*/tests/**` include）单测钉住。
- **打包 runtime。** 打包形态捆绑独立 Node `^22.19 || >=24` 加同版本 `@deepseek-ai/dsh` bin；dev 经 tsx 启动 checkout。Electron 内嵌 Node 不满足 engines 范围，所以 `ELECTRON_RUN_AS_NODE` 不是捷径。
- **崩溃与退出语义。** 单实例锁把第二次启动汇聚为聚焦已有窗口；`before-quit` 在 Electron 退出前停掉 dsh 进程树；dsh 意外退出落到本地错误页并提供重启入口。

## Alternatives considered

- **保留鉴权旁路。** 否决：它把一台能驱动本机 agent 的服务器的浏览器鉴权整个拆掉，违反固定不变的安全不变量，并把桌面客户端绑死在 harness 源码 fork 上；stdout token 行本来就是为程序化 supervisor 准备的。
- **Electron 进程内引导 web profile。** 否决：Application launch 规则规定 `dsh` CLI 加命名 profile 是唯一受支持的 Node 应用启动器，`verify-application-entrypoints` 也不允许 bin、可执行源与 demo 绕过它。
- **用 `ELECTRON_RUN_AS_NODE` 在 Electron 的 Node 下运行 dsh。** 否决：Electron 33 内嵌 Node 20.x，低于要求的 `^22.19 || >=24`；dsh CLI 将跑在不受支持的引擎上。
- **走 SDK JSON-RPC 客户端、自建原生 UI。** 现阶段否决：等于放弃整个 web GUI。复用 GUI 的正道是 webserver README 为 Electron 预留的 IPC fetch/stream 载波——渲染层走 `file://`，`createWebConnectionRpc(doFetch, openStream)` 经 IPC 桥接——已作为阶段二记录在 `apps/desktop/PLAN.md`。
- **固定端口加固定 sleep。** 否决：端口冲突与就绪竞态（慢启动白屏、快启动白等）；announce 行才是权威信号。

## Consequences

- `dsh web: ` 行格式成为以桌面壳为消费者的跨包契约：`parseLaunchLine` 单测钉住该格式，web-app 对该行的任何修改必须在同一次变更中更新桌面端解析器。
- 打包工作项必须捆绑 Node runtime 与 `@deepseek-ai/dsh`（`extraResources` + asar unpack），并在干净机器上验证打包启动；目前仓库内只演练了 dev 形态。
- 壳当前不在 `verify-application-entrypoints` 的分类清单内（无 `bin`、无 shebang 源、无根 `demo:` 脚本）；若桌面形态日后长出启动器状表面，该门禁的分类清单是登记之处。
- 阶段二——渲染层资产走 `file://`/`app://`，`doFetch`/`openStream` 经 IPC 桥接，消除渲染器与 dsh 之间的回环 HTTP 跳——仍是 future work；在此之前渲染层与浏览器标签页一样经回环 HTTP 与 dsh 通信。
