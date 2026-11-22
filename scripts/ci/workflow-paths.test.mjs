import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function listAfter(lines, start) {
  const indent = lines[start + 1].match(/^ */)[0];
  const items = [];
  for (let at = start + 1; at < lines.length && lines[at].startsWith(`${indent}- `); at++) {
    items.push(JSON.parse(lines[at].slice(indent.length + 2)));
  }
  return items;
}

function triggerPaths(text, event) {
  const lines = text.split("\n");
  const eventAt = lines.indexOf(`  ${event}:`);
  assert.ok(eventAt >= 0, `the workflow runs on ${event}`);
  const pathsAt = lines.findIndex((line, at) => at > eventAt && /^    paths:/.test(line));
  assert.ok(pathsAt > eventAt, `${event} has a paths filter`);
  return listAfter(lines, pathsAt);
}

function changeFilters(text) {
  const lines = text.split("\n");
  const blockAt = lines.findIndex((line) => /^ +filters: \|$/.test(line));
  assert.ok(blockAt >= 0, "the changes job has a paths-filter block");
  const nameIndent = lines[blockAt + 1].match(/^ */)[0];
  const filters = {};
  for (let at = blockAt + 1; at < lines.length && lines[at].startsWith(nameIndent); at++) {
    const name = lines[at].slice(nameIndent.length).match(/^([a-z-]+):$/);
    if (name) filters[name[1]] = listAfter(lines, at);
  }
  return filters;
}

const covers = (outer, inner) => outer === inner || (outer.endsWith("/**") && inner.startsWith(outer.slice(0, -2)));

function assertTriggersMatchFilters(triggers, filters, own) {
  const globs = Object.values(filters).flat();
  for (const glob of globs) {
    assert.ok(triggers.some((trigger) => covers(trigger, glob)), `a change to ${glob} starts the workflow`);
  }
  for (const trigger of triggers.filter((trigger) => trigger !== own)) {
    assert.ok(globs.some((glob) => covers(trigger, glob)), `${trigger} starts the workflow for a job that reads it`);
  }
  assert.equal(new Set(triggers).size, triggers.length, "no trigger path is listed twice");
}

test("Checks starts on the paths its jobs read, the same on pull requests and on main", () => {
  const text = workflow("checks.yml");
  const filters = changeFilters(text);
  assert.deepEqual(Object.keys(filters).sort(), ["browser", "code", "repo"]);
  assertTriggersMatchFilters(triggerPaths(text, "pull_request"), filters, ".github/workflows/checks.yml");
  assert.match(text, /^  push:\n    branches: \[main\]\n    paths: \*inputs$/m);
});

test("each Checks job runs when its filter matches, and every job runs when the filter can't tell", () => {
  const text = workflow("checks.yml");
  for (const name of ["code", "browser", "repo"]) {
    const fallback = `      ${name}: \${{ steps.filter.outcome != 'success' || steps.filter.outputs.${name} == 'true' }}`;
    assert.ok(text.includes(fallback), `${name} falls back to running`);
    assert.ok(text.includes(`    if: needs.changes.outputs.${name} == 'true'`), `a job waits on ${name}`);
  }
  assert.match(text, /- id: filter\n        continue-on-error: true\n/);
});

test("Deploy starts on main only for the paths one of its services deploys from", () => {
  const text = workflow("deploy.yml");
  assertTriggersMatchFilters(triggerPaths(text, "push"), changeFilters(text), ".github/workflows/deploy.yml");
});
