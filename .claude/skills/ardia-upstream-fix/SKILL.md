---
name: ardia-upstream-fix
description: Fix a reported Ardia bug in Felix's personal fork and contribute the same focused fix upstream, including issue ownership, before-and-after evidence, pull request review and later reconciliation. Use when Felix asks to fix and contribute a specific bug or maintain an existing contribution.
---

# Ardia upstream bug fix

Deliver one verified fix to Felix's personal source and one reviewable contribution to the original Ardia repository. Upstream review must not hold back personal integration. Keep source integration, published updates and installation as separate facts.

This is a repository-local, model-independent workflow. Use the agent's available Git, GitHub and testing tools; no particular assistant, model, subscription or connector is required. Repository paths are relative to the repository root; Markdown resource links are relative to this skill file.

## Scope and authorization

Felix invoking this skill for a specific bug authorizes its investigation, owned code changes, personal integration, fork branch pushes, upstream issue/claim, evidence upload, pull request and replies needed to maintain that contribution. Do not ask again for each routine step already covered by that request. A narrower instruction such as “diagnose only” limits the workflow.

Creating, reading or reviewing this skill, or noticing a bug incidentally, does not authorize public posts. If the user only reports a symptom without asking to contribute it, investigate under the existing task and establish contribution intent before publishing.

Felix has standing-authorized the upstream CLA signature (2026-11-27): post it for him as described under delivery, without asking first. Apart from that, this scope does not authorize making legal/human-review attestations for Felix, merging upstream, changing maintainer trust/CI controls, publishing upstream releases or deploying its site. Follow the active release instructions: integrating a personal fix is not by itself an explicit request to cut a release. Do not enable scheduling, change keys or replace the running browser as a side effect.

## Establish the current rules and state

Read local `AGENTS.md`, `docs/agent-brief.md`, `docs/conventions.md` and `docs/personal-browser.md`. Confirm the canonical checkout from Git and the current user instructions; keep work in the approved visible GitHub workspace. Inspect the shared working tree and active owners before editing or committing.

Fetch/read the latest upstream `CONTRIBUTING.md`, applicable issue form and PR template from `ardia-browser/ardia` before opening or updating a contribution. Record their commit/blob identifiers and retrieval date. Use the live rules, not a frozen copy of today's claim limits, labels, review bots or stale deadlines. Read relevant upstream `AGENTS.md` and testing guidance for the affected area.

Confirm the authenticated GitHub identity, its actual contribution eligibility, open-PR limits and issue ownership. Do not assume collaborator/vouched status from the fork owner's name. Check for duplicate issues, existing fixes, claimed work and linked PRs before implementing a competing solution.

Expected repository roles, to verify rather than infer from a default remote:

| Role | Expected destination |
| --- | --- |
| Original project and PR base | `ardia-browser/ardia`, current `main` |
| Felix's fork | `FelixKewa/ardia`, normally remote `fork` |
| Personal browser source | `codex/webkit-kimchi` |
| Trusted personal update controller | Fork `main` |
| Signed update feed | `personal-updates` |

Never push to upstream `main`, use fork `main` as the personal application branch, or merge the entire personal branch into a contribution branch. Do not modify controller/feed branches to deliver an ordinary browser fix.

Use [the contribution record](references/contribution-record.md) to create or resume `docs/personal-contributions/<issue-or-slug>.md` on the personal source lane. The fork may be public: keep versioned records public-safe from creation, using repository-relative paths and public URLs, with private artifact locations in a separate local companion outside Git. Keep that record and this skill out of the upstream bug-fix diff.

## Prove the bug belongs upstream

1. Record the user's trigger, expected/actual behavior, version, platform, layout and relevant profile/window conditions. Distinguish observations from hypotheses.
2. Reproduce on a frozen, clean upstream commit or a verified matching official build, using isolated data. Preserve the baseline commit/build and failing check or capture before editing.
3. If it only fails with our custom changes, fix it in the personal lane and explain that no upstream bug was established. Do not submit the old Chromium/Peek diagnosis merely because an extension fails in WebKit.
4. If upstream already fixed it, verify that change and integrate through the normal personal source process. If an existing PR covers it, test/support that PR rather than open a duplicate. If another contributor owns the issue, coordinate through the permitted claim process instead of taking it over.

If the bug cannot yet be reproduced, retain the useful evidence and state what is missing. Do not invent a cause or publish a definitive claim unsupported by the baseline.

## Claim and implement one focused change

Reuse the matching issue when possible. Otherwise file it through the live upstream web bug form, never through the API or `gh issue create`. GitHub drops labels set by an account without triage access, so an API-created issue arrives without the form's `bug` label. Then `/take` is refused and the PR fails `bug-fix-only` until a maintainer labels it. Submit the form from a browser signed in as Felix:
- drive his own signed-in browser when he has allowed that for GitHub;
- otherwise send him a prefilled form link (`/issues/new?template=<form file>&title=…&<field id>=…`) and let him press Create.

Fill the current form's required fields truthfully, including version and reproduction details.

Before claiming, confirm from GitHub that the issue exists, is authored by Felix and carries `bug`. A form that was opened but never submitted leaves no issue. If a reused issue lacks `bug`, ask a maintainer on it rather than filing a duplicate. Claim it using the live contribution procedure and verify the resulting ownership before starting the proposed fix. Respect eligibility and concurrent-PR limits; do not label yourself trusted or add maintainer-only CI controls to bypass them.

An occupied claim or PR limit blocks a new upstream submission, not a separately verified personal remedy. Keep that personal work distinct, record the upstream dependency, and do not steal the claim or open a competing PR.

Create an owned contribution branch from the recorded current upstream base, following the active branch-naming convention. Use permitted isolation for that branch. Never switch, reset, clean or stash the shared personal checkout to make room for it; another agent's pending work must survive. If isolation is temporarily unavailable, continue independent diagnosis/evidence work and report the actual Git dependency.

Implement only the reported problem and the tests/docs it needs. Exclude personal Kimchi preparation, signing configuration, updater policy, private handover material and unrelated cleanups unless a specific upstream fix truly requires an independently reviewable part. Review the complete PR-base-to-head diff, including its ancestry, before pushing.

Follow the repository's build locks, engine rules, boundary tests, telemetry consent and platform checks for the changed area. Use real production paths in regression tests. Get independent review for risky permission, lifetime, race, migration or sync logic; reproduce findings before changing the implementation. Delegate by file ownership when useful without requiring an unavailable model or service.

## Produce honest before-and-after proof

Use the same reproduction, neutral fixture, layout, viewport and relevant settings for both results. Identify exact before/after commits and builds. A personal build screenshot alone does not prove the clean upstream change.

- For visible state/layout bugs, save matched before/after screenshots from isolated test instances.
- For timing, animation or interaction bugs, use a short recording when permitted and necessary to demonstrate the behavior; measure what the issue actually concerns.
- For nonvisual bugs, retain the concrete failing result before and passing result after, with commands and relevant output. If current readiness automation additionally requires a visual attachment, satisfy it truthfully or report that gate as pending.

Prefer in-process captures and synthetic pages. Never record the user's desktop or live accounts to satisfy a PR checklist, and honor any active ban on recording/capture. Keep profile data, tokens, browsing history and unrelated windows out of all evidence. A required capture that cannot be obtained is a real limitation, not permission to fabricate one.

Store evidence outside the source tree and record hashes. Put the screenshot or recording in the PR description itself, uploaded through GitHub's web editor. The readiness automation reads only the description; images in comments do not count.
- Upload it with the signed-in browser's file upload when Felix has allowed that.
- Otherwise give him the prepared file and say exactly where in the description to drop it.

Scripted public hosting, such as gists, release assets or other sites, is not an attachment method. Do not commit screenshots/videos, invent attachment URLs, or call a local-only path accessible to reviewers. Open the PR with its evidence already in the description. Keep it a draft only while required evidence is genuinely pending, and report the exact missing step.

## Deliver to the personal branch and upstream PR

Integrate the verified fix into the personal source without waiting for upstream acceptance. Prefer preserving the same fix commits when histories permit; if adaptation/cherry-picking is necessary, record the mapping and test the personal result. Include review corrections in both lanes.

Before a personal source push, check current remote state and any active personal release's frozen-source leases. Coordinate with its owner rather than invalidating a publishing run. Preserve unrelated personal features and uncommitted work; stage only owned changes and inspect the shared index. Never force-push the personal source/controller/feed branches to reconcile a bug fix.

A personal commit is not an installed update. Report the integration SHA and use the existing authorized personal update process. If active instructions require an explicit release request for this invocation, integrate/queue until that request; do not bypass that constraint. Where current or standing user authorization already covers publication, proceed through the personal gates without another permission question. An already authorized nightly process can pick up eligible source changes normally. Use `docs/personal-browser.md` and the personal pipeline, not the upstream release/site workflow. Retain signing, upgrade-proof and publication gates; verify available and installed versions separately.

Push the clean contribution branch to Felix's fork and open the upstream PR with the verified base/head repositories. Follow the current template, link the claimed issue using its required closing syntax, and explain the trigger, cause, user-visible result, test evidence and material limitations. Use [the record reference](references/contribution-record.md) for the evidence/PR contents, not as a replacement for upstream's current template.

Check the final diff yourself. Do not attest that Felix performed a human review or signed an agreement when he has not. Sign the CLA for him as soon as the PR is open. If the CLA bot asks for a signature, post its exact signing comment (today `I have read the CLA Document and I hereby sign the CLA`) on the PR from his account, then confirm the `cla` check passes. Report that you signed it and which CLA version. Upstream stores each signature per CLA version (`signatures/cla-v1.json` on `cla-signatures`), so the bot normally asks only after a new version. Honor active user instructions about attribution.

Upstream's `CONTRIBUTING.md` asks the PR description to end with the model and harness that did the work. A plain final line such as `Model: <model> (<role>). Harness: <harness>.` meets that without the `Co-Authored-By`, "Generated with" or session-link lines that `AGENTS.md` forbids. Name every model that actually took part. If live upstream disclosure requirements genuinely conflict with those instructions, identify the precise conflict and leave the affected submission step pending; do not falsely claim full compliance or silently invent an attribution line.

Use structured text arguments or a body file for multiline issue/PR text. Verify the resulting issue, PR and attachment links after creation. Public descriptions contain no local operational paths, private profile details or signing material.

## Maintain and reconcile the contribution

Read the actual checks and review threads. Address valid findings, explain disagreements with evidence, and resolve a thread only after its concern is answered or the correction is verified. Keep the PR mergeable against upstream and update the personal integration when reviewer changes affect it.

When rebasing an owned PR branch is required, preserve the previous head, confirm nobody else advanced it and use a lease-aware update. Do not rewrite another contributor's branch or drop review corrections. Recheck the final changed behavior and affected checks, rather than endlessly rerunning unrelated suites.

Monitor active checks with bounded waits and deadlines. A maintainer decision, trust-gated CI, unresolved rule conflict, access problem or missing permitted evidence should produce a concrete pending state and next action. Do not post empty keepalive comments, create a background watcher or claim continuous monitoring without a separate request. On a later invocation, resume from the record and fresh GitHub state.

After upstream merges, record its actual merge/squash/rebase commit and compare the accepted effective change with the personal implementation. The same behavior may already exist under different SHAs. Let the normal upstream sync merge the histories, apply only any missing correction, and rerun the regression. Never blindly cherry-pick the accepted patch a second time or revert the personal fix merely because its original commit was not retained upstream.

If upstream declines or closes the PR, keep a verified useful personal fix unless Felix asks otherwise. Record the reason and future maintenance implications. Do not reopen, repackage or resubmit to evade the decision.

Finish with the issue/PR links, proof collected, personal integration SHA, review/check state, published/installed status if verified, and the next concrete action. “Submitted for review” is a valid handoff; “merged,” “released” and “installed” require separate evidence.
