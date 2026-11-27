# A WebKit page takes the keyboard from the command bar

| Field | Record |
| --- | --- |
| Symptom and trigger | Open New Tab from the sidebar over a WebKit tab and type. The bar disappears mid-word and the rest of the typing reaches the page, where it runs the page's own shortcuts. Trigger: the page focuses one of its own elements while the bar is open, as video players do. |
| Scope | Confirmed upstream for WebKit tabs. Chromium tabs refuse the same page focus. Also explains the bar closing during a held Backspace; on a page that never focuses itself, five held-Backspace variants left the bar open. |
| Authorized task | Felix reported the symptom on 2026-11-27. Scope: diagnose, fix, integrate into the personal source and push a contribution branch to the fork. No upstream issue, claim or PR until a PR slot is free. No release. |
| Current owner | Head Developer coordinates GitHub; Developer #1 implemented `fix/webkit-page-steals-typing` in a linked worktree. |
| Rules snapshot | Retrieved 2026-11-27 at upstream `main` 9f0583252a22: `CONTRIBUTING.md` blob 525dd9f5793c, `.github/pull_request_template.md` blob d2e7fa6db4b5. |
| Eligibility and claim | Not attempted: FelixKewa is at the limit of 3 open PRs for an outside contributor (#4594, #4601, #4605). Issue searches on 2026-11-27 found no report of this bug. |
| Baseline | Upstream `main` 15c0128dd3ec, hidden Debug build with the published engine for key 8db616c1affa and a test bundle ID. Synthetic two-page fixture with its own key log; the page focuses its player on request. Typing is injected as hardware key events. |
| Expected and actual | Expected: the bar keeps the keyboard and the typed text; the page gets no keys. Before: the bar closed after 5 of 13 keys and the page received the rest. After: the bar stayed open through every key, the page received none, a click on the page still moved the keyboard there, and a page could still focus itself while nothing was being typed. |
| Regression check | `packages/ardiacore/tests/webkit-page-typing.test.mjs` with real WebKit: 2 of 2 pass with the fix; with the guard replaced by an empty function the native binary fails 9 expectations. |
| Contribution branch | FelixKewa/ardia `fix/webkit-page-steals-typing` on upstream `main` 9f0583252a22. The commits between the baseline and this base touch only the site and its meadow shader. |
| Fix and revisions | 06333b417d9f Mac: a WebKit page can't take the keyboard from a browser text field (5977e13f3 before the rebase onto 9f0583252a22). |
| Personal integration | `codex/webkit-kimchi`: 9872e7303a1c, cherry-picked from 06333b417d9f; the only adaptation is merging the test list in `packages/ardiacore/package.json`. Personal hidden build, with a test copy of the prepared Kimchi package loaded and allowed on the fixture: the same scenarios pass. The fixture does not exercise Kimchi's Netflix behaviour. |
| Issue and PR | queued: waiting for a free PR slot |
| Evidence | Kept outside Git, nothing uploaded. Before capture (page after losing the bar) SHA-256 cac60ba88bccb0b6ca36ff622793dc1b7ca1dc667094b5cc89dc9bc37f78bc55; after capture (bar still open) 5c7ec4ee83af86323ac9e35999960461b7fd5183f1ee3f08e6ac9e9d64802480; before run log 8316241e9d64ec8b4f1bacfdfc399ca48f11e3e114a14b89aac5fa5c7d060938; after run log 975a0995b5185301b936aefde3b8296db2d1651e3cdc10ec876ad9d50eaf12ed; test without the fix 15581b83d18b252095b878fd494f5745686526807b03aaa26af5f1933ef0ba46; test with the fix 9c2475b02174cacd115e6bc25f84707cb68cd75fb0f6989d76660b8eb1c32778. The harness cannot type `y` on the test keyboard layout, so the typed text lacks it in both runs. |
| Review and CI | Independent agent review: Web Inspector was also being refused (fixed by guarding only Ardia's page views) and one unreachable condition was removed. Left as is: a method wrapper added by another binary would switch the guard off. Element fullscreen, VoiceOver and live input method composition were not checked. No Codex review (not available). No hosted CI yet. |
| Personal delivery | Integrated in source; not yet published or installed. |
| Accepted upstream change | not applicable yet |
| Reconciliation | not applicable yet |
| Last checked | 2026-11-27: branch pushed to the fork. Next: open the issue and PR when a slot is free, uploading the two captures into the PR description. |
