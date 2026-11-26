#!/bin/bash
set -euo pipefail
source="${1:?usage: check-candidate.sh <candidate checkout>}"
cd "$source"
manager="$(node -p 'require("./package.json").packageManager')"
npm exec --yes --package="$manager" -- pnpm -C packages/hostapi test
npm exec --yes --package="$manager" -- pnpm -C apps/browser typecheck
npm exec --yes --package="$manager" -- pnpm -C apps/desktop typecheck
npm exec --yes --package="$manager" -- pnpm -C apps/desktop test:graph
npm exec --yes --package="$manager" -- pnpm -C apps/desktop test:host
node --test packages/ardiacore/tests/personal-signing.test.mjs packages/ardiacore/tests/webkit-extension-package.test.mjs packages/ardiacore/tests/webkit-extension-prepare.test.mjs packages/ardiacore/tests/webkit-preview-migration.test.mjs
node --no-warnings --import ./apps/browser/src/test-loader.mjs --test apps/browser/src/state/extensions/webKit.test.mjs apps/browser/src/state/extensions/toolbarOrder.test.mjs apps/browser/src/state/extensions/toolbarAnchors.test.mjs
