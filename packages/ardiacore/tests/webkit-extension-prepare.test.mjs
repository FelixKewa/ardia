import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { adaptKimchiDictionarySource, adaptKimchiNetflixSeekSource, adaptKimchiNetflixSeekHelper, adaptKimchiWebKitMiningSource, prepareWebKitExtension } from "../../../scripts/personal/prepare-webkit-extension.mjs";

const dictionaryHelper = "async function decode(e){let t=(await e.blob()).stream().pipeThrough(new DecompressionStream(`gzip`));return await(await new Response(t).blob()).text()}";
const adaptedDecoder = () => new Function(`return (${adaptKimchiDictionarySource(dictionaryHelper)})`)();
const netflixSeekMethod = "seekTo(e){let t=document.createElement(`script`);t.src=chrome.runtime.getURL(`inject/netflix_seek.js?`)+new URLSearchParams({t:(e/1e3).toString()}),t.onload=function(){this.remove()},(document.head||document.documentElement).appendChild(t)}";
const netflixSeekHelper = '(()=>{const params = new URLSearchParams(document.currentScript.src.split("?")[1]);const player=globalThis.testPlayer;player.seek(parseFloat(params.get("t")) * 1000);})();';

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
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiNetflixSeek: true }), /differs from the reviewed original/);
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiDictionary: true, kimchiNetflixSeek: true }), /differs from the reviewed original/);
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiWebKitMining: true }), /differs from the reviewed original/);
  assert.throws(() => prepareWebKitExtension(source, output, { kimchiDictionary: true, kimchiNetflixSeek: true, kimchiWebKitMining: true }), /differs from the reviewed original/);
  assert.equal(fs.existsSync(output), false);
});

test("Netflix next previous repeat and zero targets use ordered per-script millisecond attributes", () => {
  const calls = [], nodes = [];
  const helper = new vm.Script(adaptKimchiNetflixSeekHelper(netflixSeekHelper));
  let page;
  const document = {
    currentScript: null,
    createElement() {
      const attributes = new Map();
      return { async: true, assignedSrc: "", removed: false,
        setAttribute(key, value) { attributes.set(key, value); },
        getAttribute(key) { return attributes.get(key) ?? null; },
        set src(value) { this.assignedSrc = value; },
        get src() { return "webkit-masked-url://hidden/"; },
        remove() { this.removed = true; },
      };
    },
    head: { appendChild(node) { nodes.push(node); } },
  };
  page = vm.createContext({ document, testPlayer: { seek(value) { calls.push(value); } } });
  const sender = vm.runInNewContext(`({${adaptKimchiNetflixSeekSource(netflixSeekMethod)}})`, {
    document, chrome: { runtime: { getURL: (resource) => `webkit-extension://fixture/${resource}` } },
  });
  const targets = [125500, 94123, 94123, 0, 1234.5];
  for (const target of targets) sender.seekTo(target);
  assert.equal(new Set(nodes).size, targets.length);
  for (const [index, node] of nodes.entries()) {
    assert.equal(node.async, false);
    assert.equal(node.assignedSrc, "webkit-extension://fixture/inject/netflix_seek.js");
    assert.equal(node.getAttribute("data-kimchi-seek-ms"), String(targets[index]));
    document.currentScript = node;
    helper.runInContext(page);
    (index % 2 ? node.onerror : node.onload).call(node);
    assert.equal(node.removed, true);
  }
  assert.deepEqual(calls, targets);
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, "100"]) sender.seekTo(invalid);
  assert.equal(nodes.length, targets.length);
});

test("Netflix seek helper ignores missing blank malformed negative and nonfinite targets without reading masked URLs", () => {
  const calls = [];
  const source = adaptKimchiNetflixSeekHelper(netflixSeekHelper);
  for (const value of [null, undefined, "", " ", "NaN", "Infinity", "-Infinity", "-1", "12invalid"]) {
    vm.runInNewContext(source, {
      document: { currentScript: { getAttribute: () => value, get src() { throw new Error("Masked URL must not be read"); } } },
      testPlayer: { seek(target) { calls.push(target); } },
    });
  }
  vm.runInNewContext(source, { document: { currentScript: null }, testPlayer: { seek(target) { calls.push(target); } } });
  assert.deepEqual(calls, []);
});

test("Netflix seek adaptation composes with dictionary correction and refuses ambiguous helpers", () => {
  const combined = dictionaryHelper + `\nconst player={${netflixSeekMethod}};`;
  assert.equal(adaptKimchiNetflixSeekSource(adaptKimchiDictionarySource(combined)), adaptKimchiDictionarySource(adaptKimchiNetflixSeekSource(combined)));
  assert.throws(() => adaptKimchiNetflixSeekSource("seekTo(){}"), /exactly once/);
  assert.throws(() => adaptKimchiNetflixSeekSource(netflixSeekMethod + netflixSeekMethod), /exactly once/);
  assert.throws(() => adaptKimchiNetflixSeekHelper("(()=>{})()"), /exactly once/);
  assert.throws(() => adaptKimchiNetflixSeekHelper(netflixSeekHelper + netflixSeekHelper), /exactly once/);
});

const miningFixture = `async function prepare(){let d=await Z.lazyAsyncGet(),f=d.dict.mining.captureAudioWhenPossible,p=d.dict.mining.captureScreenshotWhenPossible;Ru.set(!1),zu.set(!1);if(f||p)capture();return {sentence:"한국어 문장",definition:"Synthetic definition",image:null,getAudio:null}}
function openContext(){n()&&!R(l)&&N(l,t.context?t.context.getContext():Promise.resolve(null),!0)}`;

function miningHarness({ platform = "netflix", scheme = "webkit-extension", audio = true, screenshot = true } = {}) {
  const preferences = { dict: { mining: { captureAudioWhenPossible: audio, captureScreenshotWhenPossible: screenshot } } };
  const calls = { capture: 0, reset: 0, browser: 0 };
  const state = { open: true, pending: { value: null }, dirty: { value: false }, uploading: { value: false }, provider: null };
  const context = vm.createContext({
    Z: { lazyAsyncGet: async () => preferences }, ph: { getPlatform: () => platform },
    chrome: { runtime: { getURL() { calls.browser++; return `${scheme}://fixture/`; } } },
    Ru: { set() { calls.reset++; } }, zu: { set() { calls.reset++; } }, capture() { calls.capture++; },
    n: () => state.open, R: (value) => value.value, N: (cell, value) => { cell.value = value; },
    l: state.pending, u: state.dirty, d: state.uploading, t: { context: { getContext: () => state.provider() } },
  });
  vm.runInContext(adaptKimchiWebKitMiningSource(miningFixture), context);
  return { prepare: context.prepare, openContext: context.openContext, preferences, calls, state };
}

test("WebKit Netflix requested media fails before capture or hidden UI setup with explicit text-only guidance", async () => {
  for (const [audio, screenshot] of [[true, true], [true, false], [false, true]]) {
    const fixture = miningHarness({ audio, screenshot });
    const before = structuredClone(fixture.preferences);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(fixture.prepare(), (error) => {
        assert.equal(error.code, "ardia-webkit-mining-media-unavailable");
        assert.match(error.message, /unavailable/);
        assert.match(error.message, /Capture screenshot when possible/);
        assert.match(error.message, /Capture audio when possible/);
        assert.match(error.message, /text-only/);
        return true;
      });
    }
    assert.equal(fixture.calls.capture, 0);
    assert.equal(fixture.calls.reset, 0);
    assert.deepEqual(fixture.preferences, before);
  }
});

test("explicit text-only mining avoids browser APIs and leaves other browsers and platforms unchanged", async () => {
  const textOnly = miningHarness({ audio: false, screenshot: false });
  const context = await textOnly.prepare();
  assert.equal(context.sentence, "한국어 문장");
  assert.equal(context.definition, "Synthetic definition");
  assert.equal(context.image, null);
  assert.equal(context.getAudio, null);
  assert.deepEqual(textOnly.calls, { capture: 0, reset: 2, browser: 0 });
  for (const options of [{ scheme: "moz-extension" }, { scheme: "chrome-extension" }, { platform: "youtube" }, { platform: "viki" }]) {
    const fixture = miningHarness(options);
    assert.equal((await fixture.prepare()).sentence, "한국어 문장");
    assert.equal(fixture.calls.capture, 1);
  }
});

test("mining capability error recovers dismissal after a dirty prior card and permits explicit text-only retry", async () => {
  const fixture = miningHarness();
  fixture.state.provider = () => ({ sentence: "Prior card" });
  fixture.openContext();
  assert.equal((await fixture.state.pending.value).sentence, "Prior card");
  fixture.state.dirty.value = true;
  fixture.state.uploading.value = true;
  fixture.state.open = false;
  fixture.state.pending.value = null;
  fixture.state.open = true;
  fixture.state.provider = fixture.prepare;
  fixture.openContext();
  await assert.rejects(fixture.state.pending.value, { code: "ardia-webkit-mining-media-unavailable" });
  assert.equal(fixture.state.dirty.value, false);
  assert.equal(fixture.state.uploading.value, false);
  fixture.state.open = false;
  fixture.state.pending.value = null;
  fixture.preferences.dict.mining.captureAudioWhenPossible = false;
  fixture.preferences.dict.mining.captureScreenshotWhenPossible = false;
  fixture.state.open = true;
  fixture.openContext();
  assert.equal((await fixture.state.pending.value).sentence, "한국어 문장");
  assert.equal(fixture.calls.capture, 0);
});

test("late or generic mining errors cannot clear a newer card's transient state", async () => {
  const fixture = miningHarness();
  let rejectOld;
  fixture.state.provider = () => new Promise((_, reject) => { rejectOld = reject; });
  fixture.openContext();
  const old = fixture.state.pending.value;
  const oldResult = assert.rejects(old, { code: "ardia-webkit-mining-media-unavailable" });
  fixture.state.open = false;
  fixture.state.pending.value = null;
  fixture.state.open = true;
  fixture.state.provider = () => ({ sentence: "New card" });
  fixture.openContext();
  const current = fixture.state.pending.value;
  await current;
  fixture.state.dirty.value = true;
  fixture.state.uploading.value = true;
  rejectOld(Object.assign(new Error("Old request"), { code: "ardia-webkit-mining-media-unavailable" }));
  await oldResult;
  assert.equal(fixture.state.pending.value, current);
  assert.equal(fixture.state.dirty.value, true);
  assert.equal(fixture.state.uploading.value, true);
  fixture.state.pending.value = null;
  fixture.state.provider = () => Promise.reject(new Error("Generic failure"));
  fixture.openContext();
  await assert.rejects(fixture.state.pending.value, /Generic failure/);
  assert.equal(fixture.state.dirty.value, true);
  assert.equal(fixture.state.uploading.value, true);
});

test("mining preparation composes with dictionary and seeking and rejects missing or ambiguous boundaries", () => {
  const combined = dictionaryHelper + `\nconst player={${netflixSeekMethod}};\n` + miningFixture;
  assert.equal(
    adaptKimchiWebKitMiningSource(adaptKimchiNetflixSeekSource(adaptKimchiDictionarySource(combined))),
    adaptKimchiDictionarySource(adaptKimchiNetflixSeekSource(adaptKimchiWebKitMiningSource(combined))),
  );
  assert.throws(() => adaptKimchiWebKitMiningSource("async function prepare(){}"), /exactly once/);
  assert.throws(() => adaptKimchiWebKitMiningSource(miningFixture + miningFixture), /exactly once/);
  assert.throws(() => adaptKimchiWebKitMiningSource(miningFixture.split("function openContext")[0]), /exactly once/);
});
