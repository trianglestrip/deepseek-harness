# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

DeepSeek Harness Desktop：监督 `dsh --profile web` 的 Electron 壳。

壳是监督者（supervisor），不是应用启动器：它 spawn checkout 的 `dsh` CLI（dev）或捆绑的同版本 `@deepseek-ai/dsh`（packaged），并加载服务器打印的已鉴权 Web URL。壳不修改 harness 侧代码，浏览器鉴权完整保留。

## 工作方式

```
Electron main (src/main.ts)
  ├─ resolveDshRuntime (src/dsh-runtime.ts)     dev: node + tsx + checkout CLI · packaged: bundled Node + dsh bin
  ├─ startServer (src/server-process.ts)        spawn --profile web --no-open --port 0 (no shell)
  │    ├─ parseLaunchLine                       readiness = the `dsh web: <url>` stdout line (?token=…)
  │    └─ buildTreeKillArgs                     win32: taskkill /T /F · POSIX: detached process-group kill
  ├─ BrowserWindow.loadURL(authenticatedUrl)    the ?token= → cookie exchange happens in the navigation
  ├─ app-lifecycle (src/app-lifecycle.ts)       single instance · stop the dsh tree before quit · crash watch
  └─ preload (src/preload.ts)                   dsh-status / dsh-restart IPC only
```

- **端口 0**：由 OS 分配空闲端口；真实 URL 来自就绪行——web-app 在插件树稳定后恰好打印一次该行。
- **无固定 sleep**：窗口在服务器宣告就绪时才导航，上限 60 秒；失败落到本地错误页并提供重启按钮。
- **无孤儿进程**：终止时杀掉整棵 dsh 进程树而非单个 pid——`exec` + `kill` 的旧实现会留下占住端口的僵尸服务器。

## 开发

```sh
pnpm install            # workspace install (electron is allow-listed in pnpm-workspace.yaml)
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

前置要求：PATH 上有 `^22.19 || >=24` 的 Node（dsh engines 范围），环境或根 `.env` 中有 `DEEPSEEK_API_KEY`。

附着模式跳过 spawn，直接加载一个已在运行的 dsh web URL——便于迭代 dsh 本身：

```sh
DSH_DESKTOP_URL='http://127.0.0.1:3080/?token=…' pnpm --filter @deepseek-ai/dsh-desktop run dev
```

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package:dir   # unpacked distribution under release/win-unpacked
```

electron-builder 运行前，`packaging/prepare-runtime.mjs` 会把两个运行时输入装配进 `extraResources`：

- `runtime/`：独立 Node 二进制（先走 npmmirror 镜像、nodejs.org 兜底；版本可用 `DSH_DESKTOP_NODE_VERSION` 覆盖）。
- `dsh-runtime/`：dsh 生产闭包——从 `apps/cli` 出发遍历 workspace 链接图（只跟 manifest 的生产依赖），复制每个可达单元并保留相对链接，闭包的解析行为与 checkout 完全一致。`pnpm deploy` 在此处不可用：这种规模的 workspace 下其 legacy 产物会丢失 `.pnpm` 传递条目。

electron-builder 只把编译产物与静态窗口资产打进 `app.asar`；dsh 闭包与 Node runtime 走 asar 外的 `extraResources`——spawn 出的 Node 是真实系统进程，读不了 asar 虚拟路径。原生模块**不**为 Electron 重编译（`npmRebuild: false`）：dsh 树运行在捆绑的原生 Node 下，Electron 主进程也不依赖任何原生模块。未打包分发已在 Windows 上完成端到端验证；NSIS 安装器目标是剩余的打包工作项。

## 验证

纯逻辑（URL 行解析、kill 参数、runtime 解析）的单测位于 `tests/`，经仓库根 `vitest` 运行（`apps/*/tests/**/*.spec.ts` include）：

```sh
pnpm exec vitest run apps/desktop
pnpm --filter @deepseek-ai/dsh-desktop run typecheck
```
