import { hexColor, lookAngle, padPosition, type PresetLookFields, type PresetThemes, type ProfileColor, type ProfileTheme, type ThemeLook } from "./profileLook";

export function presetStartingTheme(swatch: string): ProfileTheme {
  const color = hexColor(swatch);
  return { stops: [{ ...padPosition(color), color }], intensity: 0.6, mode: "auto", grain: 0, texture: "grain", translucency: 1 };
}

export function presetThemeOf(profile: PresetLookFields, color: ProfileColor): ProfileTheme | null {
  if (color === profile.color) return profile.theme ?? null;
  return profile.presetThemes?.[color] ?? null;
}

const SAME_VALUE = 1e-9;
const SAME_COLOUR = 0.002;
const SAME_ANGLE = 0.5;

const near = (a: number, b: number, within = SAME_VALUE) => Math.abs(a - b) <= within;

function sameLook(a: ThemeLook, b: ThemeLook): boolean {
  if (a.texture !== b.texture || a.stops.length !== b.stops.length) return false;
  if (!near(a.intensity, b.intensity) || !near(a.grain, b.grain) || !near(a.translucency, b.translucency) || !near(lookAngle(a), lookAngle(b), SAME_ANGLE)) return false;
  return a.stops.every((s, i) => {
    const o = b.stops[i]!;
    const colour = (x: number, y: number) => near(x, y, SAME_COLOUR);
    return near(s.x, o.x) && near(s.y, o.y) && colour(s.color.r, o.color.r) && colour(s.color.g, o.color.g) && colour(s.color.b, o.color.b) && colour(s.color.a, o.color.a);
  });
}

export function snapToStart(value: number, start: number, trackPixels: number): number {
  return Math.abs(value - start) * trackPixels <= 0.5 ? start : value;
}

export function snapPointToStart(point: { x: number; y: number }, start: { x: number; y: number }, padPixels: number): { x: number; y: number } {
  return Math.abs(point.x - start.x) * padPixels <= 0.5 && Math.abs(point.y - start.y) * padPixels <= 0.5 ? { x: start.x, y: start.y } : point;
}

export function isUntouched(theme: ProfileTheme, start: ProfileTheme): boolean {
  return !theme.dark && sameTheme(theme, start);
}

export function sameTheme(a: ProfileTheme | null | undefined, b: ProfileTheme | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.mode !== b.mode || !sameLook(a, b)) return false;
  return a.dark && b.dark ? sameLook(a.dark, b.dark) : !a.dark && !b.dark;
}

export type PresetChoice = { color: ProfileColor; theme: ProfileTheme | null; presetThemes: PresetThemes | undefined };

export function withPresetChosen(profile: PresetLookFields, color: ProfileColor): PresetChoice | null {
  if (color === profile.color) return null;
  const { [profile.color]: _leaving, [color]: arriving, ...others } = profile.presetThemes ?? {};
  const presetThemes: PresetThemes = profile.theme ? { ...others, [profile.color]: profile.theme } : others;
  return { color, theme: arriving ?? null, presetThemes: Object.keys(presetThemes).length ? presetThemes : undefined };
}

export type PreviousTheme = { color: ProfileColor; theme: ProfileTheme };

export type SyncedColor = { color: ProfileColor; theme: ProfileTheme | null | undefined; presetThemes: PresetThemes | undefined; previousTheme: undefined };

export function withSyncedColor(profile: PresetLookFields & { previousTheme?: PreviousTheme }, color: ProfileColor, synced: ProfileTheme | null | undefined): SyncedColor | null {
  if (color === profile.color) return null;
  const departing = profile.previousTheme?.color === profile.color ? profile.previousTheme.theme : profile.theme;
  const { [profile.color]: _leaving, [color]: _replaced, ...others } = profile.presetThemes ?? {};
  const presetThemes: PresetThemes = departing ? { ...others, [profile.color]: departing } : others;
  return { color, theme: synced, presetThemes: Object.keys(presetThemes).length ? presetThemes : undefined, previousTheme: undefined };
}

export function editedPresetCount(profile: PresetLookFields): number {
  const stashed = Object.keys(profile.presetThemes ?? {}).filter((color) => color !== profile.color).length;
  return stashed + (profile.theme ? 1 : 0);
}
