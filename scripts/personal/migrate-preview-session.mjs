import { createHash } from "node:crypto";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const importedProfile = (scope, profile) => `preview-import-${hash(`ardia.preview-import|${scope}|${profile}`).slice(0, 32)}`;
export const storeIdentifier = (scope, profile) => {
  const bytes = Buffer.from(hash(`ardia.webkit|${scope}|${profile}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex").toUpperCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
};

const lists = ["windows", "tabs", "groups", "splits", "closedTabs", "closedWindows", "closedGroups", "deletedGroups", "cleanedTabs"];
const tables = ["parkedPins", "pinChoices", "pinSync"];
const idKeys = new Set(["id", "tabId", "windowId", "profileId", "openerId", "linkOpenerId", "groupId", "parentId", "pinnedOpenerId", "pinKey", "closeBatch", "folderId", "itemId", "activePin"]);
const idLists = new Set(["tabIds", "shownTabIds", "stack"]);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ownId = (id) => typeof id === "string" && id.length > 0 && id.length <= 300 && !(id in Object.prototype);

export function validateSession(session) {
  if (!object(session) || session.version !== 11 || !object(session.profiles) || !Array.isArray(session.profileOrder)) throw Error("Unsupported session schema; no data changed.");
  for (const [id, profile] of Object.entries(session.profiles)) {
    if (!ownId(id) || !object(profile) || profile.id !== id || typeof profile.name !== "string") throw Error("Invalid saved profile.");
    const engine = profile.dataId ?? id;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(engine) || engine.startsWith("incognito")) throw Error("Unsupported profile identity.");
  }
  if (session.profileOrder.some((id) => !Object.hasOwn(session.profiles, id))) throw Error("Unknown profile in saved order.");
  if (new Set(session.profileOrder).size !== session.profileOrder.length || !Array.isArray(session.windowOrder) || session.windowOrder.some((id) => !ownId(id)) || new Set(session.windowOrder).size !== session.windowOrder.length) throw Error("Invalid saved order.");
  for (const key of lists) {
    if (!Array.isArray(session[key])) throw Error("Unsupported saved session rows.");
    const ids = new Set();
    for (const row of session[key]) {
      if (!object(row) || !ownId(row.id) || ids.has(row.id)) throw Error("Invalid or duplicate session row.");
      ids.add(row.id);
    }
  }
  for (const key of tables) if (session[key] !== undefined && !object(session[key])) throw Error("Unsupported saved session table.");
  const windows = new Set(session.windows.map((row) => row.id));
  const tabs = new Map(session.tabs.map((row) => [row.id, row]));
  for (const row of session.windows) {
    if (!Object.hasOwn(session.profiles, row.profileId) || !Array.isArray(row.tabIds) || !object(row.activeTabIds) || row.incognito === true || row.kind === "private") throw Error("Invalid or private saved window.");
    if (row.tabIds.some((id) => tabs.get(id)?.windowId !== row.id)) throw Error("Broken saved window tab reference.");
  }
  for (const row of session.tabs) if (!windows.has(row.windowId) || !Object.hasOwn(session.profiles, row.profileId) || typeof row.url !== "string") throw Error("Broken saved tab reference.");
  for (const row of session.groups) if (!windows.has(row.windowId) || !Object.hasOwn(session.profiles, row.profileId) || !Array.isArray(row.tabIds) || row.tabIds.some((id) => !tabs.has(id))) throw Error("Broken saved group reference.");
  for (const row of session.splits) if (!windows.has(row.windowId) || !Array.isArray(row.slots) || row.slots.some((slot) => !object(slot) || (slot.tabId ? !tabs.has(slot.tabId) : !Array.isArray(slot.stack) || slot.stack.some((id) => !tabs.has(id))))) throw Error("Broken saved split reference.");
  return session;
}

export function restoreLastWindow(saved) {
  const session = structuredClone(validateSession(saved));
  if (session.windows.length) return session;
  const closed = session.closedWindows.find((row) => row.lastWindow === true);
  if (!closed) return session;
  if (!object(closed.window) || !Array.isArray(closed.tabs) || !Array.isArray(closed.groups)) throw Error("Invalid saved last window.");
  const windowId = `${closed.id}-preview-window`;
  const tabs = closed.tabs.map(({ active, tabId, ...tab }, index) => ({ ...tab, id: tabId ?? `${closed.id}-tab-${index}`, windowId, page: { kind: "idle" }, openerId: null, createdAt: closed.closedAt, lastActiveAt: tab.lastActiveAt ?? closed.closedAt }));
  const activeTabIds = Object.fromEntries([...new Set(tabs.map((tab) => tab.profileId))].map((profile) => [profile, tabs.find((tab, i) => tab.profileId === profile && closed.tabs[i].active)?.id ?? tabs.find((tab) => tab.profileId === profile).id]));
  session.windows.push({ ...closed.window, id: windowId, tabIds: tabs.map((tab) => tab.id), activeTabIds, createdAt: closed.closedAt });
  session.windowOrder.push(windowId);
  session.tabs.push(...tabs);
  session.groups.push(...closed.groups.map(({ tabIndexes, ...group }) => ({ ...group, windowId, tabIds: tabIndexes.map((i) => tabs[i]?.id) })));
  session.splits.push(...(closed.splits ?? []).map((split, index) => ({ ...split, id: `${closed.id}-split-${index}`, windowId })));
  delete closed.lastWindow;
  return validateSession(session);
}

export function mergeSessions(official, preview, scope) {
  validateSession(official);
  validateSession(preview);
  const profiles = new Map();
  const engines = new Set();
  for (const [id, profile] of Object.entries(preview.profiles)) {
    const engine = (profile.dataId ?? id) === "default" ? "" : (profile.dataId ?? id);
    if (engines.has(engine)) throw Error("Multiple preview profiles share engine data; resolve before importing.");
    engines.add(engine);
    profiles.set(id, { sourceProfile: engine, profile: importedProfile(scope, engine), identifier: storeIdentifier(scope, engine) });
  }
  const ids = new Map([...profiles].map(([id, value]) => [id, value.profile]));
  const mapped = (id) => {
    if (id === "") return "";
    if (!ownId(id)) throw Error("Invalid session identity.");
    if (!ids.has(id)) ids.set(id, `preview-item-${hash(`${scope}|${id}`).slice(0, 32)}`);
    return ids.get(id);
  };
  const walk = (value, key = "") => {
    if (Array.isArray(value)) return value.map((v) => idLists.has(key) && typeof v === "string" ? mapped(v) : walk(v));
    if (!object(value)) return idKeys.has(key) && typeof value === "string" ? mapped(value) : value;
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      if (["restoreFrom", "chromeOpened", "chromeWindow", "dataId", "syncTabs", "shareTopApps"].includes(k)) continue;
      if (k === "page") { out.page = { kind: value.page?.kind === "asleep" ? "asleep" : "idle" }; continue; }
      if (k === "activeTabIds") { out[k] = Object.fromEntries(Object.entries(v).map(([p, t]) => [mapped(p), mapped(t)])); continue; }
      out[k] = walk(v, k);
    }
    return out;
  };
  const merged = structuredClone(official);
  for (const [oldId, profile] of Object.entries(preview.profiles)) {
    const id = mapped(oldId);
    if (Object.hasOwn(merged.profiles, id)) throw Error("Imported profile already exists; use the migration receipt to verify completion.");
    merged.profiles[id] = { ...walk(profile), name: `${profile.name} (Preview)` };
    merged.profileOrder.push(id);
  }
  for (const key of lists) {
    const existing = new Set(merged[key].map((row) => row.id));
    const rows = preview[key].map((row) => walk(row));
    if (rows.some((row) => existing.has(row.id))) throw Error("Imported session identity collision.");
    merged[key].push(...rows);
  }
  merged.windowOrder = [...official.windowOrder, ...preview.windowOrder.map(mapped)];
  for (const key of tables) {
    merged[key] ??= {};
    for (const [p, rows] of Object.entries(preview[key] ?? {})) {
      if (!profiles.has(p)) throw Error("Unknown profile in saved table.");
      merged[key][mapped(p)] = key === "parkedPins" ? walk(rows) : Object.fromEntries(Object.entries(rows).map(([id, value]) => {
        const match = /^(group|place|order):(.*)$/.exec(id);
        return [match ? `${match[1]}:${mapped(match[2])}` : mapped(id), key === "pinSync" && object(value) && typeof value.g === "string" ? { ...value, g: mapped(value.g) } : value];
      }));
    }
  }
  validateSession(merged);
  return { session: merged, profiles: [...profiles.values()], ids };
}
