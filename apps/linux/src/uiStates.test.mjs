import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const shims = new URL("./shims/", import.meta.url);
const packages = new URL("../../../packages/", import.meta.url);
const aliases = new Map([
  ["react-native", new URL("react-native.tsx", shims).href],
  ["expo-modules-core", new URL("expo-modules-core.ts", shims).href],
  ...["shell", "ardiacore", "shaders", "sync", "import"].map((name) => [`@ardia/${name}`, new URL(`${name}.tsx`, shims).href]),
  ...[["shell", "index.tsx"], ["ardiacore", "index.ts"], ["shaders", "index.tsx"], ["sync", "index.ts"], ["import", "index.ts"]].map(([name, file]) => [`@ardia-real/${name}`, new URL(`${name}/src/${file}`, packages).href]),
]);
const PLATFORM_FIRST = [".linux.tsx", ".linux.ts", ".web.tsx", ".web.ts"];
const ASSET_REQUIRE = /\brequire\((["'])([^"']+\.(?:png|jpe?g|gif|webp|svg))\1\)/g;
const typescript = createRequire(import.meta.url)("typescript");

registerHooks({
  resolve(specifier, context, next) {
    if (aliases.has(specifier)) return { url: aliases.get(specifier), shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      for (const ext of PLATFORM_FIRST) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url) || url.includes("/node_modules/")) return next(url, context);
    const source = readFileSync(new URL(url), "utf8").replace(ASSET_REQUIRE, (_match, _quote, asset) => JSON.stringify(asset));
    const { outputText } = typescript.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022, jsx: typescript.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

await import("@ardia/shell");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const ui = await import("../../browser/src/components/ui/index.ts");

const render = (node) => renderToStaticMarkup(node);
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1].toLowerCase(), m[2] ?? ""]));
const tags = (html) => [...html.matchAll(/<(div|button|input|textarea)\b[^>]*>/g)].map((m) => ({ tag: m[1], ...attributes(m[0]) }));
const withRole = (html, role) => tags(html).filter((t) => t.role === role);
const inlineStyles = (html) => [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
const closing = (node) => h(ui.ClosingScope, { closing: true }, node);
const noop = () => {};

test("a checked menu row is a radio that publishes aria-checked, and an unchecked one says false", () => {
  const on = withRole(render(h(ui.MenuRow, { title: "Speaker", checked: true, onPress: noop })), "radio");
  const off = withRole(render(h(ui.MenuRow, { title: "Headphones", checked: false, onPress: noop })), "radio");
  assert.deepEqual([on.length, on[0]["aria-checked"]], [1, "true"]);
  assert.deepEqual([off.length, off[0]["aria-checked"]], [1, "false"]);
});

test("a menu row with a cursor highlight stays a button and publishes the selection, not a check", () => {
  const html = render(h(ui.MenuRow, { title: "Tab", selected: true, onPress: noop }));
  const [button] = withRole(html, "button");
  assert.equal(button["aria-selected"], "true", html);
  assert.equal(button["aria-checked"], undefined, html);
});

test("the radio, checkbox and switch mappings give every platform its state", () => {
  assert.deepEqual(ui.radioA11y(true, "Screen 1"), { accessibilityRole: "radio", accessibilityLabel: "Screen 1", accessibilityState: { checked: true, selected: true }, "aria-checked": true });
  assert.deepEqual(ui.checkboxA11y("mixed", true, "All"), { accessibilityRole: "checkbox", accessibilityLabel: "All", accessibilityState: { checked: "mixed", disabled: true }, "aria-checked": "mixed", "aria-disabled": true });
  assert.equal(ui.switchA11y(false)["aria-checked"], false);
});

test("Space activates a radio or checkbox row once and stops the page scrolling; other keys do nothing", () => {
  let presses = 0;
  let prevented = 0;
  const key = (k) => ui.spaceActivates(() => presses++)({ nativeEvent: { key: k }, preventDefault: () => prevented++ });
  key(" ");
  key("Enter");
  key("a");
  assert.deepEqual([presses, prevented], [1, 1]);
});

test("a whole-row check target is one named checkbox with a Tab stop and its state; the mark inside it is drawing only", () => {
  const html = render(h(ui.CheckTarget, { value: true, label: "Include pages", onChange: noop }, h(ui.CheckMark, { value: true })));
  const boxes = withRole(html, "checkbox");
  assert.equal(boxes.length, 1, html);
  assert.deepEqual([boxes[0]["aria-label"], boxes[0]["aria-checked"], boxes[0].tabindex], ["Include pages", "true", "0"]);
  assert.equal(tags(html).filter((t) => t["aria-disabled"] !== undefined).length, 0, "no unnamed, disabled checkbox inside the row");
  assert.equal(tags(html).filter((t) => t.tabindex !== undefined).length, 1, html);
});

test("a disabled check target leaves the Tab order and says it is disabled, still unchecked", () => {
  const [box] = withRole(render(h(ui.CheckTarget, { value: false, disabled: true, label: "Trace", onChange: noop }, h(ui.CheckMark, { value: false, disabled: true }))), "checkbox");
  assert.deepEqual([box["aria-checked"], box["aria-disabled"], box.tabindex], ["false", "true", "-1"]);
});

test("a form checkbox publishes checked and mixed, and a ring checkbox with no onChange draws with no role", () => {
  assert.equal(withRole(render(h(ui.Checkbox, { value: true, label: "Searches", onChange: noop })), "checkbox")[0]["aria-checked"], "true");
  assert.equal(withRole(render(h(ui.Checkbox, { value: false, mixed: true, label: "All", onChange: noop })), "checkbox")[0]["aria-checked"], "mixed");
  const ring = render(h(ui.Checkbox, { look: "ring", size: "s", value: true }));
  assert.deepEqual(tags(ring).filter((t) => t.role || t.tabindex !== undefined), [], ring);
});

test("a toggle is a switch with aria-checked", () => {
  const [toggle] = withRole(render(h(ui.Toggle, { value: true, onChange: noop, accessibilityLabel: "Block pop-ups" })), "switch");
  assert.equal(toggle["aria-checked"], "true");
});

const PIECES = {
  "push button": () => h(ui.Button, { title: "Allow", onPress: noop }),
  "icon button": () => h(ui.Button, { variant: "icon", icon: "xmark", tooltip: "Close", focusable: true, onPress: noop }),
  "text button": () => h(ui.Button, { variant: "text", look: "link", title: "Scan Again", focusable: true, onPress: noop }),
  "pill button": () => h(ui.Button, { variant: "pill", title: "Reset", onPress: noop }),
  "stepper": () => h(ui.Button, { variant: "stepper", icon: "plus", tooltip: "Zoom In", onPress: noop }),
  "panel close": () => h(ui.PanelCloseButton, { onPress: noop }),
  "menu row": () => h(ui.MenuRow, { title: "Open", onPress: noop }),
  "radio menu row": () => h(ui.MenuRow, { title: "Speaker", checked: true, onPress: noop }),
  "list row": () => h(ui.ListRow, { onPress: noop }, null),
  "checkbox": () => h(ui.Checkbox, { value: true, label: "Share audio", onChange: noop }),
  "check target": () => h(ui.CheckTarget, { value: true, label: "Include pages", onChange: noop }, h(ui.CheckMark, { value: true })),
  "toggle": () => h(ui.Toggle, { value: true, onChange: noop, look: "panel" }),
  "segmented": () => h(ui.Segmented, { value: "a", onChange: noop, options: [{ value: "a", title: "A" }, { value: "b", title: "B" }] }),
  "pop-up": () => h(ui.PopUp, { value: "a", onChange: noop, options: [{ value: "a", title: "A" }] }),
  "popover value": () => h(ui.PopoverValue, { title: "This tab", onPress: noop }),
};

for (const [name, piece] of Object.entries(PIECES))
  test(`a ${name} inside a closing panel is disabled and out of the Tab order, and looks the same`, () => {
    const open = render(piece());
    const dead = render(closing(piece()));
    const live = tags(open).filter((t) => t.tabindex !== undefined);
    const gone = tags(dead).filter((t) => t.tabindex !== undefined);
    assert.ok(live.length > 0, open);
    assert.ok(live.every((t) => t["aria-disabled"] === undefined), open);
    assert.equal(gone.length, live.length, dead);
    assert.ok(gone.every((t) => t["aria-disabled"] === "true" && t.tabindex === "-1"), dead);
    assert.ok(gone.filter((t) => t.tag === "button").every((t) => t.disabled === ""), dead);
    assert.deepEqual(inlineStyles(dead), inlineStyles(open), "no dimming while closing");
  });

test("text and search fields inside a closing panel stop taking text", () => {
  for (const field of [h(ui.TextField, { value: "x", onChangeText: noop }), h(ui.SearchField, { value: "x", onChangeText: noop, placeholder: "Search" })]) {
    const [open] = tags(render(field)).filter((t) => t.tag === "input");
    const [dead] = tags(render(closing(field))).filter((t) => t.tag === "input");
    assert.equal(open.readonly, undefined);
    assert.equal(dead.readonly, "");
  }
});

test("a search field's clear button is dead while its panel closes", () => {
  const html = render(closing(h(ui.SearchField, { value: "x", onChangeText: noop, placeholder: "Search" })));
  const clear = tags(html).filter((t) => t.tabindex !== undefined);
  assert.ok(clear.length === 1 && clear[0]["aria-disabled"] === "true", html);
});

test("a closing popover marks its subtree inert and hidden, and kills the pieces inside it", () => {
  const popover = (isClosing) => render(h(ui.Popover, { width: "s", top: 0, right: 0, closing: isClosing, onDismiss: noop }, h(ui.Button, { title: "Allow", onPress: noop }), h(ui.TextField, { value: "", onChangeText: noop })));
  const open = popover(false);
  const dead = popover(true);
  assert.doesNotMatch(open, /\sinert/);
  assert.match(dead, /\sinert/);
  assert.equal(tags(open).find((t) => t.tag === "button")?.disabled, undefined, open);
  assert.equal(tags(dead).find((t) => t.tag === "button")?.disabled, "", dead);
  assert.equal(tags(dead).find((t) => t.tag === "input")?.readonly, "", dead);
});

test("a nested scope inside a closing panel stays closing", () => {
  const html = render(closing(h(ui.ClosingScope, { closing: false }, h(ui.Button, { title: "Allow", onPress: noop }))));
  assert.equal(tags(html).find((t) => t.tag === "button")?.disabled, "", html);
});

test("whileOpen drops an action once closing starts and checks the live open state when it runs", () => {
  const calls = [];
  let open = true;
  const act = ui.whileOpen(false, () => open)((n) => calls.push(n));
  act(1);
  open = false;
  act(2);
  ui.whileOpen(true)((n) => calls.push(n))(3);
  assert.deepEqual(calls, [1]);
});
