# Contribution record and evidence

For each bug, maintain one `docs/personal-contributions/<issue-or-slug>.md` record in the personal source lane. This is resumable project state, not an upstream template. The fork may be public, so make the versioned record public-safe from creation. Preserve earlier commit mappings when a PR is rebased or squashed. Use `not attempted`, `pending`, `not applicable` or `unknown` rather than inventing values. Keep this record out of the upstream diff.

## Record fields

| Field | Record |
| --- | --- |
| Symptom and trigger | Observable problem and minimal reproduction |
| Scope | Confirmed upstream, personal-only, already fixed, duplicate or unconfirmed |
| Authorized task | Public-safe scope summary and narrower publication/capture/release limits, not a private conversation transcript |
| Current owner | Implementation/review responsibilities, branch and repository-relative workspace references |
| Rules snapshot | Retrieval date, upstream CONTRIBUTING commit/blob, issue/PR template versions |
| Eligibility and claim | Authenticated account, applicable limits, assignee/claim result, linked competing work |
| Baseline | Upstream commit, official/test build version, platform, layout and fixture |
| Expected and actual | Before behavior and accepted success condition |
| Regression check | Exact command/path, before result and after result |
| Contribution branch | Fork owner/repository/branch and upstream base |
| Fix and revisions | Ordered original/revised SHAs and reason for each mapping |
| Personal integration | Source branch and integration/adaptation SHAs; personal regression result |
| Issue and PR | Verified upstream URLs; draft/open/merged/declined state |
| Evidence | Before/after files, SHA-256, capture conditions and verified attachment URLs |
| Review and CI | Tested head SHA, check conclusions, unresolved threads and maintainer gates |
| Personal delivery | Integrated source; first published build/run/feed only if verified; installed build separately |
| Accepted upstream change | Actual merge/squash/rebase SHA, accepted behavior and any remaining personal delta |
| Reconciliation | Sync/integration SHA, regression result and completion/pending state |
| Last checked | Timestamp and the exact remaining action/owner |

Use only repository-relative paths and public URLs in the versioned record. Do not store machine-absolute paths, private artifact locations, user-report transcripts, credentials, private captures, signing secrets or browser data there. Keep local evidence paths in a separate private companion outside Git, use a task-owned artifact directory outside the checkout, and publish only reviewed neutral files.

## Evidence package

Use matching conditions and identify which commits/builds produced each artifact. Save a failing baseline before editing; if the baseline must be rebuilt later, rebuild its recorded immutable source and say so. Do not recreate the “before” by deliberately breaking the fixed app.

| Item | Required detail |
| --- | --- |
| Reproduction | Short ordered actions, fixture and relevant settings |
| Before | Visible failure or actual failing check, source/build identity |
| After | Same actions/check succeeding, source/build identity |
| Coverage | Focused and adjacent checks; affected platform results |
| Comparison | Dia reference only when relevant and actually examined |
| Limitations | Missing runtime evidence, inaccessible upload, gated CI or untested platform stated explicitly |

Screenshots demonstrate visible states; recordings demonstrate motion/timing when permitted. For a nonvisual change, show the actual before/after check output. Read current contribution/readiness rules to determine whether an additional visual attachment is required. Evidence should show the changed behavior, not merely a test runner's green summary.

## PR content

Use the live upstream PR template. Supply these facts in its matching fields:

- The concrete user action that triggers the problem and the resulting behavior.
- The diagnosed cause, with uncertainty labelled if any remains.
- What the fix changes and why its scope is sufficient.
- The claimed issue's required closing reference, normally `Closes #N` for the upstream repository.
- A verification section with reproducible steps, exact commands, baseline/fixed source identities and real attachment links.
- Cross-platform or engine impact when applicable, including actual checked/skipped results.
- Remaining limitations and any required user/maintainer action, without claiming missing human review or legal assent.

Do not include the fork's signing/update configuration, release bumps, this record or unrelated personal customization. Required agent disclosures must be truthful and consistent with active user instructions; surface a genuine conflict instead of fabricating compliance.

## Resume and completion

On resumption, query current issue ownership, PR head, review/check status, upstream base, personal branch head and active release leases. Records can become stale while another agent or maintainer works.

Track these independently: reproduced, fixed/tested, personally integrated, PR submitted, review pending, upstream merged, reconciled, personal release published, update installed. A declined upstream PR can coexist with a retained personal fix. A source merge alone does not establish release or installation.
