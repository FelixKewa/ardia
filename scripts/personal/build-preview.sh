#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
output="${1:?usage: bash scripts/personal/build-preview.sh <absolute output directory>}"
[[ "$output" == /* ]] || { echo "error: output directory must be absolute" >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo "error: an Apple Silicon Mac is required" >&2; exit 1; }
if [[ -n "${GITHUB_REPOSITORY:-}" && "$GITHUB_REPOSITORY" != FelixKewa/ardia ]]; then
  echo "error: this workflow builds only FelixKewa/ardia" >&2
  exit 1
fi
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcodebuild -checkFirstLaunchStatus || { echo "error: open Xcode and finish its first-time setup" >&2; exit 1; }
mkdir -p "$output/logs" "$output/archive"
output="$(cd "$output" && pwd -P)"
exec > >(tee "$output/logs/build.log") 2>&1
cd "$root"
export NODE_BINARY="$(command -v node)"
export AC_LOCKED_AS=personal-preview

{
  printf 'Source commit: %s\nBranch: %s\n' "$(git rev-parse HEAD)" "$(git branch --show-current)"
  git status --short
  sw_vers
  xcodebuild -version
  printf 'Node: %s\npnpm: %s\nCocoaPods: %s\n' "$(node --version)" "$(pnpm --version)" "$(pod --version)"
} > "$output/logs/provenance.txt"
scripts/agent/locked pod --wait 120 --as personal-preview -- pnpm install --frozen-lockfile
framework="$(packages/ardiacore/scripts/fetch-engine.sh)"
printf 'Engine key: %s\nFramework: %s\n' "$(engine/engine-key.sh)" "$framework" >> "$output/logs/provenance.txt"
(
  cd apps/browser/macos
  "$root/scripts/agent/locked" pod --wait 120 --as personal-preview -- pod install
)
scripts/release/archive.sh "$output/archive" "$framework" "$output/derived" adhoc
app="$output/archive/Ardia.xcarchive/Products/Applications/Ardia.app"
[[ -s "$app/Contents/Resources/main.jsbundle" ]] || { echo "error: Release JavaScript bundle is missing" >&2; exit 1; }
[[ "$(lipo -archs "$app/Contents/MacOS/Ardia")" == arm64 ]] || { echo "error: the executable is not arm64" >&2; exit 1; }
codesign --verify --deep --strict "$app"
codesign -dv --verbose=4 "$app" 2> "$output/logs/signature.txt"
grep -q '^Signature=adhoc$' "$output/logs/signature.txt"
plutil -p "$app/Contents/Info.plist" > "$output/logs/app-info.txt"
preview_staging="$(mktemp -d "$output/preview.XXXXXX")"
preview="$preview_staging/Ardia WebKit Preview"
mkdir -p "$preview"
ditto "$app" "$preview/Ardia.app"
codesign --verify --deep --strict "$preview/Ardia.app"
cp scripts/personal/launch-preview.command "$preview/Launch Ardia Preview.command"
chmod +x "$preview/Launch Ardia Preview.command"
cat > "$preview/Read me.txt" <<'TEXT'
Open Launch Ardia Preview.command to use the separate temporary test profile.
Do not open Ardia.app directly or replace your installed browser.

This is an ad-hoc signed compatibility preview. Its test profile disables
updates and uses test credential storage. Do not save passwords or use it
as your everyday browser. The temporary profile may be cleared by macOS.

WebKit extensions: Settings > Profiles > Extensions > WebKit Extensions.
Load a trusted, unpacked extension folder and choose its allowed APIs/sites.
Reload the page, then click the extension's own toolbar icon.
Hover over the address bar if its buttons are hidden. The puzzle menu
provides management and overflow when there is limited toolbar space.
TEXT
archive="$output/Ardia-WebKit-preview-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$preview" "$archive"
shasum -a 256 "$archive" > "$output/logs/SHA256SUMS"
printf '%s\n' "$preview/Launch Ardia Preview.command" > "$output/logs/launcher-path.txt"
printf 'Built %s\nTest only with a separate ARDIA_DATA_DIR; do not replace the installed browser.\n' "$archive"
