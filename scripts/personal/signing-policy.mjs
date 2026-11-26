import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const magic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

export function isMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && magic.has(header.toString('hex'));
  } finally { closeSync(fd); }
}

export function collectCode(app) {
  const root = realpathSync(app);
  if (!lstatSync(app).isDirectory() || lstatSync(app).isSymbolicLink()) throw new Error('The staged app must be a plain directory.');
  const binaries = [], bundles = [];
  const walk = path => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      if (!realpathSync(path).startsWith(root + sep)) throw new Error('Bundle contains an external symbolic link.');
    } else if (entry.isDirectory()) {
      for (const child of readdirSync(path)) walk(join(path, child));
      if (/\.(app|xpc|framework)$/.test(path)) bundles.push(path);
    } else if (entry.isFile()) {
      if (entry.size >= 4 && isMachO(path)) binaries.push(path);
    } else throw new Error('Bundle contains a special file.');
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
  if (!/^[a-zA-Z0-9._-]+$/.test(identifier) || !/^[a-f0-9]{40}$/.test(certificateSHA1)) throw new Error('Invalid signing identity.');
  return `designated => identifier "${identifier}" and certificate leaf = H"${certificateSHA1}"`;
}
