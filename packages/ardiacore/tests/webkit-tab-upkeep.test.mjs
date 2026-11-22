import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../ios/${name}`, import.meta.url), "utf8");
const body = (text, start) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} is there`);
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  assert.fail(`${start} ends`);
};

test("a page notification closed before its permission answer arrives is never shown, and an evicted worker notification is closed", () => {
  const notifications = source("WebKitNotifications.swift");
  const received = body(notifications, "func received(_ data: [String: Any], from tab: WebKitTab, sender: WKSecurityOrigin)");
  assert.ok(received.includes("showing.insert(pageId)"));
  assert.ok(received.includes("closedBeforeShown.remove(pageId) != nil { return }"), "the late answer drops a show the page already closed");
  assert.ok(received.includes("if showing.contains(wireId) { closedBeforeShown.insert(wireId) }"));
  const worker = body(notifications, "fileprivate func workerShow(");
  const eviction = worker.slice(worker.indexOf("workerShown.count > 200"));
  assert.ok(eviction.slice(0, 400).includes("Self.emitClose(oldest.wireId"), "the shown notification goes when its record is evicted");
});

test("a suspend counts only once WebKit confirms it, a failed kill can be retried, and the old-snapshot sweep runs after writes", () => {
  const lifecycle = source("WebKitTab+Lifecycle.swift");
  const frozen = body(lifecycle, "private func applyFrozen()");
  assert.ok(frozen.indexOf("self.life.suspended = target") > frozen.indexOf("guard applied"), "suspended is set from WebKit's answer, not before the call");
  assert.ok(!/life\.suspended = life\.frozen/.test(frozen));
  assert.ok(body(lifecycle, "func lifecycleWatches(").includes("life.suspended = false"), "a new view starts unsuspended");
  const hang = body(lifecycle, "func resolveHang(terminate: Bool)");
  assert.ok(hang.indexOf("guard ended else") >= 0 && hang.indexOf("guard ended else") < hang.indexOf("life.unresponsive = false"), "the hang stays until the kill went through");
  const save = body(lifecycle, "static func saveNow(_ tab: WebKitTab)");
  assert.ok(save.includes("guard (try? data.write(to: file, options: .atomic)) != nil else { return }"));
  assert.ok(save.includes("pruneEvery"), "the 90-day sweep runs again while the app keeps running");
  assert.ok(!lifecycle.includes("pruned.insert(profile)"));
});

test("clearing a page's background colour restores WebKit's own, and a site-data read names the origins past its cap", () => {
  assert.ok(source("WebKitTab+PageTab.swift").includes("if pageBackgroundColor == nil { webView?.underPageBackgroundColor = newValue }"));
  assert.ok(source("WebKitTab.swift").includes("webView?.underPageBackgroundColor = pageBackgroundColor ?? life.contentsBackgroundColor"));
  const module = body(source("WebKitModule.swift"), '"readSiteData": { args, reply in');
  assert.ok(module.includes('read["skippedOrigins"]'));
});
