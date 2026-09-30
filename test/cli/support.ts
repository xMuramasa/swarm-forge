// Shared helpers for the black-box tests: temporary repos, running the scripts with a controlled
// environment, a fake herdr on PATH, and builders for the handoff files the scripts exchange.

import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dir, "../..");
export const scriptsDir = join(repoRoot, "swarmforge", "scripts");
export const script = (name: string) => join(scriptsDir, name);

const created: string[] = [];
// This module is shared by every test file in one process, so clean up when that process ends
// (an afterAll would fire after the first file and delete the fake herdr the later ones need).
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export function tmpDir(prefix = "swarmforge-test."): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function writeFile(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export const readFile = (path: string) => readFileSync(path, "utf8");
export const exists = (path: string) => existsSync(path);
export const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** Files (not directories) directly in `dir`, sorted; [] when the directory is missing. */
export function listFiles(dir: string, suffix = ""): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(suffix) && statSync(join(dir, f)).isFile()).sort().map((f) => join(dir, f));
}

/** Every file under `dir`, recursively. */
export function walk(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// -- fake herdr ---------------------------------------------------------------------

const fakeScript = join(import.meta.dir, "fake-herdr.sh");
let fakeBin: string | undefined;

function fakeBinDir(): string {
  if (!fakeBin) {
    fakeBin = mkdtempSync(join(tmpdir(), "fake-herdr-bin."));
    created.push(fakeBin);
    copyFileSync(fakeScript, join(fakeBin, "herdr"));
    chmodSync(join(fakeBin, "herdr"), 0o755);
  }
  return fakeBin;
}

export const fake = {
  stateDir: (dir: string) => join(dir, ".fake-herdr"),
  /** Environment that puts the fake herdr first on PATH, with state under `dir`. */
  env: (dir: string) => ({ PATH: `${fakeBinDir()}:${process.env.PATH}`, FAKE_HERDR_DIR: join(dir, ".fake-herdr") }),
  addAgents(dir: string, names: string[], text = ""): void {
    for (const name of names) writeFile(join(dir, ".fake-herdr", "agents", name), text);
  },
  setStatus: (dir: string, name: string, status: string) => writeFile(join(dir, ".fake-herdr", "status", name), status),
  logLines(dir: string, file: string): string[] {
    const path = join(dir, ".fake-herdr", file);
    return existsSync(path) ? readFile(path).split("\n").filter(Boolean) : [];
  },
  calls: (dir: string) => fake.logLines(dir, "calls.log"),
  prompts: (dir: string) => fake.logLines(dir, "prompts.log").map((l) => l.split("\t") as [string, string]),
  closed: (dir: string) => fake.logLines(dir, "closed.log"),
  reset: (dir: string) => rmSync(join(dir, ".fake-herdr"), { recursive: true, force: true }),
};

// -- running things -----------------------------------------------------------------

export type Result = { exit: number; out: string; err: string };
export type RunOpts = { dir: string; env?: Record<string, string>; ok?: boolean };

/** Run a command in `dir` with only PATH (fake herdr first), GIT_CONFIG_NOSYSTEM and `env`.
 *  Throws unless it exits 0 or `ok` is false. */
export function run(opts: RunOpts, command: string, ...args: string[]): Result {
  const r = spawnSync(command, args, {
    cwd: opts.dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", ...fake.env(opts.dir), ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = { exit: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  if (opts.ok !== false && result.exit !== 0) {
    throw new Error(`Command failed (${result.exit}): ${command} ${args.join(" ")}\n${result.err}${result.out}`);
  }
  return result;
}

export function initRepo(root: string): string {
  run({ dir: root }, "git", "init", "-q");
  run({ dir: root }, "git", "config", "user.email", "test@example.com");
  run({ dir: root }, "git", "config", "user.name", "Test User");
  writeFile(join(root, "README.md"), "initial\n");
  run({ dir: root }, "git", "add", "README.md");
  run({ dir: root }, "git", "commit", "-q", "-m", "Initial commit");
  return headSha(root);
}

export const headSha = (dir: string) => run({ dir }, "git", "rev-parse", "--short=10", "HEAD").out.trim();

export function addWorktree(root: string, name: string): string {
  const wt = join(root, ".worktrees", name);
  mkdirSync(dirname(wt), { recursive: true });
  run({ dir: root }, "git", "worktree", "add", "-q", wt, "HEAD");
  return wt;
}

// -- project state ------------------------------------------------------------------

type RoleSpec = [role: string, mode?: string, propagation?: string];

/** roles.tsv rows: a {role: mode} map or [[role, mode, propagation], ...]. */
export function roleSpecRows(roles: Record<string, string> | RoleSpec[]): [string, string, string][] {
  return Array.isArray(roles)
    ? roles.map(([role, mode, prop]) => [role, mode || "task", prop || ""])
    : Object.entries(roles).map(([role, mode]) => [role, mode || "task", ""]);
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

export function setupProject(root: string, roles: Record<string, string> | RoleSpec[] = { sender: "task", receiver: "task" }): void {
  for (const dir of ["outbox/tmp", "sent", "failed", "inbox/new", "inbox/in_process", "inbox/completed"]) {
    mkdirSync(join(root, ".swarmforge/handoffs", dir), { recursive: true });
  }
  writeFile(
    join(root, ".swarmforge/roles.tsv"),
    roleSpecRows(roles).map(([role, mode, prop]) => `${role}\tmaster\t${root}\tsession\t${capitalize(role)}\tcodex\t${mode}\t${prop}\n`).join(""),
  );
}

export type HandoffAttrs = {
  id?: string; from?: string; to?: string; recipient?: string; priority?: string; type?: string;
  taskId?: string; task?: string; commit?: string; body?: string; taskBaseCommit?: string;
  enqueuedAt?: string; dequeuedAt?: string; completedAt?: string;
};

export function handoffText(a: HandoffAttrs): string {
  return [
    `id: ${a.id}`, `from: ${a.from}`, `to: ${a.to}`,
    ...(a.recipient ? [`recipient: ${a.recipient}`] : []),
    `priority: ${a.priority}`, `type: ${a.type}`,
    ...(a.taskId ? [`task_id: ${a.taskId}`] : []),
    ...(a.task ? [`task: ${a.task}`] : []),
    ...(a.commit ? [`commit: ${a.commit}`] : []),
    ...(a.taskBaseCommit ? [`task_base_commit: ${a.taskBaseCommit}`] : []),
    ...(a.enqueuedAt ? [`enqueued_at: ${a.enqueuedAt}`] : []),
    ...(a.dequeuedAt ? [`dequeued_at: ${a.dequeuedAt}`] : []),
    ...(a.completedAt ? [`completed_at: ${a.completedAt}`] : []),
    "", `${a.body ?? `payload for ${a.id}`}\n`,
  ].join("\n");
}

export const handoffPath = (root: string, state: string, filename: string) =>
  join(root, ".swarmforge", "handoffs", "inbox", state, filename);

export function putHandoff(root: string, state: string, filename: string, attrs: HandoffAttrs): string {
  return writeFile(handoffPath(root, state, filename), handoffText(attrs));
}

/** The value of a header in the head of a handoff file. */
export function header(path: string, field: string): string | undefined {
  const prefix = `${field}: `;
  for (const line of readFile(path).split("\n")) {
    if (!line) return undefined;
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

export function boardAuditCount(root: string, taskName: string): number | undefined {
  const file = join(root, ".swarmforge/board/tasks.tsv");
  if (!existsSync(file)) return undefined;
  for (const line of readFile(file).split("\n")) {
    const [name, , , , , audit] = line.split("\t");
    if (name === taskName) return Number(audit || "0");
  }
  return undefined;
}

export const auditPendingDir = (root: string) => join(root, ".swarmforge/handoffs/audit_pending");
export const auditSenderDirs = (root: string) =>
  isDir(auditPendingDir(root)) ? readdirSync(auditPendingDir(root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(auditPendingDir(root), e.name)) : [];
export const emptyAuditSenderDirs = (root: string) => auditSenderDirs(root).filter((d) => listFiles(d).length === 0);
export const auditFiles = (root: string) => walk(auditPendingDir(root)).filter((f) => f.endsWith(".json"));

export function queuedPath(out: string): string | undefined {
  const prefix = "HANDOFF QUEUED: ";
  return out.split("\n").find((l) => l.startsWith(prefix))?.slice(prefix.length);
}

export const outboxHandoffs = (root: string) => listFiles(join(root, ".swarmforge/handoffs/outbox"), ".handoff");
export const outboxTo = (root: string, role: string) => outboxHandoffs(root).find((f) => f.endsWith(`_to_${role}.handoff`));
export const handoffBody = (path: string) => {
  const text = readFile(path);
  const at = text.indexOf("\n\n");
  return at < 0 ? "" : text.slice(at + 2);
};

/** Run swarm_handoff; if it asks for the audit, run it a second time to submit. */
export function auditAndSubmitGitHandoff(opts: RunOpts, draft: string): Result {
  const first = run({ ...opts, ok: false }, script("swarm_handoff.sh"), draft);
  if (first.exit === 0 && first.out.includes("AUDIT_REQUIRED")) return run(opts, script("swarm_handoff.sh"), draft);
  return first;
}

export function makeQueuedHandoff(root: string, filename: string, attrs: HandoffAttrs = {}): string {
  const sha = attrs.commit ?? headSha(root);
  return putHandoff(root, "new", filename, {
    from: "sender", to: "receiver", recipient: "receiver", priority: "50", type: "git_handoff", task: "task-one",
    commit: sha, body: `merge_and_process sender ${sha}`, ...attrs,
  });
}

/** Commit a fresh change to slice.md in `root` so there is work to hand off. Returns the new HEAD. */
export function commitWork(root: string): string {
  writeFile(join(root, "slice.md"), `work ${process.hrtime.bigint()}\n`);
  run({ dir: root }, "git", "add", "slice.md");
  run({ dir: root }, "git", "commit", "-q", "-m", "Add slice");
  return headSha(root);
}

/** Queue a git handoff from `role` to `to` for `task`, with prose after the headers. */
export function queueGitFrom(root: string, role: string, to: string, task: string): Result {
  const draft = writeFile(join(root, "tmp", `${role}-${task}.handoff`),
    `type: git_handoff\nto: ${to}\npriority: 50\ntask: ${task}\n\nPlease also rewrite the layout.\n`);
  return auditAndSubmitGitHandoff({ dir: root, env: { SWARMFORGE_ROLE: role } }, draft);
}
