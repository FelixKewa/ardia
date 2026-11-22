import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { HOSTILE_STRINGS, embedded } from "../../../../../scripts/security/hostile-inputs.mjs";
import { CHROMIUM_MISSING, launchChromium } from "../../../../../scripts/lib/test-chromium.mjs";
const { hidingFilter, parseHidingFilter, savablePickedSelector } = await import("./hiddenElements.ts");

const uboScript = readFileSync(new URL("../../../../../packages/ardiacore/scripts/ubo.sh", import.meta.url), "utf8");
const VERSION = /^UBO_VERSION="([^"]+)"/m.exec(uboScript)[1];
const SHA256 = /^UBO_SHA256="([0-9a-f]{64})"/m.exec(uboScript)[1];
const ZIP_NAME = `uBlock0_${VERSION}.chromium.zip`;
const cache = new URL(`../../../node_modules/.cache/ublock/${VERSION}/`, import.meta.url);
const NEEDED = ["js/static-filtering-parser.js", "js/arglist-parser.js", "js/jsonpath.js", "js/text-utils.js", "lib/csstree/css-tree.js"];

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function pinnedZip() {
  const vendored = new URL(`../../../../../packages/ardiacore/vendor/ubo/${ZIP_NAME}`, import.meta.url);
  for (const candidate of [vendored, new URL(ZIP_NAME, cache)]) if (existsSync(candidate) && sha256(candidate) === SHA256) return fileURLToPath(candidate);
  mkdirSync(cache, { recursive: true });
  const response = await fetch(`https://github.com/gorhill/uBlock/releases/download/${VERSION}/${ZIP_NAME}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`downloading uBlock Origin ${VERSION}: HTTP ${response.status}`);
  const target = new URL(ZIP_NAME, cache);
  const partial = new URL(`${ZIP_NAME}.${process.pid}`, cache);
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  if (sha256(partial) !== SHA256) {
    rmSync(partial, { force: true });
    throw new Error(`uBlock Origin ${VERSION} doesn't match the SHA-256 ubo.sh pins`);
  }
  renameSync(partial, target);
  return fileURLToPath(target);
}

async function loadParser() {
  const root = new URL(`unpacked/uBlock0.chromium/`, cache);
  if (!NEEDED.every((file) => existsSync(new URL(file, root)))) {
    const zip = await pinnedZip();
    const out = fileURLToPath(new URL("unpacked/", cache));
    mkdirSync(out, { recursive: true });
    execFileSync("unzip", ["-o", "-q", zip, ...NEEDED.map((file) => `uBlock0.chromium/${file}`), "-d", out], { stdio: "ignore" });
  }
  const parser = await import(pathToFileURL(fileURLToPath(new URL("js/static-filtering-parser.js", root))).href);
  const { LineIterator } = await import(pathToFileURL(fileURLToPath(new URL("js/text-utils.js", root))).href);
  return { sfp: parser, LineIterator };
}

let ublock = null;
let unavailable = false;
try {
  ublock = await loadParser();
} catch (error) {
  if (process.env.CI) throw error;
  unavailable = `the pinned uBlock Origin parser isn't available offline (${error.message})`;
}

function compiledRules(text) {
  const { sfp, LineIterator } = ublock;
  const parser = new sfp.AstFilterParser({ nativeCssHas: true, trustedSource: false });
  const lines = new LineIterator(sfp.utils.preparser.prune(text, ["chromium", "ublock"]));
  const rules = [];
  while (!lines.eot()) {
    let line = lines.next();
    while (line.endsWith(" \\")) {
      if (lines.peek(4) !== "    ") break;
      line = line.slice(0, -2).trim() + lines.next().trim();
    }
    parser.parse(line);
    if (!parser.isFilter()) continue;
    rules.push({
      line,
      error: parser.hasError(),
      network: parser.isNetworkFilter(),
      cosmetic: parser.isCosmeticFilter(),
      exception: parser.isException(),
      compiled: parser.isExtendedFilter() ? parser.result.compiled : undefined,
    });
  }
  return rules;
}

const appendUserFilters = (content, filters) => `${content.trim()}\n${filters.join("\n").trim()}`;

const USER_LIST = [
  "! Title: My filters",
  "||ads.example^",
  "news.test##.promo",
  "!#if env_firefox",
  "example.org##+js(set-constant, ardiaFixtureMarker, 1)",
  "!#endif",
  "example.net##div.banner \\",
  "    , aside.banner",
].join("\n");

const baseline = () => compiledRules(USER_LIST).map((r) => JSON.stringify(r));

function addedBy(filters) {
  const before = baseline();
  const after = compiledRules(appendUserFilters(USER_LIST, filters)).map((r) => JSON.stringify(r));
  for (const rule of before) {
    const at = after.indexOf(rule);
    assert.ok(at >= 0, `appending ${JSON.stringify(filters)} changed an existing rule: ${rule}`);
    after.splice(at, 1);
  }
  return after.map((r) => JSON.parse(r));
}

function onlyRule(filter, input) {
  const added = addedBy([filter]);
  const where = JSON.stringify(input).slice(0, 160);
  assert.equal(added.length, 1, `${where}: exactly one new line, got ${JSON.stringify(added)}`);
  const [rule] = added;
  assert.equal(rule.line, filter, `${where}: the new line is the one the app sent`);
  return { rule, where };
}

function assertNeverMoreThanCosmetic(filter, input) {
  const { rule, where } = onlyRule(filter, input);
  if (rule.error) return;
  assert.equal(rule.network, false, `${where}: not a network filter`);
  assert.equal(rule.cosmetic, true, `${where}: a cosmetic filter, not a scriptlet, HTML or header filter`);
  assert.equal(rule.exception, false, `${where}: not an exception`);
  assert.ok(!rule.compiled.startsWith("{"), `${where}: plain CSS, not a procedural or action filter: ${rule.compiled}`);
}

function assertOnePlainCosmeticRule(filter, input) {
  const { rule, where } = onlyRule(filter, input);
  assert.equal(rule.error, false, `${where}: uBlock accepts it`);
  assertNeverMoreThanCosmetic(filter, input);
}

const HOST = "ardia-fixture.test";

const PICKER_SHAPES = [
  "#fixture-banner",
  "div.ad-slot",
  "main > section:nth-of-type(2) > aside.promo",
  'section[data-testid="promo"]',
  'section[data-testid="promo/\\2a card"]',
  'a[data-qa="a\\9 b"]',
  "div.sc\\:x",
  "x-ad-box",
];

const UBLOCK_ONLY = [
  "div:style(display: none !important)",
  "div:remove()",
  "div:remove-attr(class)",
  "div:remove-class(ad)",
  "div:has-text(ardiaFixtureMarker)",
  "div:not(:has-text(x))",
  "div:has(:has-text(x))",
  ":is(div):remove()",
  "div, span:has-text(x)",
  "div:matches-css(display: block)",
  "html:matches-path(/x) div",
  ":is(:has-text(x))",
  "div:is(:style(x))",
  "div:where(:remove())",
  "div:upward(2)",
  "div:xpath(//a)",
  "a:is(.x):watch-attr(y)",
  "div:others()",
  "div:min-text-length(3)",
  "div:-abp-has(span)",
  "div:-abp-contains(x)",
  "div:if(span)",
  "div:if-not(span)",
  "div:nth-ancestor(1)",
  "div:shadow(span)",
  "div:matches-media((min-width: 1px))",
  "div:matches-prop(x)",
  "div:matches-attr(x)",
  "div:contains(x)",
  "div::before",
  "div:has(span)",
];

function savedFilters() {
  const inputs = [...PICKER_SHAPES, ...UBLOCK_ONLY, ...HOSTILE_STRINGS.flatMap(({ value }) => [...embedded(value, "div", "p"), `[data-testid="${value}"]`, `section[data-testid="a${value}b"]`])];
  const saved = new Map();
  for (const selector of inputs)
    for (const candidate of [selector, savablePickedSelector(selector)]) {
      const filter = typeof candidate === "string" ? hidingFilter(HOST, candidate) : null;
      if (filter !== null) saved.set(filter, selector);
    }
  return saved;
}

test("nothing the picker can save compiles, under the pinned uBlock parser, to more than one plain cosmetic rule", { skip: unavailable }, () => {
  const saved = savedFilters();
  for (const [filter, input] of saved) assertNeverMoreThanCosmetic(filter, input);
  for (const selector of PICKER_SHAPES) assert.ok(hidingFilter(HOST, selector), `${selector}: an ordinary pick still saves`);
});

test("what the picker saves and the blocker's own CSS check takes is exactly one plain cosmetic rule", { skip: unavailable || CHROMIUM_MISSING, timeout: 30_000 }, async (t) => {
  const saved = savedFilters();
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const filters = [...saved.keys()];
  const takes = await page.evaluate((filters) => filters.map((f) => {
    try {
      document.createDocumentFragment().querySelector(f.slice(f.indexOf("##") + 2));
      return true;
    } catch {
      return false;
    }
  }), filters);
  let checked = 0;
  filters.forEach((filter, i) => {
    if (!takes[i]) return;
    checked++;
    assertOnePlainCosmeticRule(filter, saved.get(filter));
  });
  t.diagnostic(`${checked} of ${filters.length} saved filters pass the CSS check and compile as one plain rule`);
  assert.ok(checked >= PICKER_SHAPES.length);
});

test("uBlock-only selector syntax is never saved from a pick, even where a browser's querySelector would take it", { skip: unavailable }, () => {
  for (const selector of UBLOCK_ONLY) assert.equal(hidingFilter(HOST, selector), null, selector);
  assert.equal(hidingFilter(HOST, 'div[title="a:style(b)"]'), 'ardia-fixture.test##div[title="a:style(b)"]', "a colon inside a quoted value is data");
});

test("a batch of saved picks adds one plain cosmetic rule per pick and leaves the list's other rules as they were", { skip: unavailable }, () => {
  const batch = PICKER_SHAPES.map((selector) => hidingFilter(HOST, selector));
  const added = addedBy(batch);
  assert.equal(added.length, batch.length);
  for (const rule of added) assert.ok(rule.cosmetic && !rule.error && !rule.exception && !rule.compiled.startsWith("{"), JSON.stringify(rule));
});

test("the filters the Hidden Elements list reads back are the rules uBlock compiles as plain cosmetic rules", { skip: unavailable }, () => {
  for (const selector of PICKER_SHAPES) {
    const filter = hidingFilter(HOST, selector);
    assert.equal(parseHidingFilter(filter)?.selector, selector);
  }
});
