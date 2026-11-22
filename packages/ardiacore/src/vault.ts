export type VaultSignInStatus = "signed_in" | "submitted" | "still_on_login" | "filled" | "no_form" | "no_login" | "needs_passkey" | "needs_human" | "automation_attached" | "cross_origin" | "failed";
export type VaultSignIn = { status: VaultSignInStatus; reason?: string; readyMs?: number; fillMs?: number; totalMs?: number; usedCode: boolean; codeMs: number; prepareMs: number; appMs: number };
export type VaultStoreState = { problem: "unrecoverable" | "unreadable" | "unavailable" | null; unlockMs: number; secureEnclave: boolean; kind: "software" | "secureEnclave" };
export type VaultAlwaysGrant = { profile: string; origin: string; teamId: string; identifier: string; program: string; added: number };
export type VaultLoginFormSeen = { tab: string; origin: string; hasUsername: boolean; hasPassword: boolean; hasOneTimeCode: boolean; mainFrame: boolean; at: number };
export type VaultAuthentication = { granted: boolean; how: "granted" | "cancelled" | "failed" | "unavailable" | "testDenied"; ms: number };
