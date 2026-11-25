import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { prepareWebKitExtension } from "../../../scripts/personal/prepare-webkit-extension.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-extension-preparation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "background"), { recursive: true });
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", background: { scripts: ["./background/index.js", "ascii.js"] } }));
  fs.writeFileSync(path.join(source, "background/index.js"), 'globalThis.result = /[가-힣]+/.test("한글");');
  fs.writeFileSync(path.join(source, "ascii.js"), "globalThis.ascii = true;");
  fs.writeFileSync(path.join(source, "resource.bin"), Buffer.from([0, 1, 0xff]));
  return { root, source, output: path.join(root, "prepared") };
}

test("preparation fixes the encoding failure and preserves original bytes and unrelated files", (t) => {
  const { source, output } = fixture(t);
  const original = fs.readFileSync(path.join(source, "background/index.js"));
  assert.throws(() => new vm.Script(new TextDecoder("windows-1252").decode(original)), SyntaxError);
  const result = prepareWebKitExtension(source, output);
  assert.deepEqual(result.preparedScripts, ["background/index.js"]);
  const prepared = fs.readFileSync(path.join(output, "background/index.js"));
  assert.deepEqual(prepared.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.deepEqual(prepared.subarray(3), original);
  assert.equal(vm.runInNewContext(new TextDecoder("utf-8").decode(prepared)), true);
  assert.deepEqual(fs.readFileSync(path.join(source, "background/index.js")), original);
  for (const file of ["manifest.json", "ascii.js", "resource.bin"]) {
    assert.deepEqual(fs.readFileSync(path.join(output, file)), fs.readFileSync(path.join(source, file)));
  }
});

test("already marked background scripts are not marked twice", (t) => {
  const { source, output, root } = fixture(t);
  prepareWebKitExtension(source, output);
  const again = path.join(root, "again");
  assert.deepEqual(prepareWebKitExtension(output, again).preparedScripts, []);
  assert.deepEqual(fs.readFileSync(path.join(output, "background/index.js")), fs.readFileSync(path.join(again, "background/index.js")));
});

test("preparation refuses existing output nested output and resource symlinks", (t) => {
  const { source, output, root } = fixture(t);
  assert.throws(() => prepareWebKitExtension(source, source), /outside/);
  assert.throws(() => prepareWebKitExtension(source, path.join(source, "nested")), /outside/);
  fs.mkdirSync(output);
  assert.throws(() => prepareWebKitExtension(source, output), /already exists/);
  fs.rmSync(output, { recursive: true });
  fs.symlinkSync(path.join(root, "secret"), path.join(source, "link"));
  assert.throws(() => prepareWebKitExtension(source, output), /symbolic links/);
  assert.equal(fs.existsSync(output), false);
});

test("background traversal and invalid UTF-8 fail before creating an output folder", (t) => {
  const { source, output } = fixture(t);
  const manifest = path.join(source, "manifest.json");
  const original = fs.readFileSync(manifest);
  const changed = JSON.parse(original);
  changed.background.scripts = ["../outside.js"];
  fs.writeFileSync(manifest, JSON.stringify(changed));
  assert.throws(() => prepareWebKitExtension(source, output), /inside/);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(manifest, original);
  fs.writeFileSync(path.join(source, "background/index.js"), Buffer.from([0xff]));
  assert.throws(() => prepareWebKitExtension(source, output), /encoded data/);
  assert.equal(fs.existsSync(output), false);
});
