import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'AC_TARGET_OS')),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const series = `# fixture series
chromium chromium-shared.patch
chromium chromium-mac-only.patch mac
chromium chromium-linux-only.patch linux

layer engine/chromium
layer engine/ardiacore mac
layer engine/ardiacore-linux linux
`

const linuxApply = `#!/usr/bin/env bash
here=$(cd "$(dirname "$0")" && pwd)
copy_file "$here/../ardiacore/src/ardia/core/ac_hooks.h" "$src/ardia/core/ac_hooks.h"
copy_file "$here/../../packages/ardiacore/ios/page_script.js" "$src/ardia/core/page_script.js"
copy_file "$here/../chromium/src/\${logo%/linux/*}/\${logo##*/}" "$src/$logo"
`

const files = {
  'engine/patches/series': series,
  'engine/patches/chromium-shared.patch': 'shared\n',
  'engine/patches/chromium-mac-only.patch': 'mac\n',
  'engine/patches/chromium-linux-only.patch': 'linux\n',
  'engine/patches/series.py': 'print()\n',
  'engine/patches/build/env.sh': 'export CHROMIUM_VERSION=1.2.3.4\n',
  'engine/patches/build/tests/test_tooling.py': 'pass\n',
  'engine/chromium/apply.sh': '#!/usr/bin/env bash\n',
  'engine/chromium/src/chrome/app/theme/chromium/product_logo_16.png': 'logo\n',
  'engine/ardiacore/apply.sh': '#!/usr/bin/env bash\n',
  'engine/ardiacore/src/ardia/core/ac_hooks.h': 'hooks\n',
  'engine/ardiacore/src/ardia/core/ardiacore_engine.mm': 'mac engine\n',
  'engine/ardiacore-linux/apply.sh': linuxApply,
  'engine/ardiacore-linux/src/ardia/linux/shell.cc': 'linux shell\n',
  'apps/browser/assets/offline-game/game.js': 'game\n',
  'apps/browser/assets/offline-game-pipeline/inline.py': 'inline\n',
  'packages/ardiacore/ios/page_script.js': 'page\n',
  'README.md': 'fixture\n',
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'engine-key-'))
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  for (const [path, content] of Object.entries(files)) write(path, content)
  mkdirSync(join(root, 'engine'), { recursive: true })
  copyFileSync(join(repo, 'engine/engine-key.sh'), join(root, 'engine/engine-key.sh'))
  const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  const run = (args, env = {}) =>
    spawnSync(join(root, 'engine/engine-key.sh'), args, { cwd: root, env: { ...gitEnv, ...env }, encoding: 'utf8' })
  const key = (platform, ...rest) => {
    const result = run(['--platform', platform, ...rest])
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const keys = () => ({ macos: key('macos'), linux: key('linux') })
  const change = (path, content) => {
    write(path, content)
    git('add', '-A')
    git('commit', '-q', '-m', `change ${path}`)
    return keys()
  }
  return { root, git, run, key, keys, change, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function withFixture(body) {
  return () => {
    const repo = fixture()
    try {
      body(repo)
    } finally {
      repo.cleanup()
    }
  }
}

function assertKeys(before, after, { macos, linux }) {
  assert.equal(before.macos !== after.macos, macos, `macOS key ${macos ? 'should' : 'should not'} change`)
  assert.equal(before.linux !== after.linux, linux, `Linux key ${linux ? 'should' : 'should not'} change`)
}

const cases = [
  ['a Linux-only patch', 'engine/patches/chromium-linux-only.patch', { macos: false, linux: true }],
  ['a macOS-only patch', 'engine/patches/chromium-mac-only.patch', { macos: true, linux: false }],
  ['a shared patch', 'engine/patches/chromium-shared.patch', { macos: true, linux: true }],
  ['the Linux layer', 'engine/ardiacore-linux/src/ardia/linux/shell.cc', { macos: false, linux: true }],
  ['the Linux layer apply.sh', 'engine/ardiacore-linux/apply.sh', { macos: false, linux: true }],
  ['the macOS layer', 'engine/ardiacore/src/ardia/core/ardiacore_engine.mm', { macos: true, linux: false }],
  ['a macOS layer file the Linux layer copies', 'engine/ardiacore/src/ardia/core/ac_hooks.h', { macos: true, linux: true }],
  ['page_script.js, which only the Linux layer copies', 'packages/ardiacore/ios/page_script.js', { macos: false, linux: true }],
  ['the shared chromium layer', 'engine/chromium/src/chrome/app/theme/chromium/product_logo_16.png', { macos: true, linux: true }],
  ['the build scripts', 'engine/patches/build/env.sh', { macos: true, linux: true }],
  ['series.py', 'engine/patches/series.py', { macos: true, linux: true }],
  ['the offline game', 'apps/browser/assets/offline-game/game.js', { macos: true, linux: true }],
  ['the offline game pipeline', 'apps/browser/assets/offline-game-pipeline/inline.py', { macos: true, linux: true }],
  ['the build scripts tests', 'engine/patches/build/tests/test_tooling.py', { macos: false, linux: false }],
  ['engine-key itself', 'engine/engine-key.test.mjs', { macos: false, linux: false }],
  ['a file outside the engine', 'README.md', { macos: false, linux: false }],
]

for (const [name, path, expected] of cases) {
  test(
    `a change to ${name} changes ${Object.entries(expected).filter(([, v]) => v).map(([k]) => k).join(' and ') || 'neither key'}`,
    withFixture(({ keys, change }) => {
      const before = keys()
      assertKeys(before, change(path, `changed ${path}\n`), expected)
    }),
  )
}

test(
  'a series line for one platform leaves the other platform key alone',
  withFixture(({ keys, change, root }) => {
    const before = keys()
    writeFileSync(join(root, 'engine/patches/chromium-linux-new.patch'), 'new\n')
    const linuxLine = change('engine/patches/series', series.replace('chromium chromium-linux-only.patch linux\n', 'chromium chromium-linux-only.patch linux\nchromium chromium-linux-new.patch linux\n'))
    assertKeys(before, linuxLine, { macos: false, linux: true })
    writeFileSync(join(root, 'engine/patches/chromium-mac-new.patch'), 'new\n')
    const macLine = change('engine/patches/series', readFileSync(join(root, 'engine/patches/series'), 'utf8').replace('chromium chromium-mac-only.patch mac\n', 'chromium chromium-mac-only.patch mac\nchromium chromium-mac-new.patch mac\n'))
    assertKeys(linuxLine, macLine, { macos: true, linux: false })
  }),
)

test(
  'comments and blank lines in the series change neither key, the order of shared lines changes both',
  withFixture(({ keys, change }) => {
    const before = keys()
    const commented = change('engine/patches/series', `${series}\n# another comment\n`.replace('chromium chromium-shared.patch', 'chromium chromium-shared.patch  # why'))
    assertKeys(before, commented, { macos: false, linux: false })
    const reordered = change('engine/patches/series', series.replace('layer engine/chromium\n', '').replace('chromium chromium-shared.patch\n', 'layer engine/chromium\nchromium chromium-shared.patch\n'))
    assertKeys(commented, reordered, { macos: true, linux: true })
  }),
)

test(
  'marking a shared patch for Linux drops it from the macOS key only',
  withFixture(({ keys, change }) => {
    const before = keys()
    assertKeys(before, change('engine/patches/series', series.replace('chromium chromium-shared.patch\n', 'chromium chromium-shared.patch linux\n')), { macos: true, linux: false })
  }),
)

test(
  'the platforms have different keys, and macos, mac and AC_TARGET_OS name the same one',
  withFixture(({ key, run }) => {
    const macos = key('macos')
    const linux = key('linux')
    assert.match(macos, /^[0-9a-f]{40}$/)
    assert.match(linux, /^[0-9a-f]{40}$/)
    assert.notEqual(macos, linux)
    assert.equal(key('mac'), macos)
    assert.equal(run([], { AC_TARGET_OS: 'linux' }).stdout.trim(), linux)
    assert.equal(run([], { AC_TARGET_OS: 'mac' }).stdout.trim(), macos)
    assert.equal(run(['--platform=linux']).stdout.trim(), linux)
    const native = run([])
    if (process.platform === 'darwin') assert.equal(native.stdout.trim(), macos)
    if (process.platform === 'linux') assert.equal(native.stdout.trim(), linux)
    assert.notEqual(run(['--platform', 'windows']).status, 0)
    assert.notEqual(run(['--bogus']).status, 0)
    assert.equal(run(['--help']).status, 0)
    assert.match(run(['--help']).stdout, /--platform macos\|linux/)
  }),
)

test(
  'a commit or tree argument gives the key of that commit or tree',
  withFixture(({ key, change, git }) => {
    const first = { macos: key('macos'), linux: key('linux') }
    change('engine/patches/chromium-shared.patch', 'later\n')
    assert.equal(key('macos', 'HEAD~1'), first.macos)
    assert.equal(key('linux', 'HEAD~1'), first.linux)
    const tree = git('rev-parse', 'HEAD~1^{tree}')
    assert.equal(key('linux', tree), first.linux)
  }),
)

test(
  'a commit that lacks a key path has no key',
  withFixture(({ git, run }) => {
    git('rm', '-q', '-r', '--cached', 'apps/browser/assets/offline-game')
    git('commit', '-q', '-m', 'no game')
    const result = run(['--platform', 'macos'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /has no apps\/browser\/assets\/offline-game/)
  }),
)

test(
  '--paths lists the key roots, plus what a layer copies from outside them',
  withFixture(({ run }) => {
    const roots = ['engine', 'apps/browser/assets/offline-game', 'apps/browser/assets/offline-game-pipeline']
    assert.deepEqual(run(['--platform', 'macos', '--paths']).stdout.trim().split('\n'), roots)
    assert.deepEqual(run(['--platform', 'linux', '--paths']).stdout.trim().split('\n'), [...roots, 'packages/ardiacore/ios/page_script.js'])
  }),
)

function rows(table) {
  return readFileSync(join(repo, table), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'))
}

for (const table of ['packages/ardiacore/prebuilt-engines.tsv', 'packages/ardiacore/prebuilt-engines-linux.tsv']) {
  test(`${table} rows are key, tag, SHA-256 and an optional built key, each key once`, () => {
    const seen = new Set()
    for (const fields of rows(table)) {
      assert.ok(fields.length === 3 || fields.length === 4, fields.join('\t'))
      const [key, tag, sha, built] = fields
      assert.match(key, /^[0-9a-f]{40}$/)
      assert.match(tag, /^(engine-[0-9a-f]{12}|\d+\.\d+\.\d+(-nightly\.\d+)?)$/)
      assert.match(sha, /^[0-9a-f]{64}$/)
      if (built !== undefined) {
        assert.match(built, /^[0-9a-f]{40}$/)
        assert.notEqual(built, key)
        if (tag.startsWith('engine-')) assert.equal(tag, `engine-${built.slice(0, 12)}`)
      } else if (tag.startsWith('engine-')) {
        assert.equal(tag, `engine-${key.slice(0, 12)}`)
      }
      assert.ok(!seen.has(key), `${key} is listed twice`)
      seen.add(key)
    }
  })
}

const shasum = spawnSync('shasum', ['--version']).status === 0
const xz = spawnSync('xz', ['--version']).status === 0

test(
  'the macOS fetch-engine.sh downloads the archive a row names by its built key',
  { skip: !(shasum && xz) && 'needs shasum and xz' },
  withFixture(({ root, key, git }) => {
    const script = 'packages/ardiacore/scripts/fetch-engine.sh'
    mkdirSync(join(root, 'packages/ardiacore/scripts'), { recursive: true })
    copyFileSync(join(repo, script), join(root, script))
    writeFileSync(join(root, '.gitignore'), 'apps/browser/build-ardiacore/\n')
    const built = 'f'.repeat(40)
    const tag = `engine-${built.slice(0, 12)}`
    const assets = join(root, '..', `${root.split('/').pop()}-assets`)
    const framework = join(assets, 'pack', 'Chromium Framework.framework', 'Versions', 'Current')
    mkdirSync(framework, { recursive: true })
    writeFileSync(join(framework, 'Chromium Framework'), 'engine')
    mkdirSync(join(assets, tag), { recursive: true })
    const archive = join(assets, tag, `ArdiaCore-${built.slice(0, 12)}.tar.xz`)
    execFileSync('tar', ['-cJf', archive, '-C', join(assets, 'pack'), 'Chromium Framework.framework'])
    const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const macos = key('macos')
    writeFileSync(join(root, 'packages/ardiacore/prebuilt-engines.tsv'), `# fixture\n${macos}\t${tag}\t${sha}\t${built}\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'table')
    try {
      const fetched = spawnSync(join(root, script), [], {
        cwd: root,
        env: { ...gitEnv, ARDIACORE_PREBUILT_ASSETS: `file://${assets}`, ARDIACORE_PREBUILT_REPO: 'invalid/invalid' },
        encoding: 'utf8',
      })
      assert.equal(fetched.status, 0, fetched.stderr)
      assert.equal(fetched.stdout.trim(), join(root, 'apps/browser/build-ardiacore/prebuilt', macos.slice(0, 12), 'Chromium Framework.framework'))
      appendFileSync(join(root, 'engine/patches/chromium-linux-only.patch'), 'more\n')
      git('commit', '-q', '-a', '-m', 'Linux only')
      assert.equal(key('macos'), macos)
      const again = spawnSync(join(root, script), [], { cwd: root, env: { ...gitEnv, ARDIACORE_PREBUILT_REPO: 'invalid/invalid' }, encoding: 'utf8' })
      assert.equal(again.status, 0, again.stderr)
    } finally {
      rmSync(assets, { recursive: true, force: true })
    }
  }),
)
