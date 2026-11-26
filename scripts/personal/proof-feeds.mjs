import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { proofPort, verifySignedFeed } from './release-policy.mjs';
import { PolicyFailure, runSigningTool } from './signing-policy.mjs';

export function writeProofFeeds(output, config, seedFile, sparkleBin, run = runSigningTool) {
  const trustedFeed = (path, reason) => {
    const bytes = readFileSync(path);
    try { return verifySignedFeed(bytes, config.updatePublicKey); }
    catch { throw new PolicyFailure(reason, 'An update feed failed signature verification.'); }
  };
  const folder = join(output, 'proof');
  mkdirSync(folder, { recursive: true });
  const production = trustedFeed(join(output, 'updates/appcast.xml'), 'production-feed-invalid');
  const feed = production.replaceAll(`https://github.com/${config.repository}/releases/download/`, `http://127.0.0.1:${proofPort}/`);
  if (feed === production) throw new PolicyFailure('production-feed-without-release', 'The production feed has no personal release enclosure.');
  const good = join(folder, 'appcast.xml');
  const badArchive = join(folder, 'bad-archive.xml');
  writeFileSync(good, feed);
  writeFileSync(badArchive, feed.replace(/(<enclosure\b[^>]*\bsparkle:edSignature=")[^"]+"/, `$1${'A'.repeat(86)}=="`));
  for (const path of [good, badArchive]) {
    run(join(sparkleBin, 'sign_update'), ['--ed-key-file', seedFile, path]);
    trustedFeed(path, 'proof-feed-invalid');
  }
  const signed = readFileSync(good, 'utf8');
  const damaged = signed.replace(/(<!-- sparkle-signatures:\s*edSignature: )([A-Za-z0-9+/])/, (_, start, first) => start + (first === 'A' ? 'B' : 'A'));
  if (damaged === signed) throw new PolicyFailure('invalid-feed-fixture-failed', 'Could not prepare invalid feed signature fixture.');
  writeFileSync(join(folder, 'bad-feed.xml'), damaged);
}
