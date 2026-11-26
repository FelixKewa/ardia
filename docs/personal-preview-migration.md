# Import the personal preview

This local tool transfers a closed preview into the installed `com.ardia.browser` app. It does not install or sign the app. Run it only with the personal build that understands imported WebKit stores and refuses startup during an interrupted migration.

The installed browser keeps its existing profiles, tabs, history, bookmarks, extensions, and active global settings. The preview becomes a separate profile with new window, tab, group, and split identifiers. Its last saved window is reopened if quitting archived that window. Recently closed entries and profile appearance are retained. Preview global settings remain in the verified backup; they do not replace the installed browser's global choices. Imported profiles start with sync disabled.

Kimchi's approved managed package is verified against its saved fingerprint, then copied to a permanent source folder under `Personal Extensions` in the installed data directory. Its context identifier, grants, settings, and existing WebKit storage remain the same. Future **Review access** updates use that permanent source path. No package approval is fabricated and no new permission is granted.

The imported profile adopts the preview's existing WebKit website and extension store identifiers. This is an ownership transfer: retire the preview app and its old launcher afterward. Do not reopen the preview with its old data directory. Deleting the imported profile will also delete its adopted website and extension data.

Chromium history, bookmarks, preferences, installed extension packages, and extension settings are copied into the new profile. Secure Preferences are copied unchanged so their existing integrity checks remain intact. Unpacked or externally located user extensions stop the import for separate handling. Chromium cookies, saved passwords, autofill databases, and the preview's mock credential store are excluded. The original installed credential databases are untouched. The full offline backup retains the excluded preview files for recovery, without decoding or printing their contents.

## Inspect without changing data

Use the exact data-directory spelling from the preview launch. `/var/...` and `/private/var/...` resolve to the same files but produce different WebKit identifiers. A mismatch stops the import.

```sh
node scripts/personal/migrate-preview.mjs --preview /absolute/preview-data
```

The result contains counts only. Inspection does not copy or alter files. A changed package, unsupported document version, duplicate permission, inconsistent identity, or unsafe path stops the plan.

## Import after quitting both apps

Manually quit official Ardia and every preview. Use a new backup directory outside both browser data directories, with enough space for both complete document roots and the transferred WebKit stores.

```sh
node scripts/personal/migrate-preview.mjs \
  --preview /absolute/preview-data \
  --apply --accept-transfer \
  --backup /absolute/new-backup-directory
```

The tool refuses a running browser. It creates an exclusive transaction lock and a startup-blocking marker, copies the backups, and verifies every copied file by size and SHA-256 before publishing any imported profile. Package copies are verified again before publication. New data is staged separately; session and store mappings are replaced atomically. A failure rolls back to the original bytes. A receipt makes repeat imports idempotent.

No telemetry is sent by this offline tool. Its output reports counts, outcome flags, and a backup integrity hash. It never prints page addresses, titles, extension storage values, cookies, or passwords.

## Recover an interrupted import

Keep both apps closed. Do not manually delete the startup-blocking marker.

```sh
node scripts/personal/migrate-preview.mjs --recover --backup /absolute/original-backup-directory
```

Recovery takes the same exclusive transaction lock. If interruption occurred before publication was possible, it cancels the staged attempt. Otherwise it verifies the backup and current transaction-owned files, restores the original metadata atomically, and removes only verified imported additions. Changed or unknown data stops recovery and leaves the marker in place. Temporary replacements and rollback trash stay outside the installed data directory so another interruption can be recovered again.

## Verification

```sh
node --test packages/ardiacore/tests/webkit-preview-migration.test.mjs
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  node --test packages/ardiacore/tests/webkit-imported-stores.test.mjs
```

These use synthetic temporary data. They cover official-data preservation, identity remapping, extension fingerprint checks, clear-history markers, disabled sync, rollback after each metadata publication, verified recovery, and exclusion of overlapping transactions. Chromium extension activation after a storage-key change also needs the separate synthetic app probe against the final engine; byte-preserving unit tests alone do not prove that runtime behavior.

```sh
PATH=/usr/sbin:$PATH node scripts/personal/prove-profile-import.mjs /absolute/build/Ardia.app
```

The probe builds an original synthetic extension using [Chromium's CRX3 format](https://github.com/chromium/chromium/blob/main/components/crx_file/crx3.proto), starts only hidden temporary instances, imports a bookmark, history visit, and extension setting, and reads them back through the browser. It invalidates only the synthetic encrypted preference hash while retaining the registration and existing legacy MAC, then verifies recovery. Its negative control changes the synthetic registration without its MAC and expects rejection. It never reads real credential stores, captures media, or changes an installed profile.
