# Desktop 功能对齐：Electron 提供了什么，当前 Tauri 壳走到哪里

本文是 **fork 内部的状态文档**（`apps/desktop/PARITY.md`，不在 upstream 的文档范围内），用于回答两件事：被替换掉的 Electron 壳原本提供哪些功能、当前 Tauri 壳对齐到什么程度、还差什么。设计取舍记录在两个 Agent Note 里：[Tauri 壳](../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.md) 与 [Host 载体](../.agents/notes/implemented/architecture/2026-09-15-desktop-host-carrier.md)。

状态标记：✅ 已对齐 ｜ ⚠️ 部分对齐 ｜ 🔜 待做 ｜ ⛔ 本轮明确不做。

## 1. 谁来替换谁（三层模型）

| 层 | Electron | 当前 Tauri | 是否"重写" |
|---|---|---|---|
| 壳（原 main 进程） | `src/main.ts`(521) + `preload*.ts` + `host-process.ts` + `renderer/`，15 个 IPC 通道 | `src-tauri/src/{shell,supervisor,backend}.rs` + `host/{client,frame,bridge}.rs` + `ui/` | ✅ 用 Rust 重写这一层 |
| 后端（子进程） | `apps/desktop-host`：组装 desktop profile、资产、`/api`、帧协议 | **与 upstream 逐字节相同**（fork 改动为 0） | ⛔ 不重写 |
| 应用逻辑（原住在 main 里） | `src/project-manager.ts`(611) + `profile-packages.ts` + `runtime-tree.ts` | 方案 D：薄 Node CLI（`apps/desktop/src/desktop-plugins.ts`，待做） | 🔜 换家，不重写 |

**要点**：换壳 = 换父进程。`desktop-host` 是大 Electron main 的子进程，它自己不该被重写；而 `project-manager` 虽住在 main 里，内容却是应用逻辑，必须换个家。

## 2. 不可变契约（两个壳都必须保持）

判据：**能跨过"壳 ↔ 后端/渲染层"边界、或落在磁盘上的，就是契约；只被壳内部看见的，由壳自由实现。**

| # | 契约 | 具体形态 | 钉住方式 |
|---|---|---|---|
| 1 | 桌面组合 | `apps/desktop-host/config/desktop.cordis.patch.yml`：停用 `web-startup`/`webserver`/`web-runtime`/`client-hmr`/`open-in-app`/`ui-open-in-app`/`directory-picker`；插入 `directory-picker-native` + `ui-directory-picker-native`；`connection` 注入 `credentials` | upstream 同一份文件，两个壳共用 |
| 2 | profile 落盘布局 | `$DSH_HOME/profiles/desktop/{package.json(dsh.profile.bundles), desktop.cordis.yml, node_modules}` | prepare 脚本 + 待换家的 project-manager |
| 3 | 线协议 | magic `0x44534833`、13 字节头、64 KiB 分块、请求/响应类型 1–4、**版本 3**；`fd` 走描述符 3/4 + Node IPC；`stdio` 增量追加事件/控制帧（类型 5/6） | 黄金向量 `src-tauri/tests/fixtures/host-wire-vectors.json` + Rust 单测 + `smoke:host` |
| 4 | HTTP 面 | 仅三条：`/.dsh/remote-stream`、`/api/*`、其余为资产；只用 pathname | Host 代码 + `smoke:host` |
| 5 | 渲染层 transport 契约 | `globalThis.__DSH_TRANSPORT__` = `ClientTransportHooks{ ownsHost: true, fetch?, openStream? }`（`packages/client/connection/src/client/index.ts:80/90/105`；`isLoopback` 由 `ownsHost` 决定，`:233`） | 注入脚本 + smoke 断言注入存在 |
| 6 | 前端产物 | `apps/web` 构建的同一份 dist（`index.html` + bundles + `/plugins/` 资产） | 同一构建产物 |
| 7 | 运行时闭包 | Node 运行时 + dsh 闭包 + `desktop-runtime` 描述符与校验 | `runtime-tree.ts` + native payload smoke |
| 8 | CLI 契约 | 监督路径的 `dsh web: <authenticatedUrl>` readiness 行；`--profile desktop` 归桌面应用独占（`apps/cli/src/args.ts:68` `rejectElectronProfile`） | Rust `parse_launch_line` 单测 + `packages/bundle/web-app/tests` |

## 3. 接口契约（Electron 通道 → Rust 命令 → 页面 API）

| Electron 通道（`DESKTOP_IPC`） | Rust 命令 | 页面 API |
|---|---|---|
| `dsh-desktop:locale-get` | `locale_get` | `window.dsh.locale()` |
| `dsh-desktop:plugins-list` | `plugins_list` | `window.dsh.plugins.list()` |
| `dsh-desktop:plugins-add` | `plugins_add(spec)` | `.add(spec)` |
| `dsh-desktop:plugins-remove` | `plugins_remove(name)` | `.remove(name)` |
| `dsh-desktop:plugins-update` | `plugins_update(name, version)` | `.update(name, version)` |
| `dsh-desktop:plugins-toggle` | `plugins_toggle(name, enabled)` | `.toggle(name, enabled)` |
| `dsh-desktop:plugins-disable-all` | `plugins_disable_all` | `.disableAll()` |
| `dsh-desktop:backend-status` | `backend_status` | `.backend.status()` ✅ |
| `dsh-desktop:backend-retry` | `backend_retry` | `.backend.retry()` ✅ |
| `dsh-desktop:application-restart` | `application_restart` | 启动页 `.restart()` ✅ |
| `dsh-desktop:configuration-reset` | `configuration_reset` | 启动页 `.resetConfiguration()` ✅ |
| `dsh-desktop:backend-state`（事件） | — | 无推送事件；页面轮询 `backend_status`（Electron 为事件推送） |
| `dsh-desktop:updates-check` | `updates_check` | `.updates.check()` ✅（无端点构建报 `idle`） |
| `dsh-desktop:updates-install` | `updates_install` | `.updates.install()` ✅（同上） |
| `dsh-desktop:updates-state`（事件） | — | 无推送事件；页面轮询 `updates_state`（Electron 为 `subscribe()`） |
| （启动页专用）`disablePlugins` | `plugins_disable_all` 复用 | `.disablePlugins()` ✅ |

状态类型字段保持：`DesktopBackendState`（`phase`/`message`/`profileRecovery`）、`DesktopUpdateState`（`phase`/`version`/`message`）、`DesktopPluginRecord`（按 `project-manager.ts` 现有字段）。

## 4. Electron 功能清单 → 当前状态

| # | Electron 能力 | 原实现 | Tauri 归属 | 状态 |
|---|---|---|---|---|
| 1 | 窗口、关窗常驻、单实例 | `main.ts` `createWindow`、`single-instance.ts` | `shell.rs`（`on_window_event`、`tauri-plugin-single-instance`） | ✅ |
| 2 | 托盘与菜单 | 原生应用菜单（`Application` → Desktop Plugins… / Check for Updates…） | `shell.rs` 托盘（Show / Desktop Plugins… / Check for Updates… / Restart dsh / Quit） | ✅ |
| 3 | 打包 Host 私有载体 | `host-process.ts` + fd3/4 + Node IPC | `src/shell-core.ts`（复用 `host-process.ts`）+ `src-tauri/src/host/{client,frame,bridge}.rs` + `transport/desktop-transport.js` | ✅ |
| 4 | 渲染层 transport 注入 | `DESKTOP_TRANSPORT_SCRIPT` 内联 | 壳以 `initialization_script` 注入 `transport/desktop-transport.js`（不可写 `__DSH_TRANSPORT__`） | ✅ |
| 5 | 监督回退路径 | 无（Electron 只有 Host 路径） | `supervisor.rs`：`dsh web` + readiness 行解析 + 崩溃监视 + 进程组 | ✅（Tauri 独有） |
| 6 | 后端状态机 | `backend-controller.ts`(148)：`starting/ready/error{message,profileRecovery}` + 串行重试 | `backend.rs`（状态机 + `profile_recovery` 判定）+ `shell.rs` 串行化重启 | ✅ |
| 7 | 状态与重试通道 | `backendStatus` / `backendRetry` | `backend_status` / `backend_retry` 命令 | ✅ |
| 8 | 恢复动作 | `applicationRestart` / `configurationReset` / `disablePlugins` | `application_restart` / `configuration_reset` / `plugins_disable_all` | ✅ |
| 9 | 启动/失败页 | `renderer/startup.*` + `startup-document.ts` + `startup-error.ts` | `ui/index.html`（本地化、失败 fragment、Retry / Disable all / Reset / Restart，按 `profileRecovery` 门控） | ✅ |
| 10 | 壳 UI 本地化 | `locale.ts`（en/zh-CN 全量字典 + `{name}` 格式化 + `localeGet`） | `src-tauri/src/locale.rs` + `locale_get`（页面与托盘共用一份，35 键 ×2） | ✅ |
| 11 | 插件管理窗口 | `renderer/plugin-manager.*` + 第二窗口 + 独立 preload | `shell.rs::open_plugin_window` + `ui/plugin-manager.{html,js,css}`（同一个 `window.dsh`） | ✅ |
| 12 | 插件操作（列表/装/卸/升级/启停/全禁） | 7 个 IPC + `project-manager.ts` | `src/desktop-plugins.ts`（复用同一 manager）+ `plugins.rs` 命令（停后端→事务→重启） | ✅ |
| 13 | profile 准备 | `createRuntimeProjectMetadata` / `createDevelopmentProjectMetadata` / `createPluginProfile` | `src/project-manager.ts`（保留，由 prepare 脚本与方案 D 使用） | ✅ |
| 14 | 运行时闭包准备与校验 | `prepare:runtime` / `prepare:packages` / `prepare:dsh` + `verifyDesktopRuntime` + native smoke | `scripts/prepare-tauri*.ts`（同一条流水线，输出到 `src-tauri/resources`） | ✅ |
| 15 | 更新检查/安装 | `update-coordinator.ts`(148) + `electron-updater` + `updatesState` | `update.rs`（同阶段状态机）+ `tauri-plugin-updater` + 托盘对话框；缺端点/公钥（发布配置） | ⚠️ |
| 16 | 签名/公证/安装器/上传 | `package-macos.ts`、`notarize-macos-disk-images.mjs`、`windows-sign.*`、`installer.nsh`、`desktop-upload-plan.ts` | `bundle` 携带分类/发布者/NSIS 安装模式/macOS hardened runtime + `createUpdaterArtifacts`；签名、公证、上传需凭据与发布渠道 | ⛔ |
| 17 | 调试端口 | `inspectPort` 传 Node inspector | —（dev 用 `dev:host`，未开 inspector） | 🔜 |
| 18 | Shell 注入页面属性、紧急页 | `startup-document.ts` | `shell-api.js` 安装 `window.dsh`；失败页承载 fragment 与恢复动作 | ✅ |

统计：✅ 14 项，⚠️ 1 项（更新：实现完成、待发布配置），🔜 2 项（调试端口、部分测试面对齐），⛔ 1 项（签名/公证/上传：需凭据与发布渠道）。

## 5. 同功能、不同实现（架构差异）

| 维度 | Electron | 当前 Tauri |
|---|---|---|
| 传输载体 | 描述符 3/4 + Node IPC（协议 v3） | `stdio` 帧（壳 ↔ shell core）→ 描述符 3/4 + Node IPC（core ↔ Host，upstream 原样）；`ready`/`fatal`/`shutdown`/`controlResult` 在壳这一侧走帧 |
| 渲染层通路 | `protocol.handle` 的 Node 流式代理 + `fetch('/.dsh/remote-stream')` | 静态资产走 buffered custom scheme（Tauri 的 responder 必须完整缓冲），流走 invoke + Channel |
| 监督路径 | 无 | 有：没有打包运行时时回退到 `dsh web`（loopback + token） |
| 引擎与体积 | Node + Chromium（`--dir` 686 MiB） | 系统 WebView + Rust（壳 debug 13 MB + bundled `desktop-runtime` 242 MB，安装体积约 255 MB） |
| 宿主页面 | `renderer/*.html` + preload 桥 | `ui/*.html` + `__TAURI_INTERNALS__.invoke` |
| 对话框 | `dialog.showMessageBox` | `tauri-plugin-dialog` 或自绘对话框页 |
| 重启与退出 | `app.relaunch()` / `app.exit()` | `app.restart()` / `app.exit()` |
| 系统语言 | `app.getLocale()` | `navigator.language`（同为系统语言来源） |
| 第二窗口 | `BrowserWindow` + 独立 preload | `WebviewWindowBuilder` + 同一 `ui/` 目录页面 |
| 更新器 | `electron-updater` + `app-update.yml` | `tauri-plugin-updater` + `tauri.conf.json` `plugins.updater`（清单/签名格式不同，需发布端点改造） |
| 打包 | electron-builder + 多平台脚本 | `prepare:all` → `bundle.resources` → `tauri build`（未配签名/公证） |

体积收益全部来自去掉 Chromium（约 430 MiB）；bundled 运行时闭包（node 89 MB + dsh 闭包 136 MB + pnpm 19 MB）占安装体积的 95%，壳二进制不再是体积杠杆，下一步体积优化对象是 `prepare-dsh` 产物与 pnpm，而非壳本身。

## 6. 当前验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 单测（含跨语言线协议向量） | `cargo test`（`apps/desktop/src-tauri`） | 29 passed |
| Host 端到端（stdin/stdout 载体） | `pnpm --filter @deepseek-ai/dsh-desktop run smoke:host` | ok：ready → 200 → 33 KB 文档含注入脚本 → shutdown 退出码 0 |
| 窗口内 Host 路径 | `pnpm --filter @deepseek-ai/dsh-desktop run dev:host` | `host ready: dsh 0.1.5-rc.2 at 11.9s` → `first renderer request: POST http://dsh-app.localhost/api/settings/describe` |
| 壳 API 桥 | `pnpm vitest run apps/desktop/tests/shell-api.spec.ts` | 通过（逐组断言命令与参数） |
| 启动/恢复页渲染 | `pnpm vitest run apps/desktop/tests/startup-page.spec.ts` | 8 passed（fragment 渲染、`profileRecovery` 门控、动作结果） |
| TS 类型检查 | `tsc -b tsconfig.host.json` / `tsconfig.client.json` | 0 error |
| 文档配对 | `pnpm run verify-translation-pairing` | 通过（README 与 Agent Note） |

**已被证伪的旧假设**：`capabilities.json` 是 `{}` 并不阻塞壳自身命令——Tauri 2.11.5 只对 `plugin:*` 命令走 `resolve_access`，app 命令不经 ACL；窗口内的首个 renderer 请求已证明这条路径可用。

## 7. 剩余工作（按顺序）

| 阶段 | 内容 | 验收方式 |
|---|---|---|
| P5 | 发布工程：签名/公证、NSIS 安装/卸载钩子（卸载保留 `DSH_HOME`）、上传计划、更新端点与公钥 | 手工：本地产出安装包并安装/卸载验证 `DSH_HOME` 保留；无凭据时只能验证失败分支与配置解析 |
| P6 | 测试面对齐：逐个补齐 Electron 的 16 个 spec 对应行为 | 见下方测试对齐表 |

依赖：P5 依赖外部构件（更新端点、证书、发布渠道）；没有它们时只能完成实现与失败分支，不能宣称对齐。

### 测试对齐表（Electron spec → 对应实现）

| Electron spec（行数） | 对应测试 | 状态 |
|---|---|---|
| `backend-controller.spec.ts`(170) | `backend.rs` 单测（状态序列化与发布）+ `supervisor.rs` 单测 | ⚠️ 重启串行化（`shell.rs::restart`）无单测面 |
| `locale.spec.ts`(23) | `locale.rs` Rust 单测（5 个：键集、占位符、语言回退） | ✅ |
| `startup-renderer.spec.ts`(175) | `tests/startup-page.spec.ts`（8 个 jsdom；页面脚本提取为 `ui/startup.js`） | ✅ |
| `plugin-manager.spec.ts`(33) | `tests/desktop-plugins.spec.ts`（CLI 参数与记录映射） | ✅ |
| `main-startup.spec.ts`(368) | Rust 单测：boot 选择（packaged/linked/监督）、`application_url`、失败 fragment 组合 | ⚠️ 导航时机与失败页跳转靠手工冒烟 |
| `single-instance.spec.ts`(32) | 手工冒烟（`tauri-plugin-single-instance` 提供，无单测面） | ⚠️ |
| `preload-app.spec.ts`(39) | `tests/shell-api.spec.ts`（`window.dsh` 形状逐组断言） | ✅ |
| `update-coordinator.spec.ts`(102) | `update.rs` 单测（阶段序列化、安装守卫：只装检查宣布过的版本） | ⚠️ re-check 与下载路径需 AppHandle，未单测 |
| `desktop-auto-update-environment.spec.ts`(89) | — | N/A：Tauri 更新配置由 `tauri.conf.json` 构建期注入，无运行时环境变量面 |
| `package-target.spec.ts`(126) / `package-macos.spec.ts`(190) / `macos-signature.spec.ts`(242) / `macos-signing-walk.spec.ts`(36) / `windows-sign.spec.ts`(226) / `desktop-upload-plan.spec.ts`(195) | 打包基础面已有：`tests/desktop-build-paths.spec.ts`、`tests/macos-runtime.spec.ts`、`tests/macos-notarized-application.spec.ts`、`tests/prepare-package-set.spec.ts`、`tests/core-package-set.spec.ts`、`tests/runtime-file-policy.spec.ts` | ⛔ 签名/公证/上传随 P5，fork 未配置凭据 |
| `host-protocol.spec.ts` / `host-process.spec.ts` | 仍在树上（upstream），由 Rust 侧黄金向量 + `smoke:host` 覆盖 | ✅ |

## 8. 本机环境注意（不影响仓库本身）

- 本机 `npm` 安装损坏（缺 `npm-cli.js`/`npm-prefix.js`），而仓库脚本内部调用 `npm run …`；用 PATH shim（`npm` → `pnpm`，需同时提供 `npm.cmd`）才能跑 `pnpm run typecheck` 与 pre-push hook。
- lefthook 的 `third-party notices` 钩子在本机必然失败：`node_modules` 缺 lockfile 要求的 `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.263`，且 `pnpm install --frozen-lockfile --force` 报 "Already up to date" 不补装。涉及 `pnpm-lock.yaml`/`apps/*/src/**` 的提交需 `--no-verify`，或在一致的 `node_modules` 上重跑该生成器。
