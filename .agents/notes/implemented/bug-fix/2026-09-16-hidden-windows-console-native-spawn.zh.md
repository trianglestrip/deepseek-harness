# Agent Note：在原生进程创建路径上隐藏 Windows 控制台窗口

状态：implemented

[English](2026-09-16-hidden-windows-console-native-spawn.md) | 中文

## Problem

打包后的桌面应用把 Harness 运行时作为 GUI 镜像运行：`runtimeResources()` 把 `node` 解析为 `process.execPath`，因此桌面宿主是在 `ELECTRON_RUN_AS_NODE` 下运行的 Electron 可执行文件。GUI 镜像没有控制台，而 Windows 会为调用方没有控制台的 console 子系统子进程**新分配**一个带可见窗口的控制台。

每条普通命令都经由 `@deepseek-ai/dsh-win32-process` 到达 Windows，包括在 shell 沙箱内运行的那些：argv 包装器启动 `windows-acl` runner，runner 再以受限 token 启动调用方的 PowerShell。这些 `CreateProcessW` / `CreateProcessAsUserW` 调用只传了 `CREATE_SUSPENDED`、`CREATE_UNICODE_ENVIRONMENT` 或什么都没有，于是每条 shell 命令都会在桌面壳旁弹出一个 PowerShell 窗口，并在命令结束时关闭。供给这些路径的 node 启动边存在同样的缺口：`launchWindowsJob` 启动私有 Job runner 时没有传 `windowsHide`，桌面壳启动宿主进程与包事务时也没有传，而回退路径（`spawnSubprocess`）早已传入 `windowsHide: process.platform === 'win32'`。

## Decision

`abi.ts` 把 `CREATE_NO_WINDOW`（`0x08000000`）作为经头文件核验的常量持有，三个进程原语都传入它：`spawnPipedProcess`、`spawnInheritedJobProcess`、`spawnCurrentTokenJobProcess`。因此无论调用方有没有控制台，target 都只会得到无窗口的控制台，console 子系统的 target 不再分配窗口。

供给这些原语的 node 启动边出于同样理由传入 `windowsHide: true`：`launchWindowsJob`（源码或 CLI 运行到达它时 `process.execPath` 是 console 子系统的 `node`，否则会为 runner 打开一个窗口并把它交给其中的每个 target）、`DesktopHostProcess.start()` 与 `DesktopProjectManager.runPnpm()`。

这同时更正了一条已记录的边界。[`@deepseek-ai/dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.zh.md) 曾记录：以 `CREATE_NO_WINDOW` 创建的受限 token 子进程会在 DLL 初始化期间以 `STATUS_DLL_INIT_FAILED` 死亡；在交付的 token 下这一点无法复现（见 Measurement）。更早的[隐藏 Windows 子进程窗口](../../archived/bug-fix/2026-09-03-hidden-windows-subprocess-windows.md)笔记只修了 node 启动路径，而 [Windows ACL 受限 token 沙箱](../feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)笔记把该边界作为代价记录。

## Alternatives considered

**用 `STARTF_USESHOWWINDOW` 加 `wShowWindow = SW_HIDE` 代替创建标志。** 在受限 token 边界仍被相信存在时，这是备用方案，它隐藏的是系统仍会创建的窗口。`CREATE_NO_WINDOW` 是 Node 已经为 `windowsHide` 使用的机制，让窗口根本不产生，且在受限 token 下被证明足够。

**只隐藏 Job runner。** GUI runner 没有控制台可传递，target 仍会分配自己的窗口；而 console 子系统的 runner 传递的是一个可见窗口。两条边都需要该选项。

**让子进程继续附着在宿主控制台上。** 桌面宿主没有可附着的控制台，因此这不可能是桌面行为，而且它正是窗口的来源。

## Measurement

Windows 11 工作站，本 checkout 的 Harness 源码。一个辅助脚本用 `EnumWindows` 枚举顶层窗口，按 `ConsoleWindowClass`、`CASCADIA_HOSTING_WINDOW_CLASS`、`PseudoConsoleWindow` 过滤，并报告可见性与属主 pid；Windows 的默认终端应用是 Windows Terminal，因此新分配的控制台表现为一个 Windows Terminal 窗口。无控制台的父进程以 `detached: true` 启动，与打包宿主的无控制台条件一致。

| 路径 | 修复前 | 修复后 |
| --- | --- | --- |
| 无控制台父进程下的 `windows-acl` runner，`--mode read-only`，子进程 `exit 7` | 1 个新的可见窗口，标题为 `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` | 0 个可见窗口，子进程退出码 7 |
| 无控制台父进程下的 `windows-acl` runner，`--mode workspace-write`（无 agent 的私有临时能力），子进程 `exit 7` | 未测量 | 0 个可见窗口，子进程退出码 7 |
| 无控制台父进程下经 `LocalSubprocessRuntime.spawn()` 的普通 Job 路径，target 为 `powershell.exe`，子进程 `exit 7` | 2 个新的可见窗口：标题为 `…\node.exe` 的 `CASCADIA_HOSTING_WINDOW_CLASS` 及其伪控制台宿主 | 0 个可见窗口；唯一的新窗口是 runner 拥有的隐藏 `ConsoleWindowClass`，子进程退出码 7 |

受限 token 子进程在两种模式下均正常完成，这是让 `STATUS_DLL_INIT_FAILED` 边界作废的证据。

## Consequences

Windows 桌面会话不再为每条命令闪现控制台窗口，源码或 CLI 运行也不再为私有 Job runner 打开窗口。单元测试钉住三个原语的创建标志与 runner 启动的 `windowsHide` 选项。该验证是工作站上的可见窗口测量，而不是自动化门禁：这条路径上的回归对测试套件是静默的，因为没有任何测试断言窗口可见性；且打包后的应用必须重新构建才能带上此修复。
