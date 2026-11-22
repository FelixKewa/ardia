import assert from "node:assert/strict";
import { test } from "node:test";
import { listRowLayout, listRowTitleLines } from "./listSheetTokens.ts";

test("a native list row's title takes one line at normal sizes and up to three from the large-text threshold, for Spaces, Archive and the Library alike", () => {
  assert.equal(listRowTitleLines(1), 1);
  assert.equal(listRowTitleLines(listRowLayout.largeTextScale - 0.01), 1);
  assert.equal(listRowTitleLines(listRowLayout.largeTextScale), 3);
  assert.equal(listRowTitleLines(3), 3);
});
