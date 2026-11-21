import assert from "node:assert/strict";
import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { js, pause } from "../lib/util.mjs";

const TAB = "main-tab-0";
const PAGE_SHOWN = "((status) => !!status && status.acked === status.sequence && (status.sent?.pages.length ?? 0) > 0)(ardiaLinux.inputRegions()?.status())";
const REGION = '[data-testid="ardia-auto-hide-toolbar"]';
const TRIGGERS = { hover: "peek", scroll: "shown", click: "shown" };

export default {
  id: "F31",
  issue: 3285,
  title: "Opening and folding the hidden toolbar keeps the page drawn under it",
  deadline: 180000,
  async run(t) {
    const url = t.fixtures.url.page(1, "toolbar-expand");
    const { app, shell } = await startBrowser(t, { session: sessionSeed({ windows: [{ id: "main", urls: [url] }] }) });
    await shell.state(`s.activate(${js(TAB)}); s.setFocusedWindow(windowId); s.updateSettings({ hideToolbarWhileScrolling: true }); return true;`);
    await app.pageLoaded(url);
    await shell.waitState(`return s.settings.hideToolbarWhileScrolling === true;`, { label: "Hide toolbar while scrolling on" });
    const collapse = async () => {
      await shell.eval(`(() => { const t = ardiaLinux.toolbar; t.setState({ scrolledDown: { ...t.getState().scrolledDown, ${js(TAB)}: true }, peek: {} }); return true; })()`);
      await pause(900);
      await shell.waitFor(PAGE_SHOWN, { label: "the page shown under the collapsed toolbar" });
    };
    const strip = async () => {
      const rect = await shell.eval(`(() => { const r = document.querySelector(${js(REGION)})?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + 10 }; })()`);
      assert.ok(rect, "the auto-hide toolbar must be on screen");
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    };
    const middle = async () => {
      const [width, height] = await shell.eval("[window.innerWidth, window.innerHeight]");
      return { x: Math.round(width / 2), y: Math.round(height / 2) };
    };
    const move = (point) => shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    const expand = {
      async hover() {
        await move(await strip());
        await pause(900);
      },
      async scroll() {
        await shell.eval(`(() => { const t = ardiaLinux.toolbar; const { [${js(TAB)}]: _, ...rest } = t.getState().scrolledDown; t.setState({ scrolledDown: rest }); return true; })()`);
        await pause(900);
      },
      async click() {
        const point = await strip();
        await move(point);
        await shell.session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await shell.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        await pause(900);
      },
    };
    for (const [trigger, opened] of Object.entries(TRIGGERS)) {
      await t.check(`the page is never hidden while the hidden toolbar opens by ${trigger} and folds away`, async () => {
        await move(await middle());
        await collapse();
        await shell.eval(`(() => {
          const record = globalThis.toolbarExpandRecord = { sent: [], regionRequests: 0, modes: [], stopped: false };
          const send = chrome.send.bind(chrome);
          chrome.send = (name, params) => {
            const call = name === "ardiaRequest" ? params?.[2] : undefined;
            if (call?.method === "tab.viewport") record.sent.push(call.args.visible);
            if (call?.method === "shell.inputRegions" && Array.isArray(call.args?.overlays)) record.regionRequests++;
            return send(name, params);
          };
          const sample = () => {
            if (record.stopped) return void (chrome.send = send);
            const t = ardiaLinux.toolbar.getState();
            const mode = !t.scrolledDown[${js(TAB)}] ? "shown" : t.peek[${js(TAB)}] ? "peek" : "collapsed";
            if (record.modes.at(-1) !== mode) record.modes.push(mode);
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          return true;
        })()`);
        for (let round = 0; round < 2; round++) {
          await expand[trigger]();
          await move(await middle());
          await collapse();
        }
        const record = await shell.eval("(() => { const { stopped, ...r } = globalThis.toolbarExpandRecord; globalThis.toolbarExpandRecord.stopped = true; return r; })()");
        await t.evidence(`viewports-${trigger}`, record);
        await t.screenshot(shell, `expanded-${trigger}`);
        assert.deepEqual(record.modes.filter((mode) => mode !== "collapsed"), [opened, opened], `the toolbar must open as ${opened} twice: ${js(record.modes)}`);
        assert.ok(record.regionRequests > 0, "the shell's host requests must be read by the recorder");
        assert.ok(!record.sent.includes(false), `the page was hidden while the toolbar opened or folded: ${js(record.sent)}`);
        await shell.waitFor(PAGE_SHOWN, { timeout: 5000, label: "the page still shown after the expansions" });
        return { viewports: record.sent.length, modes: record.modes };
      });
    }
  },
};
