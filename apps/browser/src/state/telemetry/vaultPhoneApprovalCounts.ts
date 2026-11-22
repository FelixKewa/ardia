import { countFor, type ConsentToken } from "./consentPeriod";

const counts = { asked: 0, allowed: 0, denied: 0, expired: 0, cancelled: 0, unreachable: 0, refused: 0, answerMsTotal: 0, answerMsMost: 0 };

export type PhoneApprovalOutcome = "asked" | "allowed" | "denied" | "expired" | "cancelled" | "unreachable" | "refused";

const FIELD: Record<PhoneApprovalOutcome, string> = {
  asked: "vault_phone_asks",
  allowed: "vault_phone_allowed",
  denied: "vault_phone_denied",
  expired: "vault_phone_expired",
  cancelled: "vault_phone_cancelled",
  unreachable: "vault_phone_unreachable",
  refused: "vault_phone_refused",
};

export function notePhoneApproval(outcome: PhoneApprovalOutcome, consent: ConsentToken | null | undefined, answeredInMs?: number) {
  const ms = answeredInMs !== undefined && Number.isFinite(answeredInMs) ? Math.max(0, Math.round(answeredInMs)) : null;
  countFor(
    consent,
    () => {
      counts[outcome] += 1;
      if (ms === null) return;
      counts.answerMsTotal += ms;
      counts.answerMsMost = Math.max(counts.answerMsMost, ms);
    },
    ms === null ? { [FIELD[outcome]]: 1 } : { [FIELD[outcome]]: 1, vault_phone_answer_ms_total: ms, vault_phone_answer_ms_max: ms },
  );
}

export function takeVaultPhoneApprovalCounts() {
  const taken = {
    vault_phone_asks: counts.asked,
    vault_phone_allowed: counts.allowed,
    vault_phone_denied: counts.denied,
    vault_phone_expired: counts.expired,
    vault_phone_cancelled: counts.cancelled,
    vault_phone_unreachable: counts.unreachable,
    vault_phone_refused: counts.refused,
    vault_phone_answer_ms_total: counts.answerMsTotal,
    vault_phone_answer_ms_max: counts.answerMsMost,
  };
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
  return taken;
}
