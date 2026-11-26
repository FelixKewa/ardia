import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { designatedRequirement } from './signing-policy.mjs';
import { proofPort, sha256, validateRelease, verifySignedFeed } from './release-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [oldArgument, signedArgument, resultArgument] = process.argv.slice(2);
if (!oldArgument || !signedArgument || !resultArgument || !process.env.SPARKLE_FRAMEWORK_ROOT) throw new Error('Usage: SPARKLE_FRAMEWORK_ROOT=<verified Sparkle directory> node update-proof.mjs <old Ardia.app> <signed candidate directory> <proof.json>');
if (spawnSync('pgrep', ['-x', 'Ardia'], { stdio: 'ignore' }).status !== 1) throw new Error('Close existing Ardia instances before running the isolated update proof.');
for (const domain of [`user/${process.getuid()}`, `gui/${process.getuid()}`, 'system']) {
  for (const label of ['com.ardia.browser-sparkle-updater', 'com.ardia.browser-sparkle-progress']) {
    const probe = spawnSync('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
    if (probe.status === 0) throw new Error('An existing Ardia update helper is registered. Finish or retire that update before the isolated proof.');
    if (!/Could not find (service|domain)|could not find (service|domain)/.test(probe.stderr ?? '')) throw new Error('Could not safely check for an existing Ardia update helper.');
  }
}
const old = realpathSync(oldArgument), signed = realpathSync(signedArgument);
const config = JSON.parse(readFileSync(join(root, 'scripts/personal/release-config.json'), 'utf8'));
const release = validateRelease(JSON.parse(readFileSync(join(signed, 'release.json'), 'utf8')), config);
const archive = join(signed, 'updates', release.archive);
assert.equal(await sha256(archive), release.sha256);
verifySignedFeed(readFileSync(join(signed, 'updates/appcast.xml')), config.updatePublicKey);
const run = (tool, args, options = {}) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const info = app => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]));
const verifyApp = app => {
  const value = info(app);
  for (const [key, expected] of Object.entries({ CFBundleIdentifier: config.bundleIdentifier, ACPersonalBuild: true, ACPersonalSigningCertificateSHA256: config.certificateSHA256, SUPublicEDKey: config.updatePublicKey, SUFeedURL: config.feedURL })) assert.equal(value[key], expected, key);
  run('codesign', ['--verify', '--deep', '--strict', '-R', '=' + designatedRequirement(config.bundleIdentifier, config.certificateSHA1).replace('designated => ', ''), app]);
  return value;
};
const before = verifyApp(old);
assert.ok(Number(before.CFBundleVersion) < Number(release.build), 'The proof must start with an older personal build.');
mkdirSync(dirname(resolve(resultArgument)), { recursive: true });
const requests = new Map();
const work = realpathSync(mkdtempSync('/tmp/ardia-personal-update-proof-'));
const server = createServer((request, response) => {
  const path = new URL(request.url, `http://127.0.0.1:${proofPort}`).pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  const feeds = new Set(['/appcast.xml', '/bad-feed.xml', '/bad-archive.xml']);
  const file = feeds.has(path) ? join(signed, 'proof', basename(path)) : path === `/${release.tag}/${release.archive}` ? archive : null;
  if (!file) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Length': statSync(file).size, 'Content-Type': file.endsWith('.xml') ? 'application/xml' : 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(proofPort, '127.0.0.1', done); });
  const installed = join(work, 'Ardia.app');
  run('cp', ['-cR', old, installed]);
  const sentinel = join(work, 'profile-sentinel.json');
  writeFileSync(sentinel, JSON.stringify({ tabs: ['https://example.invalid/fixture'], extensionData: 'synthetic-preserved' }));
  const sentinelHash = await sha256(sentinel);
  const host = join(work, 'sparkle-host');
  run('xcrun', ['swiftc', '-O', join(root, 'scripts/personal/update-proof-host.swift'), '-F', process.env.SPARKLE_FRAMEWORK_ROOT,
    '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', process.env.SPARKLE_FRAMEWORK_ROOT, '-o', host]);
  const { spawn } = await import('node:child_process');
  const attempt = async (name, expected) => {
    requests.clear();
    const home = join(work, name);
    mkdirSync(home);
    const env = { ...process.env, CFFIXED_USER_HOME: home, ARDIA_UPDATE_PROOF_HOME: home };
    for (const key of Object.keys(env)) if (key.startsWith('ARDIA_') && key !== 'ARDIA_UPDATE_PROOF_HOME') delete env[key];
    let log = '';
    const child = spawn(host, [installed, `http://127.0.0.1:${proofPort}/${name}.xml`, expected, config.channel], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = bytes => { if (log.length < 1024 * 1024) log += bytes.toString(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 270000);
    const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }).finally(() => clearTimeout(timeout));
    writeFileSync(join(dirname(resolve(resultArgument)), `${name}.log`), log);
    assert.equal(status, 0, log);
    assert.ok(requests.get(`/${name}.xml`) > 0, 'The requested proof feed was actually read.');
    const archiveRequests = requests.get(`/${release.tag}/${release.archive}`) ?? 0;
    if (name === 'bad-feed') assert.equal(archiveRequests, 0, 'Invalid feed must stop before archive download.');
    else assert.ok(archiveRequests > 0, 'The signed archive path was exercised.');
    if (expected === 'reject') {
      assert.match(log, /REJECTED invalid update signature/);
      assert.equal(info(installed).CFBundleVersion, before.CFBundleVersion);
    }
  };
  await attempt('bad-feed', 'reject');
  await attempt('bad-archive', 'reject');
  await attempt('appcast', release.version);
  const after = verifyApp(installed);
  assert.equal(after.CFBundleVersion, release.build);
  assert.equal(await sha256(sentinel), sentinelHash);
  const proof = { schema: 1, archiveSHA256: release.sha256, source: release.source, previousBuild: before.CFBundleVersion,
    installedBuild: after.CFBundleVersion, installed: true, rejectedBadFeed: true, rejectedBadArchive: true, sameSigner: true, sentinelRetained: true };
  writeFileSync(resultArgument, JSON.stringify(proof, null, 2) + '\n');
  console.log(`PASS actual Sparkle update ${before.CFBundleVersion} -> ${after.CFBundleVersion}; invalid feed and archive rejected.`);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
