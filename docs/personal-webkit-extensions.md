# Personal WebKit extensions

This work lives on `codex/webkit-kimchi` in `FelixKewa/ardia` and incorporates upstream Ardia updates.
It adds Apple's public WebKit extension host on macOS 15.4 and later. Chromium tabs retain their existing
extension implementation. The private fork is separate from the upstream contribution.

## What the preview supports

Settings → Profiles → Extensions has a WebKit Extensions section. Load Folder inspects an unpacked extension.
Reviewing an installed extension starts with its saved access choices. **Use on all websites and profiles**
provides the simple setup; the detailed API and individual-site controls are under **Individual Permissions…**. All profiles means
current and future regular profiles. Private windows are excluded, and each profile keeps separate extension
settings and sign-ins.

The review identifies the package and requested access before loading. Background extension code starts only
after confirmation, with the selected grants validated and applied first. Unsupported APIs remain denied;
compatibility notices do not imply that every extension feature works.

On a regular WebKit tab, loaded extensions appear directly in the toolbar with their own icons. Clicking one
opens its action against that tab. Direct icons take priority in narrow toolbars. The puzzle menu appears when
space allows; right-clicking an icon also opens extension management and overflow. Toolbar visibility follows
the same address-bar hover preference as Chromium extensions. Private
WebKit tabs have no extension host. Disable turns off an extension, while keeping its
stored data. Reload already open pages after loading, disabling, or changing permissions because scripts
previously injected into a page can remain until navigation.

Approved API permissions are `activeTab`, `scripting`, `storage`, `unlimitedStorage`, `contextMenus`, and `tabs`.
Host grants cover explicitly selected websites or approved HTTP/HTTPS match patterns. All-websites access
excludes file, browser-internal and extension URLs. A broad manifest request can still be narrowed to individual
hosts. The `tabs` API can expose tab metadata in the same profile. Chromium `tabCapture`, offscreen documents
and screen/audio recording are not enabled. WebKit has a public visible-tab snapshot API; this fork does not add an alternative
Netflix image/audio mining implementation.

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
identifiers. All-profile approval shares a verified package and access policy, not account data or extension
storage. The controller namespace also includes the application's data directory, so scratch tests do not
share extension data with the installed browser. Disabling and re-enabling the same folder, or approving an
update from that folder, keeps its extension storage. Updated code can therefore read its previous data; the
trust screen explains this. Review access starts with the saved choices and requires confirmation for changes. Browser restart restores only
verified managed packages and their saved grants. Saved metadata uses an explicit version-1 document and rejects
unsupported versions or malformed shapes. Profile deletion unloads extensions and removes their data.

Shared access fails closed. A global disable also marks the same folder disabled in every profile's own saved
copy, so a damaged shared-approvals file or a rollback to an older build cannot revive it. Ending shared access,
or reducing the shared permissions, brings back another profile's own earlier approval only when it is enabled,
uses the same package fingerprint and grants no more than the shared policy did; any other copy stays disabled
and shows **Review and Enable…**. If a package in the same folder changes and can no longer be prepared for all
websites (a new Kimchi release, for example), the review opens narrowed to that profile's saved websites instead
of failing. An unreadable shared-approvals file is reported on the WebKit Extensions list.

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
node scripts/personal/prepare-webkit-extension.mjs --kimchi-dictionary --kimchi-netflix-seek --kimchi-webkit-mining /path/to/original-extracted-firefox-package /path/to/new-prepared-folder
```

Without any optional compatibility flags, the preparation command adds only a UTF-8 marker to non-ASCII
`background.scripts` files that lack one. `--kimchi-dictionary` also adapts the reviewed Kimchi Reader 0.21.7 dictionary
decoder. It requires the exact original content-script SHA-256 and its declared manifest entry, and refuses
unfamiliar versions, changed scripts, or an already adapted script before creating the destination.

The tested WebKit extension world rejects the dictionary's `Blob.stream()` chunks with
`TypeError: Invalid type should be ArrayBuffer`. WebKit's
[decompressor checks the chunk against its ArrayBuffer realm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/compression/DecompressionStream.js).
The adaptation inserts a local stream transform that copies each Uint8Array chunk into a local ArrayBuffer
before decompression. It applies only to Kimchi's dictionary helper, including entry, pair, translated-language,
idiom and proverb resources. It preserves subarray offsets and content, and malformed gzip still rejects.
It changes no global API, background frequency updater, capture feature, host grant, or manifest permission.

`--kimchi-netflix-seek` adapts subtitle navigation for the tested WebKit runtime. Kimchi originally puts its seek
time in the injected script's URL, but the page sees `document.currentScript.src` as
`webkit-masked-url://hidden/`. Reading that masked URL produces a nonfinite target. The preparation instead
passes milliseconds through a numeric attribute on each one-shot script element. The helper validates the
attribute before calling Netflix's existing player API. Zero is valid; missing, blank, malformed, negative and
nonfinite values are ignored. Scripts execute in insertion order and are removed on load or error, so rapid
next/previous/repeat requests keep their separate target times. WebKit's URL masking stays enabled.
The option requires the exact original content-script and seek-helper hashes and their manifest declarations.
Generate from the original official folder with all required flags to retain earlier corrections; a previously
adapted content script is refused as input. Existing shortcut bindings and cue selection are preserved.

`--kimchi-webkit-mining` makes unsupported Netflix media requests explicit before Kimchi hides its mining
dialog or starts capture. With either capture preference enabled, the existing context-error dialog explains
that image/audio mining is unavailable in this preview. For text-only cards, the user can turn off **Capture
screenshot when possible** and **Capture audio when possible** under Kimchi Reader settings → **Capture during
Mining**, then retry. The command does not change those preferences, silently remove requested attachments,
save a card, or enable capture. The existing pause when opening mining remains. Chrome/Firefox behavior and
other sites are unchanged.

The error stays dismissible after a previously edited card closes. Recovery clears only the obsolete
dialog's transient dirty/uploading flags for this identified compatibility error; a late rejection cannot
change a newer card. Text-only context and submission follow the existing path, including account checks and
server error reporting. The option requires the same reviewed original content-script hash as the other
Kimchi adaptations.

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
The seek probe exercises the real injected helper with a synthetic Netflix player: original query targets become
nonfinite under page-visible URL masking, while distinct, repeated and zero millisecond attributes reach the
player correctly. Invalid targets do not invoke the player, and rapid requests preserve insertion order.
Mining tests use inert upload responses and synthetic text/media only. A nonpersistent windowless WebKit
extension verified the actual content/background message path, Korean FormData fields, optional synthetic
Blob bytes, and server/network/timeout error reporting without any real account request. The original Netflix
capture path emitted an early unhandled rejection when unsupported APIs failed; deliberately stalled replies
also reproduced a hidden modal that kept the page inert. The guard avoids entering that path.
The actual mining error component, modal and Svelte runtime rendered the new guidance in WebKit; repeated
Escape dismissal, a dirty prior card, text-only retry and stale rejection isolation passed. No screenshots,
recording, protected media or account data were used. The reported live-tab crash still needs console evidence
to identify its exact cause; these checks do not establish real authenticated card saving or media mining.

```bash
METRO_PORT=8097 node scripts/personal/webkit-smoke.mjs /absolute/path/to/Debug/Ardia.app
```

The debug JavaScript server must serve this checkout on the chosen port. The package boundary tests live in
`packages/ardiacore/tests/webkit-extension-package.test.mjs`; settings race tests live beside the extension
state. Native event counts reuse the consent-stamped WebKit telemetry channel. While sharing is on, hourly
counts include `webkit_extension_loads`, `webkit_extension_load_failures`, `webkit_extension_grants`,
`webkit_extension_actions`, `webkit_extension_unloads`, `webkit_extension_shared_approvals` (approvals or access
changes applied to all profiles) and `webkit_extension_all_websites_loads` (loads that allowed all websites). They
contain no extension identities, URLs, permissions, folder paths, error text or extension data. Watch load
failures, successful popup actions, and all-websites loads relative to all loads after the shared option ships.

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

The everyday installation uses `/Applications/Ardia.app`, the existing Dock icon and the original browser
identity. **Ardia → About Ardia** identifies the personal build and links to its exact source in Felix's fork. The original profile remains
available; the imported preview profile has **(Preview)** appended to its name and retains the working Kimchi
setup. Selecting a profile in Settings changes which profile's extension settings are shown. Switch the browser
window to that profile as well when using its extensions.

The everyday build and signed personal update feed are described in [Ardia Personal](personal-browser.md).
The scratch preview command above is only for development; do not use its old launcher after transferring its
data into the everyday installation. Upstream source updates are merged and tested on the personal branch
before publication, preserving this fork's WebKit support.
