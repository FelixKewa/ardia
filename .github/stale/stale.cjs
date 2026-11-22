const fs = require("node:fs");
const path = require("node:path");
const vouch = require("../vouch/vouch.cjs");

const STALE = "stale";
const STALE_LABEL_SPEC = { name: STALE, color: "cfd3d7", description: "No activity for a week; closes after another quiet week" };
const KEEP_LABELS = [vouch.TRUSTED, vouch.READY, "pinned", "keep-open"];
const TARGET_LABELS = [vouch.UNVOUCHED, vouch.INCOMPLETE, vouch.NEEDS_REBASE];
const NUDGE_AFTER_DAYS = 7;
const CLOSE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEAM_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
const WORKFLOW_BOT = "github-actions[bot]";
const ACTIVITY_EVENTS = new Set([
  "commented",
  "committed",
  "reviewed",
  "line-commented",
  "head_ref_force_pushed",
  "head_ref_restored",
  "reopened",
  "ready_for_review",
  "convert_to_draft",
  "renamed",
]);
const SWEEP_WRITE_INTERVAL_MS = 1000;
const TEAM_LIST_PATH = ".github/TEAM.td";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function labelNames(item) {
  return (item.labels || []).map((label) => (typeof label === "string" ? label : label.name));
}

function isBot(actor) {
  if (!actor) return false;
  return actor.type === "Bot" || String(actor.login || "").endsWith("[bot]");
}

function parseTeam(text) {
  return new Set(
    [...vouch.parseVouchedList(text || "")].filter(([, entry]) => !entry.denounced).map(([login]) => login),
  );
}

function isTeamAuthor(pr, team) {
  const author = pr.user;
  if (!author || isBot(author)) return true;
  if (team.has(String(author.login).toLowerCase())) return true;
  return TEAM_ASSOCIATIONS.includes(pr.author_association);
}

function isEligible(pr, team) {
  if (pr.state !== "open") return false;
  const labels = labelNames(pr);
  if (labels.some((label) => KEEP_LABELS.includes(label))) return false;
  if (!labels.some((label) => TARGET_LABELS.includes(label))) return false;
  return !isTeamAuthor(pr, team);
}

function eventTime(event) {
  if (event.event === "committed") return Date.parse((event.committer && event.committer.date) || (event.author && event.author.date) || "");
  if (event.event === "reviewed") return Date.parse(event.submitted_at || "");
  return Date.parse(event.created_at || "");
}

function eventActor(event) {
  return event.actor || event.user || null;
}

function isActivity(event) {
  if (event.event === "unlabeled") return Boolean(event.label && event.label.name === STALE);
  if (!ACTIVITY_EVENTS.has(event.event)) return false;
  if (event.event === "committed") return true;
  return !isBot(eventActor(event));
}

function lastActivity(pr, events) {
  return events
    .filter(isActivity)
    .map(eventTime)
    .filter(Number.isFinite)
    .reduce((latest, time) => Math.max(latest, time), Date.parse(pr.created_at || "") || 0);
}

function staleSince(events) {
  return events
    .filter((event) => event.event === "labeled" && event.label && event.label.name === STALE)
    .map(eventTime)
    .filter(Number.isFinite)
    .reduce((latest, time) => Math.max(latest, time), null);
}

function mayWaitWithoutTimeline(pr, now) {
  if (labelNames(pr).includes(STALE)) return false;
  const updated = Date.parse(pr.updated_at || "");
  return Number.isFinite(updated) && now - updated < NUDGE_AFTER_DAYS * DAY_MS;
}

function decide({ pr, events, now, team }) {
  const marked = labelNames(pr).includes(STALE);
  if (!isEligible(pr, team)) return { action: marked ? "unstale" : "skip" };
  const active = lastActivity(pr, events);
  if (marked) {
    const since = staleSince(events);
    if (since === null) return { action: "wait" };
    if (active > since) return { action: "unstale" };
    return { action: now - since >= CLOSE_AFTER_DAYS * DAY_MS ? "close" : "wait" };
  }
  return { action: now - active >= NUDGE_AFTER_DAYS * DAY_MS ? "nudge" : "wait" };
}

function needsOf(pr) {
  const labels = labelNames(pr);
  const base = (pr.base && pr.base.ref) || "main";
  const needs = [];
  if (labels.includes(vouch.NEEDS_REBASE)) needs.push(`it conflicts with \`${base}\`, so it needs a rebase`);
  if (labels.includes(vouch.INCOMPLETE)) {
    needs.push("something in CONTRIBUTING.md is still missing (a screenshot or video, an open bot thread answered, or a passing check)");
  }
  if (!needs.length) needs.push("it is still waiting on an update from you");
  return needs.join(", and ");
}

function authorOf(pr) {
  return pr.user ? pr.user.login : "there";
}

function nudgeBody(pr) {
  return [
    `Hi @${authorOf(pr)}, this pull request has had no activity for ${NUDGE_AFTER_DAYS} days, and ${needsOf(pr)}.`,
    `Push an update or leave a comment to keep it open; otherwise it closes in ${CLOSE_AFTER_DAYS} days.`,
  ].join("\n");
}

function closeBody(pr) {
  return [
    `Closing this for now, @${authorOf(pr)}: it has had no activity for ${NUDGE_AFTER_DAYS + CLOSE_AFTER_DAYS} days, and ${needsOf(pr)}.`,
    "Thanks for the work! Once it is rebased or updated, comment here and it reopens, or open a new pull request.",
  ].join("\n");
}

function loadTeam(root = REPO_ROOT) {
  return fs.readFileSync(path.join(root, TEAM_LIST_PATH), "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ignoreStatus(...statuses) {
  return (error) => {
    if (!statuses.includes(error.status)) throw error;
    return null;
  };
}

function createSession({ github, context, core, team, now, pace }) {
  return {
    github,
    context,
    core,
    repo: { owner: context.repo.owner, repo: context.repo.repo },
    team: parseTeam(team === undefined ? loadTeam() : team),
    now: now || (() => Date.now()),
    pace: pace || (() => sleep(SWEEP_WRITE_INTERVAL_MS)),
    labelReady: null,
  };
}

function ensureLabel(session) {
  if (!session.labelReady) {
    session.labelReady = session.github.rest.issues
      .createLabel({ ...session.repo, ...STALE_LABEL_SPEC })
      .catch(ignoreStatus(422));
  }
  return session.labelReady;
}

function removeStale(session, number) {
  return session.github.rest.issues
    .removeLabel({ ...session.repo, issue_number: number, name: STALE })
    .catch(ignoreStatus(404));
}

async function act(session, pr, action) {
  const { github, repo } = session;
  const issue_number = pr.number;
  if (action === "nudge") {
    await ensureLabel(session);
    await github.rest.issues.createComment({ ...repo, issue_number, body: nudgeBody(pr) });
    await github.rest.issues.addLabels({ ...repo, issue_number, labels: [STALE] });
  } else if (action === "close") {
    await github.rest.issues.createComment({ ...repo, issue_number, body: closeBody(pr) });
    await github.rest.pulls.update({ ...repo, pull_number: issue_number, state: "closed" });
  } else if (action === "unstale") {
    await removeStale(session, issue_number);
  }
}

async function sweep(session, dryRun) {
  const { github, repo, core } = session;
  const now = session.now();
  const report = { nudge: [], close: [], unstale: [] };
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 });
  let wrote = false;
  for (const pr of pulls) {
    const marked = labelNames(pr).includes(STALE);
    if (!marked && !isEligible(pr, session.team)) continue;
    if (mayWaitWithoutTimeline(pr, now)) continue;
    const events = isEligible(pr, session.team)
      ? await github.paginate(github.rest.issues.listEventsForTimeline, { ...repo, issue_number: pr.number, per_page: 100 })
      : [];
    const { action } = decide({ pr, events, now, team: session.team });
    if (!report[action]) continue;
    report[action].push(pr.number);
    core.info(`${dryRun ? "Would" : "Will"} ${action} #${pr.number}`);
    if (dryRun) continue;
    if (wrote) await session.pace();
    wrote = true;
    await act(session, pr, action);
  }
  const lines = Object.entries(report).map(([action, numbers]) => `- ${action}: ${numbers.length ? numbers.map((n) => `#${n}`).join(", ") : "none"}`);
  if (core.summary) {
    await core.summary.addRaw(`## Stale pull requests${dryRun ? " (dry run)" : ""}\n\n${lines.join("\n")}\n`).write();
  }
  return report;
}

async function onPullUpdate(session) {
  const pr = session.context.payload.pull_request;
  if (!pr || pr.state !== "open" || isBot(session.context.payload.sender)) return null;
  if (!labelNames(pr).includes(STALE)) return null;
  await removeStale(session, pr.number);
  return "unstale";
}

async function onComment(session) {
  const { github, repo, core, context } = session;
  const { issue, comment } = context.payload;
  if (!issue || !issue.pull_request || !comment || isBot(comment.user)) return null;
  if (!labelNames(issue).includes(STALE)) return null;
  if (issue.state === "open") {
    await removeStale(session, issue.number);
    return "unstale";
  }
  if (issue.pull_request.merged_at) return null;
  if (!issue.user || String(comment.user.login).toLowerCase() !== String(issue.user.login).toLowerCase()) return null;
  const { data } = await github.rest.issues.get({ ...repo, issue_number: issue.number });
  if (!data.closed_by || data.closed_by.login !== WORKFLOW_BOT) return null;
  try {
    await github.rest.pulls.update({ ...repo, pull_number: issue.number, state: "open" });
  } catch (error) {
    if (error.status !== 422) throw error;
    core.warning(`#${issue.number} could not be reopened: ${error.message}`);
    await github.rest.issues.createComment({
      ...repo,
      issue_number: issue.number,
      body: `@${issue.user.login}, this pull request can't be reopened as it is (its branch may be gone). Please open a new pull request.`,
    });
    return "unreopenable";
  }
  await removeStale(session, issue.number);
  return "reopen";
}

async function run(args) {
  const session = createSession(args);
  const { context } = session;
  if (context.eventName === "pull_request_target") return onPullUpdate(session);
  if (context.eventName === "issue_comment") return onComment(session);
  const dryRun = context.eventName === "workflow_dispatch" && String((context.payload.inputs || {}).dry_run) === "true";
  return sweep(session, dryRun);
}

module.exports = {
  STALE,
  KEEP_LABELS,
  TARGET_LABELS,
  NUDGE_AFTER_DAYS,
  CLOSE_AFTER_DAYS,
  parseTeam,
  isEligible,
  isActivity,
  lastActivity,
  staleSince,
  decide,
  needsOf,
  nudgeBody,
  closeBody,
  run,
};
