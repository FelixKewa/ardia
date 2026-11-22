import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHROMIUM_MISSING, launchChromium } from "../../../scripts/lib/test-chromium.mjs";

const pageScript = readFileSync(new URL("../ios/page_script.js", import.meta.url), "utf8");

const GESTURE_KINDS = ["newTabLink", "peek", "linkDrop", "displayMedia", "verificationCode"];

const FIXTURE = `<!doctype html><body style="margin:0">
<a id="away" href="https://elsewhere.test/landing" target="_blank" style="position:absolute;left:0;top:0;width:300px;height:60px;display:block">away</a>
<a id="drag" href="https://elsewhere.test/dragged" style="position:absolute;left:0;top:100px;width:300px;height:60px;display:block">drag</a>
</body>`;

async function openFixture(browser) {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await context.addInitScript(`window.__ardiaPosts = []; window.__ardiaReceive = (${pageScript})((kind, json) => window.__ardiaPosts.push([kind, json]));`);
  await context.route("https://page.test/**", (route) => route.fulfill({ contentType: "text/html", body: FIXTURE }));
  await context.route("https://elsewhere.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>elsewhere</p>" }));
  const page = await context.newPage();
  await page.goto("https://page.test/");
  const cdp = await context.newCDPSession(page);
  const run = async (fn) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression: `(async () => { const v = await (${fn})(); try { return JSON.stringify(v ?? null); } catch { return "null"; } })()`, userGesture: false, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return JSON.parse(result.value);
  };
  await run(() => window.__ardiaReceive?.("config", JSON.stringify({ peek: "alt", split: "altShift", peekOtherSites: true })));
  return { page, run, activated: () => run(() => navigator.userActivation.hasBeenActive) };
}

const posts = (run) => run(() => window.__ardiaPosts.splice(0));
const gestures = async (run) => (await posts(run)).filter(([kind]) => GESTURE_KINDS.includes(kind)).map(([kind, json]) => `${kind} ${json}`);
const settle = (page) => page.waitForTimeout(80);

const TRICKS = {
  "a dispatched click on a new-tab link": () => document.getElementById("away").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })),
  "a scripted click() without user activation": () => document.getElementById("away").click(),
  "window.open without user activation": () => window.open("https://elsewhere.test/opened"),
  "a dispatched Alt-click, Peek's modifier": () =>
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) =>
      document.getElementById("away").dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, altKey: true, clientX: 20, clientY: 20 })),
    ),
  "a dispatched drag of a link out of the page": () => {
    const link = document.getElementById("drag");
    const data = new DataTransfer();
    data.setData("text/uri-list", link.href);
    for (const type of ["dragstart", "drag", "dragend"]) link.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, screenX: type === "dragend" ? 900 : 10, screenY: 110 }));
  },
  "the custom event the old Hide Element bridge listened for": () => {
    document.dispatchEvent(new CustomEvent("ardia-hide-element", { detail: { selector: "#away", point: [10, 10] }, bubbles: true }));
    window.dispatchEvent(new CustomEvent("ardia-hide-element", { detail: { selector: "#away" } }));
    document.getElementById("away").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  },
  "a planted picker object and a dispatched Enter": () => {
    window[Symbol.for("ardia.elementPicker")] = { start: () => ({ selector: "#away" }), ensure() {} };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  },
  "getDisplayMedia without user activation": () => navigator.mediaDevices?.getDisplayMedia?.({ video: true }).catch(() => {}),
};

test("the page script sends no gesture-gated message for input the page made up", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run, activated } = await openFixture(browser);
  await posts(run);
  for (const [name, trick] of Object.entries(TRICKS)) {
    await run(trick);
    await settle(page);
    assert.deepEqual(await gestures(run), [], name);
  }
  assert.equal(await activated(), false, "nothing in the harness gave the page a user gesture");
  assert.deepEqual(
    (await posts(run)).filter(([kind]) => /hide/i.test(kind)),
    [],
    "no page message starts or confirms Hide Element",
  );
});

test("the same harness sees a real click on a new-tab link, so the silence above means something", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run } = await openFixture(browser);
  await posts(run);
  await page.mouse.click(20, 20);
  await settle(page);
  assert.deepEqual(await gestures(run), ['newTabLink {"url":"https://elsewhere.test/landing"}']);
});

test("A1: after a real right-click, the page's own Hide Element event sends nothing", { skip: CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const { page, run } = await openFixture(browser);
  await posts(run);
  await page.mouse.click(20, 130, { button: "right" });
  await page.keyboard.press("Escape");
  await run(TRICKS["the custom event the old Hide Element bridge listened for"]);
  await settle(page);
  assert.deepEqual((await posts(run)).filter(([kind]) => /hide/i.test(kind)), []);
});
