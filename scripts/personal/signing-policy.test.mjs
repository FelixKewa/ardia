import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectCode, describeFailure, designatedRequirement, diagnosticLineLimit, diagnosticPrefix, entitlementsFor, formatDiagnostic, forwardedDiagnostics, isMachO, matchingIdentities, parseDiagnostic, PolicyFailure, runSigningTool, ToolFailure } from './signing-policy.mjs';

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
    rmSync(join(app, 'escape'));
    symlinkSync('removed', join(app, 'dangling'));
    assert.throws(() => collectCode(app), error => error.reason === 'unresolved-symlink' && error.subject === join(app, 'dangling'));
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

const hidden = 'hunter2-private-signing-value';
const line = value => diagnosticPrefix + JSON.stringify(value);
const diagnostics = text => text.split('\n').filter(entry => entry.startsWith(diagnosticPrefix)).map(entry => JSON.parse(entry.slice(diagnosticPrefix.length)));

test('tool errors become allowlisted reasons and keep no tool output', () => {
  const app = '/stage/Ardia.app';
  const classify = (stderr, extra = {}) => new ToolFailure('/usr/bin/codesign', { status: 1, stderr, ...extra }, { app });
  const cases = {
    'errsec-internal-component': 'x: errSecInternalComponent',
    'certificate-chain-incomplete': 'Warning: unable to build chain to self-signed root for signer "x"\nx: errSecInternalComponent',
    'identity-not-found': 'abc: no identity found',
    'identity-ambiguous': 'abc: ambiguous (matches "one" and "two")',
    'detritus-not-allowed': 'x: resource fork, Finder information, or similar detritus not allowed',
    'unsigned-code-object': 'x: code object is not signed at all',
    'sealed-resource-invalid': 'x: a sealed resource is missing or invalid',
    'nested-code-invalid': 'x: nested code is modified or invalid',
    'unsealed-contents': 'x: unsealed contents present in the bundle root',
    'bundle-format-unrecognized': 'x: bundle format unrecognized, invalid, or unsuitable',
    'bundle-format-ambiguous': 'x: bundle format is ambiguous (could be app or framework)',
    'sparkle-signer-mismatch': "Error generating appcast from directory\nCode signature of new version doesn't match the old version.",
    'sparkle-key-unreadable': 'Unable to load EdDSA private key from /private/key',
    'sparkle-signature-rejected': 'Error: failed to pass signing verification.',
    'no-such-file': 'ditto: /nowhere: No such file or directory',
  };
  for (const [reason, stderr] of Object.entries(cases)) {
    const failure = classify(`${hidden}\n${stderr}\n`);
    assert.equal(failure.reason, reason, stderr);
    assert.equal(failure.stderrBytes, undefined);
    assert.doesNotMatch(JSON.stringify({ ...failure, message: failure.message, stack: failure.stack }), /hunter2/);
  }
  const sparkle = (tool, stdout) => new ToolFailure(`/tools/${tool}`, { status: 1, stderr: '', stdout }, { app }).reason;
  assert.equal(sparkle('sign_update', 'Error: failed to extract signature from appcast. Is the appcast signed?'), 'sparkle-signature-rejected');
  assert.equal(sparkle('sign_update', `ERROR! Failed to decode base64 encoded key data from: ${hidden}`), 'sparkle-key-unreadable');
  assert.equal(sparkle('generate_appcast', "Error: Private key not decoded from the argument because it isn't base64 encoded."), 'sparkle-key-unreadable');
  assert.equal(sparkle('generate_appcast', `Could not unarchive ${hidden}`), 'sparkle-extraction-failed');
  assert.equal(sparkle('codesign', 'errSecInternalComponent'), 'unclassified');
  const unknown = classify(`${hidden}\n`);
  assert.equal(unknown.reason, 'unclassified');
  assert.equal(unknown.stderrBytes, Buffer.byteLength(`${hidden}\n`));
  assert.equal(classify('', { status: null, code: 'ENOENT' }).reason, 'ENOENT');
  assert.equal(classify('', { status: null, signal: 'SIGKILL' }).signal, 9);
  assert.equal(classify(`${app}: nested code is modified or invalid\nIn subcomponent: ${app}/Contents/Frameworks/Test.framework\n`).subcomponent, 'Contents/Frameworks/Test.framework');
  assert.equal(classify(`file modified: ${app}/Contents/Resources/a.txt\n`).subcomponent, 'Contents/Resources/a.txt');
  assert.equal(classify(`${app}/Contents/MacOS/Ardia: code object is not signed at all\n`).subcomponent, 'Contents/MacOS/Ardia');
  assert.equal(classify('In subcomponent: /Users/runner/private/key\n').subcomponent, undefined);
  assert.throws(() => runSigningTool('/nonexistent/codesign', [hidden]), error => error.reason === 'ENOENT' && !String(error.stack).includes(hidden));
});

test('unexpected and policy errors describe a stage without free text', () => {
  const app = '/stage/Ardia.app';
  const missing = Object.assign(new Error(hidden), { code: 'ENOENT', path: `${app}/Contents/Missing` });
  assert.equal(formatDiagnostic(describeFailure('code-scan', missing, { app, path: app })), line({ stage: 'code-scan', path: '.', subcomponent: 'Contents/Missing', reason: 'ENOENT' }));
  const outside = Object.assign(new Error(hidden), { code: 'ENOENT', path: '/Users/runner/keys/password' });
  assert.equal(formatDiagnostic(describeFailure('signing-material', outside, { app })), line({ stage: 'signing-material', reason: 'ENOENT' }));
  assert.equal(formatDiagnostic(describeFailure('plist-read', new SyntaxError(hidden), { app })), line({ stage: 'plist-read', reason: 'invalid-json' }));
  assert.equal(formatDiagnostic(describeFailure('provenance', new Error(hidden))), line({ stage: 'provenance', reason: 'unclassified' }));
  assert.equal(formatDiagnostic(describeFailure('cert-pin', new PolicyFailure('certificate-pin-mismatch', hidden))), line({ stage: 'cert-pin', reason: 'certificate-pin-mismatch' }));
});

test('only well formed diagnostic lines are accepted', () => {
  const good = { stage: 'codesign-sign', tool: 'codesign', status: 1, path: 'Contents/Frameworks/Chromium Framework.framework/Helpers/Chromium Helper (GPU).app', reason: 'errsec-internal-component' };
  assert.deepEqual(parseDiagnostic(line(good)), good);
  for (const patch of [
    { stage: hidden }, { reason: hidden }, { tool: '/usr/bin/codesign' }, { tool: hidden }, { status: '1' }, { status: 1.5 }, { signal: 'SIGKILL' }, { detail: hidden },
    { path: '/Users/runner/work' }, { path: '../outside' }, { path: 'Contents/../../outside' }, { path: 'Contents/a=b' }, { path: 'a'.repeat(241) }, { subcomponent: 'line\nbreak' }, { stderrBytes: -1 },
    { path: '::add-mask::x' }, { subcomponent: '##[group]x' }, { matches: 1 },
    { stage: undefined }, { reason: undefined },
  ]) assert.equal(parseDiagnostic(line({ ...good, ...patch })), null, JSON.stringify(patch));
  for (const text of [
    `${diagnosticPrefix}{`, `${diagnosticPrefix}[]`, `${diagnosticPrefix}null`, ` ${line(good)}`, hidden, `::add-mask::${hidden}`, `##[error]${hidden}`, `${line(good)}::add-mask::${hidden}`, `##[group]${line(good)}`,
    `${diagnosticPrefix}{"stage":"child","reason":"unclassified","__proto__":{}}`, line(good) + ' '.repeat(diagnosticLineLimit),
  ]) assert.equal(parseDiagnostic(text), null, text.slice(0, 80));
});

test('the pinned identity is counted from paired identities, trusted or not', () => {
  const pin = 'ab'.repeat(20);
  const listing = ['Policy: Code Signing', '  Matching identities', `  1) ${pin.toUpperCase()} "${hidden}" (CSSMERR_TP_NOT_TRUSTED)`, `  2) ${'CD'.repeat(20)} "other"`, '     2 identities found',
    '  Valid identities only', `  1) ${pin.toUpperCase()} "${hidden}"`, '     1 valid identities found', ''].join('\n');
  assert.equal(matchingIdentities(listing, pin), 1);
  assert.equal(matchingIdentities(listing, 'ef'.repeat(20)), 0);
  assert.equal(matchingIdentities('     0 valid identities found\n', pin), 0);
  assert.equal(matchingIdentities(`  Matching identities\n     0 identities found\n  Valid identities only\n  1) ${pin.toUpperCase()} "x"\n`, pin), 0);
});

test('forwarded paths stay inside the app even through symbolic links', () => {
  const work = mkdtempSync('/tmp/ardia-sign-members-');
  try {
    const app = join(work, 'Ardia.app'), outside = join(work, 'outside');
    mkdirSync(join(app, 'Contents/Versions/A'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(app, 'Contents/Versions/A/file'), 'fixture');
    writeFileSync(join(outside, 'private'), 'fixture');
    symlinkSync('A', join(app, 'Contents/Versions/Current'));
    symlinkSync(outside, join(app, 'Contents/escape'));
    symlinkSync('removed', join(app, 'Contents/dangling'));
    const kept = name => 'subcomponent' in diagnostics(forwardedDiagnostics(line({ stage: 'code-scan', reason: 'unclassified', subcomponent: name }), app).join('\n'))[0];
    for (const name of ['.', 'Contents', 'Contents/Versions/A/file', 'Contents/Versions/Current/file', 'Contents/dangling', 'Contents/escape']) assert.equal(kept(name), true, name);
    for (const name of ['Contents/escape/private', 'Contents/escape/missing', 'Contents/missing', 'Contents/dangling/file']) assert.equal(kept(name), false, name);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

function signerHarness(work) {
  const repository = join(work, 'repository/scripts/personal'), tools = join(work, 'tools'), candidate = join(work, 'candidate'), app = join(candidate, 'Ardia.app');
  for (const folder of [repository, tools, join(app, 'Contents/MacOS'), join(app, 'Contents/Resources'), join(work, 'home')]) mkdirSync(folder, { recursive: true });
  for (const name of ['ci-sign.mjs', 'sign-personal.mjs', 'signing-policy.mjs', 'proof-feeds.mjs', 'release-policy.mjs']) copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(repository, name));
  const keys = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const base64 = value => Buffer.from(value, 'base64url').toString('base64');
  const certificate = 'throwaway certificate bytes';
  const config = JSON.parse(readFileSync(new URL('./release-config.json', import.meta.url), 'utf8'));
  Object.assign(config, { certificateSHA256: createHash('sha256').update(certificate).digest('hex'), certificateSHA1: createHash('sha1').update(certificate).digest('hex'), updatePublicKey: base64(keys.x) });
  writeFileSync(join(repository, 'release-config.json'), JSON.stringify(config));
  writeFileSync(join(app, 'Contents/MacOS/Ardia'), Buffer.from('cffaedfe', 'hex'));
  writeFileSync(join(app, 'Contents/Resources/nested.txt'), 'fixture');
  writeFileSync(join(app, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: config.bundleIdentifier, CFBundleVersion: '1002', CFBundleShortVersionString: '0.0.0', ACPersonalBuild: true,
    ACPersonalSigningCertificateSHA256: config.certificateSHA256, SUFeedURL: config.feedURL, SUPublicEDKey: config.updatePublicKey, SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true,
    SUSignedFeedFailureExpirationInterval: 0, SUDefaultsDomain: 'com.ardia.browser.personal.updates', ACUpdateChannel: config.channel }));
  writeFileSync(join(candidate, 'source-commit.txt'), 'a'.repeat(40));
  writeFileSync(join(candidate, 'engine.json'), 'match=exact fixture');
  const secrets = {
    PERSONAL_CERTIFICATE_P12: Buffer.from('throwaway private certificate container '.repeat(4)).toString('base64'),
    PERSONAL_CERTIFICATE_PASSWORD: hidden,
    PERSONAL_SPARKLE_SEED: base64(keys.d),
  };
  const noise = [hidden, ...Object.values(secrets), join(work, 'private-signing/sparkle.key'), '/Users/runner/work/_temp/private-signing/password',
    line({ stage: 'codesign-sign', reason: 'unclassified', path: 'Contents/Resources/nested.txt' })].join('\n') + '\n';
  const restricted = { ...secrets, GH_TOKEN: 'ghp-throwaway-token', GITHUB_TOKEN: 'ghs-throwaway-token' };
  const calls = join(work, 'security-calls'), searchList = join(work, 'search-list'), originalList = [join(work, 'home/login.keychain-db')];
  const listedOnly = `if (args.includes('--sign') && !JSON.parse(fs.readFileSync(${JSON.stringify(searchList)})).includes(args[args.indexOf('--keychain') + 1])) fail(args[args.indexOf('--sign') + 1] + ': no identity found');`;
  const tool = (name, body = '') => {
    const file = join(tools, name);
    const scrubbed = name === 'security' || name === 'openssl' ? '' : `if (${JSON.stringify(Object.keys(restricted))}.some(key => key in process.env)) process.exit(99);`;
    writeFileSync(file, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst fail = text => { process.stderr.write(${JSON.stringify(noise)} + text + '\\n'); process.exit(1); };\n${scrubbed}\n${name === 'codesign' ? listedOnly : ''}\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const listing = `  Matching identities\n  1) ${config.certificateSHA1.toUpperCase()} "${hidden}" (CSSMERR_TP_NOT_TRUSTED)\n  Valid identities only\n`;
  const security = (failure = '') => tool('security', `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
${failure}
if (args[0] === 'list-keychains') {
  if (args[3] === '-s') fs.writeFileSync(${JSON.stringify(searchList)}, JSON.stringify(args.slice(4)));
  else process.stdout.write(JSON.parse(fs.readFileSync(${JSON.stringify(searchList)})).map(entry => '    "' + entry + '"\\n').join(''));
}
if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), '');
if (args[0] === 'find-identity') process.stdout.write(${JSON.stringify(listing)} + args.at(-1));`);
  security();
  tool('openssl', `fs.writeFileSync(args[args.indexOf('-out') + 1], ${JSON.stringify(certificate)});`);
  tool('plutil', `process.stdout.write(args.includes('xml1') ? '<plist/>' : fs.readFileSync(args.at(-1)));`);
  tool('codesign');
  tool('ditto', `fs.writeFileSync(args.at(-1), 'archive');`);
  const signFeed = `const crypto = require('node:crypto');
const signFeed = (file, seedFile) => {
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(fs.readFileSync(seedFile, 'utf8').trim(), 'base64')]), format: 'der', type: 'pkcs8' });
  const body = fs.readFileSync(file, 'utf8').split('<!-- sparkle-signatures:')[0];
  fs.writeFileSync(file, body + '<!-- sparkle-signatures:\\nedSignature: ' + crypto.sign(null, Buffer.from(body), key).toString('base64') + '\\nlength: ' + Buffer.byteLength(body) + '\\n-->\\n');
};`;
  tool('generate_appcast', `${signFeed}
const feed = args[args.indexOf('-o') + 1];
fs.writeFileSync(feed, '<rss><enclosure url="' + args[args.indexOf('--download-url-prefix') + 1] + 'a.zip" sparkle:edSignature="x"/></rss>\\n');
signFeed(feed, args[args.indexOf('--ed-key-file') + 1]);`);
  const signUpdate = (failure = '') => tool('sign_update', `${signFeed}\n${failure}\nif (!args.includes('--verify')) signFeed(args.at(-1), args[args.indexOf('--ed-key-file') + 1]);`);
  signUpdate();
  let runs = 0;
  const sign = () => {
    runs += 1;
    for (const name of ['updates', 'proof']) rmSync(join(candidate, name), { recursive: true, force: true });
    rmSync(calls, { force: true });
    writeFileSync(searchList, JSON.stringify(originalList));
    const keyDirectory = join(work, `private-signing-${runs}`);
    const result = spawnSync(process.execPath, [join(repository, 'ci-sign.mjs'), candidate, keyDirectory], { encoding: 'utf8', timeout: 60000,
      env: { PATH: tools, HOME: join(work, 'home'), SPARKLE_BIN: tools, ...restricted } });
    const output = result.stdout + result.stderr;
    const used = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(entry => JSON.parse(entry)) : [];
    const passwords = used.flatMap(args => args.filter((_, index) => ['-p', '-P'].includes(args[index - 1]) || (args[0] === 'set-key-partition-list' && args[index - 1] === '-k')));
    for (const value of [...noise.split('\n').slice(0, -2), ...Object.values(restricted), ...passwords.filter(entry => entry !== 'codesigning'), 'throwaway', work, realpathSync(work)]) {
      assert.ok(!output.includes(value), `leaked ${value.slice(0, 24)}`);
    }
    if (used.length) assert.deepEqual(used.at(-1), ['list-keychains', '-d', 'user', '-s', ...originalList], 'the original search list is restored last, without the temporary keychain');
    assert.deepEqual(JSON.parse(readFileSync(searchList, 'utf8')), originalList);
    const listed = used.filter(args => args[0] === 'list-keychains' && args[3] === '-s').slice(0, -1);
    for (const args of listed) assert.deepEqual(args.slice(4), [join(keyDirectory, 'signing.keychain-db'), ...originalList]);
    if (used.some(args => args[0] === 'create-keychain')) {
      assert.ok(used.some(args => args[0] === 'delete-keychain'), 'the temporary keychain is deleted');
      assert.ok(passwords.some(value => value.length === 43), 'the keychain password was observed');
    }
    assert.equal(existsSync(keyDirectory), false);
    const reported = diagnostics(result.stderr);
    return { status: result.status, stderr: result.stderr, calls: used, identity: reported.filter(entry => entry.stage === 'identity-check'), reported: reported.filter(entry => entry.stage !== 'identity-check') };
  };
  return { repository, app: realpathSync(app), candidate, tool, security, signUpdate, sign, secrets, restricted, searchList, config };
}

test('the CI signer reports the failing stage from both processes without secrets or paths', () => {
  const work = mkdtempSync('/tmp/ardia-sign-diagnostics-');
  try {
    const harness = signerHarness(work);
    const passed = harness.sign();
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stderr, line({ stage: 'identity-check', matches: 1 }) + '\n');
    assert.deepEqual(passed.calls.map(args => args[0]), ['list-keychains', 'create-keychain', 'set-keychain-settings', 'unlock-keychain', 'import', 'set-key-partition-list', 'find-identity', 'list-keychains', 'unlock-keychain', 'delete-keychain', 'list-keychains']);
    assert.equal(passed.calls[7].length, 6, 'the child runs with the temporary keychain in the search list');
    const childFailed = { stage: 'child', tool: 'node', status: 1, reason: 'child-reported' };

    harness.tool('codesign', `if (args.includes('--sign')) fail(args.at(-1) + ': replacing existing signature\\n' + args.at(-1) + ': errSecInternalComponent\\nIn subcomponent: ${harness.app}/Contents/Resources/nested.txt');`);
    const refused = harness.sign();
    assert.equal(refused.status, 1);
    assert.deepEqual(refused.reported, [{ stage: 'codesign-sign', tool: 'codesign', status: 1, path: 'Contents/MacOS/Ardia', subcomponent: 'Contents/Resources/nested.txt', reason: 'errsec-internal-component' }, childFailed]);

    harness.tool('codesign', `if (args.includes('-d')) fail('something nobody has classified');`);
    const [unknown] = harness.sign().reported;
    assert.deepEqual({ ...unknown, stderrBytes: unknown.stderrBytes > 0 }, { stage: 'entitlements-read', tool: 'codesign', status: 1, path: 'Contents/MacOS/Ardia', reason: 'unclassified', stderrBytes: true });

    harness.tool('codesign', `if (args.includes('--verify')) fail('${harness.app}: a sealed resource is missing or invalid');`);
    assert.deepEqual(harness.sign().reported[0], { stage: 'codesign-verify', tool: 'codesign', status: 1, path: '.', reason: 'sealed-resource-invalid' });
    harness.tool('codesign');

    harness.signUpdate(`if (args.at(-1).endsWith('bad-archive.xml')) { process.stdout.write('Error: failed to parse XML data: ' + args.at(-1)); process.exit(1); }`);
    assert.deepEqual(harness.sign().reported[0], { stage: 'proof-feeds', tool: 'sign_update', status: 1, reason: 'sparkle-feed-unparseable' });
    harness.signUpdate();

    harness.security(`if (args[0] === 'find-identity') fail('security: errSecInternalComponent');`);
    const uncounted = harness.sign();
    assert.equal(uncounted.status, 0, uncounted.stderr);
    assert.deepEqual(uncounted.identity, [{ stage: 'identity-check', tool: 'security', status: 1, reason: 'errsec-internal-component' }]);

    for (const [command, stage] of [['create-keychain', 'keychain-create'], ['set-key-partition-list', 'partition-list']]) {
      harness.security(`if (args[0] === '${command}') { fs.writeFileSync(args.at(-1), ''); fail('security: unexpected'); }`);
      assert.equal(harness.sign().reported[0].stage, stage);
    }

    harness.security(`if (args[0] === 'import') fail('security: SecKeychainItemImport: The user name or passphrase you entered is not correct.');`);
    assert.deepEqual(harness.sign().reported, [{ stage: 'import', tool: 'security', status: 1, reason: 'keychain-passphrase-rejected' }]);

    harness.security(`if (args[0] === 'delete-keychain') fail('x');`);
    const cleanup = harness.sign();
    assert.equal(cleanup.status, 1);
    assert.deepEqual(cleanup.reported.map(entry => entry.stage), ['cleanup']);
    harness.security();

    harness.tool('openssl', `fs.writeFileSync(args[args.indexOf('-out') + 1], 'another certificate');`);
    assert.deepEqual(harness.sign().reported, [{ stage: 'cert-pin', reason: 'certificate-pin-mismatch' }]);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('the CI signer drops everything from its child except valid diagnostics', () => {
  const work = mkdtempSync('/tmp/ardia-sign-forward-');
  try {
    const harness = signerHarness(work);
    const valid = { stage: 'archive', tool: 'ditto', status: 1, path: 'Contents/Resources/nested.txt', reason: 'no-space-left' };
    const smuggled = { stage: 'archive', reason: 'unclassified', path: harness.secrets.PERSONAL_SPARKLE_SEED.replace(/[=+/]/g, 'a'), subcomponent: 'Contents/MacOS/Ardia' };
    const lines = [
      hidden, ...Object.values(harness.secrets), join(work, 'private'), `::add-mask::${hidden}`, `##[error]${hidden}`, `${diagnosticPrefix}::add-mask::${hidden}`, line(valid), `${diagnosticPrefix}{"stage":`, line({ ...valid, detail: hidden }),
      line({ ...valid, reason: hidden }), line({ ...valid, path: join(work, 'private') }), line({ ...valid, path: '##[group]' }), line(valid) + ' '.repeat(diagnosticLineLimit), `prefix ${line(valid)}`, line(smuggled),
    ];
    const child = (output, status) => writeFileSync(join(harness.repository, 'sign-personal.mjs'), `import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (${JSON.stringify(Object.keys(harness.restricted))}.some(key => key in process.env)) process.exit(99);\nif (!JSON.parse(readFileSync(${JSON.stringify(harness.searchList)})).includes(join(process.argv[3], 'signing.keychain-db'))) process.exit(98);\nprocess.stderr.write(${JSON.stringify(output)});\nprocess.exitCode = ${status};\n`);
    child(lines.join('\n') + '\n', 3);
    const result = harness.sign();
    assert.equal(result.status, 1);
    assert.deepEqual(result.reported, [valid, { stage: 'archive', subcomponent: 'Contents/MacOS/Ardia', reason: 'unclassified' }, { stage: 'child', tool: 'node', status: 3, reason: 'child-reported' }]);
    assert.equal(result.stderr.trim().split('\n').length, 5);

    child(Array.from({ length: 9 }, (_, status) => line({ ...valid, status })).join('\n') + '\n', 3);
    assert.deepEqual(harness.sign().reported.map(entry => [entry.stage, entry.status]), [['archive', 0], ['archive', 1], ['archive', 2], ['archive', 3], ['child', 3]]);

    child(hidden + '\n', 7);
    assert.deepEqual(harness.sign().reported, [{ stage: 'child', tool: 'node', status: 7, reason: 'unclassified', stderrBytes: Buffer.byteLength(hidden + '\n') }]);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('signer stops are reported once, under the stage that stopped', () => {
  const run = (script, args) => spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: '' } });
  assert.equal(run('./sign-personal.mjs', []).stderr, line({ stage: 'policy', reason: 'invalid-arguments' }) + '\n');
  const missing = run('./sign-personal.mjs', [`/tmp/${hidden}`]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, line({ stage: 'policy', reason: 'ENOENT' }) + '\n');
  const usage = run('./ci-sign.mjs', []);
  assert.equal(usage.status, 1);
  assert.equal(diagnostics(usage.stderr).length, 1);
  assert.deepEqual(diagnostics(usage.stderr)[0], { stage: 'policy', reason: 'invalid-arguments' });
});
