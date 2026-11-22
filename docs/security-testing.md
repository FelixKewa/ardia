# Security tests

These tests guard the places where data the user didn't type reaches a privileged part of the browser: a page's
messages and events, values a page returns from evaluated script, other devices' sync records, links from other apps,
plugin calls and the control socket. They run in the normal checks (`pnpm -C apps/browser test`, the packages'
portable tests and CI on every pull request) and add about 7 seconds.

0.2.48 fixed a picked selector with a line break in it, which the content blocker stored as an extra filter line. The
value had passed a check that was right for the input it expected. These tests check what the privileged
sink finally receives, for every input shape in one shared list, so a check that is right for the expected input but
wrong for an awkward one fails here and not in a release.

## The layers

| Layer | File | What it checks |
| --- | --- | --- |
| Boundary table | `apps/browser/src/boundaries.json`, `apps/browser/src/boundaries.test.mjs` | Every entry point, found by reading the code: Chromium page messages (`page_script.js` sends, `ArdiaWebView+PageMessages.mm` receivers), the page script's DOM listeners, WebKit page messages, listeners and script handlers, every `evaluate` call site in `apps/browser/src`, native event channels (`ShellEvents.swift`), sync adapters, plugin channel methods, control socket families and raw settings writes. Each row names its source and its guard, and the files and symbols it cites must still exist. A new entry point with no row fails, so does a changed call count, and so does a page script listening for a custom DOM event |
| Hostile inputs | `scripts/security/hostile-inputs.mjs` | One shared list: CR, LF, CRLF, FF, VT, NEL, U+2028/2029, NUL, BOM, lone surrogates, overlong strings, uBlock filter syntax (scriptlets, exceptions, HTML and header filters, network options, preparser directives, procedural and action operators), script, data, file and engine URL schemes, path traversal, Object prototype keys and wrong types |
| Validators and sinks | `apps/browser/src/hostileInputs.test.mjs`, `packages/core/src/hostileInputs.test.ts` | Every hostile value through each guard, checked at the sink: a hiding rule is one line that the app, the Mac write guard and the Linux guards all accept, or nothing; a link from another app opens only a web, file, blank or listed Ardia address; plugin URLs are http(s) only; no settings write, sync write or synced record leaves a setting outside its spec; search templates stay http(s); Reader and Find take nothing from a page that changes settings; typed text never becomes a script URL. One case per finding id from the 0.2.48 review, named after it |
| uBlock compile | `apps/browser/src/state/site/hidingRuleSink.test.mjs` | Downloads the uBlock Origin release `packages/ardiacore/scripts/ubo.sh` pins (checked against its SHA-256, cached in `apps/browser/node_modules/.cache/ublock`) and compiles the user list with each rule the picker could save appended, as `appendUserFilters` and `compileFilters` do. Each adds exactly one line, which uBlock either refuses or reads as a plain cosmetic rule; with the blockers' own `querySelector` check applied, it is always exactly one plain cosmetic rule. Existing rules compile as before |
| Real browser | `apps/browser/src/state/site/elementPicker.test.mjs`, `packages/ardiacore/tests/page-script-synthetic-input.test.mjs` | Headless Chromium. The picker refuses a planted picker object and ignores synthetic input; a page that rewrites the helpers the picker calls still gets only inert rules saved. The real `page_script.js` sends no gesture-gated message (new-tab link notes, Peek, link drops, screen share) for dispatched events, scripted clicks, `window.open` without activation or the old Hide Element event, and the same harness does see a real click |

`scripts/lib/test-chromium.mjs` finds the browser: Playwright's own download, `ARDIA_TEST_CHROMIUM`, or the system
Chrome GitHub's Linux runners ship. Locally, a missing browser or no network skips those cases; in CI, both fail.

## Adding an entry point

When code starts taking data from a page, a frame, another device, another app, a plugin or the socket, the boundary
test names it. Then:

1. Add its row to `apps/browser/src/boundaries.json`: `id` as the failure printed it, `source` (one of `sources`),
   `guard` (what refuses bad input, in a sentence) and `checks` (`path#symbol` of the guard, so the row can't outlive
   it). Keep `count` equal to the call count the test reports. Rows for entry points no detector finds carry
   `"detected": false`.
2. Run the shared list through the new guard in `hostileInputs.test.mjs` and assert on what the sink receives, not on
   the guard's return value alone. A guard that should refuse everything in a class needs a positive control too, so
   the test can't pass because nothing ran.
3. If the guard lets something through, write the failing case. Fix it in the same change when the fix is small and
   clearly right; otherwise open an issue and mark the case `{ todo: "<finding> open: ..." }` so it runs, shows up
   and turns green when fixed.

A regression case is named after the finding it guards (`A1`, `D5`) and should fail with the fix reverted. Check that
once by reverting the fix's lines in your checkout before you commit the case.

## What it doesn't cover

These need a running app or a native build and are left to `docs/testing.md`'s acceptance runs and the Swift and C++
tests:

- Native gates: the Mac's pick confirmation (`ArdiaWebView+ContextMenu.mm`), main-frame and origin checks in
  `ArdiaWebView+PageMessages.mm`, WebKit's `frameInfo` checks, the control socket's peer check, plugin pin and archive
  verification (`packages/shell/plugin-tests`), import readers (`packages/import`), native messaging cleanup and the
  launch environment. The boundary table lists them so a change there is still reviewed.
- Linux's and Windows' native sinks. The Linux C++ guard has its own scenarios in `engine/ardiacore-linux/tests`;
  Windows has none yet.
- Anything that needs a real origin, such as the Chrome Web Store helper, or an OS prompt.
- Timing: races between a check and a use, and stale state across navigations.

Open findings from the 0.2.48 review that these tests mark but don't fix are listed in the rows that cite them
(`findings`) and as `todo` cases.
