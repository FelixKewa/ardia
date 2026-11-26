import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPublishable, nextBuild, validatePlan, validateRelease, verifySignedFeed } from './release-policy.mjs';

const config = JSON.parse(readFileSync(new URL('./release-config.json', import.meta.url)));
const hash = letter => letter.repeat(40);
const plan = { schema: 1, repository: config.repository, controller: hash('a'), personal: hash('b'), upstream: hash('c'), candidate: hash('d'), feedHead: hash('e'), build: 1002, previous: { build: '1001' }, bundleSHA256: 'f'.repeat(64) };
const release = { schema: 1, tag: 'personal-1002', build: '1002', version: '0.3.0-nightly.1002', archive: 'Ardia-Personal-1002-arm64.zip', sha256: '1'.repeat(64), bytes: 123, source: plan.candidate, ...Object.fromEntries(['bundleIdentifier', 'certificateSHA256', 'updatePublicKey', 'feedURL'].map(key => [key, config[key]])) };
const proof = { schema: 1, archiveSHA256: release.sha256, source: release.source, previousBuild: '1001', installedBuild: '1002', installed: true, rejectedBadFeed: true, rejectedBadArchive: true, sameSigner: true, sentinelRetained: true };
const current = { personal: plan.personal, feedHead: plan.feedHead };

test('release numbers are monotonic and malformed provenance is refused', () => {
  assert.equal(nextBuild(['v0.3.0', 'personal-1000', 'personal-1008', 'personal-1009^{}']), 1009);
  assert.equal(validateRelease(release, config), release);
  assert.equal(validatePlan(plan), plan);
  for (const patch of [{ archive: '../app.zip' }, { tag: 'v1002' }, { bytes: -1 }, { source: '../HEAD' }, { feedURL: 'https://ardia.dev/appcast.xml' }, { certificateSHA256: '0'.repeat(64) }]) assert.throws(() => validateRelease({ ...release, ...patch }, config));
  assert.throws(() => validatePlan({ ...plan, repository: 'ardia-browser/ardia' }));
  assert.throws(() => validatePlan({ ...plan, build: 1000 }));
});

test('publication requires the frozen heads and this exact successful update proof', () => {
  assert.doesNotThrow(() => assertPublishable(plan, release, proof, current));
  for (const key of ['personal', 'feedHead']) assert.throws(() => assertPublishable(plan, release, proof, { ...current, [key]: hash('f') }), /branch moved/);
  for (const key of ['installed', 'rejectedBadFeed', 'rejectedBadArchive', 'sameSigner', 'sentinelRetained']) assert.throws(() => assertPublishable(plan, release, { ...proof, [key]: false }, current), /proof/);
  for (const patch of [{ source: hash('a') }, { archiveSHA256: '0'.repeat(64) }, { installedBuild: '1001' }, { previousBuild: '1000' }]) assert.throws(() => assertPublishable(plan, release, { ...proof, ...patch }, current), /proof/);
});

test('signed feeds verify exact UTF-8 bytes and reject wrong keys, tampering and unsigned data', () => {
  const keys = generateKeyPairSync('ed25519');
  const key = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const bytes = Buffer.from('<rss><channel><title>한국어 Personal</title></channel></rss>\n');
  const signature = sign(null, bytes, keys.privateKey).toString('base64');
  const feed = Buffer.concat([bytes, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${signature}\nlength: ${bytes.length}\n-->\n`)]);
  assert.match(verifySignedFeed(feed, key), /한국어/);
  const altered = Buffer.from(feed); altered[10] ^= 1;
  assert.throws(() => verifySignedFeed(altered, key), /invalid/);
  assert.throws(() => verifySignedFeed(feed, config.updatePublicKey), /invalid/);
  assert.throws(() => verifySignedFeed(bytes, key), /envelope/);
  assert.throws(() => verifySignedFeed(Buffer.from(feed.toString().replace(`length: ${bytes.length}`, 'length: 1')), key), /invalid/);
});

test('workflow keeps signing and publication on separate workers with immutable artifact selection', () => {
  const source = readFileSync(new URL('../../.github/workflows/personal-nightly.yml', import.meta.url), 'utf8');
  const jobs = Object.fromEntries([...source.matchAll(/^  (plan|build|sign|proof|publish):\n([\s\S]*?)(?=^  [a-z]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual(Object.keys(jobs), ['plan', 'build', 'sign', 'proof', 'publish']);
  for (const action of source.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  assert.match(jobs.plan, /github.repository == 'FelixKewa\/ardia'.*github.ref == 'refs\/heads\/main'/);
  assert.match(jobs.plan, /PERSONAL_NIGHTLY_ENABLED/);
  assert.match(jobs.sign, /environment: personal-signing/);
  assert.equal((jobs.sign.match(/secrets\./g) ?? []).length, 3);
  for (const name of ['plan', 'build', 'proof', 'publish']) assert.doesNotMatch(jobs[name], /secrets\.|environment: personal-signing/);
  for (const name of ['plan', 'build', 'sign', 'proof']) assert.doesNotMatch(jobs[name], /contents: write/);
  assert.match(jobs.publish, /contents: write/);
  assert.doesNotMatch(jobs.sign + jobs.publish, /materialize|check-candidate|webkit-smoke|npm |pnpm |uses: \.\//);
  assert.match(jobs.sign, /EXPECTED_SHA256/);
  assert.match(jobs.proof, /update-proof\.mjs/);
  assert.doesNotMatch(source, /pull_request_target|pull_request:|\n  push:|actions\/cache@/);
  for (const download of source.split(/- uses: actions\/download-artifact@/).slice(1)) assert.match(download.split(/\n      - /)[0], /artifact-ids:/);
});

test('bundle metadata replaces upstream release notes with the exact personal release', { skip: process.platform !== 'darwin' }, () => {
  const work = mkdtempSync('/tmp/ardia-personal-bundle-fixture-');
  try {
    const app = join(work, 'Ardia.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    const plist = join(app, 'Contents/Info.plist');
    writeFileSync(plist, JSON.stringify({ CFBundleIdentifier: config.bundleIdentifier, CFBundleVersion: '1001', CFBundleShortVersionString: '0.2.49-nightly.1001', ACReleaseNotesURL: 'https://ardia.dev/release-notes/' }));
    execFileSync('plutil', ['-convert', 'xml1', plist]);
    execFileSync(process.execPath, [fileURLToPath(new URL('./configure-bundle.mjs', import.meta.url)), app, '1002']);
    const actual = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    assert.equal(actual.ACReleaseNotesURL, 'https://github.com/FelixKewa/ardia/releases/tag/personal-1002');
    assert.equal(actual.CFBundleVersion, '1002');
    assert.equal(actual.CFBundleShortVersionString, '0.2.49-nightly.1002');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
