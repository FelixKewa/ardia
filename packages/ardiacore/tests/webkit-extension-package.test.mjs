import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("extension snapshots and origin grants reject changed packages and unsafe boundaries", (t) => {
  runSwiftTests(t, "webkit-extension-package", ["../ios/WebKitExtensionPackage.swift", "../ios/WebKitExtensionPreparation.swift", "./webkit-extension-package.test.swift"]);
});
