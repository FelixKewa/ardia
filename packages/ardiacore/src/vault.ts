export type VaultSignInStatus = "signed_in" | "submitted" | "still_on_login" | "filled" | "no_form" | "no_login" | "needs_passkey" | "needs_human" | "cross_origin" | "busy" | "cancelled" | "failed";
export type VaultTransfer = "none" | "complete" | "partial" | "sent" | "timed_out";
export type VaultSignIn = { status: VaultSignInStatus; reason?: string; readyMs?: number; fillMs?: number; totalMs?: number; profileMs?: number; seedMs?: number; loadMs?: number; scanMs?: number; transferMs?: number; transfer?: VaultTransfer; conflicts?: number; cookies?: number; localStorage?: number; transferFailed?: number; blockedRequests?: number; usedCode: boolean; codeMs: number; prepareMs: number; appMs: number };
export type VaultStoreState = { ready: boolean; problem: "unrecoverable" | "unreadable" | "unavailable" | "retry" | null; unlockMs: number; secureEnclave: boolean; kind: "software" | "secureEnclave" };
export type VaultAlwaysGrant = { profile: string; origin: string; teamId: string; identifier: string; program: string; added: number };
export type VaultLoginFormSeen = { tab: string; origin: string; hasUsername: boolean; hasPassword: boolean; hasOneTimeCode: boolean; mainFrame: boolean; document?: string | number; at: number };
export type VaultAuthentication = { granted: boolean; how: "granted" | "cancelled" | "failed" | "unavailable" | "testDenied"; ms: number };
