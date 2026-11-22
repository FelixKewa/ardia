import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { actionWords, blockingWords, dismissWords } from "./sharedWords.ts";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const literal = (word: string) => new RegExp(`(["'\`>])${word}(["'\`<])`);

test("Open has one owner: native and drawn Archive and Spaces and the open-link prompt read actionWords.open", () => {
  assert.equal(actionWords.open, "Open");
  for (const path of ["components/tabs/ExpoArchive.tsx", "components/tabs/ArchiveView.tsx", "components/sync/ExpoSpaces.tsx", "components/sync/SpacesView.tsx", "state/page/pagePrompts.ts"]) {
    const text = source(path);
    assert.doesNotMatch(text, literal("Open"), path);
    assert.match(text, /actionWords\.open/, path);
  }
});

test("Done has one owner: Settings, Archive, Library and Spaces take it from the shared Done control", () => {
  assert.equal(dismissWords.done, "Done");
  assert.doesNotMatch(source("components/settings/ExpoSettingsDone.tsx"), literal("Done"));
  assert.match(source("components/settings/ExpoSettingsDone.tsx"), /dismissWords\.done/);
  for (const path of ["components/tabs/ExpoArchive.tsx", "components/library/ExpoLibrary.tsx", "components/sync/ExpoSpaces.tsx"]) {
    const text = source(path);
    assert.doesNotMatch(text, /label=\{dismissWords\.done\}/, path);
    assert.match(text, /Done(ToolbarItem|Button)/, path);
  }
});

test("the blocking label has one owner, which the Trusted Sites explanation reads", () => {
  assert.equal(blockingWords.blockAdsAndTrackers, "Block Ads and Trackers");
  const blocking = source("components/settings/ExpoBlockingPages.tsx");
  assert.doesNotMatch(blocking, literal("Block Ads and Trackers"));
  assert.match(blocking, /blockingWords\.blockAdsAndTrackers/);
});
