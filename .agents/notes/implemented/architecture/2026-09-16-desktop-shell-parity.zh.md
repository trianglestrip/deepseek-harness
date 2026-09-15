# Agent Note：Tauri 壳补齐 Electron 的应用层功能

Status: implemented

[English](2026-09-16-desktop-shell-parity.md) | 中文

## Problem

[Host 载体](2026-09-15-desktop-host-carrier.zh.md)让 Tauri 壳能提供与 Electron 壳相同的窗口，但没有提供 Electron 主进程围绕窗口做的那些功能：页面读取的 `window.dsh` 桥、托盘与对话框渲染的壳自有文案、应用内插件事务、更新检查与安装，以及重试之外的恢复动作。只把窗口服务好的壳丢掉的是这些功能，而不是传输。

## Decision

每项功能都保留它在 Electron 里的安排，只是由壳自己的程序完成原 Electron 主进程的工作。

- **`window.dsh` 取代两个 preload。** 壳把 `shell-api.js` 作为窗口初始化脚本安装，于是加载页、插件窗口与 Host 提供的应用文档都在自己的脚本运行前读到同一套 API。它的分组就是 Electron preload 的——`locale`、`backend`、`plugins`、`updates`——外加启动页动作 `resetConfiguration`、`restart`、`disablePlugins` 与 `openPluginWindow`。该全局不带 setter，页面无法替换它。
- **文案归 Rust。** `locale.rs` 持有中英文字典，并按页面报告的语言标签回答 `locale_get`，与 Harness Web UI 读取的是同一来源。页面与托盘因此不会漂移，而 `locale::current()` 记住最近一次回答，供没有页面的菜单与对话框动作使用。
- **插件事务作为程序运行。** `desktop-plugins.js` 驱动 Electron 主进程曾直接 import 的同一个 `DesktopProjectManager`，一条命令进、一个 JSON 结果出。壳在停掉后端的前提下启动它，于是 pnpm 改写文件时没有进程占用 profile；无论事务成功还是失败，随后都重启后端。托盘打开插件窗口，那是壳自有的页面。
- **更新沿用 Electron 协调器的状态机。** `update.rs` 报告 `idle`、`checking`、`available`、`installing`、`ready`、`error`，只在检查验证过之后才公布版本，安装前重新校验版本，且绝不安装自己未公布的版本。没有更新端点的构建回答 `idle` 而不是报错，这正是 Electron 协调器在构建不带更新配置时的行为；托盘的检查用原生对话框询问用户，`tauri.conf.json` 携带 `createUpdaterArtifacts` 以及一份由发布流程填写的空更新配置。
- **恢复覆盖启动页的四个动作。** `application_restart` 重启应用、`configuration_reset` 重建 profile、`plugins_disable_all` 禁用全部第三方插件、`backend_retry` 再次引导后端。页面仅在壳报告 `profileRecovery` 时提供重置与禁用，这正是 Electron 页面的门控条件；重启被串行化，两次操作无法交错地停止与引导后端。
- **打包在 Tauri 允许的范围内对齐 Electron。** bundle 携带开发者工具分类、发布者与版权、允许用户选择目录的 NSIS 安装模式，以及使用相同最低系统版本的 macOS hardened runtime。

## Alternatives considered

- **把字典留在页面里。** 否决：托盘与更新对话框在没有页面时也要渲染文案，所以壳本来就需要自己的一份；两份必然漂移。
- **用 `dsh plugin` 驱动插件事务。** 否决：`apps/cli` 直接拒绝 `desktop` profile，而 CLI 只转发 pnpm，并不暴露 toggle 与 disable-all。
- **用页面而不是对话框做更新。** 否决：Electron 的菜单用原生对话框询问，即使没有窗口聚焦用户也能看到它的按钮。
- **不经插件安装更新。** 否决：手写的下载没有签名校验，而该插件的校验是这个应用唯一能依赖的。
- **保留不串行化的重启。** 否决：Electron 协调器串行化了尝试；否则第二次点击会停掉第一次点击刚刚启动的 Host。

## Consequences

- fork 只拥有 `apps/desktop`；Harness、Host 包以及它们之间的线协议都不受这项工作影响。
- 代码之外剩下的是发布通道：签名与公证凭据、上传计划，以及更新端点与其公钥。没有它们的构建会报告无更新，且不安装任何东西。
- 插件窗口的原生标题在页面设置它之前保持英文，而标题文字与按钮已本地化。
- 壳的页面是 HTML 模块，其脚本没有单元测试；被覆盖的是它们调用的 API 与背后的 Rust。
