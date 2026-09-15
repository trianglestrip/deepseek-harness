# Agent Note: The Tauri shell carries the desktop Host over its framed transport

Status: implemented

English | [中文](2026-09-15-desktop-host-carrier.zh.md)

## Problem

The [Tauri shell](2026-09-14-desktop-shell-runs-on-tauri.md) reached the harness through a loopback HTTP server and an authenticated URL, because a supervisor is all the shell could realize without a Node runtime it could address. That is strictly weaker than what the shell it replaced did: the Electron parent spawned the private `@deepseek-ai/dsh-desktop-host` package, which composes the desktop profile in-process, serves renderer assets and `/api` from one handler table, and speaks a versioned framed protocol over pipes. The Electron contract could not simply be kept, because it required descriptor 3 and 4 plus a Node IPC channel, and a Rust parent on Windows has neither: `std::process::Command` exposes only standard streams, and Node's IPC channel needs an inherited handle the standard library cannot hand over.

## Decision

The Host keeps the composition and the Fetch semantics. The transport becomes a carrier seam whose `fd` layout stays the Electron contract, and the shell reaches the Host through standard streams.

- **`fd` stays the Electron contract.** Descriptors 3 and 4 keep carrying request and response frames, `ready` and `fatal` keep travelling on the Node IPC channel, and the ready event keeps reporting protocol version 3. An Electron-family parent needs no change to supervise this Host.
- **`stdio` is additive.** `DSH_DESKTOP_TRANSPORT=stdio` reads request frames from standard input and writes response frames to standard output, redirecting every other standard-output write to standard error so logs cannot corrupt the stream. It carries `ready` and `fatal` as response frames on id 0, `shutdown` as a request control frame, and their answers as `controlResult` frames, so a parent without an IPC channel supervises the Host on the same wire.
- **The renderer transport stays Host-injected.** `runDesktopHost` takes the injected script as an option, defaulting to the script the Electron shell expects; the Tauri shell supplies `apps/desktop/src-tauri/transport/desktop-transport.js` through `DSH_DESKTOP_TRANSPORT_SCRIPT` because Tauri's `UriSchemeResponder` takes a fully materialized body and only invoke plus a channel can stream.
- **The shell owns the parent half.** `apps/desktop/src-tauri/src/host` decodes and encodes the same bytes in Rust, spawns the installed Host under the bundled upstream Node.js executable, waits for readiness, and serves the webview from the `dsh-app://` protocol handler plus invoke commands: `dsh_request_start` opens a stream and delivers response frames through a Tauri channel, and the body, end, and cancel commands complete the exchange.
- **The wire is shared through golden vectors.** `apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json` holds the bytes the Host emits; `apps/desktop/scripts/generate-host-wire-vectors.ts` regenerates it, `apps/desktop/src-tauri/src/host/frame.rs` re-encodes every request vector byte-identically and decodes every response vector, including in seven-byte chunks, and `apps/desktop/scripts/host-smoke.ts` drives the installed Host over `stdio` end to end.
- **The supervisor path remains the fallback.** A checkout without prepared resources still boots `dsh web` and loads the announced URL, so `tauri dev` needs no packaging step and a broken carrier degrades to a working application.
- **Development reaches the same carrier.** `DSH_DESKTOP_DEV_RUNTIME` names a workspace-linked runtime tree that `apps/desktop/scripts/dev-runtime.ts` builds, so `pnpm run dev:host` boots the packaged path, and the Host logs the first renderer request as it arrives.

## Alternatives considered

- **Keep the Electron descriptor contract only.** Rejected: it cannot be satisfied by a Rust parent on Windows, and no Node parent ships in this fork any more.
- **Node IPC implemented by hand from Rust.** Rejected: it needs raw `CreateProcess` with an inherited pipe handle and the `NODE_CHANNEL_FD` convention, which is more failure surface than a framed stream the shell already understands.
- **A named pipe or Unix socket carrier.** Rejected: unlike standard streams, it is an address any local process can connect to, which is exactly the property the Host composition removes.
- **A Node launcher that bridges descriptors and IPC to standard streams.** Rejected: it adds a resident process per shell start, and it still needs the shell-side injection override, because the injected script decides whether streams reach the Host at all.
- **Only the static assets over the custom protocol.** Rejected as a stopping point: Tauri's `UriSchemeResponder` takes a fully materialized body, so streamed RPC and Gateway streams have to use IPC anyway; splitting them across two carriers buys nothing.
- **A breaking protocol version.** Rejected: bumping the shared version would make the upstream Electron parent refuse this Host, turning every later merge into a conflict instead of a mechanical one.
- **Move the plugin and backend control plane into the Host.** Not taken here: the supervisor path still covers plugin transactions through `dsh plugin`, and the control frames are the extension point if the shell ever needs them.

## Consequences

- The desktop composition again opens no Web server, no loopback port, and no token URL, and the shell ships the running dsh it was built against.
- The packaged path is verified in a window: the renderer's first `dsh_request_start` reaches the Host, which also confirms that the shell's own commands need no capability file.
- Two carriers with one wire format must stay in step; the fixture is what a protocol change updates first, and the Host, the TypeScript parent, and the Rust shell each fail loudly on an unknown frame type.
- The upstream surface is two files, `apps/desktop-host/src/index.ts` and `src/wire.ts`; both changes are additive, so the fork can merge upstream without resolving semantics.
- `serde_json` is built with `preserve_order`, so Rust request frames are byte-identical to the TypeScript ones rather than merely equivalent JSON.
- The static asset handler materializes a whole body per request; a large renderer download is still bounded by memory, unlike the streamed API path.
- The request-body path sends one invoke payload per chunk; a multi-megabyte upload crosses the IPC boundary as many messages, which is unmeasured.
- `apps/desktop/scripts/prepare-tauri-resources.ts` copies the prepared runtime into `src-tauri/resources/desktop-runtime`, which is a build output and stays out of git.
