const test = require("node:test");
const assert = require("node:assert/strict");
const stale = require("./stale.cjs");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const TEAM = "shivamhwp\nmantrakp04\n";

function ago(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function pr(number, login, { labels = [], association = "CONTRIBUTOR", created = ago(30), updated = ago(20), state = "open" } = {}) {
  return {
    number,
    state,
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    author_association: association,
    labels: labels.map((name) => ({ name })),
    base: { ref: "main" },
    created_at: created,
    updated_at: updated,
  };
}

const human = (login) => ({ login, type: "User" });
const bot = (login) => ({ login, type: "Bot" });
const commented = (days, actor) => ({ event: "commented", created_at: ago(days), actor, user: actor });
const labeled = (days, name, actor = bot("github-actions[bot]")) => ({ event: "labeled", created_at: ago(days), label: { name }, actor });
const unlabeled = (days, name, actor = bot("github-actions[bot]")) => ({ event: "unlabeled", created_at: ago(days), label: { name }, actor });
const committed = (days) => ({ event: "committed", committer: { date: ago(days) }, author: { date: ago(days) } });

function fakeGithub({ pulls = [], timelines = {}, issues = {}, reopenFails = false } = {}) {
  const calls = [];
  const record = (name, result = {}) => async (params) => {
    calls.push({ name, params });
    if (name === "pulls.update" && params.state === "open" && reopenFails) {
      throw Object.assign(new Error("branch gone"), { status: 422 });
    }
    return { data: result };
  };
  const github = {
    calls,
    paginate: async (method, params) => {
      calls.push({ name: method.endpointName, params });
      if (method.endpointName === "pulls.list") return pulls;
      return timelines[params.issue_number] || [];
    },
    rest: {
      pulls: {
        list: Object.assign(async () => ({ data: pulls }), { endpointName: "pulls.list" }),
        update: record("pulls.update"),
      },
      issues: {
        listEventsForTimeline: Object.assign(async () => ({ data: [] }), { endpointName: "issues.listEventsForTimeline" }),
        createLabel: record("issues.createLabel"),
        createComment: record("issues.createComment"),
        addLabels: record("issues.addLabels"),
        removeLabel: record("issues.removeLabel"),
        get: async (params) => {
          calls.push({ name: "issues.get", params });
          return { data: issues[params.issue_number] || {} };
        },
      },
    },
  };
  return github;
}

function fakeCore() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(line),
    warning: (line) => lines.push(`warning: ${line}`),
    summary: { addRaw(text) { lines.push(text); return this; }, write: async () => {} },
  };
}

function context(eventName, payload = {}) {
  return { eventName, payload, repo: { owner: "ardia-browser", repo: "ardia" } };
}

function writes(github) {
  return github.calls.filter((call) => !["pulls.list", "issues.listEventsForTimeline", "issues.get"].includes(call.name));
}

async function runWith(github, eventName, payload) {
  return stale.run({ github, context: context(eventName, payload), core: fakeCore(), team: TEAM, now: () => NOW, pace: async () => {} });
}

const team = stale.parseTeam(TEAM);

test("only outside pull requests with a target label and no keep label are eligible", () => {
  assert.equal(stale.isEligible(pr(1, "outsider", { labels: ["incomplete"] }), team), true);
  assert.equal(stale.isEligible(pr(2, "outsider", { labels: ["needs-rebase"] }), team), true);
  assert.equal(stale.isEligible(pr(3, "outsider", { labels: ["vouch:unvouched"] }), team), true);
  assert.equal(stale.isEligible(pr(4, "outsider", { labels: [] }), team), false);
  for (const keep of ["ready", "pinned", "keep-open", "vouch:trusted"]) {
    assert.equal(stale.isEligible(pr(5, "outsider", { labels: ["incomplete", keep] }), team), false, keep);
  }
  assert.equal(stale.isEligible(pr(6, "MantraKP04", { labels: ["incomplete"] }), team), false);
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(stale.isEligible(pr(7, "someone", { labels: ["incomplete"], association }), team), false, association);
  }
  assert.equal(stale.isEligible(pr(8, "dependabot[bot]", { labels: ["incomplete"] }), team), false);
  assert.equal(stale.isEligible(pr(9, "outsider", { labels: ["incomplete"], state: "closed" }), team), false);
});

test("bot comments and label changes are not activity; people, pushes and stale removals are", () => {
  const item = pr(1, "outsider", { created: ago(30) });
  assert.equal(stale.lastActivity(item, [commented(2, bot("coderabbitai[bot]")), labeled(1, "incomplete")]), NOW - 30 * DAY);
  assert.equal(stale.lastActivity(item, [commented(3, human("outsider"))]), NOW - 3 * DAY);
  assert.equal(stale.lastActivity(item, [committed(4)]), NOW - 4 * DAY);
  assert.equal(stale.lastActivity(item, [unlabeled(5, "stale")]), NOW - 5 * DAY);
  assert.equal(stale.lastActivity(item, [unlabeled(5, "incomplete", human("maintainer"))]), NOW - 30 * DAY);
});

test("a week of quiet nudges, another quiet week after the nudge closes, activity in between clears it", () => {
  const quiet = pr(1, "outsider", { labels: ["incomplete"] });
  assert.equal(stale.decide({ pr: quiet, events: [commented(8, human("outsider"))], now: NOW, team }).action, "nudge");
  assert.equal(stale.decide({ pr: quiet, events: [commented(6, human("outsider"))], now: NOW, team }).action, "wait");
  const marked = pr(2, "outsider", { labels: ["incomplete", "stale"] });
  assert.equal(stale.decide({ pr: marked, events: [commented(15, human("outsider")), labeled(8, "stale")], now: NOW, team }).action, "close");
  assert.equal(stale.decide({ pr: marked, events: [commented(15, human("outsider")), labeled(5, "stale")], now: NOW, team }).action, "wait");
  assert.equal(stale.decide({ pr: marked, events: [labeled(8, "stale"), commented(2, human("outsider"))], now: NOW, team }).action, "unstale");
  const nowReady = pr(3, "outsider", { labels: ["ready", "stale"] });
  assert.equal(stale.decide({ pr: nowReady, events: [], now: NOW, team }).action, "unstale");
});

test("the notes say what is missing in two lines", () => {
  const both = pr(1, "outsider", { labels: ["incomplete", "needs-rebase"] });
  const nudge = stale.nudgeBody(both);
  assert.equal(nudge.split("\n").length, 2);
  assert.match(nudge, /@outsider/);
  assert.match(nudge, /needs a rebase/);
  assert.match(nudge, /CONTRIBUTING\.md/);
  assert.match(nudge, /closes in 7 days/);
  const close = stale.closeBody(pr(2, "outsider", { labels: ["needs-rebase"] }));
  assert.equal(close.split("\n").length, 2);
  assert.match(close, /14 days/);
  assert.match(close, /comment here and it reopens/);
  assert.doesNotMatch(close, /CONTRIBUTING/);
  assert.match(stale.needsOf(pr(3, "outsider", { labels: ["vouch:unvouched"] })), /waiting on an update/);
});

function sweepFixture() {
  const pulls = [
    pr(1, "quiet", { labels: ["incomplete"] }),
    pr(2, "marked", { labels: ["needs-rebase", "stale"] }),
    pr(3, "fresh", { labels: ["incomplete"], updated: ago(1) }),
    pr(4, "mantrakp04", { labels: ["incomplete"] }),
    pr(5, "answered", { labels: ["incomplete", "stale"] }),
    pr(6, "kept", { labels: ["incomplete", "stale", "keep-open"] }),
  ];
  const timelines = {
    1: [commented(10, human("quiet"))],
    2: [commented(20, human("marked")), labeled(9, "stale")],
    5: [labeled(9, "stale"), commented(1, human("answered"))],
  };
  return fakeGithub({ pulls, timelines });
}

test("the sweep nudges, closes and clears, and skips fresh, team and kept pull requests", async () => {
  const github = sweepFixture();
  const report = await runWith(github, "schedule");
  assert.deepEqual(report, { nudge: [1], close: [2], unstale: [5, 6] });
  const timelineReads = github.calls.filter((call) => call.name === "issues.listEventsForTimeline").map((call) => call.params.issue_number);
  assert.deepEqual(timelineReads, [1, 2, 5]);
  assert.deepEqual(
    writes(github).map((call) => [call.name, call.params.issue_number || call.params.pull_number]),
    [
      ["issues.createLabel", undefined],
      ["issues.createComment", 1],
      ["issues.addLabels", 1],
      ["issues.createComment", 2],
      ["pulls.update", 2],
      ["issues.removeLabel", 5],
      ["issues.removeLabel", 6],
    ],
  );
  assert.equal(writes(github).find((call) => call.name === "pulls.update").params.state, "closed");
});

test("a dry-run dispatch writes nothing but reports the same plan", async () => {
  const github = sweepFixture();
  const report = await runWith(github, "workflow_dispatch", { inputs: { dry_run: "true" } });
  assert.deepEqual(report, { nudge: [1], close: [2], unstale: [5, 6] });
  assert.deepEqual(writes(github), []);
});

test("a push or edit by a person clears the label at once; a bot's does not", async () => {
  const github = fakeGithub();
  const pull = pr(1, "outsider", { labels: ["incomplete", "stale"] });
  assert.equal(await runWith(github, "pull_request_target", { pull_request: pull, sender: human("outsider") }), "unstale");
  assert.equal(await runWith(github, "pull_request_target", { pull_request: pull, sender: bot("github-actions[bot]") }), null);
  assert.deepEqual(writes(github).map((call) => call.name), ["issues.removeLabel"]);
});

function closedPull(number, login, merged_at = null) {
  return { ...pr(number, login, { labels: ["incomplete", "stale"], state: "closed" }), pull_request: { merged_at } };
}

test("a comment on an open stale pull request clears the label", async () => {
  const github = fakeGithub();
  const issue = { ...pr(1, "outsider", { labels: ["stale"] }), pull_request: {} };
  assert.equal(await runWith(github, "issue_comment", { issue, comment: { user: human("someone") } }), "unstale");
  assert.equal(await runWith(github, "issue_comment", { issue, comment: { user: bot("coderabbitai[bot]") } }), null);
  assert.deepEqual(writes(github).map((call) => call.name), ["issues.removeLabel"]);
});

test("the author's comment reopens a pull request the sweep closed, and only that", async () => {
  const github = fakeGithub({ issues: { 1: { closed_by: { login: "github-actions[bot]" } }, 2: { closed_by: { login: "mantrakp04" } } } });
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(1, "outsider"), comment: { user: human("Outsider") } }), "reopen");
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(1, "outsider"), comment: { user: human("bystander") } }), null);
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(2, "outsider"), comment: { user: human("outsider") } }), null);
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(3, "outsider", ago(1)), comment: { user: human("outsider") } }), null);
  assert.deepEqual(
    writes(github).map((call) => [call.name, call.params.state || call.params.name]),
    [["pulls.update", "open"], ["issues.removeLabel", "stale"]],
  );
});

test("a pull request that can't reopen gets one line asking for a new one", async () => {
  const github = fakeGithub({ issues: { 1: { closed_by: { login: "github-actions[bot]" } } }, reopenFails: true });
  assert.equal(await runWith(github, "issue_comment", { issue: closedPull(1, "outsider"), comment: { user: human("outsider") } }), "unreopenable");
  const comment = writes(github).find((call) => call.name === "issues.createComment");
  assert.match(comment.params.body, /open a new pull request/);
});
