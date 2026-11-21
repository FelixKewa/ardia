import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

globalThis.__DEV__ = false;

const { profileTheme, PROFILE_COLORS } = await import("./theme.ts");
const look_ = { ...(await import("../../lib/profileLook.ts")), ...(await import("../../lib/presetLook.ts")) };
const { editedPresetCount, presetStartingTheme, presetThemeOf, PROFILE_COLOR_NAMES, withPresetChosen } = look_;
const { themeFromRecord } = await import("../../state/sync/profileAdapters.ts");

const look = (r, intensity = 0.5) => ({ stops: [{ x: 0.2, y: 0.7, color: { r, g: 0.4, b: 0.8, a: 1 } }], intensity, mode: "auto", grain: 0, texture: "grain", translucency: 1 });
const EDIT_A = look(0.1);
const EDIT_B = look(0.9, 0.8);

const digest = (theme) => createHash("sha256").update(JSON.stringify(theme)).digest("hex");
const SAVED_CUSTOM = { stops: [{ x: 0.2, y: 0.7, color: { r: 0.9, g: 0.4, b: 0.8, a: 1 } }, { x: 0.8, y: 0.3, color: { r: 0.2, g: 0.7, b: 0.5, a: 1 } }], intensity: 0.8, mode: "auto", grain: 0.3, texture: "sand", translucency: 0.5, angle: 200 };
const digests = () =>
  Object.fromEntries(
    PROFILE_COLOR_NAMES.flatMap((color) =>
      ["light", "dark"].flatMap((mode) => [
        [`${color}:${mode}`, digest(profileTheme({ color }, mode === "dark"))],
        [`custom:${color}:${mode}`, digest(profileTheme({ color, theme: SAVED_CUSTOM }, mode === "dark"))],
      ]),
    ),
  );
const BEFORE = JSON.parse(readFileSync(new URL("./fixtures/preset-themes-0247.json", import.meta.url), "utf8"));

test("an untouched preset computes the same theme as 0.2.47 did, for all nine in light and dark", () => {
  const now = digests();
  for (const key of Object.keys(BEFORE).filter((k) => !k.startsWith("custom:"))) assert.equal(now[key], BEFORE[key], key);
  for (const color of PROFILE_COLOR_NAMES) {
    assert.deepEqual(profileTheme({ color, theme: null, presetThemes: { [color === "plum" ? "blue" : "plum"]: EDIT_A } }, true), profileTheme({ color }, true), `${color}: another preset's edit changes nothing here`);
  }
});

test("the nine presets are the only swatches, in the order the picker draws them", () => {
  assert.deepEqual(Object.keys(PROFILE_COLORS), [...PROFILE_COLOR_NAMES]);
});

test("each preset keeps its own edit: switching away stashes it and switching back brings it back", () => {
  let profile = { color: "plum", theme: EDIT_A };
  profile = { ...profile, ...withPresetChosen(profile, "blue") };
  assert.equal(profile.color, "blue");
  assert.equal(profile.theme, null, "blue was never edited, so it shows as the plain preset");
  assert.deepEqual(profile.presetThemes, { plum: EDIT_A });
  assert.deepEqual(presetThemeOf(profile, "plum"), EDIT_A);
  assert.equal(presetThemeOf(profile, "blue"), null);
  profile = { ...profile, theme: EDIT_B };
  profile = { ...profile, ...withPresetChosen(profile, "plum") };
  assert.deepEqual(profile.theme, EDIT_A);
  assert.deepEqual(profile.presetThemes, { blue: EDIT_B });
  assert.equal(editedPresetCount(profile), 2);
  profile = { ...profile, ...withPresetChosen(profile, "blue") };
  assert.deepEqual(profile.theme, EDIT_B);
  assert.deepEqual(profile.presetThemes, { plum: EDIT_A });
});

test("picking the preset that's already showing keeps its edit", () => {
  assert.equal(withPresetChosen({ color: "plum", theme: EDIT_A }, "plum"), null);
});

test("reset clears only the showing preset: the others keep their edits", () => {
  const profile = { color: "blue", theme: EDIT_B, presetThemes: { plum: EDIT_A } };
  const reset = { ...profile, theme: null };
  assert.equal(presetThemeOf(reset, "blue"), null);
  assert.deepEqual(presetThemeOf(reset, "plum"), EDIT_A);
  assert.deepEqual({ ...reset, ...withPresetChosen(reset, "plum") }, { color: "plum", theme: EDIT_A, presetThemes: undefined });
});

test("leaving a plain preset drops a stale stash for it, so a reset made elsewhere sticks", () => {
  const profile = { color: "blue", theme: null, presetThemes: { blue: EDIT_B, plum: EDIT_A } };
  assert.equal(presetThemeOf(profile, "blue"), null, "the showing preset reads from theme, never from the stash");
  assert.deepEqual(withPresetChosen(profile, "plum"), { color: "plum", theme: EDIT_A, presetThemes: undefined });
});

test("a 0.2.47 custom theme becomes the edit of the preset it was on, and the window looks exactly the same", () => {
  for (const color of PROFILE_COLOR_NAMES) {
    const saved = { color, theme: SAVED_CUSTOM };
    for (const mode of ["light", "dark"]) assert.equal(digests()[`custom:${color}:${mode}`], BEFORE[`custom:${color}:${mode}`], `${color} ${mode}: drawn as 0.2.47 drew it`);
    assert.deepEqual(presetThemeOf(saved, color), SAVED_CUSTOM, `${color}: its swatch draws the custom look`);
    assert.equal(editedPresetCount(saved), 1);
    const away = { ...saved, ...withPresetChosen(saved, color === "green" ? "red" : "green") };
    assert.deepEqual({ ...away, ...withPresetChosen(away, color) }.theme, SAVED_CUSTOM, `${color}: nothing is lost by switching away and back`);
  }
});

test("a preset opens in the editor as one colour, its swatch, with the custom editor's defaults", () => {
  for (const color of PROFILE_COLOR_NAMES) {
    const start = presetStartingTheme(PROFILE_COLORS[color].swatch);
    assert.equal(start.stops.length, 1);
    assert.deepEqual({ intensity: start.intensity, grain: start.grain, translucency: start.translucency, texture: start.texture, mode: start.mode, angle: start.angle }, { intensity: 0.6, grain: 0, translucency: 1, texture: "grain", mode: "auto", angle: undefined });
    const hex = `#${[start.stops[0].color.r, start.stops[0].color.g, start.stops[0].color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    assert.equal(hex.toLowerCase(), PROFILE_COLORS[color].swatch.toLowerCase());
  }
});

test("the theme record is read as before", () => {
  assert.deepEqual(themeFromRecord({ t: EDIT_B }), { theme: EDIT_B });
  assert.deepEqual(themeFromRecord({ preset: true }), { theme: null });
});

test("an edit counts as untouched when every value is back at the start, whatever the key order or an explicit default angle", () => {
  const { sameTheme, sanitizeTheme, withAngle } = look_;
  const start = presetStartingTheme(PROFILE_COLORS.blue.swatch);
  assert.ok(sameTheme(withAngle(withAngle(start, 200), 135), start));
  assert.ok(sameTheme(sanitizeTheme(JSON.parse(JSON.stringify(start))), start));
  assert.ok(!sameTheme({ ...start, intensity: 0.61 }, start));
  assert.ok(!sameTheme(withAngle(start, 136), start));
});

test("putting a colour point or the brightness back where the preset started counts as untouched", () => {
  const { sameTheme, withStopAt, withStopLightness, stopLightness } = look_;
  for (const color of PROFILE_COLOR_NAMES) {
    const start = presetStartingTheme(PROFILE_COLORS[color].swatch);
    const [stop] = start.stops;
    assert.ok(sameTheme(withStopAt(start, 0, stop.x, stop.y), start), `${color}: the point dragged back`);
    assert.ok(sameTheme(withStopLightness(start, 0, stopLightness(stop)), start), `${color}: the brightness put back`);
    assert.ok(!sameTheme(withStopAt(start, 0, stop.x + 0.02, stop.y), start), `${color}: a real move still counts`);
  }
});

test("a control lands on the preset's start only within half a pixel of it, and anything you can see as different stays an edit", () => {
  const { isUntouched, snapToStart, snapPointToStart } = look_;
  const start = presetStartingTheme(PROFILE_COLORS.blue.swatch);
  const TRACK = 120;
  assert.equal(snapToStart(0.6 + 0.4 / TRACK, 0.6, TRACK), 0.6, "0.4 px off snaps back");
  assert.equal(snapToStart(0.61, 0.6, TRACK), 0.61, "1.2 px off is a real adjustment");
  assert.ok(!isUntouched({ ...start, intensity: 0.61 }, start), "and it stays an edit");
  assert.ok(isUntouched({ ...start, intensity: snapToStart(0.6 - 0.3 / TRACK, 0.6, TRACK) }, start));
  const [stop] = start.stops;
  assert.deepEqual(snapPointToStart({ x: stop.x + 0.4 / 172, y: stop.y - 0.4 / 172 }, stop, 172), { x: stop.x, y: stop.y }, "the pad snaps within half a point");
  assert.equal(snapPointToStart({ x: stop.x + 1 / 172, y: stop.y }, stop, 172).x, stop.x + 1 / 172, "a point away stays");
  for (const color of PROFILE_COLOR_NAMES) {
    const s0 = presetStartingTheme(PROFILE_COLORS[color].swatch);
    const p = s0.stops[0];
    const snapped = snapPointToStart({ x: p.x + 0.3 / 172, y: p.y }, p, 172);
    assert.ok(isUntouched(look_.withStopAt(s0, 0, snapped.x, snapped.y), s0), `${color}: dragged back onto its start`);
  }
});
