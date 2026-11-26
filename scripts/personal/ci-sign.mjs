import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFailure, diagnosticPrefix, formatDiagnostic, forwardedDiagnostics, matchingIdentities, PolicyFailure, runSigningTool as run, ToolFailure } from './signing-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let stage = 'policy';
const report = (failedStage, error) => {
  process.exitCode = 1;
  process.stderr.write(formatDiagnostic(describeFailure(failedStage, error)) + '\n');
};
const cleanUp = action => {
  try { action(); }
  catch (error) { report('cleanup', error); }
};

function runSigner(candidate, keyDirectory, env) {
  try { execFileSync(process.execPath, [join(root, 'scripts/personal/sign-personal.mjs'), candidate, keyDirectory], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  catch (failure) {
    const forwarded = forwardedDiagnostics(failure.stderr, resolve(candidate, 'Ardia.app'));
    for (const line of forwarded) process.stderr.write(line + '\n');
    throw new ToolFailure(process.execPath, failure, { reason: forwarded.length ? 'child-reported' : undefined });
  }
}

function reportPairedIdentity(keychain, certificateSHA1) {
  try {
    const matches = matchingIdentities(run('security', ['find-identity', '-p', 'codesigning', keychain]), certificateSHA1);
    process.stderr.write(diagnosticPrefix + JSON.stringify({ stage: 'identity-check', matches }) + '\n');
  } catch (error) { process.stderr.write(formatDiagnostic(describeFailure('identity-check', error)) + '\n'); }
}

function signWithRestrictedSecrets() {
  const [candidate, keyDirectory] = process.argv.slice(2);
  if (!candidate || !keyDirectory || !process.env.SPARKLE_BIN || existsSync(keyDirectory)) throw new PolicyFailure('invalid-arguments', 'Usage: ci-sign.mjs <candidate directory> <new private key directory>');
  const config = JSON.parse(readFileSync(join(root, 'scripts/personal/release-config.json'), 'utf8'));
  stage = 'secrets';
  const p12 = process.env.PERSONAL_CERTIFICATE_P12;
  const importPassword = process.env.PERSONAL_CERTIFICATE_PASSWORD;
  const seed = process.env.PERSONAL_SPARKLE_SEED;
  if (!p12 || !/^[A-Za-z0-9+/=\r\n]+$/.test(p12) || !importPassword || !/^[A-Za-z0-9+/]{43}=$/.test(seed ?? '')) throw new PolicyFailure('missing-secrets', 'The restricted personal-signing environment is missing valid signing secrets.');
  process.umask(0o077);
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  const keychain = join(keyDirectory, 'signing.keychain-db');
  stage = 'search-list';
  const search = run('security', ['list-keychains', '-d', 'user']).split('\n').map(value => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
  try {
    stage = 'secrets';
    writeFileSync(join(keyDirectory, 'identity.p12'), Buffer.from(p12, 'base64'), { mode: 0o600 });
    writeFileSync(join(keyDirectory, 'p12-password'), importPassword, { mode: 0o600 });
    writeFileSync(join(keyDirectory, 'sparkle.key'), seed + '\n', { mode: 0o600 });
    stage = 'update-key-pin';
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
    if (Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64') !== config.updatePublicKey) throw new PolicyFailure('update-key-pin-mismatch', 'The CI update key does not match the pinned public key.');
    stage = 'p12-extract';
    run('openssl', ['pkcs12', '-in', join(keyDirectory, 'identity.p12'), '-passin', `file:${join(keyDirectory, 'p12-password')}`, '-clcerts', '-nokeys', '-out', join(keyDirectory, 'certificate.pem')]);
    run('openssl', ['x509', '-in', join(keyDirectory, 'certificate.pem'), '-outform', 'DER', '-out', join(keyDirectory, 'certificate.der')]);
    stage = 'cert-pin';
    const certificate = readFileSync(join(keyDirectory, 'certificate.der'));
    if (createHash('sha256').update(certificate).digest('hex') !== config.certificateSHA256 || createHash('sha1').update(certificate).digest('hex') !== config.certificateSHA1) throw new PolicyFailure('certificate-pin-mismatch', 'The CI certificate does not match the pinned identity.');
    stage = 'keychain-create';
    const password = randomBytes(32).toString('base64url');
    writeFileSync(join(keyDirectory, 'password'), password + '\n', { mode: 0o600 });
    run('security', ['create-keychain', '-p', password, keychain]);
    run('security', ['set-keychain-settings', '-lut', '3600', keychain]);
    run('security', ['unlock-keychain', '-p', password, keychain]);
    stage = 'import';
    run('security', ['import', join(keyDirectory, 'identity.p12'), '-k', keychain, '-P', importPassword, '-T', '/usr/bin/codesign']);
    stage = 'partition-list';
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    reportPairedIdentity(keychain, config.certificateSHA1);
    stage = 'search-list';
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...search]);
    const env = { ...process.env };
    for (const name of ['PERSONAL_CERTIFICATE_P12', 'PERSONAL_CERTIFICATE_PASSWORD', 'PERSONAL_SPARKLE_SEED', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];
    stage = 'child';
    runSigner(candidate, keyDirectory, env);
    console.log('Signed candidate and proof feeds using the pinned personal identity.');
  } finally {
    cleanUp(() => { if (existsSync(keychain)) run('security', ['delete-keychain', keychain]); });
    cleanUp(() => run('security', ['list-keychains', '-d', 'user', '-s', ...search]));
    cleanUp(() => rmSync(keyDirectory, { recursive: true, force: true }));
  }
}

try { signWithRestrictedSecrets(); }
catch (error) { report(stage, error); }
if (process.exitCode) process.stderr.write('Personal signing failed; private arguments and tool output were withheld.\n');
