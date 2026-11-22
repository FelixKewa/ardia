import assert from "node:assert/strict";
import { test } from "node:test";
import { dismissesToast, toastDragReturn, toastSemantics, toastSpokenLabel } from "./semantics.ts";

test("a toast with an action is a button; one without is an alert, never a button whose tap only hides it", () => {
  assert.deepEqual([toastSemantics("Open", "ios").pressable, toastSemantics("Open", "ios").role], [true, "button"]);
  assert.deepEqual([toastSemantics(null, "android").pressable, toastSemantics(null, "android").role], [false, "alert"]);
});

test("each phone announces a toast one way: iPhone through an announcement, Android through a live region", () => {
  assert.deepEqual([toastSemantics(null, "ios").announcement, toastSemantics(null, "ios").liveRegion], ["announceForAccessibility", "none"]);
  assert.deepEqual([toastSemantics("Open", "android").announcement, toastSemantics("Open", "android").liveRegion], ["liveRegion", "polite"]);
});

test("swipe-to-dismiss has a named screen reader action and the escape gesture, on every toast", () => {
  for (const actionable of ["Open", null]) {
    const { actions } = toastSemantics(actionable, "ios");
    assert.deepEqual(actions.map((action) => action.name), ["escape", "dismiss"]);
    assert.equal(actions[1]!.label, "Close");
  }
  assert.equal(dismissesToast("dismiss"), true);
  assert.equal(dismissesToast("escape"), true);
  assert.equal(dismissesToast("activate"), false);
});

test("with Reduce Motion a dragged toast snaps back instead of springing", () => {
  assert.equal(toastDragReturn(true), "snap");
  assert.equal(toastDragReturn(false), "spring");
});

test("an actionable toast is spoken with what its action does; one without an action is spoken as its message", () => {
  assert.equal(toastSpokenLabel("Downloaded otter.pdf", "Open"), "Downloaded otter.pdf, Open");
  assert.equal(toastSpokenLabel("Copied Link", null), "Copied Link");
});
