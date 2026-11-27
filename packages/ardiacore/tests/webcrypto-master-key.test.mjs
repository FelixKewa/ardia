import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import test from "node:test";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";
import { runSwiftTests } from "./swift-testing.mjs";

const packages = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(packages, path), "utf8");
const macSources = ["ardiacore", "import", "shaders", "shell", "sync"].flatMap((name) =>
  readdirSync(join(packages, name, "ios"), { recursive: true })
    .filter((file) => /\.(swift|mm|m)$/.test(file) && !/(^|\/)Tests\//.test(file))
    .map((file) => `${name}/ios/${file}`),
);
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const websiteDataStores = {
  "ardiacore/ios/WebKitStoreRemovals.swift": { made: 1, covered: 0 },
  "ardiacore/ios/WebKitStores.swift": { made: 3, covered: 4 },
  "shaders/ios/MeadowView.swift": { made: 1, covered: 1 },
  "shell/ios/PluginPageView.swift": { made: 1, covered: 1 },
};
const configurationsWithoutPages = { "shell/ios/PluginCore/PluginPageData.swift": 1 };

test("the WebCrypto key file, its keychain reads and its resolver fail closed", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ardia-webcrypto-inputs-"));
  const hostile = mkdtempSync(join(scratch, "hostile-"));
  const home = mkdtempSync(join(scratch, "home-"));
  try {
    const header = Buffer.concat([Buffer.from("ArdiaWCK"), Buffer.from([1])]);
    HOSTILE_VALUES.flatMap(({ value }) => {
      const raw = Buffer.from(typeof value === "string" ? value : inspect(value));
      return [raw, Buffer.concat([header, raw]), Buffer.concat([header, raw, Buffer.alloc(53)]).subarray(0, 53)];
    }).forEach((contents, index) => writeFileSync(join(hostile, `${index}`), contents));
    runSwiftTests(
      t,
      "webcrypto-master-key",
      ["../ios/AppKeychain.swift", "../ios/WebCryptoKeyFile.swift", "../ios/WebCryptoMasterKey.swift", "../ios/WebCryptoStoreKeys.swift", "../ios/LaunchKeychain.swift", "./webcrypto-master-key.test.swift"],
      { env: { ARDIA_HOSTILE_DIR: hostile, HOME: home, CFFIXED_USER_HOME: home } },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("every Mac web data store takes the key hook before a page can use it", () => {
  const made = /(?:WKWebsiteDataStore(?:\.init)?|\.init)\(forIdentifier:|\.nonPersistent\(\)|(?:WKWebsiteDataStore|[dD](?:ata|efaultWebsiteData)Store\s*=\s*)\.default\(\)|\[WKWebsiteDataStore (?:nonPersistentDataStore|defaultDataStore|dataStoreForIdentifier)/g;
  const covered = /WebCryptoStoreKeys\.cover\b/g;
  const found = {};
  for (const file of macSources.filter((name) => name !== "ardiacore/ios/WebCryptoStoreKeys.swift")) {
    const text = read(file);
    const stores = { made: count(text, made), covered: count(text, covered) };
    if (stores.made || stores.covered) found[file] = stores;
    const configurations = count(text, /WKWebViewConfiguration\(\)|\[WKWebViewConfiguration new\]|\[\[WKWebViewConfiguration alloc\]/g);
    assert.ok(count(text, /\.websiteDataStore\s*=(?!=)/g) >= configurations - (configurationsWithoutPages[file] ?? 0), `${file} leaves a web view on WebKit's default data store, which has no key hook`);
  }
  assert.deepEqual(found, websiteDataStores, "a website data store was added or removed: cover it with WebCryptoStoreKeys.cover, then update this list");
});

test("Safe Storage is read once at launch, before the engine starts", () => {
  const launch = read("ardiacore/ios/ArdiaHost+Launch.mm");
  const prepared = launch.indexOf("[ArdiaLaunchKeychain prepareWithDirectory:gDataDirectory mockKeychain:mockKeychain]");
  const engine = launch.indexOf("[ArdiaCoreEngine runWithArgc:");
  const gate = launch.indexOf("if (!ArdiaHost.allowsPersonalLaunch) return 78;");
  assert.ok(gate >= 0 && gate < prepared && prepared < engine);
  assert.equal(count(launch, /ArdiaLaunchKeychain prepareWithDirectory/g), 1);
  const queriers = macSources.filter((file) => /Ardia Safe Storage/.test(read(file)) && /SecItem(Add|Update|Delete)/.test(read(file)));
  assert.deepEqual(queriers.filter((file) => file.startsWith("ardiacore/")), []);
  assert.doesNotMatch(read("ardiacore/ios/AppKeychain.swift"), /SecItem(Add|Update|Delete)|SecKeychain/);
});
