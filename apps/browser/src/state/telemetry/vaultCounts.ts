import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";
import { percentile } from "./transport";

export const VAULT_REFUSALS = ["not_granted", "no_login", "no_form", "needs_passkey", "needs_human", "password_manager_plugin", "task_expired", "denied", "locked", "conflict", "busy", "failed", "bad_request"] as const;
export type VaultRefusal = (typeof VAULT_REFUSALS)[number];
export type VaultGrantVia = "sheet" | "phone" | "always";
export type VaultTiming = "login" | "autofill" | "unlock" | "sheet" | "ready" | "fill" | "decide" | "profile" | "seed" | "load" | "scan" | "transfer";
export const VAULT_FAILURES = ["unreachable", "field_missing", "field_changed", "steps"] as const;
export const noteVaultFailure = (reason: string | undefined, consent?: ConsentToken | null) => {
  if (reason && (VAULT_FAILURES as readonly string[]).includes(reason)) bump(`vault_failures_${reason}`, consent);
};
export const VAULT_TRANSFERS = ["none", "complete", "partial", "sent", "timed_out"] as const;
export type VaultTransferOutcome = (typeof VAULT_TRANSFERS)[number];

const MAX_SAMPLES = 200;
const COUNTS = ["vault_fills", "vault_autofills", "vault_tasks", "vault_codes_filled", "vault_codes_kept", "vault_always_added", ...VAULT_REFUSALS.map((code) => `vault_refusals_${code}`), "vault_grants_sheet", "vault_grants_phone", "vault_grants_always", "vault_phone_approvals", ...VAULT_TRANSFERS.map((t) => `vault_transfers_${t}`), ...VAULT_FAILURES.map((r) => `vault_failures_${r}`), "vault_conflict_keys", "vault_transfer_failures", "vault_blocked_requests"] as const;

let counts: Record<string, number> = {};
let samples: Record<VaultTiming, number[]> = { login: [], autofill: [], unlock: [], sheet: [], ready: [], fill: [], decide: [], profile: [], seed: [], load: [], scan: [], transfer: [] };

const bump = (field: string, consent?: ConsentToken | null) => countFor(consent, () => void (counts[field] = (counts[field] ?? 0) + 1), { [field]: 1 });

export const noteVaultFill = (auto: boolean, usedCode: boolean, consent?: ConsentToken | null) => {
  bump(auto ? "vault_autofills" : "vault_fills", consent);
  if (usedCode) bump("vault_codes_filled", consent);
};
export const noteVaultRefusal = (code: VaultRefusal, consent?: ConsentToken | null) => bump(`vault_refusals_${code}`, consent);
export const noteVaultGrant = (via: VaultGrantVia, consent?: ConsentToken | null) => (bump("vault_tasks", consent), bump(`vault_grants_${via}`, consent), via === "phone" && bump("vault_phone_approvals", consent));
export function noteVaultTransfer(outcome: VaultTransferOutcome | undefined, sums: { conflicts?: number; transferFailed?: number; blockedRequests?: number }, consent?: ConsentToken | null) {
  if (outcome && (VAULT_TRANSFERS as readonly string[]).includes(outcome)) bump(`vault_transfers_${outcome}`, consent);
  const add = (field: string, n: number | undefined) => {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return;
    const amount = Math.min(Math.round(n), 10_000);
    countFor(consent, () => void (counts[field] = (counts[field] ?? 0) + amount), { [field]: amount });
  };
  add("vault_conflict_keys", sums.conflicts);
  add("vault_transfer_failures", sums.transferFailed);
  add("vault_blocked_requests", sums.blockedRequests);
}

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
  samples = { login: [], autofill: [], unlock: [], sheet: [], ready: [], fill: [], decide: [], profile: [], seed: [], load: [], scan: [], transfer: [] };
  return taken;
}
