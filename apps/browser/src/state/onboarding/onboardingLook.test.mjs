import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { chooseSource, goToStep, previewTheme, skipStep, startOnboarding, useOnboarding } from "./onboarding.ts";
import { usePlugins } from "../plugins/store.ts";

usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const look = (r) => ({ stops: [{ x: 0.3, y: 0.6, color: { r, g: 0.4, b: 0.7, a: 1 } }], intensity: 0.6, mode: "auto", grain: 0, texture: "grain", translucency: 1 });

test("skipping the colour step after the window changed profile puts the look back on the profile it was previewed on, and leaves the other alone", () => {
  const windowId = S().createWindow();
  const personal = S().windows[windowId].profileId;
  S().setProfileLook(personal, { color: "plum", theme: look(0.1), presetThemes: { plum: look(0.1) } });
  const work = S().createProfile({ name: "Work", color: "blue" });
  S().setProfileLook(work, { theme: look(0.9), presetThemes: { blue: look(0.9) } });
  startOnboarding(windowId, "source");
  chooseSource("fresh");
  goToStep("look");
  previewTheme(look(0.5));
  useBrowser.setState((s) => ({ windows: { ...s.windows, [windowId]: { ...s.windows[windowId], profileId: work } } }));
  skipStep();
  assert.deepEqual(S().profiles[work].presetThemes, { blue: look(0.9) }, "work keeps its own looks");
  assert.deepEqual(S().profiles[work].theme, look(0.9));
  assert.deepEqual(S().profiles[personal].theme, look(0.1), "the preview is undone on the profile it was made on");
  assert.deepEqual(S().profiles[personal].presetThemes, { plum: look(0.1) });
  useOnboarding.setState({ windowId: null, leaving: false, redo: false });
});
