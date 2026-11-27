import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../lib/instance.mjs";

const [oldArgument, newArgument] = process.argv.slice(2);
const release = process.argv.slice(4).includes("--release");
if (!oldArgument || !newArgument) throw new Error("Usage: node scripts/personal/webkit-upgrade-smoke.mjs <old Ardia.app> <new Ardia.app> [--release]");
const oldApp = resolve(oldArgument);
const newApp = resolve(newArgument);
const buildOf = app => execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
const oldBuild = buildOf(oldApp);
const newBuild = buildOf(newApp);
if (release) assert(Number(oldBuild) < Number(newBuild), `a release upgrade check must approve in an older build, not ${oldBuild} before ${newBuild}`);
console.log(`Approving in build ${oldBuild}, then checking build ${newBuild} on the same data`);

const scratch = mkdtempSync(join(tmpdir(), "ardia-webkit-upgrade-"));
const extension = join(scratch, "extension");
const data = join(scratch, "data");
const token = randomBytes(16).toString("hex");
mkdirSync(extension);
const manifest = {
  manifest_version: 3,
  name: "Ardia upgrade fixture",
  version: "1.0.0",
  description: "Synthetic extension that checks an approval survives an update.",
  permissions: ["storage", "scripting", "tabs"],
  host_permissions: ["http://127.0.0.1/*"],
  background: { scripts: ["background.js"], persistent: false },
  content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" }],
};
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
for (let folder = 0; folder < 60; folder++) {
  const directory = join(extension, "static", String(folder));
  mkdirSync(directory, { recursive: true });
  for (let file = 0; file < 300; file++) writeFileSync(join(directory, `${file}.txt`), `${folder}/${file}`.padEnd(256, "."));
}
writeFileSync(join(extension, "background.js"), `
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.kind !== "fixture") return false;
  (async () => {
    if (message.token) await chrome.storage.local.set({ token: message.token });
    const saved = await chrome.storage.local.get("token");
    const result = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, func: () => location.href });
    const access = await chrome.permissions.getAll();
    respond({
      token: saved.token ?? null,
      runtimeId: chrome.runtime.id,
      baseURL: chrome.runtime.getURL(""),
      scriptedURL: result[0].result,
      permissions: [...access.permissions].sort(),
      origins: [...access.origins].sort(),
    });
  })().catch(error => respond({ error: error.message }));
  return true;
});
`);
writeFileSync(join(extension, "content.js"), `
document.documentElement.dataset.injected = document.readyState;
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ kind: "fixture", token: document.documentElement.dataset.token ?? null }).then(reply => {
    document.documentElement.dataset.extensionFixture = JSON.stringify(reply ?? { error: "no reply" });
  }).catch(error => {
    document.documentElement.dataset.extensionFixture = JSON.stringify({ error: error.message });
  });
}, { once: true });
`);

let served = "approval";
const server = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html data-served="${served}"${served === "approval" ? ` data-token="${token}"` : ""}><title>WebKit upgrade fixture</title><p>Isolated upgrade test</p>`);
});
await new Promise((done, fail) => {
  server.on("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const base = `http://127.0.0.1:${server.address().port}`;
const elsewhere = `http://localhost:${server.address().port}/elsewhere`;
const restored = [
  { id: "fixture", windowId: "first", path: "/approved" },
  { id: "second", windowId: "second", path: "/second" },
];
const unloaded = [
  { id: "behind-first", windowId: "first", path: "/behind-first" },
  { id: "behind-second", windowId: "second", path: "/behind-second" },
];
const initial = session({
  windows: [{ id: "first" }, { id: "second", frame: [160, 120, 1100, 700] }],
  tabs: [...restored, ...unloaded].map(({ id, windowId, path }) => ({ id, windowId, url: `${base}${path === "/approved" ? "/start" : path}`, title: id })),
  settings: { websiteEngines: { [base]: "webkit", [new URL(elsewhere).origin]: "chromium" }, engineSwitchCarriesSiteData: false },
});

let instance;
let approving = true;
const q = JSON.stringify;
const engine = (name, args = {}, timeout = 120000) => {
  assert(approving || name === "webKit.extensionList", `the upgraded app must not need ${name}`);
  return instance.eval(`return ac.engine.call(${q(name)}, ${q(args)})`, { timeout });
};
const value = (id, expression) => instance.eval(`return ac.webviews.get(${q(id)})?.evaluate(${q(`post("result", JSON.stringify(${expression}))`)}) ?? null`);
const until = async (name, test, timeout = 15000) => {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    if (!instance.alive) throw new Error(`Test app exited while waiting for ${name}`);
    try {
      const answer = await test();
      if (answer) return answer;
    } catch (error) { last = error.message; }
  }
  throw new Error(`Timed out waiting for ${name}${last ? `: ${last}` : ""}`);
};
const pageLoaded = (id, path, phase) => until(`the ${phase} page at ${path}`, () => value(id, `location.pathname === ${q(path)} && document.documentElement.dataset.served === ${q(phase)} && document.readyState === "complete"`), 30000);
const navigate = (id, url) => instance.eval(`ac.store.getState().navigate(${q(id)}, ${q(url)}, { userInitiated: true }); return true`);
const activate = id => instance.eval(`ac.store.getState().activate(${q(id)}); return true`);
const open = async (path, phase) => {
  served = phase;
  await navigate("fixture", `${base}${path}`);
  await pageLoaded("fixture", path, phase);
};
const extensionReply = async (id, path) => {
  assert.equal(await value(id, "document.documentElement.dataset.injected ?? null"), "loading", "the content script must be injected at document start");
  const reply = await until("the extension's reply", () => value(id, "document.documentElement.dataset.extensionFixture ? JSON.parse(document.documentElement.dataset.extensionFixture) : null"));
  assert.equal(reply.error, undefined, `${id}: ${reply.error}`);
  assert.equal(reply.scriptedURL, `${base}${path}`, "script injection must reach the page");
  assert.equal(reply.token, token, "the value saved in extension storage must be readable");
  return reply;
};
const listed = async () => (await engine("webKit.extensionList", { profile: "" })).extensions;
const approvalOf = row => Object.fromEntries(["id", "path", "fingerprint", "name", "version", "enabled", "loaded", "requestedPermissions", "requestedOrigins", "grantedPermissions", "grantedOrigins", "errors"].map(key => [key, row[key]]));
const chromiumPages = async () => (await instance.targets()).filter(target => target.type === "page" && target.url === elsewhere).length;
const coveredByNewTab = () => instance.eval(`const s = ac.store.getState(), w = s.windows.first, front = w.activeTabIds[w.profileId]; return !${q([...restored, ...unloaded].map(tab => tab.id))}.includes(front) && ["loaded", "adopted"].includes(s.tabs.fixture?.page.kind)`);
const savedTabs = () => {
  const { tabs } = JSON.parse(readFileSync(join(data, "session.json"), "utf8"));
  return Array.isArray(tabs) ? tabs : Object.values(tabs);
};
const stored = () => {
  const root = join(data, "Chromium", "WebKit Extensions");
  const profiles = readdirSync(root);
  assert.equal(profiles.length, 1, `expected one WebKit extension profile folder, found ${q(profiles)}`);
  assert.match(profiles[0], /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i);
  const folder = join(root, profiles[0]);
  const packages = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(join(folder, entry.name)).map(name => `${entry.name}/${name}`)).sort();
  return { profile: profiles[0], record: readFileSync(join(folder, "extensions.json"), "latin1"), packages };
};
const start = async (app, extra) => {
  instance = await launch(app, { data, ...(release ? { probe: true, js: "none" } : {}), ...extra });
};
const quit = async () => {
  const { how } = await instance.quit();
  instance = null;
  assert.equal(how, "quit", "the app must quit cleanly so that its data is saved");
};
const failures = [];
const check = async (name, body) => {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error.message}`);
  }
};

try {
  await start(oldApp, { onboarded: true, session: initial });
  await pageLoaded("fixture", "/start", "approval");
  await pageLoaded("second", "/second", "approval");
  const inspection = await engine("webKit.extensionInspect", { path: extension });
  assert.equal(inspection.name, manifest.name);
  const approval = await engine("webKit.extensionLoad", { profile: "", path: extension, fingerprint: inspection.fingerprint, permissions: manifest.permissions, origins: manifest.host_permissions });
  await open("/approved", "approval");
  const before = await extensionReply("fixture", "/approved");
  const rows = await listed();
  assert.equal(rows.length, 1);
  const approved = approvalOf(rows[0]);
  assert.equal(approved.id, approval.id);
  assert.equal(approved.enabled, true);
  assert.equal(approved.loaded, true);
  assert.deepEqual(approved.grantedPermissions, [...manifest.permissions].sort());
  assert.deepEqual(approved.grantedOrigins, manifest.host_permissions);
  assert.deepEqual(approved.errors, []);
  assert.equal(before.baseURL, `webkit-extension://${approved.id}/`);
  await until("the saved session", () => readFileSync(join(data, "session.json"), "utf8").includes("/approved"));
  console.log(`Approved in build ${oldBuild}: ${q(approved)}`);
  console.log(`Seen by the extension: ${q({ ...before, token: "saved" })}`);
  await quit();
  const storedByOldBuild = stored();
  assert.deepEqual(storedByOldBuild.packages, [`${approved.id}/${approved.fingerprint}`]);
  console.log("PASS the older build approves the extension, saves a value, injects its content script and quits cleanly");

  approving = false;
  served = "restored";
  if (!release) writeFileSync(join(data, "release-notes.json"), JSON.stringify({ version: 1, lastVersion: "0.0.0", pending: null }));
  await start(newApp, { instance: { releaseNotes: true }, switches: "--proxy-server=http://127.0.0.1:9" });
  await check("the update opens its release notes over a restored WebKit tab", async () => {
    await until("the release notes tab over the restored tab", coveredByNewTab);
  });
  for (const { id, path } of restored) {
    await check(`the restored tab in the ${id === "fixture" ? "covered" : "other"} window gets a reply without a reload`, async () => {
      await pageLoaded(id, path, "restored");
      await extensionReply(id, path);
    });
  }
  for (const { id, windowId, path } of unloaded) {
    await check(`the unloaded tab in the ${windowId} window gets a reply without a reload once opened`, async () => {
      await activate(id);
      await pageLoaded(id, path, "restored");
      await extensionReply(id, path);
    });
  }
  await check("the approval is listed unchanged, enabled and loaded, with no review", async () => {
    let current = [];
    await until("the extension to load", async () => {
      current = await listed();
      return current.some(row => row.id === approved.id && row.loaded);
    }).catch(error => { throw new Error(`${error.message}; listed: ${q(current.map(approvalOf))}`); });
    console.log(`Listed by build ${newBuild}: ${q(current.map(approvalOf))}`);
    assert.equal(current.length, 1);
    assert.deepEqual(approvalOf(current[0]), approved);
  });
  await check("a fresh page load keeps the context id, granted access, stored value and content script", async () => {
    await open("/fresh", "fresh");
    const after = await extensionReply("fixture", "/fresh");
    for (const key of ["runtimeId", "baseURL", "permissions", "origins"]) assert.deepEqual(after[key], before[key], key);
  });
  await check("both windows show a Chromium page before the next launch", async () => {
    for (const { id } of restored) {
      await activate(id);
      await navigate(id, elsewhere);
    }
    await until("the Chromium pages", async () => await chromiumPages() === restored.length, 30000);
    await until("the saved session", () => restored.every(({ id }) => savedTabs().some(tab => tab.id === id && tab.url === elsewhere)));
  });
  await quit();

  served = "relaunch";
  await start(newApp, {});
  let elapsed;
  await check("the first extension list of a launch that opened no WebKit page already shows the approved row", async () => {
    const started = performance.now();
    const answer = await engine("webKit.extensionList", { profile: "" }, 60000);
    elapsed = Math.round(performance.now() - started);
    console.log(`First list answer from build ${newBuild} after ${elapsed} ms: ${q(answer.extensions.map(approvalOf))}`);
    assert.deepEqual(answer.extensions.map(approvalOf), [approved]);
  });
  await check("the first extension list answers within 15 seconds", async () => {
    assert(elapsed !== undefined, "the first extension list never answered");
    assert(elapsed < 15000, `it took ${elapsed} ms`);
  });
  await check("that launch showed the Chromium pages", async () => {
    await until("the restored Chromium pages", async () => await chromiumPages() === restored.length, 30000);
  });
  await quit();
  await check("the stored approval and installed package are untouched on disk", async () => {
    assert.deepEqual(stored(), storedByOldBuild);
  });
} finally {
  if (instance) await instance.quit();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  console.log(`Test files: ${scratch}`);
}
if (failures.length) {
  console.log(`FAIL ${failures.length} upgrade check(s) from build ${oldBuild} to build ${newBuild}: ${failures.join("; ")}`);
  process.exitCode = 1;
} else console.log(`PASS the extension approval survived from build ${oldBuild} to build ${newBuild}`);
