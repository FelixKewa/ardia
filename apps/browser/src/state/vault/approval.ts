import { create } from "zustand";
import { authenticateDeviceOwner } from "../../platform/vault";
import { vaultApprovalAnswer } from "../../platform/launchConfig";
import { secureRandomHex } from "../../platform/secureRandom";
import { backgroundInstance } from "../app/appSettings";
import { orWarn } from "../../lib/fallback";
import { askPhoneForVaultApproval, cancelPhoneVaultApproval } from "../sync/vaultApprovals";
import { mayAlwaysAllow, programLabel, type Program } from "./programs";

export type ApprovalAnswer = "allow" | "always" | "deny";
export type ApprovalRequest = {
  id: string;
  windowId: string;
  connection: number;
  profileId: string;
  profileName: string;
  program: Program;
  sites: string[];
  why: string;
  mayAlways: boolean;
  askedAt: number;
  expiresAt: number;
};
export type ApprovalOutcome = { allow: true; always: boolean; via: "sheet" | "phone"; sheetMs: number | null } | { allow: false; code: "denied" | "needs_human"; message: string };

export const APPROVAL_SECONDS = 60;
const MAX_WAITING = 4;
const SEAM_FALLBACK_MS = 3000;

type Waiting = { request: ApprovalRequest; settle: (answer: { answer: ApprovalAnswer; via: "sheet" | "phone" } | null) => void; shownAt: number | null; timers: ReturnType<typeof setTimeout>[] };

export const useVaultApproval = create<{ request: ApprovalRequest | null }>()(() => ({ request: null }));

const waiting: Waiting[] = [];

const current = () => waiting[0] ?? null;

function showNext() {
  useVaultApproval.setState({ request: current()?.request ?? null });
}

function settleRequest(id: string, answer: { answer: ApprovalAnswer; via: "sheet" | "phone" } | null) {
  const at = waiting.findIndex((w) => w.request.id === id);
  if (at < 0) return;
  const [entry] = waiting.splice(at, 1);
  for (const timer of entry!.timers) clearTimeout(timer);
  if (answer?.via !== "phone") cancelPhoneVaultApproval(id);
  showNext();
  entry!.settle(answer);
}

export function noteApprovalShown(id: string) {
  const entry = waiting.find((w) => w.request.id === id);
  if (!entry || entry.shownAt !== null) return;
  entry.shownAt = Date.now();
  const seam = backgroundInstance ? vaultApprovalAnswer() : null;
  if (seam && seam !== "ignore") setTimeout(() => answerApproval(id, seam), 0);
}

export const answerApproval = (id: string, answer: ApprovalAnswer) => settleRequest(id, { answer, via: "sheet" });

export function dropApprovals(connection?: number) {
  for (const entry of [...waiting]) if (connection === undefined || entry.request.connection === connection) settleRequest(entry.request.id, null);
}

const siteList = (sites: readonly string[]) => sites.map((s) => s.replace(/^https:\/\//, "")).join(", ");

export async function askApproval(input: Omit<ApprovalRequest, "id" | "askedAt" | "expiresAt" | "mayAlways">, serving: () => boolean): Promise<ApprovalOutcome> {
  if (backgroundInstance && !vaultApprovalAnswer()) return { allow: false, code: "needs_human", message: "Ardia runs in the background here, so nobody can see the approval sheet." };
  if (waiting.length >= MAX_WAITING) return { allow: false, code: "needs_human", message: "Other sign-in approvals are already waiting; try again once they're answered." };
  const askedAt = Date.now();
  const request: ApprovalRequest = { ...input, id: secureRandomHex(32), askedAt, expiresAt: askedAt + APPROVAL_SECONDS * 1000, mayAlways: mayAlwaysAllow(input.program) };
  let shownAt: () => number | null = () => null;
  const answered = new Promise<{ answer: ApprovalAnswer; via: "sheet" | "phone" } | null>((resolve) => {
    const entry: Waiting = { request, settle: resolve, shownAt: null, timers: [] };
    shownAt = () => entry.shownAt;
    waiting.push(entry);
    showNext();
    entry.timers.push(setTimeout(() => settleRequest(request.id, null), request.expiresAt - askedAt));
    if (backgroundInstance) entry.timers.push(setTimeout(() => entry.shownAt === null && noteApprovalShown(request.id), SEAM_FALLBACK_MS));
  });
  const nonce = secureRandomHex(32);
  void askPhoneForVaultApproval({ id: request.id, nonce, profile: request.profileId, program: programLabel(request.program), sites: request.sites, why: request.why, expiresAt: request.expiresAt })
    .then((phone) => phone && phone.nonce === nonce && settleRequest(request.id, { answer: phone.allow ? (phone.always && request.mayAlways ? "always" : "allow") : "deny", via: "phone" }))
    .catch(orWarn(undefined));
  const result = await answered;
  const sheetMs = shownAt() === null ? null : shownAt()! - askedAt;
  if (!result) return { allow: false, code: serving() ? "denied" : "needs_human", message: serving() ? "Nobody approved the sign-in in time." : "The client left before anyone answered." };
  if (result.answer === "deny") return { allow: false, code: "denied", message: "The sign-in was turned down." };
  if (result.via === "sheet") {
    const owner = await authenticateDeviceOwner(`allow ${programLabel(request.program)} to sign in to ${siteList(request.sites)}`).catch(orWarn({ granted: false, how: "failed" as const, ms: 0 }));
    if (!owner.granted) return { allow: false, code: "denied", message: owner.how === "cancelled" ? "Touch ID was cancelled, so the sign-in wasn't allowed." : "Touch ID or the password didn't confirm the sign-in." };
  }
  if (!serving() || Date.now() > request.expiresAt) return { allow: false, code: "needs_human", message: "The approval came after the client left or the request ran out." };
  return { allow: true, always: result.answer === "always" && request.mayAlways, via: result.via, sheetMs };
}
