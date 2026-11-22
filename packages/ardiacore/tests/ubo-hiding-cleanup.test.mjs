import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = readFileSync(new URL("../scripts/ubo.sh", import.meta.url), "utf8");
const cleanup = /^hiding_cleanup = r'''\n([\s\S]*?)^'''$/m.exec(script)?.[1];

function findChromium() {
  const candidates = [process.env.ARDIA_TEST_CHROMIUM];
  const playwright = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(playwright))
    for (const dir of readdirSync(playwright).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse())
      candidates.push(join(playwright, dir, "chrome-headless-shell-mac-arm64/chrome-headless-shell"), join(playwright, dir, "chrome-headless-shell-mac-x64/chrome-headless-shell"));
  candidates.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  );
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chromium = findChromium();
const NO_CHROMIUM = !chromium && "no Chromium to run the cleanup in (set ARDIA_TEST_CHROMIUM)";

const toBase64 = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function cleanInChromium(texts) {
  const dir = mkdtempSync(join(tmpdir(), "ubo-hiding-cleanup-"));
  try {
    const page = join(dir, "run.html");
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const µb = {};
${cleanup}
const decode = (b64) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
const encode = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const texts = decode("${toBase64(texts)}");
const results = texts.map((text) => {
  const first = µb.ardiaCleanHidingRules(text);
  return { ...first, again: µb.ardiaCleanHidingRules(first.text).text };
});
document.getElementById("out").textContent = encode(results);
</script>`,
    );
    const dom = execFileSync(
      chromium,
      ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", `file://${page}`],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const b64 = /<pre id="out">([A-Za-z0-9+/=]*)<\/pre>/.exec(dom)?.[1];
    assert.ok(b64, "the cleanup page produced no result");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MARKER = "*##+js(set-constant, ardiaFixtureMarker, 1)";

const FIXTURES = [
  {
    name: "a: a comment-wrapped rule as 0.2.47 stored it, carriage returns inside",
    text: `||ads.example^\nnews.test##.promo\n127.0.0.1##x/*\r${MARKER}\r*/`,
    want: `||ads.example^\nnews.test##.promo\n`,
    removed: 1,
  },
  {
    name: "a: an unclosed comment as 0.2.47 stored it",
    text: `news.test##.promo\n127.0.0.1##x/*\r${MARKER}`,
    want: `news.test##.promo\n`,
    removed: 1,
  },
  {
    name: "a: a forgiving :is() as 0.2.47 stored it",
    text: `127.0.0.1##x:is(\r${MARKER}\r)\nnews.test##.promo`,
    want: `\nnews.test##.promo`,
    removed: 1,
  },
  {
    name: "a: a continued attribute string as 0.2.47 stored it",
    text: `127.0.0.1##[a="\\\r${MARKER}\\\r"]\nnews.test##.promo`,
    want: `\nnews.test##.promo`,
    removed: 1,
  },
  {
    name: "a: in a file with CRLF line ends",
    text: `news.test##.promo\r\n127.0.0.1##x/*\r${MARKER}\r*/\r\nlater.test##.banner\r\n`,
    want: `news.test##.promo\r\n\r\nlater.test##.banner\r\n`,
    removed: 1,
  },
  {
    name: "b: the comment-wrapped rule after My filters was saved again with line feeds",
    text: `news.test##.promo\n127.0.0.1##x/*\n${MARKER}\n*/\nlater.test##.banner`,
    want: `news.test##.promo\n\n\n\nlater.test##.banner`,
    removed: 3,
  },
  {
    name: "b: the closer can carry more selector after it",
    text: `127.0.0.1##x/*\n${MARKER}\n*/ .y\nexample.test##+js(set-constant, userFlag, 1)`,
    want: `\n\n\nexample.test##+js(set-constant, userFlag, 1)`,
    removed: 3,
  },
  {
    name: "b: a comment closed and opened again",
    text: `127.0.0.1##x/*\n*/\n.y/*\n${MARKER}\n*/\nlater.test##.banner`,
    want: `\n\n\n\n\nlater.test##.banner`,
    removed: 5,
  },
  {
    name: "b: the forgiving :is() saved again with line feeds",
    text: `127.0.0.1##x:is(\n${MARKER}\n)\n||ads.example^`,
    want: `\n\n\n||ads.example^`,
    removed: 3,
  },
  {
    name: "b: the continued attribute string saved again with line feeds",
    text: `127.0.0.1##[a="\\\n${MARKER}\\\n"]\nlater.test##.banner`,
    want: `\n\n\nlater.test##.banner`,
    removed: 3,
  },
  {
    name: "b: an unclosed comment saved again: its own line goes, the lines it may have swallowed are commented out, plain hides stay",
    text: `127.0.0.1##x/*\n${MARKER}\nlater.test##.banner\n||ads.example^\n! a note`,
    want: `\n! ${MARKER}\nlater.test##.banner\n! ||ads.example^\n! a note`,
    removed: 1,
    quarantined: 2,
  },
  {
    name: "b: an unclosed comment only reaches 1,024 characters, the longest rule 0.2.47 saved",
    text: `127.0.0.1##x/*\n${MARKER}\nlater.test##.${"a".repeat(1000)}\nexample.test##+js(set-constant, userFlag, 1)`,
    want: `\n! ${MARKER}\nlater.test##.${"a".repeat(1000)}\nexample.test##+js(set-constant, userFlag, 1)`,
    removed: 1,
    quarantined: 1,
    suspects: 1,
  },
  ...[
    ["form feed", "\f"],
    ["vertical tab", "\v"],
    ["next line", "\u0085"],
    ["line separator", " "],
    ["paragraph separator", " "],
  ].map(([label, mark]) => ({
    name: `c: a closed comment holding a ${label}, which neither uBlock Origin nor its editor splits, stays one cosmetic rule`,
    text: `news.test##.promo\n127.0.0.1##x/*${mark}${MARKER}${mark}*/\nlater.test##.banner`,
    want: `news.test##.promo\n127.0.0.1##x/*${mark}${MARKER}${mark}*/\nlater.test##.banner`,
  })),
  {
    name: "d: a hand-written list with only carriage returns keeps every rule",
    text: "example.test##.banner\rtracker.test\r||ads.example^\rnews.test##.promo",
    want: "example.test##.banner\rtracker.test\r||ads.example^\rnews.test##.promo",
  },
  {
    name: "d: a carriage-return list whose second line is also a selector",
    text: "example.test##.banner\rdiv\rexample.test##+js(set-constant, userFlag, 1)",
    want: "example.test##.banner\rdiv\rexample.test##+js(set-constant, userFlag, 1)",
  },
  {
    name: "e: a user's own scriptlets and network rules stay, and next to a hide they are counted",
    text: "example.test##+js(set-constant, userFlag, 1)\nexample.test##.banner\n||ads.example^$script\n\nexample.test#@#+js()\nexample.test##div:has-text(Sponsored)",
    want: "example.test##+js(set-constant, userFlag, 1)\nexample.test##.banner\n||ads.example^$script\n\nexample.test#@#+js()\nexample.test##div:has-text(Sponsored)",
    suspects: 2,
  },
  {
    name: "f: Hide Element rules stay, including a test attribute holding a comment opener",
    text: 'news.test##.promo\nnews.test##section[data-testid="promo/*card"]\nnews.test##div.a > span:nth-of-type(2)\nnews.test###top\nexample.test##.ad /* sidebar */\n',
    want: 'news.test##.promo\nnews.test##section[data-testid="promo/*card"]\nnews.test##div.a > span:nth-of-type(2)\nnews.test###top\nexample.test##.ad /* sidebar */\n',
  },
];

test("Hide Element cleanup removes only what Hide Element could not have written", { skip: NO_CHROMIUM }, () => {
  assert.ok(cleanup, "ubo.sh has no hiding_cleanup block");
  const results = cleanInChromium(FIXTURES.map((f) => f.text));
  FIXTURES.forEach((fixture, i) => {
    const got = results[i];
    assert.equal(JSON.stringify(got.text), JSON.stringify(fixture.want), fixture.name);
    assert.equal(got.removed, fixture.removed ?? 0, `${fixture.name}: removed`);
    assert.equal(got.quarantined, fixture.quarantined ?? 0, `${fixture.name}: commented out`);
    if ("suspects" in fixture) assert.equal(got.suspects, fixture.suspects, `${fixture.name}: next to a hide`);
    assert.equal(JSON.stringify(got.again), JSON.stringify(got.text), `${fixture.name}: a second pass changes nothing`);
  });
});

test("the cleanup runs before the engines load and on every compile of My filters", () => {
  assert.match(script, /patch\("js\/start\.js",\n\s+"    \/\/ Prime the filtering engines before first use\.\\n",\n\s+"    await µb\.ardiaRemoveSplitHidingRules\(\);/);
  assert.match(script, /rawText = µb\.ardiaCleanHidingRules\(rawText\)\.text;/);
  assert.match(script, /^UBO_PATCH="29"$/m);
  assert.match(script, /compiledMagic: 173,/);
  assert.match(script, /selfieMagic: 173,/);
  assert.match(script, /selfie\/staticArdia2/);
});
