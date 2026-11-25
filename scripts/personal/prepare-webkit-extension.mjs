import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const utf8Mark = Buffer.from([0xef, 0xbb, 0xbf]);
const maxBytes = 512 * 1024 * 1024;
const maxFiles = 50000;
const kimchiContentScript = "contentScripts/index.global.js";
const kimchiContentHash = "891ea6e2a765ed997fd6348aa0cd02a7a38469fe4e305bbca561a1df073716f6";
const kimchiSeekScript = "inject/netflix_seek.js";
const kimchiSeekHash = "3917264cd20d5e3919f0b2b2d216f3ff85aaceed09c30484d57cf6644599daed";

function replaceOnce(source, original, replacement, label) {
  if (source.split(original).length !== 2) throw new Error(`The known Kimchi ${label} was not found exactly once.`);
  return source.replace(original, replacement);
}

export function adaptKimchiDictionarySource(source) {
  const original = "(await e.blob()).stream().pipeThrough(new DecompressionStream(`gzip`))";
  const replacement = "(await e.blob()).stream().pipeThrough(new TransformStream({transform(chunk,controller){controller.enqueue(new Uint8Array(chunk).buffer)}})).pipeThrough(new DecompressionStream(`gzip`))";
  return replaceOnce(source, original, replacement, "dictionary decoder");
}

export function adaptKimchiNetflixSeekSource(source) {
  const original = "seekTo(e){let t=document.createElement(`script`);t.src=chrome.runtime.getURL(`inject/netflix_seek.js?`)+new URLSearchParams({t:(e/1e3).toString()}),t.onload=function(){this.remove()},(document.head||document.documentElement).appendChild(t)}";
  const replacement = "seekTo(e){if(!Number.isFinite(e)||e<0)return;let t=document.createElement(`script`);t.async=!1,t.setAttribute(`data-kimchi-seek-ms`,String(e)),t.src=chrome.runtime.getURL(`inject/netflix_seek.js`),t.onload=t.onerror=function(){this.remove()},(document.head||document.documentElement).appendChild(t)}";
  return replaceOnce(source, original, replacement, "Netflix seek sender");
}

export function adaptKimchiNetflixSeekHelper(source) {
  const original = 'const params = new URLSearchParams(document.currentScript.src.split("?")[1]);';
  const replacement = 'const rawTimeMs = document.currentScript?.getAttribute("data-kimchi-seek-ms");\n  if (rawTimeMs == null || rawTimeMs.trim() === "") return;\n  const timeMs = Number(rawTimeMs);\n  if (!Number.isFinite(timeMs) || timeMs < 0) return;';
  const result = replaceOnce(source, original, replacement, "Netflix seek parameter reader");
  return replaceOnce(result, 'player.seek(parseFloat(params.get("t")) * 1000);', "player.seek(timeMs);", "Netflix seek target");
}

function prepareKimchi(manifest, files, { kimchiDictionary, kimchiNetflixSeek }) {
  if (manifest.name !== "Kimchi Reader" || manifest.version !== "0.21.7") throw new Error("Compatibility preparation supports only the reviewed Kimchi Reader 0.21.7 package.");
  if (!manifest.content_scripts?.some((script) => Array.isArray(script.js) && script.js.includes(kimchiContentScript))) throw new Error("The expected Kimchi content script is not declared.");
  const data = files.get(kimchiContentScript);
  if (!data || createHash("sha256").update(data).digest("hex") !== kimchiContentHash) throw new Error("The Kimchi content script differs from the reviewed original. Use an unchanged official package.");
  let source = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (kimchiDictionary) source = adaptKimchiDictionarySource(source);
  if (kimchiNetflixSeek) {
    if (!manifest.web_accessible_resources?.some((entry) => Array.isArray(entry.resources) && entry.resources.includes(kimchiSeekScript))) throw new Error("The expected Netflix seek helper is not declared.");
    const helper = files.get(kimchiSeekScript);
    if (!helper || createHash("sha256").update(helper).digest("hex") !== kimchiSeekHash) throw new Error("The Netflix seek helper differs from the reviewed original. Use an unchanged official package.");
    source = adaptKimchiNetflixSeekSource(source);
    files.set(kimchiSeekScript, Buffer.from(adaptKimchiNetflixSeekHelper(new TextDecoder("utf-8", { fatal: true }).decode(helper))));
  }
  files.set(kimchiContentScript, Buffer.from(source));
}

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

function readPackage(root) {
  const files = new Map();
  let size = 0;
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name);
      const info = fs.lstatSync(filename);
      if (info.isSymbolicLink()) throw new Error("The extension folder must not contain symbolic links.");
      if (info.isDirectory()) {
        visit(filename);
        continue;
      }
      if (!info.isFile()) throw new Error("The extension folder contains an unsupported file.");
      const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.size > maxBytes - size || files.size >= maxFiles) throw new Error("The extension exceeds the package size limit.");
        const data = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < data.length) {
          const read = fs.readSync(descriptor, data, offset, data.length - offset, offset);
          if (!read) throw new Error("The extension changed while it was being prepared.");
          offset += read;
        }
        if (fs.fstatSync(descriptor).size !== data.length) throw new Error("The extension changed while it was being prepared.");
        size += data.length;
        files.set(path.relative(root, filename), data);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
  visit(root);
  return files;
}

export function prepareWebKitExtension(source, output, { kimchiDictionary = false, kimchiNetflixSeek = false } = {}) {
  if (!source || !output) throw new Error("Provide the extracted extension folder and a new output folder.");
  if (!fs.lstatSync(source).isDirectory()) throw new Error("Choose a regular extension folder.");
  const root = fs.realpathSync(source);
  const resolvedOutput = path.resolve(output);
  const destination = path.join(fs.realpathSync(path.dirname(resolvedOutput)), path.basename(resolvedOutput));
  if (destination === root || inside(root, destination)) throw new Error("Choose an output folder outside the original extension.");
  if (fs.existsSync(destination)) throw new Error("The output folder already exists; choose a new folder.");
  const files = readPackage(root);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes || manifestBytes.length > 1024 * 1024) throw new Error("The extension needs a valid manifest.json.");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  const scripts = manifest.background?.scripts;
  if (!Array.isArray(scripts) || !scripts.length || manifest.background.page || manifest.background.service_worker) {
    throw new Error("Use the extracted Firefox package with background scripts.");
  }
  if (kimchiDictionary || kimchiNetflixSeek) prepareKimchi(manifest, files, { kimchiDictionary, kimchiNetflixSeek });
  const preparedScripts = [];
  for (const script of new Set(scripts)) {
    if (typeof script !== "string" || !script || path.isAbsolute(script) || /[\\?#\0]/.test(script)) throw new Error("The manifest contains an unsupported background script path.");
    const absolute = path.resolve(root, script);
    if (!inside(root, absolute)) throw new Error("Background scripts must stay inside the chosen folder.");
    const relative = path.relative(root, absolute);
    const data = files.get(relative);
    if (!data) throw new Error("A background script is missing.");
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (data.subarray(0, 3).equals(utf8Mark) || !data.some((byte) => byte >= 0x80)) continue;
    files.set(relative, Buffer.concat([utf8Mark, data]));
    preparedScripts.push(relative);
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    for (const [relative, data] of files) {
      const filename = path.join(destination, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filename, data, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { directory: destination, preparedScripts, dictionaryStreams: kimchiDictionary, netflixSeek: kimchiNetflixSeek };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { kimchiDictionary: false, kimchiNetflixSeek: false };
  const flags = { "--kimchi-dictionary": "kimchiDictionary", "--kimchi-netflix-seek": "kimchiNetflixSeek" };
  while (Object.hasOwn(flags, args[0])) options[flags[args.shift()]] = true;
  if (args.length !== 2) {
    console.error("Usage: node scripts/personal/prepare-webkit-extension.mjs [--kimchi-dictionary] [--kimchi-netflix-seek] <extracted-firefox-folder> <new-output-folder>");
    process.exitCode = 1;
  } else {
    try {
      const result = prepareWebKitExtension(args[0], args[1], options);
      console.log(`Prepared ${result.preparedScripts.length} background script(s)${result.dictionaryStreams ? ", Kimchi dictionary stream compatibility" : ""}${result.netflixSeek ? ", Netflix subtitle seeking" : ""} in ${result.directory}. The original folder is unchanged. Inspect and approve this new folder in Ardia before loading it.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
