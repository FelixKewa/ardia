import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftTests } from "./swift-testing.mjs";

test("extension snapshots and origin grants reject changed packages and unsafe boundaries, and saved approvals restore", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ardia-webkit-extension-home-"));
  try {
    runSwiftTests(t, "webkit-extension-package",
      ["../ios/WebKitExtensionPackage.swift", "../ios/WebKitExtensionHost.swift", "./webkit-extension-package.test.swift", "./webkit-extension-restore.test.swift"],
      { env: { HOME: home, CFFIXED_USER_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a dismissed extension popup opens again on the next click", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ardia-webkit-extension-popup-home-"));
  try {
    runSwiftTests(t, "webkit-extension-popup",
      ["../ios/WebKitExtensionPackage.swift", "../ios/WebKitExtensionHost.swift", "../ios/WebKitExtensionDelegate.swift", "../ios/WebKitExtensionTabs.swift", "./webkit-extension-popup.test.swift"],
      { env: { HOME: home, CFFIXED_USER_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
