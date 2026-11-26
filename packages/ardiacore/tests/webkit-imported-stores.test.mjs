import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("imported WebKit stores retain identity only for the installed imported profile", (t) => {
  runSwiftTests(t, "webkit-imported-stores", ["../ios/WebKitImportedStores.swift", "./webkit-imported-stores.test.swift"]);
});
