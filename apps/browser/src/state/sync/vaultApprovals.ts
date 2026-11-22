import { vaultOrigin, vaultRequestsAdapter, visible, VAULT_REQUEST_MAX_MS, type Adapter, type ScopeState, type VaultRequestRecord } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { notePhoneApproval } from "../telemetry/vaultPhoneApprovalCounts";
import { scheduleSync, syncWritesOpen, useSync } from "./engine";

export type VaultApprovalAsk = { id: string; nonce: string; profile: string; program: string; sites: string[]; why?: string; alwaysOffered: boolean; expiresAt: number };
export type VaultApprovalAnswer = { allow: boolean; always: boolean; nonce: string };

export type VaultApprovalChannel = {
  deviceId: () => string | null;
  usable: () => boolean;
  app: () => ScopeState | undefined;
  profileName: (profile: string) => string;
  cycleSoon: () => void;
};

type OpenAsk = { request: VaultRequestRecord; askedAt: number; consent: ConsentToken | null; settle: (answer: VaultApprovalAnswer | null) => void; timer: ReturnType<typeof setTimeout> };

const PHONE_SEEN_MS = 14 * 86_400_000;
const CYCLE_GONE_MS = 60_000;
const ASKING_CYCLE_MS = 2_000;
const MAX_TEXT = 300;
const ID = /^[0-9a-f-]{8,64}$/;
const openAsks = new Map<string, OpenAsk>();
let lastCycle: { me: string; app: () => ScopeState | undefined; at: number } | null = null;
let poll: ReturnType<typeof setInterval> | undefined;

const syncChannel: VaultApprovalChannel = {
  deviceId: () => lastCycle?.me ?? null,
  usable: () => !!lastCycle && Date.now() - lastCycle.at < CYCLE_GONE_MS && syncWritesOpen() && useSync.getState().status !== "offline",
  app: () => lastCycle?.app(),
  profileName: (profile) => useBrowser.getState().profiles[profile]?.name ?? "",
  cycleSoon: () => scheduleSync(0),
};

let channel: VaultApprovalChannel | null = syncChannel;

export function connectVaultApprovals(next: VaultApprovalChannel | null) {
  for (const id of [...openAsks.keys()]) finish(id, null, "unreachable");
  channel = next;
}

function pollWhileAsking() {
  if (openAsks.size && !poll) poll = setInterval(() => channel?.cycleSoon(), ASKING_CYCLE_MS);
  if (!openAsks.size && poll) {
    clearInterval(poll);
    poll = undefined;
  }
}

const deviceKind = (app: ScopeState | undefined, device: string) => (app ? (visible(app, "dev:").get(`dev:${device}`) as { k?: unknown } | undefined)?.k : undefined);

export function phonesInReach(app: ScopeState | undefined, now = Date.now()): string[] {
  if (!app) return [];
  const out: string[] = [];
  for (const [key, value] of visible(app, "dev:")) {
    const id = key.slice(4);
    if ((value as { k?: unknown } | null)?.k === "phone" && now - (app.seen[id] ?? 0) <= PHONE_SEEN_MS) out.push(id);
  }
  return out.sort();
}

export const vaultApprovalsAsking = () => openAsks.size > 0;

export function askPhoneForVaultApproval(ask: VaultApprovalAsk): Promise<VaultApprovalAnswer | null> {
  const now = Date.now();
  const consent = consentToken();
  const me = channel?.usable() ? channel.deviceId() : null;
  if (!channel || !me || !phonesInReach(channel.app(), now).length) {
    notePhoneApproval("unreachable", consent);
    return Promise.resolve(null);
  }
  const sites = ask.sites.map(vaultOrigin);
  const valid = ID.test(ask.id) && typeof ask.nonce === "string" && ask.nonce.length >= 16 && ask.nonce.length <= 128 && typeof ask.profile === "string" && ask.profile.length > 0 && ask.profile.length <= 128;
  if (!valid || !sites.length || sites.length > 32 || sites.some((s) => s === null) || new Set(sites).size !== sites.length || !(ask.expiresAt > now) || openAsks.has(ask.id)) {
    notePhoneApproval("refused", consent);
    return Promise.resolve(null);
  }
  const expiresAt = Math.min(Math.floor(ask.expiresAt), now + VAULT_REQUEST_MAX_MS);
  const request: VaultRequestRecord = {
    id: ask.id,
    n: ask.nonce,
    p: ask.profile,
    pn: channel.profileName(ask.profile).slice(0, MAX_TEXT),
    g: String(ask.program ?? "").slice(0, MAX_TEXT),
    s: sites as string[],
    w: String(ask.why ?? "").slice(0, MAX_TEXT),
    x: expiresAt,
    m: me,
    ao: ask.alwaysOffered === true,
    at: now,
  };
  return new Promise((settle) => {
    const timer = setTimeout(() => finish(request.id, null, "expired"), expiresAt - now);
    openAsks.set(request.id, { request, askedAt: now, consent, settle, timer });
    notePhoneApproval("asked", consent);
    pollWhileAsking();
    channel!.cycleSoon();
  });
}

export function cancelPhoneVaultApproval(id: string) {
  finish(id, null, "cancelled");
}

function finish(id: string, answer: VaultApprovalAnswer | null, outcome: "allowed" | "denied" | "expired" | "cancelled" | "unreachable") {
  const entry = openAsks.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  openAsks.delete(id);
  pollWhileAsking();
  notePhoneApproval(outcome, entry.consent, answer ? Date.now() - entry.askedAt : undefined);
  entry.settle(answer);
  channel?.cycleSoon();
}

export function vaultApprovalsAdapter(me: string, app: () => ScopeState | undefined): Adapter {
  lastCycle = { me, app, at: Date.now() };
  return vaultRequestsAdapter({
    me,
    live: () => [...openAsks.values()].map((w) => w.request),
    isPhone: (device) => deviceKind(app(), device) === "phone",
    author: (key) => app()?.records[key]?.o?.[0],
    answered: (request, answer) => finish(request.id, { allow: answer.a, always: answer.a && answer.al, nonce: answer.n }, answer.a ? "allowed" : "denied"),
  });
}
