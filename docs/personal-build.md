# Personal Mac baseline

This records the initial baseline workflow at commit `430a97c7`. The current workflow builds the
[WebKit preview](personal-webkit-extensions.md), including the personal branch's changes. To reproduce the
baseline, check out that commit in an existing checkout before running its script.

The initial `Personal Mac baseline` workflow builds the unchanged Ardia `v0.2.48` application at commit
`6b1bcbaca49e766a3be05c6e7c52d57a69c0bd0d`. Only this document, the personal workflow, and its build script may
differ from that baseline. It runs on pushes to `codex/webkit-kimchi` in `FelixKewa/ardia`, or by manually dispatching
that branch. Its job refuses every other repository and branch.

The workflow uses the standard Apple Silicon `macos-26` runner, Node 24, the repository's pinned pnpm version,
and the runner's Xcode and CocoaPods. It has read-only repository permissions, needs no signing secrets, and
does not publish a release or change an update feed. Upstream resources are downloaded only.

The build downloads the exact matching prebuilt Chromium engine, verifies its published SHA-256, installs frozen
JavaScript dependencies and CocoaPods, then calls the existing `scripts/release/archive.sh` with `adhoc` signing.
That path uses `apps/browser/macos/AdHoc.xcconfig` and builds the Release configuration, including its JavaScript
bundle. The script checks that the bundle exists, the executable is arm64, and the app's ad-hoc signature verifies.

Download the app artifact from the workflow run. It contains `Ardia-0.2.48-baseline-arm64.zip`, made with `ditto`
to preserve the app's framework symlinks. Extract that inner zip using Archive Utility or `ditto -x -k`.
The separate logs artifact is uploaded even after a failed build and contains build output, available Xcode logs,
tool versions, engine identity, signing details, and the successful zip's SHA-256. App artifacts remain for seven
days; logs remain for fourteen days. A run has a sixty-minute limit.

## Isolated smoke test

This app is a baseline test build, not the permanent personal browser. It is not notarized, still identifies as
`com.ardia.browser`, and retains upstream update settings. Do not replace the installed Ardia app or launch this
copy normally. Keep it in a separate test folder and always give it a new scratch data directory:

```bash
test_data="$(mktemp -d /tmp/ardia-baseline.XXXXXX)"
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR="$test_data" /absolute/test/folder/Ardia.app
```

Scratch mode separates app state and WebKit stores, uses Chromium's mock keychain, and disables update checks.
First verify ordinary Chromium and WebKit navigation, fixture bookmarks/settings, and persistence after quitting
and reopening with the same scratch directory. Quit only this test instance when finished. Successful packaging
does not establish Netflix playback or successful updates; those need separate runtime tests.

Before everyday use, implement a stable personal app identity, separate secret/configuration namespaces, and a
personal signed update feed. Ad-hoc builds and the upstream prebuilt engine have credential/passkey limitations;
do not use this scratch profile as the future permanent profile.

## Local build

With full Xcode, CocoaPods, Node 24, and the repository's pnpm installed, run from this checkout:

```bash
bash scripts/personal/build-baseline.sh /tmp/ardia-personal-baseline
```

Use a fresh output directory. The checkout must contain the pinned baseline commit, as a full clone does. The
script performs dependency installation and builds the app; it never launches it or reads existing browser data.
