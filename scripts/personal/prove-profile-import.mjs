import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, session, sleep } from "../lib/instance.mjs";
import { applyMigration } from "./migrate-preview.mjs";
import { importedProfile } from "./migrate-preview-session.mjs";

const app = process.argv[2];
if (!app) throw Error("Usage: node scripts/personal/prove-profile-import.mjs BUILD/Ardia.app");
const root = await mkdtemp(join(tmpdir(), "ardia-migrate-fixture-"));
const preview = join(root, "preview");
const destination = join(root, "installed");
const webKit = join(root, "webkit");
const extension = join(root, "fixture-extension");
await mkdir(extension);
await mkdir(webKit);
await mkdir(destination);
const manifest = { manifest_version: 3, name: "Ardia profile import fixture", version: "1.0.0", permissions: ["storage"], background: { service_worker: "background.js" } };
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
await writeFile(join(extension, "background.js"), 'chrome.runtime.onInstalled.addListener(async () => { const saved = await chrome.storage.local.get("fixtureMarker"); if (!saved.fixtureMarker) await chrome.storage.local.set({fixtureMarker:"preserved-synthetic-setting"}); });');
await writeFile(join(extension, "probe.html"), '<!doctype html><title>Import fixture</title><script src="probe.js"></script>');
await writeFile(join(extension, "probe.js"), 'chrome.storage.local.get("fixtureMarker").then(value => { document.documentElement.dataset.fixtureMarker = value.fixtureMarker || "missing"; });');
const zip = join(root, "fixture.zip");
execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", extension, zip]);
const archive = await readFile(zip);
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
const idBytes = createHash("sha256").update(publicKey).digest().subarray(0, 16);
const id = [...idBytes.toString("hex")].map((value) => String.fromCharCode(97 + parseInt(value, 16))).join("");
const varint = (value) => { const bytes = []; do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); };
const field = (number, bytes) => Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
const uint32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const signedHeader = field(1, idBytes);
const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0"), uint32(signedHeader.length), signedHeader, archive]);
const proof = Buffer.concat([field(1, publicKey), field(2, sign("RSA-SHA256", payload, keys.privateKey))]);
const header = Buffer.concat([field(2, proof), field(10000, signedHeader)]);
const crx = join(root, "fixture.crx");
await writeFile(crx, Buffer.concat([Buffer.from("Cr24"), uint32(3), uint32(header.length), header, archive]));
let instance;
const q = JSON.stringify;
const engine = (name, args = {}) => instance.eval(`return ac.engine.call(${q(name)}, ${q(args)})`);
const until = async (label, read) => {
  for (const end = Date.now() + 15000; Date.now() < end; await sleep(100)) {
    if (!instance.alive) throw Error(`Owned fixture app exited: ${label}`);
    const value = await read();
    if (value) return value;
  }
  throw Error(`Timed out: ${label}`);
};
const start = async (data, initial) => {
  instance = await launch(resolve(app), { data, probe: true, js: "none", onboarded: true, ...(initial ? { session: initial } : {}) });
};
const checkStorage = async (profile) => {
  const tree = await engine("bookmarks.tree", { profile });
  const bookmarks = (node) => [node, ...(node.c ?? []).flatMap(bookmarks)];
  assert(bookmarks(tree.bar).some((row) => row.u === "https://fixture.invalid/bookmark"), "Imported bookmark must remain available");
  const history = await engine("history.query", { profile, maxUrls: 100, maxVisits: 10 });
  assert(history.entries.some((row) => row.u === "https://fixture.invalid/history"), "Imported history must remain available");
  const extensions = (await engine("extensions.list", { profile })).extensions;
  const installed = extensions.find((item) => item.id === id);
  assert(installed?.enabled, "Synthetic extension must still be enabled");
  const tabId = await instance.eval(`const s = ac.store.getState(); const tab = Object.values(s.tabs).find(t => (s.profiles[t.profileId]?.dataId ?? t.profileId) === ${q(profile || "default")}); if (!tab) throw Error("No fixture tab"); s.navigate(tab.id, ${q(`chrome-extension://${id}/probe.html`)}, {userInitiated:true}); return tab.id;`);
  const page = await instance.page(`chrome-extension://${id}/probe.html`);
  try { assert.equal(await until("extension local storage", () => page.eval("document.documentElement.dataset.fixtureMarker")), "preserved-synthetic-setting"); }
  finally { page.close(); }
  return tabId;
};
try {
  await start(preview, session({ tabs: [{ id: "fixture", url: "about:blank", title: "Synthetic extension fixture" }] }));
  await instance.eval(`globalThis.importFixturePrompt = ac.engine.on("extensions.installPrompt", prompt => { if (prompt.id === ${q(id)} && prompt.profile === "") void ac.engine.call("extensions.resolveInstallPrompt", {profile:"",requestId:prompt.requestId,accepted:true}); }); return true;`);
  assert.equal((await engine("extensions.installCrx", { profile: "", path: crx })).id, id);
  const tree = await engine("bookmarks.tree", { profile: "" });
  assert.equal((await engine("bookmarks.apply", { profile: "", ops: [{ op: "add", id: randomUUID(), k: "u", t: "Synthetic bookmark", u: "https://fixture.invalid/bookmark", a: Date.now(), parent: tree.bar.id }] })).applied, 1);
  await engine("history.add", { profile: "", pages: [{ u: "https://fixture.invalid/history", t: "Synthetic visit", v: [Date.now()] }], toleranceMs: 0 });
  await checkStorage("");
  await instance.quit(); instance = null;
  const saved = JSON.parse(await readFile(join(preview, "session.json"), "utf8"));
  const official = structuredClone(saved);
  official.profiles.default.name = "Official fixture";
  for (const key of ["windows", "tabs", "groups", "splits", "closedTabs", "closedWindows", "closedGroups", "deletedGroups", "cleanedTabs", "windowOrder"]) official[key] = [];
  official.focusedWindowId = null;
  await writeFile(join(destination, "session.json"), JSON.stringify(official));
  await mkdir(join(destination, "Chromium"));
  await applyMigration({ fixture: true, fixtureRoot: root, preview, destination, webKit, backup: join(root, "backup"), acceptTransfer: true });
  const profile = importedProfile(preview, "");
  await start(destination);
  await checkStorage(profile);
  await instance.quit(); instance = null;
  const prefsPath = join(destination, "Chromium", `Profile ${profile}`, "Secure Preferences");
  const prefs = JSON.parse(await readFile(prefsPath, "utf8"));
  const before = JSON.stringify(prefs.extensions.settings[id]);
  const macs = JSON.stringify(prefs.protection.macs.extensions.settings[id]);
  const hashes = prefs.protection.macs.extensions.settings_encrypted_hash;
  assert.equal(typeof hashes?.[id], "string", "Final engine must write the encrypted tracked-preference hash");
  const corrupted = Buffer.from(hashes[id], "base64");
  assert(corrupted.length > 16);
  corrupted[corrupted.length - 1] ^= 1;
  hashes[id] = corrupted.toString("base64");
  assert.equal(JSON.stringify(prefs.extensions.settings[id]), before);
  assert.equal(JSON.stringify(prefs.protection.macs.extensions.settings[id]), macs);
  await writeFile(prefsPath, JSON.stringify(prefs));
  await start(destination);
  await checkStorage(profile);
  console.log("PASS imported bookmarks, history, extension and local setting survive invalid encrypted-hash recovery");
  await instance.quit(); instance = null;
  const tampered = JSON.parse(await readFile(prefsPath, "utf8"));
  tampered.extensions.settings[id].manifest.name = "Modified synthetic registration";
  await writeFile(prefsPath, JSON.stringify(tampered));
  await start(destination);
  assert.equal((await engine("extensions.list", { profile })).extensions.some((item) => item.id === id), false);
  console.log("PASS negative control: changing registration without its MAC removes the synthetic extension");
} finally {
  if (instance) await instance.quit();
  console.log(`Synthetic fixture: ${root}`);
}
