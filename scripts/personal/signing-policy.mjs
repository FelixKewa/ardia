import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const magic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

export const diagnosticPrefix = 'ARDIA_SIGN_DIAGNOSTIC ';
export const diagnosticLineLimit = 1024;
const bundlePathLimit = 240;
const bundlePathPattern = /^(?!\.\.?(?:\/|$))[A-Za-z0-9 ._()+@-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9 ._()+@-]+)*$/;

export const signingStages = [
  'policy', 'code-scan', 'signing-material', 'plist-read', 'keychain-unlock', 'entitlements-read', 'codesign-sign', 'codesign-verify',
  'archive', 'appcast-generate', 'appcast-sign', 'appcast-verify', 'provenance', 'proof-feeds',
  'secrets', 'update-key-pin', 'p12-extract', 'cert-pin', 'keychain-create', 'import', 'partition-list', 'identity-check', 'search-list', 'child', 'cleanup',
];

export const signingTools = ['codesign', 'ditto', 'generate_appcast', 'node', 'openssl', 'plutil', 'security', 'sign_update'];
const toolsReportingOnStdout = ['generate_appcast', 'sign_update'];

const policyReasons = [
  'invalid-arguments', 'missing-secrets', 'installed-application-path', 'app-not-plain-directory', 'external-symlink', 'unresolved-symlink', 'special-file',
  'signing-material-not-private', 'certificate-pin-mismatch', 'update-key-invalid', 'update-key-pin-mismatch', 'bundle-metadata-mismatch',
  'build-number-invalid', 'signing-identity-invalid', 'update-output-exists', 'production-feed-invalid', 'production-feed-without-release',
  'proof-feed-invalid', 'invalid-feed-fixture-failed',
];

const toolOutputReasons = [
  ['certificate-chain-incomplete', /unable to build chain to self-signed root/i],
  ['errsec-internal-component', /errSecInternalComponent/],
  ['keychain-interaction-not-allowed', /User interaction is not allowed|errSecInteractionNotAllowed/],
  ['identity-not-found', /no identity found|specified item could not be found in the keychain|errSecItemNotFound/i],
  ['identity-ambiguous', /ambiguous \(matches|ambiguous identity/i],
  ['keychain-not-found', /specified keychain could not be found|errSecNoSuchKeychain/i],
  ['keychain-passphrase-rejected', /user name or passphrase you entered is not correct|errSecAuthFailed/i],
  ['pkcs12-password-rejected', /MAC verification failed|mac verify (?:error|failure)/i],
  ['pkcs12-import-failed', /SecKeychainItemImport|Unknown format in import/i],
  ['openssl-unsupported-algorithm', /inner_evp_generic_fetch|unsupported algorithm/i],
  ['detritus-not-allowed', /resource fork, Finder information, or similar detritus not allowed|Disallowed xattr/i],
  ['unsigned-code-object', /code object is not signed at all/i],
  ['sealed-resource-invalid', /a sealed resource is missing or invalid/i],
  ['nested-code-invalid', /nested code is modified or invalid/i],
  ['unsealed-contents', /unsealed contents present in the (?:bundle root|root directory of an embedded framework)/i],
  ['bundle-format-ambiguous', /bundle format is ambiguous/i],
  ['bundle-format-unrecognized', /bundle format unrecognized, invalid, or unsuitable/i],
  ['object-format-unrecognized', /object (?:file )?format unrecognized/i],
  ['symlink-destination-invalid', /invalid destination for symbolic link in bundle/i],
  ['requirement-not-satisfied', /does not satisfy its designated requirement|failed to satisfy specified code requirement/i],
  ['info-plist-invalid', /invalid Info\.plist/i],
  ['framework-version-invalid', /embedded framework contains modified or invalid version/i],
  ['signature-invalid', /invalid signature|signature of the binary is invalid/i],
  ['resource-envelope-invalid', /resource envelope is obsolete|code has no resources but signature indicates|invalid resource directory/i],
  ['entitlements-invalid', /Failed to parse entitlements|invalid entitlements|AMFIUnserialize/i],
  ['strict-validation-failed', /failed strict validation/i],
  ['codesign-internal-error', /internal error in Code Signing subsystem/i],
  ['plist-invalid', /Property List error|invalid object in plist/i],
  ['sparkle-key-unreadable', /Unable to (?:load|read) (?:EdDSA|DSA) private key|decode base64 encoded key data|Imported key must be|Private key not decoded/i],
  ['sparkle-signer-mismatch', /Code signature of new version doesn't match|code signing signature failed to match/i],
  ['sparkle-code-signature-invalid', /not signed using Apple Code Signing|Failed to get static code|Failed to copy designated requirement/i],
  ['sparkle-signature-rejected', /failed to pass signing verification|failed to extract signature from appcast|failed to decode base64 signature|invalid byte count/i],
  ['sparkle-feed-unparseable', /failed to parse XML data/i],
  ['sparkle-extraction-failed', /Could not unarchive|error occurred while extracting the archive/i],
  ['sparkle-appcast-failed', /Error generating appcast/i],
  ['no-space-left', /No space left on device/i],
  ['operation-not-permitted', /Operation not permitted/i],
  ['permission-denied', /Permission denied/i],
  ['no-such-file', /No such file or directory/i],
];

const systemReasons = ['E2BIG', 'EACCES', 'EEXIST', 'EISDIR', 'ELOOP', 'EMFILE', 'ENOBUFS', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS', 'ETIMEDOUT'];

export const signingReasons = [...policyReasons, ...toolOutputReasons.map(([reason]) => reason), ...systemReasons, 'invalid-json', 'child-reported', 'unclassified'];

export function isBundlePath(value) {
  return typeof value === 'string' && value.length <= bundlePathLimit && (value === '.' || bundlePathPattern.test(value));
}

export function bundlePath(app, value) {
  if (!app || typeof value !== 'string' || !isAbsolute(value)) return undefined;
  const name = relative(app, value).split(sep).join('/') || '.';
  return isBundlePath(name) ? name : undefined;
}

const diagnosticFields = {
  stage: value => signingStages.includes(value),
  tool: value => signingTools.includes(value),
  status: value => Number.isInteger(value) && value >= 0 && value <= 255,
  signal: value => Number.isInteger(value) && value >= 1 && value <= 64,
  path: isBundlePath,
  subcomponent: isBundlePath,
  reason: value => signingReasons.includes(value),
  stderrBytes: value => Number.isSafeInteger(value) && value >= 0,
};

export function formatDiagnostic(value) {
  const safe = Object.entries(diagnosticFields).filter(([key, valid]) => valid(value[key])).map(([key]) => [key, value[key]]);
  return diagnosticPrefix + JSON.stringify(Object.fromEntries(safe));
}

export function parseDiagnostic(line) {
  if (line.length > diagnosticLineLimit || !line.startsWith(diagnosticPrefix)) return null;
  let value;
  try { value = JSON.parse(line.slice(diagnosticPrefix.length)); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'stage') || !Object.hasOwn(value, 'reason')) return null;
  return Object.keys(value).every(key => Object.hasOwn(diagnosticFields, key) && diagnosticFields[key](value[key])) ? value : null;
}

export function matchingIdentities(listing, certificateSHA1) {
  const paired = String(listing).split('Valid identities only')[0].matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s/gim);
  return new Set([...paired].map(match => match[1].toLowerCase()).filter(hash => hash === certificateSHA1)).size;
}

export function forwardedDiagnostics(stderr, app) {
  const isMember = name => {
    try {
      if (name === '.') return lstatSync(app).isDirectory();
      const root = realpathSync(app);
      const folder = realpathSync(join(root, dirname(name)));
      if (folder !== root && !folder.startsWith(root + sep)) return false;
      return Boolean(lstatSync(join(folder, basename(name))));
    } catch { return false; }
  };
  return String(stderr ?? '').split('\n').map(parseDiagnostic).filter(Boolean).slice(0, 4).map(value => {
    for (const key of ['path', 'subcomponent']) if (value[key] !== undefined && !isMember(value[key])) delete value[key];
    return formatDiagnostic(value);
  });
}

function reportedComponent(stderr, app) {
  if (!app) return undefined;
  const reported = /^In subcomponent: (.+)$/m.exec(stderr)?.[1]
    ?? /^file (?:added|modified|missing): (.+)$/m.exec(stderr)?.[1]
    ?? stderr.split('\n').filter(line => line.startsWith(app + sep) && !line.endsWith(': replacing existing signature')).map(line => line.split(': ')[0])[0];
  return bundlePath(app, reported);
}

export class PolicyFailure extends Error {
  constructor(reason, message, subject) {
    super(message);
    this.reason = reason;
    this.subject = subject;
  }
}

export class ToolFailure extends Error {
  constructor(tool, failure, { app, reason } = {}) {
    const name = basename(tool);
    super(`Trusted signing tool ${name} failed (${failure.status ?? 'unknown'}); private arguments were withheld.`);
    const stderr = String(failure.stderr ?? '');
    const complaint = toolsReportingOnStdout.includes(name) ? `${stderr}\n${failure.stdout ?? ''}` : stderr;
    this.tool = name;
    this.status = failure.status ?? undefined;
    this.signal = constants.signals[failure.signal];
    this.reason = reason
      ?? toolOutputReasons.find(([, pattern]) => pattern.test(complaint))?.[0]
      ?? (systemReasons.includes(failure.code) ? failure.code : 'unclassified');
    this.subcomponent = reportedComponent(stderr, app);
    this.stderrBytes = this.reason === 'unclassified' ? Buffer.byteLength(stderr) : undefined;
  }
}

export function runSigningTool(tool, args, { app, ...options } = {}) {
  try { return execFileSync(tool, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch (failure) { throw new ToolFailure(tool, failure, { app }); }
}

export function describeFailure(stage, error, { app, path } = {}) {
  const classified = error instanceof PolicyFailure || error instanceof ToolFailure;
  const reason = classified ? error.reason
    : error instanceof SyntaxError ? 'invalid-json'
      : systemReasons.includes(error?.code) ? error.code : 'unclassified';
  const member = bundlePath(app, path);
  const component = error instanceof ToolFailure ? error.subcomponent : bundlePath(app, error?.subject ?? error?.path);
  return { stage, tool: error?.tool, status: error?.status, signal: error?.signal, path: member, subcomponent: component === member ? undefined : component, reason, stderrBytes: error?.stderrBytes };
}

export function isMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && magic.has(header.toString('hex'));
  } finally { closeSync(fd); }
}

export function collectCode(app) {
  const root = realpathSync(app);
  if (!lstatSync(app).isDirectory() || lstatSync(app).isSymbolicLink()) throw new PolicyFailure('app-not-plain-directory', 'The staged app must be a plain directory.', app);
  const binaries = [], bundles = [];
  const linkTarget = path => {
    try { return realpathSync(path); }
    catch { throw new PolicyFailure('unresolved-symlink', 'Bundle contains an unresolvable symbolic link.', path); }
  };
  const walk = path => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      if (!linkTarget(path).startsWith(root + sep)) throw new PolicyFailure('external-symlink', 'Bundle contains an external symbolic link.', path);
    } else if (entry.isDirectory()) {
      for (const child of readdirSync(path)) walk(join(path, child));
      if (/\.(app|xpc|framework)$/.test(path)) bundles.push(path);
    } else if (entry.isFile()) {
      if (entry.size >= 4 && isMachO(path)) binaries.push(path);
    } else throw new PolicyFailure('special-file', 'Bundle contains a special file.', path);
  };
  walk(app);
  return { binaries, bundles: bundles.sort((a, b) => b.split(sep).length - a.split(sep).length) };
}

export function entitlementsFor(app, path, existing = {}) {
  const name = relative(app, path).split(sep).join('/');
  if (path.endsWith('.framework') || /\.(dylib|so)$/.test(path)) return {};
  if (name === '' || name === 'Contents/MacOS/Ardia') return {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.disable-library-validation': true,
    'com.apple.security.automation.apple-events': true,
    'com.apple.security.device.audio-input': true,
    'com.apple.security.device.camera': true,
    'com.apple.security.device.bluetooth': true,
    'com.apple.security.device.usb': true,
    'com.apple.security.personal-information.calendars': true,
    'com.apple.security.personal-information.location': true,
  };
  const result = {};
  if (name.includes('/Sparkle.framework/')) {
    for (const key of ['com.apple.security.app-sandbox', 'com.apple.security.inherit', 'com.apple.security.network.client']) {
      if (existing[key] === true) result[key] = true;
    }
  }
  if (/Helper \((?:Aperitif )?(?:Renderer|GPU)\)\.app(?:\/|$)/.test(name)) result['com.apple.security.cs.allow-jit'] = true;
  if (name.includes('/Chromium Framework.framework/') && name.includes('/Helpers/')) result['com.apple.security.cs.disable-library-validation'] = true;
  return result;
}

export function designatedRequirement(identifier, certificateSHA1) {
  if (!/^[a-zA-Z0-9._-]+$/.test(identifier) || !/^[a-f0-9]{40}$/.test(certificateSHA1)) throw new PolicyFailure('signing-identity-invalid', 'Invalid signing identity.');
  return `designated => identifier "${identifier}" and certificate leaf = H"${certificateSHA1}"`;
}
