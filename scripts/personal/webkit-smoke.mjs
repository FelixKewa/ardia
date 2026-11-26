import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../lib/instance.mjs";

const app = process.argv[2];
const release = process.argv.slice(3).includes("--release");
if (!app) throw new Error("Usage: node scripts/personal/webkit-smoke.mjs <Ardia.app> [--release]");
const scratch = mkdtempSync(join(tmpdir(), "ardia-webkit-smoke-"));
const extension = join(scratch, "extension");
const data = join(scratch, "data");
mkdirSync(extension);
const manifest = {
  manifest_version: 3,
  name: "Ardia isolated extension fixture",
  version: "1.0.0",
  icons: { "1": "icon.png" },
  permissions: ["storage", "scripting", "tabs"],
  host_permissions: ["http://127.0.0.1/*"],
  background: { scripts: ["background.js"], persistent: false },
  content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["한글.js"], run_at: "document_start" }],
};
writeFileSync(join(extension, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438DwHwAGgAJ/EEwb4QAAAABJRU5ErkJggg==", "base64"));
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
writeFileSync(join(extension, "background.js"), `
const started = (async () => {
  const saved = await chrome.storage.local.get("boots");
  await chrome.storage.local.set({ boots: (saved.boots || 0) + 1 });
  return true;
})().catch(error => ({ failure: error.message }));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.kind !== "fixture") return false;
  (async () => {
    const initialized = await started;
    if (initialized !== true) throw new Error(initialized.failure);
    const saved = await chrome.storage.local.get("count");
    const count = (saved.count || 0) + 1;
    await chrome.storage.local.set({ count });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => { document.documentElement.dataset.scripted = "yes"; return location.href; },
    });
    respond({ count, senderId: sender.tab.id, activeIds: tabs.map(tab => tab.id), url: result[0].result });
  })().catch(error => respond({ error: error.message }));
  return true;
});
`);
writeFileSync(join(extension, "한글.js"), `
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ kind: "fixture" }).then(reply => {
    document.documentElement.dataset.extensionFixture = JSON.stringify(reply);
  }).catch(error => {
    document.documentElement.dataset.extensionFixture = JSON.stringify({ error: error.message });
  });
}, { once: true });
`);
const server = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end("<!doctype html><title>WebKit fixture</title><p>Isolated extension test</p>");
});
await new Promise((done, fail) => {
  server.on("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const base = `http://127.0.0.1:${server.address().port}`;
const initial = session({
  profiles: ["Personal", "Other"],
  tabs: [{ id: "fixture", url: `${base}/fixture`, title: "WebKit fixture" }],
  settings: { websiteEngines: { [base]: "webkit" }, engineSwitchCarriesSiteData: false },
});
let instance;
const q = JSON.stringify;
const engine = (name, args = {}) => instance.eval(`return ac.engine.call(${q(name)}, ${q(args)})`);
const value = expression => instance.eval(`return ac.webviews.get("fixture")?.evaluate(${q(`post("result", JSON.stringify(${expression}))`)}) ?? null`);
const until = async (name, test, timeout = 15000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    if (!instance.alive) throw new Error(`Test app exited while waiting for ${name}`);
    const answer = await test();
    if (answer) return answer;
  }
  throw new Error(`Timed out waiting for ${name}`);
};
const reload = async () => {
  const marker = `navigation-${Date.now()}`;
  await instance.eval(`ac.store.getState().navigate("fixture", ${q(`${base}/${marker}`)}, { userInitiated: true }); return true`);
  await until(marker, () => value(`location.pathname === ${q(`/${marker}`)} && document.readyState === "complete"`));
};
const result = () => until("extension response", () => value("document.documentElement.dataset.extensionFixture ? JSON.parse(document.documentElement.dataset.extensionFixture) : null"));
const assertIcon = row => {
  assert.match(row.icon, /^data:image\/png;base64,/);
  const png = Buffer.from(row.icon.split(",")[1], "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
};
const assertResponse = async previousCount => {
  const response = await result();
  assert.equal(response.error, undefined, response.error);
  assert(response.count > previousCount, "storage counter must survive reloads");
  assert(response.activeIds.includes(response.senderId), "active-tab query must return the WebKit page");
  assert(response.url.startsWith(base), "script must execute in the WebKit page");
  assert.equal(await value("document.documentElement.dataset.scripted"), "yes");
  return response.count;
};
const start = async first => {
  instance = await launch(resolve(app), { data, onboarded: true, ...(release ? { probe: true, js: "none" } : {}), ...(first ? { session: initial } : {}) });
  await until("WebKit page", () => value('document.title === "WebKit fixture"'));
  assert.equal((await instance.targets()).some(target => target.url.startsWith(base)), false, "fixture must not be a Chromium page");
};
try {
  await start(true);
  const inspection = await engine("webKit.extensionInspect", { path: extension });
  assert.equal(inspection.name, manifest.name);
  assert.match(inspection.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await engine("webKit.extensionList", { profile: "" })).available, true);
  const approval = { profile: "", path: extension, fingerprint: inspection.fingerprint, permissions: [], origins: [] };
  await assert.rejects(engine("webKit.extensionLoad", { ...approval, profile: "incognito:fixture@default" }), /private/i);
  await assert.rejects(engine("webKit.extensionLoad", { ...approval, fingerprint: "0".repeat(64) }), /changed|inspect/i);
  let loaded = await engine("webKit.extensionLoad", approval);
  const id = loaded.id;
  assert.equal(loaded.loaded, true);
  assertIcon(loaded);
  assert.equal((await engine("webKit.extensionList", { profile: "" })).extensions[0].icon, loaded.icon);
  assert.deepEqual(loaded.grantedOrigins, []);
  assert.deepEqual((await engine("webKit.extensionList", { profile: "other" })).extensions, []);
  await reload();
  assert.equal(await value("document.documentElement.dataset.extensionFixture ?? null"), null);
  console.log("PASS load requires inspected bytes; host access starts off; profiles are separate");

  const grants = { profile: "", id, permissions: manifest.permissions, origins: manifest.host_permissions };
  await engine("webKit.extensionGrant", grants);
  await reload();
  let count = await assertResponse(0);
  console.log("PASS document-start script, messaging, active-tab query, script injection and extension storage");

  await engine("webKit.extensionUnload", { profile: "", id });
  assert.equal((await engine("webKit.extensionList", { profile: "" })).extensions[0].icon, undefined);
  await reload();
  assert.equal(await value("document.documentElement.dataset.extensionFixture ?? null"), null);
  loaded = await engine("webKit.extensionLoad", { ...approval, permissions: grants.permissions, origins: grants.origins });
  assert.equal(loaded.id, id);
  await reload();
  count = await assertResponse(count);
  console.log("PASS disable removes injection; re-enable retains extension data");

  await instance.quit();
  instance = null;
  await start(false);
  await reload();
  count = await assertResponse(count);
  assertIcon((await engine("webKit.extensionList", { profile: "" })).extensions[0]);
  console.log("PASS grants and extension storage survive browser restart");

  manifest.version = "1.0.1";
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(engine("webKit.extensionLoad", approval), /changed|inspect/i);
  const updated = await engine("webKit.extensionInspect", { path: extension });
  await assert.rejects(engine("webKit.extensionLoad", { ...approval, fingerprint: updated.fingerprint, origins: ["https://denied.example/*"] }), /host|origin|permission/i);
  await reload();
  count = await assertResponse(count);
  loaded = await engine("webKit.extensionLoad", { ...approval, fingerprint: updated.fingerprint });
  assert.equal(loaded.id, id);
  assert.deepEqual(loaded.grantedOrigins, []);
  assert.deepEqual(loaded.grantedPermissions, []);
  await engine("webKit.extensionGrant", grants);
  await reload();
  await assertResponse(count);
  console.log("PASS inspected update resets grants and retains extension data");
} finally {
  if (instance) await instance.quit();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  console.log(`Test files: ${scratch}`);
}
