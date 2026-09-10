# Desktop shell boots the built CLI with a desktop-first profile and a V8 compile cache

Date: 2026-09-10 · Area: apps/desktop

## What changed

The Electron shell no longer launches the checkout CLI through tsx in dev.
Both launch modes run the built `apps/cli/lib/bin.js` under plain Node, the
desktop profile (`~/.dsh/profiles/desktop`, same bundles as `web` without the
home's MCP rows) is booted when it exists, and every launch sets
`NODE_COMPILE_CACHE` to `~/.dsh/compile-cache`.

## Measured effect

One-shot boot benchmark (`apps/desktop/bench/boot-bench.mjs`, spawn → the
`dsh web:` readiness line, Windows, 146-plugin desktop profile):

| configuration | time-to-ready |
|---|---|
| tsx + `web` profile + broken MCP rows | ~85 s |
| built CLI + `desktop` profile + no MCP | ~6–9 s |
| + `NODE_COMPILE_CACHE` warm | ~1–2 s faster |

`boot-bench.mjs` and `boot-once.mjs` stay in `apps/desktop/bench/` for
regression measurement; they are manual tools, not CI.

## Constraints recorded for future decisions

- **The compile cache flushes only on graceful process exit.** The shell
  stops dsh with a tree kill (`taskkill /T /F` on win32), so a session that
  ends by quitting the shell never writes cache entries. Reading the cache is
  unaffected, and cache content only changes when `lib/` is rebuilt, so one
  graceful exit (e.g. a SIGINT'ed CLI run) after each rebuild seeds every
  later boot. Hard-killed boots still read the stale-but-valid cache.
- **`NODE_COMPILE_CACHE` skips parse+compile only.** Module-body evaluation
  still runs; the measured ceiling is ~1–2 s of the ~9 s floor, not the full
  66 % compile share the CPU profile attributes to module loading.
- **The `desktop` profile lives in the user's Harness home, not in the
  repository.** The shell falls back to the shipped `web` profile when the
  directory does not exist, and `DSH_DESKTOP_PROFILE` overrides the choice.
- `sigbreak`-style graceful termination was tested on win32 and does not
  deliver a console control event to the hidden-spawned child; `taskkill /T /F`
  remains the teardown path.
