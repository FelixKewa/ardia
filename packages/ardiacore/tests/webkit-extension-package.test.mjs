import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftTests } from "./swift-testing.mjs";

test("extension snapshots and origin grants reject changed packages and unsafe boundaries, and saved approvals restore", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ardia-webkit-extension-home-"));
  try {
    runSwiftTests(t, "webkit-extension-package",
      ["../ios/WebKitExtensionPackage.swift", "../ios/WebKitExtensionHost.swift", "../ios/WebKitExtensionKeepAlive.swift", "./webkit-extension-package.test.swift", "./webkit-extension-restore.test.swift"],
      { env: { HOME: home, CFFIXED_USER_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const runAgainstWebKit = (t, name) => {
  const home = mkdtempSync(join(tmpdir(), `ardia-${name}-home-`));
  try {
    runSwiftTests(t, name,
      ["../ios/WebKitExtensionPackage.swift", "../ios/WebKitExtensionHost.swift", "../ios/WebKitExtensionDelegate.swift", "../ios/WebKitExtensionTabs.swift", "../ios/WebKitExtensionKeepAlive.swift", "./webkit-extension-host-stubs.swift", `./${name}.test.swift`],
      { env: { HOME: home, CFFIXED_USER_HOME: home } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("a dismissed extension popup opens again on the next click", (t) => runAgainstWebKit(t, "webkit-extension-popup"));

test("open pages recover when an extension is loaded again", (t) => runAgainstWebKit(t, "webkit-extension-reload"));

test("a background stays awake only while a page runs the extension, so slow requests are answered", (t) => runAgainstWebKit(t, "webkit-extension-keepalive"));
