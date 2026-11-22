import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import inventory from "./boundaries.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const filesIn = (dir, pick) => readdirSync(join(ROOT, dir)).filter(pick).map((name) => `${dir}/${name}`);
const walk = (dir, pick) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "test-native" || entry.name === "fixtures" ? [] : walk(path, pick);
    return pick(entry.name) ? [path] : [];
  });
const matches = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1]);
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const unique = (list) => [...new Set(list)].sort();
const notTest = (name) => !/\.test\.|\.d\.ts$/.test(name);

const PAGE_SCRIPT = "packages/ardiacore/ios/page_script.js";
const IOS = "packages/ardiacore/ios";

function bodyOf(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} is where the inventory reads it`);
  const end = text.indexOf("\n  }\n", start);
  return text.slice(start, end < 0 ? undefined : end);
}

function detectedEntries() {
  const entries = [];
  const add = (surface, key, extra = {}) => entries.push({ id: `${surface}:${key}`, ...extra });

  const pageScript = read(PAGE_SCRIPT);
  const pageMessageFiles = filesIn(IOS, (n) => n.endsWith(".mm")).filter((f) => /didReceivePageMessage:\(NSString \*\)kind|holdPageMessage:\(NSString \*\)kind/.test(read(f)));
  const nativeReceivers = pageMessageFiles.flatMap((f) => matches(read(f), /\[kind isEqualToString:@"([A-Za-z]+)"\]/g));
  for (const kind of unique([...matches(pageScript, /\bsend\("([A-Za-z]+)"/g), ...nativeReceivers])) add("chromium-page-message", kind);
  for (const event of unique(matches(pageScript, /addEventListener\("([A-Za-z:-]+)"/g))) add("page-script-listener", event);
  add("page-script-listener-count", "page_script.js", { count: count(pageScript, /addEventListener\(/g) });

  const webkitScripts = filesIn(IOS, (n) => /^WebKit.*\.swift$/.test(n));
  const webkitPosted = webkitScripts.flatMap((f) => matches(read(f), /\b(?:post|send)\("([A-Za-z]+)"/g)).filter((k) => !["close", "show", "showConsole", "toggleElementSelection"].includes(k));
  const webkitReceived = [
    ...matches(bodyOf(read(`${IOS}/WebKitTab.swift`), "func pageMessage("), /case "([A-Za-z]+)":/g),
    ...matches(read(`${IOS}/WebKitTab+Site.swift`), /case "([A-Za-z]+)":/g),
    ...matches(read(`${IOS}/WebKitTab+FieldProviders.swift`), /case "([A-Za-z]+)":/g),
  ];
  for (const kind of unique([...webkitPosted, ...webkitReceived])) add("webkit-page-message", kind);
  for (const f of webkitScripts) {
    const n = count(read(f), /addEventListener\(/g);
    if (n) add("webkit-page-listener-count", f.slice(IOS.length + 1), { count: n });
  }
  for (const f of [...filesIn(IOS, (n) => n.endsWith(".swift")), ...filesIn("packages/shell/ios", (n) => n.endsWith(".swift"))])
    if (/func userContentController\(/.test(read(f))) add("webkit-script-handler", relative("packages", f));

  for (const f of walk("apps/browser/src", (n) => /\.(ts|tsx)$/.test(n) && notTest(n))) {
    const n = count(read(f), /\.evaluate(?:<[^>]*>)?\(/g);
    if (n) add("evaluate-result", f.slice("apps/browser/src/".length), { count: n });
  }

  const shellEvents = read("packages/shell/ios/ShellEvents.swift");
  for (const channel of matches(bodyOf(shellEvents, "enum Channel"), /case (\w+) = "/g)) add("native-channel", channel);

  for (const f of walk("apps/browser/src/state/sync", (n) => n.endsWith(".ts") && notTest(n))) {
    const file = f.slice("apps/browser/src/state/sync/".length);
    for (const [, name, many] of read(f).matchAll(/^export function (\w+)\((?:(?!^export )[\s\S])*?\): (?:Adapter|ExtensionsAdapter|\(forced: boolean\) => Adapter)(\[\])? \{$/gm))
      add(many ? "sync-adapter-set" : "sync-adapter", `${file}#${name}`);
    for (const name of matches(read(f), /^export const (\w+): Adapter = /gm)) add("sync-adapter", `${file}#${name}`);
  }

  const channelApi = read("apps/browser/src/state/plugins/channelApi.ts");
  for (const method of unique(matches(channelApi, /case "([a-z.A-Z]+)":/g))) add("plugin-method", method);

  const catalog = read("apps/browser/src/state/automation/socketCatalog.ts");
  const families = /SOCKET_FAMILIES = \[([^\]]+)\]/.exec(catalog)[1];
  for (const family of matches(families, /"([a-z_]+)"/g)) add("socket-family", family);

  for (const f of walk("apps/browser/src/state", (n) => n.endsWith(".ts") && notTest(n))) {
    const n = count(read(f), /settings: \{ ?\.\.\.(?:s|state|before|now|prev|get\(\))\.settings\b/g);
    if (n) add("raw-settings-write", f.slice("apps/browser/src/".length), { count: n });
  }
  return entries;
}

const rows = inventory.rows;
const rowById = new Map(rows.map((r) => [r.id, r]));

test("every boundary row is unique, says where its input comes from and names the check that guards it", () => {
  assert.equal(rowById.size, rows.length, "no row twice");
  for (const row of rows) {
    assert.match(row.id, /^[a-z-]+:.+$/, row.id);
    assert.ok(inventory.sources[row.source], `${row.id}: source ${row.source} is one of ${Object.keys(inventory.sources).join(", ")}`);
    assert.equal(typeof row.guard, "string", `${row.id}: says what guards it`);
    assert.ok(row.guard.length >= 8, `${row.id}: guard`);
  }
});

test("every check a row names still exists where the row says", () => {
  for (const row of rows) {
    for (const ref of row.checks ?? []) {
      const [path, symbol] = ref.split("#");
      assert.ok(existsSync(join(ROOT, path)), `${row.id}: ${path} exists`);
      if (symbol) assert.ok(read(path).includes(symbol), `${row.id}: ${path} still has ${symbol}`);
    }
  }
});

test("every place page, sync, plugin, socket or other-app data enters the browser is in the boundary table", () => {
  const found = detectedEntries();
  const missing = found.filter((e) => !rowById.has(e.id));
  const changed = found.filter((e) => rowById.has(e.id) && e.count !== undefined && rowById.get(e.id).count !== e.count);
  const detectedIds = new Set(found.map((e) => e.id));
  const gone = rows.filter((r) => r.detected !== false && !detectedIds.has(r.id));
  const advice = "Add or update its row in apps/browser/src/boundaries.json and name the check that guards it (docs/security-testing.md).";
  assert.deepEqual(missing.map((e) => e.id), [], `new entry points with no row. ${advice}`);
  assert.deepEqual(changed.map((e) => `${e.id}: ${rowById.get(e.id).count} -> ${e.count}`), [], `entry points whose call count changed. ${advice}`);
  assert.deepEqual(gone.map((r) => r.id), [], "rows whose entry point is gone: remove them, or mark a hand-kept row detected: false");
});

test("no page script listens for a DOM event a page can name itself", () => {
  const scripts = [PAGE_SCRIPT, ...filesIn(IOS, (n) => /^WebKit.*\.swift$/.test(n))];
  for (const f of scripts) {
    const custom = matches(read(f), /addEventListener\("([^"]+)"/g).filter((event) => /[-:]|ardia/i.test(event) && !inventory.customEvents?.[event]);
    assert.deepEqual(custom, [], `${f}: a custom DOM event any page can dispatch needs a row in customEvents and a trusted-sender check`);
  }
});
