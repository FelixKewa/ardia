import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const [app, buildNumber] = process.argv.slice(2);
if (!app || !isAbsolute(app) || !/^[1-9][0-9]{3,}$/.test(buildNumber)) throw new Error('Usage: configure-bundle.mjs <absolute app path> <build number>');
const config = JSON.parse(readFileSync(new URL('./release-config.json', import.meta.url), 'utf8'));
const plist = join(app, 'Contents/Info.plist');
const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
if (read('CFBundleIdentifier') !== config.bundleIdentifier) throw new Error('Unexpected app identity.');
const version = read('CFBundleShortVersionString').replace(/-nightly\.\d+$/, '');
const values = {
  ACPersonalBuild: true,
  ACPersonalSigningCertificateSHA256: config.certificateSHA256,
  ACUpdateChannel: config.channel,
  SUFeedURL: config.feedURL,
  SUPublicEDKey: config.updatePublicKey,
  SUVerifyUpdateBeforeExtraction: true,
  SURequireSignedFeed: true,
  SUSignedFeedFailureExpirationInterval: 0,
  SUDefaultsDomain: 'com.ardia.browser.personal.updates',
  SUEnableAutomaticChecks: true,
  CFBundleVersion: buildNumber,
  CFBundleShortVersionString: `${version}-nightly.${buildNumber}`,
};
for (const [key, value] of Object.entries(values)) {
  const kind = typeof value === 'boolean' ? '-bool' : typeof value === 'number' ? '-integer' : '-string';
  execFileSync('plutil', ['-replace', key, kind, String(value), plist]);
}
console.log(`Configured personal build ${buildNumber}.`);
