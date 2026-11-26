import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const directory = process.argv.slice(2).find(arg => arg !== '--resume') ?? join(homedir(), 'Library/Application Support/Ardia Personal Signing');
if (!isAbsolute(directory)) throw new Error('An absolute signing directory is required.');
if (existsSync(directory)) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Signing directory must be private and owned by this user.');
}
const privateFile = file => {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Signing files must be regular private files owned by this user.');
  return readFileSync(file);
};
const manifest = join(directory, 'public.json');
if (existsSync(manifest)) {
  const value = JSON.parse(privateFile(manifest).toString('utf8'));
  if (value.schema !== 1 || value.bundleIdentifier !== 'com.ardia.browser' || !/^[a-f0-9]{64}$/.test(value.certificateSHA256) || !/^[a-f0-9]{40}$/.test(value.certificateSHA1) || !/^[A-Za-z0-9+/]{43}=$/.test(value.updatePublicKey)) throw new Error('Invalid public signing metadata.');
  console.log(JSON.stringify({ schema: 1, bundleIdentifier: value.bundleIdentifier, certificateSHA256: value.certificateSHA256, certificateSHA1: value.certificateSHA1, updatePublicKey: value.updatePublicKey }, null, 2));
  process.exit(0);
}
if (existsSync(directory) && !process.argv.includes('--resume')) throw new Error('Signing directory already exists without public.json; inspect it before retrying with --resume.');
process.umask(0o077);
mkdirSync(directory, { mode: 0o700, recursive: true });
const passwordFile = join(directory, 'password');
const password = existsSync(passwordFile) ? privateFile(passwordFile).toString('utf8').trim() : randomBytes(32).toString('base64url');
if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('Existing signing password has an unexpected format.');
writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
const exportPasswordFile = join(directory, 'p12-password');
writeFileSync(exportPasswordFile, password + '\n', { mode: 0o600 });
const run = (binary, args, options = {}) => {
  try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch (error) { throw new Error(`Signing setup step ${binary} ${args[0]} failed (status ${error.status ?? 'unknown'}); private command details were withheld.`); }
};
if (!existsSync(join(directory, 'identity.pem')) && !existsSync(join(directory, 'certificate.pem'))) {
run('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650',
  '-subj', '/CN=FelixKewa Ardia Personal Updates/', '-addext', 'basicConstraints=critical,CA:FALSE',
  '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=codeSigning',
  '-passout', `file:${passwordFile}`, '-keyout', join(directory, 'identity.pem'), '-out', join(directory, 'certificate.pem')]);
}
run('openssl', ['x509', '-in', join(directory, 'certificate.pem'), '-outform', 'DER', '-out', join(directory, 'certificate.der')]);
const privateIdentity = createPrivateKey({ key: privateFile(join(directory, 'identity.pem')), passphrase: password }).export({ format: 'pem', type: 'pkcs8' });
run('openssl', ['pkcs12', '-export', '-passout', `file:${exportPasswordFile}`,
  '-inkey', '/dev/stdin', '-in', join(directory, 'certificate.pem'), '-keypbe', 'PBE-SHA1-3DES',
  '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-out', join(directory, 'identity.p12')], { input: privateIdentity });
const keychain = join(directory, 'signing.keychain-db');
const search = run('security', ['list-keychains', '-d', 'user']).split('\n').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
try {
  if (!existsSync(keychain)) run('security', ['create-keychain', '-p', password, keychain]);
  run('security', ['set-keychain-settings', '-lut', '3600', keychain]);
  run('security', ['unlock-keychain', '-p', password, keychain]);
  run('security', ['import', join(directory, 'identity.p12'), '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
} finally {
  run('security', ['list-keychains', '-d', 'user', '-s', ...search]);
}
const seedFile = join(directory, 'sparkle.key');
let updatePrivateKey;
if (existsSync(seedFile)) {
  const seed = privateFile(seedFile).toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(seed)) throw new Error('Existing update key has an unexpected format.');
  updatePrivateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
} else {
  updatePrivateKey = generateKeyPairSync('ed25519').privateKey;
  writeFileSync(seedFile, Buffer.from(updatePrivateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
}
const updatePublicKey = Buffer.from(createPublicKey(updatePrivateKey).export({ format: 'jwk' }).x, 'base64url').toString('base64');
const certificate = readFileSync(join(directory, 'certificate.der'));
const publicData = {
  schema: 1,
  bundleIdentifier: 'com.ardia.browser',
  certificateSHA256: createHash('sha256').update(certificate).digest('hex'),
  certificateSHA1: createHash('sha1').update(certificate).digest('hex'),
  updatePublicKey,
};
writeFileSync(manifest, JSON.stringify(publicData, null, 2) + '\n', { mode: 0o600 });
for (const file of ['identity.pem', 'identity.p12', 'sparkle.key', 'password']) chmodSync(join(directory, file), 0o600);
console.log(JSON.stringify(publicData, null, 2));
