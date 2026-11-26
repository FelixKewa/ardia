import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishable, feedBranch, hexCommit, nextBuild, repository, sha256, sourceBranch, validatePlan, validateRelease, verifySignedFeed } from './release-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(join(root, 'scripts/personal/release-config.json'), 'utf8'));
if (config.repository !== repository || config.branch !== sourceBranch || config.upstream !== 'ardia-browser/ardia') throw new Error('Unexpected personal pipeline repository configuration.');
const github = 'https://github.com/';
const remote = `${github}${repository}.git`;
const run = (tool, args, options = {}) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, ...options });
const git = (cwd, args, { env, ...options } = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
  cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Ardia Personal CI', GIT_AUTHOR_EMAIL: 'ardia-personal@users.noreply.github.com', GIT_COMMITTER_NAME: 'Ardia Personal CI', GIT_COMMITTER_EMAIL: 'ardia-personal@users.noreply.github.com', ...env }, ...options,
}).trim();
const githubGit = (cwd, args) => {
  if (!process.env.GH_TOKEN) throw new Error('GitHub git access needs GH_TOKEN.');
  const credential = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  return git(cwd, args, { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${github}.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}` } });
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const summary = message => {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n', { flag: 'a' });
};
const skip = message => { output('ready', false); summary(message); };
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { flag: 'a' });
};
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}
function controllerGuard() {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main' || !['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) || !hexCommit(process.env.GITHUB_SHA)) throw new Error('This controller runs only from the trusted fork main branch.');
  if (git(root, ['rev-parse', 'HEAD']) !== process.env.GITHUB_SHA) throw new Error('Controller checkout differs from the workflow commit.');
}
async function prepare(folder) {
  controllerGuard();
  const environment = await api('environments/personal-signing');
  const rules = await api('environments/personal-signing/deployment-branch-policies');
  if (environment.deployment_branch_policy?.protected_branches !== false || environment.deployment_branch_policy?.custom_branch_policies !== true || rules.branch_policies?.length !== 1 || rules.branch_policies[0].name !== 'main' || (rules.branch_policies[0].type && rules.branch_policies[0].type !== 'branch')) throw new Error('personal-signing must allow only the trusted main branch.');
  if (existsSync(folder)) throw new Error('The plan output must be a new directory.');
  mkdirSync(folder, { recursive: true });
  const source = join(folder, 'source');
  githubGit(root, ['clone', '--no-checkout', remote, source]);
  githubGit(source, ['fetch', '--no-tags', remote, `refs/heads/${sourceBranch}:refs/remotes/frozen/personal`, `refs/heads/${feedBranch}:refs/remotes/frozen/feed`]);
  githubGit(source, ['fetch', '--no-tags', `${github}${config.upstream}.git`, 'refs/heads/main:refs/remotes/frozen/upstream']);
  const personal = git(source, ['rev-parse', 'refs/remotes/frozen/personal']);
  const upstream = git(source, ['rev-parse', 'refs/remotes/frozen/upstream']);
  const feedHead = git(source, ['rev-parse', 'refs/remotes/frozen/feed']);
  const previous = validateRelease(JSON.parse(git(source, ['show', `${feedHead}:release.json`])), config);
  verifySignedFeed(Buffer.from(run('git', ['show', `${feedHead}:appcast.xml`], { cwd: source, encoding: null })), config.updatePublicKey);
  const tags = githubGit(source, ['ls-remote', '--tags', remote]).split('\n').map(line => line.split('\t')[1]?.replace('refs/tags/', '')).filter(Boolean);
  if (!tags.includes(previous.tag)) throw new Error('The published feed has no corresponding personal release tag.');
  const build = Math.max(nextBuild(tags), Number(previous.build) + 1);
  git(source, ['checkout', '-b', 'personal-candidate', personal]);
  try { git(source, ['merge', '--no-ff', '--no-edit', upstream]); }
  catch (error) {
    if (git(source, ['diff', '--name-only', '--diff-filter=U'])) return skip('Upstream merge needs review. No source branch, release or feed changed.');
    throw error;
  }
  if (git(source, ['status', '--porcelain'])) throw new Error('The candidate merge is not clean. Conflicts require review.');
  const candidate = git(source, ['rev-parse', 'HEAD']);
  if (candidate === personal && previous.source === personal && process.env.PERSONAL_FORCE !== 'true') return skip('Already running the latest personal source. No new build is needed.');
  const bundle = join(folder, 'candidate.bundle');
  git(source, ['bundle', 'create', bundle, 'personal-candidate']);
  const plan = validatePlan({ schema: 1, repository, controller: process.env.GITHUB_SHA, personal, upstream, candidate, feedHead, build, previous, bundleSHA256: await sha256(bundle) });
  save(join(folder, 'plan.json'), plan);
  output('ready', true);
  output('build', build);
  output('candidate', candidate);
  console.log(`Frozen personal ${personal.slice(0, 12)}, upstream ${upstream.slice(0, 12)}, candidate ${candidate.slice(0, 12)}, build ${build}.`);
}
async function materialize(folder, target) {
  const plan = validatePlan(json(join(folder, 'plan.json')));
  if (await sha256(join(folder, 'candidate.bundle')) !== plan.bundleSHA256) throw new Error('Candidate bundle digest mismatch.');
  git(root, ['clone', '--no-checkout', join(folder, 'candidate.bundle'), target]);
  git(target, ['checkout', '--detach', plan.candidate]);
  if (git(target, ['rev-parse', 'HEAD']) !== plan.candidate) throw new Error('Wrong candidate source.');
}
async function engine(source) {
  try {
    const description = run('bash', [join(source, 'packages/ardiacore/scripts/fetch-engine.sh'), '--describe'], { cwd: source, env: { ...process.env, ARDIACORE_PREBUILT_REPO: config.upstream }, timeout: 180000 });
    if (!description.startsWith('match=exact ')) throw new Error('Candidate engine is not exact.');
    output('ready', true);
  } catch (error) {
    if (/no prebuilt engine for this checkout/.test(error.stderr?.toString() ?? '')) return skip('Waiting for the exact upstream engine. No source branch, release or feed changed.');
    throw error;
  }
}
async function verifyBuild(folder, planFile) {
  const plan = validatePlan(json(planFile));
  if (readFileSync(join(folder, 'source-commit.txt'), 'utf8').trim() !== plan.candidate) throw new Error('Build source differs from frozen plan.');
  const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(folder, 'Ardia.app/Contents/Info.plist')]));
  if (info.ArdiaEngineMatch !== 'exact' || !readFileSync(join(folder, 'engine.json'), 'utf8').startsWith('match=exact ')) throw new Error('Only the exact published engine can be signed.');
  if (info.CFBundleVersion !== String(plan.build)) throw new Error('Build number differs from frozen plan.');
  if (info.ACReleaseNotesURL !== `https://github.com/${repository}/releases/tag/personal-${plan.build}`) throw new Error('Release notes do not point to this personal build.');
}
async function previous(folder, planFile) {
  const plan = validatePlan(json(planFile));
  const prior = validateRelease(plan.previous, config);
  mkdirSync(folder, { recursive: true });
  const response = await fetch(`https://github.com/${repository}/releases/download/${prior.tag}/${prior.archive}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Previous personal archive download failed (${response.status}).`);
  const { pipeline } = await import('node:stream/promises');
  const { createWriteStream } = await import('node:fs');
  const archive = join(folder, prior.archive);
  await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }));
  if (await sha256(archive) !== prior.sha256) throw new Error('Previous personal archive digest mismatch.');
  run('python3', ['-I', join(root, 'scripts/personal/artifact.py'), 'unzip', archive, join(folder, 'extracted')]);
}
export async function uploadAsset(uploadURL, name, path, token) {
  const response = await fetch(`${uploadURL.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: readFileSync(path), signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`Release asset upload failed (${response.status}). The feed was not changed.`);
  const asset = await response.json();
  if (asset.digest && asset.digest !== `sha256:${await sha256(path)}`) throw new Error('Uploaded asset digest mismatch. The feed was not changed.');
}
async function publish(folder, planFolder, proofFile) {
  controllerGuard();
  const plan = validatePlan(json(join(planFolder, 'plan.json')));
  if (plan.controller !== process.env.GITHUB_SHA) throw new Error('Release controller changed.');
  const release = validateRelease(json(join(folder, 'release.json')), config);
  const proof = json(proofFile);
  const archive = join(folder, 'updates', release.archive);
  if (await sha256(archive) !== release.sha256) throw new Error('Signed archive digest mismatch.');
  verifySignedFeed(readFileSync(join(folder, 'updates/appcast.xml')), config.updatePublicKey);
  const refs = githubGit(root, ['ls-remote', remote, `refs/heads/${sourceBranch}`, `refs/heads/${feedBranch}`, `refs/tags/${release.tag}`]);
  const map = new Map(refs.split('\n').filter(Boolean).map(line => { const [hash, ref] = line.split('\t'); return [ref, hash]; }));
  if (map.has(`refs/tags/${release.tag}`)) throw new Error('Release tags and assets are immutable; this build number already exists.');
  assertPublishable(plan, release, proof, { personal: map.get(`refs/heads/${sourceBranch}`), feedHead: map.get(`refs/heads/${feedBranch}`) ?? null });
  if (await sha256(join(planFolder, 'candidate.bundle')) !== plan.bundleSHA256) throw new Error('Candidate bundle digest mismatch.');
  git(root, ['fetch', join(planFolder, 'candidate.bundle'), 'personal-candidate:refs/heads/personal-release-candidate']);
  git(root, ['merge-base', '--is-ancestor', plan.personal, plan.candidate]);
  try {
    githubGit(root, ['push', '--atomic', `--force-with-lease=refs/heads/${sourceBranch}:${plan.personal}`, remote,
      `${plan.candidate}:refs/heads/${sourceBranch}`, `${plan.candidate}:refs/tags/${release.tag}`]);
  } catch (error) {
    if (/refusing to allow[\s\S]*workflow|workflow[\s\S]*(?:permission|scope)/i.test(error.stderr?.toString() ?? '')) return skip('GitHub requires an owner-approved source merge for changed workflow files. Push that reviewed merge to the personal branch, then retry. Atomic publication stopped before any release or feed changed.');
    throw error;
  }
  const made = await api('releases', 'POST', { tag_name: release.tag, target_commitish: plan.candidate, name: `Ardia Personal ${release.build}`, draft: true, prerelease: true,
    body: `Source: ${plan.candidate}\nUpstream: ${plan.upstream}\nController: ${plan.controller}\nEngine: ${release.engine ?? 'recorded in signed app metadata'}\nArchive SHA-256: ${release.sha256}\nActual signed Sparkle update proof: ${proof.previousBuild} → ${proof.installedBuild}.` });
  const uploads = [archive, join(folder, 'release.json'), join(folder, 'updates/appcast.xml'), proofFile];
  for (const path of uploads) await uploadAsset(made.upload_url, path === proofFile ? 'update-proof.json' : basename(path), path, process.env.GH_TOKEN);
  await api(`releases/${made.id}`, 'PATCH', { draft: false, make_latest: 'false' });
  githubGit(root, ['fetch', '--no-tags', remote, `refs/heads/${feedBranch}:refs/remotes/personal-publish/feed`]);
  if (git(root, ['rev-parse', 'refs/remotes/personal-publish/feed']) !== plan.feedHead) throw new Error('Feed branch moved; release exists but feed remains unchanged.');
  const index = join(folder, 'feed.index');
  const indexEnv = { GIT_INDEX_FILE: index };
  git(root, ['read-tree', '--empty'], { env: indexEnv });
  for (const [name, path] of [['appcast.xml', join(folder, 'updates/appcast.xml')], ['release.json', join(folder, 'release.json')]]) {
    const blob = git(root, ['hash-object', '-w', '--stdin'], { input: readFileSync(path) });
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`], { env: indexEnv });
  }
  const tree = git(root, ['write-tree'], { env: indexEnv });
  const commit = git(root, ['commit-tree', tree, '-p', plan.feedHead, '-m', `Publish verified personal build ${release.build}`]);
  githubGit(root, ['push', `--force-with-lease=refs/heads/${feedBranch}:${plan.feedHead}`, remote, `${commit}:refs/heads/${feedBranch}`]);
  console.log(`Published ${release.tag}; signed feed advanced last to ${commit}.`);
}

async function dispatch([command, ...args]) {
  if (command === 'prepare' && args.length === 1) await prepare(resolve(args[0]));
  else if (command === 'materialize' && args.length === 2) await materialize(resolve(args[0]), resolve(args[1]));
  else if (command === 'engine' && args.length === 1) await engine(resolve(args[0]));
  else if (command === 'verify-build' && args.length === 2) await verifyBuild(resolve(args[0]), resolve(args[1]));
  else if (command === 'previous' && args.length === 2) await previous(resolve(args[0]), resolve(args[1]));
  else if (command === 'publish' && args.length === 3) await publish(resolve(args[0]), resolve(args[1]), resolve(args[2]));
  else throw new Error('Usage: pipeline.mjs prepare|materialize|verify-build|previous|publish <paths>');
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await dispatch(process.argv.slice(2));
