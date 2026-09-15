# Agent Note: The Tauri shell parents the desktop Host through a shell core

Status: implemented

English | [中文](2026-09-15-desktop-host-carrier.zh.md)

## Problem

The [Tauri shell](2026-09-14-desktop-shell-runs-on-tauri.md) reached the harness through a loopback HTTP server and an authenticated URL, because a supervisor is all the shell could realize without a Node runtime it could address. That is strictly weaker than what the shell it replaced did: the Electron parent spawned the private `@deepseek-ai/dsh-desktop-host` package, which composes the desktop profile in-process, serves renderer assets and `/api` from one handler table, and speaks a versioned framed protocol over pipes. Nothing about that could be kept as it stood, because the Host's parent needs descriptor 3 and 4 plus a Node IPC channel, and a Rust parent on Windows has neither: `std::process::Command` exposes only standard streams, and Node's IPC channel needs an inherited handle the standard library cannot hand over.

## Decision

A fork-owned Node process, the shell core, is the Host's parent. The Rust shell parents the core, and the installed Host package stays exactly as upstream wrote it.

- **The upstream parent half is reused, not rewritten.** `apps/desktop/src/shell-core.ts` drives `DesktopHostProcess` from `apps/desktop/src/host-process.ts`: descriptor 3 and 4, the IPC readiness handshake, upload backpressure, cancellation, and the three-step teardown all remain upstream code, and upstream's own `host-process.spec.ts` and `host-protocol.spec.ts` keep covering it.
- **The Host package carries no fork change.** `apps/desktop-host/src/index.ts` and `wire.ts` are byte-identical to upstream, so a merge from `upstream/master` never resolves semantics in this package. The frames the core needs beyond the Host's own wire — lifecycle events and control answers — live in `apps/desktop/src/shell-core-wire.ts`.
- **Frames own standard output.** The shell spawns the core as `node shell-core.js <runtimeDir> <projectDir> [--allow-linked-profile]` and exchanges the Host's frame layout with it: request `start`/`data`/`end`/`cancel`, response `start`/`data`/`end`/`error`, plus `ready` and `fatal` as events on the reserved id and `shutdown` as a control frame. Every other standard-output write is redirected to standard error, because the Harness logs freely.
- **The shell installs the renderer transport itself.** Tauri's `UriSchemeResponder` takes a fully materialized body, so a page whose transport streams over `fetch('/.dsh/remote-stream')` cannot work. The window is built in Rust with `initialization_script`, and `desktop-transport.js` defines `__DSH_TRANSPORT__` without a setter, so the script the Host injects for an Electron-family parent cannot replace it with one that would have to stream across a non-streaming URI scheme.
- **The wire is pinned across languages.** `apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json` holds the bytes the core emits; `apps/desktop/scripts/generate-host-wire-vectors.ts` regenerates it from `shell-core-wire.ts`, the Rust codec re-encodes every request vector byte-identically and decodes every response vector including in seven-byte chunks, and `apps/desktop/scripts/host-smoke.ts` drives the core end to end.
- **Development reaches the same carrier.** `DSH_DESKTOP_DEV_RUNTIME` names a workspace-linked runtime tree that `apps/desktop/scripts/dev-runtime.ts` builds, so `pnpm run dev:host` boots the packaged path, and the Host logs the first renderer request as it arrives. The supervisor path stays as the fallback for a checkout with no runtime at all.

## Alternatives considered

- **Add a stdio carrier inside `apps/desktop-host`.** Rejected: it made the upstream package a permanent fork patch (four files, one of them an entry-point rewrite) whose every later merge needs semantic resolution.
- **Implement the descriptor and IPC parent half in Rust.** Rejected: it needs raw `CreateProcess` with an inherited pipe handle and the `NODE_CHANNEL_FD` convention, which is more failure surface than driving upstream's own parent code.
- **Rewrite `desktop-host` so the shell can speak to it directly.** Rejected: its 680 lines boot a 423-package TypeScript application through the Cordis loader, so a rewrite is a rewrite of the Harness rather than of an entry point.
- **Rewrite the served index to inject the shell's transport.** Rejected: it makes the core touch response semantics — buffering HTML, rewriting `content-length` — for what a window initialization script already reaches.
- **A named pipe or Unix socket carrier.** Rejected: unlike standard streams, it is an address any local process can connect to, which is exactly the property the desktop composition removes.
- **Keep the supervisor path alone.** Rejected: the desktop profile's composition turns the Web server off and replaces the directory picker, so the fallback loses the desktop features rather than the transport.

## Consequences

- `apps/desktop-host` is indistinguishable from upstream, and the fork owns only `apps/desktop`; the desktop application is one Rust process parenting two Node processes where Electron parented one.
- Two hops carry every byte: the shell frames requests to the core, and the core drives the Host's descriptors. The extra process costs roughly 40 MB resident and about 0.1 s of startup against a boot measured in tens of seconds.
- The core depends on `DesktopHostProcess`'s constructor and `fetch` contract; an upstream change to that class surfaces immediately instead of silently, because the core is the only caller in this fork.
- The static asset handler materializes a whole body per request; a large renderer download is still bounded by memory, unlike the streamed API path.
- The request-body path sends one invoke payload per chunk; a multi-megabyte upload crosses the IPC boundary as many messages, which is unmeasured.
