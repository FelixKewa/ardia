import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./artifact.py', import.meta.url));
const python = (args, options) => execFileSync('python3', ['-I', ...args], { stdio: 'pipe', ...options });

test('artifact transfer preserves executable permissions and internal framework links', () => {
  const work = mkdtempSync('/tmp/ardia-artifact-test-');
  try {
    const source = join(work, 'source'), output = join(work, 'unpacked');
    mkdirSync(join(source, 'Ardia.app/Contents/Frameworks/Test.framework/Versions/A'), { recursive: true });
    writeFileSync(join(source, 'Ardia.app/Contents/Info.plist'), 'fixture');
    const executable = 'Ardia.app/Contents/Frameworks/Test.framework/Versions/A/Test';
    writeFileSync(join(source, executable), 'fixture code'); chmodSync(join(source, executable), 0o755);
    symlinkSync('A', join(source, 'Ardia.app/Contents/Frameworks/Test.framework/Versions/Current'));
    writeFileSync(join(source, 'engine.json'), 'match=exact'); writeFileSync(join(source, 'source-commit.txt'), 'a'.repeat(40));
    python([script, 'pack', source, join(work, 'candidate.tar')]);
    python([script, 'unpack', join(work, 'candidate.tar'), output]);
    assert.equal(readFileSync(join(output, executable), 'utf8'), 'fixture code');
    assert.equal(statSync(join(output, executable)).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(output, 'Ardia.app/Contents/Frameworks/Test.framework/Versions/Current')), 'A');
    assert.throws(() => python([script, 'unpack', join(work, 'candidate.tar'), output]));
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('hostile archives cannot escape or introduce special files before signing', () => {
  const check = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('artifact',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\nmodule.validate(json.loads(sys.argv[2]))`;
  const info = ['Ardia.app/Contents/Info.plist', 'file', '', 10];
  const root = ['Ardia.app', 'directory', '', 0];
  for (const extra of [
    [['../escape', 'file', '', 1]],
    [['/tmp/escape', 'file', '', 1]],
    [info],
    [['Ardia.app/device', 'other', '', 0]],
    [['Ardia.app/link', 'symlink', '/tmp', 0]],
    [['Ardia.app/link', 'symlink', '../../outside', 0]],
    [['Ardia.app/link', 'symlink', 'Contents', 0], ['Ardia.app/link/write', 'file', '', 1]],
    [['Ardia.app/oversized', 'file', '', 9 * 1024 ** 3]],
  ]) assert.throws(() => python(['-c', check, script, JSON.stringify([root, info, ...extra])]));
});

test('zip extraction rejects traversal before creating its destination', () => {
  const work = mkdtempSync('/tmp/ardia-artifact-zip-test-');
  try {
    const archive = join(work, 'bad.zip');
    python(['-c', "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('Ardia.app/Contents/Info.plist','fixture')\n z.writestr('../escape','bad')", archive]);
    assert.throws(() => python([script, 'unzip', archive, join(work, 'extracted')]));
    assert.throws(() => statSync(join(work, 'escape')));
  } finally { rmSync(work, { recursive: true, force: true }); }
});
