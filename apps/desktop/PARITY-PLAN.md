# Desktop 1:1 重写计划（Electron → Tauri）

目标：**功能与架构与 Electron 壳一一对应**。功能不丢、模块职责一一对应、对外接口（IPC 通道名、preload API 形状、状态类型字段）一一对应，测试面逐条对应。当前状态记录在 [PARITY.md](PARITY.md)。

## 0. 1:1 的定义（验收判据）

| 维度 | 判据 |
|---|---|
| 功能 | Electron `DshDesktopApi` 的每个方法、每个菜单项、每个恢复动作、每个打包产物都有对应实现 |
| 模块职责 | Electron 的 `main.ts` / `backend-controller.ts` / `project-manager.ts` / `locale.ts` / `update-coordinator.ts` / `renderer/*` / `scripts/*` 各自能找到唯一对应物，职责不混合 |
| 接口 | 通道名语义一致（`dsh-desktop:plugins-list` ↔ `plugins_list`），`window.dsh` 的形状与 Electron preload 相同，状态字段保持 `phase` / `message` / `profileRecovery` / `version` 等同名 camelCase |
| 测试 | Electron 的 16 个 spec 逐条找到对应测试（Rust 单测 / vitest / 手工冒烟），无行为失守 |

不变量（两个壳都必须保持，与 PARITY.md 第 2 节一致）：桌面组合、profile 落盘布局、线协议、HTTP 面、`__DSH_TRANSPORT__` 契约、前端产物、运行时闭包、CLI readiness/`--profile desktop` 独占。

## 1. 先定一个决策：传输父半是否也 1:1

Electron 的父半是 Node（`host-process.ts` 427 行：fd3/fd4 + Node IPC + 背压 + 取消 + 三级 teardown）。两种复刻方式：

| | 方案 A（现状） | 方案 B（更严格的 1:1） |
|---|---|---|
| 父半 | Rust `host/{client,frame,bridge}.rs` 直接当 Host 的父进程，`stdio` 载体 | Rust 只做窗口与渲染层桥；**fork 自带一个 Node "shell core"**，它原样复用 upstream 的 `host-process.ts`，由它去 spawn Host |
| `desktop-host` 上游面 | 2 个文件（`index.ts`、`wire.ts`）增量修改 | **0 个文件**（完全不动） |
| 进程数 | 壳 + Host | 壳 + shell core + Host |
| 协议 | v3 数据帧 + 增量事件/控制帧 | upstream v3 原样（fd3/4 + IPC 在 core↔Host 之间） |
| 架构接近度 | 高（换父进程语言） | **最高（父子关系与协议形状与 Electron 完全一致）** |
| 代价 | 维护 2 个上游文件的增量 | 多一个常驻 Node 进程；Rust↔core 仍需一条通道 |

**建议**：若"架构保持一样"按字面执行 → 选 **B**；若接受"父进程语言不同、协议等价" → 保持 **A**（现状已具备）。本计划其余部分与两者兼容，只有 §3 里 `host/` 与 `upstream/` 的落点不同。

## 2. 模块映射总表

| Electron（行数） | 职责 | Tauri 归属 | 状态 |
|---|---|---|---|
| `src/main.ts`(521) | 窗口、菜单、协议注册、15 个 IPC、紧急页、更新对话框、恢复编排 | `src-tauri/src/{shell,menu,recovery,backend}.rs` + `ui/` | ⚠️ 部分（窗口/托盘/载体/状态机已有） |
| `src/ipc.ts`(63) | 通道名常量 + `DshDesktopApi` / `DshDesktopStartupApi` 类型 | `ui/ipc.js`（页面侧同形状 API）+ Rust 命令 | 🔜 |
| `src/preload.ts`(38) / `preload-app.ts`(24) | contextIsolation 桥 | `ui/ipc.js`（`window.dsh`） | 🔜 |
| `src/backend-controller.ts`(148) | `starting/ready/error{message,profileRecovery}` + 串行重试 + 取消 | `src-tauri/src/backend.rs` | ✅ |
| `src/locale.ts`(127) | en/zh-CN 字典 + 占位符格式化 | `src-tauri/ui/locale.js` + `locale.d.ts` | ✅ |
| `src/project-manager.ts`(611) | pnpm 插件事务、锁文件、链接校验、恢复、`canRecoverProfile` | 方案 D：`src/desktop-plugins.ts` 薄 CLI（import 现有模块），Rust 调用 | 🔜 |
| `src/profile-packages.ts` / `runtime-tree.ts` / `owned-directory.ts` / `core-package-set.ts` / `paths.ts` / `release.ts` | 运行时闭包、描述符、校验、路径 | 原地保留，由 prepare 脚本与方案 D 共用 | ✅ |
| `src/update-coordinator.ts`(95) | 检查/下载/安装 + 状态机 | `src-tauri/src/update.rs` + `tauri-plugin-updater` | 🔜（需端点与签名） |
| `src/startup-document.ts`(26) / `startup-error.ts` | 失败页文档与诊断序列化 | `ui/index.html` + `backend.rs` 的 error 状态 | ⚠️ 部分 |
| `src/single-instance.ts`(26) | 单实例聚焦 | `tauri-plugin-single-instance`（`shell.rs`） | ✅ |
| `renderer/startup.{html,js,css}`(97) | 启动/恢复页 | `ui/index.html` | ⚠️ 部分（缺 Reset / Disable 按钮） |
| `renderer/plugin-manager.{js,css,html}`(265) | 插件管理页 | `ui/plugin-manager.{html,js,css}` + 第二窗口 | 🔜 |
| `scripts/package-target.ts`(331) | 打包编排 | `scripts/prepare-tauri*.ts` + `tauri build` | ⚠️ 部分（无签名/公证/上传） |
| `scripts/package-macos.ts`(122) / `notarize-macos-disk-images.mjs`(30) | dmg/pkg + 公证 | `tauri.conf.json` `bundle.macOS` + 公证脚本 | ⛔→🔜（本轮纳入） |
| `scripts/windows-sign.{mjs,cmd}`(283) | Windows 签名 | `tauri.conf.json` `bundle.windows`（certificateThumbprint/timestampUrl） | ⛔→🔜 |
| `scripts/installer.nsh`(70) | NSIS 安装/卸载钩子（卸载保留 `DSH_HOME`） | `bundle.windows.nsis.installerHooks` | ⛔→🔜 |
| `scripts/desktop-upload-plan.ts`(257) / `upload-target.ts`(83) | 产物上传计划 | fork 脚本（对象存储/发布渠道） | ⛔→🔜 |
| `scripts/desktop-auto-update-environment.mjs`(169) | 更新源环境变量 | 更新阶段的配置注入 | ⛔→🔜 |
| `tests/*.spec.ts`(16 个, ~2100 行) | 行为测试 | Rust 单测 + vitest + 手工冒烟（见 §5） | 🔜 |

## 3. 目标文件布局（与 Electron 职责对齐）

```
apps/desktop/
  src/                      Electron 时代保留的应用逻辑（prepare 与方案 D 共用）
    project-manager.ts  profile-packages.ts  runtime-tree.ts  core-package-set.ts
    owned-directory.ts  paths.ts  release.ts  host-protocol.ts  host-process.ts
    desktop-plugins.ts      ← 新增：方案 D 的 CLI 入口（plugins.* 六个操作）
  src-tauri/
    src/
      main.rs               Builder 装配（对应 Electron main() 的入口段）
      shell.rs              窗口、托盘、菜单、单实例、常驻、boot 选择
      supervisor.rs         runtime 解析、`dsh` 监督、进程组、崩溃监视
      backend.rs            状态机 + backend_status/backend_retry          ✅
      recovery.rs           restart_application/reset_desktop/disable_plugins（🔜）
      menu.rs               Desktop Plugins… / Check for Updates…（🔜）
      plugins.rs            plugins_* 命令，转发给 desktop-plugins CLI（🔜）
      update.rs             updates_* 命令 + tauri-plugin-updater（🔜）
      host/                 A：父半实现（frame/client/bridge）  B：Rust↔shell core 桥
    ui/                     壳自有页面（对应 Electron 的 renderer/）
      index.html            启动/恢复页（loading）
      plugin-manager.{html,js,css}
      locale.js/.d.ts       字典                                      ✅
      ipc.js                `window.dsh`（对应 preload.ts + ipc.ts）   🔜
    transport/desktop-transport.js   注入渲染层的 `__DSH_TRANSPORT__`   ✅
  scripts/
    prepare-tauri.ts   prepare-tauri-resources.ts   dev-runtime.ts   dev-host.ts
    host-smoke.ts      generate-host-wire-vectors.ts
    sign-macos.*  notarize-macos.*  sign-windows.*  installer-hooks.nsh  upload-plan.ts   （🔜）
```

方案 B 额外落点：`apps/desktop/shell-core/`（fork 自有的最小 Node 包，`package.json` + `index.mjs`，直接 `import '../src/host-process.ts'` 的编译产物），随 `bundle.resources` 分发。

## 4. 接口契约（保持同名同形）

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
| `dsh-desktop:application-restart` | `application_restart` | 启动页 `.restart()` 🔜 |
| `dsh-desktop:configuration-reset` | `configuration_reset` | 启动页 `.resetConfiguration()` 🔜 |
| `dsh-desktop:backend-state`（事件） | — | 轮询/事件（🔜，插件窗口需要） |
| `dsh-desktop:updates-check` | `updates_check` | `.updates.check()` 🔜 |
| `dsh-desktop:updates-install` | `updates_install` | `.updates.install()` 🔜 |
| `dsh-desktop:updates-state`（事件） | — | `.updates.subscribe()` 🔜 |
| （启动页专用）`disablePlugins` | `plugins_disable_all` 复用 | `.disablePlugins()` 🔜 |

状态类型字段保持：`DesktopBackendState`（`phase`/`message`/`profileRecovery`）、`DesktopUpdateState`（`phase`/`version`/`message`）、`DesktopPluginRecord`（按 `project-manager.ts` 现有字段）。

## 5. 分阶段计划

| 阶段 | 内容 | 文件 | 验收 | 估工 |
|---|---|---|---|---|
| **P0** | 页面侧 API 桥：`ui/ipc.js` 造出与 preload 同形的 `window.dsh`（`locale/plugins/backend/updates`），启动页与插件页共用 | `ui/ipc.js`、`ui/index.html` | vitest：`window.dsh` 形状与 Electron `DshDesktopApi` 键一一对应（对照快照） | 0.5 天 |
| **P1** | 恢复三件套 + 启动页按钮（Retry ✅ / Reset / Disable all）+ `profileRecovery` 决定是否显示 Reset | `src-tauri/src/recovery.rs`、`shell.rs`、`ui/index.html` | Rust 单测（动作分发、仅打包态允许 reset）+ 手工：指向不存在的 profile 触发失败后按钮可用 | 1–2 天 |
| **P2** | 插件管理：`desktop-plugins.ts`（复用 `DesktopProjectManager`）+ `plugins.rs` + `ui/plugin-manager.*` + 第二窗口 | 见 §3 | 单测（参数校验、路径、profile 锁定）+ 手工：列/装/卸/升级/启停/全禁，每步后端自动重启 | 3–5 天 |
| **P3** | 菜单与窗口 1:1：应用菜单两项、主窗口 ready 后再 show、导航失败进失败页 | `menu.rs`、`shell.rs` | 手工冒烟 + 失败路径日志 | 1 天 |
| **P4** | 更新：`tauri-plugin-updater` + `update.rs` + 状态事件 + 更新对话框（Tauri dialog 插件或自绘页） | `update.rs`、`menu.rs`、`ui/` | 单测（状态机、无端点时的失败分支）+ 手工：假装有新版本 | 2–3 天 |
| **P5** | 发布：签名/公证/安装器钩子（卸载保留 `DSH_HOME`）/上传计划 | `tauri.conf.json`、`scripts/*` | 手工：本地产出安装包并安装/卸载验证 `DSH_HOME` 保留 | 3–5 天 |
| **P6** | 测试面对齐：逐个补齐 Electron 的 16 个 spec 对应行为 | Rust/vitest | 见 §6 表 | 2–3 天 |

依赖：P2 依赖 P1 的后端重启语义；P4/P5 依赖发布端点与证书（没有则只能验证失败分支与配置解析）。

## 6. 无法逐字 1:1 的地方与替代

| Electron | Tauri 替代 | 契约是否等价 |
|---|---|---|
| `protocol.handle` 的流式代理 | 静态资产用 buffered custom scheme，流用 invoke + `Channel` | ✅ 等价（`__DSH_TRANSPORT__` 形状不变） |
| `dialog.showMessageBox` | `tauri-plugin-dialog` 或自绘对话框页 | ✅ 行为等价 |
| `app.relaunch()` / `app.exit()` | `app.restart()` / `app.exit()` | ✅ |
| `app.getLocale()` | `navigator.language` | ✅（同为系统语言来源） |
| `BrowserWindow` 第二窗口 + 独立 preload | `WebviewWindowBuilder` + 同一 `ui/` 目录页面 | ✅ |
| `electron-updater` + `app-update.yml` | `tauri-plugin-updater` + `tauri.conf.json` `plugins.updater` | ⚠️ 清单/签名格式不同，需要发布端点改造 |
| `electron-builder`（`--dir` 686 MiB） | Tauri bundle（系统 WebView，13 MB debug） | ⚠️ 产物形态不同，安装体验需重新验证 |

## 7. 测试对齐表（Electron spec → 对应实现）

| Electron spec（行数） | 对应测试 |
|---|---|
| `backend-controller.spec.ts`(170) | `backend.rs` 单测（已有 3 个）+ P1 补重试/取消 |
| `locale.spec.ts`(23) | `apps/desktop/tests/locale.spec.ts` ✅（4 个） |
| `startup-renderer.spec.ts`(175) | 页面无 DOM 测试；改为对 `ui/index.html` 的片段渲染做 jsdom 测试（P1） |
| `plugin-manager.spec.ts`(33) | P2：CLI 参数与记录映射单测 |
| `main-startup.spec.ts`(368) | P3：Rust 单测（boot 选择、失败页导航）+ 手工冒烟 |
| `single-instance.spec.ts`(32) | 手工冒烟（插件提供，无单测面） |
| `preload-app.spec.ts`(39) | P0：`window.dsh` 形状快照 |
| `update-coordinator.spec.ts`(102) | P4：状态机单测 |
| `desktop-auto-update-environment.spec.ts`(89) | P4：环境注入单测 |
| `package-target.spec.ts`(126) / `package-macos.spec.ts`(190) / `macos-signature.spec.ts`(242) / `macos-signing-walk.spec.ts`(36) / `windows-sign.spec.ts`(226) / `desktop-upload-plan.spec.ts`(195) | P5：打包/签名/上传脚本的单测（可直接复用被删测试的断言思路） |
| `host-protocol.spec.ts` / `host-process.spec.ts` | 仍在树上（upstream），由 Rust 侧黄金向量 + `smoke:host` 覆盖 |

## 8. 顺序与风险

1. **先 P0/P1**：它们让"壳自有 UI"这条线与 Electron 同形，后续插件窗口与更新对话框都建立在同一套 `window.dsh` 上。
2. **P2 是最大一块**（复用 611 行现有逻辑 + 新窗口 + 6 个命令），建议单独一个 PR。
3. **P4/P5 依赖外部构件**（更新端点、证书、发布渠道）；没有它们时只能完成实现与失败分支，不能宣称对齐。
4. **传输父半（§1）先拍板**：选 B 会改动 `host/` 的实现与进程拓扑，越早定越省返工；选 A 则保持现状。
5. 每个阶段按仓库惯例附 Agent Note，并在 PARITY.md 更新状态表。
