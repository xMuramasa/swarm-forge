#!/usr/bin/env bun
// The board of task cards (.swarmforge/board/tasks.tsv) and the archive of role panes.
//   name <TAB> lane <TAB> created <TAB> updated <TAB> task-id <TAB> audit-count

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as herdr from "./herdr.ts";
import { ExitError, projectRoot, timestamp } from "./handoff_lib.ts";

export const usageText = `Usage:
  pack_board.sh create --name <name> --lane <lane> [--root <dir>] [--text <text>]
  pack_board.sh create <name> <lane>
  pack_board.sh move --name <name> --lane <lane> [--root <dir>]
  pack_board.sh move <name> <lane>
  pack_board.sh done --name <name> [--root <dir>]
  pack_board.sh done <name>
  pack_board.sh list [--root <dir>]
  pack_board.sh lanes [--root <dir>]
  pack_board.sh master-lane [--root <dir>]
  pack_board.sh archive --role <role> [--root <dir>]
  pack_board.sh archive <role>
  pack_board.sh archive-all [--root <dir>]
  pack_board.sh increment-audit --task-id <task-id> [--root <dir>]
  pack_board.sh delete --name <name> [--root <dir>]
  pack_board.sh delete <name>`;

const flags: Record<string, keyof Opts> = {
  "--root": "root", "--name": "name", "--lane": "lane", "--text": "text", "--role": "role", "--task-id": "taskId",
};

type Opts = { root?: string; name?: string; lane?: string; text?: string; role?: string; taskId?: string; positional: string[] };

export class BoardError extends ExitError {}

const boardDir = (root: string) => join(root, ".swarmforge", "board");
export const tasksFile = (root: string) => join(boardDir(root), "tasks.tsv");
const bodyFile = (root: string, name: string) => join(boardDir(root), `${name}.txt`);
const docFile = (root: string, name: string) => join(root, "tasks", `${name}.md`);

// -- lock ---------------------------------------------------------------------

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const staleAfterMs = 30_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run `f` holding an exclusive lock on the board. The lock is a directory: creating it is atomic
 *  across processes. One left behind by a dead process or older than 30 s is taken over. */
export function withBoardLock<T>(root: string, f: () => T): T {
  const dir = boardDir(root);
  const lock = join(dir, "tasks.lock.d");
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch {
      try {
        const owner = Number(readFileSync(join(lock, "pid"), "utf8"));
        if (!pidAlive(owner) || Date.now() - statSync(lock).mtimeMs > staleAfterMs) rmSync(lock, { recursive: true, force: true });
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

// -- rows ---------------------------------------------------------------------

function readRows(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
}

function writeRows(file: string, rows: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const dir = mkdtempSync(join(dirname(file), ".tasks."));
  const tmp = join(dir, "tasks");
  writeFileSync(tmp, rows.length ? `${rows.join("\n")}\n` : "");
  renameSync(tmp, file);
  rmSync(dir, { recursive: true, force: true });
}

const rowName = (line: string) => line.split("\t")[0] ?? "";
const findTask = (rows: string[], name: string) => rows.find((r) => rowName(r).toLowerCase() === name.toLowerCase());
const taskRow = (name: string, lane: string, now: string, taskId: string) => [name, lane, now, now, taskId, "0"].join("\t");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "task";

/** yyyyMMdd'T'HHmmssSSSSSS'Z' (microseconds, so ids from one millisecond still sort) + slug. */
export function newTaskId(name: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "000Z");
  return `${stamp}-${slug(name)}`;
}

const need = (value: string | undefined, label: string): string => {
  if (!value || !value.trim()) throw new BoardError(`Missing ${label}`);
  return value;
};

// -- operations ---------------------------------------------------------------

export function createCard(root: string, name: string, lane: string, taskId = newTaskId(name), text?: string): void {
  need(name, "task name");
  need(lane, "lane");
  withBoardLock(root, () => {
    const rows = readRows(tasksFile(root));
    if (findTask(rows, name)) throw new BoardError(`Duplicate task name: ${name}`);
    writeRows(tasksFile(root), [...rows, taskRow(name, lane, timestamp(), taskId)]);
    if (text !== undefined) {
      mkdirSync(boardDir(root), { recursive: true });
      writeFileSync(bodyFile(root, name), text);
    }
    const body = text ?? "";
    mkdirSync(join(root, "tasks"), { recursive: true });
    writeFileSync(docFile(root, name), `# ${name}\n\n${body}${body.endsWith("\n") ? "" : "\n"}`);
  });
}

function setLane(root: string, name: string, lane: string): void {
  need(name, "task name");
  need(lane, "lane");
  withBoardLock(root, () => {
    const rows = readRows(tasksFile(root));
    if (!findTask(rows, name)) throw new BoardError(`Unknown task name: ${name}`);
    writeRows(tasksFile(root), rows.map((line) => {
      const [rn, , created, , taskId, audit] = line.split("\t");
      return rn.toLowerCase() === name.toLowerCase()
        ? [rn, lane, created, timestamp(), taskId, audit || "0"].join("\t")
        : line;
    }));
  });
}

export function incrementAudit(root: string, taskId: string): void {
  need(taskId, "task ID");
  withBoardLock(root, () => {
    const file = tasksFile(root);
    if (!existsSync(file)) return;
    const rows = readRows(file);
    const keyOf = (line: string) => {
      const cols = line.split("\t");
      return cols[4] || cols[0];
    };
    if (!rows.some((r) => keyOf(r) === taskId)) throw new BoardError(`Unknown task ID: ${taskId}`);
    writeRows(file, rows.map((line) => {
      if (keyOf(line) !== taskId) return line;
      const cols = line.split("\t");
      const count = /^[0-9]+$/.test(cols[5] ?? "") ? Number(cols[5]) : 0;
      return [cols[0], cols[1], cols[2], cols[3], cols[4], String(count + 1)].join("\t");
    }));
  });
}

export function deleteCard(root: string, name: string): void {
  need(name, "task name");
  withBoardLock(root, () => {
    const rows = readRows(tasksFile(root));
    if (!findTask(rows, name)) throw new BoardError(`Unknown task name: ${name}`);
    writeRows(tasksFile(root), rows.filter((r) => rowName(r).toLowerCase() !== name.toLowerCase()));
    rmSync(bodyFile(root, name), { force: true });
  });
}

const roleRows = (root: string) => readRows(join(root, ".swarmforge", "roles.tsv")).map((l) => l.split("\t"));

export function masterLane(root: string): string {
  const masters = roleRows(root).filter((cols) => cols[1] === "master");
  if (masters.length !== 1) throw new BoardError("Config must name exactly one master worktree");
  return masters[0][0];
}

function sessionForRole(root: string, role: string): string | undefined {
  const row = roleRows(root).find((cols) => cols[0] === role);
  if (!row) return undefined;
  return row[3]?.trim() ? row[3] : `sf-${herdr.clean(role)}`;
}

/** Save the role's terminal text under .swarmforge/sessions/<role>/pane.txt. */
export function archiveSession(root: string, role: string): void {
  if (!role.trim()) return;
  const session = sessionForRole(root, role);
  const text = process.env.SWARMFORGE_PANE_STUB || (session ? herdr.readText(session) : undefined);
  if (text === undefined) return;
  const file = join(root, ".swarmforge", "sessions", role, "pane.txt");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function archiveAll(root: string): void {
  const roles = new Set<string>();
  for (const line of readRows(tasksFile(root))) {
    const [name, lane] = line.split("\t");
    if (name?.trim() && lane?.trim() && lane !== "done") roles.add(lane);
  }
  for (const role of roles) archiveSession(root, role);
}

// -- command line -------------------------------------------------------------

function parseArgs(args: string[]): Opts {
  const opts: Opts = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]];
    if (!key) {
      opts.positional.push(args[i]);
    } else if (args[i + 1] === undefined) {
      throw new BoardError(`Missing value for ${args[i]}`);
    } else {
      (opts[key] as string) = args[++i];
    }
  }
  return opts;
}

export function run(args: string[]): void {
  const opts = parseArgs(args);
  const [command, second, third] = opts.positional;
  const root = () => opts.root ?? projectRoot();
  const name = opts.name ?? second;
  switch (command) {
    case "create": return createCard(root(), name ?? "", opts.lane ?? third ?? "", opts.taskId, opts.text);
    case "move": return setLane(root(), name ?? "", opts.lane ?? third ?? "");
    case "done": return setLane(root(), name ?? "", "done");
    case "list": {
      const file = tasksFile(root());
      if (existsSync(file)) process.stdout.write(readFileSync(file, "utf8"));
      return;
    }
    case "lanes":
      for (const cols of roleRows(root())) console.log(cols[0]);
      return;
    case "master-lane": return console.log(masterLane(root()));
    case "archive": return archiveSession(root(), need(opts.role ?? second, "role"));
    case "archive-all": return archiveAll(root());
    case "increment-audit": return incrementAudit(root(), opts.taskId ?? "");
    case "delete": return deleteCard(root(), name ?? "");
    default:
      throw new BoardError(usageText, 1);
  }
}

if (import.meta.main) {
  try {
    run(process.argv.slice(2));
    process.exit(0);
  } catch (e) {
    if (e instanceof ExitError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(e.exit);
    }
    throw e;
  }
}
