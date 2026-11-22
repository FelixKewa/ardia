import { listPasswords } from "../site/passwords";
import { originOfLogin } from "../site/savedPasswords";
import { currentManagerPlugin } from "../site/passwordManager";
import { currentTab } from "../browser/current";
import { withLivePage } from "../tabs/livePage";
import { onLoginFormSeen, vaultSignIn, type VaultSignIn } from "../../platform/vault";
import { consentToken } from "../telemetry/client";
import { noteVaultFill, noteVaultRefusal, noteVaultTiming, type VaultRefusal } from "../telemetry/vaultCounts";
import { recordVaultEvent } from "./activity";
import { programLabel } from "./programs";
import { driveTab, taskDrivingTab, type VaultTask } from "./tasks";

export class VaultError extends Error {
  readonly code: VaultRefusal;

  constructor(code: VaultRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

const AUTO_RETRY_MS = 30_000;

const STATUS_CODES: Partial<Record<VaultSignIn["status"], VaultRefusal>> = {
  still_on_login: "needs_human",
  needs_human: "needs_human",
  automation_attached: "denied",
  no_form: "no_form",
  no_login: "no_login",
  needs_passkey: "needs_passkey",
  cross_origin: "not_granted",
  failed: "failed",
};

const STATUS_MESSAGES: Partial<Record<VaultSignIn["status"], string>> = {
  needs_human: "The site wants a step only a person can do (a code sent by text, a CAPTCHA).",
  automation_attached: "Ardia won't sign in while a DevTools client is attached to the sign-in page.",
  still_on_login: "Ardia filled the saved login, but the site still shows its sign-in page: it may want a code sent by text, a CAPTCHA or another step only a person can do.",
  no_form: "Ardia didn't find a sign-in form for the saved login on that page.",
  no_login: "Ardia's password store has no saved login for that site and account.",
  needs_passkey: "That site signs in with a passkey, which only the person at the Mac can use.",
  cross_origin: "The sign-in form belongs to another site than the one granted.",
  failed: "The sign-in didn't finish.",
};

export function pluginRefusal(profileId: string): VaultError | null {
  const plugin = currentManagerPlugin(profileId);
  return plugin ? new VaultError("password_manager_plugin", `This profile's passwords are kept by ${plugin.title}; Ardia's own password store isn't used, and its plugin doesn't sign agents in.`) : null;
}

export async function cacheLogins(task: VaultTask) {
  const saved = await listPasswords(task.engineProfile);
  task.logins.clear();
  for (const login of saved) {
    const origin = originOfLogin(login.origin).toLowerCase();
    if (!task.origins.has(origin)) continue;
    const names = task.logins.get(origin) ?? [];
    if (!names.includes(login.username)) task.logins.set(origin, [...names, login.username]);
  }
}

async function usernameFor(task: VaultTask, origin: string, account: string | null): Promise<string> {
  if (!task.logins.has(origin)) await cacheLogins(task);
  const names = task.logins.get(origin) ?? [];
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

type Attempt = { task: VaultTask; origin: string; account: string | null; tabId: string | null; why: string; auto: boolean; startedAt?: number };

export async function signIn({ task, origin, account, tabId, why, auto, startedAt = Date.now() }: Attempt) {
  const consent = consentToken();
  const base = { profile: task.profileId, site: origin, program: programLabel(task.program), signer: task.program.signer, task: task.id.slice(0, 8), via: auto ? "auto" : "login", reason: why };
  let username: string | null = account;
  try {
    const refused = pluginRefusal(task.profileId);
    if (refused) throw refused;
    if (!task.origins.has(origin)) throw new VaultError("not_granted", "This task wasn't granted that site.");
    username = await usernameFor(task, origin, account);
    if (!task.serving() || task.expiresAt <= Date.now()) throw new VaultError("task_expired", "The task ended before Ardia signed in.");
    const result = await vaultSignIn(task.engineProfile, signInUrl(origin, tabId), origin, username);
    const code = STATUS_CODES[result.status];
    if (code) throw new VaultError(code, STATUS_MESSAGES[result.status] ?? "The sign-in didn't finish.");
    if (tabId) {
      driveTab(task, tabId);
      void withLivePage(tabId, (page) => page.reload(), task.serving).catch(() => false);
    }
    const ms = result.totalMs ?? result.appMs;
    noteVaultFill(auto, result.usedCode, consent);
    noteVaultTiming(auto ? "autofill" : "login", ms, consent);
    noteVaultTiming("ready", result.readyMs, consent);
    noteVaultTiming("fill", result.fillMs, consent);
    recordVaultEvent({ ...base, time: Date.now(), kind: "fill", account: username, outcome: result.status, ms });
    return { status: result.status, ms, readyMs: result.readyMs ?? null, fillMs: result.fillMs ?? null, usedCode: result.usedCode, appMs: Date.now() - startedAt };
  } catch (error) {
    const refusal = error instanceof VaultError ? error : new VaultError("failed", error instanceof Error ? error.message : String(error));
    noteVaultRefusal(refusal.code, consent);
    recordVaultEvent({ ...base, time: Date.now(), kind: "refusal", account: username, outcome: refusal.code });
    throw refusal;
  }
}

let watching: { remove(): void } | null = null;

export function watchLoginForms() {
  watching ??= onLoginFormSeen((form) => {
    if ((!form.hasPassword && !form.hasOneTimeCode) || form.mainFrame === false) return;
    const origin = form.origin.toLowerCase();
    const task = taskDrivingTab(form.tab, origin);
    if (!task) return;
    const key = `${form.tab}\n${origin}`;
    const last = task.autoTried.get(key);
    if (last !== undefined && (last < 0 || Date.now() - last < AUTO_RETRY_MS)) return;
    task.autoTried.set(key, Date.now());
    void signIn({ task, origin, account: null, tabId: form.tab, why: task.why, auto: true }).catch(() => task.autoTried.set(key, -1));
  });
}
