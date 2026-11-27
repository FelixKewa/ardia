# Keys held in the command bar repeat into the page

| Field | Record |
| --- | --- |
| Symptom and trigger | Keep a key pressed in the command bar while the bar closes. Its repeats continue into the page: Escape reaches the page, and Backspace reaches it too, which in a WebKit tab goes back one page. |
| Scope | Confirmed upstream for Chromium and WebKit tabs on macOS. Linux and Windows were not checked. WebKit's Backspace-goes-back setting stays on by Felix's choice. |
| Authorized task | Felix reported the held-Backspace symptom on 2026-11-27 and asked that repeats started in the bar never reach the page. Scope: fix, integrate into the personal source and push a contribution branch to the fork. No upstream issue, claim or PR until a PR slot is free. No release. |
| Current owner | Head Developer coordinates GitHub; Developer #1 implemented `fix/held-keys-reach-pages` in a linked worktree. |
| Rules snapshot | Retrieved 2026-11-27 at upstream `main` 9f0583252a22: `CONTRIBUTING.md` blob 525dd9f5793c, `.github/pull_request_template.md` blob d2e7fa6db4b5. |
| Eligibility and claim | Not attempted: FelixKewa is at the limit of 3 open PRs for an outside contributor (#4594, #4601, #4605). Issue searches on 2026-11-27 found no report of this bug. |
| Baseline | Upstream `main` 15c0128dd3ec, hidden Debug build with the published engine for key 8db616c1affa and a test bundle ID. Synthetic two-page fixture with its own key log; keys are injected as hardware events with auto-repeat. |
| Expected and actual | Expected: the page gets no repeat of a key that was first pressed in the bar. Before: held Escape delivered 14 repeats to a Chromium page; closing the bar during a held Backspace delivered 25 repeats to a Chromium page and sent a WebKit tab back a page. After: no key reached either page and the WebKit tab stayed; keys first pressed on a page still repeat there; Backspace held in the open bar leaves it open and empty. |
| Regression check | `packages/shell/scripts/fieldKeyRepeats.test.mjs` runs the installed key monitor against a real field and WebKit page: 2 of 2 pass with the fix; with a monitor-free stand-in the native binary fails 11 expectations. |
| Contribution branch | FelixKewa/ardia `fix/held-keys-reach-pages` on upstream `main` 9f0583252a22. The commits between the baseline and this base touch only the site and its meadow shader. |
| Fix and revisions | bc68e3d6d0ad Mac: a key held in a browser text field never repeats into a page (ba47d7c25 before the parity note moved to its own row and the rebase onto 9f0583252a22). |
| Personal integration | `codex/webkit-kimchi`: e47d3febb2e0, cherry-picked from bc68e3d6d0ad with no adaptation. Personal hidden build, with a test copy of the prepared Kimchi package loaded: the same scenarios pass on a WebKit tab. |
| Issue and PR | queued: waiting for a free PR slot |
| Evidence | Kept outside Git, nothing uploaded. Before capture (WebKit tab sent back) SHA-256 ed4957c4526137916c770413ddb153d1b38e7acb96f804ffbecd24036ae52631; after capture (page unchanged, no keys) ab7f220d4bf24ad627fd7a1bbd8d508f9d2fcc873322fe7b7cb4c6a166193f39; before run logs, Chromium held Escape f9853b53049da241e7d1186f62ea12590b55921ad98174b80a0bc5647b00b077, Chromium held Backspace a456607e1ae06a96f9e3cefc34bb958d59a26fefd7dbdce8e7064ff50dd97f4c and WebKit held Backspace af8e5e16edafb9ae45d38e59babf3589e11e1c8930f4d0deda82db67156c3691; after run logs, WebKit df233c1ad46b7749d3c523142d6ba2d88ae4a9072dba3102830eb22317e8e496 and Chromium 857fbb3d879722358d79096abe77b100918307d0c57a0a580a47723f2917230f; test without the fix 00a842224b8fe501bb0d901db25ff202c9c6013683fd71cd1009a46fdf977ca1; test with the fix 16373e98ba2613f978f1e3c4ad785e81e3433bb799ef00e0405725f66d1dcc64. |
| Review and CI | Independent agent review: held Command and Control shortcuts still repeated into pages, and repeats replayed after the release could pass; both fixed, with Control-Tab kept for the tab switcher, and the telemetry wording corrected. Left as is: after a quick tap that closes the bar, the page still receives that key's release. No Codex review (not available). No hosted CI yet. |
| Personal delivery | Integrated in source; not yet published or installed. |
| Accepted upstream change | not applicable yet |
| Reconciliation | not applicable yet |
| Last checked | 2026-11-27: branch pushed to the fork. Next: open the issue and PR when a slot is free, uploading the two captures into the PR description. |
