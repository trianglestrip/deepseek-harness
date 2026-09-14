# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

DeepSeek Harness Desktop: a Tauri shell over the dsh application.

The shell renders the harness web GUI in the operating system's webview. It serves that GUI from the packaged desktop Host over a private framed carrier when the application carries a bundled runtime, and otherwise supervises `dsh --profile desktop` and loads the authenticated URL the server prints. Harness source is not modified by the shell; browser authentication stays intact. The [Tauri shell Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-desktop-shell-runs-on-tauri.md) and the [Host carrier Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-desktop-host-carrier.md) record the decisions and what they traded away.

## Architecture

```
src-tauri/src
  ├─ shell.rs          window, tray, single instance, resident mode, boot choice
  ├─ supervisor.rs     packaged-runtime and checkout resolution, `dsh` supervision
  └─ host/
       ├─ frame.rs     protocol v4 codec; golden vectors live in apps/desktop-host/fixtures
       ├─ client.rs    Node child, framed streams, readiness handshake, teardown
       └─ bridge.rs    invoke commands and the `dsh-app://` asset handler
```

- **The packaged Host is the primary path.** When the application resources carry `desktop-runtime/{node,dsh,desktop-transport.js}`, the shell spawns the installed `@deepseek-ai/dsh-desktop-host` under the bundled upstream Node.js executable with `DSH_DESKTOP_TRANSPORT=stdio`, waits for the protocol-v4 readiness event, and navigates the window to `dsh-app://localhost/index.html` (`http://dsh-app.localhost/index.html` on Windows). Unary RPC and Gateway streams then cross the shell's private framed carrier, so the desktop composition opens no Web server and no loopback port, and no token URL exists.
- **The renderer transport is injected by the Host.** `desktop-transport.js` installs `__DSH_TRANSPORT__` with `ownsHost: true` plus `fetch` and `openStream` over the invoke commands, matching the seam a served page fills with HTTP and WebSocket.
- **The supervisor path stays as the fallback.** Without a packaged runtime the shell spawns the checkout's built CLI with `--profile desktop --no-open --port 0`, reads the `dsh web: <authenticatedUrl>` line from its stdout, and navigates the window to that URL; the `?token=` → cookie exchange happens inside that first navigation.
- **Both paths run the same profile.** `dsh --profile desktop` is the shipped profile: the `base` and `web-app` bundles without the Harness home's MCP patch rows. The supervisor selects it when `~/.dsh/profiles/desktop` exists, `DSH_DESKTOP_PROFILE` overrides the choice, and the Host composes the same directory as its plugin profile.
- **Lifecycle is the tray's.** Closing the window hides it, so the application and its session stay warm; the tray owns Show, Restart dsh, and Quit; `tauri-plugin-single-instance` focuses the existing window on a second launch. Both boot paths kill the whole dsh tree on Quit.
- **Failure surfaces on the loading page.** A boot failure, or a Host that exits after readiness, navigates back to the loading page with the message in the fragment and reveals a Restart button.
- **The package publishes no JavaScript** (`files: []`); the shell reaches users as a platform installer.

## Development

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop run dev
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

`tauri.conf.json` bundles `src-tauri/resources/desktop-runtime` as the `desktop-runtime` resource directory, and `src-tauri/resources/` is a build output. A checkout without prepared resources still runs the supervisor path, so `tauri dev` needs no packaging step.

## Repository ownership

This fork replaced the upstream Electron shell with the Tauri shell. `apps/desktop` belongs to the fork: the Electron sources, its tests, and its electron-builder release pipeline are deleted, and `apps/desktop/scripts/upstream-sync.sh` re-applies those deletions after a merge from `upstream/master`. The wire protocol is shared with the Host package rather than owned by either shell: `apps/desktop-host/fixtures/wire-vectors.json` is the golden copy that the TypeScript, Rust, and Host codecs are each tested against.
