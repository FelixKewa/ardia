import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const repository = 'FelixKewa/ardia';
export const sourceBranch = 'codex/webkit-kimchi';
export const feedBranch = 'personal-updates';
export const proofPort = 18847;
export const hexCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function publicKey(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid update public key.');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value, 'base64')]), format: 'der', type: 'spki' });
}

export function verifySignedFeed(bytes, key) {
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Update feed is too large.');
  const text = bytes.toString('utf8');
  const footer = /<!-- sparkle-signatures:\s*edSignature: ([A-Za-z0-9+/]{86}==)\s*length: ([0-9]+)\s*-->\s*$/.exec(text);
  if (!footer || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Update feed has no valid signature envelope.');
  const length = Number(footer[2]);
  if (length !== Buffer.byteLength(text.slice(0, footer.index)) || !verify(null, bytes.subarray(0, length), publicKey(key), Buffer.from(footer[1], 'base64'))) throw new Error('Update feed signature is invalid.');
  return text;
}

export function validateRelease(value, config) {
  if (value.schema !== 1 || !/^[1-9][0-9]{3,}$/.test(value.build) || !Number.isSafeInteger(Number(value.build)) ||
      value.tag !== `personal-${value.build}` || value.archive !== `Ardia-Personal-${value.build}-arm64.zip` ||
      !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !hexCommit(value.source)) throw new Error('Invalid personal release provenance.');
  for (const key of ['bundleIdentifier', 'certificateSHA256', 'updatePublicKey', 'feedURL']) if (value[key] !== config[key]) throw new Error(`Release ${key} differs from trusted configuration.`);
  return value;
}

export function validatePlan(value) {
  if (value.schema !== 1 || value.repository !== repository || ![value.controller, value.personal, value.upstream, value.candidate].every(hexCommit) ||
      (value.feedHead !== null && !hexCommit(value.feedHead)) || !Number.isSafeInteger(value.build) || value.build < 1001 ||
      !/^[a-f0-9]{64}$/.test(value.bundleSHA256)) throw new Error('Invalid frozen personal release plan.');
  return value;
}

export function nextBuild(tags) {
  const values = tags.filter(tag => /^personal-[1-9][0-9]{3,}$/.test(tag)).map(tag => Number(tag.slice(9)));
  const build = Math.max(1000, ...values) + 1;
  if (!Number.isSafeInteger(build)) throw new Error('Personal build number exhausted.');
  return build;
}

export function assertPublishable(plan, release, proof, current) {
  validatePlan(plan);
  if (current.personal !== plan.personal || current.feedHead !== plan.feedHead) throw new Error('A branch moved after this candidate was frozen; retry with a fresh plan.');
  if (release.source !== plan.candidate || Number(release.build) !== plan.build || proof.archiveSHA256 !== release.sha256 || proof.source !== plan.candidate ||
      proof.previousBuild !== plan.previous?.build || proof.installedBuild !== release.build || proof.installed !== true || proof.rejectedBadFeed !== true || proof.rejectedBadArchive !== true || proof.sameSigner !== true || proof.sentinelRetained !== true) throw new Error('The actual signed upgrade proof does not authorize this release.');
}
