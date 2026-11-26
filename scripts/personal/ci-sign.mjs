import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [candidate, keyDirectory] = process.argv.slice(2);
if (!candidate || !keyDirectory || !process.env.SPARKLE_BIN || existsSync(keyDirectory)) throw new Error('Usage: ci-sign.mjs <candidate directory> <new private key directory>');
const config = JSON.parse(readFileSync(join(root, 'scripts/personal/release-config.json'), 'utf8'));
const p12 = process.env.PERSONAL_CERTIFICATE_P12;
const importPassword = process.env.PERSONAL_CERTIFICATE_PASSWORD;
const seed = process.env.PERSONAL_SPARKLE_SEED;
if (!p12 || !/^[A-Za-z0-9+/=\r\n]+$/.test(p12) || !importPassword || !/^[A-Za-z0-9+/]{43}=$/.test(seed ?? '')) throw new Error('The restricted personal-signing environment is missing valid signing secrets.');
const run = (tool, args, options = {}) => {
  try { return execFileSync(tool, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch (error) { throw new Error(`Trusted signing tool ${basename(tool)} failed (${error.status ?? 'unknown'}); private arguments were withheld.`); }
};
process.umask(0o077);
mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
const keychain = join(keyDirectory, 'signing.keychain-db');
const search = run('security', ['list-keychains', '-d', 'user']).split('\n').map(value => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
try {
  writeFileSync(join(keyDirectory, 'identity.p12'), Buffer.from(p12, 'base64'), { mode: 0o600 });
  writeFileSync(join(keyDirectory, 'p12-password'), importPassword, { mode: 0o600 });
  writeFileSync(join(keyDirectory, 'sparkle.key'), seed + '\n', { mode: 0o600 });
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
  if (Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64') !== config.updatePublicKey) throw new Error('The CI update key does not match the pinned public key.');
  run('openssl', ['pkcs12', '-in', join(keyDirectory, 'identity.p12'), '-passin', `file:${join(keyDirectory, 'p12-password')}`, '-clcerts', '-nokeys', '-out', join(keyDirectory, 'certificate.pem')]);
  run('openssl', ['x509', '-in', join(keyDirectory, 'certificate.pem'), '-outform', 'DER', '-out', join(keyDirectory, 'certificate.der')]);
  const certificate = readFileSync(join(keyDirectory, 'certificate.der'));
  if (createHash('sha256').update(certificate).digest('hex') !== config.certificateSHA256 || createHash('sha1').update(certificate).digest('hex') !== config.certificateSHA1) throw new Error('The CI certificate does not match the pinned identity.');
  const password = randomBytes(32).toString('base64url');
  writeFileSync(join(keyDirectory, 'password'), password + '\n', { mode: 0o600 });
  run('security', ['create-keychain', '-p', password, keychain]);
  run('security', ['set-keychain-settings', '-lut', '3600', keychain]);
  run('security', ['unlock-keychain', '-p', password, keychain]);
  run('security', ['import', join(keyDirectory, 'identity.p12'), '-k', keychain, '-P', importPassword, '-T', '/usr/bin/codesign']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  run('security', ['list-keychains', '-d', 'user', '-s', ...search]);
  const env = { ...process.env };
  for (const name of ['PERSONAL_CERTIFICATE_P12', 'PERSONAL_CERTIFICATE_PASSWORD', 'PERSONAL_SPARKLE_SEED', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];
  run(process.execPath, [join(root, 'scripts/personal/sign-personal.mjs'), candidate, keyDirectory], { env });
  console.log('Signed candidate and proof feeds using the pinned personal identity.');
} finally {
  try { if (existsSync(keychain)) run('security', ['delete-keychain', keychain]); }
  finally {
    try { run('security', ['list-keychains', '-d', 'user', '-s', ...search]); }
    finally { rmSync(keyDirectory, { recursive: true, force: true }); }
  }
}
