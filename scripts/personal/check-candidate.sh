#!/bin/bash
set -euo pipefail
source="${1:?usage: check-candidate.sh <candidate checkout>}"
cd "$source"
manager="$(node -p 'require("./package.json").packageManager')"
npm exec --yes --package="$manager" -- pnpm -C packages/hostapi test
npm exec --yes --package="$manager" -- pnpm -C apps/browser typecheck
npm exec --yes --package="$manager" -- pnpm -C apps/desktop typecheck
(
  cd apps/desktop
  NODE_OPTIONS=--max-old-space-size=4096 node --test --test-concurrency=1 scripts/module-graph.test.mjs scripts/windowsPaths.test.mjs scripts/scaledAssets.test.mjs
)
npm exec --yes --package="$manager" -- pnpm -C apps/desktop test:host
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/ardia-personal-checks.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
node --test --test-reporter=tap packages/ardiacore/tests/personal-signing.test.mjs packages/ardiacore/tests/webkit-extension-package.test.mjs packages/ardiacore/tests/webkit-extension-policy.test.mjs packages/ardiacore/tests/webkit-extension-prepare.test.mjs packages/ardiacore/tests/webkit-preview-migration.test.mjs | tee "$work_dir/native.tap"
grep -qx '# skipped 0' "$work_dir/native.tap" || { echo 'check-candidate: a native test was skipped. Swift Testing needs a full Xcode; select one with xcode-select or DEVELOPER_DIR.' >&2; exit 1; }
node --no-warnings --import ./apps/browser/src/test-loader.mjs --test apps/browser/src/state/extensions/webKit.test.mjs apps/browser/src/state/extensions/toolbarOrder.test.mjs apps/browser/src/state/extensions/toolbarAnchors.test.mjs
swift test --package-path packages/shell --scratch-path "$work_dir/shell" --filter 'AppBuildIdentityTests|PersonalUpdatePolicyTests'
