import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

export const exists = async (path) => lstat(path).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; });
export const within = (parent, child) => { const rel = relative(parent, child); return rel !== "" && !rel.startsWith("../") && rel !== ".." && !rel.startsWith("/"); };

export async function owned(path, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (process.getuid && stat.uid !== process.getuid())) throw Error("Migration input must be an owned regular file or directory.");
  return stat;
}

export async function readSafe(path, limit = 32 * 1024 * 1024) {
  await owned(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit || (process.getuid && stat.uid !== process.getuid())) throw Error("Migration input exceeds its limit.");
    const output = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await file.read(output, offset, output.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw Error("Migration input changed while reading.");
    return output.subarray(0, offset);
  } finally { await file.close(); }
}

export const parseJSON = (bytes) => { try { return JSON.parse(bytes.toString("utf8")); } catch { throw Error("A migration document contains invalid JSON; its contents were not logged."); } };
export const readJSON = async (path) => parseJSON(await readSafe(path));
export const fileHash = async (path) => {
  await owned(path);
  const digest = createHash("sha256");
  const stream = createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK });
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
};

export async function inventory(root) {
  await owned(root, true);
  const canonicalRoot = await realpath(root);
  const entries = [];
  const walk = async (directory) => {
    await owned(directory, true);
    if (await realpath(directory) !== resolve(canonicalRoot, relative(root, directory))) throw Error("Migration input contains an unsafe directory.");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw Error("Migration input contains a symbolic link; close both browsers and inspect before retrying.");
      if (stat.isDirectory()) await walk(path);
      else { await owned(path); entries.push({ path: relative(root, path), bytes: stat.size, sha256: await fileHash(path) }); }
    }
  };
  await walk(root);
  return entries;
}

export async function copyTree(source, target) {
  const before = await inventory(source);
  if (await exists(target)) throw Error("Migration destination already exists.");
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of before) {
    const from = join(source, entry.path);
    const to = join(target, entry.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await pipeline(createReadStream(from, { flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK }), createWriteStream(to, { flags: "wx", mode: 0o600 }));
    if (await fileHash(to) !== entry.sha256 || await fileHash(from) !== entry.sha256) throw Error("Migration data changed during copy.");
  }
  const after = await inventory(source);
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(await inventory(target))) throw Error("Migration copy verification failed.");
  return before;
}

export async function copyFileChecked(source, target) {
  const before = await fileHash(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await pipeline(createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK }), createWriteStream(target, { flags: "wx", mode: 0o600 }));
  if (await fileHash(target) !== before || await fileHash(source) !== before) throw Error("Migration file changed during copy.");
}

export async function writeJSON(path, value, stage) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = stage ? join(stage, `metadata-${randomUUID()}`) : `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

export async function replaceFileChecked(source, target, stage) {
  const temporary = stage ? join(stage, `restore-${randomUUID()}`) : `${target}.${randomUUID()}.tmp`;
  await copyFileChecked(source, temporary);
  await rename(temporary, target);
}

export async function packageFingerprint(root) {
  const files = await inventory(root);
  if (files.length > 50000 || files.reduce((sum, file) => sum + file.bytes, 0) > 512 * 1024 * 1024 || !files.some((file) => file.path === "manifest.json")) throw Error("Invalid extension package size or manifest.");
  const canonical = new Map();
  for (const file of files) {
    const name = file.path.normalize("NFC");
    if (canonical.has(name)) throw Error("Equivalent extension resource paths.");
    canonical.set(name, file);
  }
  const digest = createHash("sha256");
  const legacy = createHash("sha256");
  for (const [name, file] of [...canonical].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const bytes = await readSafe(join(root, file.path), file.path === "manifest.json" ? 1024 * 1024 : 512 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw Error("Extension changed during verification.");
    digest.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
    legacy.update(`${Buffer.byteLength(file.path)}:${file.path}:${bytes.length}:`).update(bytes);
  }
  return { fingerprint: digest.digest("hex"), legacyFingerprint: legacy.digest("hex"), files: files.length };
}

export async function removeOwned(path) { if (await exists(path)) { await owned(path, (await lstat(path)).isDirectory()); await rm(path, { recursive: true, force: false }); } }

export async function exclusively(destination, action, { interpreter = "/usr/bin/python3", startTimeout = 60000 } = {}) {
  const code = "import fcntl,os,stat,sys\nfd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)\ns=os.fstat(fd)\nif not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid(): sys.exit(2)\ntry: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(3)\nprint('locked',flush=True)\nsys.stdin.buffer.read()\n";
  const guardian = spawn(interpreter, ["-u", "-c", code, `${destination}.preview-import.mutex`], { stdio: ["pipe", "pipe", "ignore"] });
  guardian.stdin.on("error", () => {});
  let active = false;
  const exited = new Promise((resolve) => guardian.once("close", () => { active = false; resolve(); }));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { guardian.kill("SIGKILL"); reject(Error("The migration lock helper did not start in time.")); }, startTimeout);
      const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      guardian.once("error", () => done(Error("Could not create the migration transaction lock.")));
      guardian.once("exit", () => done(Error("Another migration or recovery is running.")));
      guardian.stdout.once("data", (bytes) => { if (bytes.toString().trim() !== "locked") return done(Error("Invalid transaction lock response.")); active = true; done(); });
    });
    return await action(() => { if (!active) throw Error("Migration transaction lock was lost; stop and recover before launching."); });
  } finally {
    guardian.stdin.end();
    await exited;
  }
}
