# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop: an Electron shell that supervises `dsh --profile desktop`.

The shell is a supervisor, not an application launcher: it spawns the checkout's
`dsh` CLI (dev) or the bundled same-version `@deepseek-ai/dsh` (packaged) and
loads the authenticated web URL the server prints. Harness-side code is not
modified by the shell; browser authentication stays fully intact.

## How it works

```
Electron main (src/main.ts)
  ├─ resolveDshRuntime (src/dsh-runtime.ts)     dev: node + built checkout CLI · packaged: bundled Node + dsh bin
  ├─ startServer (src/server-process.ts)        spawn --profile desktop --no-open --port 0 (no shell)
  │    ├─ parseLaunchLine                       readiness = the `dsh web: <url>` stdout line (?token=…)
  │    └─ buildTreeKillArgs                     win32: taskkill /T /F · POSIX: detached process-group kill
  ├─ BrowserWindow.loadURL(authenticatedUrl)    the ?token= → cookie exchange happens in the navigation
  ├─ app-lifecycle (src/app-lifecycle.ts)       single instance · stop the dsh tree before quit · crash watch
  └─ preload (src/preload.ts)                   dsh-status / dsh-restart IPC only
```

- **Port 0**: the OS picks a free port; the real URL arrives on the readiness
  line, which web-app prints exactly once after its plugin tree settles.
- **Built CLI in every mode**: both launches run `apps/cli/lib/bin.js` under
  plain Node — the tsx source-launch hook re-transforms the tree on every boot
  (~45s here); a missing built entry lands on the error page with the fix.
  Run `pnpm run build` before `dev`.
- **Desktop-first profile**: the shell boots the `desktop` profile when it
  exists in the Harness home — same bundles as `web` without the home's MCP
  rows, so dsh does not wait on stdio MCP servers at startup. `DSH_DESKTOP_PROFILE`
  overrides; without a `desktop` profile the shell falls back to the shipped
  `web`.
- **Boot overlaps the window stack**: the dsh spawn happens before Electron
  builds its window, so the plugin-tree boot runs inside the shell's own
  initialization; the loading page ticks elapsed seconds locally (no IPC).
- **Resident by default**: closing the window hides it — the supervised
  server and the authenticated session stay warm, so re-opening is instant.
  The tray icon offers Show / Restart dsh / Quit; set
  `DSH_DESKTOP_RESIDENT=0` for close-to-exit.
- **No fixed sleep**: the window navigates when the server announces readiness,
  with a 180s ceiling; failures land on a local error page with a restart button.
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

## Packaging

```sh
pnpm --filter @deepseek-ai/dsh-desktop run package:dir   # unpacked distribution under release/win-unpacked
```

Two runtime inputs are assembled into `extraResources` before electron-builder
runs (`packaging/prepare-runtime.mjs`):

- `runtime/`: the standalone Node binary (npmmirror mirror first, nodejs.org
  as fallback; version overridable via `DSH_DESKTOP_NODE_VERSION`).
- `dsh-runtime/`: the dsh production closure, produced by walking the
  workspace link graph from `apps/cli` (manifest production dependencies
  only) and copying each reachable unit while preserving relative links —
  the closure resolves exactly like the checkout. `pnpm deploy` is not
  usable here: its legacy output drops transitive `.pnpm` entries at this
  workspace size.

electron-builder packs only the compiled entry and static window assets into
`app.asar`; the dsh closure and Node runtime travel outside the asar because
the spawned Node is a real OS process. Native modules are **not** rebuilt for
Electron (`npmRebuild: false`): the dsh tree runs under the bundled stock
Node, and nothing in the Electron main process requires native modules. The
unpacked distribution is verified end-to-end on Windows; the NSIS installer
target is the remaining packaging work item.

## Verification

Pure logic (URL-line parsing, kill arguments, runtime resolution) is
unit-tested under `tests/` and runs through the repository's root `vitest`
(`apps/*/tests/**/*.spec.ts` include):

```sh
pnpm exec vitest run apps/desktop
pnpm --filter @deepseek-ai/dsh-desktop run typecheck
```
