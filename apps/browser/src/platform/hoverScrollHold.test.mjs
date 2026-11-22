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

test("a long hold is counted in the consent period it began in, taken under one lock, and never while sharing is off", () => {
  const note = method("+ (void)ardia_noteHoverHeld");
  assert.ok(note.indexOf("@synchronized") < note.indexOf("ArdiaHoverHeldSince = CACurrentMediaTime()"), "the hold's start and its epoch are set under the same lock");
  assert.match(note, /ArdiaHoverHeldEpoch = ArdiaHoverConsentEpoch/);
  assert.match(method("+ (void)ardia_endHoverHold"), /ardia_countHover:@"holds" epoch:epoch/);
  assert.match(method("+ (void)ardia_countHover:(NSString *)kind epoch:(NSString *)epoch"), /if \(epoch\.length == 0\) \{\n    return;/);
});

test("AppKit tracking stays on the view's bounds, and a waiting enter never rebuilds a tracking area", () => {
  assert.doesNotMatch(added, /NSTrackingInVisibleRect/, "a view's visibleRect runs past its bounds when it doesn't clip (macOS 14+), so a visible-rect area entered views far from the pointer");
  assert.doesNotMatch(added, /NSTrackingMouseMoved/);
  assert.doesNotMatch(method("- (void)ardia_waitForEnter"), /ardia_rearmTrackingArea/);
});

const installed = new URL("../../../../node_modules/react-native-macos/React/Views/RCTView.m", import.meta.url);

const REPLAYED = [
  "+ (void)ardia_scrolled:(NSView *)moved",
  "+ (NSPoint)ardia_pointerOnScreen",
  "+ (BOOL)ardia_holdsHoverInScrolled:(BOOL)inScrolled",
  "+ (void)ardia_hoverDecidedAt:(NSPoint)screen",
  "+ (NSArray<RCTView *> *)ardia_byDepth:(NSArray<RCTView *> *)views deepestFirst:(BOOL)deepestFirst",
  "+ (void)ardia_setConsentEpoch:(NSString *)epoch",
  "+ (void)ardia_noteHoverHeld",
  "+ (void)ardia_endHoverHold",
  "+ (NSString *)ardia_consentEpoch",
  "+ (void)ardia_countHover:(NSString *)kind epoch:(NSString *)epoch",
  "+ (NSDictionary<NSString *, NSDictionary<NSString *, NSNumber *> *> *)ardia_takeHoverCounts",
  "+ (void)ardia_checkHover",
  "- (void)ardia_setMouseOver:(BOOL)over atScreenPoint:(NSPoint)screen",
  "- (void)updateTrackingAreas",
  "- (BOOL)ardia_holdHoverForScroll",
  "- (NSTrackingAreaOptions)ardia_trackingOptions",
  "- (void)ardia_rearmTrackingArea",
  "- (void)ardia_rideScrollIfInside",
  "- (void)ardia_waitForEnter",
  "- (void)ardia_stopWaiting",
  "+ (void)ardia_retryWaitingEnters",
  "- (void)ardia_enterAt:(NSPoint)screen",
  "- (void)ardia_windowChanged",
  "- (void)mouseEntered:(NSEvent *)event",
  "- (void)mouseExited:(NSEvent *)event",
];

const PRELUDE = String.raw`#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
static CFTimeInterval now = 10;
static NSPoint pointer;
#define CACurrentMediaTime replayTime
static CFTimeInterval replayTime(void) { return now; }
static id moveHandler;
static int monitors;
@interface ReplayEvent : NSEvent
+ (id)addLocalMonitorForEventsMatchingMask:(NSEventMask)mask handler:(id)handler;
@end
@implementation ReplayEvent
+ (NSPoint)mouseLocation { return pointer; }
+ (NSUInteger)pressedMouseButtons { return 0; }
+ (NSEventModifierFlags)modifierFlags { return 0; }
+ (id)addLocalMonitorForEventsMatchingMask:(NSEventMask)mask handler:(id)handler { moveHandler = handler; monitors++; return @"watch"; }
+ (void)removeMonitor:(id)monitor { moveHandler = nil; monitors--; }
@end
#define NSEvent ReplayEvent
typedef void (^RCTDirectEventBlock)(NSDictionary *);
@interface RCTView : NSView {
@public
  BOOL _hasMouseOver;
  BOOL _ardiaEnterWaiting;
  BOOL _ardiaClipCounted;
  NSTrackingArea *_trackingArea;
}
@property (copy) RCTDirectEventBlock onMouseEnter;
@property (copy) RCTDirectEventBlock onMouseLeave;
@property (assign) BOOL inside;
@property (assign) BOOL detached;
@end
@interface ReplayWindow : NSObject
@end
@implementation ReplayWindow
- (NSPoint)convertPointFromScreen:(NSPoint)point { return point; }
- (NSPoint)convertPointToScreen:(NSPoint)point { return point; }
- (BOOL)isVisible { return NO; }
- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector { return [NSMethodSignature signatureWithObjCTypes:"@@:"]; }
- (void)forwardInvocation:(NSInvocation *)invocation { id nothing = nil; [invocation setReturnValue:&nothing]; }
@end
static NSWindow *replayWindow;
static NSHashTable *ArdiaHoverViews;
static NSHashTable *ArdiaClippingViews;
static __weak NSView *ArdiaHoverScrolled;
static BOOL ArdiaHoverRidesScroll, ArdiaHoverSettling, ArdiaHoverHeld;
static const CFTimeInterval ArdiaHoverScrollSettle = 0.08;
`;

const STUBS = String.raw`
@implementation RCTView
- (NSWindow *)window { return self.detached ? nil : replayWindow; }
+ (NSWindow *)ardia_windowUnderPointer:(NSPoint)screen { return replayWindow; }
+ (BOOL)ardia_pointer:(NSPoint)screen isInside:(RCTView *)view { return view.window != nil && view.inside; }
+ (void)ardia_markHoverDirty {}
- (void)ardia_clipSubviewsHiding:(BOOL)hiding {}
- (NSDictionary *)locationInfoFromDraggingLocation:(NSPoint)location { return nil; }
- (NSDictionary *)locationInfoFromEvent:(NSEvent *)event { return nil; }
- (void)sendMouseEventWithBlock:(RCTDirectEventBlock)block locationInfo:(NSDictionary *)info modifierFlags:(NSEventModifierFlags)flags additionalData:(NSDictionary *)data
{
  if (block) block(info);
}
`;

const SCENARIOS = String.raw`
static void step(NSView *clip, int x) { now += 0.016; clip.boundsOrigin = NSMakePoint(x, 0); [RCTView ardia_scrolled:clip]; }
int main(void) {
  @autoreleasepool {
    ArdiaHoverViews = [NSHashTable weakObjectsHashTable];
    NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 400)];
    NSView *clip = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 200)];
    RCTView *row = [[RCTView alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)];
    RCTView *tool = [[RCTView alloc] initWithFrame:NSMakeRect(250, 0, 50, 50)];
    [root addSubview:clip]; [clip addSubview:row]; [root addSubview:tool];
    replayWindow = (NSWindow *)[ReplayWindow new];
    [ArdiaHoverViews addObject:row]; [ArdiaHoverViews addObject:tool];
    __block int rowIn = 0, rowOut = 0, toolIn = 0;
    row.onMouseEnter = ^(NSDictionary *i) { rowIn++; };
    row.onMouseLeave = ^(NSDictionary *i) { rowOut++; };
    tool.onMouseEnter = ^(NSDictionary *i) { toolIn++; };
    tool.onMouseLeave = ^(NSDictionary *i) {};
    [row updateTrackingAreas]; [tool updateTrackingAreas];
    pointer = NSMakePoint(100, 100);
    [RCTView ardia_checkHover];

    [RCTView ardia_scrolled:clip];
    step(clip, 1);
    pointer = NSMakePoint(130, 100);
    row.inside = YES;
    [row mouseEntered:nil];
    [RCTView ardia_checkHover];
    int enteredDuringCoast = rowIn;
    for (int x = 2; x < 80; x++) {
      row.inside = NO;
      step(clip, x);
      if (x == 2) [row mouseExited:nil];
      [RCTView ardia_checkHover];
    }
    printf("momentum %d %d %d\n", enteredDuringCoast, rowOut, row->_hasMouseOver);

    now += 1;
    [RCTView ardia_checkHover];
    [RCTView ardia_scrolled:clip];
    int toolBefore = toolIn;
    for (int x = 81; x < 95; x++) {
      step(clip, x);
      if (x == 85) tool.inside = YES;
      [RCTView ardia_checkHover];
    }
    printf("outside %d\n", toolIn - toolBefore);

    now += 1;
    tool.inside = NO;
    [RCTView ardia_checkHover];
    [RCTView ardia_scrolled:clip];
    int rebuilt = 0, rowInBefore = rowIn;
    for (int x = 100; x < 150; x++) {
      step(clip, x);
      row.inside = YES;
      NSTrackingArea *before = row->_trackingArea;
      [row mouseEntered:nil];
      if (row->_trackingArea != before) rebuilt++;
      row.inside = NO;
      before = row->_trackingArea;
      [row mouseExited:nil];
      if (row->_trackingArea != before) rebuilt++;
    }
    printf("churn %d %d\n", rebuilt, rowIn - rowInBefore);

    now += 1;
    [RCTView ardia_checkHover];
    [RCTView ardia_scrolled:clip];
    step(clip, 200);
    row.inside = YES;
    rowInBefore = rowIn;
    [row mouseEntered:nil];
    int heldEnter = rowIn - rowInBefore;
    pointer = NSMakePoint(140, 100);
    if (moveHandler) ((id (^)(id))moveHandler)(nil);
    printf("waiting %d %d %d %d\n", heldEnter, rowIn - rowInBefore, row->_ardiaEnterWaiting, monitors);

    now += 1;
    row.inside = NO;
    [RCTView ardia_checkHover];
    [RCTView ardia_scrolled:clip];
    step(clip, 210);
    row.inside = YES;
    [row mouseEntered:nil];
    RCTDirectEventBlock enter = row.onMouseEnter, leave = row.onMouseLeave;
    row.onMouseEnter = nil; row.onMouseLeave = nil;
    [row updateTrackingAreas];
    row.onMouseEnter = enter; row.onMouseLeave = leave;
    [row updateTrackingAreas];
    printf("handlers %d %d\n", row->_ardiaEnterWaiting, (int)((row->_trackingArea.options & NSTrackingAssumeInside) != 0));

    now += 1;
    [RCTView ardia_checkHover];
    row.inside = YES;
    [row mouseEntered:nil];
    int outBefore = rowOut;
    row.detached = YES;
    [row ardia_windowChanged];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    printf("detach %d %d\n", row->_hasMouseOver, rowOut - outBefore);

    [RCTView ardia_takeHoverCounts];
    [RCTView ardia_setConsentEpoch:@""];
    [RCTView ardia_noteHoverHeld];
    now += 0.5;
    [RCTView ardia_endHoverHold];
    [RCTView ardia_countHover:@"clipped" epoch:[RCTView ardia_consentEpoch]];
    printf("sharingoff %lu\n", (unsigned long)[RCTView ardia_takeHoverCounts].count);
  }
  return 0;
}
`;

function replayed() {
  const source = readFileSync(installed, "utf8");
  const region = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const body = (signature) => {
    const start = source.indexOf(`${signature}\n{`);
    assert.notEqual(start, -1, `RCTView.m has no ${signature}`);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };
  return PRELUDE + region("typedef struct {\n  double scrolledAt;", "// [Ardia: removeClippedSubviews hides") + STUBS + REPLAYED.map(body).join("\n") + "\n@end\n" + SCENARIOS;
}

let replay;
function replayRun(t) {
  if (process.platform !== "darwin") return t.skip("AppKit replay runs on macOS"), null;
  if (replay !== undefined) return replay;
  const dir = mkdtempSync(join(tmpdir(), "hover-replay-"));
  try {
    writeFileSync(join(dir, "replay.m"), replayed());
    execFileSync("clang", ["-fobjc-arc", "-w", "-framework", "AppKit", "-framework", "QuartzCore", "-o", join(dir, "replay"), join(dir, "replay.m")], { stdio: "pipe" });
    let out;
    try {
      out = execFileSync(join(dir, "replay"), { stdio: "pipe" }).toString();
    } catch (error) {
      throw new Error(`the replay stopped: ${error.stdout}${error.stderr}`);
    }
    replay = Object.fromEntries(out.trim().split("\n").map((line) => { const [name, ...values] = line.split(" "); return [name, values.map(Number)]; }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return replay;
}

test("a row entered while a list coasts under a still pointer is left as soon as it scrolls away, not when the coast ends", (t) => {
  const r = replayRun(t);
  if (!r) return;
  const [entered, left, hovered] = r.momentum;
  assert.equal(entered, 1);
  assert.equal(left, 1, "the scroll's leave scan turns back on when a row in the list is entered");
  assert.equal(hovered, 0);
});

test("hover outside the scrolling list never waits on the scroll", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.equal(r.outside[0], 1, "a toolbar view that moves under a still pointer while the list coasts is entered at once");
});

test("enters and leaves a scroll holds rebuild no tracking area and deliver nothing", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.churn, [0, 0]);
});

test("a held enter waits on the app's mouse moves and lands on the first move once nothing holds hover", (t) => {
  const r = replayRun(t);
  if (!r) return;
  const [heldEnter, entered, stillWaiting, watches] = r.waiting;
  assert.equal(heldEnter, 0);
  assert.equal(entered, 1);
  assert.equal(stillWaiting, 0);
  assert.equal(watches, 0, "the move watch goes once nothing waits");
});

test("removing a view's hover handlers ends a deferred enter, and a view that leaves the window gets the leave it is owed", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.handlers, [0, 0], "no waiting enter or assumed-inside area survives losing both handlers");
  assert.deepEqual(r.detach, [0, 1]);
});

test("nothing is counted while sharing is off", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.equal(r.sharingoff[0], 0);
});
