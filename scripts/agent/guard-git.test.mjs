import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const guard = join(dirname(fileURLToPath(import.meta.url)), "guard-git");
const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-git-")));
const shared = join(root, "shared");
const worktree = join(root, "worktree");
const clone = join(root, "clone");

function git(directory, ...args) {
  execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
}

mkdirSync(shared);
git(shared, "init", "-q", "-b", "work");
git(shared, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
mkdirSync(join(shared, "apps"));
git(shared, "worktree", "add", "-q", "-b", "feature", worktree);
git(root, "clone", "-q", shared, clone);

test.after(() => rmSync(root, { recursive: true, force: true }));

function verdict(command, cwd = shared, project = shared) {
  const result = spawnSync("python3", [guard], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
  return result.status === 2 ? "blocked" : result.status === 0 ? "allowed" : `status ${result.status}: ${result.stderr}`;
}

test("destructive commands stay blocked in the shared checkout and its subfolders", () => {
  for (const command of [
    "git checkout -- README.md",
    "git switch main",
    "git restore README.md",
    "git stash",
    "git reset --hard HEAD",
    "git clean -fd",
    "echo hi && git switch main",
  ]) {
    assert.equal(verdict(command), "blocked", command);
    assert.equal(verdict(command, join(shared, "apps")), "blocked", command);
  }
});

test("safe forms pass in the shared checkout", () => {
  for (const command of ["git checkout -b topic", "git restore --staged README.md", "git status", "git show HEAD:README.md"]) {
    assert.equal(verdict(command), "allowed", command);
  }
});

test("a linked worktree and a separate clone may switch, reset, stash and clean", () => {
  for (const command of ["git switch main", "git checkout -- a.txt", "git reset --hard HEAD", "git stash", "git clean -fd", "git restore a.txt"]) {
    assert.equal(verdict(command, worktree), "allowed", `worktree: ${command}`);
    assert.equal(verdict(command, clone), "allowed", `clone: ${command}`);
  }
});

test("the directory a command moves to decides, by cd or git -C", () => {
  assert.equal(verdict(`cd ${worktree} && git switch main`), "allowed");
  assert.equal(verdict(`cd "${clone}" && git reset --hard HEAD`), "allowed");
  assert.equal(verdict(`git -C ${worktree} switch main`), "allowed");
  assert.equal(verdict(`git -C ${shared} switch main`, worktree), "blocked");
  assert.equal(verdict(`cd ${shared} && git stash`, clone), "blocked");
  assert.equal(verdict(`cd ${worktree} && cd ../shared && git clean -fd`, clone), "blocked");
  assert.equal(verdict(`cd ${worktree} && git switch main; cd ${shared} && git stash`), "blocked");
});

test("a fresh clone made in the same command may switch at once", () => {
  const fresh = join(root, "fresh");
  assert.equal(verdict(`git clone --depth 1 x ${fresh} && cd ${fresh} && git switch -c topic`), "allowed");
});

test("text that only mentions a command is judged by where it would run", () => {
  assert.equal(verdict(`cd ${clone} && python3 - <<'EOF'\nprint("git checkout -- <file>")\nEOF`), "allowed");
  assert.equal(verdict(`python3 - <<'EOF'\nprint("x")\ngit checkout -- file\nEOF`), "blocked");
});

test("a session started in a worktree still guards the shared checkout", () => {
  assert.equal(verdict("git switch main", worktree, worktree), "allowed");
  assert.equal(verdict("git switch main", shared, worktree), "blocked");
});

test("outside any repository nothing is blocked", () => {
  assert.equal(verdict("git stash", root), "allowed");
});
