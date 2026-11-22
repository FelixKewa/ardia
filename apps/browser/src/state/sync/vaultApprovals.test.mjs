import assert from "node:assert/strict";
import { test } from "node:test";
const { Clock, emptyScope, syncScope, visible, vaultAnswerFor, vaultRequestOf, VAULT_ANSWER, VAULT_REQUEST } = await import("@ardia/sync");
const { askPhoneForVaultApproval, cancelPhoneVaultApproval, connectVaultApprovals, phonesInReach, vaultApprovalsAdapter, vaultApprovalsAsking } = await import("./vaultApprovals.ts");
const { takeVaultPhoneApprovalCounts } = await import("../telemetry/vaultPhoneApprovalCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "vault-approvals-test");

const MAC = "mac00000000000000000000000";
const PHONE = "phone0000000000000000000000";
const NONCE = "nonce-0123456789abcdef";
let ids = 0;
const nextId = () => `0f0e0d0c-0b0a-4908-8706-${String(++ids).padStart(12, "0")}`;

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${String(++this.counter).padStart(4, "0")}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        const here = [...this.files].filter(([, f]) => f.scope === scope);
        return { files: here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
      },
      remove: async () => {},
    };
  }
}

function device(folder, id, adapters) {
  const state = emptyScope();
  const clock = new Clock(id, null);
  return { state, sync: () => syncScope({ scope: "app", state, transport: folder.transport(), adapters: adapters(state), clock, device: id, now: Date.now }) };
}

async function setUp({ phoneSeenDaysAgo = 0 } = {}) {
  const folder = new Folder();
  const answers = new Map();
  let cycles = 0;
  const mac = device(folder, MAC, (state) => [
    { prefix: "dev:", extract: () => ({ values: new Map([[`dev:${MAC}`, { n: "MacBook Pro" }]]), ignore: (k) => k !== `dev:${MAC}` }), apply: () => true },
    vaultApprovalsAdapter(MAC, () => state),
  ]);
  const phone = device(folder, PHONE, () => [
    { prefix: "dev:", extract: () => ({ values: new Map([[`dev:${PHONE}`, { n: "iPhone", k: "phone", f: ["send"] }]]), ignore: (k) => k !== `dev:${PHONE}` }), apply: () => true },
    { prefix: "vault:", extract: () => ({ values: new Map(answers), ignore: (k) => !answers.has(k) }), apply: () => true },
  ]);
  await phone.sync();
  await mac.sync();
  if (phoneSeenDaysAgo) mac.state.seen[PHONE] = Date.now() - phoneSeenDaysAgo * 86_400_000;
  connectVaultApprovals({ deviceId: () => MAC, usable: () => true, app: () => mac.state, profileName: () => "Personal", cycleSoon: () => void cycles++ });
  const phoneAnswers = async (allow, always, change = {}) => {
    await phone.sync();
    const [key, value] = [...visible(phone.state, VAULT_REQUEST)][0];
    const request = vaultRequestOf(key, value);
    answers.set(`${VAULT_ANSWER}${request.id}`, { ...vaultAnswerFor(request, allow, always, PHONE, Date.now()), ...change });
    await phone.sync();
  };
  return { mac, phone, phoneAnswers, cycles: () => cycles };
}

const ask = (overrides = {}) => ({ id: nextId(), nonce: NONCE, profile: "profile-1", program: "node, unsigned", sites: ["https://github.com"], why: "deploy", alwaysOffered: true, expiresAt: Date.now() + 60_000, ...overrides });

test("with no phone in reach, or sync not running, the answer is null at once, and that's counted", async () => {
  takeVaultPhoneApprovalCounts();
  assert.equal(await askPhoneForVaultApproval(ask()), null);
  connectVaultApprovals(null);
  assert.equal(await askPhoneForVaultApproval(ask()), null);
  await setUp({ phoneSeenDaysAgo: 30 });
  assert.deepEqual(phonesInReach(undefined), []);
  assert.equal(await askPhoneForVaultApproval(ask()), null);
  assert.equal(takeVaultPhoneApprovalCounts().vault_phone_unreachable, 3);
  connectVaultApprovals(null);
});

test("the phone's Allow resolves the ask with its nonce, and the Mac then removes the request and the answer", async () => {
  takeVaultPhoneApprovalCounts();
  const { mac, phoneAnswers, cycles } = await setUp();
  const answer = askPhoneForVaultApproval(ask());
  assert.equal(vaultApprovalsAsking(), true);
  assert.equal(cycles(), 1);
  await mac.sync();
  await phoneAnswers(true, true);
  await mac.sync();
  assert.deepEqual(await answer, { allow: true, always: true, nonce: NONCE });
  assert.equal(vaultApprovalsAsking(), false);
  await mac.sync();
  assert.deepEqual([...visible(mac.state, "vault:").keys()], []);
  const counts = takeVaultPhoneApprovalCounts();
  assert.deepEqual([counts.vault_phone_asks, counts.vault_phone_allowed, counts.vault_phone_denied], [1, 1, 0]);
  connectVaultApprovals(null);
});

test("an answer for other sites or another nonce is not taken, and Mac-side cancel resolves null", async () => {
  const { mac, phoneAnswers } = await setUp();
  const request = ask();
  const answer = askPhoneForVaultApproval(request);
  await mac.sync();
  await phoneAnswers(true, false, { s: ["https://evil.example"] });
  await mac.sync();
  await phoneAnswers(true, false, { n: "another-nonce-00000000" });
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true);
  cancelPhoneVaultApproval(request.id);
  assert.equal(await answer, null);
  await mac.sync();
  assert.deepEqual([...visible(mac.state, VAULT_REQUEST).keys()], []);
  connectVaultApprovals(null);
});

test("an ask resolves null at its expiry, and malformed asks are refused at once", async () => {
  takeVaultPhoneApprovalCounts();
  await setUp();
  assert.equal(await askPhoneForVaultApproval(ask({ expiresAt: Date.now() + 30 })), null);
  assert.equal(await askPhoneForVaultApproval(ask({ sites: ["http://plain.example"] })), null);
  assert.equal(await askPhoneForVaultApproval(ask({ sites: ["https://a.example/path"] })), null);
  assert.equal(await askPhoneForVaultApproval(ask({ nonce: "short" })), null);
  assert.equal(await askPhoneForVaultApproval(ask({ id: "NOT AN ID" })), null);
  assert.equal(await askPhoneForVaultApproval(ask({ expiresAt: Date.now() - 1 })), null);
  const counts = takeVaultPhoneApprovalCounts();
  assert.deepEqual([counts.vault_phone_expired, counts.vault_phone_refused], [1, 5]);
  connectVaultApprovals(null);
});

test("an ask that doesn't offer Always Allow says so to the phone, and an answer claiming Always is not taken", async () => {
  const { mac, phone, phoneAnswers } = await setUp();
  const request = ask({ alwaysOffered: false });
  const answer = askPhoneForVaultApproval(request);
  await mac.sync();
  await phone.sync();
  assert.equal(vaultRequestOf(`${VAULT_REQUEST}${request.id}`, visible(phone.state, VAULT_REQUEST).get(`${VAULT_REQUEST}${request.id}`)).ao, false);
  await phoneAnswers(true, true, { al: true });
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true);
  await phoneAnswers(true, true);
  await mac.sync();
  assert.deepEqual(await answer, { allow: true, always: false, nonce: NONCE });
  connectVaultApprovals(null);
});
