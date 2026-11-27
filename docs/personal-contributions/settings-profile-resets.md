# Settings › Profiles jumps back to the first profile

| Field | Record |
| --- | --- |
| Symptom and trigger | With two or more profiles, pick a profile other than the window's in Settings › Profiles, visit another Settings pane (or close Settings there and reopen), then return to Profiles: it shows the window's profile again, often the first in the list. |
| Scope | Confirmed upstream on `main` aac043a937f8. Closing Settings while Profiles is on screen and reopening does not reproduce; the loss needs another pane. The report's "nothing worked" is not explained by this bug: picking a profile in Settings never switches the browser window, so an extension installed only in the picked profile is absent from a window on another profile. That part is by design and unchanged. |
| Authorized task | Felix invoked the upstream-fix workflow for this bug on 2026-11-27: diagnose, fix, integrate into the personal source and open an upstream issue and PR. No release, CLA signature or human-review attestation is authorized. |
| Current owner | Head Developer coordinates GitHub and integration; Developer #2 implemented `fix/settings-profile-resets` in a linked worktree. |
| Rules snapshot | Retrieved 2026-11-27 at upstream `main` aac043a937f8: `CONTRIBUTING.md` blob 525dd9f5793c, `.github/ISSUE_TEMPLATE/bug_report.yml` blob 8b668dffd333, `.github/pull_request_template.md` blob d2e7fa6db4b5. |
| Eligibility and claim | Account FelixKewa, not in `.github/VOUCHED.td`: bug fixes only, 3 open PRs and 3 assigned issues at a time. No duplicate issue or PR found. #4593, opened through the API, lost the form's `bug` label and `/take` was refused. Felix re-filed the bug through the web form as #4599, which arrived labelled `bug`; `/take` there assigned FelixKewa. #4593 is closed as a duplicate of #4599. |
| Baseline | Upstream `main` aac043a937f8, Debug build with the published engine for key 8db616c1affa, test bundle ID, profiles Alpha, Beta and Gamma, one window on Alpha. |
| Expected and actual | Expected: Profiles keeps the picked profile. Before: the window's profile after visiting another pane. After: the picked profile. |
| Regression check | `apps/browser/src/state/settings/settingsProfilePick.test.mjs`: 4 pass and 3 fail on the base with only the test, 7 of 7 with the fix. |
| Contribution branch | FelixKewa/ardia `fix/settings-profile-resets` on upstream `main` aac043a937f8 |
| Fix and revisions | 9b0d5402d730 Settings keeps your picked profile when you visit another pane |
| Personal integration | `codex/webkit-kimchi`: e85e72c8f, cherry-picked from 9b0d5402d730 with no adaptation. Settings and extensions tests 423 of 423 and the `apps/browser` typecheck pass on the personal tree. |
| Issue and PR | https://github.com/ardia-browser/ardia/issues/4599 (open, `bug`, assigned FelixKewa). https://github.com/ardia-browser/ardia/pull/4594 (ready for review, `ready`, `vouch:unvouched`, closes #4599). https://github.com/ardia-browser/ardia/issues/4593 closed as a duplicate. |
| Evidence | Side-by-side screenshot of the "General, then Profiles" step, before on the left and after on the right, SHA-256 b6cec0656e7dfe3d73e481fe03ef0d529a86b15e00ced7c2c1789d062084047a. Felix uploaded it to the PR description through the web UI (https://github.com/user-attachments/assets/aa882ab5-b748-49bb-b7af-b4838f63996c), after an automated public upload was refused. Before and after step results and test output are in the PR body. |
| Review and CI | Head 9b0d5402d730. `bug-fix-only`, `cla`, `linked-issue` and `vouch` pass; Felix signed the CLA himself on #4594. CodeRabbit and the gated platform builds wait for a maintainer. No review comments yet. |
| Personal delivery | Integrated in source; not yet published or installed. |
| Accepted upstream change | not applicable yet |
| Reconciliation | not applicable yet |
| Last checked | 2026-11-27: #4594 is `ready`. Next: maintainer review and gated CI; answer Greptile or maintainer findings through Developer #2. |
