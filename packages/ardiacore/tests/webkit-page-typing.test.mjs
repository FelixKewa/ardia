import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const CHILD_TIMEOUT_MS = 180_000;
const runChild = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  assert.ok(!result.error, `${command} failed to finish within ${CHILD_TIMEOUT_MS / 1000} s: ${result.error?.message}`);
  return result;
};

test("every WebKit page view installs the guard that keeps browser typing", () => {
  assert.match(readFileSync(path("../ios/WebKitWebView.swift"), "utf8"), /super\.init\(frame: frame, configuration: configuration\)\n\s+ArdiaKeepTypingFromPage\(self\)/);
});

test("a WebKit page that focuses itself can't take the keyboard from a browser field being typed in", (t) => {
  const probe = spawnSync("clang++", ["--version"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  if (process.platform !== "darwin" || probe.error || probe.status !== 0) return t.skip("clang++ for macOS is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-page-typing-"));
  try {
    const binary = join(dir, "page-typing-test");
    const built = runChild("clang++", ["-std=c++20", "-fobjc-arc", "-Wall", "-Werror", "-framework", "AppKit", "-framework", "WebKit", "-I", path("../ios"), path("../ios/ArdiaPageTypingGuard.mm"), path("./webkit-page-typing.test.mm"), "-o", binary]);
    assert.equal(built.status, 0, built.stderr);
    const ran = runChild(binary, []);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
