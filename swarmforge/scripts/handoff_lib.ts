#!/usr/bin/env bun
// Shared handoff helpers, and a small command line for the scripts that shell out to them.

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export class ExitError extends Error {
  constructor(message: string, public exit = 1) {
    super(message);
  }
}

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

export const gitToplevel = (): string | undefined => git("rev-parse", "--show-toplevel") || undefined;

export function gitCommonDir(): string | undefined {
  const out = git("rev-parse", "--git-common-dir");
  return out ? (isAbsolute(out) ? out : resolve(out)) : undefined;
}

export const stateDir = () => join(process.cwd(), ".swarmforge", "handoffs");
export const inboxDir = () => join(stateDir(), "inbox");

export const rolesAt = (root: string | undefined): root is string =>
  !!root && existsSync(join(root, ".swarmforge", "roles.tsv"));

export function projectRootOrUndefined(): string | undefined {
  try {
    return projectRoot();
  } catch {
    return undefined;
  }
}

export function projectRoot(): string {
  const common = gitCommonDir();
  const parent = common ? dirname(common) : undefined;
  if (rolesAt(parent)) return parent;
  const top = gitToplevel();
  if (rolesAt(top)) return top;
  if (rolesAt(process.cwd())) return process.cwd();
  throw new ExitError("Cannot find SwarmForge project root");
}

export const rolesFile = () => join(projectRoot(), ".swarmforge", "roles.tsv");

export const roleRows = (): string[][] =>
  readFileSync(rolesFile(), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));

export function inferRoleFromWorktree(): string | undefined {
  const here = gitToplevel() ?? process.cwd();
  return roleRows().find((cols) => cols[0] && cols[2] && samePath(cols[2], here))?.[0];
}

export function role(): string {
  const found = process.env.SWARMFORGE_ROLE || inferRoleFromWorktree();
  if (!found) throw new ExitError("Set SWARMFORGE_ROLE.");
  return found;
}

export function roleRow(name: string): string[] {
  const row = roleRows().find((cols) => cols[0] === name);
  if (!row) throw new ExitError(`Unknown role: ${name}`);
  return row;
}

export const roleKnown = (name: string) => roleRows().some((cols) => cols[0] === name);
export const roleWorktreeName = (name: string) => roleRow(name)[1];
export const roleReceiveMode = (name: string) => roleRow(name)[6] || "task";
export const rolePropagation = (name: string) => roleRow(name)[7] || "forward-only";

export const timestamp = () => new Date().toISOString();
export const idTimestamp = () => timestamp().replace(/[-:]/g, "").replace(/\.\d+/, "");
export const validPriority = (value: string) => /^[0-9][0-9]$/.test(value);

/** Lines of a text the way Clojure's split-lines gives them (Java's String.split): trailing
 *  empty lines are dropped, and text with no newline at all comes back whole, even "". */
export function splitLines(text: string): string[] {
  if (text === "") return [""];
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const isBlank = (line: string) => line.trim() === "";

/** Header lines (up to the first blank line) of a handoff file. */
const headerLines = (lines: string[]) => {
  const end = lines.findIndex(isBlank);
  return end < 0 ? lines : lines.slice(0, end);
};

export function headerField(file: string, field: string): string | undefined {
  const prefix = `${field}: `;
  const line = headerLines(splitLines(readFileSync(file, "utf8"))).find((l) => l.startsWith(prefix));
  return line?.slice(prefix.length);
}

export function body(file: string): string {
  const text = readFileSync(file, "utf8");
  const at = text.indexOf("\n\n");
  return at < 0 ? "" : text.slice(at + 2);
}

export function setHeaderLines(lines: string[], field: string, value: string): string[] {
  const prefix = `${field}: `;
  const headers = headerLines(lines);
  const rest = lines.slice(headers.length);
  const rewritten = headers.map((l) => (l.startsWith(prefix) ? `${prefix}${value}` : l));
  if (!rewritten.some((l) => l.startsWith(prefix))) rewritten.push(`${prefix}${value}`);
  return [...rewritten, ...rest];
}

export function setHeader(file: string, field: string, value: string): void {
  const dir = mkdtempSync(join(dirname(resolve(file)), ".headers."));
  const tmp = join(dir, "file");
  writeFileSync(tmp, `${setHeaderLines(splitLines(readFileSync(file, "utf8")), field, value).join("\n")}\n`);
  renameSync(tmp, file);
  rmSync(dir, { recursive: true, force: true });
}

const out = (text: string): void => {
  process.stdout.write(text);
};
const println = (text = "") => out(`${text}\n`);

export function printTask(file: string): void {
  const taskName = headerField(file, "task");
  const taskId = headerField(file, "task_id");
  println(`TASK: ${file}`);
  println(`FROM: ${headerField(file, "from") ?? "unknown"}`);
  println(`TYPE: ${headerField(file, "type") ?? "unknown"}`);
  println(`PRIORITY: ${headerField(file, "priority") ?? "50"}`);
  if (taskName !== undefined) println(`TASK_NAME: ${taskName}`);
  if (taskId !== undefined) println(`TASK_ID: ${taskId}`);
  println("PAYLOAD:");
  out(body(file));
}

export function handoffFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".handoff") && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => join(dir, f));
}

/** Directories named batch_* directly under `dir`, sorted. */
export function batchDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("batch_") && statSync(join(dir, f)).isDirectory())
    .sort()
    .map((f) => join(dir, f));
}

export const currentHead = () => spawnSync("git", ["rev-parse", "--short=10", "HEAD"], { encoding: "utf8" }).stdout.trim();

/** Print the lines to stderr and exit. */
export function fail(status: number, ...lines: string[]): never {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(status);
}

/** Merge an inbound git_handoff's commit into this worktree (merge_and_process.sh). */
export function mergeGitHandoff(file: string): void {
  if (headerField(file, "type") !== "git_handoff") return;
  const from = headerField(file, "from");
  const commit = headerField(file, "commit");
  if (!from || !commit) return;
  const r = spawnSync(join(dirname(import.meta.path), "merge_and_process.sh"), [from, commit], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) fail(1, `${r.stderr}\n${r.stdout}`.trim());
}

export function printBatch(batchDir: string): void {
  const files = handoffFiles(batchDir);
  if (!files.length) throw new ExitError(`AMBIGUOUS_TASK_STATE: batch contains no tasks: ${batchDir}`, 2);
  println(`BATCH: ${batchDir}`);
  println(`COUNT: ${files.length}`);
  const name = headerField(files[0], "task");
  if (name !== undefined) println(`TASK_NAME: ${name}`);
  println(`PRIORITY: ${headerField(files[0], "priority") ?? "50"}`);
  files.forEach((file, index) => {
    println();
    println(`BATCH_ITEM: ${index + 1}`);
    printTask(file);
  });
}

function archiveCurrentRole(): void {
  const script = join(dirname(import.meta.path), "pack_board.sh");
  const r = spawnSync(script, ["archive", "--role", role(), "--root", projectRoot()], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.stderr.write(`${r.stderr}${r.stdout}`);
}

export const announceFollowUp = () =>
  println(handoffFiles(join(inboxDir(), "new")).length ? "MAIL_WAITING" : "NO_TASK");

export function finishDone(): void {
  try {
    archiveCurrentRole();
  } catch (e) {
    const safe = <T>(f: () => T, fallback: string) => {
      try {
        return String(f());
      } catch {
        return fallback;
      }
    };
    process.stderr.write(`archive failed role=${safe(role, "?")} root=${safe(projectRoot, "?")} error=${(e as Error).message}\n`);
  }
  announceFollowUp();
}

export const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run `f` holding an exclusive lock. The lock is a directory: creating it is atomic across
 *  processes. One left behind by a dead process, or older than 30 s, is taken over. */
export function withLockDir<T>(lock: string, f: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch {
      try {
        const owner = Number(readFileSync(join(lock, "pid"), "utf8"));
        if (!pidAlive(owner) || Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // the owner just released it or has not written its pid yet: try again
      }
      sleep(10);
    }
  }
  try {
    return f();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Next six-digit handoff sequence number, under a lock. */
export function nextSequence(dir = stateDir()): string {
  const seqFile = join(dir, "sequence");
  return withLockDir(join(dir, "sequence.lock"), () => {
    const last = existsSync(seqFile) ? readFileSync(seqFile, "utf8").trim() : "0";
    const next = (/^[0-9]+$/.test(last) ? Number(last) : 0) + 1;
    const formatted = String(next).padStart(6, "0");
    writeFileSync(seqFile, `${formatted}\n`);
    return formatted;
  });
}

const commands: Record<string, (args: string[]) => number | void> = {
  role: () => println(role()),
  "state-dir": () => println(stateDir()),
  "inbox-dir": () => println(inboxDir()),
  "project-root": () => println(projectRoot()),
  "role-known": (a) => (roleKnown(a[1]) ? 0 : 1),
  "role-worktree-name": (a) => println(roleWorktreeName(a[1])),
  "role-receive-mode": (a) => println(roleReceiveMode(a[1])),
  "role-propagation": (a) => println(rolePropagation(a[1])),
  timestamp: () => println(timestamp()),
  "id-timestamp": () => println(idTimestamp()),
  "valid-priority": (a) => (validPriority(a[1]) ? 0 : 1),
  "header-field": (a) => {
    const value = headerField(a[1], a[2]);
    if (value === undefined) return 1;
    println(value);
  },
  body: (a) => out(body(a[1])),
  "set-header": (a) => setHeader(a[1], a[2], a[3]),
  "print-task": (a) => printTask(a[1]),
  "print-batch": (a) => printBatch(a[1]),
  "next-sequence": () => println(nextSequence()),
  "finish-done": () => finishDone(),
};

export function main(args: string[]): number {
  const command = commands[args[0]];
  if (!command) {
    process.stderr.write("Usage: handoff_lib.ts <command> [args...]\n");
    return 2;
  }
  try {
    return command(args) ?? 0;
  } catch (e) {
    if (e instanceof ExitError) {
      process.stderr.write(`${e.message}\n`);
      return e.exit;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
