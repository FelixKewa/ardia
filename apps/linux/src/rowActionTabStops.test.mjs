import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inputAdapters, rawBookmarkAdapter } from "../inputAdapters.ts";
import { rewordForLinux } from "../linuxWording.ts";

const requireHere = createRequire(import.meta.url);
const typescript = requireHere("typescript");
const reactNativeWeb = new URL("./", pathToFileURL(requireHere.resolve("react-native-web/package.json")));
const shims = new URL("./shims/", import.meta.url);
const packages = new URL("../../../packages/", import.meta.url);
const shellWithFiles = `data:text/javascript,export * from ${JSON.stringify(new URL("shell.tsx", shims).href)}; export const fileExists = () => true;`;
const aliases = new Map([
  ["react-native", new URL("react-native.tsx", shims).href],
  ["react-native/Libraries/Animated/useAnimatedProps", new URL("dist/cjs/vendor/react-native/Animated/useAnimatedProps.js", reactNativeWeb).href],
  ["expo-modules-core", new URL("expo-modules-core.ts", shims).href],
  ["react-native/Libraries/Core/ExceptionsManager", new URL("exceptions-manager.ts", shims).href],
  ["@ardia/shell", shellWithFiles],
  ...["ardiacore", "shaders", "sync", "import"].map((name) => [`@ardia/${name}`, new URL(`${name}.tsx`, shims).href]),
  ...[["shell", "index.tsx"], ["ardiacore", "index.ts"], ["shaders", "index.tsx"], ["sync", "index.ts"], ["import", "index.ts"]].map(([name, file]) => [`@ardia-real/${name}`, new URL(`${name}/src/${file}`, packages).href]),
]);
const PLATFORM_FIRST = [".linux.tsx", ".linux.ts", ".web.tsx", ".web.ts"];
const REQUIRE = /\brequire\((["'])([^"']+)\1\)/g;
const ASSET = /\.(png|jpe?g|gif|webp|svg)$/;

function requiresAsImports(code) {
  const specs = [];
  const body = code.replace(REQUIRE, (_match, _quote, spec) => {
    if (ASSET.test(spec)) return JSON.stringify(spec);
    const index = specs.includes(spec) ? specs.indexOf(spec) : specs.push(spec) - 1;
    return `__required${index}`;
  });
  return specs.map((spec, i) => `import * as __required${i} from ${JSON.stringify(spec)};`).join("\n") + "\n" + body;
}
const adapters = new Set([...inputAdapters.values(), rawBookmarkAdapter.replacement]);

function adapted(url, importer) {
  if (!url.startsWith("file:") || !importer?.startsWith("file:") || adapters.has(fileURLToPath(importer))) return null;
  const path = fileURLToPath(url);
  const raw = path === rawBookmarkAdapter.source && rawBookmarkAdapter.importers.has(fileURLToPath(importer));
  const replacement = raw ? rawBookmarkAdapter.replacement : inputAdapters.get(path);
  return replacement ? pathToFileURL(replacement).href : null;
}

registerHooks({
  resolve(specifier, context, next) {
    if (aliases.has(specifier)) return { url: aliases.get(specifier), shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      for (const ext of PLATFORM_FIRST) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    const resolved = next(specifier, context);
    const replacement = adapted(resolved.url, context.parentURL);
    return replacement ? { url: replacement, shortCircuit: true } : resolved;
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url) || url.includes("/node_modules/")) return next(url, context);
    const shared = readFileSync(new URL(url), "utf8");
    const source = requiresAsImports(rewordForLinux(fileURLToPath(url), shared) ?? shared);
    const { outputText } = typescript.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022, jsx: typescript.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

await import("@ardia/shell");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
const { DownloadRow, DownloadRowActions } = await import("../../browser/src/components/downloads/Downloads.tsx");
const { BookmarkRow } = await import("../../browser/src/components/pages/BookmarkRow.tsx");
const { HistoryRow } = await import("../../browser/src/components/pages/HistoryRow.tsx");

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const elements = (html) => [...html.matchAll(/<(div|button)\b[^>]*>/g)].map((m) => attributes(m[0]));
const tabStops = (html) => elements(html).filter((e) => e.tabindex === "0");
const named = (html, label) => elements(html).find((e) => e["aria-label"] === label);
const pressables = (html) => elements(html).filter((e) => e.tabindex !== undefined);

const download = (patch) => ({
  id: "d1",
  url: "https://files.example/report.pdf",
  filename: "report.pdf",
  path: "/home/me/Downloads/report.pdf",
  state: "finished",
  received: 10,
  total: 10,
  speed: 0,
  paused: false,
  dangerous: false,
  startedAt: 0,
  ...patch,
});
const noop = () => {};

test("a finished download row is one Tab stop and keeps its Show in Folder button out of the Tab order until revealed", () => {
  const html = render(DownloadRow, { d: download(), windowId: "w" });
  assert.equal(tabStops(html).length, 1, html);
  assert.equal(named(html, "Show in Folder"), undefined, "the hidden action is not rendered, so Tab skips it");
});

test("the Show in Folder button is a Tab stop once revealed and absent until then", () => {
  const html = render(DownloadRowActions, { d: download(), done: true, blocked: false, revealed: true });
  assert.equal(named(html, "Show in Folder")?.tabindex, "0", html);
  const hidden = render(DownloadRowActions, { d: download(), done: true, blocked: false, revealed: false });
  assert.equal(named(hidden, "Show in Folder"), undefined, hidden);
  assert.equal(pressables(hidden).length, 0, hidden);
});

test("an in-progress download's Pause and Cancel and a blocked download's Keep and Discard are Tab stops", () => {
  const running = render(DownloadRowActions, { d: download({ state: "downloading", received: 4 }), done: false, blocked: false, revealed: false });
  assert.equal(named(running, "Pause")?.tabindex, "0", running);
  assert.equal(named(running, "Cancel")?.tabindex, "0", running);
  const blocked = render(DownloadRowActions, { d: download({ state: "downloading", dangerous: true }), done: false, blocked: true, revealed: false });
  assert.deepEqual(pressables(blocked).map((e) => e.tabindex), ["0", "0"], blocked);
  assert.match(blocked, /Keep[\s\S]*Discard/);
});

function seedBookmark() {
  Object.assign(useBrowser.getInitialState().bookmarks.nodes, { b1: { kind: "url", id: "b1", parentId: "bar", title: "Example", url: "https://example.com/", favicon: null, addedAt: 0 } });
}

const bookmarkRow = (keyboardRow) =>
  render(BookmarkRow, { id: "b1", top: 0, windowId: "w", profileId: "p", showPath: false, selected: false, highlighted: false, keyboardRow, targetRef: noop, onSelect: noop, onOpenFolder: noop, onMenu: noop, onDragStart: noop, onDragMove: noop, onDragEnd: noop });

test("the Bookmarks cursor row reveals its More Actions button as a Tab stop, and its row is not one", () => {
  seedBookmark();
  const cursor = bookmarkRow(true);
  assert.equal(named(cursor, "More actions")?.tabindex, "0", cursor);
  assert.deepEqual(pressables(cursor).map((e) => e.tabindex), ["-1", "0"], "the list owns the row's Tab stop");
  const other = bookmarkRow(false);
  assert.equal(named(other, "More actions"), undefined);
  assert.equal(tabStops(other).length, 0, other);
});

test("the History cursor row reveals its checkbox and More Actions button as Tab stops, and its link is not one", () => {
  const entry = { url: "https://example.com/", title: "Example", favicon: null, visits: 1, lastVisit: 0 };
  const props = { entry, profileId: "p", first: true, last: true, selected: false, selecting: false, windowId: "w", onToggle: noop, onMoreFromSite: noop, onRemove: noop, menuTargets: () => [entry] };
  const cursor = render(HistoryRow, { ...props, highlighted: true });
  assert.equal(named(cursor, "Example")?.tabindex, "0", cursor);
  assert.equal(named(cursor, "More actions")?.tabindex, "0", cursor);
  assert.equal(tabStops(cursor).length, 2, cursor);
  assert.equal(tabStops(render(HistoryRow, { ...props, highlighted: false })).length, 0);
});
