import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { adaptKimchiDictionarySource, prepareWebKitExtension } from "../../../scripts/personal/prepare-webkit-extension.mjs";

const dictionaryHelper = "async function decode(e){let t=(await e.blob()).stream().pipeThrough(new DecompressionStream(`gzip`));return await(await new Response(t).blob()).text()}";
const adaptedDecoder = () => new Function(`return (${adaptKimchiDictionarySource(dictionaryHelper)})`)();

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

test("dictionary adaptation decodes Korean gzip JSON from offset views and multiple chunks", async () => {
  const expected = JSON.stringify({ word: "한글", definitions: ["한국어", "글자"], extra: "가나다라".repeat(50) });
  const gzip = gzipSync(expected);
  const stream = new ReadableStream({ start(controller) {
    for (let offset = 0; offset < gzip.length; offset += 7) {
      const end = Math.min(gzip.length, offset + 7);
      const backing = new Uint8Array(end - offset + 8).fill(255);
      backing.set(gzip.subarray(offset, end), 3);
      controller.enqueue(backing.subarray(3, 3 + end - offset));
    }
    controller.close();
  } });
  const result = await adaptedDecoder()({ blob: async () => ({ stream: () => stream }) });
  assert.equal(result, expected);
  assert.deepEqual(JSON.parse(result).definitions, ["한국어", "글자"]);
});

test("dictionary adaptation preserves malformed gzip rejection", async () => {
  const corrupted = Buffer.from(gzipSync('{"word":"한글"}'));
  corrupted[corrupted.length - 8] ^= 255;
  await assert.rejects(adaptedDecoder()(new Response(corrupted)));
});

test("dictionary adaptation refuses missing and repeated decoder expressions", () => {
  assert.throws(() => adaptKimchiDictionarySource("async function decode(){}"), /exactly once/);
  assert.throws(() => adaptKimchiDictionarySource(dictionaryHelper + dictionaryHelper), /exactly once/);
});

test("dictionary opt-in rejects unfamiliar versions scripts and hashes without changing the source or creating output", (t) => {
  const { source, output } = fixture(t);
  const manifestPath = path.join(source, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.name = "Kimchi Reader";
  manifest.version = "0.21.8";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiDictionary: true }), /0\.21\.7/);
  assert.equal(fs.existsSync(output), false);
  manifest.version = "0.21.7";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiDictionary: true }), /not declared/);
  assert.equal(fs.existsSync(output), false);
  manifest.content_scripts = [{ matches: ["https://example.com/*"], js: ["contentScripts/index.global.js"] }];
  fs.mkdirSync(path.join(source, "contentScripts"));
  fs.writeFileSync(path.join(source, "contentScripts/index.global.js"), dictionaryHelper);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeScript = fs.readFileSync(path.join(source, "contentScripts/index.global.js"));
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiDictionary: true }), /differs from the reviewed original/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
  assert.deepEqual(fs.readFileSync(path.join(source, "contentScripts/index.global.js")), beforeScript);
});
