import { create } from "zustand";
import { useEffect } from "react";
import { chooseExtensionFolder } from "../../platform/extensions";
import { confirm } from "../../platform/dialogs";
import { showMenu } from "../../platform/menus";
import { inspectWebKitExtension, listWebKitExtensions, loadWebKitExtension, showWebKitExtension, unloadWebKitExtension, type WebKitExtension, type WebKitExtensionInspection, type WebKitExtensionList } from "../../platform/webKitExtensions";
import { errorText } from "../../lib/errors";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { TOOLBAR_TRAILING } from "../../lib/toolbarRow";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { tabEngine } from "../engines/engines";
import { shownPageId } from "../peek/peek";
import { usePages } from "../tabs/pageState";
import { openSettings, SETTINGS_WINDOW_ID, useSettingsNav } from "../settings/settingsWindows";

export type { WebKitExtension };

type Review = { key: number; profileId: string; profile: string; pkg: WebKitExtensionInspection; permissions: string[]; origins: string[]; busy: boolean };
type State = {
  lists: Record<string, WebKitExtension[]>;
  errors: Record<string, string | null>;
  available: boolean | null;
  review: Review | null;
  choosing: boolean;
};
export const useWebKitExtensions = create<State>()(() => ({ lists: {}, errors: {}, available: null, review: null, choosing: false }));
const EMPTY: WebKitExtension[] = [];
let request = 0;
let settingsHost: { profileId: string } | null = null;
const refreshes = new Map<string, number>();
const inFlight = new Map<string, Promise<WebKitExtensionList | undefined>>();

export const WEBKIT_PERMISSION_DETAILS: Record<string, string> = {
  activeTab: "Access the current tab when you click the extension",
  scripting: "Run scripts on sites you allow",
  storage: "Save extension settings and data",
  unlimitedStorage: "Store extension data without the usual quota",
  contextMenus: "Add items to page context menus",
  tabs: "Read titles and URLs of all WebKit tabs in this profile",
};

export function exactWebKitHost(pattern: string): boolean {
  try {
    const url = new URL(pattern);
    return url.protocol === "https:" && !!url.hostname && !url.hostname.includes("*") && !url.hostname.includes("%") &&
      !url.username && !url.password && !url.port && !url.search && !url.hash && pattern === `https://${url.hostname}/*`;
  } catch { return false; }
}

function requestedHost(pattern: string, origins: string[]): boolean {
  if (!exactWebKitHost(pattern)) return false;
  const host = new URL(pattern).hostname;
  return origins.some((origin) => {
    if (origin === "<all_urls>" || origin === pattern) return true;
    const match = /^(?:https|\*):\/\/([^/:?#@]+)\/\*$/.exec(origin);
    if (!match) return false;
    const requested = match[1]!.toLowerCase();
    return requested === "*" || requested === host ||
      (requested.startsWith("*.") && (host === requested.slice(2) || host.endsWith(`.${requested.slice(2)}`)));
  });
}

const regularProfile = (profileId: string) => PLATFORM_FEATURES.webKit && !isIncognitoProfile(profileId) && !!useBrowser.getState().profiles[profileId];
const profileOf = (profileId: string) => engineProfile(useBrowser.getState(), profileId);
const fail = (profile: string, error: unknown) => useWebKitExtensions.setState((s) => ({ errors: { ...s.errors, [profile]: error === null ? null : errorText(error) } }));

export function bindWebKitSettings(profileId: string) {
  const host = { profileId };
  settingsHost = host;
  cancelWebKitReview();
  return () => {
    if (settingsHost !== host) return;
    settingsHost = null;
    cancelWebKitReview();
  };
}

export function cancelWebKitReview() {
  request += 1;
  useWebKitExtensions.setState({ review: null, choosing: false });
}

export function useWebKitExtensionList(profileId: string) {
  const profile = useBrowser((s) => engineProfile(s, profileId));
  return useWebKitExtensions((s) => s.lists[profile] ?? EMPTY);
}

export function useWebKitExtensionError(profileId: string) {
  const profile = useBrowser((s) => engineProfile(s, profileId));
  return useWebKitExtensions((s) => s.errors[profile] ?? null);
}

export async function refreshWebKitExtensions(profileId: string, fresh = false) {
  if (!regularProfile(profileId)) return;
  const profile = profileOf(profileId);
  const existing = inFlight.get(profile);
  if (!fresh && existing) return existing;
  const key = (refreshes.get(profile) ?? 0) + 1;
  refreshes.set(profile, key);
  const pending = Promise.resolve().then(async () => {
    try {
      const result = await listWebKitExtensions(profile);
      if (refreshes.get(profile) !== key || !regularProfile(profileId) || profileOf(profileId) !== profile) return;
      useWebKitExtensions.setState((s) => ({ available: result.available, lists: { ...s.lists, [profile]: result.extensions } }));
      return result;
    } catch (error) {
      if (refreshes.get(profile) === key) fail(profile, error);
    } finally {
      if (refreshes.get(profile) === key) inFlight.delete(profile);
    }
  });
  inFlight.set(profile, pending);
  return pending;
}

function settingsTarget(profileId: string, key: number) {
  const host = settingsHost;
  const nav = useSettingsNav.getState();
  const record = useBrowser.getState().profiles[profileId];
  const profile = profileOf(profileId);
  return () => request === key && settingsHost === host && host?.profileId === profileId &&
    useSettingsNav.getState() === nav && useBrowser.getState().profiles[profileId] === record && regularProfile(profileId) && profileOf(profileId) === profile;
}

let reviewCurrent: (() => boolean) | null = null;

export async function reviewWebKitExtension(profileId: string, savedPath?: string) {
  if (!regularProfile(profileId) || settingsHost?.profileId !== profileId || useWebKitExtensions.getState().review?.busy) return;
  const key = ++request;
  const current = settingsTarget(profileId, key);
  const profile = profileOf(profileId);
  useWebKitExtensions.setState({ review: null, choosing: true });
  fail(profile, null);
  try {
    const path = savedPath ?? await chooseExtensionFolder();
    if (!current() || !path) return;
    const pkg = await inspectWebKitExtension(path);
    if (!current()) return;
    reviewCurrent = current;
    useWebKitExtensions.setState({ review: { key, profileId, profile, pkg, permissions: [], origins: [], busy: false } });
  } catch (error) {
    if (current()) fail(profile, error);
  } finally {
    if (request === key) useWebKitExtensions.setState({ choosing: false });
  }
}

export function selectWebKitGrant(key: number, kind: "permissions" | "origins", value: string, on: boolean) {
  const review = useWebKitExtensions.getState().review;
  if (!review || review.key !== key || review.busy || !reviewCurrent?.()) return;
  const allowed = kind === "permissions"
    ? review.pkg.requestedPermissions.includes(value) && review.pkg.supportedPermissions.includes(value)
    : requestedHost(value, review.pkg.requestedOrigins);
  if (!allowed) return;
  const values = review[kind].filter((entry) => entry !== value);
  useWebKitExtensions.setState({ review: { ...review, [kind]: on ? [...values, value] : values } });
}

export function addWebKitHost(key: number, input: string): boolean {
  const review = useWebKitExtensions.getState().review;
  if (!review || review.key !== key || review.busy || !reviewCurrent?.()) return false;
  try {
    const value = input.trim();
    if (!/^(?:https:\/\/)?[^/:?#@]+(?:\/(?:\*)?)?$/.test(value)) return false;
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const pattern = `https://${url.hostname}/*`;
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !["/", "/*"].includes(url.pathname) || !requestedHost(pattern, review.pkg.requestedOrigins)) return false;
    useWebKitExtensions.setState({ review: { ...review, origins: [...new Set([...review.origins, pattern])] } });
    return true;
  } catch { return false; }
}

export async function acceptWebKitReview(key: number) {
  const review = useWebKitExtensions.getState().review;
  const current = reviewCurrent;
  if (!review || review.key !== key || review.busy || !current?.()) return;
  useWebKitExtensions.setState({ review: { ...review, busy: true } });
  try {
    const { confirmed } = await confirm({
      title: `Trust ${review.pkg.name} ${review.pkg.version}?`,
      message: `This loads extension code and starts its background code in this profile. Only continue if you trust its source. Updated code retains this extension's saved data.\n\nPermissions: ${review.permissions.map((p) => WEBKIT_PERMISSION_DETAILS[p] ?? p).join("; ") || "None"}.\n\nSite access: ${review.origins.map((p) => new URL(p).hostname).join(", ") || "None"}. Access covers all HTTPS pages on each selected host, not just a URL path. Private windows are excluded.`,
      confirmTitle: "Trust and Load",
      windowId: SETTINGS_WINDOW_ID,
    });
    if (!confirmed || !current()) return;
    await loadWebKitExtension(review.profile, review.pkg.path, review.pkg.fingerprint, review.permissions, review.origins);
    if (!current()) return;
    fail(review.profile, null);
    cancelWebKitReview();
  } catch (error) {
    if (current()) fail(review.profile, error);
  } finally {
    const pending = useWebKitExtensions.getState().review;
    if (pending?.key === key) useWebKitExtensions.setState({ review: { ...pending, busy: false } });
    await refreshWebKitExtensions(review.profileId, true);
  }
}

export async function disableWebKitExtension(profileId: string, id: string) {
  if (!regularProfile(profileId)) return;
  const profile = profileOf(profileId);
  cancelWebKitReview();
  try { await unloadWebKitExtension(profile, id); fail(profile, null); }
  catch (error) { fail(profile, error); }
  await refreshWebKitExtensions(profileId, true);
}

function toolbarTarget(s: BrowserState, windowId: string, tabId = shownPageId(s, windowId)) {
  const window = s.windows[windowId];
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (!PLATFORM_FEATURES.webKit || !window || window.kind === "private" || !tab || isIncognitoProfile(tab.profileId) ||
    shownPageId(s, windowId) !== tabId || tab.windowId !== windowId || tabEngine(s, tab.id) !== "webkit") return null;
  return { window, tab, profile: engineProfile(s, tab.profileId) };
}

export function webKitToolbarMode(s: BrowserState, windowId: string, tabId = shownPageId(s, windowId)): "webkit" | "hidden" | "chromium" {
  if (!PLATFORM_FEATURES.webKit || !tabId || !s.tabs[tabId] || tabEngine(s, tabId) !== "webkit") return "chromium";
  return toolbarTarget(s, windowId, tabId) ? "webkit" : "hidden";
}

export const useWebKitToolbarMode = (windowId: string, tabId?: string) => useBrowser((s) => webKitToolbarMode(s, windowId, tabId));

export function webKitToolbarLayout(list: WebKitExtension[], limit: number, button: number) {
  const active = list.filter((extension) => extension.enabled && extension.loaded);
  const slots = limit === Infinity ? active.length : Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 1) - 1);
  const visible = active.slice(0, slots);
  const overflow = active.slice(visible.length);
  return { visible, overflow, width: (visible.length + 1) * button + visible.length * TOOLBAR_TRAILING.itemGap };
}

export function useWebKitToolbarLayout(windowId: string, limit: number, button: number, tabId?: string) {
  const profile = useBrowser((s) => toolbarTarget(s, windowId, tabId)?.profile ?? null);
  const list = useWebKitExtensions((s) => profile === null ? EMPTY : s.lists[profile] ?? EMPTY);
  return webKitToolbarLayout(list, limit, button);
}

export function watchWebKitToolbar(windowId: string, tabId: string) {
  const target = toolbarTarget(useBrowser.getState(), windowId, tabId);
  if (!target) return () => {};
  const generation = usePages.getState().ready[tabId];
  let stopped = false;
  let attempts = 0;
  const deadline = Date.now() + 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => {
    const next = toolbarTarget(useBrowser.getState(), windowId, tabId);
    return !stopped && next?.profile === target.profile && next.tab.profileId === target.tab.profileId && usePages.getState().ready[tabId] === generation;
  };
  const refresh = async () => {
    if (!current()) return;
    const result = await refreshWebKitExtensions(target.tab.profileId);
    if (!current() || !result || ++attempts >= 30 || Date.now() >= deadline) return;
    if (result.extensions.some((extension) => extension.enabled && !extension.loaded && !extension.errors.length)) timer = setTimeout(() => void refresh(), 500);
  };
  void refresh();
  return () => { stopped = true; clearTimeout(timer); };
}

export function useWebKitToolbarRefresh(windowId: string, tabId: string) {
  const profile = useBrowser((s) => toolbarTarget(s, windowId, tabId)?.profile ?? null);
  const profileId = useBrowser((s) => toolbarTarget(s, windowId, tabId)?.tab.profileId ?? null);
  const generation = usePages((s) => s.ready[tabId]);
  useEffect(() => profile === null ? undefined : watchWebKitToolbar(windowId, tabId), [windowId, tabId, profile, profileId, generation]);
}

function toolbarActionTarget(windowId: string, tabId: string) {
  const target = toolbarTarget(useBrowser.getState(), windowId, tabId);
  if (!target) return null;
  const generation = usePages.getState().ready[tabId];
  const current = () => {
    const next = toolbarTarget(useBrowser.getState(), windowId, tabId);
    return next?.window === target.window && next?.tab === target.tab && next.profile === target.profile && usePages.getState().ready[tabId] === generation;
  };
  return { ...target, current, ready: typeof generation === "number" && Number.isInteger(generation) && generation > 0 };
}

export async function activateWebKitExtension(windowId: string, tabId: string, id: string, fingerprint?: string) {
  const target = toolbarActionTarget(windowId, tabId);
  if (!target?.ready) return;
  const shown = useWebKitExtensions.getState().lists[target.profile]?.find((extension) => extension.id === id);
  if (!shown?.enabled || !shown.loaded || (fingerprint !== undefined && shown.fingerprint !== fingerprint)) return;
  const result = await refreshWebKitExtensions(target.tab.profileId);
  const latest = result?.extensions.find((extension) => extension.id === id);
  if (!target.current() || !latest?.enabled || !latest.loaded || latest.fingerprint !== shown.fingerprint) return;
  try {
    await showWebKitExtension(target.profile, id, tabId);
    if (target.current()) fail(target.profile, null);
  } catch (error) { if (target.current()) fail(target.profile, error); }
}

export async function openWebKitExtensionMenu(windowId: string, tabId: string, limit = 1) {
  const target = toolbarActionTarget(windowId, tabId);
  if (!target) return;
  const result = await refreshWebKitExtensions(target.tab.profileId);
  if (!target.current() || !result) return;
  const { overflow } = webKitToolbarLayout(result.extensions, limit, 0);
  try {
    const choice = await showMenu([
      ...overflow.map((extension, index) => ({ id: `extension:${index}`, title: extension.name, enabled: target.ready })),
      ...(overflow.length ? [{ separator: true as const }] : []),
      { id: "manage", title: "Manage WebKit Extensions…", symbol: "puzzlepiece.extension" },
    ]);
    if (!target.current()) return;
    if (choice === "manage") return openSettings("profiles", target.tab.profileId);
    const selected = overflow.find((_, index) => choice === `extension:${index}`);
    if (selected) await activateWebKitExtension(windowId, tabId, selected.id, selected.fingerprint);
  } catch (error) { fail(target.profile, error); }
}
