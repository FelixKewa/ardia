import assert from "node:assert/strict";
import { after, test } from "node:test";
import { nativeEvents } from "../../test-native/events.ts";

const channel = nativeEvents();
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaWebKit: { call: () => Promise.resolve("null"), addListener: channel.addListener },
};
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const { startWebKitCounts, takeEngineSwitchCounts } = await import("./engineSwitchCounts.ts");
after(() => client.setSharing(false, "settings"));

const counted = (name) => channel.emit("webKit", { name: "webKit.counted", data: { name, epoch: client.consentEpoch() } });

test("WebKit page counts from native reach the hourly counts once the app starts listening, never twice", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeEngineSwitchCounts();
  counted("contextMenu");
  assert.equal(takeEngineSwitchCounts().webkit_context_menus, 0, "importing the counts module listens to nothing");
  startWebKitCounts();
  startWebKitCounts();
  counted("contextMenu");
  counted("certificateInterstitial");
  const counts = takeEngineSwitchCounts();
  assert.equal(counts.webkit_context_menus, 1);
  assert.equal(counts.webkit_certificate_interstitials, 1);
});

test("extension counts exclude disabled sharing and callbacks from an earlier consent period", () => {
  const events = {
    extensionLoad: "webkit_extension_loads",
    extensionLoadFailure: "webkit_extension_load_failures",
    extensionGrant: "webkit_extension_grants",
    extensionAction: "webkit_extension_actions",
    extensionUnload: "webkit_extension_unloads",
    extensionSharedApproval: "webkit_extension_shared_approvals",
    extensionAllWebsitesLoad: "webkit_extension_all_websites_loads",
  };
  client.setSharing(true, "settings");
  startWebKitCounts();
  const stale = client.consentEpoch();
  client.setSharing(false, "settings");
  for (const name of Object.keys(events)) counted(name);
  const excluded = takeEngineSwitchCounts();
  for (const field of Object.values(events)) assert.equal(excluded[field], 0);
  client.setSharing(true, "settings");
  for (const name of Object.keys(events)) {
    channel.emit("webKit", { name: "webKit.counted", data: { name, epoch: stale } });
    counted(name);
  }
  const counts = takeEngineSwitchCounts();
  for (const field of Object.values(events)) assert.equal(counts[field], 1);
});
