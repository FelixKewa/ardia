import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const utf8Mark = Buffer.from([0xef, 0xbb, 0xbf]);
const maxBytes = 512 * 1024 * 1024;
const maxFiles = 50000;

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

export function prepareWebKitExtension(source, output) {
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
  return { directory: destination, preparedScripts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) {
    console.error("Usage: node scripts/personal/prepare-webkit-extension.mjs <extracted-firefox-folder> <new-output-folder>");
    process.exitCode = 1;
  } else {
    try {
      const result = prepareWebKitExtension(process.argv[2], process.argv[3]);
      console.log(`Prepared ${result.preparedScripts.length} background script(s) in ${result.directory}. The original folder is unchanged. Inspect and approve this new folder in Ardia before loading it.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
