# Sidebar tab titles unreadable with higher contrast text

| Field | Record |
| --- | --- |
| Symptom and trigger | With Higher contrast text on, switching between light and dark while Ardia is open leaves inactive sidebar tab titles in the old appearance: black on the dark sidebar, or white on the light one, until a restart. |
| Scope | Confirmed upstream (ardia-browser/ardia#2727, reported by another user) on `main` aac043a937f8. Each mode looks right right after a launch; the bug needs a live switch. |
| Authorized task | On 2026-11-27 Felix asked for an easy free upstream bug to practise the upstream-fix workflow: claim, fix, integrate into the personal source and open the PR. No release. He gave standing authorization for the CLA signature. |
| Current owner | Head Developer coordinates GitHub and integration; Developer #1 implemented `fix/sidebar-contrast-titles` in a linked worktree. |
| Rules snapshot | Retrieved 2026-11-27 at upstream `main` aac043a937f8: `CONTRIBUTING.md` blob 525dd9f5793c, `.github/pull_request_template.md` blob d2e7fa6db4b5. |
| Eligibility and claim | FelixKewa, not vouched: bug fixes only, 3 open PRs and 3 assigned issues at a time. Before the claim: one open PR (#4594) and one assigned issue (#4599). #2727 carried `bug`, had no assignee, no linked PR and no `/take`; `/take` on 2026-11-27 assigned FelixKewa. No open PR touched the same fix. |
| Baseline | Upstream `main` aac043a937f8, hidden Debug build with the published engine for key 8db616c1affa and a test bundle ID. Theme switched through Ardia's own setting, not the macOS appearance. |
| Expected and actual | Expected: titles follow the theme after a live switch. Before: titles keep the launch appearance. After: readable after every switch, and higher-contrast titles draw at full opacity. |
| Regression check | `apps/browser/src/components/ui/drawnNative.test.mjs`: 5 pass and 1 fail on the base with only the test (`rgba(255,255,255,1)` where a hex colour is expected), 6 of 6 with the fix. |
| Contribution branch | FelixKewa/ardia `fix/sidebar-contrast-titles` on upstream `main` aac043a937f8 |
| Fix and revisions | 0397de548e7a Sidebar: tab titles keep their colour with higher contrast text |
| Personal integration | `codex/webkit-kimchi`: 5ee423d1a, cherry-picked from 0397de548e7a with no adaptation. `components/ui` tests 137 of 137 and the `apps/browser` typecheck pass on the personal tree. |
| Issue and PR | https://github.com/ardia-browser/ardia/issues/2727 (open, `bug`, assigned FelixKewa). PR pending. |
| Evidence | Side-by-side of the sidebar after a live switch to dark with higher contrast, before on the left and after on the right, SHA-256 73218dd8b73f0b9c7b83789faf9300bdf306b50074d2ea7138a43a50d850902c. Felix uploads it in the PR description. |
| Review and CI | pending |
| Personal delivery | Integrated in source; not yet published or installed. |
| Accepted upstream change | not applicable yet |
| Reconciliation | not applicable yet |
| Last checked | 2026-11-27: PR page prepared for Felix to add the screenshot and create. |
