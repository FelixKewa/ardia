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

const lines = fileSection("React/Views/RCTView.m").split("\n");
const added = lines
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");
const patched = lines
  .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
  .map((line) => line.slice(1))
  .join("\n");

const method = (signature) => {
  const start = patched.indexOf(signature);
  assert.notEqual(start, -1, `RCTView.m no longer has ${signature}`);
  return patched.slice(start, patched.indexOf("\n}\n", start) + 3);
};

function holdRule() {
  const start = added.indexOf("typedef struct {\n  double scrolledAt;");
  assert.notEqual(start, -1, "RCTView.m has no ArdiaHoverHold state");
  const holds = added.indexOf("static bool ArdiaHoverHolds(", start);
  return added.slice(start, added.indexOf("\n}\n", holds) + 3);
}

const SETTLE = 0.08;
const STEP = 0.016;

function run(steps) {
  const dir = mkdtempSync(join(tmpdir(), "hover-hold-"));
  const body = steps
    .map(([kind, ...args]) => {
      if (kind === "scroll") return `  hold.scrolledAt = ${args[0]};`;
      if (kind === "decided") return `  ArdiaHoverHoldDecided(&hold, ${args[0]}, ${args[1]});`;
      return `  printf("%d", ArdiaHoverHolds(&hold, ${args[0]}, ${SETTLE}, ${args[1]}, ${args[2]}, ${args[3] ?? true}) ? 1 : 0);`;
    })
    .join("\n");
  const source = `#include <stdbool.h>\n#include <stdio.h>\n${holdRule()}\nint main(void) {\n  ArdiaHoverHold hold = {0};\n${body}\n  return 0;\n}\n`;
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

test("a still pointer over a list that just scrolled waits, and nothing waits once the scroll pauses or outside the list", (t) => {
  const out = run([
    ["scroll", 10],
    ["decided", 100, 100],
    ["scroll", 10 + STEP],
    ["holds", 10 + STEP + 0.005, 100, 100],
    ["holds", 10 + STEP + 0.005, 100.4, 100],
    ["holds", 10 + STEP + SETTLE + 0.001, 100, 100],
    ["holds", 10 + STEP + 0.005, 100, 100, false],
  ]);
  if (out === null) return t.skip("no C compiler");
  assert.equal(out, "1100");
});

test("a scroll step that lands between a pointer move and its enter can't swallow the move", (t) => {
  const out = run([
    ["scroll", 10],
    ["decided", 100, 100],
    ["scroll", 10 + STEP],
    ["scroll", 10 + 2 * STEP],
    ["holds", 10 + 2 * STEP + 0.001, 130, 100],
  ]);
  if (out === null) return t.skip("no C compiler");
  assert.equal(out, "0", "the enter after the step is measured from where hover was last decided, not from the step");
});

test("slow motion adds up across scroll steps until it lets hover through", (t) => {
  const steps = [["scroll", 10], ["decided", 100, 100]];
  for (let i = 1; i <= 4; i++) steps.push(["scroll", 10 + i * STEP], ["holds", 10 + i * STEP + 0.001, 100 + 0.4 * i, 100]);
  const out = run(steps);
  if (out === null) return t.skip("no C compiler");
  assert.equal(out, "1100", "0.4 pt a step is held twice, then the 1.2 pt it has added up to updates hover");
});

test("a scroll step never moves the anchor hover is measured from, and a step that leaves the list where it was arms nothing", () => {
  const scrolled = method("+ (void)ardia_scrolled:(NSView *)moved");
  assert.doesNotMatch(scrolled, /ardia_hoverDecidedAt|ArdiaHoverHoldDecided|anchorX|anchorY/);
  const equal = scrolled.indexOf("NSEqualPoints(");
  assert.ok(equal !== -1 && equal < scrolled.indexOf("ArdiaHoverHoldState.scrolledAt = now"), "the unchanged-origin check must return before the hold is armed");
});

test("only a full hover check moves the anchor, so every event of one pointer move is measured from the same place", () => {
  assert.match(method("+ (void)ardia_checkHover"), /ardia_hoverDecidedAt:screen/);
  const decides = [...patched.matchAll(/ardia_hoverDecidedAt:/g)].length;
  assert.equal(decides, 2, "ardia_hoverDecidedAt is defined once and called only from ardia_checkHover");
  assert.doesNotMatch(method("- (BOOL)ardia_holdHoverForScroll"), /ardia_hoverDecidedAt/);
});

test("a long hold is counted in the consent period it began in", () => {
  assert.match(method("+ (void)ardia_noteHoverHeld"), /ArdiaHoverHeldEpoch = ArdiaHoverConsentEpoch/);
  assert.match(method("+ (void)ardia_endHoverHold"), /ardia_countHover:@"holds" epoch:ArdiaHoverHeldEpoch/);
});

test("an enter a scroll holds or that comes over a clipped part waits for the pointer to reach the shown part, and only an entered view is left", () => {
  const enter = method("- (void)ardia_enterWith:(NSEvent *)event");
  assert.ok(enter.indexOf("ardia_shows:event") < enter.indexOf("_hasMouseOver = YES"), "the shown part is checked before the view counts as entered");
  assert.match(method("- (NSTrackingAreaOptions)ardia_trackingOptions"), /_ardiaEnterWaiting \? NSTrackingMouseMoved/);
  assert.match(method("- (void)mouseEntered:(NSEvent *)event"), /ardia_holdHoverForScroll\]\) \{ \/\/ \[Ardia\]\n    \[self ardia_waitForEnter\];/, "an enter a scroll holds keeps waiting for the pointer's moves, so moving onto the shown part later still enters");
  assert.match(method("- (void)mouseMoved:(NSEvent *)event"), /ardia_enterWith:event/);
  assert.match(added, /if \(!_hasMouseOver\) \{ \/\/ \[Ardia\]\n    return;/);
  assert.doesNotMatch(added, /NSTrackingInVisibleRect/, "a view's visibleRect runs past its bounds when it doesn't clip (macOS 14+), so a visible-rect area entered views far from the pointer");
});
