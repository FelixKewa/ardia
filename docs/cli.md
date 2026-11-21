# The `ardia` command

The `ardia` command drives a running Ardia from the terminal. It is its own project now: source, tests, CI, version
and releases live in github.com/ardia-browser/plugins (`plugins/cli`), and its manual is
[plugins/cli/docs/cli.md](https://github.com/ardia-browser/plugins/blob/main/plugins/cli/docs/cli.md) there. This page
is what Ardia does for it: how it ships, how it's installed, and the contract the two keep.

## How Ardia ships it

- **The pin.** `apps/browser/official-plugins.json` names each official plugin Ardia bundles: its version, the GitHub
  release it comes from and the SHA-256 of each artifact (`macos-arm64`, the plugin folder; `linux-x64`, the command's
  tarball; `installer`, `install.sh`). A `null` SHA-256 means not published yet, and every release step that needs it
  refuses. `scripts/release/official-plugins.py pin cli <version>` writes the hashes of a published release, and
  `check` (in the tests) holds the file well formed and `apps/cli/install.sh` equal to the pinned installer. The app's
  official catalogue (`state/plugins/official.ts`) is held equal to it by a test.
- **macOS.** The Release workflow's `build` job, which holds no secrets, fetches the pinned folder, checks its SHA-256 and
  unpacks it (`official-plugins.py bundle`: files and folders only, its `plugin.json` must be the pinned name and
  version). The `sign` job signs its Mach-Os inside out with the app's Developer ID and hardened runtime, writes each
  plugin's payload digest into `Info.plist` (`ArdiaBuiltInPlugins`) and the program registry its manifests' `claim`s and
  the pin's `legacyInstall` make (`ArdiaProgramRegistry`, `docs/plugins.md` › programs), then signs the app; `verify.sh`
  recomputes both on the signed app and checks every Mach-O's signature and runtime flag. The plugins repo never needs the
  signing identity. The release no longer publishes an `ardia-cli-*.tar.gz` of its own.
- **Linux** has no plugins yet, so the package carries the command for its installer: `official-plugins.py linux-cli
  <app version>` fetches the pinned linux-x64 tarball, checks it, and renames it `ardia-cli-<app version>-linux-x64.tar.gz`
  with that top folder, the name the Linux engine's installer (`ac_linux_cli.cc`) expects; `scripts/linux/package.py`
  puts it in `lib/ardia/cli/` with `apps/cli/install.sh` and its digest. The smoke's `cli-install` checks that the
  installed `ardia --version` prints a version (the command's own, not the app's).
- **`apps/cli/install.sh`** is the one file of the command kept here: the engine's Linux packaging test
  (`engine/patches/build/tests/test_linux_release.py`) reads it, and moving it would change the engine key. It is a copy
  of the pinned release's `install.sh`; when the engine is next rebuilt, that test can read the fetched installer and
  the copy can go.

## Installing it

On macOS it's the **Command Line** plugin (`docs/plugins.md` › Built-in plugins, › programs, › Official plugins): a
fresh profile is offered it in Settings › Plugins and onboarding, and one click installs it through the consent sheet.
Settings › Advanced › Command line has no switch on macOS: it's one line of status ("Not installed." with Open
Plugins, "On your PATH. It can control Ardia.", or why it isn't on PATH, with Try Again). Once installed it stays: Ardia keeps `~/.local/bin/ardia` linked to its copy in
`~/Library/Application Support/Ardia/Programs/cli/`, makes a new copy when the app brings a new version (checked against
the signed digest), and runs its after-update actions once per version (`ardia skills install --auto`,
`ardia skills refresh`, `ardia computer refresh`). **Installed means control is on**: installing turns `cliControl` on
(the sheet says so), and each launch turns it back on while Command Line is installed. The control pill's Stop turns
it off until the next launch. An `ardia` installed the old way (`~/Library/Application Support/Ardia/CLI/current`) is
adopted on update with no click when control was on: the plugin counts as installed, the link moves to the new copy,
and `CLI/current` points into the store, so paths saved through it keep working. When control was off, it isn't
adopted (`ADOPT_WITH_CONTROL_OFF` in `state/plugins/programs.ts` is false): the old `ardia` stays on PATH, untouched,
control stays off, and Command Line shows as available. The old command then reports Ardia unreachable with its own
old wording until the user installs Command Line, which adopts it and turns control on as the sheet says
(`usage_counts.plugin_adoptions_waiting` counts these). There's no uninstall from
Settings; removing the link brings it back at the next launch.

On Linux, Settings › Advanced › Command line installs it from the package (`install.sh --version <app version> --sha256
<digest>` with a `file://` URL), as before.

`cliControl` (`state/app/cliControl.ts`) stays the stored key, the control pill and the token server stay in the app
(`docs/automation.md`), and on Linux and in older data folders it means what it always did; Linux keeps its switch in
Settings › Advanced.

## The contract

- **Control protocol.** `hello` carries a protocol number both ways. Ardia answers with `protocol` (today 4) and
  `minClientProtocol`, and refuses a `hello` that names an older `protocol` with `unsupported_protocol` ("… update the
  command"); a `hello` with no `protocol` is taken as the current one, as every command before this change sent none.
  The command sends its `protocol` and refuses an Ardia whose `protocol` is under its `MIN_APP_PROTOCOL` ("… update
  Ardia"), before it sends anything else. A side raises its minimum only when it needs the other's newer behaviour, so a
  newer command against an older Ardia, or the reverse, either works or says which one to update. `ardia --version`
  reports the command's own version.
- **Methods.** `methods` lists every method the socket answers: `name`, `area`, `mutates`, `description`, `params` (a
  JSON Schema subset the socket checks before it runs anything) and `result`. The command's `ardia methods` prints it
  and `ardia call <method> [params]` calls any method, so a method Ardia adds is usable from the shell without a new
  command release. Adding methods doesn't change the protocol: a command that calls one an older Ardia lacks gets
  `unknown_method`. Every area, what it reads and changes, and what stays out of reach (passwords, card numbers,
  cookie values) is in `docs/control-socket.md`. Tile folders (`pins.*`), page icons (`favicons.get`), shared
  and live folders (`sharedFolders.*`, `live.*`), setup codes (`presets.*`) and Air Traffic Control rules
  (`airTraffic.*`) are there too.
- **One line is at most 1 MiB.** Every line Ardia writes on the socket (a reply, an event, a decide request) is at most
  1 MiB (1,048,576 bytes, newline included), the limit every shipped command reads (`MAX_LINE` in `control.py` and
  `control.rs`); a longer line makes the command drop the connection. Old commands can't change, so Ardia keeps to it:
  pages stop early, a read whose reply wouldn't fit answers `failed` saying what to narrow, a write whose result wouldn't
  fit answers a compact `{ok, oversized, …counts}` so it's never unclear whether the write happened, an event that
  wouldn't fit goes out summarized with `truncated: true`, and a decide request that wouldn't fit isn't sent (Ardia uses
  its default). A reader that falls behind loses its oldest events, never a reply or a decide message and never its connection
  in the middle of a line; the next event it gets carries `dropped: <n>`. Details in `docs/control-socket.md` › The 1 MiB line.
- **The plugin schema.** `docs/plugin.schema.json` is the manifest schema Ardia writes (`apps/browser/scripts/
  write-plugin-schema.mjs`; a test keeps it current). The command ships a copy for `ardia plugins check` offline, and the
  plugins repo's CI compares that copy with ardia main's.
- **Release smoke.** `scripts/release/cli-bootstrap-smoke.sh` checks that a fresh profile gets no `ardia` until it installs
  Command Line, and that an installed one gets `ardia` from the signed copy at the pinned version with `ardia tabs`
  answering. `scripts/release/token-smoke.sh` runs `ardia browse` over the real token connection with the app's built-in
  `ardia`.
- **Telemetry.** The command's events go to the same service under `source = 'ardia-cli'` (the dashboard's CLI health
  page reads them); the What's Sent copy in the app lists them, since the consent is the app's. A new CLI event needs
  that copy changed here.

## Plugin credentials

The token server (`docs/engine-build.md` › `chromium-devtools-control-token.patch`) takes two kinds of secret. The
token in `<user data dir>/Chromium/ArdiaControl.json` is the owner's `ardia` command (kind `cli`, a full DevTools
client). A plugin's browse gets a credential of its own (kind `plugin`: web pages in one window and profile, nothing
else), minted per plugin activity. A plugin process never reads `ArdiaControl.json`, and a credential never travels in
argv (any process can read another's argv through `sysctl KERN_PROCARGS2`), in the environment, in a file or in a log.

**What #2808 ships and what it doesn't.** #2808 ships the engine side only: the `ac_cli_plugin_credential` call and its
app routes (`engine.cliPluginCredential` on the Mac and Linux; Windows reports it missing), the `plugin` kind and its
policy. Nothing in the app calls them yet. `packages/shell/ios/PluginProcess.swift` still passes only its channel fd
(`ARDIA_PLUGIN_FD=3`), and no plugin activity mints or revokes a credential, so until the app side lands a plugin
browse can't connect as `plugin` at all. The app side belongs to the AI plugin work (`PluginBrowse.swift` and the
TypeScript browse client), not to #2808. It must:
- mint with `mintCliPluginCredential(tabId)` (`apps/browser/src/platform/cli.ts`, which calls `engine.cliPluginCredential
  {tabId}`) when a plugin activity starts, with a tab in the activity's window;
- hand the `credential` to each CLI child it spawns for that activity on an inherited pipe fd, and `endpoint` in
  `ARDIA_PLUGIN_ENDPOINT`, as described below;
- revoke with `revokeCliPluginCredential(id)` (same file, `engine.cliPluginCredential {revoke}`) when the activity ends,
  is cancelled or its plugin is turned off, and mint again after control is turned back on (a restart clears them).

- **Mint.** The app calls `engine.cliPluginCredential {tabId}` (engine call `ac_cli_plugin_credential`, args
  `{"tab": <Chrome tab id>}`; the Mac's `EngineModule.swift` and Linux's `ac_linux_host.cc` turn the app's tab id into
  Chrome's). The scope is the window that tab is in (its `SessionID`) and that window's profile (path and whether it
  is off the record), fixed at mint time. The reply is `{"id", "credential", "window", "endpoint"}`:
  - `id`: `plugin-` and 16 hex digits; it names the credential for revoking and is not secret;
  - `credential`: the secret, `p.` and 43 base64url characters (45 ASCII bytes, no padding, no newline);
  - `window`: the scope's window `SessionID`;
  - `endpoint`: `ws://127.0.0.1:<port>/devtools/browser/<id>` while the token server runs, else `""` (turn control
    on, then mint again; a credential minted while it's off still works once it's on, but the reply can't say where).

  An unknown or closed tab answers the error `no such tab`.
- **Revoke.** `engine.cliPluginCredential {revoke: <id>}` (engine args `{"revoke": "<id>"}`) answers
  `{"revoked": true}`, or `false` for an unknown id. It forgets the credential and closes every connection made with
  it. The app revokes when the activity ends. A credential also dies with the window it was minted for, when the
  control server stops or restarts (mint again after turning control back on) and when the browser quits. A profile
  holds at most 16 live credentials; past that, minting answers `too many plugin credentials for this profile`.
- **What a plugin connection may do** is an exact allowlist (`docs/engine-build.md` › `chromium-devtools-control-token.patch`):
  plain-data DOM and accessibility reads, page navigation, and
  input: keys, text, button-less pointer moves, the wheel, and clicks through `Ardia.dispatchClick` (one call presses
  and releases in place, so a plugin can never drag). Clicks, moves and wheels go only to the page target's own
  session. A click succeeds when the renderer has acknowledged every event, which isn't proof the page handled it; a
  click whose press Chromium suppressed, filtered or never dispatched (a renderer not yet running or gone) answers
  `ardia: not delivered` at once. A wheel succeeds once the renderer has acknowledged it and Chromium has acknowledged
  its phase-end (an acknowledgement, not proof it scrolled: read `DOM.getBoxModel` again); a browser acknowledgement
  or the 5 s deadline answers `ardia: outcome unknown`. A plugin has at most one wheel outstanding per tab: another
  wheel from the same credential to that tab gets `ardia: busy` and isn't queued until the first one is done. Done
  means, before it reached Chromium, any answer or the 5 s deadline (which answers `ardia: not delivered`); after
  it reached Chromium, only its acknowledgement (and its phase-end's) or the end of the frame or tab it went to. A
  wheel whose frame stalls answers `ardia: outcome unknown` after 5 s but keeps that tab busy for the plugin until
  the frame acknowledges it or goes away. A
  wheel to a page that isn't taking input (its renderer is blocked, or a dialog holds it) is refused (`the page isn't
  taking input right now`), and so is a wheel to a hidden page (`page hidden`). A wheel to a tab the person scrolled,
  touched or typed in (in any frame of the page) during the last 500 ms also answers `busy` without being queued (try
  again later). That counts person input once Chromium reports it dispatched to the renderer: input Chromium filtered
  doesn't count, and neither does input still waiting in most queues, but Chromium's deferred touch-move path reports
  dispatch before it hands the move over, so such a move counts slightly early. The time only moves forward, so a late
  event can't shorten the window. A wheel already in Chromium's own wheel queue can still be dispatched after the page
  navigates or the tab leaves scope, with no further check; with one outstanding wheel per credential and tab, that
  residual is at most one queued wheel and its phase-end per credential and tab: a scroll, never a click. It can't
  focus, scroll
  a node into view, or emulate focus: only a click focuses the page (its keys and text don't), and it scrolls with the
  wheel.
  It gets no Runtime at all: it can't run script in a page or hold a JavaScript object. What the page does in
  response to its input (a link that opens in another window) counts as the person acting, but the plugin still can't
  reach that window. When its tab leaves the window, its session is detached, commands in flight answer
  `ardia: tab_out_of_scope`, and input it queued before the move never lands.
- **The owner's clicks too.** `Ardia.dispatchClick` works on the `ardia` command's token connection as well, with the
  same page-session rule, outcome reporting (done, `ardia: not delivered`, `ardia: outcome unknown`) and gated recovery
  release; the owner keeps Chromium's raw `Input.dispatchMouseEvent` alongside it. When the owner has mouse-to-touch
  emulation on and the emulator takes a press, the click answers `ardia: outcome unknown`, since the emulator acted
  on it (plugins are refused under that emulation).
- **Showing a background tab while acting.** A plugin's attach doesn't make its tab visible, so a background tab stays
  hidden (`document.visibilityState` is `hidden`, and its wheels are refused) and costs nothing while the plugin is
  idle. The act lease turns a hold on at lease start, before the first action, and off only after the last action
  returns: `engine.cliPluginCredential {id, tabId, visible}` (engine args `{"id", "tab", "visible"}`) answers
  `{"visible": true}` or `{"visible": false}`. While it's on, the tab renders and reports `visible` to the page but
  stays in the background. It's idempotent and per credential and tab. The capturer count changes synchronously, so
  the browser treats the tab as shown when the call answers; the renderer learns it by Mojo right after, so the first
  frame (and the page's `visibilitychange`) follows shortly. Turning it on fails with `no such credential` (the id is unknown, revoked or its window is
  gone), `no such tab`, `tab out of scope` (another window or not a web page) or `no attached session` (the
  credential has no session on that tab); turning it off always succeeds, also for a tab that's gone. The hold drops
  by itself the moment the tab leaves the credential's window (before its sessions finish detaching, and a session
  that left can't authorize a new hold even if the tab comes back), when the credential's last session on the tab
  detaches, when the credential is revoked and when the tab closes. The `ardia` command's own token still keeps a tab visible for as long as it's attached.
- **Refusals.** Every refusal a plugin can get has a stable message, one constant each in
  `engine/ardiacore/src/ardia/core/ac_plugin_refusals.h` (`ardia::refusal`). Match on the exact message (or, for the
  three patterns, on the fixed prefix and suffix); the wording changes only together with the plugins that match it.
  CDP refusals arrive as the command's `error.message`; hold refusals as the engine call's error. A plugin can also
  get Chromium's own CDP errors (an unknown node, a missing frame, invalid params from Chromium's handlers), which
  aren't Ardia refusals and aren't in this table.

  | Refusal | Exact message |
  | --- | --- |
  | Busy (wheel): the person used that tab in the last 500 ms, or this credential's previous wheel to that tab is still outstanding | `ardia: busy` |
  | Page hidden (wheel) | `ardia: page hidden` |
  | Not delivered: no press (or event) was sent | `ardia: not delivered` |
  | Outcome unknown: something was sent and not all of it was acknowledged by the renderer, or every event was acknowledged but the page navigated or the widget went away meanwhile, or (owner) the touch emulator took the press | `ardia: outcome unknown` |
  | Page changed: a navigation committed after admission | `ardia: the page changed after the input was sent` |
  | Not the page session (clicks, moves, wheels) | `ardia: pointer input and clicks go only to the page target's own session` |
  | Page not taking input (wheel) | `ardia: the page isn't taking input right now` |
  | No page to send input to | `ardia: there's no page to send input to` |
  | Point outside the page's view | `ardia: that point is outside the page` |
  | Nothing to send input to at that point | `ardia: there's nothing there to send input to` |
  | Input can't be built from those values | `ardia: that input can't be made` |
  | Session can't send input | `ardia: that session can't send input` |
  | Input refused at delivery (session departed, scope, lease, touch emulation) | `ardia: input isn't allowed for this session` |
  | Out of scope: the tab left the plugin's window | `ardia: tab_out_of_scope: the tab left the plugin's window` |
  | No attached session with that `sessionId` | `ardia: no attached session has that sessionId` |
  | nodeId not in this page | `ardia: that nodeId isn't in this page` |
  | backendNodeId not in this page | `ardia: that backendNodeId isn't in this page` |
  | Node left the page during an accessibility query | `ardia: that node left this page while the query was pending` |
  | Not a JSON object | `ardia: a command must be a JSON object` |
  | No id or method | `ardia: a command needs an id and a method` |
  | params not an object | `ardia: params must be an object` |
  | Connection closing | `ardia: this connection is closing` |
  | Duplicate id still waiting | `ardia: a command with that id is still waiting for its reply` |
  | Too many waiting commands (the socket closes) | `ardia: too many commands are waiting for replies; closing the connection` |
  | Method or parameter off the allowlist (pattern) | `ardia: <method> <what> isn't allowed for a plugin` |
  | Click or mouse values refused by the validator (pattern) | `ardia: <method> <what> can't be sent` |
  | File picker answer refused (pattern, owner only) | `ardia: Ardia.answerFilePicker <what> can't be answered` |
  | Hold: unknown, revoked or dead credential | `no such credential` |
  | Hold: no such tab | `no such tab` |
  | Hold: tab out of scope | `tab out of scope` |
  | Hold: no attached session on that tab | `no attached session` |
  | Hold: another hold on that tab is still being taken | `another hold on that tab is still being taken` |
  | Mint: the profile already has 16 live credentials | `too many plugin credentials for this profile` |
- **Handing it to the CLI child.** The app creates a pipe, writes the credential to it and closes its write end, and
  passes the read end to the child as an inherited fd (`posix_spawn_file_actions_adddup2`; with
  `POSIX_SPAWN_CLOEXEC_DEFAULT` nothing else leaks). It sets `ARDIA_PLUGIN_CREDENTIAL_FD=<n>`, the fd number only, and
  `ARDIA_PLUGIN_ENDPOINT=<endpoint>` (not secret: the socket refuses it without the credential). `n` is the app's
  choice; fd 3 is already the plugin channel (`ARDIA_PLUGIN_FD`), so plugin children use 4.
- **Framing on that fd: the raw credential bytes, then EOF.** No newline, no length prefix, no JSON. The 45 bytes fit
  in one pipe write (under `PIPE_BUF`), so the app writes before or right after the spawn without blocking. The reader
  reads until EOF, at most 256 bytes, then closes the fd. It refuses anything that isn't exactly `p.` followed by
  base64url characters (a trailing newline included), and an fd that is missing, isn't readable or is a terminal. The
  fd must not reach the child's own children: it arrives without `FD_CLOEXEC`, so the child closes it as soon as it
  has read it, before it spawns anything.
- **Connecting.** The child opens `<endpoint>?token=<credential>` (base64url needs no escaping) with no `Origin`
  header, exactly like the `ardia` command's browser connection. `/ardia/active` and `/json*` answer it nothing.
  The credential stays in the query (`?token=`), and the engine never records it:
  - **Not recorded:** nothing on the engine side records the request path or query: not `net/server`, the DevTools
    handler, NetLog (the server socket has no NetLog source), crash keys, tracing, internals pages or our own logging.
    One exception, which never includes the credential: a plain HTTP request to a `/devtools/` path with an unknown
    file suffix can log that path in `GetMimeType`, but Chromium strips the query before it gets there.
  - **Crash dumps:** a dump holds process memory, so it can hold the credential, as it would any secret, whichever way
    the credential arrived.
  - **Client side:** the remaining risk is there. The TS client never puts the raw endpoint in an error.
  - **Malformed request lines:** the one edge case. `net/server` logs the protocol token of a request line it can't
    parse, which could carry part of a URL with a space in it; such a line only ever comes from the client itself.
