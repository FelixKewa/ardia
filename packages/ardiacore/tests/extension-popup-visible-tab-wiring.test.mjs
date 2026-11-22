import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("the popup remembers the page whose extension action opened it", () => {
  const view = read("engine/ardiacore/src/ardia/core/ac_extension_view.mm");
  const action = read("engine/ardiacore/src/ardia/core/ardiacore_tab_extensions.mm");
  assert.match(action, /kShowPopup:\s+ardiacore::RememberExtensionPopupSource\([\s\S]*?_contents\);/);
  assert.match(view, /PopupSources\(\)\[SourceKey\(browser, extension_id\)\] = source->GetWeakPtr\(\);/);
  assert.match(view, /kind == ExtensionViewKind::kPopup\s+\? TakePopupSource\(browser, extension->id\(\)\)/);
  assert.match(view, /g_ardia_extension_popup_tab = &PopupSourceFor;/);
});

test("tabs.query treats the popup's page as active without selecting it", () => {
  const patch = read("engine/patches/chromium-extension-popup-visible-tab.patch");
  assert.match(patch, /g_ardia_extension_popup_tab\(GetSenderWebContents\(\)\)/);
  assert.match(patch, /candidate_browser == active_tab_override_browser_[\s\S]*?web_contents == active_tab_override_/);
  assert.match(patch, /tab_object\.active = tab->GetContents\(\) == active_tab_override_/);
  assert.doesNotMatch(patch, /ActivateTabAt/);
});

test("the Chromium patch and the Peek acceptance check stay in the suite", () => {
  const series = read("engine/patches/series");
  const popup = series.indexOf("chromium chromium-extension-popup-visible-tab.patch");
  assert.ok(popup > series.indexOf("chromium chromium-hidden-window-current-window.patch"));
  assert.ok(popup < series.indexOf("chromium chromium-devtools-redock-display.patch"));
  assert.match(read("docs/engine-build.md"), /`chromium-extension-popup-visible-tab\.patch`/);
  assert.match(read("packages/ardiacore/scripts/acceptance.mjs"), /check\("extension-popup-peek-tab"/);
});
