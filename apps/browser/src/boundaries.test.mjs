import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import inventory from "./boundaries.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const readFromDisk = (path) => readFileSync(join(ROOT, path), "utf8");
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

const MESSAGE = String.raw`([A-Za-z][\w:.-]*)`;
const SENT = new RegExp(String.raw`\b(?:send|post)\(\s*["']` + MESSAGE + `["']`, "g");
const RECEIVED_NATIVE = new RegExp(String.raw`\[kind isEqualToString:@"` + MESSAGE + `"\]`, "g");
const RECEIVED_SWIFT = new RegExp(String.raw`case "` + MESSAGE + `":`, "g");
const NATIVE_ADD_LISTENER = /(?:const|let|var)\s+(\w+)\s*=\s*(?:[\w.]+\s*&&\s*)?(?:window\.)?EventTarget\.prototype\.addEventListener\b|(\w+):\s*(?:window\.)?EventTarget\.prototype\.addEventListener\b/g;

function listenerAliases(text) {
  const aliases = new Set(["listen", "addListener"]);
  for (const m of text.matchAll(NATIVE_ADD_LISTENER)) aliases.add(m[1] ?? m[2]);
  for (const alias of [...aliases]) for (const m of text.matchAll(new RegExp(String.raw`(\w+):\s*${alias}\b`, "g"))) aliases.add(m[1]);
  return [...aliases];
}

function listenerPatterns(text) {
  const aliases = listenerAliases(text);
  const through = String.raw`|\bapply\(\s*(?:${aliases.join("|")})\s*,\s*[^,\[\]]+,\s*\[\s*`;
  return {
    named: new RegExp(String.raw`(?:addEventListener\(\s*${through})["']([^"']+)["']`, "g"),
    calls: new RegExp(String.raw`addEventListener\(|\bapply\(\s*(?:${aliases.join("|")})\s*,`, "g"),
  };
}

const listenedEvents = (text) => matches(text, listenerPatterns(text).named);
const listenerCalls = (text) => count(text, listenerPatterns(text).calls);
const EVALUATE_CALLS = /\.evaluate\b(?:<[^()]*>)?(?:\?\.)?\(|\[\s*["']evaluate["']\s*\](?:\?\.)?\(/g;

function detectedEntries(read = readFromDisk) {
  const entries = [];
  const add = (surface, key, extra = {}) => entries.push({ id: `${surface}:${key}`, ...extra });

  const pageScript = read(PAGE_SCRIPT);
  const pageMessageFiles = filesIn(IOS, (n) => n.endsWith(".mm")).filter((f) => /didReceivePageMessage:\(NSString \*\)kind|holdPageMessage:\(NSString \*\)kind/.test(read(f)));
  const nativeReceivers = pageMessageFiles.flatMap((f) => matches(read(f), RECEIVED_NATIVE));
  for (const kind of unique([...matches(pageScript, SENT), ...nativeReceivers])) add("chromium-page-message", kind);
  for (const event of unique(listenedEvents(pageScript))) add("page-script-listener", event);
  add("page-script-listener-count", "page_script.js", { count: listenerCalls(pageScript) });

  const webkitScripts = filesIn(IOS, (n) => /^WebKit.*\.swift$/.test(n));
  const webkitPosted = webkitScripts.flatMap((f) => matches(read(f), SENT)).filter((k) => !["close", "show", "showConsole", "toggleElementSelection"].includes(k));
  const webkitReceived = [
    ...matches(bodyOf(read(`${IOS}/WebKitTab.swift`), "func pageMessage("), RECEIVED_SWIFT),
    ...matches(read(`${IOS}/WebKitTab+Site.swift`), RECEIVED_SWIFT),
    ...matches(read(`${IOS}/WebKitTab+FieldProviders.swift`), RECEIVED_SWIFT),
  ];
  for (const kind of unique([...webkitPosted, ...webkitReceived])) add("webkit-page-message", kind);
  for (const f of webkitScripts) {
    const n = listenerCalls(read(f));
    if (n) add("webkit-page-listener-count", f.slice(IOS.length + 1), { count: n });
  }
  for (const f of [...filesIn(IOS, (n) => n.endsWith(".swift")), ...filesIn("packages/shell/ios", (n) => n.endsWith(".swift"))])
    if (/func userContentController\(/.test(read(f))) add("webkit-script-handler", relative("packages", f));

  for (const f of walk("apps/browser/src", (n) => /\.(ts|tsx)$/.test(n) && notTest(n))) {
    const n = count(read(f), EVALUATE_CALLS);
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
  for (const method of unique(matches(channelApi, RECEIVED_SWIFT))) add("plugin-method", method);

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
      if (symbol) assert.ok(readFromDisk(path).includes(symbol), `${row.id}: ${path} still has ${symbol}`);
    }
  }
});

function unlisted(found) {
  const detectedIds = new Set(found.map((e) => e.id));
  return {
    missing: found.filter((e) => !rowById.has(e.id)).map((e) => e.id),
    changed: found.filter((e) => rowById.has(e.id) && e.count !== undefined && rowById.get(e.id).count !== e.count).map((e) => `${e.id}: ${rowById.get(e.id).count} -> ${e.count}`),
    gone: rows.filter((r) => r.detected !== false && !detectedIds.has(r.id)).map((r) => r.id),
  };
}

test("every place page, sync, plugin, socket or other-app data enters the browser is in the boundary table", () => {
  const { missing, changed, gone } = unlisted(detectedEntries());
  const advice = "Add or update its row in apps/browser/src/boundaries.json and name the check that guards it (docs/security-testing.md).";
  assert.deepEqual(missing, [], `new entry points with no row. ${advice}`);
  assert.deepEqual(changed, [], `entry points whose call count changed. ${advice}`);
  assert.deepEqual(gone, [], "rows whose entry point is gone: remove them, or mark a hand-kept row detected: false");
});

const withAdded = (additions) => (path) => readFromDisk(path) + (additions[path] ? `\n${additions[path]}\n` : "");

const FORMS = [
  { form: "an optional-chained evaluate on a file with no row", file: "apps/browser/src/state/site/contentBlocking.ts", code: 'void web.evaluate?.("1");', missing: "evaluate-result:state/site/contentBlocking.ts" },
  { form: "an evaluate with a nested generic", file: "apps/browser/src/state/site/contentBlocking.ts", code: "void web?.evaluate<Array<Record<string, string>>>(code);", missing: "evaluate-result:state/site/contentBlocking.ts" },
  { form: "an evaluate called by bracket name", file: "apps/browser/src/state/site/contentBlocking.ts", code: 'void web["evaluate"](code);', missing: "evaluate-result:state/site/contentBlocking.ts" },
  { form: "one more optional-chained evaluate in a file with a row", file: "apps/browser/src/state/site/translate.ts", code: 'void webviews.get(tabId)?.evaluate?.("1");', changed: "evaluate-result:state/site/translate.ts" },
  { form: "a listener through apply(listenOn, …), an alias of addEventListener", file: "packages/ardiacore/ios/page_script.js", code: 'apply(listenOn, session, ["fixturestatus", f]);', missing: "page-script-listener:fixturestatus" },
  { form: "a listener whose event name is on the next line", file: "packages/ardiacore/ios/page_script.js", code: 'document.addEventListener(\n  "fixturemultiline",\n  f,\n);', missing: "page-script-listener:fixturemultiline" },
  { form: "a listener through apply(listen, …)", file: "packages/ardiacore/ios/page_script.js", code: 'apply(listen, window, ["fixturechange", guard(() => {})]);', missing: "page-script-listener:fixturechange", changed: "page-script-listener-count:page_script.js" },
  { form: "a hyphenated message the page script sends", file: "packages/ardiacore/ios/page_script.js", code: 'send("pick-done", {});', missing: "chromium-page-message:pick-done" },
  { form: "a dotted message a native receiver takes", file: "packages/ardiacore/ios/ArdiaWebView+PageMessages.mm", code: '} else if ([kind isEqualToString:@"pick.done"]) {', missing: "chromium-page-message:pick.done" },
  { form: "a hyphenated WebKit message", file: "packages/ardiacore/ios/WebKitTab+Site.swift", code: 'case "pick-done": break', missing: "webkit-page-message:pick-done" },
  { form: "a single-quoted WebKit post", file: "packages/ardiacore/ios/WebKitPageScript.swift", code: "post('fixtureKind', {})", missing: "webkit-page-message:fixtureKind" },
  { form: "a hyphenated plugin method", file: "apps/browser/src/state/plugins/channelApi.ts", code: 'case "tabs.read-all":', missing: "plugin-method:tabs.read-all" },
];

test("each call form the inventory enforces raises a missing row when it appears in new code", () => {
  for (const { form, file, code, missing, changed } of FORMS) {
    const found = unlisted(detectedEntries(withAdded({ [file]: code })));
    if (missing) assert.ok(found.missing.includes(missing), `${form}: expected ${missing} to be reported, got ${JSON.stringify(found.missing)}`);
    if (changed) assert.ok(found.changed.some((c) => c.startsWith(`${changed}:`)), `${form}: expected ${changed} to be reported as changed, got ${JSON.stringify(found.changed)}`);
  }
});

const customEventsIn = (text) => listenedEvents(text).filter((event) => /[-:]|ardia/i.test(event) && !inventory.customEvents?.[event]);

test("no page script listens for a DOM event a page can name itself", () => {
  const scripts = [PAGE_SCRIPT, ...filesIn(IOS, (n) => /^WebKit.*\.swift$/.test(n))];
  for (const f of scripts) assert.deepEqual(customEventsIn(readFromDisk(f)), [], `${f}: a custom DOM event any page can dispatch needs a row in customEvents and a trusted-sender check`);
  assert.deepEqual(customEventsIn('const listen = EventTarget.prototype.addEventListener; document.addEventListener("ardia-hide-element", f); apply(listen, document, ["ardia-pick", f]);'), ["ardia-hide-element", "ardia-pick"]);
});
