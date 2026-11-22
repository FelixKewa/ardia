import { listPasswords } from "../site/passwords";
import { originOfLogin } from "../site/savedPasswords";
import { currentManagerPlugin } from "../site/passwordManager";
import { currentTab } from "../browser/current";
import { useBrowser } from "../browser/store";
import { withLivePage } from "../tabs/livePage";
import { cancelVaultSignIn, onLoginFormSeen, vaultSignIn, type VaultSignIn } from "../../platform/vault";
import { onAppEvent } from "../../platform/app";
import { secureRandomHex } from "../../platform/secureRandom";
import { consentToken } from "../telemetry/client";
import { noteVaultFill, noteVaultRefusal, noteVaultTiming, noteVaultTransfer, type VaultRefusal } from "../telemetry/vaultCounts";
import { recordVaultEvent } from "./activity";
import { dropApprovals } from "./approval";
import { programLabel } from "./programs";
import { dropAllTasks, drivenTabs, driveTab, liveTaskCount, onTaskGone, taskDrivingTab, taskIsLive, undriveTab, type AutoFill, type GoneReason, type VaultTask } from "./tasks";

export class VaultError extends Error {
  readonly code: VaultRefusal;

  constructor(code: VaultRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

const AUTO_RETRY_MS = 30_000;
const AUTO_FAILURES = 3;
const FINAL_REFUSALS: ReadonlySet<VaultRefusal> = new Set(["not_granted", "no_login", "needs_passkey", "needs_human", "password_manager_plugin", "denied", "bad_request", "task_expired", "locked"]);

const STATUS_CODES: Partial<Record<VaultSignIn["status"], VaultRefusal>> = {
  still_on_login: "needs_human",
  needs_human: "needs_human",
  no_form: "no_form",
  no_login: "no_login",
  needs_passkey: "needs_passkey",
  cross_origin: "not_granted",
  cancelled: "task_expired",
  busy: "busy",
  failed: "failed",
};

const STATUS_MESSAGES: Partial<Record<VaultSignIn["status"], string>> = {
  needs_human: "The site wants a step only a person can do (a code sent by text, a CAPTCHA).",
  still_on_login: "Ardia filled the saved login, but the site still shows its sign-in page: it may want a code sent by text, a CAPTCHA or another step only a person can do.",
  no_form: "Ardia didn't find a sign-in form for the saved login on that page.",
  no_login: "Ardia's password store has no saved login for that site and account.",
  needs_passkey: "That site signs in with a passkey, which only the person at the Mac can use.",
  cross_origin: "The sign-in page isn't on the saved login's site. For single sign-on, grant the identity provider's site, sign in there (it needs its own saved login), then reload the tab.",
  cancelled: "The task ended before the sign-in finished.",
  busy: "Another sign-in is running for this site or profile; retry shortly.",
  failed: "The sign-in didn't finish.",
};

const TRANSFER_REFUSALS: Partial<Record<NonNullable<VaultSignIn["transfer"]>, [VaultRefusal, string]>> = {
  sent: ["failed", "The sign-in finished and its session was sent to the profile, but Ardia couldn't confirm it arrived, so the tab may not be signed in."],
  partial: ["failed", "The sign-in finished, but Ardia could move only part of the session to the profile, so the tab may not be signed in."],
  timed_out: ["failed", "The sign-in finished, but moving the session to the profile took too long, so the tab may not be signed in."],
};

const REVOKED: Record<GoneReason | "tab", [VaultRefusal, string]> = {
  ended: ["task_expired", "The task ended before the sign-in finished, so Ardia stopped it."],
  expired: ["task_expired", "The task ran out before the sign-in finished, so Ardia stopped it."],
  closed: ["task_expired", "The connection closed before the sign-in finished, so Ardia stopped it."],
  locked: ["locked", "The Mac locked or slept before the sign-in finished, so Ardia stopped it and ended the task."],
  tab: ["denied", "The tab moved to another profile before the sign-in finished, so Ardia stopped it."],
};

export const tabReloads = { reload: (tabId: string, mayAct: () => boolean) => withLivePage(tabId, (page) => page.reload(), mayAct) };

type Attempt = { id: string; task: VaultTask; origin: string; tabId: string | null; revoked: GoneReason | "tab" | null };

const attempts = new Map<string, Attempt>();

function revoke(attempt: Attempt, why: GoneReason | "tab") {
  if (attempt.revoked) return;
  attempt.revoked = why;
  void cancelVaultSignIn(attempt.id).catch(() => false);
}

function stillAllowed(attempt: Attempt): boolean {
  if (attempt.revoked) return false;
  const { task, tabId } = attempt;
  if (!taskIsLive(task)) revoke(attempt, task.expiresAt <= Date.now() ? "expired" : "closed");
  else if (!task.origins.has(attempt.origin)) revoke(attempt, "ended");
  else if (tabId !== null && currentTab(tabId)?.profileId !== task.profileId) revoke(attempt, "tab");
  return !attempt.revoked;
}

function checkpoint(attempt: Attempt) {
  if (stillAllowed(attempt)) return;
  const [code, message] = REVOKED[attempt.revoked!];
  throw new VaultError(code, message);
}

export function pluginRefusal(profileId: string): VaultError | null {
  const plugin = currentManagerPlugin(profileId);
  return plugin ? new VaultError("password_manager_plugin", `This profile's passwords are kept by ${plugin.title}; Ardia's own password store isn't used, and its plugin doesn't sign agents in.`) : null;
}

async function fetchLogins(task: VaultTask) {
  const saved = await listPasswords(task.engineProfile);
  task.logins.clear();
  for (const login of saved) {
    const origin = originOfLogin(login.origin).toLowerCase();
    if (!task.origins.has(origin)) continue;
    const names = task.logins.get(origin) ?? [];
    if (!names.includes(login.username)) task.logins.set(origin, [...names, login.username]);
  }
}

export function cacheLogins(task: VaultTask): Promise<void> {
  task.loginsLoading ??= fetchLogins(task).catch((error: unknown) => {
    task.loginsLoading = null;
    throw error;
  });
  return task.loginsLoading;
}

async function usernameFor(attempt: Attempt, account: string | null): Promise<string> {
  await cacheLogins(attempt.task);
  checkpoint(attempt);
  const names = attempt.task.logins.get(attempt.origin) ?? [];
  if (account !== null) {
    if (names.includes(account)) return account;
    throw new VaultError("no_login", "There's no saved login with that account for this site.");
  }
  if (names.length === 1) return names[0]!;
  if (!names.length) throw new VaultError("no_login", "There's no saved login for this site in Ardia's password store.");
  throw new VaultError("bad_request", `This site has ${names.length} saved logins; name one with account.`);
}

function signInUrl(origin: string, tabId: string | null): string {
  const url = tabId ? currentTab(tabId)?.url : undefined;
  return url && originOfLogin(url).toLowerCase() === origin ? url : `${origin}/`;
}

type Request = { task: VaultTask; origin: string; account: string | null; tabId: string | null; why: string; auto: boolean; startedAt?: number };

export async function signIn({ task, origin, account, tabId, why, auto, startedAt = Date.now() }: Request) {
  const consent = consentToken();
  const attempt: Attempt = { id: secureRandomHex(16), task, origin, tabId, revoked: null };
  attempts.set(attempt.id, attempt);
  const base = { profile: task.profileId, site: origin, program: programLabel(task.program), signer: task.program.signer, task: task.id.slice(0, 8), via: auto ? "auto" : "login", reason: why };
  let username: string | null = account;
  try {
    const refused = pluginRefusal(task.profileId);
    if (refused) throw refused;
    if (!task.origins.has(origin)) throw new VaultError("not_granted", "This task wasn't granted that site.");
    checkpoint(attempt);
    username = await usernameFor(attempt, account);
    checkpoint(attempt);
    const result = await vaultSignIn(task.engineProfile, signInUrl(origin, tabId), origin, username, attempt.id);
    checkpoint(attempt);
    noteVaultTransfer(result.transfer, result, consent);
    for (const [kind, value] of [["profile", result.profileMs], ["seed", result.seedMs], ["load", result.loadMs], ["scan", result.scanMs]] as const) noteVaultTiming(kind, value, consent);
    noteVaultTiming("transfer", result.transferMs, consent);
    const code = STATUS_CODES[result.status];
    if (code) throw new VaultError(code, STATUS_MESSAGES[result.status] ?? "The sign-in didn't finish.");
    const transfer = TRANSFER_REFUSALS[result.transfer ?? "none"];
    if (transfer) throw new VaultError(...transfer);
    if (tabId) driveTab(task, tabId);
    if (tabId && result.status === "signed_in" && result.transfer === "complete") void tabReloads.reload(tabId, () => stillAllowed(attempt)).catch(() => false);
    if (result.status === "signed_in" && (result.conflicts ?? 0) > 0) throw new VaultError("conflict", "You changed this site's session in Ardia while the agent was signing in, so Ardia kept your changes and reloaded the tab; it may be signed in as you rather than as the saved login.");
    const ms = result.totalMs ?? result.appMs;
    noteVaultFill(auto, result.usedCode, consent);
    noteVaultTiming(auto ? "autofill" : "login", ms, consent);
    noteVaultTiming("ready", result.readyMs, consent);
    noteVaultTiming("fill", result.fillMs, consent);
    recordVaultEvent({ ...base, time: Date.now(), kind: "fill", account: username, outcome: result.status, ms });
    const timing = (value: number | undefined) => (typeof value === "number" && value >= 0 ? value : null);
    return {
      status: result.status,
      transfer: result.transfer ?? "none",
      ms,
      readyMs: timing(result.readyMs),
      fillMs: timing(result.fillMs),
      totalMs: timing(result.totalMs),
      profileMs: timing(result.profileMs),
      seedMs: timing(result.seedMs),
      loadMs: timing(result.loadMs),
      scanMs: timing(result.scanMs),
      transferMs: timing(result.transferMs),
      conflicts: result.conflicts ?? 0,
      usedCode: result.usedCode,
      appMs: Date.now() - startedAt,
    };
  } catch (error) {
    const refusal = error instanceof VaultError ? error : new VaultError("failed", error instanceof Error ? error.message : String(error));
    noteVaultRefusal(refusal.code, consent);
    recordVaultEvent({ ...base, time: Date.now(), kind: "refusal", account: username, outcome: refusal.code });
    throw refusal;
  } finally {
    attempts.delete(attempt.id);
  }
}

function autoFill(task: VaultTask, tab: string, origin: string): AutoFill {
  const key = `${tab}\n${origin}`;
  if (!task.auto.has(key)) task.auto.set(key, { documents: new Set(), lastSuccess: 0, failures: 0, stopped: false });
  return task.auto.get(key)!;
}

function revokeTab(tab: string) {
  for (const attempt of attempts.values()) if (attempt.tabId === tab) revoke(attempt, "tab");
}

let guarding = false;

function guard() {
  if (guarding) return;
  guarding = true;
  onTaskGone((task, why) => {
    for (const attempt of attempts.values()) if (attempt.task === task) revoke(attempt, why);
  });
  onAppEvent((e) => {
    if (e.type !== "lockedOrAsleep" && e.type !== "screenLocked") return;
    dropApprovals(undefined, "locked");
    dropAllTasks("locked");
  });
  useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs || (!liveTaskCount() && !attempts.size)) return;
    for (const [task, tab] of drivenTabs()) {
      if (s.tabs[tab]?.profileId === task.profileId) continue;
      undriveTab(task, tab);
      revokeTab(tab);
    }
    for (const attempt of attempts.values()) if (attempt.tabId && s.tabs[attempt.tabId]?.profileId !== attempt.task.profileId) revoke(attempt, "tab");
  });
}

let watching: { remove(): void } | null = null;

export function watchVault() {
  guard();
  watching ??= onLoginFormSeen((form) => {
    if ((!form.hasPassword && !form.hasOneTimeCode) || form.mainFrame === false) return;
    const origin = form.origin.toLowerCase();
    const task = taskDrivingTab(form.tab, origin);
    if (!task || task.busyTabs.has(form.tab)) return;
    const state = autoFill(task, form.tab, origin);
    const document = form.document === undefined ? null : String(form.document);
    if (state.stopped || (document !== null && state.documents.has(document))) return;
    if (Date.now() - state.lastSuccess < AUTO_RETRY_MS) return;
    task.busyTabs.add(form.tab);
    void signIn({ task, origin, account: null, tabId: form.tab, why: task.why, auto: true })
      .then(
        () => {
          state.failures = 0;
          state.lastSuccess = Date.now();
          if (document !== null) state.documents.add(document);
        },
        (error: unknown) => {
          const code = error instanceof VaultError ? error.code : "failed";
          if (FINAL_REFUSALS.has(code) || ++state.failures >= AUTO_FAILURES) state.stopped = true;
        },
      )
      .finally(() => task.busyTabs.delete(form.tab));
  });
}

export const liveAttempts = () => attempts.size;
