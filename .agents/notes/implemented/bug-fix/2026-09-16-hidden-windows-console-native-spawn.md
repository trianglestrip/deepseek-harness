# Agent Note: Hiding Windows console windows on the native spawn paths

Status: implemented

English | [中文](2026-09-16-hidden-windows-console-native-spawn.zh.md)

## Problem

The packaged desktop application runs its Harness runtime as a GUI image: `runtimeResources()` resolves `node` to `process.execPath`, so the desktop host is the Electron executable under `ELECTRON_RUN_AS_NODE`. A GUI image owns no console, and Windows allocates a NEW console — with a visible window — for a console-subsystem child whose caller has none.

Every ordinary command reaches Windows through `@deepseek-ai/dsh-win32-process`, including the ones that run inside the shell sandbox: the argv wrapper spawns the `windows-acl` runner, and the runner spawns the caller's PowerShell under the restricted token. Those `CreateProcessW` / `CreateProcessAsUserW` calls passed only `CREATE_SUSPENDED`, `CREATE_UNICODE_ENVIRONMENT`, or nothing, so each shell command opened a PowerShell window beside the desktop shell and closed it when the command exited. The node-spawn edges that feed the same paths had the same gap: `launchWindowsJob` started the private Job runner without `windowsHide`, and the desktop shell started its host process and its package transactions without it, while the fallback path (`spawnSubprocess`) already passed `windowsHide: process.platform === 'win32'`.

## Decision

`abi.ts` owns `CREATE_NO_WINDOW` (`0x08000000`) as a header-verified constant, and every process primitive passes it: `spawnPipedProcess`, `spawnInheritedJobProcess`, and `spawnCurrentTokenJobProcess`. A target therefore gets a windowless console no matter what its caller has, and a console-subsystem target never allocates a window.

The node-spawn edges that feed those primitives pass `windowsHide: true` for the same reason: `launchWindowsJob` (a source or CLI run reaches it with `process.execPath` = a console-subsystem `node`, which would otherwise open a window for the runner and hand that window to every target inside it), `DesktopHostProcess.start()`, and `DesktopProjectManager.runPnpm()`.

This also corrects a recorded boundary. [`@deepseek-ai/dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.md) documented that restricted-token children created with `CREATE_NO_WINDOW` die during DLL initialization with `STATUS_DLL_INIT_FAILED`; that does not reproduce under the shipped token (see Measurement). The earlier [hidden Windows subprocess windows](../../archived/bug-fix/2026-09-03-hidden-windows-subprocess-windows.md) note fixed only the node-spawn paths, and the [Windows ACL restricted-token sandbox](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) note carried the boundary as a cost.

## Alternatives considered

**`STARTF_USESHOWWINDOW` with `wShowWindow = SW_HIDE` instead of the creation flag.** It was the fallback plan while the restricted-token boundary was believed real, and it hides a window the system still creates. `CREATE_NO_WINDOW` is the mechanism Node already uses for `windowsHide`, keeps the window from being created at all, and proved sufficient under the restricted token.

**Hiding only the Job runner.** A GUI runner has no console to pass on, so the target still allocates its own window; and a console-subsystem runner passes on a visible one. Both edges need the option.

**Keeping the child attached to the host console.** The desktop host has no console to attach to, so this cannot be the desktop behavior, and it is what produced the window in the first place.

## Measurement

Windows 11 workstation, Harness source in this checkout. A helper enumerated top-level windows with `EnumWindows`, filtered to `ConsoleWindowClass`, `CASCADIA_HOSTING_WINDOW_CLASS`, and `PseudoConsoleWindow`, and reported visibility and owner pid; the Windows default terminal application is Windows Terminal, so a newly allocated console appears as a Windows Terminal window. Console-less parents were launched with `detached: true`, matching the packaged host's no-console condition.

| Path | Before | After |
| --- | --- | --- |
| `windows-acl` runner from a console-less parent, `--mode read-only`, child `exit 7` | 1 new visible window titled `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` | 0 visible windows, child exits 7 |
| `windows-acl` runner from a console-less parent, `--mode workspace-write` (agentless private temp capability), child `exit 7` | not measured | 0 visible windows, child exits 7 |
| Ordinary Job path via `LocalSubprocessRuntime.spawn()` from a console-less parent, target `powershell.exe`, child `exit 7` | 2 new visible windows: `CASCADIA_HOSTING_WINDOW_CLASS` titled `…\node.exe` plus its pseudo-console host | 0 visible windows; the only new window is a hidden `ConsoleWindowClass` owned by the runner, child exits 7 |

The restricted-token child completed normally in both modes, which is the evidence that retires the `STATUS_DLL_INIT_FAILED` boundary.

## Consequences

A Windows desktop session no longer flashes a console window per command, and a source or CLI run no longer opens one for the private Job runner. Unit tests pin the creation flags of all three primitives and the `windowsHide` option of the runner spawn. The verification is a workstation measurement of visible windows, not an automated gate: a regression on this path is silent to the suite because no test asserts window visibility, and the artifact must be rebuilt for a packaged application to pick the fix up.
