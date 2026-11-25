import assert from "node:assert/strict";
import { test } from "node:test";

const native = await import("../../test-native/index.ts");
const calls = [];
let rows = [];
let confirmation = async () => ({ confirmed: true });
let menu = async () => "extension:0";
let inspect;
let load;
let list;
const pkg = {
  name: "Kimchi", version: "1.0", path: "/fixtures/kimchi", fingerprint: "a".repeat(64),
  requestedPermissions: ["storage", "tabs", "tabCapture"], supportedPermissions: ["storage", "tabs"],
  requestedOrigins: ["https://www.netflix.com/*", "https://*.example.com/*", "<all_urls>"],
  errors: ["tabCapture is unsupported"],
};
const record = () => ({ ...pkg, id: "kimchi", enabled: true, loaded: true, grantedPermissions: [], grantedOrigins: [], reloadRequired: false });
globalThis.acTestNativeModules = {
  ArdiaWebKit: {
    addListener: () => ({ remove() {} }),
    async call(verb, profile, json) {
      const args = JSON.parse(json);
      calls.push({ verb, profile, args });
      let answer;
      if (verb === "extensionInspect") answer = await inspect(args);
      else if (verb === "extensionLoad") { answer = await load(args); rows = [answer]; }
      else if (verb === "extensionUnload") { answer = { ...record(), loaded: false, enabled: false }; rows = [answer]; }
      else if (verb === "extensionList") answer = await list(profile);
      else if (verb === "extensionShow") answer = { shown: true };
      else answer = null;
      return JSON.stringify(answer);
    },
  },
  ArdiaDialogs: { confirm: (options) => { calls.push({ verb: "confirm", options }); return confirmation(); } },
  ArdiaMenus: { showMenu: (items) => { calls.push({ verb: "menu", items }); return menu(); } },
};
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { useSettingsNav } = await import("../settings/settingsWindows.ts");
const actions = await import("./webKit.ts");
const S = () => useBrowser.getState();
const E = () => actions.useWebKitExtensions.getState();
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
let unbind = () => {};

function setup() {
  unbind();
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://www.netflix.com/" });
  const tabId = S().windows[windowId].tabIds[0];
  const profileId = S().tabs[tabId].profileId;
  S().updateTab(tabId, { engine: "webkit" });
  usePages.setState({ ready: { [tabId]: 7 } });
  useSettingsNav.setState({ pane: "profiles", profileId, detail: null });
  actions.useWebKitExtensions.setState({ lists: {}, errors: {}, available: true, review: null, choosing: false });
  unbind = actions.bindWebKitSettings(profileId);
  native.chosenExtensionFolder.next = pkg.path;
  rows = [];
  inspect = async () => structuredClone(pkg);
  load = async (args) => ({ ...record(), grantedPermissions: args.permissions, grantedOrigins: args.origins });
  list = async () => ({ available: true, extensions: rows });
  confirmation = async () => ({ confirmed: true });
  menu = async () => "extension:0";
  calls.length = 0;
  return { profileId, windowId, tabId };
}

test("inspection never starts code; unsupported requests remain denied and trust precedes loading", async () => {
  const { profileId } = setup();
  await actions.reviewWebKitExtension(profileId);
  assert.deepEqual(calls.map((call) => call.verb), ["extensionInspect"]);
  const key = E().review.key;
  assert.deepEqual(E().review.permissions, []);
  assert.deepEqual(E().review.origins, []);
  actions.selectWebKitGrant(key, "permissions", "tabs", true);
  actions.selectWebKitGrant(key, "permissions", "tabCapture", true);
  actions.selectWebKitGrant(key, "origins", "<all_urls>", true);
  actions.selectWebKitGrant(key, "origins", "https://www.netflix.com/*", true);
  assert.equal(actions.addWebKitHost(key, "player.example.com"), true);
  assert.equal(actions.addWebKitHost(key, "*.example.com"), false);
  assert.equal(actions.addWebKitHost(key, "player.example.com:443"), false);
  assert.equal(actions.addWebKitHost(key, "https://player.example.com/private"), false);
  await actions.acceptWebKitReview(key);
  const verbs = calls.map((call) => call.verb);
  assert.ok(verbs.indexOf("confirm") < verbs.indexOf("extensionLoad"));
  assert.equal(calls.find((call) => call.verb === "extensionLoad").args.fingerprint, pkg.fingerprint);
  const allowed = calls.find((call) => call.verb === "extensionLoad");
  assert.equal(allowed.profile, "", "the default regular profile uses an empty native key");
  assert.deepEqual(allowed.args.permissions, ["tabs"]);
  assert.deepEqual(allowed.args.origins, ["https://www.netflix.com/*", "https://player.example.com/*"]);
  assert.equal(calls.some((call) => call.verb === "extensionGrant"), false);
  const consent = calls.find((call) => call.verb === "confirm").options;
  assert.match(consent.title, /Kimchi 1.0/);
  assert.match(consent.message, /background code/);
  assert.match(consent.message, /retains.*saved data/);
  assert.match(consent.message, /URLs of all WebKit tabs in this profile/);
  assert.match(consent.message, /not just a URL path/);
});

test("declining trust starts no extension code", async () => {
  const { profileId } = setup();
  confirmation = async () => ({ confirmed: false });
  await actions.reviewWebKitExtension(profileId);
  await actions.acceptWebKitReview(E().review.key);
  assert.equal(calls.some((call) => call.verb === "extensionLoad"), false);
});

test("changed inspected bytes are rejected without granting access", async () => {
  const { profileId } = setup();
  load = async () => { throw new Error("Extension changed since inspection"); };
  await actions.reviewWebKitExtension(profileId);
  await actions.acceptWebKitReview(E().review.key);
  assert.match(E().errors[""], /changed since inspection/);
  assert.equal(calls.some((call) => call.verb === "extensionGrant"), false);
});

test("switching profiles during inspection cannot create a review for the old selection", async () => {
  const { profileId } = setup();
  const pending = deferred();
  inspect = () => pending.promise;
  const reviewing = actions.reviewWebKitExtension(profileId);
  await flush();
  useSettingsNav.setState({ profileId: S().createProfile({ name: "Other" }) });
  pending.resolve(pkg);
  await reviewing;
  assert.equal(E().review, null);
  assert.equal(calls.some((call) => call.verb === "extensionLoad"), false);
});

test("changing the settings selection while trust is pending cancels loading", async () => {
  const { profileId } = setup();
  await actions.reviewWebKitExtension(profileId);
  const pending = deferred();
  confirmation = () => pending.promise;
  const accepting = actions.acceptWebKitReview(E().review.key);
  useSettingsNav.setState({ detail: "passwords" });
  pending.resolve({ confirmed: true });
  await accepting;
  assert.equal(calls.some((call) => call.verb === "extensionLoad"), false);
});

test("leaving settings after trust commits the approved load without disabling the stable extension", async () => {
  const { profileId } = setup();
  await actions.reviewWebKitExtension(profileId);
  const pending = deferred();
  load = () => pending.promise;
  const accepting = actions.acceptWebKitReview(E().review.key);
  await flush();
  useSettingsNav.setState({ pane: "general", profileId: null });
  actions.cancelWebKitReview();
  pending.resolve(record());
  await accepting;
  assert.equal(calls.some((call) => call.verb === "extensionUnload"), false);
  assert.equal(E().lists[""][0].enabled, true);
  assert.equal(E().review, null);
  assert.equal(calls.some((call) => call.verb === "extensionGrant"), false);
});

test("refused host grants preserve the previous context without an unload", async () => {
  const { profileId } = setup();
  const previous = record();
  rows = [previous];
  load = async () => { throw new Error("Host was not requested by this extension"); };
  await actions.reviewWebKitExtension(profileId);
  await actions.acceptWebKitReview(E().review.key);
  assert.match(E().errors[""], /Host was not requested/);
  assert.equal(calls.some((call) => call.verb === "extensionUnload"), false);
  assert.deepEqual(E().lists[""], [previous]);
});

test("typed hosts must narrow a requested HTTPS host rule before loading", async () => {
  const { profileId } = setup();
  inspect = async () => ({ ...pkg, requestedOrigins: ["https://*.example.com/*", "http://plain.example/*", "https://limited.example/private/*"] });
  await actions.reviewWebKitExtension(profileId);
  const key = E().review.key;
  assert.equal(actions.addWebKitHost(key, "player.example.com"), true);
  assert.equal(actions.addWebKitHost(key, "example.com"), true);
  for (const host of ["other.test", "notexample.com", "example.com.evil.test", "plain.example", "limited.example", "user@example.com", "example.com?secret=yes"]) {
    assert.equal(actions.addWebKitHost(key, host), false, host);
  }
  actions.selectWebKitGrant(key, "origins", "https://other.test/*", true);
  assert.deepEqual(E().review.origins, ["https://player.example.com/*", "https://example.com/*"]);
  assert.equal(calls.some((call) => call.verb === "extensionLoad"), false);
});

test("toolbar sends the app tab ID; readiness is only a generation guard", async () => {
  const { windowId, tabId } = setup();
  rows = [record()];
  await actions.openWebKitExtensionMenu(windowId, tabId);
  const shown = calls.find((call) => call.verb === "extensionShow");
  assert.deepEqual(shown.args, { id: "kimchi", tabId });
  assert.equal(shown.profile, "");
});

test("a tab switch while the menu is open never opens the old tab's extension popup", async () => {
  const { windowId, tabId } = setup();
  rows = [record()];
  const pending = deferred();
  menu = () => pending.promise;
  const opening = actions.openWebKitExtensionMenu(windowId, tabId);
  await flush();
  S().newTab(windowId, { url: "https://other.example/" });
  pending.resolve("extension:0");
  await opening;
  assert.equal(calls.some((call) => call.verb === "extensionShow"), false);
});

test("a page replacement while the menu is open invalidates its readiness generation", async () => {
  const { windowId, tabId } = setup();
  rows = [record()];
  const pending = deferred();
  menu = () => pending.promise;
  const opening = actions.openWebKitExtensionMenu(windowId, tabId);
  await flush();
  usePages.setState({ ready: { [tabId]: 8 } });
  pending.resolve("extension:0");
  await opening;
  assert.equal(calls.some((call) => call.verb === "extensionShow"), false);
});

test("Chromium and private windows never invoke the WebKit extension menu", async () => {
  const { windowId, tabId } = setup();
  assert.equal(actions.webKitToolbarMode(S(), windowId, tabId), "webkit");
  S().updateTab(tabId, { engine: "chromium" });
  assert.equal(actions.webKitToolbarMode(S(), windowId, tabId), "chromium");
  await actions.openWebKitExtensionMenu(windowId, tabId);
  S().updateTab(tabId, { engine: "webkit" });
  useBrowser.setState((s) => ({ windows: { ...s.windows, [windowId]: { ...s.windows[windowId], kind: "private" } } }));
  assert.equal(actions.webKitToolbarMode(S(), windowId, tabId), "hidden");
  await actions.openWebKitExtensionMenu(windowId, tabId);
  assert.equal(calls.length, 0);
  S().updateTab(tabId, { engine: "chromium" });
  assert.equal(actions.webKitToolbarMode(S(), windowId, tabId), "chromium");
});

test("direct activation opens the current profile's popup without an intermediate menu", async () => {
  const { windowId, tabId, profileId } = setup();
  rows = [record()];
  await actions.refreshWebKitExtensions(profileId);
  calls.length = 0;
  await actions.activateWebKitExtension(windowId, tabId, "kimchi", pkg.fingerprint);
  assert.deepEqual(calls.map((call) => call.verb), ["extensionList", "extensionShow"]);
  assert.deepEqual(calls[1], { verb: "extensionShow", profile: "", args: { id: "kimchi", tabId } });
});

test("direct activation shares an in-flight refresh and keeps a concurrent refresh from swallowing the click", async () => {
  const { windowId, tabId, profileId } = setup();
  rows = [record()];
  await actions.refreshWebKitExtensions(profileId);
  const pending = deferred();
  list = () => pending.promise;
  calls.length = 0;
  const activation = actions.activateWebKitExtension(windowId, tabId, "kimchi");
  const refresh = actions.refreshWebKitExtensions(profileId);
  await flush();
  assert.equal(calls.filter((call) => call.verb === "extensionList").length, 1);
  pending.resolve({ available: true, extensions: rows });
  await Promise.all([activation, refresh]);
  assert.equal(calls.filter((call) => call.verb === "extensionShow").length, 1);
});

test("direct activation refuses disabled, unloaded, replaced, unready, private and Chromium targets", async () => {
  for (const change of ["disabled", "unloaded", "replaced", "unready", "private", "chromium"]) {
    const { windowId, tabId, profileId } = setup();
    rows = [record()];
    await actions.refreshWebKitExtensions(profileId);
    if (change === "disabled") rows = [{ ...record(), enabled: false }];
    if (change === "unloaded") rows = [{ ...record(), loaded: false }];
    if (change === "replaced") rows = [{ ...record(), fingerprint: "b".repeat(64) }];
    if (change === "unready") usePages.setState({ ready: {} });
    if (change === "private") useBrowser.setState((s) => ({ windows: { ...s.windows, [windowId]: { ...s.windows[windowId], kind: "private" } } }));
    if (change === "chromium") S().updateTab(tabId, { engine: "chromium" });
    calls.length = 0;
    await actions.activateWebKitExtension(windowId, tabId, "kimchi", pkg.fingerprint);
    assert.equal(calls.some((call) => call.verb === "extensionShow"), false, change);
    assert.equal(calls.some((call) => call.verb === "menu"), false, change);
  }
});

test("direct activation rejects a tab, profile or readiness change during native refresh", async () => {
  for (const change of ["tab", "profile", "generation", "engine"]) {
    const { windowId, tabId, profileId } = setup();
    rows = [record()];
    await actions.refreshWebKitExtensions(profileId);
    const pending = deferred();
    list = () => pending.promise;
    const activation = actions.activateWebKitExtension(windowId, tabId, "kimchi");
    await flush();
    if (change === "tab") S().newTab(windowId, { url: "https://other.example/" });
    if (change === "profile") S().updateTab(tabId, { profileId: S().createProfile({ name: "Other" }) });
    if (change === "generation") usePages.setState({ ready: { [tabId]: 8 } });
    if (change === "engine") S().updateTab(tabId, { engine: "chromium" });
    pending.resolve({ available: true, extensions: rows });
    await activation;
    assert.equal(calls.some((call) => call.verb === "extensionShow"), false, change);
  }
});

test("direct activation uses the shown tab's nondefault profile", async () => {
  setup();
  const profileId = S().createProfile({ name: "Work" });
  const windowId = S().createWindow({ profileId, url: "https://www.netflix.com/" });
  const tabId = S().windows[windowId].tabIds[0];
  usePages.setState({ ready: { [tabId]: 1 } });
  rows = [record()];
  await actions.refreshWebKitExtensions(profileId);
  await actions.activateWebKitExtension(windowId, tabId, "kimchi");
  const shown = calls.find((call) => call.verb === "extensionShow");
  assert.ok(shown);
  assert.notEqual(shown.profile, "");
  assert.equal(shown.profile, calls.find((call) => call.verb === "extensionList").profile);
  assert.deepEqual(shown.args, { id: "kimchi", tabId });
});

test("a post-mutation fresh list wins over an older in-flight response", async () => {
  const { profileId } = setup();
  const old = deferred();
  list = () => old.promise;
  const stale = actions.refreshWebKitExtensions(profileId);
  await flush();
  const disabled = { ...record(), enabled: false, loaded: false };
  list = async () => ({ available: true, extensions: [disabled] });
  await actions.refreshWebKitExtensions(profileId, true);
  old.resolve({ available: true, extensions: [record()] });
  await stale;
  assert.deepEqual(E().lists[""], [disabled]);
});

test("toolbar layout preserves native order, hides inactive rows and uses management space only when available", () => {
  const entries = ["one", "two", "three"].map((id) => ({ ...record(), id, icon: "data:image/png;base64,AQ==" }));
  const list = [entries[0], { ...record(), id: "disabled", enabled: false }, entries[1], { ...record(), id: "unloaded", loaded: false }, entries[2]];
  const narrow = actions.webKitToolbarLayout(list, 2, 28);
  assert.deepEqual(narrow.visible.map((entry) => entry.id), ["one"]);
  assert.deepEqual(narrow.overflow.map((entry) => entry.id), ["two", "three"]);
  assert.equal(narrow.width, 58);
  const full = actions.webKitToolbarLayout(list, Infinity, 22);
  assert.deepEqual(full.visible, entries);
  assert.equal(full.width, 94);
  const oneSlot = actions.webKitToolbarLayout(list, 1, 28);
  assert.deepEqual(oneSlot.visible, [entries[0]]);
  assert.deepEqual(oneSlot.overflow, entries.slice(1));
  assert.equal(oneSlot.manage, false);
  assert.equal(oneSlot.width, 28);
  const single = actions.webKitToolbarLayout([entries[0]], 1, 28);
  assert.deepEqual(single.visible, [entries[0]]);
  assert.equal(single.manage, false);
  assert.equal(single.width, 28);
  const exactFit = actions.webKitToolbarLayout(entries.slice(0, 2), 2, 28);
  assert.deepEqual(exactFit.visible, entries.slice(0, 2));
  assert.equal(exactFit.manage, false);
  assert.equal(exactFit.width, 58);
  assert.equal(actions.webKitToolbarLayout([], Infinity, 28).width, 28);
});

test("overflow offers only hidden loaded rows and refuses a version replaced while the menu is open", async () => {
  const { windowId, tabId } = setup();
  rows = [record(), { ...record(), id: "other", name: "Other" }, { ...record(), id: "third", name: "Third" }];
  const pending = deferred();
  menu = () => pending.promise;
  const opening = actions.openWebKitExtensionMenu(windowId, tabId, 2);
  await flush();
  assert.deepEqual(calls.find((call) => call.verb === "menu").items.filter((item) => item.id?.startsWith("extension:")).map((item) => item.title), ["Other", "Third"]);
  actions.useWebKitExtensions.setState({ lists: { "": [record(), { ...rows[1], fingerprint: "b".repeat(64) }] } });
  pending.resolve("extension:0");
  await opening;
  assert.equal(calls.some((call) => call.verb === "extensionShow"), false);
});

test("an icon's context menu keeps all extensions and management accessible in a one-slot sidebar", async () => {
  const { windowId, tabId } = setup();
  rows = [record(), { ...record(), id: "other", name: "Other" }];
  menu = async () => null;
  assert.equal(actions.webKitToolbarLayout(rows, 1, 28).manage, false);
  await actions.openWebKitExtensionMenu(windowId, tabId);
  const items = calls.find((call) => call.verb === "menu").items;
  assert.deepEqual(items.filter((item) => item.id?.startsWith("extension:")).map((item) => item.title), ["Kimchi", "Other"]);
  assert.equal(items.at(-1).id, "manage");
});

test("toolbar restore refresh retries until loaded, then stops, and cleanup cancels pending retries", async (t) => {
  const { windowId, tabId } = setup();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  rows = [{ ...record(), loaded: false, errors: [] }];
  const stop = actions.watchWebKitToolbar(windowId, tabId);
  await flush();
  assert.equal(calls.filter((call) => call.verb === "extensionList").length, 1);
  rows = [record()];
  t.mock.timers.tick(500);
  await flush();
  assert.equal(E().lists[""][0].loaded, true);
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(calls.filter((call) => call.verb === "extensionList").length, 2);
  stop();
  rows = [{ ...record(), loaded: false, errors: [] }];
  const stopPending = actions.watchWebKitToolbar(windowId, tabId);
  await flush();
  stopPending();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(calls.filter((call) => call.verb === "extensionList").length, 3);
});

test("toolbar restore retries are bounded and stop when the active profile or page generation changes", async (t) => {
  const { windowId, tabId } = setup();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  rows = [{ ...record(), loaded: false, errors: [] }];
  const stop = actions.watchWebKitToolbar(windowId, tabId);
  await flush();
  for (let attempt = 0; attempt < 40; attempt++) { t.mock.timers.tick(500); await flush(); }
  assert.equal(calls.filter((call) => call.verb === "extensionList").length, 30);
  stop();
  const next = actions.watchWebKitToolbar(windowId, tabId);
  await flush();
  usePages.setState({ ready: { [tabId]: 8 } });
  t.mock.timers.tick(500);
  await flush();
  assert.equal(calls.filter((call) => call.verb === "extensionList").length, 31);
  next();
});
