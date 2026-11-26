import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCode, designatedRequirement, entitlementsFor } from './signing-policy.mjs';
import { writeProofFeeds } from './proof-feeds.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, keysArgument] = process.argv.slice(2);
if (!outputArgument || !isAbsolute(outputArgument)) throw new Error('Usage: sign-personal.mjs <absolute candidate directory> [signing directory]');
const output = realpathSync(outputArgument);
const app = join(output, 'Ardia.app');
if (output === '/Applications' || output.startsWith('/Applications/')) throw new Error('Sign staged candidates only.');
const { binaries, bundles } = collectCode(app);
const keys = keysArgument ?? join(homedir(), 'Library/Application Support/Ardia Personal Signing');
const config = JSON.parse(readFileSync(join(root, 'scripts/personal/release-config.json'), 'utf8'));
const run = (binary, args, options = {}) => {
  try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch (error) { throw new Error(`Personal signing step ${basename(binary)} failed (status ${error.status ?? 'unknown'}); private command details were withheld.`); }
};
const privateFile = name => {
  const path = join(keys, name);
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o077)) throw new Error('Signing material must be private regular files owned by this user.');
  return readFileSync(path);
};
const cert = privateFile('certificate.der');
if (createHash('sha256').update(cert).digest('hex') !== config.certificateSHA256 || createHash('sha1').update(cert).digest('hex') !== config.certificateSHA1) throw new Error('Signing certificate differs from the pinned identity.');
const seed = privateFile('sparkle.key').toString('utf8').trim();
if (!/^[A-Za-z0-9+/]{43}=$/.test(seed)) throw new Error('Invalid update signing key.');
const edKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
if (Buffer.from(createPublicKey(edKey).export({ format: 'jwk' }).x, 'base64url').toString('base64') !== config.updatePublicKey) throw new Error('Update signing key differs from the pinned public key.');
const plist = join(app, 'Contents/Info.plist');
const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist]));
if (info.CFBundleIdentifier !== config.bundleIdentifier || info.ACPersonalBuild !== true || info.ACPersonalSigningCertificateSHA256 !== config.certificateSHA256 || info.SUFeedURL !== config.feedURL || info.SUPublicEDKey !== config.updatePublicKey || info.SUVerifyUpdateBeforeExtraction !== true || info.SURequireSignedFeed !== true || info.SUSignedFeedFailureExpirationInterval !== 0 || info.SUDefaultsDomain !== 'com.ardia.browser.personal.updates' || info.ACUpdateChannel !== config.channel) throw new Error('Candidate identity/update configuration does not match the personal release policy.');
if (!/^[1-9][0-9]{3,}$/.test(info.CFBundleVersion)) throw new Error('Invalid candidate build number.');
const keychain = join(keys, 'signing.keychain-db');
run('security', ['unlock-keychain', '-p', privateFile('password').toString('utf8').trim(), keychain]);
const originalEntitlements = new Map();
for (const path of [...binaries, ...bundles]) {
  const xml = run('codesign', ['-d', '--entitlements', '-', '--xml', path]);
  originalEntitlements.set(path, xml.trim() ? JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml })) : {});
}
const sign = path => {
  const args = ['--force', '--sign', config.certificateSHA1, '--keychain', keychain, '--timestamp=none', '--options', 'runtime'];
  const values = entitlementsFor(app, path, originalEntitlements.get(path));
  const entitlements = join(output, `entitlements-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.plist`);
  writeFileSync(entitlements, run('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(values) }));
  args.push('--entitlements', entitlements);
  const bundlePlist = join(path, 'Contents/Info.plist');
  let identifier = path === app ? config.bundleIdentifier : `${config.bundleIdentifier}.code.${createHash('sha256').update(path.slice(app.length)).digest('hex').slice(0, 16)}`;
  if (existsSync(bundlePlist)) identifier = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', bundlePlist])).CFBundleIdentifier;
  args.push('--identifier', identifier, '--requirements', '=' + designatedRequirement(identifier, config.certificateSHA1));
  run('codesign', [...args, path]);
};
for (const binary of binaries) sign(binary);
for (const bundle of bundles) sign(bundle);
run('codesign', ['--verify', '--deep', '--strict', app]);
const tag = `personal-${info.CFBundleVersion}`;
const archiveName = `Ardia-Personal-${info.CFBundleVersion}-arm64.zip`;
const updates = join(output, 'updates');
if (existsSync(updates)) throw new Error('Update output already exists.');
mkdirSync(updates);
const archive = join(updates, archiveName);
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
const sparkle = process.env.SPARKLE_BIN ?? join(root, 'apps/browser/macos/Pods/Sparkle/bin');
const notes = `Ardia Personal ${info.CFBundleVersion}\n\nUpstream Ardia improvements with the personal WebKit extension support and Kimchi compatibility tooling.\n`;
writeFileSync(join(updates, archiveName.replace(/\.zip$/, '.txt')), notes);
run(join(sparkle, 'generate_appcast'), ['--ed-key-file', join(keys, 'sparkle.key'), '--maximum-deltas', '0', '--channel', config.channel,
  '--download-url-prefix', `https://github.com/${config.repository}/releases/download/${tag}/`, '--embed-release-notes', '--link', `https://github.com/${config.repository}`,
  '-o', join(updates, 'appcast.xml'), updates]);
run(join(sparkle, 'sign_update'), ['--ed-key-file', join(keys, 'sparkle.key'), join(updates, 'appcast.xml')]);
run(join(sparkle, 'sign_update'), ['--verify', '--ed-key-file', join(keys, 'sparkle.key'), join(updates, 'appcast.xml')]);
const hasher = createHash('sha256');
for await (const chunk of createReadStream(archive)) hasher.update(chunk);
const sha256 = hasher.digest('hex');
const provenance = { schema: 1, tag, build: info.CFBundleVersion, version: info.CFBundleShortVersionString, archive: archiveName, sha256, bytes: statSync(archive).size,
  source: readFileSync(join(output, 'source-commit.txt'), 'utf8').trim(), engine: readFileSync(join(output, 'engine.json'), 'utf8').trim(), bundleIdentifier: config.bundleIdentifier, certificateSHA256: config.certificateSHA256, updatePublicKey: config.updatePublicKey, feedURL: config.feedURL };
writeFileSync(join(output, 'release.json'), JSON.stringify(provenance, null, 2) + '\n');
writeProofFeeds(output, config, join(keys, 'sparkle.key'), sparkle);
console.log(JSON.stringify({ build: provenance.build, archive, sha256, signedFeed: true }));
