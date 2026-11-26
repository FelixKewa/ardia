import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigration, planMigration, recoverMigration } from "../../../scripts/personal/migrate-preview.mjs";
import { importedProfile, mergeSessions, restoreLastWindow, storeIdentifier } from "../../../scripts/personal/migrate-preview-session.mjs";
import { fileHash, inventory, packageFingerprint, parseJSON, readJSON, exists, exclusively } from "../../../scripts/personal/migrate-preview-files.mjs";

const session = (label) => ({ version: 11, profiles: { default: { id: "default", name: label, color: "blue", createdAt: 1, syncTabs: true } }, profileOrder: ["default"],
  settings: { label, defaultEngine: "chromium" }, settingsMeta: { chosen: [label] }, windows: [{ id: "w", profileId: "default", tabIds: ["a", "b"], activeTabIds: { default: "a" }, frame: [0, 0, 800, 600] }], windowOrder: ["w"], focusedWindowId: "w", lastProfileId: "default",
  tabs: [{ id: "a", profileId: "default", windowId: "w", url: "https://fixture.invalid/a", engine: "webkit", page: { kind: "idle", wake: "restore:old" }, pin: { as: "row" }, title: label }, { id: "b", profileId: "default", windowId: "w", url: "https://fixture.invalid/b", engine: "chromium", page: { kind: "asleep" }, openerId: "a" }],
  groups: [{ id: "g", windowId: "w", profileId: "default", tabIds: ["a", "b"], name: label }], splits: [{ id: "s", windowId: "w", orientation: "horizontal", slots: [{ tabId: "a", size: 0.5 }, { tabId: "b", size: 0.5 }] }],
  closedTabs: [{ id: "c", kind: "tab", windowId: "w", tabId: "a", tab: { profileId: "default", url: "https://fixture.invalid/closed" }, group: { id: "g" }, closedAt: 1 }], closedWindows: [], closedGroups: [], deletedGroups: [], cleanedTabs: [],
  parkedPins: { default: { tabs: [], groups: [] } }, pinChoices: { default: { a: "stamp", "group:g": "stamp" } }, pinSync: {}, orphanedProfileData: [], launchTab: null });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ardia-migrate-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preview = join(root, "preview");
  const destination = join(root, "installed");
  const webKit = join(root, "webkit");
  for (const path of [preview, destination, webKit]) await mkdir(path);
  for (const [path, label] of [[preview, "Preview"], [destination, "Official"]]) {
    await writeFile(join(path, "session.json"), JSON.stringify(session(label)));
    await mkdir(join(path, "Chromium/Default"), { recursive: true });
    await writeFile(join(path, "Chromium/Default/History"), `${label} history`);
    await writeFile(join(path, "Chromium/Default/Bookmarks"), JSON.stringify({ roots: { bookmark_bar: { children: [{ name: label, url: "https://fixture.invalid" }] } } }));
    await writeFile(join(path, "Chromium/Default/Cookies"), `${label} must not import`);
    await writeFile(join(path, "Chromium/Default/Login Data"), `${label} must not import`);
    await writeFile(join(path, "Chromium/Default/Preferences"), JSON.stringify({ extensions: { pinned_extensions: [] }, browser: { fixture: label } }));
    await writeFile(join(path, "opaque-official-setting"), `${label} untouched`);
  }
  await writeFile(join(destination, "sync.json"), JSON.stringify({ v: 1, enabled: true, profiles: { default: { syncId: "original", enabled: true } }, types: { history: true } }));
  const identifier = storeIdentifier(preview, "");
  const id = "9726606d-2f65-4707-9e98-07bb4777ecfb";
  const source = join(root, "package");
  await mkdir(source);
  await writeFile(join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1", permissions: ["storage"], host_permissions: ["https://fixture.invalid/*"] }));
  await writeFile(join(source, "한글.js"), "globalThis.fixture = true;");
  const { fingerprint } = await packageFingerprint(source);
  const pkg = join(preview, "Chromium/WebKit Extensions", identifier, id, fingerprint);
  await mkdir(pkg, { recursive: true });
  for (const name of ["manifest.json", "한글.js"]) await writeFile(join(pkg, name), await readFile(join(source, name)));
  await writeFile(join(preview, "Chromium/WebKit Extensions", identifier, "extensions.json"), JSON.stringify({ version: 1, extensions: [{ id, path: source, fingerprint, name: "Fixture", version: "1", enabled: true, requestedPermissions: ["storage"], requestedOrigins: ["https://fixture.invalid/*"], permissions: ["storage"], origins: ["https://fixture.invalid/*"] }] }));
  for (const [kind, name] of [["WebsiteDataStore", identifier.toLowerCase()], ["WebExtensions", identifier]]) {
    const dir = join(webKit, kind, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "opaque-state"), "owned synthetic data");
  }
  return { fixture: true, fixtureRoot: root, root, preview, destination, webKit, backup: join(root, "backup"), acceptTransfer: true, identifier, id, fingerprint };
}

test("migration keeps official values, adds separate linked rows, and retains approved extension identity", async (t) => {
  const f = await fixture(t);
  const official = await readJSON(join(f.destination, "session.json"));
  const officialHistory = await fileHash(join(f.destination, "Chromium/Default/History"));
  const sourceBefore = await inventory(f.preview);
  const storesBefore = await inventory(f.webKit);
  const result = await applyMigration(f);
  assert.equal(result.counts.tabs, 2);
  const saved = await readJSON(join(f.destination, "session.json"));
  for (const key of ["settings", "settingsMeta", "focusedWindowId", "lastProfileId", "launchTab", "orphanedProfileData"]) assert.deepEqual(saved[key], official[key]);
  assert.deepEqual(saved.profiles.default, official.profiles.default);
  for (const key of ["windows", "tabs", "groups", "splits", "closedTabs"]) assert.deepEqual(saved[key].slice(0, official[key].length), official[key]);
  const p = importedProfile(f.preview, "");
  assert.equal(saved.profiles[p].syncTabs, undefined);
  assert.equal(saved.tabs[2].profileId, p);
  assert.equal(saved.tabs[3].openerId, saved.tabs[2].id);
  assert.equal(saved.groups[1].tabIds[0], saved.tabs[2].id);
  assert.equal(saved.splits[1].slots[1].tabId, saved.tabs[3].id);
  assert.equal(saved.windows[1].activeTabIds[p], saved.tabs[2].id);
  assert.deepEqual(saved.tabs[2].page, { kind: "idle" });
  const imported = join(f.destination, "Chromium", `Profile ${p}`);
  assert.equal(await exists(join(imported, "Cookies")), false);
  assert.equal(await exists(join(imported, "Login Data")), false);
  assert.equal(await readFile(join(imported, "History"), "utf8"), "Preview history");
  assert.equal(await fileHash(join(f.destination, "Chromium/Default/History")), officialHistory);
  const extension = (await readJSON(join(f.destination, "Chromium/WebKit Extensions", f.identifier, "extensions.json"))).extensions[0];
  assert.equal(extension.id, f.id);
  assert.equal(extension.fingerprint, f.fingerprint);
  assert.deepEqual(extension.origins, ["https://fixture.invalid/*"]);
  assert.equal((await packageFingerprint(extension.path)).fingerprint, f.fingerprint);
  const sync = await readJSON(join(f.destination, "sync.json"));
  assert.deepEqual(sync.profiles.default, { syncId: "original", enabled: true });
  assert.equal(sync.profiles[p].enabled, false);
  assert.deepEqual(await inventory(f.preview), sourceBefore);
  assert.deepEqual(await inventory(f.webKit), storesBefore);
  const after = await inventory(f.destination);
  assert.equal((await applyMigration(f)).alreadyImported, true);
  assert.deepEqual(await inventory(f.destination), after);
  assert.equal(await exists(`${f.destination}.preview-import.lock`), false);
  assert.equal((await readJSON(join(f.backup, "transaction.json"))).status, "complete");
});

test("failed publication rolls back official bytes and added data using verified backups", async (t) => {
  const f = await fixture(t);
  const before = await inventory(f.destination);
  await assert.rejects(applyMigration({ ...f, afterPublish: () => { throw Error("injected failure"); } }), /injected failure/);
  assert.deepEqual(await inventory(f.destination), before);
  assert.equal((await readJSON(join(f.backup, "transaction.json"))).status, "rolled-back");
  assert.equal(await exists(`${f.destination}.preview-import.lock`), false);
});

test("changed approvals and unsafe scopes reject without writes", async (t) => {
  const f = await fixture(t);
  const before = await inventory(f.destination);
  await assert.rejects(planMigration({ ...f, destination: f.preview }), /separate/);
  await assert.rejects(planMigration({ ...f, fixtureRoot: f.destination }), /escaped/);
  await assert.rejects(applyMigration({ ...f, acceptTransfer: false }), /acknowledgement/);
  await assert.rejects(applyMigration({ ...f, checkClosed: () => { throw Error("browser still open"); } }), /still open/);
  const pkg = join(f.preview, "Chromium/WebKit Extensions", f.identifier, f.id, f.fingerprint);
  await writeFile(join(pkg, "한글.js"), "changed");
  await assert.rejects(planMigration(f), /approved fingerprint/);
  assert.deepEqual(await inventory(f.destination), before);
  assert.equal(await exists(f.backup), false);
});

test("package symlinks and canonical resource collisions fail closed", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.preview, "Chromium/WebKit Extensions", f.identifier, f.id, f.fingerprint);
  await symlink(join(f.destination, "session.json"), join(pkg, "escape"));
  await assert.rejects(planMigration(f), /symbolic link/);
});

test("session remapping rejects unknown schemas and preserves hostile own keys without prototype mutation", () => {
  const preview = session("Preview");
  preview.tabs[0].extra = JSON.parse('{"__proto__":{"bad":true},"kept":"yes"}');
  const merged = mergeSessions(session("Official"), preview, "/tmp/synthetic").session;
  assert.equal(Object.hasOwn(merged.tabs[2].extra, "__proto__"), true);
  assert.equal(merged.tabs[2].extra.kept, "yes");
  assert.equal({}.bad, undefined);
  assert.throws(() => mergeSessions(session("Official"), { ...preview, version: 12 }, "/tmp/synthetic"), /schema/);
  assert.throws(() => mergeSessions(session("Official"), { ...preview, profiles: { default: { ...preview.profiles.default, dataId: "../escape" } } }, "/tmp/synthetic"), /identity/);
});

test("all published metadata rolls back byte for byte when a later step fails", async (t) => {
  for (const point of ["sync", "session", "mapping"]) {
    const f = await fixture(t);
    const before = await inventory(f.destination);
    await assert.rejects(applyMigration({ ...f, afterMetadata: (step) => { if (step === point) throw Error("late failure"); } }), /late failure/);
    assert.deepEqual(await inventory(f.destination), before);
    assert.equal(await exists(`${f.destination}.preview-import.lock`), false);
  }
});

test("interrupted imports retain their lock and recover only from a verified matching backup", async (t) => {
  const f = await fixture(t);
  const before = await inventory(f.destination);
  let interrupted = false;
  await assert.rejects(applyMigration({ ...f, checkClosed: () => { if (interrupted) throw Error("no safe rollback"); }, afterMetadata: () => { interrupted = true; throw Error("interrupted"); } }), /rollback could not finish/);
  assert.equal(await exists(`${f.destination}.preview-import.lock`), true);
  await assert.rejects(applyMigration(f), /recovery/);
  const journal = await readFile(join(f.backup, "transaction.json"));
  await rm(join(f.backup, "transaction.json"));
  await assert.rejects(recoverMigration(f), /no recoverable preparation state/);
  assert.equal(await exists(`${f.destination}.preview-import.lock`), true);
  await writeFile(join(f.backup, "transaction.json"), journal);
  const original = await readFile(join(f.backup, "installed/session.json"));
  await writeFile(join(f.backup, "installed/session.json"), "changed backup");
  await assert.rejects(recoverMigration(f), /integrity/);
  assert.equal(await exists(`${f.destination}.preview-import.lock`), true);
  await writeFile(join(f.backup, "installed/session.json"), original);
  assert.equal((await recoverMigration(f)).recovered, true);
  assert.deepEqual(await inventory(f.destination), before);
  assert.equal(await exists(`${f.destination}.preview-import.lock`), false);
});

test("clear-history markers prevent revived WebKit and Chromium back-forward data", async (t) => {
  const f = await fixture(t);
  const history = join(f.preview, "Chromium/WebKit Tab History/p");
  await mkdir(history, { recursive: true });
  await writeFile(join(history, "61"), "old invalid history");
  await writeFile(`${history}.forgotten`, "cleared");
  await writeFile(`${history}.cleared`, "epoch");
  await writeFile(join(f.preview, "Chromium/Default/Ardia Tab History Cleared"), "generation");
  await applyMigration(f);
  const p = importedProfile(f.preview, "");
  const target = join(f.destination, "Chromium/WebKit Tab History", `p${Buffer.from(p).toString("hex").toUpperCase()}`);
  assert.equal(await exists(target), false);
  assert.equal(await readFile(`${target}.cleared`, "utf8"), "epoch");
  assert.equal(await readFile(join(f.destination, "Chromium", `Profile ${p}`, "Ardia Tab History Cleared"), "utf8"), "generation");
});

test("duplicate grants reject before copying and Chromium registration bytes stay unchanged", async (t) => {
  const f = await fixture(t);
  const metadata = join(f.preview, "Chromium/WebKit Extensions", f.identifier, "extensions.json");
  const saved = await readJSON(metadata);
  saved.extensions[0].permissions.push("storage");
  await writeFile(metadata, JSON.stringify(saved));
  await assert.rejects(planMigration(f), /duplicate/);
  saved.extensions[0].permissions.pop();
  await writeFile(metadata, JSON.stringify(saved));
  const id = "a".repeat(32);
  const profile = join(f.preview, "Chromium/Default");
  await mkdir(join(profile, "Extensions", id, "1_0"), { recursive: true });
  await writeFile(join(profile, "Extensions", id, "1_0/manifest.json"), '{"manifest_version":3}');
  await mkdir(join(profile, "Local Extension Settings", id), { recursive: true });
  await writeFile(join(profile, "Local Extension Settings", id, "synthetic"), "fixture settings");
  const prefs = JSON.stringify({ extensions: { settings: { [id]: { location: 1, path: `${id}/1_0`, state: 1 } } }, protection: { macs: { synthetic: "unaltered" } } });
  await writeFile(join(profile, "Secure Preferences"), prefs);
  await applyMigration(f);
  const target = join(f.destination, "Chromium", `Profile ${importedProfile(f.preview, "")}`);
  assert.equal(await readFile(join(target, "Secure Preferences"), "utf8"), prefs);
  assert.equal(await readFile(join(target, "Local Extension Settings", id, "synthetic"), "utf8"), "fixture settings");
});

test("a quit preview's last saved window reopens with its stored tab identities", () => {
  const original = session("Preview");
  const saved = { ...original, windows: [], tabs: [], groups: [], splits: [], windowOrder: [], closedWindows: [{ id: "closed-window", kind: "window", lastWindow: true, closedAt: 1,
    window: { profileId: "default", frame: [0, 0, 800, 600] }, tabs: original.tabs.map(({ id, windowId, page, openerId, ...tab }, i) => ({ ...tab, tabId: id, active: i === 1 })),
    groups: [{ id: "g", profileId: "default", name: "Fixture", tabIndexes: [0, 1] }], splits: [{ orientation: "horizontal", slots: original.splits[0].slots }] }] };
  const restored = restoreLastWindow(saved);
  assert.equal(restored.tabs.length, 2);
  assert.deepEqual(restored.tabs.map((tab) => tab.id), ["a", "b"]);
  assert.equal(restored.windows[0].activeTabIds.default, "b");
  assert.deepEqual(restored.groups[0].tabIds, ["a", "b"]);
  assert.equal(saved.closedWindows[0].lastWindow, true);
  assert.equal(restored.closedWindows[0].lastWindow, undefined);
  const cleaned = { ...original, cleanedTabs: [{ id: "cleaned", windowId: "", tab: { profileId: "default", url: "https://fixture.invalid" } }] };
  assert.equal(mergeSessions(session("Official"), cleaned, "/tmp/test").session.cleanedTabs[0].windowId, "");
});

test("recovery cannot overlap an active apply transaction", async (t) => {
  const f = await fixture(t);
  let attempted = false;
  const module = new URL("../../../scripts/personal/migrate-preview.mjs", import.meta.url).href;
  await applyMigration({ ...f, afterPublish: () => {
    if (attempted) return;
    attempted = true;
    const code = "const {recoverMigration}=await import(process.argv[1]);try{await recoverMigration(JSON.parse(process.argv[2]));process.exitCode=1}catch(error){console.log(error.message)}";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code, module, JSON.stringify(f)], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Another migration or recovery is running/);
  } });
  assert.equal(attempted, true);
  assert.equal((await readJSON(join(f.backup, "transaction.json"))).status, "complete");
});

test("an interruption before any backup manifest can safely cancel without modifying browser data", async (t) => {
  const f = await fixture(t);
  const before = await inventory(f.destination);
  let interrupted = false;
  await assert.rejects(applyMigration({ ...f, checkClosed: () => { if (interrupted) throw Error("interrupted"); }, beforeBackup: () => { interrupted = true; throw Error("interrupted"); } }), /rollback could not finish/);
  assert.equal(await exists(f.backup), false);
  const lock = await readJSON(`${f.destination}.preview-import.lock`);
  await writeFile(join(lock.stage, "metadata-interrupted"), "incomplete staged file");
  assert.deepEqual(await recoverMigration(f), { recovered: true, published: false });
  assert.deepEqual(await inventory(f.destination), before);
  assert.equal(await exists(lock.stage), false);
});

test("the transaction lock waits for a slow helper to start but fails at once when it is held or the helper exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ardia-migrate-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "installed");
  const helper = async (name, body) => {
    const path = join(root, name);
    await writeFile(path, `#!/usr/bin/python3\nimport os,sys,time\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const slow = await helper("slow", "time.sleep(6)\nos.execv('/usr/bin/python3',['/usr/bin/python3']+sys.argv[1:])");
  let started = Date.now();
  assert.equal(await exclusively(destination, async (assertLocked) => { assertLocked(); return "locked"; }, { interpreter: slow }), "locked");
  assert.ok(Date.now() - started >= 6000);
  const refused = () => assert.fail("an unlocked action must not run");
  await exclusively(destination, async () => {
    started = Date.now();
    await assert.rejects(exclusively(destination, refused), /Another migration or recovery is running/);
    assert.ok(Date.now() - started < 30000);
  });
  started = Date.now();
  await assert.rejects(exclusively(destination, refused, { interpreter: await helper("broken", "sys.exit(2)") }), /Another migration or recovery is running/);
  assert.ok(Date.now() - started < 30000);
  await assert.rejects(exclusively(destination, refused, { interpreter: await helper("silent", "time.sleep(600)"), startTimeout: 2000 }), /did not start in time/);
});

test("invalid private documents never appear in parse errors", () => {
  const canary = "synthetic-private-token-do-not-log";
  try { parseJSON(Buffer.from(`not-valid-${canary}`)); assert.fail("must reject"); }
  catch (error) { assert.match(error.message, /invalid JSON/); assert.equal(error.message.includes(canary), false); }
});
