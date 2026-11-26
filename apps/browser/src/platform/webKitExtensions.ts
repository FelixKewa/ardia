import { call, type WebKitExtension, type WebKitExtensionInspection, type WebKitExtensionList } from "@ardia/ardiacore";

export type { WebKitExtension, WebKitExtensionInspection, WebKitExtensionList };

export const inspectWebKitExtension = (path: string, allWebsites = false) => call("webKit.extensionInspect", { path, allWebsites });
export const listWebKitExtensions = (profile: string) => call("webKit.extensionList", { profile });
export const loadWebKitExtension = (profile: string, path: string, fingerprint: string, permissions: string[], origins: string[], allWebsites = false, allProfiles = false) => call("webKit.extensionLoad", { profile, path, fingerprint, permissions, origins, allWebsites, allProfiles });
export const grantWebKitExtension = (profile: string, id: string, permissions: string[], origins: string[], allProfiles = false) => call("webKit.extensionGrant", { profile, id, permissions, origins, allProfiles });
export const showWebKitExtension = (profile: string, id: string, tabId: string) => call("webKit.extensionShow", { profile, id, tabId });
export const unloadWebKitExtension = (profile: string, id: string, allProfiles = false) => call("webKit.extensionUnload", { profile, id, allProfiles });
