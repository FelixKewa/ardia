#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
output="${1:?usage: bash scripts/personal/build-baseline.sh <absolute output directory>}"
[[ "$output" == /* ]] || { echo "error: output directory must be absolute" >&2; exit 1; }
mkdir -p "$output/logs" "$output/archive"
output="$(cd "$output" && pwd -P)"
exec > >(tee "$output/logs/build.log") 2>&1
cd "$root"

baseline=6b1bcbaca49e766a3be05c6e7c52d57a69c0bd0d
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo "error: an Apple Silicon Mac is required" >&2; exit 1; }
if [[ -n "${GITHUB_REPOSITORY:-}" && "$GITHUB_REPOSITORY" != FelixKewa/ardia ]]; then
  echo "error: this workflow builds only FelixKewa/ardia" >&2
  exit 1
fi
git cat-file -e "$baseline^{commit}"
git diff --exit-code "$baseline" -- . \
  ':!.github/workflows/personal-mac.yml' ':!scripts/personal/build-baseline.sh' ':!docs/personal-build.md'

{
  printf 'Baseline: %s\nWorkflow commit: %s\n' "$baseline" "$(git rev-parse HEAD)"
  sw_vers
  xcodebuild -version
  printf 'Node: %s\npnpm: %s\nCocoaPods: %s\n' "$(node --version)" "$(pnpm --version)" "$(pod --version)"
} | tee "$output/logs/provenance.txt"

export NODE_BINARY="$(command -v node)"
scripts/agent/locked pod --wait 120 --as personal-baseline -- pnpm install --frozen-lockfile
framework="$(packages/ardiacore/scripts/fetch-engine.sh)"
engine_key="$(engine/engine-key.sh)"
printf 'Engine key: %s\nFramework: %s\n' "$engine_key" "$framework" | tee -a "$output/logs/provenance.txt"
(
  cd apps/browser/macos
  "$root/scripts/agent/locked" pod --wait 120 --as personal-baseline -- pod install
)
git diff --stat > "$output/logs/dependency-changes.txt"

export AC_LOCKED_AS=personal-baseline
scripts/release/archive.sh "$output/archive" "$framework" "$output/derived" adhoc
app="$output/archive/Ardia.xcarchive/Products/Applications/Ardia.app"
[[ -s "$app/Contents/Resources/main.jsbundle" ]] || { echo "error: Release JavaScript bundle is missing" >&2; exit 1; }
[[ "$(lipo -archs "$app/Contents/MacOS/Ardia")" == arm64 ]] || { echo "error: the executable is not arm64" >&2; exit 1; }
codesign --verify --deep --strict "$app"
codesign -dv --verbose=4 "$app" 2> "$output/logs/signature.txt"
grep -q '^Signature=adhoc$' "$output/logs/signature.txt"
plutil -p "$app/Contents/Info.plist" > "$output/logs/app-info.txt"

archive="$output/Ardia-0.2.48-baseline-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
shasum -a 256 "$archive" | tee "$output/logs/SHA256SUMS"
printf 'Built %s\nUse only with a fresh ARDIA_DATA_DIR; the app still has upstream identity and update settings.\n' "$archive"
