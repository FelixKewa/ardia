import { readDocument, writeDocument } from "../../platform/documents";
import { chromeCtrlTabMru } from "../../platform/profiles";
import { isFields } from "../../lib/decode";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { useBrowser } from "../browser/store";
import { noteCtrlTabFollowedChrome } from "../telemetry/settingsPickerCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { ctrlTabChoice, setCtrlTab } from "./commandShortcuts";
import type { CtrlTabChoice, CtrlTabPreset } from "./ctrlTabKeys";

const DOC = "chrome-ctrl-tab.json";
const VERSION = 1;
const FIRST_LOOK_MS = 3000;
const POLL_MS = 2000;
const LAST_LOOK_AFTER_MS = 15000;
const CHROME_SETTINGS = /^(chrome|ardia):\/\/settings(\/|$|\?|#)/;

export type ChromeCtrlTab = Record<string, boolean>;

export function presetFollowingChrome(seen: ChromeCtrlTab, now: ChromeCtrlTab, choice: CtrlTabChoice): CtrlTabPreset | null {
  let wanted: CtrlTabPreset | null = null;
  for (const [profile, mru] of Object.entries(now)) {
    const before = seen[profile];
    if (before === undefined ? mru && choice === "step" : mru !== before) wanted = mru ? "switcher" : "step";
  }
  return wanted && wanted !== choice ? wanted : null;
}

function readSeen(): ChromeCtrlTab {
  let doc: ReturnType<typeof parseSaved> = null;
  try {
    doc = parseSaved(readDocument(DOC), VERSION);
  } catch {
    doc = null;
  }
  const seen: ChromeCtrlTab = {};
  if (doc && isFields(doc.profiles)) for (const [profile, mru] of Object.entries(doc.profiles)) if (typeof mru === "boolean") seen[profile] = mru;
  return seen;
}

function saveSeen(seen: ChromeCtrlTab) {
  try {
    writeDocument(DOC, versionedJson({ profiles: seen }, VERSION));
  } catch {
    return;
  }
}

let looking = false;
let unsupported = false;

async function look(consent: ConsentToken | null) {
  if (looking || unsupported) return;
  looking = true;
  try {
    const now = await chromeCtrlTabMru();
    if (!now) {
      unsupported = true;
      return;
    }
    const seen = readSeen();
    const preset = presetFollowingChrome(seen, now, ctrlTabChoice());
    if (preset && setCtrlTab(preset)) noteCtrlTabFollowedChrome(preset, consent);
    const merged = { ...seen, ...now };
    if (Object.entries(now).some(([profile, mru]) => seen[profile] !== mru)) saveSeen(merged);
  } catch {
    unsupported = true;
  } finally {
    looking = false;
  }
}

const showsChromeSettings = (tabs: ReturnType<typeof useBrowser.getState>["tabs"]) => Object.values(tabs).some((tab) => CHROME_SETTINGS.test(tab.url ?? ""));

let started = false;

export function followChromeCtrlTab() {
  if (started) return;
  started = true;
  const consent = consentToken();
  let poll: ReturnType<typeof setInterval> | undefined;
  let lastLook: ReturnType<typeof setTimeout> | undefined;
  const watch = (shown: boolean) => {
    if (unsupported) return;
    if (shown && !poll) {
      clearTimeout(lastLook);
      poll = setInterval(() => void look(consent), POLL_MS);
    } else if (!shown && poll) {
      clearInterval(poll);
      poll = undefined;
      lastLook = setTimeout(() => void look(consent), LAST_LOOK_AFTER_MS);
    }
  };
  setTimeout(() => {
    void look(consent);
    watch(showsChromeSettings(useBrowser.getState().tabs));
  }, FIRST_LOOK_MS);
  useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs !== prev.tabs) watch(showsChromeSettings(s.tabs));
  });
}
