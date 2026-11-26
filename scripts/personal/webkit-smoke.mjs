import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, session, sleep } from "../lib/instance.mjs";

const app = process.argv[2];
const release = process.argv.slice(3).includes("--release");
if (!app) throw new Error("Usage: node scripts/personal/webkit-smoke.mjs <Ardia.app> [--release]");
const scratch = mkdtempSync(join(tmpdir(), "ardia-webkit-smoke-"));
const extension = join(scratch, "extension");
const data = join(scratch, "data");
const localPage = join(scratch, "local.html");
mkdirSync(extension);
writeFileSync(localPage, "<!doctype html><title>WebKit fixture</title><p>Isolated local file</p>");
const manifest = {
  manifest_version: 3,
  name: "Ardia isolated extension fixture",
  description: "Synthetic extension for the isolated WebKit smoke test",
  version: "1.0.0",
  icons: { "1": "icon.png" },
  permissions: ["storage", "scripting", "tabs"],
  host_permissions: ["http://127.0.0.1/*"],
  optional_host_permissions: ["http://*/*", "https://*/*"],
  background: { scripts: ["background.js"], persistent: false },
  content_scripts: [
    { matches: ["http://127.0.0.1/*", "http://localhost/*"], js: ["한글.js"], run_at: "document_start" },
    { matches: ["<all_urls>"], js: ["everywhere.js"], run_at: "document_start" },
  ],
};
writeFileSync(join(extension, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438DwHwAGgAJ/EEwb4QAAAABJRU5ErkJggg==", "base64"));
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
writeFileSync(join(extension, "background.js"), `
const started = (async () => {
  const saved = await chrome.storage.local.get(["boots", "owner"]);
  await chrome.storage.local.set({ boots: (saved.boots || 0) + 1, owner: saved.owner || crypto.randomUUID() });
  return true;
})().catch(error => ({ failure: error.message }));
const contains = origin => chrome.permissions.contains({ origins: [origin] }).then(Boolean, () => false);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.kind !== "fixture") return false;
  (async () => {
    const initialized = await started;
    if (initialized !== true) throw new Error(initialized.failure);
    const saved = await chrome.storage.local.get(["count", "owner"]);
    const count = (saved.count || 0) + 1;
    await chrome.storage.local.set({ count });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => { document.documentElement.dataset.scripted = "yes"; return location.href; },
    });
    const access = {
      origins: (await chrome.permissions.getAll()).origins,
      web: await contains("https://unvisited.example/*"),
      excluded: await Promise.all(["<all_urls>", "file:///*", "webkit-extension://*/*"].map(contains)),
    };
    respond({ count, owner: saved.owner, access, senderId: sender.tab.id, activeIds: tabs.map(tab => tab.id), url: result[0].result });
  })().catch(error => respond({ error: error.message }));
  return true;
});
`);
writeFileSync(join(extension, "everywhere.js"), `document.documentElement.dataset.everywhere = "yes";\n`);
writeFileSync(join(extension, "한글.js"), `
document.documentElement.dataset.injected = "yes";
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ kind: "fixture" }).then(reply => {
    document.documentElement.dataset.extensionFixture = JSON.stringify(reply);
  }).catch(error => {
    document.documentElement.dataset.extensionFixture = JSON.stringify({ error: error.message });
  });
}, { once: true });
`);
const serveFixture = (request, response) => {
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end("<!doctype html><title>WebKit fixture</title><p>Isolated extension test</p>");
};
const server = createServer(serveFixture);
await new Promise((done, fail) => {
  server.on("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const base = `http://127.0.0.1:${server.address().port}`;
const broadServer = createServer(serveFixture);
await new Promise((done, fail) => {
  broadServer.on("error", fail);
  broadServer.listen(0, "localhost", done);
});
const broadBase = `http://localhost:${broadServer.address().port}`;
const initial = session({
  profiles: ["Personal", "Other", "Preexisting"],
  tabs: [{ id: "fixture", url: `${base}/fixture`, title: "WebKit fixture" }],
  settings: { websiteEngines: { [base]: "webkit", [broadBase]: "webkit" }, engineSwitchCarriesSiteData: false },
});
const WEBSITES = ["http://*/*", "https://*/*"];
const REFUSED_ORIGINS = ["<all_urls>", "*://*/*", "file:///*", "webkit-extension://*/*"];
const REFUSAL = /declared APIs and explicitly approved website access/i;
const LEGACY_FIELDS = ["id", "path", "fingerprint", "name", "version", "enabled", "requestedPermissions", "requestedOrigins", "permissions", "origins"];
const savedRoot = () => join(data, "Chromium", "WebKit Extensions");
const sharedFile = () => join(savedRoot(), "Shared Approvals", "extensions.json");
const rewriteAsLegacyRecords = expected => {
  let rewritten = 0;
  for (const folder of readdirSync(savedRoot())) {
    const file = join(savedRoot(), folder, "extensions.json");
    if (folder === "Shared Approvals" || !existsSync(file)) continue;
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.extensions = saved.extensions.map(record => {
      const legacy = Object.fromEntries(LEGACY_FIELDS.map(field => [field, record[field]]));
      assert.deepEqual(sorted(Object.keys(JSON.parse(JSON.stringify(legacy)))), sorted(LEGACY_FIELDS), "a saved record has every 1001 field");
      if (Object.keys(record).length > LEGACY_FIELDS.length) rewritten++;
      return legacy;
    });
    writeFileSync(file, JSON.stringify(saved));
  }
  assert.equal(rewritten, expected, "the saved approvals were rewritten to the 1001 shape");
};
let instance;
const q = JSON.stringify;
const sorted = values => [...values].sort();
const engine = (name, args = {}) => instance.eval(`return ac.engine.call(${q(name)}, ${q(args)})`);
const value = (expression, tabId = "fixture") => instance.eval(`return ac.webviews.get(${q(tabId)})?.evaluate(${q(`post("result", JSON.stringify(${expression}))`)}) ?? null`);
const until = async (name, test, timeout = 15000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
    if (!instance.alive) throw new Error(`Test app exited while waiting for ${name}`);
    const answer = await test();
    if (answer) return answer;
  }
  throw new Error(`Timed out waiting for ${name}`);
};
const reload = async (tabId = "fixture", origin = base) => {
  const marker = `navigation-${Date.now()}`;
  await instance.eval(`ac.store.getState().navigate(${q(tabId)}, ${q(`${origin}/${marker}`)}, { userInitiated: true }); return true`);
  await until(marker, () => value(`location.pathname === ${q(`/${marker}`)} && document.readyState === "complete"`, tabId));
};
const result = (tabId = "fixture") => until("extension response", () => value("document.documentElement.dataset.extensionFixture ? JSON.parse(document.documentElement.dataset.extensionFixture) : null", tabId));
const injection = tabId => value("[document.documentElement.dataset.injected ?? null, document.documentElement.dataset.everywhere ?? null, document.documentElement.dataset.extensionFixture ?? null, document.documentElement.dataset.scripted ?? null]", tabId);
const assertUntouched = async (tabId, why) => assert.deepEqual(await injection(tabId), [null, null, null, null], why);
const assertIcon = row => {
  assert.match(row.icon, /^data:image\/png;base64,/);
  const png = Buffer.from(row.icon.split(",")[1], "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
};
const respondsOn = async (tabId, origin = base) => {
  await reload(tabId, origin);
  const response = await result(tabId);
  assert.equal(response.error, undefined, response.error);
  assert(response.url.startsWith(origin), "script must execute in the WebKit page");
  assert.deepEqual((await injection(tabId)).slice(0, 2), ["yes", "yes"], "both content scripts run at document start");
  return response;
};
const assertAllWebsites = (response, where) => {
  assert.deepEqual(sorted(response.access.origins), WEBSITES, `${where}: the extension holds exactly the HTTP and HTTPS patterns`);
  assert.equal(response.access.web, true, `${where}: an unvisited website is covered`);
  assert.deepEqual(response.access.excluded, [false, false, false], `${where}: <all_urls>, file and extension URLs stay excluded`);
};
const assertResponse = async (previousCount, checkCurrentWindow = true) => {
  const response = await result();
  assert.equal(response.error, undefined, response.error);
  assert(response.count > previousCount, "storage counter must survive reloads");
  if (checkCurrentWindow) assert(response.activeIds.includes(response.senderId), "active-tab query must return the WebKit page");
  assert(response.url.startsWith(base), "script must execute in the WebKit page");
  assert.equal(await value("document.documentElement.dataset.scripted"), "yes");
  return response.count;
};
const assertWebKitPage = async prefix => assert.equal((await instance.targets()).some(target => target.url.startsWith(prefix)), false, `${prefix} must not be a Chromium page`);
const start = async first => {
  instance = await launch(resolve(app), { data, onboarded: true, ...(release ? { probe: true, js: "none" } : {}), ...(first ? { session: initial } : {}) });
  await until("WebKit page", () => value('document.title === "WebKit fixture"'));
  await assertWebKitPage(base);
};
const restart = async (whileQuit = () => {}) => {
  await instance.quit();
  instance = null;
  whileQuit();
  await start(false);
};
const openFixture = async (profileId, origin = base, kind = "main") => {
  const tabId = await instance.eval(`const windowId = ac.store.getState().createWindow({ profileId: ${q(profileId)}, kind: ${q(kind)}, url: ${q(`${origin}/opened`)} }); const opened = ac.store.getState().windows[windowId]; if (opened.kind !== ${q(kind)}) throw new Error("Wrong fixture window kind"); return opened.tabIds[0]`);
  await until(`page ${tabId}`, () => value('document.title === "WebKit fixture" && document.readyState === "complete"', tabId));
  await assertWebKitPage(origin);
  return tabId;
};
const createProfile = name => instance.eval(`return ac.store.getState().createProfile({ name: ${q(name)} })`);
try {
  await start(true);
  const inspection = await engine("webKit.extensionInspect", { path: extension });
  assert.equal(inspection.name, manifest.name);
  assert.match(inspection.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await engine("webKit.extensionList", { profile: "" })).available, true);
  const rowsFor = async profile => (await engine("webKit.extensionList", { profile })).extensions;
  const profileRow = async profile => {
    const rows = (await rowsFor(profile)).filter(row => row.path === inspection.path);
    assert(rows.length <= 1, `one approval per folder in ${profile}`);
    return rows[0];
  };
  const restored = (profile, allProfiles = true) => until(`${allProfiles ? "shared" : "local"} extension in ${profile || "default"}`, async () => {
    const row = await profileRow(profile);
    assert.equal(row?.errors?.length ?? 0, 0, JSON.stringify(row?.errors));
    return row?.enabled && row.loaded && row.allProfiles === allProfiles ? row : null;
  });
  const approval = { profile: "", path: extension, fingerprint: inspection.fingerprint, permissions: [], origins: [] };
  await assert.rejects(engine("webKit.extensionLoad", { ...approval, profile: "incognito:fixture@default" }), /private/i);
  await assert.rejects(engine("webKit.extensionLoad", { ...approval, fingerprint: "0".repeat(64) }), /changed|inspect/i);
  let loaded = await engine("webKit.extensionLoad", approval);
  const id = loaded.id;
  assert.equal(loaded.loaded, true);
  assertIcon(loaded);
  assert.equal((await engine("webKit.extensionList", { profile: "" })).extensions[0].icon, loaded.icon);
  assert.deepEqual(loaded.grantedOrigins, []);
  assert.deepEqual(await rowsFor("other"), []);
  await reload();
  await assertUntouched("fixture", "host access starts off");
  console.log("PASS load requires inspected bytes; host access starts off; profiles are separate");

  const grants = { profile: "", id, permissions: manifest.permissions, origins: manifest.host_permissions };
  await engine("webKit.extensionGrant", grants);
  await reload();
  let count = await assertResponse(0);
  const exact = (await result()).access;
  assert.deepEqual(exact.origins, manifest.host_permissions);
  assert.equal(exact.web, false);
  assert.deepEqual(exact.excluded, [false, false, false]);
  console.log("PASS document-start script, messaging, active-tab query, script injection and extension storage");

  await engine("webKit.extensionUnload", { profile: "", id });
  assert.equal((await engine("webKit.extensionList", { profile: "" })).extensions[0].icon, undefined);
  await reload();
  await assertUntouched("fixture", "a disabled extension is not injected");
  loaded = await engine("webKit.extensionLoad", { ...approval, permissions: grants.permissions, origins: grants.origins });
  assert.equal(loaded.id, id);
  await reload();
  count = await assertResponse(count);
  console.log("PASS disable removes injection; re-enable retains extension data");

  await restart();
  await reload();
  count = await assertResponse(count);
  assertIcon((await engine("webKit.extensionList", { profile: "" })).extensions[0]);
  console.log("PASS grants and extension storage survive browser restart");

  manifest.version = "1.0.1";
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(engine("webKit.extensionLoad", approval), /changed|inspect/i);
  const updated = await engine("webKit.extensionInspect", { path: extension });
  await assert.rejects(engine("webKit.extensionLoad", { ...approval, fingerprint: updated.fingerprint, origins: ["http://denied.example/*"] }), REFUSAL);
  await reload();
  count = await assertResponse(count);
  loaded = await engine("webKit.extensionLoad", { ...approval, fingerprint: updated.fingerprint });
  assert.equal(loaded.id, id);
  assert.deepEqual(loaded.grantedOrigins, []);
  assert.deepEqual(loaded.grantedPermissions, []);
  await engine("webKit.extensionGrant", grants);
  await reload();
  count = await assertResponse(count);
  console.log("PASS inspected update resets grants and retains extension data");

  const local = { ...approval, fingerprint: updated.fingerprint, permissions: grants.permissions, origins: grants.origins, allProfiles: false, allWebsites: false };
  const ownTab = await openFixture("preexisting");
  await assertUntouched(ownTab, "a profile without its own approval starts without the extension");
  const own = await engine("webKit.extensionLoad", { ...local, profile: "preexisting" });
  assert.notEqual(own.id, id, "a separate local approval has its own context identity");
  const ownResult = await respondsOn(ownTab);
  assert.equal(ownResult.count, 1);
  const ownBroadTab = await openFixture("preexisting", broadBase);
  await assertUntouched(ownBroadTab, "a local exact-host approval does not reach the second hostname");
  console.log("PASS an existing profile's own approval has a separate identity and storage");

  await restart(() => rewriteAsLegacyRecords(2));
  for (const [profile, contextId] of [["", id], ["preexisting", own.id]]) {
    const row = await restored(profile, false);
    assert.equal(row.id, contextId, `1001 record in ${profile || "default"}: identity`);
    assert.equal(row.allWebsites, false);
    assert.deepEqual(sorted(row.grantedPermissions), sorted(grants.permissions), `1001 record in ${profile || "default"}: permissions`);
    assert.deepEqual(row.grantedOrigins, grants.origins, `1001 record in ${profile || "default"}: websites`);
  }
  await reload();
  count = await assertResponse(count, false);
  const ownLegacy = await respondsOn(ownTab);
  assert.equal(ownLegacy.owner, ownResult.owner);
  assert(ownLegacy.count > ownResult.count);
  assert.deepEqual(ownLegacy.access.origins, grants.origins);
  console.log("PASS saved approvals in the 1001 record shape still load with their grants and data");

  const originalOwner = (await result()).owner;
  const broadTab = await openFixture("default", broadBase);
  await assertUntouched(broadTab, "an unselected hostname starts without extension injection");
  const broad = await engine("webKit.extensionInspect", { path: extension, allWebsites: true });
  assert.equal(broad.allWebsites, true);
  assert.equal(broad.canUseAllWebsites, true);
  const sharedApproval = { ...approval, fingerprint: broad.fingerprint, permissions: grants.permissions, allWebsites: true, allProfiles: true };
  const assertShared = (row, where) => {
    assert.equal(row?.allProfiles, true, `${where}: shared`);
    assert.equal(row.allWebsites, true, `${where}: all websites`);
    assert.deepEqual(sorted(row.grantedOrigins), WEBSITES, `${where}: explicit patterns`);
    assert.deepEqual(sorted(row.grantedPermissions), sorted(grants.permissions), `${where}: shared permissions`);
  };
  const shared = await engine("webKit.extensionLoad", sharedApproval);
  assert.equal(shared.id, id);
  assertShared(shared, "approval reply");
  assert.deepEqual(shared.localGrantedOrigins, grants.origins);
  assert.deepEqual(sorted(shared.localGrantedPermissions), sorted(grants.permissions));
  const broadResult = await respondsOn(broadTab, broadBase);
  assert.equal(broadResult.owner, originalOwner);
  assertAllWebsites(broadResult, "default");
  await reload();
  count = await assertResponse(count, false);
  assert.equal((await result()).owner, originalOwner);
  const otherRow = await restored("other");
  assert.equal(otherRow.id, id);
  assertShared(otherRow, "existing profile");
  assert.equal(otherRow.localGrantedOrigins, undefined);
  const ownRow = await restored("preexisting");
  assert.equal(ownRow.id, own.id, "sharing keeps an existing profile's context identity");
  assertShared(ownRow, "existing profile with its own approval");
  assert.deepEqual(ownRow.localGrantedOrigins, grants.origins);
  const ownShared = await respondsOn(ownTab);
  assert.equal(ownShared.owner, ownResult.owner, "sharing keeps an existing profile's own extension data");
  assert(ownShared.count > ownResult.count);
  assert.equal((await respondsOn(ownBroadTab, broadBase)).owner, ownResult.owner);
  const otherTab = await openFixture("other");
  const otherResult = await respondsOn(otherTab);
  assert.notEqual(otherResult.owner, originalOwner);
  const otherBroadTab = await openFixture("other", broadBase);
  const otherBroad = await respondsOn(otherBroadTab, broadBase);
  assert.equal(otherBroad.owner, otherResult.owner);
  assertAllWebsites(otherBroad, "existing profile");
  const futureProfile = await createProfile("Future fixture");
  const futureTab = await openFixture(futureProfile);
  const futureResult = await respondsOn(futureTab);
  const futureRow = await restored(futureProfile);
  assert.equal(futureRow.id, id);
  assertShared(futureRow, "new profile");
  const futureBroadTab = await openFixture(futureProfile, broadBase);
  const futureBroad = await respondsOn(futureBroadTab, broadBase);
  assert.equal(futureBroad.owner, futureResult.owner);
  assertAllWebsites(futureBroad, "new profile");
  assert.equal(new Set([originalOwner, ownResult.owner, otherResult.owner, futureResult.owner]).size, 4, "every profile has its own extension storage");
  console.log("PASS shared approval reaches the second hostname in existing and newly created profiles");

  for (const origin of REFUSED_ORIGINS) {
    await assert.rejects(engine("webKit.extensionGrant", { ...grants, origins: [origin], allProfiles: true }), REFUSAL, `shared grant of ${origin}`);
    await assert.rejects(engine("webKit.extensionLoad", { ...local, origins: [origin] }), REFUSAL, `local load of ${origin}`);
  }
  const forced = await engine("webKit.extensionLoad", { ...sharedApproval, origins: ["<all_urls>"] });
  assertShared(forced, "an all-websites request that names <all_urls>");
  const catalog = JSON.parse(readFileSync(join(data, "Chromium", "WebKit Extensions", "Shared Approvals", "extensions.json"), "utf8"));
  assert.deepEqual(catalog.extensions.map(record => sorted(record.origins)), [WEBSITES], "the saved shared approval holds only HTTP and HTTPS patterns");
  await restored("other");
  await restored("preexisting");
  await restored(futureProfile);
  const fileTab = await openFixture("default");
  assert.deepEqual((await respondsOn(fileTab)).access.excluded, [false, false, false]);
  const fileAddress = pathToFileURL(localPage).href;
  await instance.eval(`ac.store.getState().updateTab(${q(fileTab)}, { engine: "webkit" }); ac.store.getState().navigate(${q(fileTab)}, ${q(fileAddress)}, { userInitiated: true }); return true`);
  await until("local file page", () => value('location.protocol === "file:" && document.title === "WebKit fixture" && document.readyState === "complete"', fileTab));
  await assertWebKitPage("file:");
  assert.equal(await value("navigator.vendor", fileTab), "Apple Computer, Inc.", "the local file page is rendered by WebKit");
  await sleep(500);
  await assertUntouched(fileTab, "all-websites access excludes local files");
  console.log("PASS all-websites access is explicit HTTP/HTTPS patterns; <all_urls>, file and extension URLs stay excluded");

  for (const [profileId, origin] of [["default", base], ["default", broadBase], ["other", base]]) {
    const privateTab = await openFixture(profileId, origin, "private");
    const privateProfile = await instance.eval(`return ac.store.getState().tabs[${q(privateTab)}].profileId`);
    assert.match(privateProfile, /^incognito:/);
    await sleep(500);
    await assertUntouched(privateTab, `private ${profileId} pages stay excluded on ${origin}`);
    await assert.rejects(engine("webKit.extensionList", { profile: privateProfile }), /private/i);
    await assert.rejects(engine("webKit.extensionLoad", { ...sharedApproval, profile: privateProfile }), /private/i);
  }
  await assert.rejects(engine("webKit.extensionUnload", { profile: "", id }), /all regular profiles/i);
  await assert.rejects(engine("webKit.extensionGrant", grants), /all regular profiles/i);
  await assert.rejects(engine("webKit.extensionUnload", { profile: "other", id }), /all regular profiles/i);
  console.log("PASS private windows stay excluded; profile-only calls cannot change shared access");

  const defaultBefore = (await respondsOn("fixture")).count;
  const otherBefore = (await respondsOn(otherTab)).count;
  assert.equal((await respondsOn(otherTab)).count, otherBefore + 1);
  assert.equal((await respondsOn("fixture")).count, defaultBefore + 1, "another profile's activity never writes this profile's storage");
  const beforeRestart = {
    default: await respondsOn("fixture"),
    other: await respondsOn(otherTab),
    preexisting: await respondsOn(ownTab),
    future: await respondsOn(futureTab),
  };
  console.log("PASS each profile keeps independent extension storage");

  await restart();
  const profiles = [
    ["default", "", "fixture", id],
    ["other", "other", otherTab, id],
    ["preexisting", "preexisting", ownTab, own.id],
    ["future", futureProfile, futureTab, id],
  ];
  const assertEveryProfileShared = async previous => {
    const responses = {};
    for (const [name, profile, tabId, contextId] of profiles) {
      const row = await restored(profile);
      assert.equal(row.id, contextId, `${name}: stable context identity`);
      assertShared(row, name);
      responses[name] = await respondsOn(tabId);
      assert.equal(responses[name].owner, previous[name].owner, `${name}: same extension storage`);
      assert(responses[name].count > previous[name].count, `${name}: storage keeps counting`);
      assertAllWebsites(responses[name], name);
    }
    return responses;
  };
  const afterRestart = await assertEveryProfileShared(beforeRestart);
  const otherBroadRestarted = await respondsOn(otherBroadTab, broadBase);
  assert.equal(otherBroadRestarted.owner, otherResult.owner);
  console.log("PASS shared approval, stable identity and separate storage survive restart");

  const narrowed = await engine("webKit.extensionLoad", local);
  assert.equal(narrowed.id, id);
  assert.equal(narrowed.allProfiles, false);
  assert.equal(narrowed.allWebsites, false);
  assert.deepEqual(narrowed.grantedOrigins, grants.origins);
  assert.equal(await profileRow("other"), undefined);
  assert.equal(await profileRow(futureProfile), undefined);
  const ownNarrowed = await restored("preexisting", false);
  assert.equal(ownNarrowed.id, own.id);
  assert.deepEqual(ownNarrowed.grantedOrigins, grants.origins);
  await reload(broadTab, broadBase);
  await assertUntouched(broadTab, "narrowing removes access to the second hostname");
  await reload(otherTab);
  await assertUntouched(otherTab, "narrowing removes inherited access");
  await reload(futureTab);
  await assertUntouched(futureTab, "narrowing removes inherited access from the newer profile");
  const ownKept = await respondsOn(ownTab);
  assert.equal(ownKept.owner, ownResult.owner);
  assert.deepEqual(ownKept.access.origins, grants.origins);
  await reload(ownBroadTab, broadBase);
  await assertUntouched(ownBroadTab, "a restored local approval keeps only its exact hosts");
  const narrowedResponse = await respondsOn("fixture");
  assert.equal(narrowedResponse.owner, originalOwner);
  assert.deepEqual(narrowedResponse.access.origins, grants.origins);
  assert.equal(narrowedResponse.access.web, false);
  console.log("PASS narrowing to one profile removes inherited access and restores local grants");

  const otherLocal = await engine("webKit.extensionLoad", { ...local, profile: "other" });
  assert.equal(otherLocal.id, id, "an inherited profile reuses its context identity for a later local install");
  assert.equal(otherLocal.allProfiles, false);
  const otherEnabled = await respondsOn(otherTab);
  assert.equal(otherEnabled.owner, otherResult.owner, "local re-enable retains the inherited profile's extension data");
  assert(otherEnabled.count > afterRestart.other.count);
  assert.deepEqual(otherEnabled.access.origins, grants.origins);
  await reload(otherBroadTab, broadBase);
  await assertUntouched(otherBroadTab, "a local re-enable does not inherit the old shared hosts");
  console.log("PASS inherited to local re-enable keeps the same context identity and storage");

  assert.equal((await engine("webKit.extensionLoad", sharedApproval)).id, id);
  const reshared = await assertEveryProfileShared({ ...afterRestart, default: narrowedResponse, other: otherEnabled, preexisting: ownKept });
  for (const profile of ["other", "preexisting"]) assert.deepEqual((await profileRow(profile)).localGrantedOrigins, grants.origins);
  assert.equal((await respondsOn(otherBroadTab, broadBase)).owner, otherResult.owner);
  console.log("PASS sharing again restores the original shared values, identities and each profile's data");

  const publishVersion = async version => {
    manifest.version = version;
    writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
    return (await engine("webKit.extensionInspect", { path: extension, allWebsites: true })).fingerprint;
  };
  const assertOff = async (profile, tabId, why) => {
    const row = await profileRow(profile);
    assert.equal(row?.enabled, false, `${why}: disabled`);
    assert.equal(row.loaded, false, `${why}: unloaded`);
    assert.equal(row.allProfiles, false, `${why}: no longer shared`);
    await reload(tabId);
    await assertUntouched(tabId, why);
  };
  const newer = await publishVersion("1.0.2");
  const newerShared = { ...sharedApproval, fingerprint: newer };
  const newerLocal = { ...local, fingerprint: newer };
  assert.equal((await engine("webKit.extensionLoad", { ...newerLocal, profile: "preexisting" })).id, own.id);
  assert.equal((await restored("", false)).id, id, "an approval matching the shared version stays on when sharing ends");
  assert.equal((await restored("other", false)).id, id);
  assert.equal(await profileRow(futureProfile), undefined);
  assert.equal((await respondsOn("fixture")).owner, originalOwner);
  assert.equal((await respondsOn(otherTab)).owner, otherResult.owner);
  console.log("PASS ending shared access keeps other approvals that match the shared version");

  assert.equal((await engine("webKit.extensionLoad", newerShared)).id, id);
  for (const [, profile] of profiles) assert.equal((await restored(profile)).fingerprint, newer);
  const fromInherited = await engine("webKit.extensionLoad", { ...newerLocal, profile: futureProfile });
  assert.equal(fromInherited.id, id, "narrowing from an inherited profile keeps its context identity");
  assert.equal(fromInherited.allProfiles, false);
  assert.deepEqual(fromInherited.grantedOrigins, grants.origins);
  const kept = await respondsOn(futureTab);
  assert.equal(kept.owner, futureResult.owner, "the inherited profile keeps its own extension data");
  assert.deepEqual(kept.access.origins, grants.origins);
  await reload(futureBroadTab, broadBase);
  await assertUntouched(futureBroadTab, "narrowing from an inherited profile drops the shared hosts there too");
  console.log("PASS narrowing from an inherited profile keeps that profile's identity and data");

  await assertOff("", "fixture", "the default profile's older approval stays off");
  await assertOff("other", otherTab, "another profile's older approval stays off");
  assert.equal((await restored("preexisting", false)).fingerprint, newer);
  assert.equal((await respondsOn(ownTab)).owner, ownResult.owner);
  console.log("PASS stale local copies stay disabled after sharing ends, while the matching copy stays on");

  const savedCopies = () => readdirSync(savedRoot()).filter(folder => folder !== "Shared Approvals" && existsSync(join(savedRoot(), folder, "extensions.json")))
    .flatMap(folder => JSON.parse(readFileSync(join(savedRoot(), folder, "extensions.json"), "utf8")).extensions)
    .filter(record => record.path === inspection.path && record.fingerprint === newer);
  const broaderCopies = () => savedCopies().filter(record => record.permissions.includes("scripting"));
  assert.equal((await engine("webKit.extensionLoad", { ...newerLocal, profile: "other", permissions: ["storage"] })).enabled, true);
  assert.equal((await engine("webKit.extensionLoad", newerShared)).id, id);
  for (const [, profile] of profiles) await restored(profile);
  assert.deepEqual(broaderCopies().map(record => record.enabled), [true, true], "local copies stay on while the shared access covers them");
  const fewer = ["storage", "tabs"];
  assert.deepEqual(sorted((await engine("webKit.extensionLoad", { ...newerShared, profile: "preexisting", permissions: fewer })).grantedPermissions), fewer);
  const turnedOff = broaderCopies();
  assert.equal(turnedOff.length, 2);
  assert(turnedOff.some(record => record.id === own.id), "the approving profile's own broader copy is included");
  for (const record of turnedOff) {
    assert.equal(record.enabled, false, "a broader local copy is turned off while sharing hides it");
    assert.deepEqual(sorted(record.permissions), sorted(grants.permissions), "its permissions are not trimmed");
    assert.deepEqual(record.origins, grants.origins, "its websites are not trimmed");
  }
  assert.deepEqual(savedCopies().filter(record => record.permissions.join() === "storage").map(record => record.enabled), [true], "a narrower copy stays on");
  for (const [, profile] of profiles) assert.deepEqual(sorted((await restored(profile)).grantedPermissions), fewer);
  assert.equal((await engine("webKit.extensionLoad", newerShared)).id, id);
  for (const [, profile] of profiles) await restored(profile);
  assert.deepEqual(broaderCopies().map(record => record.enabled), [false, false], "widening shared access again does not turn copies back on");
  assert.equal((await engine("webKit.extensionLoad", newerLocal)).id, id);
  await assertOff("preexisting", ownTab, "the approving profile's copy stays off after sharing ends");
  await assertOff(futureProfile, futureTab, "another broader copy stays off after sharing ends");
  assert.equal((await restored("other", false)).fingerprint, newer);
  console.log("PASS reducing shared access turns off broader local copies without trimming them, while narrower copies stay on");

  assert.equal((await engine("webKit.extensionLoad", newerShared)).id, id);
  for (const [, profile] of profiles) await restored(profile);
  assert.equal((await engine("webKit.extensionList", { profile: "" })).sharedCatalogUnreadable, false);
  const savedShared = readFileSync(sharedFile());
  await restart(() => writeFileSync(sharedFile(), "{"));
  assert.equal((await engine("webKit.extensionList", { profile: "" })).sharedCatalogUnreadable, true);
  const unreadableProfile = await createProfile("Unreadable approvals fixture");
  const unreadable = await engine("webKit.extensionList", { profile: unreadableProfile });
  assert.equal(unreadable.sharedCatalogUnreadable, true);
  assert.deepEqual(unreadable.extensions, [], "unreadable shared approvals grant nothing");
  await assert.rejects(engine("webKit.extensionLoad", newerShared), /approvals/i);
  assert.equal(readFileSync(sharedFile(), "utf8"), "{", "an unreadable approvals file is never overwritten");
  await restart(() => writeFileSync(sharedFile(), savedShared));
  assert.equal((await engine("webKit.extensionList", { profile: "" })).sharedCatalogUnreadable, false);
  for (const [, profile] of profiles) await restored(profile);
  console.log("PASS an unreadable shared approvals file is reported, grants nothing and is left as it was");

  const createAndCall = (name, call, args = {}) => instance.eval(`const profile = ac.store.getState().createProfile({ name: ${q(name)} }); return ac.engine.call(${q(call)}, Object.assign({ profile }, ${q(args)})).then(reply => ({ profile, reply }))`);
  const control = await createAndCall("Restore control fixture", "webKit.extensionList");
  assert.equal(control.reply.extensions.length, 1);
  assert.equal(control.reply.extensions[0].enabled, true);
  assert.equal(control.reply.extensions[0].loaded, false, "a new profile's first call must leave its restore pending, or revoking in that call would prove nothing");
  await restored(control.profile);
  const late = await createAndCall("Pending restore fixture", "webKit.extensionUnload", { id, allProfiles: true });
  assert.equal(late.reply.id, id);
  assert.equal(late.reply.enabled, false);
  assert.equal(late.reply.loaded, false);
  const everyProfile = [...profiles.map(([, profile]) => profile), control.profile, late.profile];
  const assertRevoked = async () => {
    for (const profile of everyProfile) {
      const row = await profileRow(profile);
      assert.equal(row?.enabled, false, `global disable in ${profile || "default"}`);
      assert.equal(row.loaded, false, `global unload in ${profile || "default"}`);
      assert.deepEqual(row.errors, [], `no stale restore error in ${profile || "default"}`);
    }
  };
  const drainRestores = async () => {
    for (let round = 0; round < 2; round++) await engine("webKit.extensionInspect", { path: extension });
    await sleep(500);
  };
  const assertStaysRevoked = async () => {
    await assertRevoked();
    await drainRestores();
    await assertRevoked();
  };
  await assertStaysRevoked();
  const lateTab = await openFixture(late.profile);
  await sleep(500);
  await assertUntouched(lateTab, "a late restore cannot reactivate revoked shared approval");
  for (const [, , tabId] of profiles) {
    await reload(tabId);
    await assertUntouched(tabId, "global disable removes injection");
  }
  console.log("PASS revocation defeats a pending restore");

  writeFileSync(join(extension, "bulk.bin"), Buffer.alloc(96 * 1024 * 1024, 1));
  const bulky = await engine("webKit.extensionInspect", { path: extension, allWebsites: true });
  const bulkyApproval = { ...sharedApproval, fingerprint: bulky.fingerprint };
  await engine("webKit.extensionLoad", bulkyApproval);
  for (const profile of everyProfile) await restored(profile);
  const revoke = { profile: "", id, allProfiles: true };
  const stale = await instance.eval(`const loading = ac.engine.call("webKit.extensionLoad", ${q(bulkyApproval)}).then(() => "loaded", error => String((error && error.message) || error)); return ac.engine.call("webKit.extensionUnload", ${q(revoke)}).then(() => loading)`);
  assert.match(stale, /approval changed while loading/i, "a load that is still pending when access is revoked must be refused");
  await assertStaysRevoked();
  console.log("PASS revocation defeats a pending load");

  await restart();
  await assertStaysRevoked();
  await reload();
  await assertUntouched("fixture", "the revoked approval stays off after restart");
  console.log("PASS global disable survives restart");

  const localAgain = await engine("webKit.extensionLoad", { ...newerLocal, fingerprint: bulky.fingerprint });
  assert.equal(localAgain.enabled, true);
  await assertOff("preexisting", ownTab, "a global disable also turned off a profile's own approval");
  await assertOff("other", otherTab, "a global disable also turned off another profile's own approval");
  await assertOff(futureProfile, futureTab, "a global disable also turned off a newer profile's own approval");
  console.log("PASS approvals a global disable turned off stay off when one profile enables again");
} finally {
  if (instance) await instance.quit();
  server.closeAllConnections();
  broadServer.closeAllConnections();
  await Promise.all([new Promise(done => server.close(done)), new Promise(done => broadServer.close(done))]);
  console.log(`Test files: ${scratch}`);
}
