import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";
import { percentile } from "./transport";

export const VAULT_REFUSALS = ["not_granted", "no_login", "no_form", "needs_passkey", "needs_human", "password_manager_plugin", "task_expired", "denied", "locked", "failed", "bad_request"] as const;
export type VaultRefusal = (typeof VAULT_REFUSALS)[number];
export type VaultGrantVia = "sheet" | "phone" | "always";
export type VaultTiming = "login" | "autofill" | "unlock" | "sheet" | "ready" | "fill";

const MAX_SAMPLES = 200;
const COUNTS = ["vault_fills", "vault_autofills", "vault_tasks", "vault_codes_filled", "vault_codes_kept", "vault_always_added", ...VAULT_REFUSALS.map((code) => `vault_refusals_${code}`), "vault_grants_sheet", "vault_grants_phone", "vault_grants_always", "vault_phone_approvals"] as const;

let counts: Record<string, number> = {};
let samples: Record<VaultTiming, number[]> = { login: [], autofill: [], unlock: [], sheet: [], ready: [], fill: [] };

const bump = (field: string, consent?: ConsentToken | null) => countFor(consent, () => void (counts[field] = (counts[field] ?? 0) + 1), { [field]: 1 });

export const noteVaultFill = (auto: boolean, usedCode: boolean, consent?: ConsentToken | null) => {
  bump(auto ? "vault_autofills" : "vault_fills", consent);
  if (usedCode) bump("vault_codes_filled", consent);
};
export const noteVaultRefusal = (code: VaultRefusal, consent?: ConsentToken | null) => bump(`vault_refusals_${code}`, consent);
export const noteVaultGrant = (via: VaultGrantVia, consent?: ConsentToken | null) => (bump("vault_tasks", consent), bump(`vault_grants_${via}`, consent), via === "phone" && bump("vault_phone_approvals", consent));
export const noteVaultCodeKept = (consent?: ConsentToken | null) => bump("vault_codes_kept", consent);
export const noteVaultAlwaysAdded = (consent?: ConsentToken | null) => bump("vault_always_added", consent);

export function noteVaultTiming(kind: VaultTiming, ms: number | undefined, consent?: ConsentToken | null) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  countFor(consent, () => void (samples[kind].length < MAX_SAMPLES && samples[kind].push(Math.round(ms * 10) / 10)), {});
}

export function takeVaultCounts(): Record<string, number> {
  const taken: Record<string, number> = Object.fromEntries(COUNTS.map((field) => [field, counts[field] ?? 0]));
  for (const [kind, list] of Object.entries(samples) as [VaultTiming, number[]][]) {
    if (!list.length) continue;
    const sorted = [...list].sort((a, b) => a - b);
    taken[`vault_${kind}_ms_count`] = sorted.length;
    taken[`vault_${kind}_ms_p50`] = percentile(sorted, 0.5);
    taken[`vault_${kind}_ms_p95`] = percentile(sorted, 0.95);
    taken[`vault_${kind}_ms_max`] = sorted.at(-1)!;
  }
  counts = {};
  samples = { login: [], autofill: [], unlock: [], sheet: [], ready: [], fill: [] };
  return taken;
}
