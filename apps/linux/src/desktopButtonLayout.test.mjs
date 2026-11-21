import assert from "node:assert/strict";
import test from "node:test";
import { followDesktopButtonLayout, reportedButtonLayout, WINDOW_BUTTON_LAYOUT_METHOD } from "./desktopButtonLayout.ts";

function fakeHost(capabilities, reply) {
  const listeners = new Set();
  const invoked = [];
  return {
    invoked,
    emit: (module, event, payload) => listeners.forEach((listener) => listener(module, event, payload)),
    host: {
      bootstrap: { windowId: "w1", profileId: "default", capabilities },
      invoke: (method, args) => (invoked.push([method, args]), reply()),
      call: async () => "{}",
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
  };
}

function memory(initial = {}) {
  const items = new Map(Object.entries(initial));
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, String(value)) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an engine without the layout call is never asked, and the buttons stay as they are today", async () => {
  const seen = [];
  const { host, invoked } = fakeHost([], () => Promise.resolve({ layout: "close:" }));
  const remembered = memory({ "ardia.desktopButtonLayout": JSON.stringify({ layout: "close:" }) });
  followDesktopButtonLayout(host, remembered, (layout) => seen.push(layout));
  await settle();
  assert.deepEqual(invoked, []);
  assert.deepEqual(seen, [], "a layout remembered from a newer engine isn't applied by an older one");
});

test("the desktop's layout is read at start, follows its change event live, and is remembered for the next window", async () => {
  const seen = [];
  const { host, invoked, emit } = fakeHost([WINDOW_BUTTON_LAYOUT_METHOD], () => Promise.resolve({ layout: "appmenu:close", desktop: "GNOME" }));
  const remembered = memory();
  const stop = followDesktopButtonLayout(host, remembered, (layout) => seen.push(layout));
  await settle();
  assert.deepEqual(invoked, [[WINDOW_BUTTON_LAYOUT_METHOD, { args: [] }]]);
  emit("ArdiaShell", "windowButtonLayout", { layout: "close,minimize,maximize:", desktop: "GNOME" });
  emit("ArdiaShell", "windowState", { layout: "ignored" });
  emit("ArdiaTabs", "windowButtonLayout", { layout: "ignored" });
  emit("ArdiaShell", "windowButtonLayout", { layout: null, desktop: "" });
  assert.deepEqual(seen, ["appmenu:close", "close,minimize,maximize:", null]);
  assert.equal(remembered.items.get("ardia.desktopButtonLayout"), JSON.stringify({ layout: null }));
  stop();
  emit("ArdiaShell", "windowButtonLayout", { layout: "close:" });
  assert.equal(seen.length, 3);
});

test("a new window draws the remembered layout at once, and a change heard before the first read answers isn't undone by it", async () => {
  const seen = [];
  let answer;
  const { host, emit } = fakeHost([WINDOW_BUTTON_LAYOUT_METHOD], () => new Promise((resolve) => (answer = resolve)));
  followDesktopButtonLayout(host, memory({ "ardia.desktopButtonLayout": JSON.stringify({ layout: "close:maximize" }) }), (layout) => seen.push(layout));
  assert.deepEqual(seen, ["close:maximize"]);
  await settle();
  emit("ArdiaShell", "windowButtonLayout", { layout: "appmenu:close" });
  answer({ layout: "close:maximize" });
  await settle();
  assert.deepEqual(seen, ["close:maximize", "appmenu:close"]);
});

test("only a string or null is a layout; anything else from the host or a corrupt memory is ignored", async () => {
  for (const payload of [undefined, null, "close:", {}, { layout: 3 }, { layout: ["close"] }]) assert.equal(reportedButtonLayout(payload), undefined);
  assert.equal(reportedButtonLayout({ layout: null }), null);
  assert.equal(reportedButtonLayout({ layout: "" }), "");
  const seen = [];
  const { host } = fakeHost([WINDOW_BUTTON_LAYOUT_METHOD], () => Promise.resolve({ nope: true }));
  followDesktopButtonLayout(host, memory({ "ardia.desktopButtonLayout": "{not json" }), (layout) => seen.push(layout));
  await settle();
  assert.deepEqual(seen, []);
  const failing = fakeHost([WINDOW_BUTTON_LAYOUT_METHOD], () => Promise.reject(new Error("gone")));
  const errors = console.error;
  console.error = () => {};
  try {
    followDesktopButtonLayout(failing.host, { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } }, (layout) => seen.push(layout));
    await settle();
  } finally {
    console.error = errors;
  }
  assert.deepEqual(seen, []);
});
