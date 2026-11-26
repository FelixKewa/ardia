import type { CleanedUrl } from "@ardia/core";
import type { OpenWindowRequest, WebNotification } from "../../pageTypes";
import type { CookieRemoval, PageCookie, PasskeyAccess, SiteData, SiteDataWritten, StorageChange, WebKitCount, WebKitExtension, WebKitExtensionInspection, WebKitExtensionList } from "../../webkit";
import type { Profile } from "../wire";

export type WebKitCalls = {
  "webKit.extensionInspect": [{ path: string }, WebKitExtensionInspection];
  "webKit.extensionList": [Profile, WebKitExtensionList];
  "webKit.extensionLoad": [Profile & { path: string; fingerprint: string; permissions: string[]; origins: string[] }, WebKitExtension];
  "webKit.extensionGrant": [Profile & { id: string; permissions: string[]; origins: string[] }, WebKitExtension];
  "webKit.extensionShow": [Profile & { id: string; tabId: string }, { shown: boolean }];
  "webKit.extensionUnload": [Profile & { id: string }, WebKitExtension];
  "webKit.removeDownloadStaging": [{ path: string }, boolean];
  "webKit.endPrivateSession": [{ session: string }, null];
  "webKit.cookieStoreKey": [Profile, string];
  "webKit.importCookies": [Profile & { storeKey: string; cookies: PageCookie[] }, number];
  "webKit.exportCookies": [Profile & { urls: string[]; keys?: string[] }, number];
  "webKit.writeCopiedAddress": [{ request: number; url: CleanedUrl }, boolean];
  "webKit.setFraudWarnings": [{ enabled: boolean }, null];
  "webKit.watchSiteData": [{ enabled: boolean }, null];
  "webKit.siteDataReady": [{ id: string }, null];
  "webKit.readSiteData": [Profile & { domains: string[]; origins: string[] }, SiteData | null];
  "webKit.writeSiteData": [Profile & { set: PageCookie[]; remove: CookieRemoval[]; storage: Record<string, StorageChange> }, SiteDataWritten | null];
  "webKit.setZoom": [Profile & { host: string; zoom: number }, null];
  "webKit.notificationAction": [{ id: string; action: "click" | "close" }, null];
  "webKit.passkeyAccess": [{}, PasskeyAccess];
  "webKit.requestPasskeyAccess": [{}, PasskeyAccess];
  "webKit.devStoreExists": [Profile, boolean];
  "webKit.devHoldStore": [Profile, null];
  "webKit.devTouchStore": [Profile, boolean];
  "webKit.devParkedTransfers": [{}, string[]];
  "webKit.devContentBlocker": [{}, Record<string, unknown>];
};

export type WebKitEvents = {
  "webKit.counted": { name: WebKitCount; epoch?: string };
  "webKit.copyAddress": { url: string; request: number; epoch?: string };
  "webKit.siteDataWanted": { id: string; profile: string; origin: string; epoch?: string };
  "webKit.siteCookiesChanged": { profile: string; domains: string[]; epoch?: string };
  "webKit.notification": { profile: string; notification: WebNotification; epoch?: string };
  "webKit.notificationClose": { id: string };
  "webKit.openWindow": OpenWindowRequest & { profile: string };
};
