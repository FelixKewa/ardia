import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { collectCode, designatedRequirement, entitlementsFor, isMachO } from './signing-policy.mjs';

test('the scanner reads a sparse executable header and confines framework symlinks', () => {
  const work = mkdtempSync('/tmp/ardia-sign-scan-');
  try {
    const app = join(work, 'Ardia.app');
    mkdirSync(join(app, 'Contents/Frameworks/Test.framework/Versions/A'), { recursive: true });
    const file = join(app, 'Contents/Frameworks/Test.framework/Versions/A/Test');
    writeFileSync(file, Buffer.from('cffaedfe', 'hex'));
    truncateSync(file, 512 * 1024 * 1024);
    symlinkSync('A', join(app, 'Contents/Frameworks/Test.framework/Versions/Current'));
    assert.equal(isMachO(file), true);
    assert.deepEqual(collectCode(app).binaries, [file]);
    symlinkSync('/tmp', join(app, 'escape'));
    assert.throws(() => collectCode(app), /external symbolic link/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('sensitive grants stay on the main app and required Sparkle sandbox grants survive', () => {
  const app = '/stage/Ardia.app';
  const main = entitlementsFor(app, app);
  assert.equal(main['com.apple.security.device.camera'], true);
  assert.equal(main['com.apple.security.cs.allow-jit'], true);
  const renderer = entitlementsFor(app, `${app}/Contents/Frameworks/Chromium Framework.framework/Versions/1/Helpers/Ardia Helper (Renderer).app`);
  assert.equal(renderer['com.apple.security.cs.allow-jit'], true);
  assert.equal(renderer['com.apple.security.cs.disable-library-validation'], true);
  assert.equal(renderer['com.apple.security.device.camera'], undefined);
  for (const role of ['Renderer', 'GPU', 'Aperitif Renderer', 'Aperitif GPU']) {
    const helper = entitlementsFor(app, `${app}/Contents/Frameworks/Chromium Framework.framework/Versions/1/Helpers/Chromium Helper (${role}).app`);
    assert.equal(helper['com.apple.security.cs.allow-jit'], true, role);
    assert.equal(helper['com.apple.security.device.camera'], undefined, role);
  }
  const sparkle = entitlementsFor(app, `${app}/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc`, {
    'com.apple.security.app-sandbox': true, 'com.apple.security.network.client': true,
    'keychain-access-groups': ['UPSTREAM.group'], 'com.apple.developer.web-browser.public-key-credential': true,
    'com.apple.security.cs.disable-library-validation': true,
  });
  assert.deepEqual(sparkle, { 'com.apple.security.app-sandbox': true, 'com.apple.security.network.client': true });
  assert.deepEqual(entitlementsFor(app, `${app}/Contents/Frameworks/Sparkle.framework`), {});
});

test('codesign receives an inline designated requirement rather than a filename', { skip: process.platform !== 'darwin' }, () => {
  const work = mkdtempSync('/tmp/ardia-sign-requirement-');
  try {
    const executable = join(work, 'fixture');
    copyFileSync('/usr/bin/true', executable);
    const requirement = designatedRequirement('com.ardia.browser', 'a'.repeat(40));
    const signed = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.ardia.browser', '--requirements', '=' + requirement, executable], { encoding: 'utf8' });
    assert.equal(signed.status, 0, signed.stderr);
    assert.throws(() => designatedRequirement('bad"identifier', 'a'.repeat(40)), /Invalid/);
    assert.throws(() => designatedRequirement('com.ardia.browser', 'invalid'), /Invalid/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
