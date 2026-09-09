# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop: an Electron shell that supervises `dsh --profile web`.

The shell is a supervisor, not an application launcher: it spawns the checkout's
`dsh` CLI (dev) or the bundled same-version `@deepseek-ai/dsh` (packaged) and
loads the authenticated web URL the server prints. Harness-side code is not
modified by the shell; browser authentication stays fully intact.

## How it works

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

- **Port 0**: the OS picks a free port; the real URL arrives on the readiness
  line, which web-app prints exactly once after its plugin tree settles.
- **No fixed sleep**: the window navigates when the server announces readiness,
  with a 60s ceiling; failures land on a local error page with a restart button.
- **No orphan processes**: teardown kills the whole dsh process tree, not just
  one pid — `exec` + `kill` left zombie servers holding the port.

## Development

```sh
pnpm install            # workspace install (electron is allow-listed in pnpm-workspace.yaml)
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

Requirements: Node `^22.19 || >=24` on PATH (the dsh engines range) and
`DEEPSEEK_API_KEY` in the environment or root `.env`.

Attach mode skips spawning and loads an already-running dsh web URL — useful
while iterating on dsh itself:

```sh
DSH_DESKTOP_URL='http://127.0.0.1:3080/?token=…' pnpm --filter @deepseek-ai/dsh-desktop run dev
```

## Packaging (planned)

The packaged distribution bundles a standalone Node runtime (`extraResources`,
asar-unpacked) plus the same-version `@deepseek-ai/dsh` package, because
Electron's embedded Node does not satisfy the dsh engines range and
`ELECTRON_RUN_AS_NODE` is therefore not an option. The electron-builder
configuration is the next work item; `resolveDshRuntime('packaged', …)`
already resolves that layout. See `PLAN.md` for the full roadmap, including
the stage-two IPC fetch/stream carrier that removes the loopback HTTP hop
between the renderer and dsh.

## Verification

Pure logic (URL-line parsing, kill arguments, runtime resolution) is
unit-tested under `tests/` and runs through the repository's root `vitest`
(`apps/*/tests/**/*.spec.ts` include):

```sh
pnpm exec vitest run apps/desktop
pnpm --filter @deepseek-ai/dsh-desktop run typecheck
```
