import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

test("shared extension approvals and all-website policy remain isolated and explicitly bounded", (t) => {
  runSwiftTests(t, "webkit-extension-policy", ["../ios/WebKitExtensionPackage.swift", "../ios/WebKitExtensionPreparation.swift",
    "../ios/WebKitExtensionPolicy.swift", "../ios/WebKitExtensionCatalog.swift", "./webkit-extension-policy.test.swift"]);
});
