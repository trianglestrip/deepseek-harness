# Agent Note: The desktop shell ships as a Tauri binary instead of Electron

Status: implemented

[English](2026-09-14-desktop-shell-runs-on-tauri.md) | 中文

## 问题

[supervisor Agent Note](2026-09-09-desktop-shell-supervises-dsh-web.zh.md) 里的 Electron 壳能工作，但为了渲染一个并不属于它的 UI 而付出了第二套浏览器引擎的代价：electron-builder `--dir` 产物测得 686 MiB，绝大部分是 Electron runtime 与其 Chromium，而 asar 布局还重复打包了壳本就必须分发的 `@deepseek-ai/dsh` 闭包。壳没有用到任何 harness 未能经 `dsh` CLI 触及的 Node API，所以内嵌引擎并为 supervisor 这个角色换来不了什么。

## 决策

`apps/desktop` 是由 Tauri 2 构建的 Rust 二进制，源码位于 `apps/desktop/src-tauri/`。它在操作系统自带的 WebView2 中渲染同一套 harness web GUI，监督模型保持不变，且不发布任何 JavaScript 载荷。

- **监督契约作为回退路径存续。** 当应用携带[随附 Host](2026-09-15-desktop-host-carrier.zh.md) 时由 `shell.rs` 引导它；否则由 `supervisor.rs` spawn `node <checkout>/apps/cli/lib/bin.js`，参数为 `--profile desktop --no-open --port 0`；解析 stdout 中的 `dsh web: <authenticatedUrl>` 行，并让窗口导航到该 URL。`?token=` 换 cookie 的交换仍发生在首次导航内部，如今用的是 WebView2 的 cookie jar。
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
- **打包形态重新接通。** [Host carrier Agent Note](2026-09-15-desktop-host-carrier.zh.md) 恢复了随包运行时：`prepare:runtime`、`prepare:packages`、`prepare:dsh` 与 `prepare:resources` 把 upstream Node.js 可执行文件与已安装的 dsh 闭包放进 `src-tauri/resources/desktop-runtime`，`tauri.conf.json` 打包该目录，壳在回退到监督 CLI 之前会先引导随附 Host。尚未有人测过 release 安装包。
- **`NODE_COMPILE_CACHE` 再次到达 dsh。** `compile_cache_env` 在两条引导路径上把缓存种在应用缓存目录下。
- **就绪解析器重新被钉住，从壳这一侧。** `parse_launch_line` 与 `resolve_profile_from` 在 `apps/desktop/src-tauri/src/supervisor.rs` 中带有单测，产出侧仍由 `packages/bundle/web-app/tests/web-app.spec.ts` 钉住。引导基准仍然缺席。
- **POSIX 终止打向真实存在的进程组。** 两条引导路径在 spawn 前都调用 `process_group(0)`，并在三秒宽限后升级到 SIGKILL，因此在 macOS 或 Linux 上退出不再把 dsh 进程树留在原地占住端口。
- **就绪后的监视与重启入口都存在。** supervisor 的 watch 只为自己开启的那一代上报退出，加载页从 fragment 渲染失败信息并显示 `#restart`，按钮调用壳的 `restart_dsh`。
- **壳仍不在 `verify-application-entrypoints` 的分类清单内**（无 `bin`、无 shebang 源、无根 `demo:` 脚本）；改成 Rust 二进制不改变这一点，若日后情况变化，该门禁的分类清单仍是登记之处。
