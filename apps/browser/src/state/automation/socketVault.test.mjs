import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { useVaultApproval, answerApproval } = await import("../vault/approval.ts");
const { flushVaultActivity, useVaultActivity } = await import("../vault/activity.ts");
const { setLogShowsReasons } = await import("../vault/prefs.ts");
const { engineProfile } = await import("../browser/model.ts");
const { saveVerificationSecret } = await import("../site/vaultCodes.ts");
const { accessProblem, methodSpec, methodsCatalog } = await import("./socketCatalog.ts");
const { takeVaultCounts } = await import("../telemetry/vaultCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { emitEvent } = await import("../../test-native/ardiacore.ts");
setConsentPeriod(true, "socket-vault-test");

const APP = { pid: 41, path: "/Applications/Agent.app/Contents/MacOS/Agent", name: "Agent", identifier: "com.example.agent", teamId: "TEAM123456", signer: "Developer ID Application: Example (TEAM123456)", signed: true, valid: true, adhoc: false, platform: false, lookupMs: 1 };
const NODE = { pid: 42, path: "/opt/homebrew/bin/node", name: "node", signed: false, valid: true, adhoc: true, platform: false, lookupMs: 1 };

const login = (origin, username, password = "hunter2") => [`${origin}\n${username}`, { origin, url: origin, username, password, created: 1 }];

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

async function approved(started, answer = "allow") {
  for (let i = 0; i < 200 && !useVaultApproval.getState().request; i++) await tick();
  const request = useVaultApproval.getState().request;
  assert.ok(request, "the approval sheet is up");
  answerApproval(request.id, answer);
  return { request, reply: await started };
}

beforeEach(() => {
  stub.vaultFake.signIns.length = 0;
  stub.vaultFake.signInResult = { status: "signed_in", readyMs: 4, fillMs: 3, totalMs: 9 };
  stub.vaultFake.authenticate = { granted: true, how: "granted", ms: 1 };
  stub.vaultFake.locked = false;
  stub.passwordStores.set(null, new Map([login("https://one.example", "me"), login("https://two.example", "a"), login("https://two.example", "b")]));
});

after(() => S().updateSettings({ cliControl: false }));

test("vault methods are listed with schemas and refused to plugin sessions", async () => {
  await freshWindow();
  const names = methodsCatalog().map((m) => m.name);
  for (const name of ["vault.taskStart", "vault.taskEnd", "vault.login", "vault.log", "vault.status"]) {
    assert.ok(names.includes(name), name);
    assert.equal(accessProblem("plugin", methodSpec(name))?.code, "refused");
  }
});

test("a task starts only after the person allows it on Ardia's sheet and Touch ID", async () => {
  await freshWindow();
  stub.controlSocket.peers[701] = APP;
  const { call, ok } = socketClient(701);
  assert.equal((await call("vault.taskStart", { sites: ["http://one.example"] })).error.code, "bad_request");
  takeVaultCounts();

  const denied = await approved(call("vault.taskStart", { sites: ["one.example"], why: "book a table" }), "deny");
  assert.equal(denied.reply.error.code, "denied");
  assert.equal(denied.request.program.name, "Agent");
  assert.equal(denied.request.mayAlways, true);
  assert.deepEqual(denied.request.sites, ["https://one.example"]);
  assert.equal(denied.request.why, "book a table");
  assert.equal(takeVaultCounts().vault_refusals_denied, 1);

  stub.vaultFake.authenticate = { granted: false, how: "cancelled", ms: 1 };
  assert.equal((await approved(call("vault.taskStart", { sites: ["one.example"] }))).reply.error.code, "denied");
  stub.vaultFake.authenticate = { granted: true, how: "granted", ms: 1 };

  const { reply } = await approved(call("vault.taskStart", { sites: ["https://One.example/login", "two.example"], why: "check orders" }));
  const task = reply.result;
  assert.match(task.task, /^[0-9a-f]{32}$/);
  assert.deepEqual(task.sites, ["https://one.example", "https://two.example"]);
  assert.equal(task.via, "sheet");
  assert.ok(task.expiresAt > Date.now());
  assert.equal(takeVaultCounts().vault_grants_sheet, 1);

  const signedIn = await ok("vault.login", { task: task.task, site: "one.example" });
  assert.equal(signedIn.status, "signed_in");
  assert.equal(JSON.stringify(signedIn).includes("hunter2"), false);
  assert.deepEqual(stub.vaultFake.signIns.at(-1), { profile: stub.vaultFake.signIns.at(-1).profile, url: "https://one.example/", origin: "https://one.example", username: "me", code: false });

  assert.equal((await call("vault.login", { task: task.task, site: "three.example" })).error.code, "not_granted");
  assert.equal((await call("vault.login", { task: task.task, site: "two.example" })).error.code, "bad_request");
  assert.equal((await ok("vault.login", { task: task.task, site: "two.example", account: "b" })).status, "signed_in");
  assert.equal((await call("vault.login", { task: task.task, site: "two.example", account: "zed" })).error.code, "no_login");

  stub.vaultFake.signInResult = { status: "still_on_login" };
  assert.equal((await call("vault.login", { task: task.task, site: "one.example" })).error.code, "needs_human");
  stub.vaultFake.signInResult = { status: "needs_passkey" };
  assert.equal((await call("vault.login", { task: task.task, site: "one.example" })).error.code, "needs_passkey");

  const other = socketClient(702);
  assert.equal((await other.call("vault.login", { task: task.task, site: "one.example" })).error.code, "denied");

  const status = await ok("vault.status");
  assert.equal(status.program.name, "Agent");
  assert.deepEqual(status.tasks.map((t) => t.task), [task.task]);

  await ok("vault.taskEnd", { task: task.task });
  assert.equal((await call("vault.login", { task: task.task, site: "one.example" })).error.code, "task_expired");
  const counts = takeVaultCounts();
  assert.equal(counts.vault_fills, 2);
  assert.equal(counts.vault_refusals_needs_human, 1);
  assert.equal(counts.vault_refusals_task_expired, 1);
  assert.ok(counts.vault_login_ms_count >= 2);
});

test("a task dies with its connection", async () => {
  await freshWindow();
  stub.controlSocket.peers[703] = APP;
  const { call } = socketClient(703);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  stub.emitControlClose(703);
  await settle();
  const again = socketClient(703);
  assert.equal((await again.call("vault.login", { task: reply.result.task, site: "one.example" })).error.code, "task_expired");
});

test("always allow is kept for a signed app, never for an interpreter or the ardia command", async () => {
  await freshWindow();
  stub.vaultFake.always = [];
  stub.controlSocket.peers[704] = APP;
  const app = socketClient(704);
  await approved(app.call("vault.taskStart", { sites: ["one.example"] }), "always");
  assert.equal(stub.vaultFake.always.length, 1);
  const quiet = await app.call("vault.taskStart", { sites: ["one.example"] });
  assert.equal(quiet.result.via, "always");
  assert.equal(useVaultApproval.getState().request, null);

  stub.controlSocket.peers[705] = NODE;
  const node = socketClient(705);
  const { request, reply } = await approved(node.call("vault.taskStart", { sites: ["one.example"] }), "always");
  assert.equal(request.mayAlways, false);
  assert.equal(request.program.kind, "interpreter");
  assert.equal(reply.result.via, "sheet");
  assert.equal(stub.vaultFake.always.length, 1);
});

test("a locked screen refuses at once instead of waiting for a sheet nobody sees", async () => {
  await freshWindow();
  stub.controlSocket.peers[706] = NODE;
  stub.vaultFake.locked = true;
  assert.equal((await socketClient(706).call("vault.taskStart", { sites: ["one.example"] })).error.code, "locked");
  assert.equal(useVaultApproval.getState().request, null);
});

test("a sign-in form in a tab the task drives fills on Chrome's event, once", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[707] = NODE;
  const { call } = socketClient(707);
  await approved(call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
  const before = stub.vaultFake.signIns.length;
  emitEvent("vault.loginFormSeen", { tab, origin: "https://one.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, at: 1 });
  emitEvent("vault.loginFormSeen", { tab, origin: "https://one.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, at: 2 });
  emitEvent("vault.loginFormSeen", { tab, origin: "https://elsewhere.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, at: 3 });
  await settle();
  assert.equal(stub.vaultFake.signIns.length, before + 1);
  assert.equal(stub.vaultFake.signIns.at(-1).url, "https://one.example/login");
  assert.equal(takeVaultCounts().vault_autofills, 1);
});

test("a kept verification code goes with the sign-in, and the log hides reasons unless the person shows them", async () => {
  await freshWindow();
  stub.controlSocket.peers[708] = NODE;
  const { call, ok } = socketClient(708);
  const profile = engineProfile(S(), S().settings.defaultProfileId);
  assert.equal(await saveVerificationSecret(profile, "https://one.example/", "me", "otpauth://totp/One:me?secret=JBSWY3DPEHPK3PXP"), true);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"], why: "pay the invoice" }));
  const signedIn = await ok("vault.login", { task: reply.result.task, site: "one.example" });
  assert.equal(signedIn.usedCode, true);
  assert.equal(stub.vaultFake.signIns.at(-1).code, true);

  const log = await ok("vault.log", { limit: 5 });
  assert.ok(log.length >= 2);
  assert.ok(log.every((e) => !("reason" in e)));
  assert.ok(log.some((e) => e.kind === "fill" && e.site === "https://one.example" && e.account === "me"));
  setLogShowsReasons(true);
  assert.ok((await ok("vault.log", { limit: 5 })).some((e) => e.reason === "pay the invoice"));
  setLogShowsReasons(false);
  assert.ok(useVaultActivity.getState().events.some((e) => e.reason === "pay the invoice"));
  flushVaultActivity();
  await settle();
  assert.ok(stub.vaultFake.log.length > 0, "the log reached the native store in a batch");
});

test("a profile whose passwords a plugin keeps refuses agent sign-ins, naming the plugin", async () => {
  const { readFileSync } = await import("node:fs");
  const { startPlugins } = await import("../plugins/start.ts");
  const lifecycle = await import("../plugins/lifecycle.ts");
  const { usePlugins } = await import("../plugins/store.ts");
  const { choosePasswordManager } = await import("../site/passwordManager.ts");
  const { pluginChoice } = await import("../site/passwordManagerChoice.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  await freshWindow();
  const profile = S().settings.defaultProfileId;
  startPlugins();
  stub.pluginHost.folders = [{ name: "password-manager", status: "ok", text: readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8") }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(lifecycle.requestPluginConsent("password-manager"));
  assert.ok(lifecycle.enablePlugin("password-manager", usePlugins.getState().consent.hash));
  await settle();
  choosePasswordManager(profile, pluginChoice("password-manager"));
  await settle();
  stub.controlSocket.peers[709] = NODE;
  const refused = await socketClient(709).call("vault.taskStart", { sites: ["one.example"] });
  assert.equal(refused.error.code, "password_manager_plugin");
  assert.match(refused.error.message, new RegExp(usePlugins.getState().listings["password-manager"].manifest.title));
  assert.equal(useVaultApproval.getState().request, null);
  choosePasswordManager(profile, "ardia");
  lifecycle.disablePlugin("password-manager");
  await settle();
});
