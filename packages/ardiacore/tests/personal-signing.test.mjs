import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("personal signature policy rejects unsigned identities and every installed-profile scratch alias", { skip: process.platform !== "darwin" }, () => {
  const scratch = mkdtempSync("/tmp/ardia-personal-signing-");
  try {
    const binary = join(scratch, "policy");
    const compiled = spawnSync("xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Werror", "-framework", "Foundation", "-framework", "Security",
      "packages/ardiacore/ios/ArdiaLaunchConfig.mm", "packages/ardiacore/ios/ArdiaPersonalSigning.mm", "packages/ardiacore/tests/personal-signing.test.mm", "-o", binary], { cwd: root, encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const checked = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const pin = "a".repeat(64);
    assert.equal(spawnSync(binary, ["verify", binary, pin]).status, 1);
    assert.equal(spawnSync(binary, ["verify", "/usr/bin/true", pin]).status, 1);
    const identity = process.env.ARDIA_PERSONAL_TEST_SIGN_IDENTITY;
    const keychain = process.env.ARDIA_PERSONAL_TEST_SIGN_KEYCHAIN;
    const publicPin = process.env.ARDIA_PERSONAL_TEST_SIGN_PIN;
    if (identity && keychain && publicPin) {
      const fixture = (name, bundleIdentifier = "com.ardia.browser", leafPin = publicPin, signer = identity) => {
        const app = join(scratch, `${name}.app`);
        const executable = join(app, "Contents/MacOS/Policy");
        mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
        mkdirSync(join(app, "Contents/Resources"), { recursive: true });
        copyFileSync(binary, executable);
        writeFileSync(join(app, "Contents/Resources/marker.txt"), "original");
        writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleExecutable</key><string>Policy</string><key>CFBundlePackageType</key><string>APPL</string><key>ACPersonalBuild</key><true/><key>ACPersonalSigningCertificateSHA256</key><string>${leafPin}</string></dict></plist>`);
        const signed = spawnSync("codesign", ["--force", "--timestamp=none", "--keychain", keychain, "--sign", signer, app], { encoding: "utf8" });
        assert.equal(signed.status, 0, signed.stderr);
        return { app, executable };
      };
      const good = fixture("valid");
      assert.equal(spawnSync(binary, ["verify", good.app, publicPin]).status, 0);
      const normal = { ...process.env };
      delete normal.ARDIA_DATA_DIR;
      assert.equal(spawnSync(good.executable, ["uninitialized"], { env: normal }).status, 3);
      assert.equal(spawnSync(good.executable, ["current"], { env: normal }).status, 1);
      assert.equal(spawnSync(good.executable, ["current"], { env: { ...normal, ARDIA_DATA_DIR: join(scratch, "isolated") } }).status, 2);
      assert.equal(spawnSync(binary, ["verify", good.app, pin]).status, 1);
      const other = fixture("wrong-identifier", "com.example.other");
      assert.equal(spawnSync(binary, ["verify", other.app, publicPin]).status, 1);
      const wrongPin = fixture("wrong-pin", "com.ardia.browser", pin);
      assert.equal(spawnSync(wrongPin.executable, ["current"], { env: normal }).status, 3);
      const adhoc = fixture("adhoc", "com.ardia.browser", publicPin, "-");
      assert.equal(spawnSync(binary, ["verify", adhoc.app, publicPin]).status, 1);
      assert.equal(spawnSync(adhoc.executable, ["current"], { env: normal }).status, 3);
      writeFileSync(join(good.app, "Contents/Resources/marker.txt"), "changed after signing");
      assert.equal(spawnSync(binary, ["verify", good.app, publicPin]).status, 1);
      assert.equal(spawnSync(good.executable, ["current"], { env: normal }).status, 3);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("personal launch authorization precedes all migration and shell handoff work", () => {
  const main = readFileSync(join(root, "apps/browser/macos/Ardia-macOS/main.swift"), "utf8");
  const guard = main.indexOf("guard ArdiaHost.authorizePersonalLaunch(protectingLegacyBundle: LegacyName.bundleId) else");
  assert.ok(guard >= 0);
  for (const call of ["ArdiaHost.markMainStarted()", "WebUIShellLaunch.routeIfRequested(config)", "LegacyMigration.moveToNewName()", "LegacyMigration.runAtLaunch", "ArdiaHost.run("]) {
    assert.ok(main.indexOf(call) > guard, `${call} must follow authorization`);
  }
  assert.match(main.slice(guard, main.indexOf("ArdiaHost.markMainStarted()")), /exit\(78\)/);
});
