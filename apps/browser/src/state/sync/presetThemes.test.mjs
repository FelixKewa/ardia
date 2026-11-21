import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const adapters = await import("./profileAdapters.ts");
const v0247 = await import("./fixtures/profileAdapters-v0.2.47.ts");
const { pairTheme, settleThemeAdoption } = await import("./syncThemes.ts");
const { choosePresetColor, resetPresetTheme, setProfileTheme } = await import("../profiles/themeActions.ts");

const S = () => useBrowser.getState();

const look = (r, intensity = 0.5) => ({ stops: [{ x: 0.3, y: 0.6, color: { r, g: 0.4, b: 0.7, a: 1 } }], intensity, mode: "auto", grain: 0, texture: "grain", translucency: 1 });
const PLUM = look(0.8);
const BLUE = look(0.2, 0.7);
const GREEN = look(0.1, 0.9);

class Folder {
  files = new Map();
  counter = 0;
  withhold = null;
  duringRead = null;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        this.duringRead?.();
        const here = [...this.files].filter(([id, f]) => f.scope === scope && (known.includes(id) || !this.withhold?.(id)));
        const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
        return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

class Mac {
  constructor(id, folder, { old = false, joining = false } = {}) {
    this.id = id;
    this.old = old;
    this.folder = folder;
    this.links = { default: { syncId: "s1" } };
    this.paired = !joining;
    S().hydrate({});
    this.browser = S();
    this.scope = emptyScope();
    this.scope.joined = !joining;
    this.clock = new Clock(id);
    this.adapters = old ? this.oldAdapters() : this.currentAdapters();
  }
  currentAdapters() {
    return adapters.profileSyncAdapters(() => this.links, () => this.scope.records);
  }
  oldAdapters() {
    return [v0247.profilesAdapter(() => this.links), v0247.profileThemesAdapter(() => this.links, () => this.scope.records)];
  }
  upgrade() {
    this.adapters = this.currentAdapters();
  }
  with(fn) {
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  pick(color) {
    this.with(() => choosePresetColor("default", color, () => {}));
  }
  reset() {
    this.with(() => resetPresetTheme("default", () => {}));
  }
  oldPick(color) {
    this.with(() => S().setProfileLook("default", { color, theme: null }));
  }
  edit(theme) {
    this.with(() => setProfileTheme("default", theme, () => {}));
  }
  async sync(duringRead = null) {
    useBrowser.setState(this.browser, true);
    this.folder.duringRead = duringRead;
    try {
      const { published } = await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: this.adapters, clock: this.clock, device: this.id });
      if (!this.old && !this.paired && this.scope.joined) {
        pairTheme(this.scope, "default", this.links.default);
        this.paired = true;
      }
      if (!this.old) settleThemeAdoption(this.links, this.scope, true);
      return published;
    } finally {
      this.folder.duringRead = null;
      this.browser = S();
    }
  }
  profile() {
    return this.browser.profiles.default;
  }
  edits() {
    const p = this.profile();
    return { ...(p.presetThemes ?? {}), ...(p.theme ? { [p.color]: p.theme } : {}) };
  }
}

async function rounds(macs, n) {
  let published = 0;
  for (let i = 0; i < n; i++) for (const mac of macs) published += await mac.sync();
  return published;
}

async function twoMacsWithPlumEdited(folder) {
  const a = new Mac("a", folder);
  a.edit(PLUM);
  await a.sync();
  const b = new Mac("b", folder, { joining: true });
  await rounds([a, b], 2);
  return { a, b };
}

test("a reset reaches the other Mac and replaces its edit of that preset", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  b.reset();
  await rounds([b, a], 2);
  assert.equal(a.profile().theme, null);
  assert.deepEqual(a.edits(), {});
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U1: switching to a preset and resetting it before syncing resets it on the other Mac too, even where it was edited", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  b.pick("blue");
  b.edit(BLUE);
  b.pick("plum");
  await rounds([a, b], 2);
  a.pick("blue");
  a.reset();
  await rounds([a, b], 3);
  for (const mac of [a, b]) {
    assert.equal(mac.profile().color, "blue", mac.id);
    assert.equal(mac.profile().theme, null, `${mac.id}: blue is plain, as the Mac that reset it shows`);
  }
  assert.deepEqual(b.edits().plum, PLUM, "b keeps the plum edit it switched away from");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U2: picking a preset whose look equals the one it left still moves that look to the other Mac", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(BLUE);
  a.pick("blue");
  a.edit(BLUE);
  a.pick("plum");
  await a.sync();
  const b = new Mac("b", folder, { joining: true });
  await rounds([a, b], 2);
  a.pick("blue");
  await rounds([a, b], 3);
  for (const mac of [a, b]) {
    assert.equal(mac.profile().color, "blue", mac.id);
    assert.deepEqual(mac.profile().theme, BLUE, `${mac.id} shows a's blue edit`);
  }
  assert.deepEqual(a.edits(), { plum: BLUE, blue: BLUE }, "nothing is erased on a");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U3: a rename after a plain switch still lands the switch's look on the other Mac", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.pick("blue");
  a.with(() => S().updateProfile("default", { name: "Renamed" }));
  await rounds([a, b], 3);
  for (const mac of [a, b]) {
    assert.equal(mac.profile().color, "blue", mac.id);
    assert.equal(mac.profile().theme, null, mac.id);
  }
  assert.deepEqual(b.edits(), { plum: PLUM }, "b keeps plum's edit");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U4: a switch on one Mac and an edit on the other at once end with both Macs showing the same look", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.pick("blue");
  a.edit(BLUE);
  b.edit(GREEN);
  await a.sync();
  await b.sync();
  await rounds([a, b], 3);
  assert.equal(a.profile().color, b.profile().color);
  assert.deepEqual(a.profile().theme, b.profile().theme, "same look on both");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U5: pairing takes the synced colour even when the other Mac never synced a look", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.with(() => S().setProfileLook("default", { color: "blue" }));
  await a.sync();
  const fresh = new Mac("fresh", folder, { joining: true });
  fresh.with(() => pairTheme(a.scope, "default", { syncId: "s1" }));
  assert.equal(fresh.profile().color, "blue");
});

test("a switch made on 0.2.47 keeps the edit of the preset it left on a newer Mac", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.oldPick("blue");
  await rounds([old, a], 3);
  assert.equal(a.profile().color, "blue");
  assert.equal(a.profile().theme, null);
  assert.deepEqual(a.edits(), { plum: PLUM });
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("picking a preset on 0.2.47 shows the look it synced, plain included, on the newer Mac", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.pick("blue");
  a.edit(BLUE);
  a.pick("plum");
  a.edit(PLUM);
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.oldPick("blue");
  await rounds([old, a], 3);
  assert.equal(a.profile().color, "blue");
  assert.equal(a.profile().theme, null, "the synced plain look replaces the newer Mac's blue edit, as a pick clears the custom theme on main");
  assert.deepEqual(a.edits(), { plum: PLUM });
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("an edit made on 0.2.47 lands on the preset that's showing", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.edit(GREEN);
  await rounds([old, a], 3);
  assert.equal(a.profile().color, "blue");
  assert.deepEqual(a.edits(), { plum: PLUM, blue: GREEN });
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("a Mac upgraded from 0.2.47 keeps its newest edit and settles", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.edit(GREEN);
  await old.sync();
  old.upgrade();
  await rounds([old, a], 3);
  for (const mac of [a, old]) assert.deepEqual(mac.profile().theme, GREEN, mac.id);
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("pairing a fresh Mac takes the synced colour with its look", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  a.edit(BLUE);
  await a.sync();
  const fresh = new Mac("fresh", folder, { joining: true });
  fresh.with(() => pairTheme(a.scope, "default", { syncId: "s1" }));
  assert.equal(fresh.profile().color, "blue");
  assert.deepEqual(fresh.profile().theme, BLUE);
  fresh.pick("plum");
  assert.equal(fresh.profile().theme, null, "plum on the new Mac is plain, never blue's edit");
});

test("only the showing look is ever written to sync", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  a.edit(BLUE);
  await a.sync();
  const keys = new Set([...folder.files.values()].flatMap((f) => (JSON.parse(f.payload).ops ?? []).map((op) => op.k)));
  assert.deepEqual([...keys].filter((k) => !/^(prof|pth):s1(:angle)?$/.test(k)), []);
});

test("V1: pairing with a Mac that never synced a look keeps this Mac's edit for its own preset and publishes nothing until a look arrives", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.with(() => S().setProfileLook("default", { color: "blue" }));
  await a.sync();
  const fresh = new Mac("fresh", folder, { joining: true });
  fresh.edit(PLUM);
  await fresh.sync();
  assert.equal(fresh.profile().color, "blue");
  assert.equal(fresh.profile().theme ?? null, null, "blue shows plain: no look came with it");
  assert.deepEqual(fresh.edits(), { plum: PLUM }, "the plum edit is kept under plum");
  assert.equal(await rounds([fresh, a, fresh], 3), 0, "nothing publishes without a user action");
  assert.equal(a.profile().theme ?? null, null, "and plum's edit never reaches the other Mac as blue's look");
  a.edit(BLUE);
  await rounds([a, fresh], 2);
  assert.deepEqual(fresh.profile().theme, BLUE, "a look that arrives later shows");
  assert.deepEqual(fresh.edits().plum, PLUM);
});

async function splitPick(order) {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  b.edit(GREEN);
  await rounds([b, a], 2);
  a.pick("blue");
  await a.sync();
  const colourFile = `f${folder.counter}`;
  a.edit(BLUE);
  await a.sync();
  const lookFile = `f${folder.counter}`;
  folder.withhold = (id) => id === (order === "look first" ? colourFile : lookFile);
  await b.sync();
  folder.withhold = null;
  await b.sync();
  return { a, b };
}

test("V2: the look arriving before its colour doesn't erase this Mac's own edit of the preset it was on", async () => {
  const { b } = await splitPick("look first");
  assert.equal(b.profile().color, "blue");
  assert.deepEqual(b.profile().theme, BLUE);
  assert.deepEqual(b.edits().plum, GREEN, "plum keeps this Mac's own edit, not blue's look");
});

test("V2: the colour arriving before its look keeps this Mac's own edit of the preset it was on", async () => {
  const { b } = await splitPick("colour first");
  assert.equal(b.profile().color, "blue");
  assert.deepEqual(b.profile().theme, BLUE);
  assert.deepEqual(b.edits().plum, GREEN);
});

test("V2: an edit of the showing preset from another Mac shows here, and this Mac keeps its replaced look locally until it acts", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.edit(GREEN);
  await rounds([a, b], 2);
  assert.deepEqual(b.profile().theme, GREEN);
  assert.deepEqual(b.profile().previousTheme, { color: "plum", theme: PLUM });
  b.edit(BLUE);
  assert.equal(b.profile().previousTheme, undefined, "any user action drops it");
  assert.equal(await rounds([b, a, b], 3) > 0, true);
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("V2, the case records can't tell apart: another Mac edits the showing preset, then a later switch from sync keeps this Mac's older look of it locally", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.edit(GREEN);
  await rounds([a, b], 2);
  a.pick("blue");
  await rounds([a, b], 2);
  assert.equal(b.profile().color, "blue");
  assert.deepEqual(b.edits().plum, PLUM, "b's stash for plum is its own older look, never another preset's look");
  assert.deepEqual(a.edits().plum, GREEN, "the Mac that made the newer edit keeps it");
  assert.equal(await rounds([a, b], 3), 0, "nothing publishes from it");
});

function random(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test("over random sequences, a sync never publishes unless that Mac had a user action, and quiet Macs agree", async () => {
  const colors = ["plum", "blue", "green"];
  const looks = [PLUM, BLUE, GREEN, look(0.5, 0.3)];
  for (let seed = 1; seed <= 80; seed++) {
    const next = random(seed);
    const folder = new Folder();
    const a = new Mac("a", folder);
    a.edit(PLUM);
    await a.sync();
    const b = new Mac("b", folder, { joining: true });
    const old = new Mac("old", folder, { old: true, joining: true });
    const macs = [a, b, old];
    const dirty = new Set();
    const act = (mac, inPlace) => {
      const run = inPlace ? (fn) => fn() : (fn) => mac.with(fn);
      const action = next();
      if (action < 0.4) {
        const color = colors[Math.floor(next() * colors.length)];
        run(() => (mac.old ? S().setProfileLook("default", { color, theme: null }) : choosePresetColor("default", color, () => {})));
      } else if (action < 0.8) run(() => setProfileTheme("default", looks[Math.floor(next() * looks.length)], () => {}));
      else run(() => (mac.old ? S().setProfileLook("default", { theme: null }) : resetPresetTheme("default", () => {})));
      dirty.add(mac);
    };
    if (next() < 0.5) act(b, false);
    folder.withhold = (id) => next() < 0.3 && Number(id.slice(1)) > 1;
    for (let step = 0; step < 16; step++) {
      const mac = macs[Math.floor(next() * macs.length)];
      if (next() < 0.4) {
        act(mac, false);
        continue;
      }
      const wasDirty = dirty.has(mac);
      dirty.delete(mac);
      let midRead = false;
      const published = await mac.sync(next() < 0.2 ? () => ((midRead = true), act(mac, true)) : null);
      if (!wasDirty && !midRead) assert.equal(published, 0, `seed ${seed} step ${step}: ${mac.id} published after only applying`);
    }
    folder.withhold = null;
    await rounds(macs, 4);
    assert.equal(await rounds(macs, 2), 0, `seed ${seed}: settles`);
    for (const mac of [b, old]) {
      assert.equal(mac.profile().color, a.profile().color, `seed ${seed}: ${mac.id} colour`);
      assert.deepEqual(mac.profile().theme ?? null, a.profile().theme ?? null, `seed ${seed}: ${mac.id} look`);
    }
  }
});
