import { useBrowser } from "../browser/store";
import type { ProfileColor, ProfileTheme } from "../browser/types";
import { adoptProfileTheme } from "../sync/engine";
import { withPresetChosen } from "../../lib/presetLook";
import { noteThemePreset } from "../telemetry/themePresetCounts";

export { holdThemedWindowsKeyLook } from "../../platform/theme";

export function setProfileTheme(profileId: string, theme: ProfileTheme | null, adopt = adoptProfileTheme) {
  adopt(profileId);
  useBrowser.getState().setProfileLook(profileId, { theme, previousTheme: undefined });
}

export const showingPreset = (profileId: string): ProfileColor => useBrowser.getState().profiles[profileId]?.color ?? "plum";

export function choosePresetColor(profileId: string, color: ProfileColor, adopt = adoptProfileTheme) {
  const profile = useBrowser.getState().profiles[profileId];
  const choice = profile ? withPresetChosen(profile, color) : null;
  if (!choice) return;
  adopt(profileId);
  useBrowser.getState().setProfileLook(profileId, { ...choice, previousTheme: undefined });
}

export function resetPresetTheme(profileId: string, adopt = adoptProfileTheme) {
  if (!useBrowser.getState().profiles[profileId]?.theme) return;
  adopt(profileId);
  useBrowser.getState().setProfileLook(profileId, { theme: null, previousTheme: undefined });
  noteThemePreset("reset");
}

export function onPresetSelection(profileId: string, changed: () => void): () => void {
  return useBrowser.subscribeTo(["profiles"], (state, before) => {
    if (state.profiles[profileId]?.color !== before.profiles[profileId]?.color) changed();
  });
}
