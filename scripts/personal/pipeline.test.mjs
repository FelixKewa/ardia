import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { uploadAsset } from './pipeline.mjs';
import { assertPublishable, nextBuild, validatePlan, validateRelease, verifySignedFeed } from './release-policy.mjs';

const config = JSON.parse(readFileSync(new URL('./release-config.json', import.meta.url)));
const hash = letter => letter.repeat(40);
const plan = { schema: 1, repository: config.repository, controller: hash('a'), personal: hash('b'), upstream: hash('c'), candidate: hash('d'), feedHead: hash('e'), build: 1002, previous: { build: '1001' }, bundleSHA256: 'f'.repeat(64) };
const release = { schema: 1, tag: 'personal-1002', build: '1002', version: '0.3.0-nightly.1002', archive: 'Ardia-Personal-1002-arm64.zip', sha256: '1'.repeat(64), bytes: 123, source: plan.candidate, ...Object.fromEntries(['bundleIdentifier', 'certificateSHA256', 'updatePublicKey', 'feedURL'].map(key => [key, config[key]])) };
const proof = { schema: 1, archiveSHA256: release.sha256, source: release.source, previousBuild: '1001', installedBuild: '1002', installed: true, rejectedBadFeed: true, rejectedBadArchive: true, sameSigner: true, sentinelRetained: true };
const current = { personal: plan.personal, feedHead: plan.feedHead };

test('release numbers are monotonic and malformed provenance is refused', () => {
  assert.equal(nextBuild(['v0.3.0', 'personal-1000', 'personal-1008', 'personal-1009^{}']), 1009);
  assert.equal(validateRelease(release, config), release);
  assert.equal(validatePlan(plan), plan);
  for (const patch of [{ archive: '../app.zip' }, { tag: 'v1002' }, { bytes: -1 }, { source: '../HEAD' }, { feedURL: 'https://ardia.dev/appcast.xml' }, { certificateSHA256: '0'.repeat(64) }]) assert.throws(() => validateRelease({ ...release, ...patch }, config));
  assert.throws(() => validatePlan({ ...plan, repository: 'ardia-browser/ardia' }));
  assert.throws(() => validatePlan({ ...plan, build: 1000 }));
});

test('publication requires the frozen heads and this exact successful update proof', () => {
  assert.doesNotThrow(() => assertPublishable(plan, release, proof, current));
  for (const key of ['personal', 'feedHead']) assert.throws(() => assertPublishable(plan, release, proof, { ...current, [key]: hash('f') }), /branch moved/);
  for (const key of ['installed', 'rejectedBadFeed', 'rejectedBadArchive', 'sameSigner', 'sentinelRetained']) assert.throws(() => assertPublishable(plan, release, { ...proof, [key]: false }, current), /proof/);
  for (const patch of [{ source: hash('a') }, { archiveSHA256: '0'.repeat(64) }, { installedBuild: '1001' }, { previousBuild: '1000' }]) assert.throws(() => assertPublishable(plan, release, { ...proof, ...patch }, current), /proof/);
});

test('signed feeds verify exact UTF-8 bytes and reject wrong keys, tampering and unsigned data', () => {
  const keys = generateKeyPairSync('ed25519');
  const key = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const bytes = Buffer.from('<rss><channel><title>한국어 Personal</title></channel></rss>\n');
  const signature = sign(null, bytes, keys.privateKey).toString('base64');
  const feed = Buffer.concat([bytes, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${signature}\nlength: ${bytes.length}\n-->\n`)]);
  assert.match(verifySignedFeed(feed, key), /한국어/);
  const altered = Buffer.from(feed); altered[10] ^= 1;
  assert.throws(() => verifySignedFeed(altered, key), /invalid/);
  assert.throws(() => verifySignedFeed(feed, config.updatePublicKey), /invalid/);
  assert.throws(() => verifySignedFeed(bytes, key), /envelope/);
  assert.throws(() => verifySignedFeed(Buffer.from(feed.toString().replace(`length: ${bytes.length}`, 'length: 1')), key), /invalid/);
});

test('workflow keeps signing and publication on separate workers with immutable artifact selection', () => {
  const source = readFileSync(new URL('../../.github/workflows/personal-nightly.yml', import.meta.url), 'utf8');
  const jobs = Object.fromEntries([...source.matchAll(/^  (plan|build|graph|sign|proof|publish):\n([\s\S]*?)(?=^  [a-z]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual(Object.keys(jobs), ['plan', 'build', 'graph', 'sign', 'proof', 'publish']);
  for (const action of source.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  assert.match(jobs.plan, /github.repository == 'FelixKewa\/ardia'.*github.ref == 'refs\/heads\/main'/);
  assert.match(jobs.plan, /PERSONAL_NIGHTLY_ENABLED/);
  assert.match(jobs.sign, /environment: personal-signing/);
  assert.equal((jobs.sign.match(/secrets\./g) ?? []).length, 3);
  for (const name of ['plan', 'build', 'graph', 'proof', 'publish']) assert.doesNotMatch(jobs[name], /secrets\.|environment: personal-signing/);
  for (const name of ['plan', 'build', 'graph', 'sign', 'proof']) assert.doesNotMatch(jobs[name], /contents: write/);
  assert.match(jobs.publish, /contents: write/);
  assert.doesNotMatch(jobs.sign + jobs.publish, /materialize|check-candidate|webkit-smoke|npm |pnpm |uses: \.\//);
  assert.match(jobs.sign, /EXPECTED_SHA256/);
  assert.match(jobs.proof, /update-proof\.mjs/);
  assert.doesNotMatch(source, /pull_request_target|pull_request:|\n  push:|actions\/cache@/);
  for (const download of source.split(/- uses: actions\/download-artifact@/).slice(1)) assert.match(download.split(/\n      - /)[0], /artifact-ids:/);
});

test('the desktop graph tests run in their own job that must pass before signing', () => {
  const source = readFileSync(new URL('../../.github/workflows/personal-nightly.yml', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('./check-candidate.sh', import.meta.url), 'utf8');
  const jobs = Object.fromEntries([...source.matchAll(/^  (plan|build|graph|sign|proof|publish):\n([\s\S]*?)(?=^  [a-z]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  const condition = job => /^    if: (.*)$/m.exec(job)?.[1];
  assert.match(jobs.graph, /^    needs: plan$/m);
  assert.match(jobs.graph, /^    runs-on: ubuntu-latest$/m);
  assert.equal(condition(jobs.graph), condition(jobs.build));
  assert.match(jobs.graph, /run: bash scripts\/personal\/check-candidate\.sh "\$RUNNER_TEMP\/source" graph$/m);
  assert.doesNotMatch(jobs.graph, /continue-on-error/);
  assert.match(jobs.sign, /^    needs: \[plan, build, graph\]$/m);
  assert.doesNotMatch(condition(jobs.sign), /always|failure|cancelled/);
  assert.equal(source.match(/PERSONAL_GRAPH_IN_SEPARATE_JOB/g).length, 1);
  assert.match(jobs.build, /^          PERSONAL_GRAPH_IN_SEPARATE_JOB: '1'$/m);
  assert.deepEqual(gate.match(/\$\{PERSONAL_\w+[^}]*\}" == \S+/g), ['${PERSONAL_GRAPH_IN_SEPARATE_JOB:-}" == 1']);
  assert.equal(gate.match(/scripts\/module-graph\.test\.mjs/g).length, 1);
});

test('publication waits for the extension approval to survive the update from the previous release', () => {
  const source = readFileSync(new URL('../../.github/workflows/personal-nightly.yml', import.meta.url), 'utf8');
  const jobs = Object.fromEntries([...source.split('\njobs:\n')[1].matchAll(/^  ([a-z]+):\n([\s\S]*?)(?=^  [a-z]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  const command = 'node "$RUNNER_TEMP/source/scripts/personal/webkit-upgrade-smoke.mjs" "$RUNNER_TEMP/previous/extracted/Ardia.app" "$RUNNER_TEMP/runtime/Ardia.app" --release > "$RUNNER_TEMP/proof/webkit-upgrade.log" 2>&1';
  const steps = jobs.proof.split(/^      - /m).slice(1);
  const step = steps.findIndex(text => text.split('\n').includes(`          ${command}`));
  assert.ok(step >= 0, 'the proof job runs the upgrade check with exactly these apps');
  assert.match(steps[step], /^run: \|\n/);
  const fetched = steps.findIndex(text => text.includes('pipeline.mjs previous "$RUNNER_TEMP/previous" '));
  assert.ok(fetched >= 0 && fetched < step, 'the previous release is fetched before the upgrade check');
  const order = ['pipeline.mjs materialize "$RUNNER_TEMP/plan" "$RUNNER_TEMP/source"', 'artifact.py unzip "$RUNNER_TEMP"/signed/updates/Ardia-Personal-*-arm64.zip "$RUNNER_TEMP/runtime"', 'scripts/personal/webkit-smoke.mjs" ', command].map(text => steps[step].indexOf(text));
  assert.ok(order.every((position, index) => position > (order[index - 1] ?? -1)), 'the source and the signed app exist before the upgrade check');
  assert.equal(source.match(/webkit-upgrade-smoke\.mjs/g).length, 1);
  assert.doesNotMatch(jobs.proof, /secrets\.|environment:|GH_TOKEN|github\.token|: write|write-all|continue-on-error|^        if:|^    if:|\|\| |set \+e/m);
  assert.doesNotMatch(source.split('\njobs:\n')[0], /secrets\.|GH_TOKEN|: write|write-all/);
  assert.match(jobs.proof, /path: \$\{\{ runner\.temp \}\}\/proof\/\*\.log/);
  assert.match(jobs.publish, /^    needs: \[plan, sign, proof\]$/m);
  assert.doesNotMatch(jobs.publish, /^    if:/m);
});

test('bundle metadata replaces upstream release notes with the exact personal release', { skip: process.platform !== 'darwin' }, () => {
  const work = mkdtempSync('/tmp/ardia-personal-bundle-fixture-');
  try {
    const app = join(work, 'Ardia.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    const plist = join(app, 'Contents/Info.plist');
    writeFileSync(plist, JSON.stringify({ CFBundleIdentifier: config.bundleIdentifier, CFBundleVersion: '1001', CFBundleShortVersionString: '0.2.49-nightly.1001', ACReleaseNotesURL: 'https://ardia.dev/release-notes/' }));
    execFileSync('plutil', ['-convert', 'xml1', plist]);
    execFileSync(process.execPath, [fileURLToPath(new URL('./configure-bundle.mjs', import.meta.url)), app, '1002']);
    const actual = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    assert.equal(actual.ACReleaseNotesURL, 'https://github.com/FelixKewa/ardia/releases/tag/personal-1002');
    assert.equal(actual.CFBundleVersion, '1002');
    assert.equal(actual.CFBundleShortVersionString, '0.2.49-nightly.1002');
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('the plan job reads the signing environment with a read-only workflow token', () => {
  const source = readFileSync(new URL('../../.github/workflows/personal-nightly.yml', import.meta.url), 'utf8');
  const jobs = Object.fromEntries([...source.split('\njobs:\n')[1].matchAll(/^  ([a-z]+):\n([\s\S]*?)(?=^  [a-z]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  assert.match(jobs.plan, /^    permissions:\n      contents: read\n      actions: read\n    [a-z]/m);
  const step = jobs.plan.split(/^      - /m).find(text => text.startsWith('id: plan\n'));
  assert.match(step, /^          GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(step, /run: node scripts\/personal\/pipeline\.mjs prepare /);
  assert.equal(jobs.plan.match(/GH_TOKEN|github\.token/g).length, 2);
  assert.doesNotMatch(jobs.plan, /secrets\.|environment:|: write|write-all/);
  assert.deepEqual(Object.keys(jobs).filter(name => /GH_TOKEN|github\.token/.test(jobs[name])), ['plan', 'publish']);
});

test('release assets upload with the declared length GitHub requires and a wrong digest is refused', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ardia-personal-upload-fixture-'));
  const accepted = [];
  let reportedDigest;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (request.headers['content-length'] === undefined) return response.writeHead(400).end('{}');
      const body = Buffer.concat(chunks);
      accepted.push({ method: request.method, url: request.url, length: Number(request.headers['content-length']), type: request.headers['content-type'], authorization: request.headers.authorization, body });
      response.writeHead(201).end(JSON.stringify({ digest: reportedDigest ?? `sha256:${createHash('sha256').update(body).digest('hex')}` }));
    });
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const assets = `http://127.0.0.1:${server.address().port}/releases/1/assets`;
    const path = join(work, 'archive.zip');
    const bytes = randomBytes(3 * 1024 * 1024);
    writeFileSync(path, bytes);
    await uploadAsset(`${assets}{?name,label}`, 'Ardia Personal.zip', path, 'fixture-token');
    assert.equal(accepted.length, 1);
    const { body, ...received } = accepted[0];
    assert.deepEqual(received, { method: 'POST', url: '/releases/1/assets?name=Ardia%20Personal.zip', length: bytes.length, type: 'application/octet-stream', authorization: 'Bearer fixture-token' });
    assert.ok(body.equals(bytes));
    const streamed = await fetch(`${assets}?name=streamed`, { method: 'POST', body: createReadStream(path), duplex: 'half', signal: AbortSignal.timeout(30000) });
    assert.equal(streamed.status, 400);
    assert.equal(accepted.length, 1);
    reportedDigest = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(uploadAsset(`${assets}{?name,label}`, 'archive.zip', path, 'fixture-token'), /digest mismatch/);
    await assert.rejects(uploadAsset(`http://127.0.0.1:${server.address().port}/missing`, 'archive.zip', join(work, 'absent'), 'fixture-token'), { code: 'ENOENT' });
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test('the pipeline still runs its command when started directly or through a link', () => {
  const work = mkdtempSync(join(tmpdir(), 'ardia-personal-entry-fixture-'));
  try {
    symlinkSync(fileURLToPath(new URL('.', import.meta.url)), join(work, 'linked'));
    for (const script of [fileURLToPath(new URL('./pipeline.mjs', import.meta.url)), join(work, 'linked/pipeline.mjs')]) {
      assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe', timeout: 30000 }), /Usage: pipeline\.mjs/);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('prepare and publish authenticate every GitHub git call, as a throttled hosted runner requires', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ardia-personal-github-fixture-'));
  const token = 'fixture-token';
  const credential = Buffer.from(`x-access-token:${token}`).toString('base64');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const isolated = { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const seed = join(work, 'seed');
  const git = (...args) => execFileSync(realGit, args, { cwd: seed, env: isolated, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (name, value) => {
    writeFileSync(join(seed, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    git('add', '.');
    git('commit', '--quiet', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const requests = [];
  let base;
  const server = createServer((request, response) => {
    const url = new URL(request.url, base);
    const chunks = [];
    const reply = (status, value) => response.writeHead(status).end(JSON.stringify(value));
    if (url.pathname.startsWith('/git/')) {
      requests.push({ path: url.pathname, authorization: request.headers.authorization });
      if (request.headers.authorization !== `basic ${credential}`) return response.writeHead(403).end();
      const backend = spawn(realGit, ['http-backend'], { env: { ...isolated, GIT_PROJECT_ROOT: join(work, 'repositories'), GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x-access-token', PATH_INFO: url.pathname.slice('/git'.length), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] ?? '', GIT_PROTOCOL: request.headers['git-protocol'] ?? '', HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '' } });
      request.pipe(backend.stdin);
      backend.stdout.on('data', chunk => chunks.push(chunk));
      return backend.on('close', () => {
        const output = Buffer.concat(chunks);
        const end = output.indexOf('\r\n\r\n');
        const headers = Object.fromEntries(output.subarray(0, end).toString().split('\r\n').map(line => line.split(': ')));
        const status = Number.parseInt(headers.Status ?? '200', 10);
        delete headers.Status;
        response.writeHead(status, headers).end(output.subarray(end + 4));
      });
    }
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (url.pathname.endsWith('/environments/personal-signing')) return reply(200, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
      if (url.pathname.endsWith('/deployment-branch-policies')) return reply(200, { branch_policies: [{ name: 'main', type: 'branch' }] });
      if (url.pathname.endsWith('/releases') && request.method === 'POST') return reply(201, { id: 1, upload_url: `${base}/uploads{?name,label}` });
      if (url.pathname === '/uploads') return reply(201, { digest: `sha256:${createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}` });
      if (url.pathname.endsWith('/releases/1') && request.method === 'PATCH') return reply(200, {});
      return reply(404, {});
    });
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
    const keys = generateKeyPairSync('ed25519');
    const fixtureConfig = { ...config, updatePublicKey: Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
    const feed = build => {
      const bytes = Buffer.from(`<rss><channel><title>${build}</title></channel></rss>\n`);
      return Buffer.concat([bytes, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${sign(null, bytes, keys.privateKey).toString('base64')}\nlength: ${bytes.length}\n-->\n`)]);
    };
    const described = (build, source, bytes) => ({ ...release, tag: `personal-${build}`, build, archive: `Ardia-Personal-${build}-arm64.zip`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, source, updatePublicKey: fixtureConfig.updatePublicKey });
    const personalRepository = join(work, 'repositories', `${config.repository}.git`);
    const upstreamRepository = join(work, 'repositories', `${config.upstream}.git`);
    mkdirSync(seed);
    for (const folder of [personalRepository, upstreamRepository]) execFileSync(realGit, ['init', '--quiet', '--bare', '--initial-branch=main', folder], { env: isolated });
    git('init', '--quiet', '--initial-branch=main');
    commit('base', 'base');
    git('checkout', '--quiet', '-b', 'upstream');
    commit('upstream', 'upstream');
    git('push', '--quiet', upstreamRepository, 'upstream:main');
    git('checkout', '--quiet', '-b', config.branch, 'main');
    const personal = commit('personal', 'personal');
    git('tag', 'personal-1001');
    git('push', '--quiet', personalRepository, 'main', config.branch, 'personal-1001');
    git('checkout', '--quiet', '--orphan', 'personal-updates');
    git('rm', '--quiet', '-rf', '.');
    commit('appcast.xml', feed('1001'));
    const feedHead = commit('release.json', described('1001', personal, Buffer.from('previous')));
    git('push', '--quiet', personalRepository, 'personal-updates');
    const controller = join(work, 'controller');
    mkdirSync(join(controller, 'scripts/personal'), { recursive: true });
    for (const name of ['pipeline.mjs', 'release-policy.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(controller, 'scripts/personal', name));
    writeFileSync(join(controller, 'scripts/personal/release-config.json'), JSON.stringify(fixtureConfig));
    for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '.'], ['commit', '--quiet', '-m', 'controller']]) execFileSync(realGit, args, { cwd: controller, env: isolated });
    const controllerCommit = execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: controller, env: isolated, encoding: 'utf8' }).trim();
    const calls = join(work, 'git-calls.jsonl');
    mkdirSync(join(work, 'bin'));
    writeFileSync(join(work, 'git-to-fixture.mjs'), `import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GIT_CONFIG_') || name === 'GIT_ASKPASS'));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, config }) + '\\n');
const local = value => value.replaceAll('https://github.com/', ${JSON.stringify(`${base}/git/`)});
const env = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, name.startsWith('GIT_CONFIG_KEY_') ? local(value) : value]));
process.exit(spawnSync(${JSON.stringify(realGit)}, args.map(local), { env, stdio: 'inherit' }).status ?? 1);
`);
    writeFileSync(join(work, 'bin/git'), `#!/bin/sh\nexec "${process.execPath}" "${join(work, 'git-to-fixture.mjs')}" "$@"\n`, { mode: 0o700 });
    writeFileSync(join(work, 'local-github-api.mjs'), `const real = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = String(input).replace('https://api.github.com', ${JSON.stringify(base)});
  if (!url.startsWith(${JSON.stringify(`${base}/`)})) throw new Error('The fixture refuses a request outside itself.');
  return real(url, options);
};
`);
    let printed = '';
    const pipeline = async (...args) => {
      const child = spawn(process.execPath, ['--import', join(work, 'local-github-api.mjs'), join(controller, 'scripts/personal/pipeline.mjs'), ...args], {
        cwd: controller, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${join(work, 'bin')}:${process.env.PATH}`, HOME: work, GIT_ALLOW_PROTOCOL: 'file:http', GITHUB_REPOSITORY: config.repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule', GITHUB_SHA: controllerCommit, GH_TOKEN: token },
      });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
      const status = await new Promise(done => child.on('close', done));
      printed += output;
      assert.equal(status, 0, output);
    };
    const planFolder = join(work, 'plan');
    await pipeline('prepare', planFolder);
    const frozen = JSON.parse(readFileSync(join(planFolder, 'plan.json')));
    assert.deepEqual([frozen.build, frozen.personal, frozen.feedHead], [1002, personal, feedHead]);
    const signed = join(work, 'signed');
    mkdirSync(join(signed, 'updates'), { recursive: true });
    const archive = Buffer.from('signed archive');
    const candidate = described('1002', frozen.candidate, archive);
    writeFileSync(join(signed, 'updates', candidate.archive), archive);
    writeFileSync(join(signed, 'updates/appcast.xml'), feed('1002'));
    writeFileSync(join(signed, 'release.json'), JSON.stringify(candidate));
    writeFileSync(join(work, 'update-proof.json'), JSON.stringify({ ...proof, archiveSHA256: candidate.sha256, source: frozen.candidate }));
    await pipeline('publish', signed, planFolder, join(work, 'update-proof.json'));
    const published = name => execFileSync(realGit, ['rev-parse', name], { cwd: personalRepository, env: isolated, encoding: 'utf8' }).trim();
    assert.equal(published('refs/tags/personal-1002'), frozen.candidate);
    assert.equal(published(`refs/heads/${config.branch}`), frozen.candidate);
    assert.equal(published('refs/heads/personal-updates^'), feedHead);
    const logged = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const online = logged.filter(call => call.args.some(value => value.startsWith('https://')));
    assert.deepEqual(online.map(call => call.args[4]), ['clone', 'fetch', 'fetch', 'ls-remote', 'ls-remote', 'push', 'fetch', 'push']);
    for (const call of online) assert.deepEqual(call.config, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}` }, call.args.join(' '));
    for (const call of logged.filter(value => !online.includes(value))) assert.doesNotMatch(JSON.stringify(call.config), /extraheader|AUTHORIZATION/, call.args.join(' '));
    assert.ok(requests.length >= online.length);
    for (const request of requests) assert.equal(request.authorization, `basic ${credential}`, request.path);
    const secret = new RegExp(`${token}|${credential}`);
    assert.doesNotMatch(printed + JSON.stringify(logged.map(call => call.args)), secret);
    const written = folder => readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
    for (const path of [planFolder, signed, join(controller, '.git')].flatMap(written)) assert.doesNotMatch(readFileSync(path, 'latin1'), secret, path);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});
