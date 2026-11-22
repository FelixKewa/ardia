import { visible } from "../scope.ts";
import type { Adapter, ScopeState } from "../scopeState.ts";
import { VAULT_ANSWER, VAULT_PREFIX, VAULT_REQUEST, vaultAnswerFor, vaultAnswerOf, vaultRequestOf, type VaultAnswerRecord, type VaultRequestRecord } from "../vaultApproval.ts";

export type ViewVaultRequest = { id: string; program: string; sites: string[]; why: string; profileName: string; askedAt: number; expiresAt: number; fromDeviceId: string; fromDevice: string | null };

export type VaultAnswersContext = { answers: () => VaultAnswerRecord[]; drop: (ids: Set<string>) => void };

export function vaultAnswersAdapter(ctx: VaultAnswersContext): Adapter {
  return {
    prefix: VAULT_PREFIX,
    extract: (_base, _queued, now, _known, remote) => {
      const values = new Map<string, unknown>();
      const gone = new Set<string>();
      for (const answer of ctx.answers()) {
        const asked = vaultRequestOf(`${VAULT_REQUEST}${answer.id}`, remote(`${VAULT_REQUEST}${answer.id}`));
        if (!asked || answer.x <= now) gone.add(answer.id);
        else values.set(`${VAULT_ANSWER}${answer.id}`, answer);
      }
      if (gone.size) ctx.drop(gone);
      return {
        values,
        ignore: (k) => !values.has(k),
        published: (keys) => ctx.drop(new Set([...keys].map((k) => k.slice(VAULT_ANSWER.length)))),
      };
    },
    apply: () => true,
  };
}

export function openVaultRequests(app: ScopeState | undefined, answered: Iterable<string>, now: number): VaultRequestRecord[] {
  if (!app) return [];
  const done = new Set(answered);
  for (const [k, v] of visible(app, VAULT_ANSWER)) if (vaultAnswerOf(k, v)) done.add(k.slice(VAULT_ANSWER.length));
  const out: VaultRequestRecord[] = [];
  for (const [k, v] of visible(app, VAULT_REQUEST)) {
    const request = vaultRequestOf(k, v);
    if (request && request.x > now && !done.has(request.id)) out.push(request);
  }
  return out.sort((a, z) => a.at - z.at || (a.id < z.id ? -1 : 1));
}

export function vaultRequestsView(app: ScopeState | undefined, answered: Iterable<string>, now: number): ViewVaultRequest[] {
  if (!app) return [];
  const names = new Map<string, string>();
  for (const [k, v] of visible(app, "dev:")) {
    const n = (v as { n?: unknown } | null)?.n;
    if (typeof n === "string") names.set(k.slice(4), n);
  }
  return openVaultRequests(app, answered, now).map((r) => ({ id: r.id, program: r.g, sites: [...r.s], why: r.w, profileName: r.pn, askedAt: r.at, expiresAt: r.x, fromDeviceId: r.m, fromDevice: names.get(r.m) ?? null }));
}

export function answerVaultRequest(app: ScopeState | undefined, answers: VaultAnswerRecord[], input: { id: string; allow: boolean; always: boolean; at: number }, me: string): VaultAnswerRecord | null {
  const request = openVaultRequests(app, answers.map((a) => a.id), input.at).find((r) => r.id === input.id);
  if (!request) return null;
  const answer = vaultAnswerFor(request, input.allow === true, input.always === true, me, input.at);
  answers.push(answer);
  return answer;
}
