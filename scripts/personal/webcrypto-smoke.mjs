import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../lib/instance.mjs";

const app = process.argv[2];
const release = process.argv.slice(3).includes("--release");
if (!app) throw new Error("Usage: node scripts/personal/webcrypto-smoke.mjs <Ardia.app> [--release]");

const scratch = mkdtempSync(join(tmpdir(), "ardia-webcrypto-smoke-"));
const data = join(scratch, "data");
const engineData = join(data, "Chromium");
mkdirSync(engineData, { recursive: true });
const seed = name => writeFileSync(join(engineData, name), randomBytes(16).toString("base64"), { mode: 0o600 });
seed("Test Safe Storage Key");
seed("Test WebCrypto Master Key");

const exercise = `async name => {
  const finished = request => new Promise((done, fail) => { request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
  let step = "open";
  try {
    const opening = indexedDB.open("webcrypto-smoke-" + name, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
    const database = await finished(opening);
    const keys = () => database.transaction("keys", "readwrite").objectStore("keys");
    step = "read";
    let saved = await finished(keys().get("key"));
    const state = saved === undefined ? "stored now" : "stored earlier";
    if (saved === undefined) {
      step = "store";
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(name));
      await finished(keys().put({ key, iv, box }, "key"));
      step = "read back";
      saved = await finished(keys().get("key"));
    }
    if (!saved?.key) return { name, state, usable: false };
    step = "decrypt";
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: saved.iv }, saved.key, saved.box);
    return { name, state, usable: new TextDecoder().decode(plain) === name, extractable: saved.key.extractable };
  } catch (error) {
    return { name, state: "failed to " + step, usable: false, error: error.name };
  }
}`;
const workerScript = `const exercise = ${exercise};
oninstall = () => skipWaiting();
onmessage = event => event.waitUntil(exercise("worker").then(result => event.source.postMessage(result)));
`;
const pageScript = `(async () => {
  const exercise = ${exercise};
  const worker = async () => {
    await navigator.serviceWorker.register("/worker.js");
    const registration = await navigator.serviceWorker.ready;
    return new Promise(done => { navigator.serviceWorker.onmessage = event => done(event.data); registration.active.postMessage("run"); });
  };
  const within = (name, run) => Promise.race([run(), new Promise(done => setTimeout(() => done({ name, state: "no answer", usable: false }), 20000))]);
  const results = [await within("page", () => exercise("page")), await within("worker", worker)];
  document.documentElement.dataset.webcrypto = JSON.stringify({
    served: document.documentElement.dataset.served, webKit: !navigator.userAgent.includes("Chrome/"), results,
  });
})();
`;

const keychainLog = join(engineData, "Test App Keychain Log");
let keychainLines = 0;
const seamReads = () => existsSync(keychainLog) ? readFileSync(keychainLog, "utf8").trim().split("\n").slice(keychainLines) : [];
const refusal = `document.documentElement.dataset.webcrypto = JSON.stringify({ served: document.documentElement.dataset.served, refused: true });
`;

let served = "";
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const send = (type, body) => {
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(body);
  };
  if (path === "/page.js") return send("text/javascript", seamReads().some(line => line.startsWith("resolved ")) ? pageScript : refusal);
  if (path === "/worker.js") return send("text/javascript", workerScript);
  send("text/html", `<!doctype html><html data-served="${served}"><meta charset="utf-8"><title>WebCrypto fixture</title><p>Isolated WebCrypto key test</p><script src="/page.js"></script>`);
});
await new Promise((done, fail) => {
  server.on("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const base = `http://127.0.0.1:${server.address().port}`;
const initial = session({
  tabs: [{ id: "fixture", url: `${base}/`, title: "WebCrypto fixture" }],
  settings: { websiteEngines: { [base]: "webkit" }, engineSwitchCarriesSiteData: false },
});

const q = JSON.stringify;
let instance;
const read = () => instance.eval(`return ac.webviews.get("fixture")?.evaluate(${q(`post("result", JSON.stringify(document.documentElement.dataset.webcrypto ? JSON.parse(document.documentElement.dataset.webcrypto) : null))`)}) ?? null`, { timeout: 10000 });
const result = async phase => {
  let last;
  for (const end = Date.now() + 90000; Date.now() < end; await sleep(200)) {
    if (!instance.alive) throw new Error(`Test app exited while waiting for the ${phase} result`);
    try {
      const answer = await read();
      if (answer?.served === phase) return answer;
    } catch (error) { last = error.message; }
  }
  throw new Error(`Timed out waiting for the ${phase} result${last ? `: ${last}` : ""}`);
};
const run = async (phase, { source, expected }) => {
  served = phase;
  const log = join(scratch, `${phase}.log`);
  instance = await launch(resolve(app), { data, log, onboarded: true, test: { keychain: "file" }, ...(release ? { probe: true, js: "none" } : {}), ...(phase === "store" ? { session: initial } : {}) });
  const seen = await result(phase);
  const { how } = await instance.quit();
  instance = null;
  assert.equal(how, "quit", "the app must quit cleanly so that its data is saved");
  const logged = readFileSync(log, "utf8").split("\n").map(line => line.match(/\[webcrypto\] master key: .*$/)?.[0]).filter(Boolean);
  const reads = seamReads();
  keychainLines += reads.length;
  console.log(`${phase}: ${q(seen.results)}\n${phase} log: ${q(logged)}\n${phase} keychain seam: ${q(reads)}`);
  assert.notEqual(seen.refused, true, "the app did not take its key from the keychain seam before the page loaded, so the page used no key");
  assert.equal(seen.webKit, true, "the fixture must run on WebKit");
  assert.deepEqual(logged, [`[webcrypto] master key: ${source}`, "[webcrypto] master key: requested by WebKit"], "WebKit must ask the app for its key");
  assert.deepEqual(reads, ["find safe-storage found", ...(source === "migrated" ? ["find webcrypto found"] : []), `resolved ${source}`]);
  assert.deepEqual(seen.results.map(({ name }) => name), ["page", "worker"]);
  for (const outcome of seen.results) expected(outcome);
};

const works = state => outcome => assert.deepEqual(outcome, { name: outcome.name, state, usable: true, extractable: false });
const shut = outcome => {
  assert.equal(outcome.usable, false, `${outcome.name}: the stored key must not open under another key`);
  assert(["stored earlier", "failed to read"].includes(outcome.state), `${outcome.name}: ${outcome.state}`);
};

try {
  await run("store", { source: "migrated", expected: works("stored now") });
  console.log("PASS a page and a service worker store non-extractable keys under the app's key");
  await run("restart", { source: "file", expected: works("stored earlier") });
  console.log("PASS the stored keys work after a restart without reading the old item again");
  rmSync(join(engineData, "WebCrypto Master Key"));
  seed("Test WebCrypto Master Key");
  await run("replaced", { source: "migrated", expected: shut });
  console.log("PASS the stored keys stop opening when the app hands WebKit a different key");
} catch (error) {
  console.log(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (instance) await instance.quit({ graceful: false }).catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
