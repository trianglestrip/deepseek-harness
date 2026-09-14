# Agent Note: The desktop shell ships as a Tauri binary instead of Electron

Status: implemented

[English](2026-09-14-desktop-shell-runs-on-tauri.md) | 中文

## 问题

[supervisor Agent Note](2026-09-09-desktop-shell-supervises-dsh-web.zh.md) 里的 Electron 壳能工作，但为了渲染一个并不属于它的 UI 而付出了第二套浏览器引擎的代价：electron-builder `--dir` 产物测得 686 MiB，绝大部分是 Electron runtime 与其 Chromium，而 asar 布局还重复打包了壳本就必须分发的 `@deepseek-ai/dsh` 闭包。壳没有用到任何 harness 未能经 `dsh` CLI 触及的 Node API，所以内嵌引擎并为 supervisor 这个角色换来不了什么。

## 决策

`apps/desktop` 是由 Tauri 2 构建的 Rust 二进制，源码位于 `apps/desktop/src-tauri/`。它在操作系统自带的 WebView2 中渲染同一套 harness web GUI，监督模型保持不变，且不发布任何 JavaScript 载荷。

- **监督契约不变。** `src-tauri/src/main.rs` spawn `node <checkout>/apps/cli/lib/bin.js`，参数为 `--profile desktop --no-open --port 0`；解析 stdout 中的 `dsh web: <authenticatedUrl>` 行，并让窗口导航到该 URL。`?token=` 换 cookie 的交换仍发生在首次导航内部，如今用的是 WebView2 的 cookie jar。
- **不经 shell，也不改第一方鉴权。** spawn 仍绕过 shell，harness 源码仍不含任何桌面专用的鉴权旁路。
- **进程树终止沿用同样两种机制。** win32 仍是 `taskkill /pid <pid> /T /F`；POSIX 仍对 detached 子进程的进程组发信号。
- **窗口与生命周期归托盘管。** 托盘菜单负责 Show、Restart dsh、Quit；关闭窗口只是隐藏，被监督的服务器与已鉴权会话保持常驻；`tauri-plugin-single-instance` 把第二次启动汇聚为聚焦已有窗口。
- **dsh 引导跑在独立线程上。** `setup` 在 Tauri 完成 webview 初始化之前就 spawn 了 dsh 线程，随包发布的 `src-tauri/loading/index.html` 在本地自行累计已用秒数，于是插件树引导与窗口栈初始化重叠。
- **profile 选择不变。** 壳在 `~/.dsh/profiles/desktop` 存在时引导该 profile，否则回落到随包发布的 `web` profile，`DSH_DESKTOP_PROFILE` 可覆盖该选择。
- **本包不发布任何内容。** `apps/desktop/package.json` 声明 `files: []`；壳以平台安装器而非 npm 产物触达用户。

## Alternatives considered

- **保留 Electron 壳。** 否决：壳是 supervisor，第二套浏览器引擎换不来 harness web GUI 已经用系统 webview 填满的任何角色，代价却是 686 MiB 的安装树。
- **Tauri 配捆绑 Node sidecar 作为打包形态。** 未实现：当前 Tauri 构建不随包分发 runtime，且 `resolve_dsh_runtime` 解析的是 checkout CLI，所以只有已构建的工作区能跑起该壳。sidecar，或已安装的 `@deepseek-ai/dsh`，是打包桌面构建的重新引入路径。
- **`ELECTRON_RUN_AS_NODE`，在 Electron 内嵌 Node 下运行 dsh。** 先前否决，现在仍否决：内嵌 Node 低于要求的 `^22.19 || >=24`。
- **走 SDK JSON-RPC 客户端、自建原生 UI。** 否决：等于放弃整个 web GUI。
- **保留 tsx 源码启动。** 先前否决，现在仍否决：tsx 没有跨进程的转换缓存，每次引导都会重新转换整棵树。
- **用 Rust 重写 harness。** 否决：壳按契约监督 Node CLI，Application launch 规则也规定 `dsh` CLI 是唯一受支持的 Node 应用启动器。

## Consequences

- **安装体积缩小了约五十倍。** Tauri 二进制在 debug profile 下测得 13 MB，且不携带浏览器引擎；Electron `--dir` 产物为 686 MiB。仓库尚未构建的 release profile 还要更小。
- **打包形态退回未构建状态。** Electron 的打包工作——捆绑独立 Node 加 link-graph `@deepseek-ai/dsh` 闭包——随 Electron 源码一并删除。`bundle.active` 为 `false`，所以 `tauri build` 不产出安装器，也不随包分发 runtime。
- **`NODE_COMPILE_CACHE` 不再到达 dsh。** `spawn_dsh` 不传任何环境变量，Electron 壳曾经种下的 V8 编译缓存因此消失，dsh 在没有它的情况下引导。恢复它就是在 spawn 出的命令上加一次 `env` 调用。
- **引导基准与解析器单测随 Electron 源码一并删除**：`apps/desktop/bench/boot-bench.mjs`、`apps/desktop/bench/boot-once.mjs` 与 `apps/desktop/tests/*.spec.ts`。因此 `dsh web: ` 就绪行成了跨包契约，却在两个包里都没有测试钉住；在重新覆盖该解析器与就绪行格式之前，web-app 对该行的修改不能称为安全。
- **POSIX 的进程树终止丢了进程组建置。** `spawn_dsh` 不调用 `process_group(0)`，子进程因此不是进程组组长，`kill_process_tree` 的 `kill(-pid, SIGTERM)` 打向一个并不存在的进程组；Electron 壳那套 3 秒后升级 SIGKILL 也没了。于是在 macOS 或 Linux 上退出可能把 dsh 进程树留在原地并占住端口。
- **就绪后的崩溃监视与重启入口都没了。** 就绪行之后没有任何东西在观察子进程，`src-tauri/loading/index.html` 也没有 `#restart` 元素可供失败路径的 `hidden = false` 揭示。
- **壳仍不在 `verify-application-entrypoints` 的分类清单内**（无 `bin`、无 shebang 源、无根 `demo:` 脚本）；改成 Rust 二进制不改变这一点，若日后情况变化，该门禁的分类清单仍是登记之处。
