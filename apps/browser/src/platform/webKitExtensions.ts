import { call, type WebKitExtension, type WebKitExtensionInspection, type WebKitExtensionList } from "@ardia/ardiacore";

export type { WebKitExtension, WebKitExtensionInspection, WebKitExtensionList };

export const inspectWebKitExtension = (path: string) => call("webKit.extensionInspect", { path });
export const listWebKitExtensions = (profile: string) => call("webKit.extensionList", { profile });
export const loadWebKitExtension = (profile: string, path: string, fingerprint: string, permissions: string[], origins: string[]) => call("webKit.extensionLoad", { profile, path, fingerprint, permissions, origins });
export const grantWebKitExtension = (profile: string, id: string, permissions: string[], origins: string[]) => call("webKit.extensionGrant", { profile, id, permissions, origins });
export const showWebKitExtension = (profile: string, id: string, tabId: string) => call("webKit.extensionShow", { profile, id, tabId });
export const unloadWebKitExtension = (profile: string, id: string) => call("webKit.extensionUnload", { profile, id });
