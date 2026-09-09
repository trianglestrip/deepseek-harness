# Agent Note: The desktop shell supervises `dsh --profile web` through its stdout readiness line

Status: implemented

English | [中文](2026-09-09-desktop-shell-supervises-dsh-web.zh.md)

## Problem

The product needed a desktop client. The first Electron prototype spawned `dsh --profile web` but pointed the window at a bare `http://localhost:<port>` URL, which fails browser authentication — so the prototype short-circuited `BrowserAuth.authorizeIndex` and `isAuthenticated` in `dsh-client-connection` to `return true`. That turned a loopback agent server into an unauthenticated endpoint any local process could drive, and it made the desktop client a fork of harness source. The same prototype also fixed the port by hand, waited a hard-coded 5 seconds for readiness, and spawned through `exec`, whose `kill()` reaps only the wrapper shell and leaves the dsh process tree holding the port.

## Decision

`apps/desktop` is a **supervisor over `dsh --profile web`**, and dsh remains the only application launcher. The Electron main process spawns the dsh CLI directly (no shell) with `--no-open --port 0`, parses stdout for the `dsh web: <authenticatedUrl>` line — the readiness signal web-app already documents for supervisors — and navigates the window to that URL. The `?token=` → cookie exchange happens inside that first navigation, driven by Chromium's own cookie jar. Harness source is untouched: the `browser-auth` bypass is reverted, and the desktop client never loads an unauthenticated URL.

Supporting rulings:

- **Port 0, URL from stdout.** The OS assigns the port; the shell learns the real URL from the readiness line. A fixed port was a conflict and a mismatch waiting to happen.
- **Tree teardown.** win32 kills the tree with `taskkill /pid <pid> /T /F`; POSIX spawns the dsh process detached so it leads its own process group and teardown signals the group, escalating to SIGKILL after a 3s grace. Readiness, kill arguments, and runtime resolution are pure functions unit-pinned by the root vitest lane (`apps/*/tests/**` include).
- **Packaged runtime.** The packaged form bundles a standalone Node `^22.19 || >=24` plus the same-version `@deepseek-ai/dsh` bin; dev spawns the checkout through tsx. Electron's embedded Node does not satisfy the engines range, so `ELECTRON_RUN_AS_NODE` is not a shortcut.
- **Crash and exit semantics.** The single-instance lock funnels second launches into focusing the existing window; `before-quit` stops the dsh tree before Electron exits; an unexpected dsh exit lands on a local error page with a restart affordance.

## Alternatives considered

- **Keep the authentication bypass.** Rejected: it removes browser authentication from a server that can drive an agent on the local machine, violates the fixed security invariants, and couples the desktop client to a harness-source fork; the stdout token line already exists precisely for programmatic supervisors.
- **Boot the web profile in-process from Electron.** Rejected: the Application launch rule makes the `dsh` CLI with a named profile the only supported Node application launcher, and `verify-application-entrypoints` keeps bins, executable sources, and demos from bypassing it.
- **`ELECTRON_RUN_AS_NODE` to run dsh under Electron's Node.** Rejected: Electron 33 embeds Node 20.x, below the required `^22.19 || >=24`; the dsh CLI would run on an unsupported engine.
- **Drive the SDK JSON-RPC client and build a native UI.** Rejected for now: it abandons the entire web GUI. The sanctioned GUI-reusing evolution is the IPC fetch/stream carrier the webserver README reserves for Electron — renderer over `file://`, `createWebConnectionRpc(doFetch, openStream)` bridged through IPC — recorded as stage two in `apps/desktop/PLAN.md`.
- **Fixed port plus a fixed sleep.** Rejected: port conflicts and raced readiness (white screen on slow boots, wasted seconds on fast ones); the announce line is the authoritative signal.

## Consequences

- The `dsh web: ` line format is now a cross-package contract with the desktop shell as consumer: `parseLaunchLine` unit tests pin it, and a web-app change to the line must update the desktop parser in the same change.
- The packaging work item must bundle a Node runtime and `@deepseek-ai/dsh` (`extraResources` + asar unpack) and prove the packaged launch on a clean machine; only the dev face is exercised in-repo today.
- The shell currently sits outside `verify-application-entrypoints` classifications (no `bin`, no shebang source, no root `demo:` script); if the desktop form ever grows a launcher-shaped surface, the gate's classification inventory is the place to record it.
- Stage two — renderer assets over `file://`/`app://` with `doFetch`/`openStream` bridged over IPC, removing the loopback HTTP hop between renderer and dsh — remains future work; until then the renderer talks to dsh over loopback HTTP like any browser tab.
