#!/usr/bin/env sh
# Re-establish the Tauri shell's ownership of apps/desktop after `git merge upstream/master`.
#
# Upstream still ships the Electron shell in this directory. This fork replaced it with a
# Tauri shell, so every merge resurrects the Electron files as modify/delete conflicts that
# git resolves in favour of upstream. Run this from the repository root with no merge in
# progress, then re-run `node node_modules/typescript/bin/tsc -b apps/desktop`.
#
# Usage: sh apps/desktop/scripts/upstream-sync.sh
set -eu

# Files the fork deletes and must stay deleted. Upstream modifies them, so a merge re-adds
# them; `git rm --ignore-unmatch` makes the script idempotent.
REMOVED_PATHS='
apps/desktop/src/main.ts
apps/desktop/src/preload.ts
apps/desktop/src/preload-app.ts
apps/desktop/src/ipc.ts
apps/desktop/src/locale.ts
apps/desktop/src/single-instance.ts
apps/desktop/src/startup-document.ts
apps/desktop/src/startup-error.ts
apps/desktop/src/update-coordinator.ts
apps/desktop/src/backend-controller.ts
apps/desktop/renderer
apps/desktop/tests/expected
apps/desktop/electron-builder.config.mjs
apps/desktop/electron-builder.config.d.mts
apps/desktop/scripts/package-target.ts
apps/desktop/scripts/package-macos.ts
apps/desktop/scripts/upload-target.ts
apps/desktop/scripts/desktop-upload-plan.ts
apps/desktop/scripts/desktop-auto-update-environment.mjs
apps/desktop/scripts/desktop-auto-update-environment.d.mts
apps/desktop/scripts/notarize-macos-disk-images.mjs
apps/desktop/scripts/windows-sign.mjs
apps/desktop/scripts/windows-sign.cmd
apps/desktop/scripts/windows-sign.d.mts
apps/desktop/scripts/installer.nsh
'

# Files the fork owns outright: take ours, never upstream's Electron-era version.
OURS_PATHS='
apps/desktop/package.json
apps/desktop/README.md
apps/desktop/README.zh.md
apps/desktop/README.i18n.yaml
apps/desktop/Cargo.toml
'

for path in $OURS_PATHS; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    git checkout --ours -- "$path"
    git add -- "$path"
  fi
done

for path in $REMOVED_PATHS; do
  git rm -r --ignore-unmatch --quiet -- "$path"
done

echo "apps/desktop: upstream Electron shell removed; the Tauri shell owns this directory."
