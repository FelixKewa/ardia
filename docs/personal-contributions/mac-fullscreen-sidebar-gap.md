# Mac full screen keeps the traffic lights' empty band

| Field | Record |
| --- | --- |
| Symptom and trigger | In full screen on the Mac, the sidebar keeps the empty band that holds the traffic lights in a window, so pinned tabs sit as low as in a window and a download button stays alone in that band. |
| Scope | Confirmed upstream (ardia-browser/ardia#4541, filed by a maintainer) on `main` aac043a937f8. |
| Authorized task | On 2026-11-27 Felix asked for another easy free upstream bug: claim, fix, integrate into the personal source and open the PR. No release. Standing CLA authorization. |
| Current owner | Head Developer coordinates GitHub and integration; Developer #2 implemented `fix/mac-fullscreen-sidebar-gap` in a linked worktree. |
| Rules snapshot | Retrieved 2026-11-27 at upstream `main` aac043a937f8: `CONTRIBUTING.md` blob 525dd9f5793c, `.github/pull_request_template.md` blob d2e7fa6db4b5. |
| Eligibility and claim | FelixKewa, not vouched. Before the claim: open PRs #4594 and #4601, assigned issues #4599 and #2727; this is the third of each, the outsider limit. #4541 carried `bug` and `todo`; prshv1's `/take` was released by `/drop` the same morning, with no open PR or branch for it. `/take` on 2026-11-27 assigned FelixKewa. |
| Baseline | Upstream `main` aac043a937f8, hidden Debug build with a test bundle ID; full screen acted out with the shell's `fakeFullScreen` test hook. |
| Expected and actual | Expected: no room kept for the traffic lights in full screen. Before: first pinned icon at 66.5 pt in a window and in full screen. After: 29.5 pt in full screen, 66.5 pt in a window; the download button moves to the sidebar footer. |
| Regression check | `apps/browser/src/state/windows/fullScreenSidebarHeader.test.mjs`: 2 pass and 2 fail on the base with only the test, 4 of 4 with the fix. |
| Contribution branch | FelixKewa/ardia `fix/mac-fullscreen-sidebar-gap` on upstream `main` aac043a937f8 |
| Fix and revisions | 6476c7a71aa9 Mac full screen: pinned tabs move up into the traffic lights' band |
| Personal integration | `codex/webkit-kimchi`: 2bd6b5a04, cherry-picked from 6476c7a71aa9 with no adaptation. Window and sidebar tests 540 of 540, the desktop module-graph test 11 of 11 and the `apps/browser` typecheck pass on the personal tree. |
| Issue and PR | https://github.com/ardia-browser/ardia/issues/4541 (open, `bug`, assigned FelixKewa). PR pending. |
| Evidence | Full-screen side-by-side, before on the left and after on the right, SHA-256 2b91fe4b01a6679e5b77ef87f56bff7ec8bb1cd818d78c204b7e55ceee8df27e. Felix uploads it while creating the PR. |
| Review and CI | pending |
| Personal delivery | Integrated in source; not yet published or installed. |
| Accepted upstream change | not applicable yet |
| Reconciliation | not applicable yet |
| Last checked | 2026-11-27: PR page prepared for Felix to add the screenshot and create. |
