import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");

function fileSection(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  if (start === -1) return "";
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch.slice(start, next === -1 ? patch.length : next);
}

const added = fileSection("React/Views/RCTView.m")
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");

function holdRule() {
  const start = added.indexOf("static bool ArdiaScrollHoldsHover(");
  assert.notEqual(start, -1, "RCTView.m has no ArdiaScrollHoldsHover rule");
  const end = added.indexOf("\n}\n", start);
  return added.slice(start, end + 3);
}

function compiled() {
  const dir = mkdtempSync(join(tmpdir(), "hover-hold-"));
  const cases = [
    [0.02, 0.08, 0, 1],
    [0.02, 0.08, 0.4, 1],
    [0.02, 0.08, 1, 1],
    [0.02, 0.08, 40, 1],
    [0.09, 0.08, 0, 1],
    [0.02, 0.08, 0, 0],
  ];
  const source = `#include <stdbool.h>\n#include <stdio.h>\n${holdRule()}\nint main(void) {\n${cases
    .map(([since, settle, moved, inside]) => `  printf("%d", ArdiaScrollHoldsHover(${since}, ${settle}, ${moved}, ${inside ? "true" : "false"}) ? 1 : 0);`)
    .join("\n")}\n  return 0;\n}\n`;
  try {
    writeFileSync(join(dir, "rule.c"), source);
    try {
      execFileSync("cc", ["-o", join(dir, "rule"), join(dir, "rule.c")], { stdio: "pipe" });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return execFileSync(join(dir, "rule")).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a scroll holds hover only for content moving under a pointer that stayed still", (t) => {
  const out = compiled();
  if (out === null) return t.skip("no C compiler");
  assert.equal(out[0], "1", "a still pointer over a list that just scrolled waits for the scroll to pause");
  assert.equal(out[1], "1", "a pointer that drifted less than a point is still");
  assert.equal(out[2], "0", "a pointer that moved a point updates at once");
  assert.equal(out[3], "0", "a pointer that moved across the row updates at once");
  assert.equal(out[4], "0", "nothing is held once the scroll has paused");
  assert.equal(out[5], "0", "a view outside the scrolled list is never held");
});

test("a scroll step that leaves the list where it was arms no hold", () => {
  const scrolled = added.slice(added.indexOf("+ (void)ardia_scrolled:"));
  assert.match(scrolled, /NSEqualPoints\(/, "ardia_scrolled no longer compares the clip view's origin with the last one it saw");
  const early = scrolled.indexOf("NSEqualPoints(");
  assert.ok(early < scrolled.indexOf("ArdiaHoverScrolledAt = now"), "the unchanged-origin check comes after the hold is armed");
});
