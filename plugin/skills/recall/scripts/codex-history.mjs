#!/usr/bin/env node
// Codex adaptation of pstack's workspace-scoped transcript lookup.
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside = (path, root) => {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
};
const canonical = async (path) => realpath(resolve(path)).catch(() => resolve(path));

export async function projectRoots(project) {
  const current = await realpath(resolve(project));
  try {
    const output = execFileSync("git", ["-C", current, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(await Promise.all(output.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => canonical(field.slice(9)))))];
  } catch {
    return [current];
  }
}

async function* rolloutFiles(root) {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(path);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) yield path;
  }
}

async function metadata(path) {
  const input = createReadStream(path);
  const decoded = path.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
  if (decoded !== input) input.on("error", (error) => decoded.destroy(error));
  let first = Buffer.alloc(0);
  try {
    for await (const chunk of decoded) {
      const newline = chunk.indexOf(10);
      first = Buffer.concat([first, newline < 0 ? chunk : chunk.subarray(0, newline)]);
      if (first.length > 1024 * 1024) throw new Error("Oversized session metadata");
      if (newline >= 0) break;
    }
    const line = JSON.parse(first.toString("utf8"));
    if (line.type !== "session_meta" || typeof line.payload?.cwd !== "string" || !isAbsolute(line.payload.cwd) || !UUID.test(line.payload.id)) return undefined;
    return line.payload;
  } finally {
    decoded.destroy();
    input.destroy();
  }
}

async function historyInventory({ project = process.cwd(), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") } = {}) {
  const roots = await projectRoots(project);
  const home = await canonical(codexHome);
  const items = [];
  for (const directory of ["sessions", "archived_sessions"]) {
    for await (const path of rolloutFiles(join(home, directory))) {
      let meta;
      try { meta = await metadata(path); } catch { continue; }
      if (!meta) continue;
      const cwd = await canonical(meta.cwd);
      if (!roots.some((root) => inside(cwd, root))) continue;
      const info = await stat(path);
      const rolloutId = basename(path).match(/([0-9a-f-]{36})\.jsonl(?:\.zst)?$/i)?.[1] || meta.id;
      const item = { id: meta.id, executor: "codex", rolloutId, path, cwd: meta.cwd, modified: info.mtime.toISOString(), timestamp: meta.timestamp, source: meta.source, parentThreadId: meta.parent_thread_id, historyBase: meta.history_base, archived: directory === "archived_sessions" };
      items.push(item);
    }
  }
  return items;
}

function currentRollouts(inventory) {
  const order = (item) => {
    const name = basename(item.path).match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(?:\.zst)?$/i);
    // Match Codex's filesystem fallback: filename time, then physical rollout UUID.
    return name && name[2] === item.id ? `${name[1]}_${item.rolloutId}` : item.modified;
  };
  const current = new Map();
  for (const item of inventory) {
    const previous = current.get(item.id);
    if (!previous || order(item) > order(previous)) current.set(item.id, item);
  }
  return [...current.values()];
}

async function* runnerReceipts(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* runnerReceipts(path);
    else if (entry.isFile() && entry.name === "result.json") yield path;
  }
}

async function readRunFile(path) {
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error("Runner artifact traverses a symlink");
  return readFile(path);
}

async function claudeInventory(project, claudeRuns = []) {
  const roots = await projectRoots(project);
  const items = new Map();
  for (const supplied of Array.isArray(claudeRuns) ? claudeRuns : [claudeRuns]) {
    if (!isAbsolute(supplied)) throw new Error("--claude-runs must be an absolute existing run directory or root");
    const root = await realpath(supplied);
    if (!roots.some((projectRoot) => inside(root, projectRoot))) throw new Error("--claude-runs must be inside this project or its worktrees");
    for await (const path of runnerReceipts(root)) {
      try {
        const requestPath = join(dirname(path), "request.json");
        const request = JSON.parse((await readRunFile(requestPath)).toString("utf8"));
        if (request.executor !== "claude-code" || typeof request.cwd !== "string" || !isAbsolute(request.cwd)) continue;
        // request.json is metadata only; scope it before opening the result or transcript.
        const cwd = await canonical(request.cwd);
        if (!roots.some((projectRoot) => inside(cwd, projectRoot))) continue;
        const receipt = JSON.parse((await readRunFile(path)).toString("utf8"));
        if (receipt.executor !== "claude-code" || receipt.cwd !== request.cwd || receipt.startedAt !== request.startedAt || (receipt.sessionId !== null && !UUID.test(receipt.sessionId || ""))) continue;
        const paths = { requestPath, resultPath: path, promptPath: join(dirname(path), "prompt.txt"), stdoutPath: join(dirname(path), "stdout.jsonl"), stderrPath: join(dirname(path), "stderr.log") };
        let valid = true;
        for (const [key, expected] of Object.entries(paths)) {
          if (typeof receipt[key] !== "string" || !isAbsolute(receipt[key]) || await canonical(receipt[key]) !== expected) valid = false;
        }
        const modified = receipt.completedAt || request.startedAt;
        if (!valid || Number.isNaN(Date.parse(request.startedAt)) || Number.isNaN(Date.parse(modified))) continue;
        items.set(path, { id: receipt.sessionId, executor: "claude-code", source: "claude-code", path, cwd: request.cwd, timestamp: request.startedAt, modified, completedAt: receipt.completedAt, model: request.model, observedModel: receipt.observedModel, ...paths });
      } catch {
        // Incomplete runs and unrelated result.json files are not runner receipts.
      }
    }
  }
  return [...items.values()];
}

function validateSource(source) {
  if (source !== undefined && source !== "codex" && source !== "claude-code") throw new Error("--source must be codex or claude-code");
}

export async function listHistory({ project = process.cwd(), codexHome, since, query, touching, exclude, claudeRuns, source } = {}) {
  validateSource(source);
  const cutoff = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(cutoff)) throw new Error("--since must be an ISO date or timestamp");
  const inventory = source === "claude-code" ? [] : await historyInventory({ project, codexHome });
  const candidates = [...currentRollouts(inventory), ...(source === "codex" ? [] : await claudeInventory(project, claudeRuns))];
  const items = [];
  for (const item of candidates) {
    if (item.id === exclude || Date.parse(item.modified) < cutoff) continue;
    if (query !== undefined || touching !== undefined) {
      const content = item.executor === "codex" ? (await expandHistory(item, inventory)).toString("utf8") : (await Promise.all([item.path, item.promptPath, item.stdoutPath].map(readRunFile))).map((bytes) => bytes.toString("utf8")).join("\n");
      if (query !== undefined && !content.includes(query)) continue;
      if (touching !== undefined) {
        const target = await canonical(touching);
        const literal = JSON.stringify(resolve(touching)).slice(1, -1);
        if (!inside(await canonical(item.cwd), target) && !content.includes(`${literal}/`) && !content.includes(`${literal}"`)) continue;
      }
    }
    items.push(item);
  }
  return items.sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path));
}

async function readRollout(item) {
  // The inventory validates session metadata before opening message content.
  if ((await lstat(item.path)).isSymbolicLink()) throw new Error("Rollout became a symlink");
  if (await realpath(item.path) !== item.path) throw new Error("Rollout path traverses a symlink");
  const latest = await metadata(item.path);
  if (latest?.id !== item.id || latest?.cwd !== item.cwd) throw new Error("Session metadata changed after scoping");
  const bytes = await readFile(item.path);
  return item.path.endsWith(".zst") ? zstdDecompressSync(bytes) : bytes;
}

async function expandHistory(selected, inventory) {
  const seen = new Set();
  async function expand(item, byteLimit) {
    if (seen.has(item.path)) throw new Error("Cyclic inherited history");
    seen.add(item.path);
    let prefix = Buffer.alloc(0);
    if (item.historyBase) {
      const base = item.historyBase;
      const inherited = inventory.find((entry) => entry.rolloutId === base.thread_id);
      if (!inherited) throw new Error("Inherited rollout is unavailable in this project; use the host's full thread-history API");
      if (!Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0) throw new Error("Invalid inherited history byte boundary");
      prefix = await expand(inherited, base.end_byte_offset);
    }
    const bytes = await readRollout(item);
    const own = byteLimit === undefined ? bytes : bytes.subarray(0, byteLimit);
    if (byteLimit !== undefined && (byteLimit > bytes.length || (byteLimit > 0 && own.at(-1) !== 10))) throw new Error("Inherited history boundary is outside a complete record");
    seen.delete(item.path);
    return Buffer.concat([prefix, own]);
  }
  return expand(selected);
}

export async function readHistory(options) {
  validateSource(options.source);
  if (options.source === "claude-code" || options.receipt) {
    if (options.source === "codex") throw new Error("--receipt requires --source claude-code");
    const inventory = await claudeInventory(options.project || process.cwd(), options.claudeRuns);
    let matches;
    if (options.receipt) {
      if (!isAbsolute(options.receipt) || basename(options.receipt) !== "result.json") throw new Error("--receipt must be an exact absolute result.json path");
      const path = await canonical(options.receipt);
      matches = inventory.filter((item) => item.path === path && (options.id === undefined || item.id === options.id));
    } else {
      if (!UUID.test(options.id || "")) throw new Error("--id must be an exact chat UUID");
      matches = inventory.filter((item) => item.id === options.id);
    }
    if (matches.length > 1) throw new Error("Session has multiple runs; select the exact receipt with --receipt");
    if (!matches.length) throw new Error("Receipt is absent from this project's supplied run roots");
    const bytes = await readRunFile(matches[0].path);
    const latest = JSON.parse(bytes.toString("utf8"));
    if (latest.sessionId !== matches[0].id || latest.cwd !== matches[0].cwd) throw new Error("Runner receipt changed after scoping");
    return bytes;
  }
  if (!UUID.test(options.id || "")) throw new Error("--id must be an exact chat UUID");
  const inventory = await historyInventory(options);
  const selected = currentRollouts(inventory).find((item) => item.id === options.id);
  if (!selected) throw new Error("Chat is absent from this project's scoped history");
  return expandHistory(selected, inventory);
}

async function main(argv) {
  const command = argv.shift();
  if (command === "--help" || command === "help" || !command) {
    console.log("Usage: codex-history.mjs list|read --project ABS [--codex-home ABS] [--since ISO] [--query TEXT] [--touching ABS] [--exclude UUID] [--id UUID] [--source codex|claude-code] [--claude-runs ABS]... [--receipt ABS/result.json]\nLists metadata-scoped project/worktree history, newest activity first. Codex read emits current JSONL with inherited prefixes. Supply existing project-local Claude run roots explicitly; Claude read emits the exact result receipt and its raw artifact paths. No files are written.");
    return;
  }
  const options = {};
  const names = { "--project": "project", "--codex-home": "codexHome", "--since": "since", "--query": "query", "--touching": "touching", "--exclude": "exclude", "--id": "id", "--source": "source", "--claude-runs": "claudeRuns", "--receipt": "receipt" };
  while (argv.length) {
    const flag = argv.shift();
    if (!names[flag] || argv.length === 0) throw new Error(`Unknown or incomplete option: ${flag}`);
    if (flag === "--claude-runs") (options.claudeRuns ??= []).push(argv.shift());
    else options[names[flag]] = argv.shift();
  }
  if (command === "list") for (const item of await listHistory(options)) console.log(JSON.stringify(item));
  else if (command === "read") process.stdout.write(await readHistory(options));
  else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
