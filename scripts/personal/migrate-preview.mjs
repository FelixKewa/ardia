#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { exists, owned, parseJSON, readJSON, readSafe, fileHash, inventory, copyTree, copyFileChecked, replaceFileChecked, writeJSON, packageFingerprint, within, exclusively } from "./migrate-preview-files.mjs";
import { hash, importedProfile, mergeSessions, restoreLastWindow, storeIdentifier, validateSession } from "./migrate-preview-session.mjs";

const MAP = "WebKit Imported Stores.json";
const installedRoot = () => join(homedir(), "Library/Application Support/com.ardia.browser");
const webKitRoot = () => join(homedir(), "Library/WebKit/com.ardia.browser");
const CHROME_FILES = ["Bookmarks", "Bookmarks.bak", "BookmarkMergedSurfaceOrdering", "History", "History-journal", "History-wal", "History-shm", "Favicons", "Favicons-journal", "Favicons-wal", "Favicons-shm", "Preferences", "Secure Preferences", "Ardia Tab History Cleared"];
const CHROME_DIRS = ["Extensions", "Local Extension Settings", "Sync Extension Settings", "Extension State", "Extension Rules", "Extension Scripts"];
const supported = new Set(["activeTab", "scripting", "storage", "unlimitedStorage", "contextMenus", "tabs"]);
const hex = (text) => Buffer.from(text).toString("hex").toUpperCase();
const jsonHash = (value) => hash(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isUUID = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const syncId = () => {
  const bits = [...randomBytes(16)].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  return bits.match(/.{1,5}/g).map((part) => "abcdefghijklmnopqrstuvwxyz234567"[parseInt(part.padEnd(5, "0"), 2)]).join("");
};
const inventoryOrFile = async (path) => (await lstat(path)).isDirectory() ? inventory(path) : [{ path: "", bytes: (await owned(path)).size, sha256: await fileHash(path) }];
const fixtureRoot = async (path) => {
  const root = await realpath(path);
  if (!within(await realpath(tmpdir()), root) || !basename(root).startsWith("ardia-migrate-fixture-")) throw Error("Fixture migration escaped a dedicated temporary test directory.");
  return root;
};

export function browsersClosed() {
  const lines = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).split("\n");
  if (lines.some((line) => /\/Ardia\.app\/Contents\//.test(line) || /\sArdia(?: Helper(?: \([^)]*\))?)?$/.test(line))) throw Error("Quit official Ardia and every preview before migration; no browser will be closed automatically.");
}

async function scopeChecked(options) {
  const preview = options.preview;
  const destination = options.destination ?? installedRoot();
  const stores = options.webKit ?? webKitRoot();
  if (![preview, destination, stores].every((p) => typeof p === "string" && isAbsolute(p) && p === resolve(p) && p !== "/")) throw Error("Use absolute, standardized data paths.");
  await Promise.all([owned(preview, true), owned(destination, true), owned(stores, true)]);
  const actual = await Promise.all([realpath(preview), realpath(destination), realpath(stores)]);
  if (actual.some((a, i) => actual.some((b, j) => i !== j && (a === b || within(a, b))))) throw Error("Preview, installed data and WebKit storage must be separate directories.");
  if (!options.fixture && (await realpath(installedRoot()) !== actual[1] || await realpath(webKitRoot()) !== actual[2])) throw Error("Real migration only targets this user's installed com.ardia.browser data.");
  if (options.fixture && !options.fixtureRoot) throw Error("Fixture migrations require a confined fixture root.");
  if (options.fixture) {
    const root = await fixtureRoot(options.fixtureRoot);
    if (!actual.every((path) => within(root, path))) throw Error("Fixture migration escaped its scratch directory.");
  }
  return { preview, destination, stores };
}

async function validateExtension(directory, record) {
  if (!isUUID(record.id) || !/^[0-9a-f]{64}$/.test(record.fingerprint) || typeof record.path !== "string" || !isAbsolute(record.path) || typeof record.enabled !== "boolean" || typeof record.name !== "string" || typeof record.version !== "string") throw Error("Invalid saved extension identity.");
  for (const key of ["requestedPermissions", "requestedOrigins", "permissions", "origins"]) if (!Array.isArray(record[key]) || record[key].some((v) => typeof v !== "string") || new Set(record[key]).size !== record[key].length) throw Error("Invalid or duplicate saved extension permissions.");
  if (record.permissions.some((p) => !supported.has(p) || !record.requestedPermissions.includes(p)) || record.origins.some((p) => !/^https:\/\/[a-z0-9.-]+\/\*$/.test(p))) throw Error("Unsafe saved extension grants.");
  const packagePath = join(directory, record.id, record.fingerprint);
  const checked = await packageFingerprint(packagePath);
  if (![checked.fingerprint, checked.legacyFingerprint].includes(record.fingerprint)) throw Error("Managed extension no longer matches its approved fingerprint.");
  const manifest = await readJSON(join(packagePath, "manifest.json"));
  const declaredPermissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
  const declaredOrigins = [...declaredPermissions, ...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? []), ...(manifest.content_scripts ?? []).flatMap((s) => s.matches ?? [])];
  const covers = (pattern, origin) => {
    if (pattern === "<all_urls>") return true;
    const match = /^(\*|https):\/\/(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+)\/\*$/.exec(pattern);
    if (!match) return false;
    const host = new URL(origin).hostname;
    return match[2] === "*" || match[2] === host || (match[2].startsWith("*.") && (host === match[2].slice(2) || host.endsWith(match[2].slice(1))));
  };
  if (record.permissions.some((p) => !declaredPermissions.includes(p)) || record.origins.some((p) => !declaredOrigins.some((pattern) => covers(pattern, p)))) throw Error("Saved grants exceed the verified extension manifest.");
  return { record, packagePath, files: checked.files };
}

async function chromiumChecked(directory) {
  if (!await exists(directory)) return { extensions: 0 };
  await owned(directory, true);
  const path = join(directory, "Secure Preferences");
  if (!await exists(path)) return { extensions: 0 };
  const bytes = await readSafe(path);
  const prefs = parseJSON(bytes);
  const settings = prefs.extensions?.settings ?? {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw Error("Invalid Chromium extension registrations.");
  let extensions = 0;
  for (const [id, registration] of Object.entries(settings)) {
    if (!/^[a-p]{32}$/.test(id) || !registration || typeof registration !== "object") throw Error("Invalid Chromium extension registration.");
    if (registration.location === 5) continue;
    if (registration.location !== 1 || typeof registration.path !== "string" || isAbsolute(registration.path) || !within(join(directory, "Extensions"), resolve(directory, "Extensions", registration.path))) throw Error("Preview contains an unpacked or external Chromium extension; migrate it separately before continuing.");
    await owned(resolve(directory, "Extensions", registration.path), true);
    extensions++;
  }
  return { extensions, registrationHash: hash(bytes) };
}

export async function planMigration(options) {
  const roots = await scopeChecked(options);
  const sourceBytes = await readSafe(join(roots.preview, "session.json"));
  const targetBytes = await readSafe(join(roots.destination, "session.json"));
  const previewSession = restoreLastWindow(parseJSON(sourceBytes));
  const officialSession = validateSession(parseJSON(targetBytes));
  const receiptName = `preview-import-${hash(roots.preview).slice(0, 32)}.json`;
  const receiptPath = join(roots.destination, "Personal Migrations", receiptName);
  if (await exists(receiptPath)) {
    const receipt = await readJSON(receiptPath);
    if (receipt.version !== 1 || receipt.status !== "complete" || receipt.sourceScope !== roots.preview || receipt.destination !== roots.destination || !Array.isArray(receipt.profiles) || receipt.profiles.some((p) => !Object.hasOwn(officialSession.profiles, p.profile))) throw Error("Existing migration receipt needs manual recovery.");
    const map = await readJSON(join(roots.destination, "Chromium", MAP));
    if (receipt.profiles.some((p) => !map.entries?.some((entry) => same(entry, p)))) throw Error("Migration receipt and store ownership disagree.");
    return { alreadyImported: true, roots, receiptPath, counts: receipt.counts };
  }
  const merged = mergeSessions(officialSession, previewSession, roots.preview);
  const sourceExtensions = join(roots.preview, "Chromium/WebKit Extensions");
  if (await exists(sourceExtensions)) {
    const expected = new Set(merged.profiles.map((p) => p.identifier.toLowerCase()));
    if ((await readdir(sourceExtensions)).some((name) => !expected.has(name.toLowerCase()))) throw Error("Preview extension stores do not match the exact source scope; preserve the original /var or /private/var spelling.");
  }
  const mapPath = join(roots.destination, "Chromium", MAP);
  const mapping = await exists(mapPath) ? await readJSON(mapPath) : { version: 1, destination: join(roots.destination, "Chromium"), entries: [] };
  if (mapping.version !== 1 || mapping.destination !== join(roots.destination, "Chromium") || !Array.isArray(mapping.entries)) throw Error("Unsupported imported-store document.");
  const existingStores = new Set(Object.values(officialSession.profiles).map((p) => storeIdentifier("", (p.dataId ?? p.id) === "default" ? "" : (p.dataId ?? p.id))));
  for (const entry of mapping.entries) {
    if (entry.profile !== importedProfile(entry.sourceScope, entry.sourceProfile) || entry.identifier !== storeIdentifier(entry.sourceScope, entry.sourceProfile)) throw Error("Invalid existing imported-store mapping.");
    if (existingStores.has(entry.identifier)) throw Error("Store ownership collision.");
    existingStores.add(entry.identifier);
  }
  const profiles = [];
  let extensions = 0;
  let chromiumExtensions = 0;
  for (const profile of merged.profiles) {
    if (existingStores.has(profile.identifier)) throw Error("Preview store already belongs to an installed profile.");
    existingStores.add(profile.identifier);
    const sourceDirectory = join(roots.preview, "Chromium/WebKit Extensions", profile.identifier);
    let records = [];
    let metadataHash = null;
    if (await exists(join(sourceDirectory, "extensions.json"))) {
      const bytes = await readSafe(join(sourceDirectory, "extensions.json"));
      const saved = parseJSON(bytes);
      metadataHash = hash(bytes);
      if (saved.version !== 1 || !Array.isArray(saved.extensions) || new Set(saved.extensions.map((r) => r.id)).size !== saved.extensions.length) throw Error("Unsupported extension settings document.");
      for (const record of saved.extensions) records.push(await validateExtension(sourceDirectory, record));
    }
    const chromium = join(roots.preview, "Chromium", profile.sourceProfile ? `Profile ${profile.sourceProfile}` : "Default");
    const chrome = await chromiumChecked(chromium);
    chromiumExtensions += chrome.extensions;
    extensions += records.length;
    profiles.push({ ...profile, sourceScope: roots.preview, sourceDirectory, records, chromium, metadataHash, registrationHash: chrome.registrationHash ?? null });
  }
  const entries = profiles.map(({ profile, sourceScope, sourceProfile, identifier }) => ({ profile, sourceScope, sourceProfile, identifier }));
  const syncPath = join(roots.destination, "sync.json");
  const syncExists = await exists(syncPath);
  const sync = syncExists ? await readJSON(syncPath) : { v: 1, enabled: false, folder: null, deviceId: null, clock: null, types: {}, profiles: {}, lastSyncedAt: null, setupAt: null, joining: false };
  if (sync.v !== 1 || !sync.profiles || typeof sync.profiles !== "object" || Array.isArray(sync.profiles)) throw Error("Unsupported sync document; import must remain local.");
  for (const entry of entries) {
    if (Object.hasOwn(sync.profiles, entry.profile)) throw Error("Imported profile already has sync state.");
    sync.profiles[entry.profile] = { syncId: syncId(), enabled: false };
  }
  return { roots, receiptPath, receiptName, sourceHash: hash(sourceBytes), targetHash: hash(targetBytes), officialSession, previewSession, merged, profiles,
    mapping: { ...mapping, entries: [...mapping.entries, ...entries] }, entries, sync, syncExists, syncHash: syncExists ? await fileHash(syncPath) : null,
    counts: { profiles: profiles.length, windows: previewSession.windows.length, tabs: previewSession.tabs.length, webKitExtensions: extensions, chromiumExtensions } };
}

async function stageImport(plan, stage) {
  const additions = [];
  const add = async (relativePath, build) => {
    if (await exists(join(plan.roots.destination, relativePath))) throw Error("Import would replace existing profile data.");
    const target = join(stage, relativePath);
    await build(target);
    additions.push(relativePath);
  };
  for (const profile of plan.profiles) {
    const chromePath = join("Chromium", `Profile ${profile.profile}`);
    await add(chromePath, async (target) => {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const file of CHROME_FILES) if (await exists(join(profile.chromium, file))) await copyFileChecked(join(profile.chromium, file), join(target, file));
      for (const dir of CHROME_DIRS) if (await exists(join(profile.chromium, dir))) await copyTree(join(profile.chromium, dir), join(target, dir));
      const history = join(profile.chromium, "Ardia Tab History");
      for (const tab of plan.previewSession.tabs.filter((tab) => (plan.previewSession.profiles[tab.profileId].dataId ?? tab.profileId) === (profile.sourceProfile || "default"))) {
        const file = join(history, hex(tab.id));
        if (await exists(file)) await copyFileChecked(file, join(target, "Ardia Tab History", hex(plan.merged.ids.get(tab.id))));
      }
    });
    if (profile.records.length) {
      await add(join("Chromium/WebKit Extensions", profile.identifier), async (target) => {
        const records = [];
        for (const item of profile.records) {
          const sourceRelative = join("Personal Extensions", profile.profile, item.record.id);
          await add(sourceRelative, (path) => copyTree(item.packagePath, path));
          await copyTree(item.packagePath, join(target, item.record.id, item.record.fingerprint));
          for (const path of [join(stage, sourceRelative), join(target, item.record.id, item.record.fingerprint)]) {
            const checked = await packageFingerprint(path);
            if (![checked.fingerprint, checked.legacyFingerprint].includes(item.record.fingerprint)) throw Error("Approved extension changed during migration staging.");
          }
          records.push({ ...item.record, path: join(plan.roots.destination, sourceRelative) });
        }
        await writeJSON(join(target, "extensions.json"), { version: 1, extensions: records });
      });
    }
    const sourceHistory = join(plan.roots.preview, "Chromium/WebKit Tab History", `p${hex(profile.sourceProfile)}`);
    if (await exists(sourceHistory) && !await exists(`${sourceHistory}.forgotten`)) await add(join("Chromium/WebKit Tab History", `p${hex(profile.profile)}`), async (target) => {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const tab of plan.previewSession.tabs) {
        const file = join(sourceHistory, hex(tab.id));
        if (await exists(file)) await copyFileChecked(file, join(target, hex(plan.merged.ids.get(tab.id))));
      }
    });
    if (await exists(`${sourceHistory}.cleared`)) await add(join("Chromium/WebKit Tab History", `p${hex(profile.profile)}.cleared`), (target) => copyFileChecked(`${sourceHistory}.cleared`, target));
    const transport = join(plan.roots.preview, "Chromium/WebKit Transport Security", `p${hex(profile.sourceProfile)}.json`);
    if (await exists(transport)) await add(join("Chromium/WebKit Transport Security", `p${hex(profile.profile)}.json`), (target) => copyFileChecked(transport, target));
  }
  return additions;
}

async function backupAll(plan, backup) {
  await mkdir(backup, { recursive: false, mode: 0o700 });
  const manifest = { version: 1, destination: plan.roots.destination, sourceScope: plan.roots.preview, roots: [] };
  for (const [name, source] of [["installed", plan.roots.destination], ["preview", plan.roots.preview]]) {
    const files = await copyTree(source, join(backup, name));
    manifest.roots.push({ name, source, files });
  }
  for (const profile of plan.profiles) for (const [kind, name] of [["WebsiteDataStore", profile.identifier.toLowerCase()], ["WebExtensions", profile.identifier]]) {
    const source = join(plan.roots.stores, kind, name);
    if (!await exists(source)) continue;
    const nameInBackup = join("webkit", kind, name);
    const files = await copyTree(source, join(backup, nameInBackup));
    manifest.roots.push({ name: nameInBackup, source, files });
  }
  await writeJSON(join(backup, "manifest.json"), manifest);
  const saved = await readJSON(join(backup, "manifest.json"));
  for (const root of saved.roots) if (!same(root.files, await inventory(join(backup, root.name))) || !same(root.files, await inventory(root.source))) throw Error("Backup integrity failed; no profile data imported.");
  return jsonHash(saved);
}

export async function applyMigration(options) {
  const roots = await scopeChecked(options);
  return exclusively(roots.destination, (assertLocked) => applyLocked(options, assertLocked));
}

async function applyLocked(options, assertLocked) {
  if (!options.acceptTransfer) throw Error("Explicit ownership-transfer acknowledgement is required; retire the preview after importing.");
  const checkClosed = () => { assertLocked(); (options.fixture ? (options.checkClosed ?? (() => {})) : browsersClosed)(); };
  checkClosed();
  if (await exists(`${options.destination ?? installedRoot()}.preview-import.lock`)) throw Error("An interrupted migration needs verified recovery before retrying.");
  const plan = await planMigration(options);
  if (plan.alreadyImported) return { alreadyImported: true, counts: plan.counts };
  const backup = options.backup;
  if (!backup || !isAbsolute(backup) || resolve(backup) !== backup || await exists(backup)) throw Error("Choose a new absolute backup directory.");
  const backupParent = await realpath(dirname(backup));
  for (const path of Object.values(plan.roots)) if (within(await realpath(path), backupParent) || await realpath(path) === backupParent) throw Error("Backup must be outside browser data.");
  if (options.fixture && backupParent !== await realpath(options.fixtureRoot) && !within(await realpath(options.fixtureRoot), backupParent)) throw Error("Fixture backup escaped scratch.");
  const lockPath = `${plan.roots.destination}.preview-import.lock`;
  const stage = join(dirname(plan.roots.destination), `.ardia-preview-import-${randomUUID()}`);
  const installed = [];
  let sessionWritten = false;
  let mapWritten = false;
  let syncWritten = false;
  let recoveryRequired = false;
  let markerCreated = false;
  const mapPath = join(plan.roots.destination, "Chromium", MAP);
  let hadMap = false;
  try {
    await mkdir(stage, { mode: 0o700 });
    if (await exists(lockPath)) throw Error("An interrupted migration needs recovery.");
    await writeJSON(lockPath, { version: 1, phase: "backup", destination: plan.roots.destination, sourceScope: plan.roots.preview, backup, stage }, stage);
    markerCreated = true;
    checkClosed();
    hadMap = await exists(mapPath);
    if (options.fixture) options.beforeBackup?.();
    const backupHash = await backupAll(plan, backup);
    checkClosed();
    const additions = await stageImport(plan, stage);
    if (await fileHash(join(plan.roots.preview, "session.json")) !== plan.sourceHash || await fileHash(join(plan.roots.destination, "session.json")) !== plan.targetHash) throw Error("A browser session changed during migration.");
    const syncPath = join(plan.roots.destination, "sync.json");
    if ((await exists(syncPath) ? await fileHash(syncPath) : null) !== plan.syncHash) throw Error("Sync settings changed during migration.");
    const verifiedBackup = await readJSON(join(backup, "manifest.json"));
    for (const snapshot of verifiedBackup.roots) if (!same(snapshot.files, await inventory(snapshot.source))) throw Error("Browser data changed after the verified backup.");
    for (const profile of plan.profiles) for (const [path, expected] of [[join(profile.sourceDirectory, "extensions.json"), profile.metadataHash], [join(profile.chromium, "Secure Preferences"), profile.registrationHash]]) {
      if ((await exists(path) ? await fileHash(path) : null) !== expected) throw Error("Extension approval or registration changed since inspection.");
    }
    checkClosed();
    const payloads = { "session.json": plan.merged.session, "sync.json": plan.sync, [join("Chromium", MAP)]: plan.mapping };
    const staged = [];
    for (const path of additions) staged.push({ path, files: await inventoryOrFile(join(stage, path)) });
    const transaction = { version: 1, status: "prepared", destination: plan.roots.destination, sourceScope: plan.roots.preview, additions: staged,
      metadata: Object.fromEntries(Object.entries(payloads).map(([path, value]) => [path, hash(JSON.stringify(value) + "\n")])), sourceHash: plan.sourceHash, targetHash: plan.targetHash, backupHash, receipt: plan.receiptPath };
    await writeJSON(join(backup, "transaction.json"), transaction);
    await writeJSON(lockPath, { version: 1, phase: "prepared", destination: plan.roots.destination, sourceScope: plan.roots.preview, backup, backupHash, stage }, stage);
    for (const path of additions) {
      assertLocked();
      const target = join(plan.roots.destination, path);
      if (await exists(target)) throw Error("Import destination changed during staging.");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(join(stage, path), target);
      installed.push(target);
      if (options.fixture) options.afterPublish?.(installed.length);
    }
    checkClosed();
    await writeJSON(syncPath, plan.sync, stage);
    syncWritten = true;
    if (options.fixture) options.afterMetadata?.("sync");
    assertLocked();
    await writeJSON(join(plan.roots.destination, "session.json"), plan.merged.session, stage);
    sessionWritten = true;
    if (options.fixture) options.afterMetadata?.("session");
    assertLocked();
    await writeJSON(mapPath, plan.mapping, stage);
    mapWritten = true;
    if (options.fixture) options.afterMetadata?.("mapping");
    assertLocked();
    const receipt = { version: 1, status: "complete", sourceScope: plan.roots.preview, destination: plan.roots.destination,
      backup, backupHash, sourceHash: plan.sourceHash, originalSessionHash: plan.targetHash, importedSessionHash: jsonHash(plan.merged.session),
      profiles: plan.entries, counts: plan.counts, previewRetired: true, credentialDatabasesCopied: false };
    await writeJSON(plan.receiptPath, receipt, stage);
    await writeJSON(join(backup, "transaction.json"), { ...transaction, status: "complete" });
    return { alreadyImported: false, counts: plan.counts, backupHash };
  } catch (error) {
    try {
      checkClosed();
      if (sessionWritten) await replaceFileChecked(join(backup, "installed/session.json"), join(plan.roots.destination, "session.json"), stage);
      assertLocked();
      if (mapWritten) {
        if (hadMap) await replaceFileChecked(join(backup, "installed/Chromium", MAP), mapPath, stage);
        else await rename(mapPath, join(stage, `trash-${randomUUID()}`));
      }
      if (syncWritten) {
        assertLocked();
        if (plan.syncExists) await replaceFileChecked(join(backup, "installed/sync.json"), join(plan.roots.destination, "sync.json"), stage);
        else await rename(join(plan.roots.destination, "sync.json"), join(stage, `trash-${randomUUID()}`));
      }
      if (await exists(plan.receiptPath)) await rename(plan.receiptPath, join(stage, `trash-${randomUUID()}`));
      for (const path of installed.reverse()) { assertLocked(); await rename(path, join(stage, `trash-${randomUUID()}`)); }
      if (await exists(backup)) await writeJSON(join(backup, "transaction.json"), { version: 1, status: "rolled-back", destination: plan.roots.destination });
    } catch {
      recoveryRequired = true;
      throw Error("Migration interrupted and rollback could not finish. Keep both browsers closed; retain the lock and verified backup for recovery.");
    }
    throw error;
  } finally {
    if (!recoveryRequired) { await rm(stage, { recursive: true, force: true }); if (markerCreated) await rm(lockPath); }
  }
}

export async function recoverMigration(options) {
  const destination = options.destination ?? installedRoot();
  await owned(destination, true);
  if (options.fixture ? !options.fixtureRoot || !within(await fixtureRoot(options.fixtureRoot), await realpath(destination)) : await realpath(destination) !== await realpath(installedRoot())) throw Error("Invalid recovery scope.");
  return exclusively(destination, (assertLocked) => recoverLocked(options, assertLocked));
}

async function recoverLocked(options, assertLocked) {
  const checkClosed = () => { assertLocked(); (options.fixture ? (options.checkClosed ?? (() => {})) : browsersClosed)(); };
  checkClosed();
  const destination = options.destination ?? installedRoot();
  const backup = options.backup;
  if (!backup || !isAbsolute(backup)) throw Error("Verified recovery requires the original backup directory.");
  if (!options.fixture && await realpath(destination) !== await realpath(installedRoot())) throw Error("Recovery target is not the installed browser.");
  const backupResolved = await exists(backup) ? await realpath(backup) : join(await realpath(dirname(backup)), basename(backup));
  if (options.fixture && (!options.fixtureRoot || !within(await fixtureRoot(options.fixtureRoot), await realpath(destination)) || !within(await fixtureRoot(options.fixtureRoot), backupResolved))) throw Error("Fixture recovery escaped scratch.");
  const lockPath = `${destination}.preview-import.lock`;
  const lock = await readJSON(lockPath);
  if (lock.version !== 1 || lock.destination !== destination || lock.backup !== backup || dirname(lock.stage) !== dirname(destination) || !lock.stage.startsWith(join(dirname(destination), ".ardia-preview-import-"))) throw Error("Migration lock does not match this recovery.");
  const journalPath = join(backup, "transaction.json");
  if (!await exists(journalPath)) {
    if (lock.phase !== "backup") throw Error("Interrupted transaction has no recoverable preparation state.");
    checkClosed();
    await rm(lock.stage, { recursive: true, force: true });
    await rm(lockPath);
    return { recovered: true, published: false };
  }
  const manifest = await readJSON(join(backup, "manifest.json"));
  if (manifest.version !== 1 || manifest.destination !== destination || manifest.sourceScope !== lock.sourceScope || !Array.isArray(manifest.roots)) throw Error("Backup manifest does not match the locked migration.");
  if (lock.phase === "prepared" && lock.backupHash !== jsonHash(manifest)) throw Error("Backup integrity does not match the prepared transaction.");
  for (const root of manifest.roots) {
    if (typeof root.name !== "string" || !within(backup, resolve(backup, root.name)) || !same(root.files, await inventory(join(backup, root.name)))) throw Error("Backup integrity failed; recovery stopped.");
  }
  const original = manifest.roots.find((root) => root.name === "installed");
  if (!original) throw Error("Backup has no installed browser snapshot.");
  await mkdir(lock.stage, { recursive: true, mode: 0o700 });
  await owned(lock.stage, true);
  if (!await exists(journalPath)) {
    if (!same(original.files, await inventory(destination))) throw Error("Unjournaled changes need manual recovery; lock retained.");
  } else {
    const journal = await readJSON(journalPath);
    if (journal.status === "rolled-back") {
      if (!same(original.files, await inventory(destination))) throw Error("Rolled-back state failed verification; lock retained.");
    } else {
      if (journal.version !== 1 || journal.destination !== destination || journal.sourceScope !== lock.sourceScope || journal.backupHash !== jsonHash(manifest) || !["prepared", "complete"].includes(journal.status) || !Array.isArray(journal.additions)) throw Error("Unknown transaction state; lock retained.");
      const source = restoreLastWindow(await readJSON(join(backup, "preview/session.json")));
      const profiles = Object.values(source.profiles).map((p) => ({ source: (p.dataId ?? p.id) === "default" ? "" : (p.dataId ?? p.id) }));
      const allowed = new Set();
      for (const p of profiles) {
        const profile = importedProfile(lock.sourceScope, p.source);
        const identifier = storeIdentifier(lock.sourceScope, p.source);
        for (const path of [join("Chromium", `Profile ${profile}`), join("Chromium/WebKit Extensions", identifier), join("Chromium/WebKit Tab History", `p${hex(profile)}`), join("Chromium/WebKit Tab History", `p${hex(profile)}.cleared`), join("Chromium/WebKit Transport Security", `p${hex(profile)}.json`)]) allowed.add(path);
        const saved = join(backup, "preview/Chromium/WebKit Extensions", identifier, "extensions.json");
        if (await exists(saved)) for (const record of (await readJSON(saved)).extensions) {
          if (!isUUID(record.id)) throw Error("Invalid backed-up extension identity.");
          allowed.add(join("Personal Extensions", profile, record.id));
        }
      }
      for (const addition of journal.additions) {
        if (!allowed.has(addition.path)) throw Error("Unexpected added path in transaction; lock retained.");
        const target = join(destination, addition.path);
        if (await exists(target) && !same(addition.files, await inventoryOrFile(target))) throw Error("Imported data changed after interruption; recovery will not remove it.");
      }
      for (const path of ["session.json", "sync.json", join("Chromium", MAP)]) {
        assertLocked();
        const target = join(destination, path);
        const before = original.files.find((file) => file.path === path)?.sha256;
        const current = await exists(target) ? await fileHash(target) : undefined;
        if (current !== before && current !== journal.metadata?.[path]) throw Error("Browser metadata changed after interruption; lock retained.");
      }
      checkClosed();
      for (const path of ["session.json", "sync.json", join("Chromium", MAP)]) {
        const saved = join(backup, "installed", path);
        const target = join(destination, path);
        if (await exists(saved)) await replaceFileChecked(saved, target, lock.stage);
        else if (await exists(target)) await rename(target, join(lock.stage, `trash-${randomUUID()}`));
      }
      const receipt = join(destination, "Personal Migrations", `preview-import-${hash(lock.sourceScope).slice(0, 32)}.json`);
      if (await exists(receipt)) {
        const saved = await readJSON(receipt);
        if (saved.backupHash !== journal.backupHash || saved.sourceScope !== lock.sourceScope) throw Error("Unexpected receipt; lock retained.");
        await rename(receipt, join(lock.stage, `trash-${randomUUID()}`));
      }
      for (const addition of journal.additions) if (await exists(join(destination, addition.path))) { assertLocked(); await rename(join(destination, addition.path), join(lock.stage, `trash-${randomUUID()}`)); }
    }
  }
  if (!same(original.files, await inventory(destination))) throw Error("Restored data differs from backup; lock retained.");
  checkClosed();
  await writeJSON(journalPath, { version: 1, status: "rolled-back", destination });
  await rm(lock.stage, { recursive: true, force: true });
  await rm(lockPath);
  return { recovered: true };
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--recover") options.recover = true;
    else if (flag === "--accept-transfer") options.acceptTransfer = true;
    else if (["--preview", "--backup"].includes(flag)) options[flag.slice(2)] = args[++i];
    else if (flag === "--help") { console.log("Usage: node scripts/personal/migrate-preview.mjs --preview ABSOLUTE_DATA_DIR [--apply --accept-transfer --backup NEW_BACKUP_DIR]\nRecovery: node scripts/personal/migrate-preview.mjs --recover --backup ORIGINAL_BACKUP_DIR\nDefault: inspect a plan without changing files. Apply requires both browsers closed. Official settings remain active; preview settings are retained in the backup. The preview must be retired after its WebKit storage is transferred. Preview Chromium cookies/passwords are excluded."); return; }
    else throw Error("Unknown migration argument.");
  }
  if (options.apply && options.recover) throw Error("Choose either apply or recovery.");
  const result = options.recover ? await recoverMigration(options) : options.apply ? await applyMigration(options) : await planMigration(options);
  console.log(JSON.stringify({ mode: options.recover ? "recover" : options.apply ? "apply" : "plan", alreadyImported: !!result.alreadyImported, recovered: !!result.recovered, counts: result.counts, ...(result.backupHash ? { backupHash: result.backupHash } : {}) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
