# Agent Note: The Tauri shell reaches Electron's application features

Status: implemented

English | [中文](2026-09-16-desktop-shell-parity.zh.md)

## Problem

The [Host carrier](2026-09-15-desktop-host-carrier.md) gave the Tauri shell the same window the Electron shell served, but not the features its main process provided around it: the `window.dsh` bridge pages read, the shell-owned copy the tray and dialogs render, in-application plugin transactions, an update check and install, and the recovery actions beyond retry. A shell that only serves the window loses those features rather than the transport.

## Decision

Each feature keeps the Electron arrangement it had, with the shell's own programs doing the work the Electron main process did.

- **`window.dsh` replaces both preloads.** The shell installs `shell-api.js` as a window initialization script, so the loading page, the plugin window, and the Host-served application document all read the same API before their own scripts run. Its groups are the Electron preload's — `locale`, `backend`, `plugins`, `updates` — plus the startup actions `resetConfiguration`, `restart`, `disablePlugins`, and `openPluginWindow`. The global is defined without a setter, so a page cannot replace it.
- **The copy lives in Rust.** `locale.rs` holds the English and Chinese dictionaries and answers `locale_get` from the language tags a page reports, which is the same source the Harness Web UI reads. Pages and tray therefore cannot drift apart, and `locale::current()` remembers the last answer for the menu and dialog actions that run without a page.
- **Plugin transactions run as a program.** `desktop-plugins.js` drives the same `DesktopProjectManager` the Electron main process imported, one command in and one JSON result out. The shell spans it with its backend stopped, so no process holds the profile while pnpm rewrites it, and restarts the backend afterwards whether the transaction succeeded or failed. The tray opens the plugin window, which is a shell-owned page.
- **Updates keep the Electron coordinator's state machine.** `update.rs` reports `idle`, `checking`, `available`, `installing`, `ready`, and `error`, announces a version only after a check verified it, re-checks before installing it, and installs nothing it did not announce. A build without an update endpoint answers `idle` rather than failing, which is what the Electron coordinator did when its build carried no update configuration; the tray's check asks the user through a native dialog, and `tauri.conf.json` carries `createUpdaterArtifacts` plus the empty updater configuration a release fills in.
- **Recovery covers the startup page's four actions.** `application_restart` relaunches the application, `configuration_reset` rebuilds the profile, `plugins_disable_all` disables every third-party plugin, and `backend_retry` boots the backend again. The page offers reset and disable only when the shell reports `profileRecovery`, which is what the Electron page gated on, and restarts serialize so two actions cannot interleave stopping and booting the backend.
- **Packaging mirrors Electron where Tauri allows.** The bundle carries the developer-tools category, the publisher and copyright, an NSIS install mode that lets the user choose the directory, and the macOS hardened runtime with the same minimum system version.

## Alternatives considered

- **Keep the dictionary in the pages.** Rejected: the tray and the update dialog render copy without a page, so the shell needs its own copy anyway; two copies drift.
- **Drive plugin transactions through `dsh plugin`.** Rejected: `apps/cli` refuses the `desktop` profile outright, and the CLI forwards to pnpm rather than exposing toggle and disable-all.
- **Update through the page instead of a dialog.** Rejected: the Electron menu asked with a native dialog, whose buttons the user sees even when no window is focused.
- **Install an update without the plugin.** Rejected: a hand-rolled download has no signature verification, and the plugin's is the only one this application can rely on.
- **Keep `sandbox`-style single-threaded restarts.** Rejected: the Electron controller serialized attempts, and a second click during a boot would otherwise stop the Host the first click had just started.

## Consequences

- The fork owns `apps/desktop` alone; the Harness, the Host package, and the wire between them are untouched by this work.
- What remains outside the code is the release channel: signing and notarization credentials, the upload plan, and the updater endpoint with its public key. A build without them reports no update and installs nothing.
- The plugin window's native title stays English until a page sets it, while its heading and buttons are localized.
- The shell's pages are HTML modules, so their scripts have no unit test; the API they call and the Rust behind it are covered instead.
