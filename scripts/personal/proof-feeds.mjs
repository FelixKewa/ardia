import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { proofPort, verifySignedFeed } from './release-policy.mjs';

export function writeProofFeeds(output, config, seedFile, sparkleBin) {
  const folder = join(output, 'proof');
  mkdirSync(folder, { recursive: true });
  const production = verifySignedFeed(readFileSync(join(output, 'updates/appcast.xml')), config.updatePublicKey);
  const feed = production.replaceAll(`https://github.com/${config.repository}/releases/download/`, `http://127.0.0.1:${proofPort}/`);
  if (feed === production) throw new Error('The production feed has no personal release enclosure.');
  const good = join(folder, 'appcast.xml');
  const badArchive = join(folder, 'bad-archive.xml');
  writeFileSync(good, feed);
  writeFileSync(badArchive, feed.replace(/(<enclosure\b[^>]*\bsparkle:edSignature=")[^"]+"/, `$1${'A'.repeat(86)}=="`));
  for (const path of [good, badArchive]) {
    try { execFileSync(join(sparkleBin, 'sign_update'), ['--ed-key-file', seedFile, path], { stdio: 'pipe' }); }
    catch { throw new Error('Could not sign the isolated update proof feed.'); }
    verifySignedFeed(readFileSync(path), config.updatePublicKey);
  }
  const signed = readFileSync(good, 'utf8');
  const damaged = signed.replace(/(<!-- sparkle-signatures:\s*edSignature: )([A-Za-z0-9+/])/, (_, start, first) => start + (first === 'A' ? 'B' : 'A'));
  if (damaged === signed) throw new Error('Could not prepare invalid feed signature fixture.');
  writeFileSync(join(folder, 'bad-feed.xml'), damaged);
}
