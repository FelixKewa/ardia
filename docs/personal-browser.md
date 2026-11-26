# Ardia Personal

This is Felix's macOS fork. It replaces `/Applications/Ardia.app` using the existing `com.ardia.browser` identity and Dock shortcut. The installed browser's profiles and credentials remain in their existing locations. The working WebKit preview is imported as an additional profile, preserving its approved Kimchi package, settings and WebKit storage. See [preview migration](personal-preview-migration.md) for the transfer and recovery procedure.

The browser has a persistent personal code-signing certificate and a separate Ed25519 update key. It is locally signed, not Apple-notarized. It cannot inherit the official developer's Apple-team passkey entitlement. macOS may ask the owner to approve access to existing Keychain items after replacing the official app; never delete those items to dismiss a prompt.

## Repository and updates

- `ardia-browser/ardia/main` supplies upstream changes.
- `FelixKewa/ardia/codex/webkit-kimchi` contains the browser and personal compatibility work.
- `FelixKewa/ardia/main` holds the reviewed update controller. Automatic upstream merges do not replace that controller.
- `FelixKewa/ardia/personal-updates` holds the signed appcast and release record consumed by the browser.

After the first manual update succeeds and `PERSONAL_NIGHTLY_ENABLED=true` is set, the controller checks nightly at 23:17 UTC, or 03:17 Dubai time the following day. GitHub may delay scheduled runs. A manual workflow dispatch can check sooner.

Each update freezes the source commits, merges upstream normally, builds with the exact published engine, checks the personal features, signs on a separate worker, and proves an actual Sparkle upgrade on another worker. Invalid update-feed and archive signatures must be rejected. Only then may the source branch and release advance; the signed feed is published last. Conflicts and failed checks leave the previous working feed in place. Unchanged source and an unavailable exact engine produce a skip summary. A manual dispatch with `force=true` verifies the pipeline even when the source is unchanged.

Use Ardia's **Check for Updates…** command for published personal builds. The personal build pins its own feed and keeps updater preferences separate from the official channel. It refuses an incompatible staged official update. The old **Personal Mac preview** workflow remains disabled. The fork's inherited **Checks**, **Deploy** and **Windows engine inputs** workflows are also disabled; the personal nightly controller runs its own checks and does not deploy upstream services.

## Signing material

The private local signing material is in `~/Library/Application Support/Ardia Personal Signing`, readable only by the owner. Keep a private backup of that directory: rotating the identity without an update transition can break trust or prompt for Keychain access again. Never commit or publish it.

GitHub's `personal-signing` environment contains the personal certificate, its import password and update seed. Its deployment policy permits only the trusted `main` branch. The candidate build never receives these secrets. Signing uses independently pinned Sparkle tools, and the signing worker never executes candidate code. Public identities and the personal feed are in `scripts/personal/release-config.json`.

## Compatibility and rollback

The Kimchi changes are reproducible preparation steps for the reviewed extension version, not a redistributed extension package. A later Kimchi release must pass the preparation guards and compatibility checks before adoption. Text mining is supported by the compatibility path; protected-video audio/image capture is not enabled by this fork.

Before the first replacement, quit official Ardia and the preview. Keep an offline, verified backup of both profiles, the WebKit stores, app preferences and the original signed application. Retire the old preview launcher after the import because the imported profile adopts its WebKit store identifiers. Never open the retired preview against those same stores.

If rollback is needed, quit Ardia first. Restore the original application together with the matching pre-import profile metadata; do not run the official app against a partly completed import. The migration receipt and backup journal identify the original data. `migrate-preview.mjs --recover --backup ...` verifies its inputs before undoing an interrupted transfer. It does not overwrite browser data changed after the transfer.

## Validation record

The initial candidate was checked with isolated synthetic profiles: WebKit extension grants, messaging, page script injection, disable/re-enable, restart persistence and package updates; Chromium bookmark/history import and extension local storage; and both valid preference-MAC recovery and rejection of altered registration. No live-account requests, screen capture or protected-media recording are part of these checks.

At upstream commit `724e4589f`, the complete browser suite had three unrelated failures in the upstream consent baselines and plugin-disclosure count. The personal settings-order and naming checks were corrected and passed separately. Browser and desktop typechecks, the shared desktop module graph, the boundary inventory and focused migration/signing checks passed. Nightlies run the focused checks and real build/update proof; they do not silently treat the unrelated full-suite failures as passing.

## Controller deployment

Deploy only the paths listed in `scripts/personal/controller-files.json` onto the existing fork `main`. Do not fast-forward that branch to the browser source: doing so could enable upstream workflows on the fork. The controller uses only built-in Node/Python tools and pinned official actions; it does not install packages or execute candidate source in signing or publishing jobs.

Before enabling it, configure the `personal-signing` GitHub Environment with exactly one custom branch policy, `main`, and disable administrator bypass. Set these three environment secrets, never repository-wide secrets: `PERSONAL_CERTIFICATE_P12` (base64 PKCS#12), `PERSONAL_CERTIFICATE_PASSWORD`, and `PERSONAL_SPARKLE_SEED` (base64 Ed25519 seed). Protect edits to the default branch and this environment. The public certificate and update key must match `release-config.json`.

Keep `PERSONAL_NIGHTLY_ENABLED` unset while bootstrapping. First prove the local older-to-newer signed update with both browsers closed and old Sparkle helpers retired. Publish that verified initial `personal-N` prerelease, its archive and release record, then place the signed appcast and record on `personal-updates`. Dispatch the controller on `main` with `force=true`. Enable the nightly variable only after that complete run has passed its actual installer and both engine fixtures and advanced the feed. The old preview workflow stays disabled.

The update proof launches a headless Sparkle host, never the supplied browser copy. It uses a fresh preferences directory, a local feed, an app copy and a synthetic sentinel. It rejects an already running Ardia process or registered Ardia Sparkle service because service names share the production bundle ID. It proves invalid feed and archive signatures are rejected, a newer archive installs, the configured personal signer remains valid, and the synthetic sentinel survives. The subsequent WebKit and Chromium fixtures exercise the signed application using throwaway data. None of these tests reads saved accounts or records protected media.

Sparkle authenticates the downloaded ZIP using the old Ed25519 update key. Sparkle itself permits that key to authorize a change in code identity; this pipeline separately pins and verifies the personal certificate and designated requirement. A failed sign, proof, source-branch lease, or publication leaves the previous feed in place. An immutable release created before a final feed failure is retained; retry with a new build number. The `personal-updates` branch moves only after release assets are uploaded and the signed build has passed its proof.

GitHub's built-in publishing token deliberately has only `contents:write`. If upstream changes workflow files that it cannot push, the atomic source update stops and the run asks for an owner-reviewed source merge followed by a retry. Do not broaden signing secrets or add a long-lived workflow token to bypass that boundary.

These archives are not notarized. A manually downloaded archive can require macOS's normal Open Anyway approval. Never disable Gatekeeper globally or delete existing Keychain items as part of installation. The initial replacement retains the official bundle and credential namespace by the owner's explicit choice; it is not a second isolated everyday browser.
