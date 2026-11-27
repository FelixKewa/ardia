import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const swiftc = process.env.SWIFTC || "swiftc";
const CHILD_TIMEOUT_MS = 180_000;
const runChild = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  assert.ok(!result.error, `${command} failed to finish within ${CHILD_TIMEOUT_MS / 1000} s: ${result.error?.message}`);
  return result;
};

test("the focus module watches held keys from its first key, and counts the ones it keeps from pages", () => {
  const focusHandoff = readFileSync(path("../ios/FocusHandoff.swift"), "utf8");
  assert.match(focusHandoff, /guard monitor == nil else \{ return \}\n\s+FieldKeyRepeats\.shared\.install \{ \[weak self\] in self\?\.countEditKeyAck\("heldKeysKeptFromPages"\) \}/);
});

test("a key held in a browser field never repeats into a page after the field is gone", (t) => {
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  if (process.platform !== "darwin" || probe.error || probe.status !== 0) return t.skip("swiftc for macOS is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-field-key-repeats-"));
  try {
    const binary = join(dir, "field-key-repeats-test");
    const built = runChild(swiftc, ["-parse-as-library", path("../ios/FieldKeyRepeats.swift"), path("./fieldKeyRepeats.test.swift"), "-o", binary]);
    assert.equal(built.status, 0, built.stderr);
    const ran = runChild(binary, []);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
