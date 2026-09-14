# Agent Note: Desktop shell boots the built CLI with a desktop-first profile and a V8 compile cache

Status: implemented

English | [中文](2026-09-10-desktop-built-cli-boot-and-compile-cache.zh.md)

## Problem

The shell's dev face launched the checkout CLI through tsx, which re-transforms the plugin tree on every boot and cost ~45 s before the window could navigate. On top of that, the home's `web` profile carried mirrored stdio MCP rows (github, playwright, codegraph, everything-search), so boot also waited on external MCP servers, and the ~146-plugin module graph re-parsed its JavaScript from scratch every start — CPU profiling attributed ~66 % of boot to module loading.

## Decision

The shell runs the built `apps/cli/lib/bin.js` under plain Node from `PATH`. It boots the `desktop` profile (`~/.dsh/profiles/desktop`) when it exists — same bundles as `web`, no MCP patch rows — falls back to the shipped `web` otherwise, and `DSH_DESKTOP_PROFILE` overrides the choice. The compile-cache half of this decision does not survive the [Tauri shell](../architecture/2026-09-14-desktop-shell-runs-on-tauri.md): `spawn_dsh` passes no environment, so `NODE_COMPILE_CACHE` is unset, and the bench scripts went with the Electron sources.

## Alternatives considered

- **Keep the tsx source launch.** Rejected: tsx has no cross-process transform cache, so the ~45 s re-transform recurs on every boot; the built `lib/` is the repository's sanctioned artifact plane and boots in single-digit seconds.
- **Run dsh under an embedded shell runtime.** Rejected: the Electron 33 runtime this was weighed against embedded Node 20.x, below the required `^22.19 || >=24`; the shell spawns `node` from `PATH` instead.

## Consequences

One-shot boot benchmark (spawn → the `dsh web:` readiness line, Windows, 146-plugin desktop profile; the measuring script went with the Electron sources):

| configuration | time-to-ready |
|---|---|
| tsx + `web` profile + broken MCP rows | ~85 s |
| built CLI + `desktop` profile + no MCP | ~6–9 s |
| + `NODE_COMPILE_CACHE` warm | ~1–2 s faster |

- **The compile cache flushes only on graceful process exit.** The shell stops dsh with a tree kill (`taskkill /T /F` on win32), so a session that ends by quitting the shell never writes cache entries. Reading the cache is unaffected, and cache content only changes when `lib/` is rebuilt, so one graceful exit (e.g. a SIGINT'ed CLI run) after each rebuild seeds every later boot. Hard-killed boots still read the stale-but-valid cache. Nothing seeds the cache while `NODE_COMPILE_CACHE` is unset, as it is in the Tauri shell.
- **`NODE_COMPILE_CACHE` skips parse+compile only.** Module-body evaluation still runs; the measured ceiling is ~1–2 s of the ~9 s floor, not the full 66 % compile share the CPU profile attributes to module loading.
- **The `desktop` profile lives in the user's Harness home, not in the repository.** The shell falls back to the shipped `web` profile when the directory does not exist, and `DSH_DESKTOP_PROFILE` overrides the choice.
- `sigbreak`-style graceful termination was tested on win32 and does not deliver a console control event to the hidden-spawned child; `taskkill /T /F` remains the teardown path.
- The four mirrored MCP rows were removed from the home's `web` profile on request after this note shipped; with them gone, `web` and `desktop` boot in the same range, and the shell's profile fallback no longer risks inheriting the MCP wait.
