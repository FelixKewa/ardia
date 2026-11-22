import assert from "node:assert/strict";
import { test } from "node:test";
import { dismissesToast, toastDragReturn, toastSemantics } from "./semantics.ts";

test("a toast with an action is a button; one without is an alert, never a button whose tap only hides it", () => {
  assert.deepEqual([toastSemantics(true, "ios").pressable, toastSemantics(true, "ios").role], [true, "button"]);
  assert.deepEqual([toastSemantics(false, "android").pressable, toastSemantics(false, "android").role], [false, "alert"]);
});

test("each phone announces a toast one way: iPhone through an announcement, Android through a live region", () => {
  assert.deepEqual([toastSemantics(false, "ios").announcement, toastSemantics(false, "ios").liveRegion], ["announceForAccessibility", "none"]);
  assert.deepEqual([toastSemantics(true, "android").announcement, toastSemantics(true, "android").liveRegion], ["liveRegion", "polite"]);
});

test("swipe-to-dismiss has a named screen reader action and the escape gesture, on every toast", () => {
  for (const actionable of [true, false]) {
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
