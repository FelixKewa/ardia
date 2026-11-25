# Personal WebKit extension preview

This work lives on `codex/webkit-kimchi` in `FelixKewa/ardia`, based on official Ardia `v0.2.48`.
It adds Apple's public WebKit extension host on macOS 15.4 and later. Chromium tabs retain their existing
extension implementation. The private fork is separate from the upstream contribution.

## What the preview supports

Settings → Profiles → Extensions has a WebKit Extensions section. Load Folder inspects an unpacked extension,
shows its requested APIs and websites, and leaves every grant off initially. Select the APIs and exact HTTPS
hosts needed, then confirm Review and Load. Background extension code starts only after that confirmation.
Selected grants are validated and applied before the background starts. Unsupported permissions remain denied;
compatibility notices do not imply that every extension feature works.

On a regular WebKit tab, loaded extensions appear directly in the toolbar with their own icons. Clicking one
opens its action against that tab. Direct icons take priority in narrow toolbars. The puzzle menu appears when
space allows; right-clicking an icon also opens extension management and overflow. Toolbar visibility follows
the same address-bar hover preference as Chromium extensions. Private
WebKit tabs have no extension host. Disable turns off an extension, while keeping its
stored data. Reload already open pages after loading, disabling, or changing permissions because scripts
previously injected into a page can remain until navigation.

Approved API permissions are `activeTab`, `scripting`, `storage`, `unlimitedStorage`, `contextMenus`, and `tabs`.
Host grants are exact HTTPS hosts, including all paths; WebKit's match patterns do not isolate ports. A broad
manifest request can be narrowed to explicitly entered hosts. The `tabs` API can expose tab metadata in the
same profile. Screen/audio capture, Chromium offscreen documents and unrestricted host grants are not enabled.

## Package and data handling

Inspection copies and hashes the package. Loading verifies the approved fingerprint against a new snapshot,
rejects symbolic links and unsafe paths, and executes the managed copy. Changing the source folder after
inspection requires a new approval. Invalid grant choices do not replace a working extension.

Package hashes normalize filenames to Unicode NFC before sorting and hashing. macOS can copy a Korean name
using its equivalent decomposed spelling without changing file contents; that must not invalidate approval on
restart. Canonically duplicate paths are rejected, and every file's bytes remain part of the hash.
Restoring an existing package also accepts its exact prior raw-filename hash; new approvals use the canonical
hash. The actual Kimchi Reader managed copy now reproduces its original approved hash without changing files,
grants, account data, or saved metadata.

Each regular profile has its own controller, website data store, saved grant records and stable extension
identifiers. The controller namespace also includes the application's data directory, so scratch tests do not
share extension data with the installed browser. Disabling and re-enabling the same folder, or approving an
update from that folder, keeps its extension storage. Updated code can therefore read its previous data; the
trust screen explains this. Review access starts with new explicit grant choices. Browser restart restores only
verified managed packages and their saved grants. Saved metadata uses an explicit version-1 document and rejects
unsupported versions or malformed shapes. Profile deletion unloads extensions and removes their data.

Ordinary website sign-ins may still follow Ardia's existing engine-switch data setting. This feature does not
copy Chromium extension storage or authentication tokens into WebKit.

## Kimchi Reader

Use a package obtained from Kimchi Reader's [official installation guide](https://kimchi-reader.app/manual/web-extension).
The repository does not bundle or redistribute its code. The initial audit used official Chrome and Firefox
0.21.7 packages. The webapp bridge is a content-script/custom-event bridge, so its sign-in path does not depend
on the fixed Chrome extension ID. Its popup opens `https://kimchi-reader.app/extension/connect`.

The tested WebKit runtime misdecoded Korean text in Firefox's generated background page. The unmodified
package reported an invalid regular-expression range. Prepending a UTF-8 byte-order mark to its background
script in a separate local copy removed that error; that prepared package loaded with no reported context
errors. This does not modify the downloaded original or bypass any account checks.

WebKit documents the generated-background-page UTF-8 fix in
[Safari Technology Preview 257](https://webkit.org/blog/18652/release-notes-for-safari-technology-preview-257/).
Prepare a local copy before choosing Load Folder:

```bash
node scripts/personal/prepare-webkit-extension.mjs --kimchi-dictionary /path/to/extracted-firefox-package /path/to/new-prepared-folder
```

Without the optional `--kimchi-dictionary` flag, the preparation command adds only a UTF-8 marker to non-ASCII
`background.scripts` files that lack one. The flag also adapts the reviewed Kimchi Reader 0.21.7 dictionary
decoder. It requires the exact original content-script SHA-256 and its declared manifest entry, and refuses
unfamiliar versions, changed scripts, or an already adapted script before creating the destination.

The tested WebKit extension world rejects the dictionary's `Blob.stream()` chunks with
`TypeError: Invalid type should be ArrayBuffer`. WebKit's
[decompressor checks the chunk against its ArrayBuffer realm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/compression/DecompressionStream.js).
The adaptation inserts a local stream transform that copies each Uint8Array chunk into a local ArrayBuffer
before decompression. It applies only to Kimchi's dictionary helper, including entry, pair, translated-language,
idiom and proverb resources. It preserves subarray offsets and content, and malformed gzip still rejects.
It changes no global API, background frequency updater, capture feature, host grant, or manifest permission.

Preparation leaves the original folder untouched, refuses an existing destination or symbolic links, and does
not download or redistribute the extension. Normal inspection and fingerprint approval apply to the prepared
copy. For an existing installation, keep the existing source-folder path when replacing its prepared contents
after backing them up; then use Review access, select the required grants, approve the changed package, and
reload the page. Using the same source path preserves the extension identity and its stored data.

Allow the requested storage/script permissions and the requested hosts needed for the selected site and
Kimchi Reader account page. Keep unsupported capture APIs off. Audio/image mining and Netflix subtitle parsing
are separate compatibility checks; a successful host test does not establish those features work on Netflix.
Actual sign-in, popup operation and protected playback require a manual check with the user's account.
The unauthenticated account-page test passed: the actual prepared package injected its
`data-kimchi-extension` bridge into the real Kimchi Reader account page running in WebKit, with no reported
background errors. No account sign-in was attempted.

## Verification

`scripts/personal/webkit-smoke.mjs` launches only a hidden, isolated Debug build and closes it afterward. It
uses a synthetic extension and a loopback page; it never records or captures the screen. HTTP loopback grants
are available only in test instances. The test exercises inspected-byte approval, private-profile refusal,
profile separation, document-start injection, background startup with approved storage access, messaging,
active-tab queries, script execution, disable/re-enable, restart persistence and approved package updates.
It also checks that invalid update grants preserve the previous working extension, and that extension icons
are bounded PNGs, survive restart, and are removed when the extension is disabled.
The content-script fixture uses a Korean filename to cover the macOS filename-normalization boundary.
Dictionary preparation tests cover multi-chunk Korean JSON, typed-array offsets, corrupt gzip, strict package
guards and unchanged originals. A standalone nonpersistent WKWebExtension probe reproduced the original
ArrayBuffer rejection in an isolated content-script world and verified the local chunk-copy correction.

```bash
METRO_PORT=8097 node scripts/personal/webkit-smoke.mjs /absolute/path/to/Debug/Ardia.app
```

The debug JavaScript server must serve this checkout on the chosen port. The package boundary tests live in
`packages/ardiacore/tests/webkit-extension-package.test.mjs`; settings race tests live beside the extension
state. Native event counts reuse the consent-stamped WebKit telemetry channel. While sharing is on, hourly
counts include `webkit_extension_loads`, `webkit_extension_load_failures`, `webkit_extension_grants`,
`webkit_extension_actions` and `webkit_extension_unloads`. They contain no extension identities, URLs,
permissions, folder paths, error text or extension data. Watch load failures and successful popup actions.

## Building and updates

After Xcode's first setup, Node 24+, pnpm and CocoaPods are installed:

```bash
bash scripts/personal/build-preview.sh /tmp/ardia-personal-preview
```

The script builds a standalone arm64 Release archive with its JavaScript bundle, verifies its ad-hoc signature,
and creates a zip plus build provenance. The zip includes a manual launcher, which opens a separate temporary
preview profile. Agents must not run that launcher; automated checks use hidden instances instead. The preview
uses test credential storage, so it is unsuitable for saving passwords or everyday use. Its temporary profile
can be removed by macOS. It fetches the pinned prebuilt engine; it does not rebuild Chromium.
This preview retains upstream app identity and update settings. Use a separate scratch `ARDIA_DATA_DIR` and
do not replace or normally launch it against the installed browser's profile.

The preview is not yet the everyday personal browser with automatic updates. That still requires a stable
personal identity, separate secret/configuration namespaces, a suitable signing setup, and a separately signed
update feed pointing at the fork. App replacement can preserve profile data when those identifiers remain
stable. Upstream source updates must first be merged and tested on the personal branch; an upstream release
must not overwrite this fork's WebKit support.
