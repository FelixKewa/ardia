#!/bin/bash
set -euo pipefail
controller="$(cd "$(dirname "$0")/../.." && pwd -P)"
root="${ARDIA_PERSONAL_SOURCE:-$controller}"
[[ "$root" == /* && -e "$root/.git" ]] || { echo 'An absolute source checkout is required.' >&2; exit 1; }
output="${1:?usage: build-personal.sh <absolute output directory> <build number>}"
build_number="${2:?usage: build-personal.sh <absolute output directory> <build number>}"
[[ "$output" == /* && "$build_number" =~ ^[1-9][0-9]{3,}$ ]] || { echo 'Invalid output directory or personal build number.' >&2; exit 1; }
[[ ! -e "$output/Ardia.app" ]] || { echo 'Output already contains an app.' >&2; exit 1; }
mkdir -p "$output"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export AC_LOCKED_AS=personal-release
cd "$root"
manager="$(node -p 'require("./package.json").packageManager')"
scripts/agent/locked pod --as personal-release --wait 120 -- npm exec --yes --package="$manager" -- pnpm install --frozen-lockfile > "$output/dependencies.log" 2>&1
printf 'Checking candidate before the native build.\n'
bash "$controller/scripts/personal/check-candidate.sh" "$root" > "$output/checks.log" 2>&1
printf 'Candidate checks passed; building the Release app.\n'
export ARDIACORE_PREBUILT_REPO=ardia-browser/ardia
export ARDIACORE_FRAMEWORK="$(packages/ardiacore/scripts/fetch-engine.sh)"
(
  cd apps/browser/macos
  "$root/scripts/agent/locked" pod --as personal-release --wait 120 -- pod install
) > "$output/pods.log" 2>&1
export XCODE_XCCONFIG_FILE="$root/apps/browser/macos/AdHoc.xcconfig"
scripts/agent/build-app --as personal-release --config Release --force --wait 120 > "$output/build.log" 2>&1
ditto "$root/apps/browser/build-personal-release/Build/Products/Release/Ardia.app" "$output/Ardia.app"
mkdir -p "$output/Ardia.app/Contents/Resources/Licenses"
cp "$root"/LICENSE* "$root/NOTICE" "$output/Ardia.app/Contents/Resources/Licenses/"
node "$controller/scripts/personal/configure-bundle.mjs" "$output/Ardia.app" "$build_number"
git rev-parse HEAD > "$output/source-commit.txt"
packages/ardiacore/scripts/fetch-engine.sh --describe --offline > "$output/engine.json"
printf 'Built personal candidate: %s\n' "$output/Ardia.app"
