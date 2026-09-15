# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

DeepSeek Harness Desktop: a Tauri shell over the dsh application.

The shell renders the harness web GUI in the operating system's webview. It serves that GUI from the packaged desktop Host over a private framed carrier when the application carries a bundled runtime, and otherwise supervises `dsh --profile desktop` and loads the authenticated URL the server prints. Harness source is not modified by the shell; browser authentication stays intact. The [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.md) and the [Host carrier Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-desktop-host-carrier.md) record the decisions and what they traded away.

## Architecture

```
src-tauri/src
  ├─ shell.rs          window, tray, single instance, resident mode, boot choice
  ├─ supervisor.rs     shell-core and checkout resolution, `dsh` supervision
  ├─ backend.rs        backend availability, retry, and recovery actions
  └─ host/
       ├─ frame.rs     wire codec; golden vectors live in src-tauri/tests/fixtures
       ├─ client.rs    Node child, framed streams, readiness handshake, teardown
       └─ bridge.rs    invoke commands and the `dsh-app://` asset handler
src
  └─ shell-core.ts     Node parent of the installed Host (upstream `host-process.ts`)
```

- **A shell core parents the Host.** When the application resources carry `desktop-runtime/{node,dsh,shell-core.js}`, the shell spawns the core under the bundled upstream Node.js executable, and the core drives the installed `@deepseek-ai/dsh-desktop-host` over descriptor 3 and 4 plus the Node IPC channel the Host expects. Unary RPC and Gateway streams cross the shell's private framed carrier, so the desktop composition opens no Web server and no loopback port, and no token URL exists; `apps/desktop-host` itself carries no fork change.
- **The renderer transport is the shell's.** `desktop-transport.js` installs `__DSH_TRANSPORT__` with `ownsHost: true` plus `fetch` and `openStream` over the invoke commands, matching the seam a served page fills with HTTP and WebSocket. The shell injects it as a window initialization script and defines the global without a setter, because Tauri's URI-scheme responder cannot stream and the script the Host injects for an Electron-family parent would.
- **The supervisor path stays as the fallback.** Without a packaged runtime the shell spawns the checkout's built CLI with `--profile desktop --no-open --port 0`, reads the `dsh web: <authenticatedUrl>` line from its stdout, and navigates the window to that URL; the `?token=` → cookie exchange happens inside that first navigation.
- **Both paths use their own profile.** The supervised CLI boots the shipped `web` profile, because the desktop profile's composition turns the Web server off; `DSH_DESKTOP_PROFILE` overrides the choice. The Host composes `~/.dsh/profiles/desktop` as its plugin profile.
- **The shell owns its pages' API and copy.** `shell-api.js` installs `window.dsh` — `locale`, `backend`, `plugins`, `updates`, and the startup actions — into every page the shell owns, and `locale.rs` answers it from the dictionary the tray and dialogs read too. The plugin window is a shell page backed by `desktop-plugins.js`, which runs the same profile manager the Electron main process drove.
- **Lifecycle is the tray's.** Closing the window hides it, so the application and its session stay warm; the tray owns Show, Restart dsh, and Quit; `tauri-plugin-single-instance` focuses the existing window on a second launch. Both boot paths kill the whole dsh tree on Quit.
- **Failure surfaces on the loading page.** A boot failure, or a Host that exits after readiness, navigates back to the loading page with the message in the fragment; the page offers retry, relaunch, and — when the packaged runtime can rebuild a profile — disabling every third-party plugin or resetting the desktop profile.
- **Updates keep the Electron coordinator's phases.** The tray's Check for Updates… asks through a native dialog, and the shell installs only a version a check verified. A build without `plugins.updater.{endpoints,pubkey}` reports no update instead of failing.
- **The package publishes no JavaScript** (`files: []`); the shell reaches users as a platform installer.

## Development

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop run dev        # supervised fallback, built CLI
pnpm --filter @deepseek-ai/dsh-desktop run dev:host   # the packaged path from a linked runtime
```

Requires Node `^22.19 || >=24` and a Rust toolchain with the Tauri 2 prerequisites.

## Packaging

```sh
pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime
pnpm --filter @deepseek-ai/dsh-desktop run prepare:packages
pnpm --filter @deepseek-ai/dsh-desktop run prepare:dsh
pnpm --filter @deepseek-ai/dsh-desktop run prepare:resources
pnpm --filter @deepseek-ai/dsh-desktop run build
```

`tauri.conf.json` bundles `src-tauri/resources/desktop-runtime` — the bundled Node.js executable, the pnpm the plugin transactions run, the installed dsh closure, `shell-core.js`, and `desktop-plugins.js` — as the `desktop-runtime` resource directory, and `src-tauri/resources/` is a build output. A checkout without prepared resources still runs the supervisor path, so `tauri dev` needs no packaging step. A release build fills in `plugins.updater.{endpoints,pubkey}` and the platform signing and notarization settings; nothing in this fork configures them, so a build without them installs no updates.

## Repository ownership

This fork replaced the upstream Electron shell with the Tauri shell. `apps/desktop` belongs to the fork: the Electron sources, its tests, and its electron-builder release pipeline are deleted, and `apps/desktop/scripts/upstream-sync.sh` re-applies those deletions after a merge from `upstream/master`. The wire protocol is shared with the Host package rather than owned by either shell: `apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json` is the golden copy that the TypeScript Host encoder and the Rust codec are each tested against, and `apps/desktop/scripts/generate-host-wire-vectors.ts` regenerates it. [PARITY.md](PARITY.md) records what the Electron shell did and where this shell stands against it.
