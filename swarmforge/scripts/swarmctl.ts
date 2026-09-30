#!/usr/bin/env bun
// Operator commands for a running swarm: status, task new, approve, reject.
// Reads and writes the same files the handoff daemon uses, and talks to the agents
// through the herdr CLI.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BoardError, createCard, incrementAudit, newTaskId } from "./pack_board.ts";

export { newTaskId };

const run = promisify(execFile);

export type Role = {
  role: string;
  worktree: string; // "master" or a worktree name
  path: string;
  agent: string; // herdr agent name
  display: string;
  backend: string;
};

export type Approval = {
  id: string;
  task: string;
  taskId: string;
  from: string;
  to: string;
  commit: string;
  artifacts: string[];
};

export type Card = { name: string; lane: string; id: string; auditCount: number };

export class CliError extends Error {}

// -- files ------------------------------------------------------------------

const state = (root: string, ...parts: string[]) => join(root, ".swarmforge", ...parts);

export function parseMessage(text: string): { headers: Record<string, string>; body: string } {
  const at = text.indexOf("\n\n");
  const head = at < 0 ? text : text.slice(0, at);
  const headers: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(": ");
    if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return { headers, body: at < 0 ? "" : text.slice(at + 2) };
}

const commaList = (text = ""): string[] =>
  text.split(",").map((s) => s.trim()).filter(Boolean);

function handoffFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".handoff")).sort();
}

export function readRoles(root: string): Role[] {
  const file = state(root, "roles.tsv");
  if (!existsSync(file)) throw new CliError(`No swarm state at ${root} (missing .swarmforge/roles.tsv).`);
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const [role, worktree, path, agent, display, backend] = line.split("\t");
    return { role, worktree, path, agent: agent || `sf-${role}`, display, backend };
  });
}

export function masterRole(roles: Role[]): Role {
  const master = roles.find((r) => r.worktree === "master");
  if (!master) throw new CliError("No role on the master worktree.");
  return master;
}

export function readCards(root: string): Card[] {
  const file = state(root, "board", "tasks.tsv");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const [name, lane, , , id, audit] = line.split("\t");
    return { name, lane, id: id || name, auditCount: /^\d+$/.test(audit ?? "") ? Number(audit) : 0 };
  });
}

const pendingDir = (root: string) => state(root, "handoffs", "pending_approval");

export function readApprovals(root: string): Approval[] {
  return handoffFiles(pendingDir(root)).map((file) => {
    const { headers } = parseMessage(readFileSync(join(pendingDir(root), file), "utf8"));
    return {
      id: file.replace(/\.handoff$/, ""),
      task: headers.task ?? "",
      taskId: headers.task_id || headers.task || "",
      from: headers.from ?? "",
      to: commaList(headers.to)[0] ?? "",
      commit: headers.commit ?? "",
      artifacts: commaList(headers.artifacts),
    };
  });
}

/** The handoffs a role is working on or has queued: [new count, in-process task names]. */
export function inbox(role: Role): { queued: number; working: string[] } {
  const base = join(role.path, ".swarmforge", "handoffs", "inbox");
  const working: string[] = [];
  const inProcess = join(base, "in_process");
  const dirs = existsSync(inProcess)
    ? [inProcess, ...readdirSync(inProcess, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(inProcess, e.name))]
    : [];
  for (const dir of dirs) {
    for (const file of handoffFiles(dir)) {
      const task = parseMessage(readFileSync(join(dir, file), "utf8")).headers.task;
      if (task && !working.includes(task)) working.push(task);
    }
  }
  return { queued: handoffFiles(join(base, "new")).length, working };
}

// -- herdr --------------------------------------------------------------------

/** herdr status of an agent (idle, working, blocked, ...), or null when it is gone. */
export async function agentStatus(agent: string): Promise<string | null> {
  try {
    const { stdout } = await run("herdr", ["agent", "get", agent]);
    return JSON.parse(stdout).result?.agent?.agent_status ?? "unknown";
  } catch {
    return null;
  }
}

/** herdr delivers multi-line text as a paste that Claude does not answer, so send one line. */
const oneLine = (text: string) => text.replace(/\s*[\r\n\t]+\s*/g, " ");

async function prompt(agent: string, text: string): Promise<string | null> {
  try {
    await run("herdr", ["agent", "prompt", agent, oneLine(text)]);
    return null;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? "";
    try {
      return JSON.parse(out).error?.message ?? String(e);
    } catch {
      return String(e);
    }
  }
}

// -- status -------------------------------------------------------------------

export type Status = {
  project: string;
  branch: string;
  roles: { role: string; agent: string; state: string; queued: number; working: string[] }[];
  tasks: (Card & { status: string })[];
  approvals: Approval[];
};

async function currentBranch(root: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", root, "symbolic-ref", "--short", "-q", "HEAD"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function collectStatus(root: string): Promise<Status> {
  const roles = readRoles(root);
  const approvals = readApprovals(root);
  const [states, branch] = await Promise.all([
    Promise.all(roles.map((r) => agentStatus(r.agent))),
    currentBranch(root),
  ]);
  const rows = roles.map((r, i) => ({
    role: r.role,
    agent: r.agent,
    state: states[i] ?? "no agent",
    ...inbox(r),
  }));
  const tasks = readCards(root).map((card) => {
    const row = rows.find((r) => r.role === card.lane);
    const waiting = approvals.some((a) => a.taskId === card.id || a.task === card.name);
    const status =
      card.lane === "done" ? "done"
      : waiting ? "waiting for your approval"
      : row?.working.includes(card.name) ? "in progress"
      : "queued";
    return { ...card, status };
  });
  return { project: basename(root), branch, roles: rows, tasks, approvals };
}

const pad = (text: string, width: number) => text.padEnd(width);

export function formatStatus(s: Status): string {
  const out: string[] = [`${s.project}${s.branch ? `  (branch ${s.branch})` : ""}`, "", "Roles"];
  const width = Math.max(...s.roles.map((r) => r.role.length), 4) + 2;
  for (const r of s.roles) {
    const note =
      r.state === "blocked" ? "  <- waiting for input in herdr"
      : r.working.length ? `  working on: ${r.working.join(", ")}`
      : r.queued ? `  ${r.queued} queued` : "";
    out.push(`  ${pad(r.role, width)}${pad(r.state, 10)}${note}`.trimEnd());
  }
  out.push("", "Tasks");
  if (!s.tasks.length) out.push("  none");
  const nameWidth = Math.max(...s.tasks.map((t) => t.name.length), 4) + 2;
  for (const t of s.tasks) out.push(`  ${pad(t.name, nameWidth)}${pad(t.lane, 12)}${t.status}`);
  if (s.approvals.length) {
    out.push("", 'Waiting for your approval  (swarm approve <id> | swarm reject <id> "comments")');
    for (const a of s.approvals) {
      out.push(`  ${a.id}`, `    ${a.task || "(no task)"}: ${a.from} -> ${a.to}${a.commit ? `  commit ${a.commit.slice(0, 8)}` : ""}`);
      if (a.artifacts.length) out.push(`    artifacts: ${a.artifacts.join(", ")}`);
    }
  }
  return out.join("\n");
}

// -- approvals --------------------------------------------------------------------

/** An approval by id, by unique id prefix, or by task name when only one is pending. */
export function findApproval(root: string, ref: string): Approval {
  const all = readApprovals(root);
  const exact = all.find((a) => a.id === ref);
  if (exact) return exact;
  const matches = all.filter((a) => a.id.startsWith(ref) || a.task === ref);
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new CliError(`No pending approval matches '${ref}'.${all.length ? ` Pending: ${all.map((a) => a.id).join(", ")}` : " Nothing is waiting for approval."}`);
  throw new CliError(`'${ref}' matches ${matches.length} approvals: ${matches.map((a) => a.id).join(", ")}`);
}

export const withApproved = (content: string) =>
  /^approved: /m.test(content) ? content : content.replace("\n\n", "\napproved: true\n\n");

function dropApproval(root: string, id: string) {
  rmSync(join(pendingDir(root), `${id}.handoff`), { force: true });
  rmSync(join(pendingDir(root), `${id}.reviews.json`), { force: true });
}

export function approve(root: string, ref: string): Approval {
  const approval = findApproval(root, ref);
  const file = join(pendingDir(root), `${approval.id}.handoff`);
  const outbox = state(root, "handoffs", "outbox");
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, `${approval.id}.handoff`), withApproved(readFileSync(file, "utf8")));
  dropApproval(root, approval.id);
  return approval;
}

/** Discard the pending spec and tell the master agent what to change. Returns a warning if it could not be reached. */
export async function reject(root: string, ref: string, comments: string): Promise<{ approval: Approval; warning: string | null }> {
  if (!comments.trim()) throw new CliError("Say what to change: swarm reject <id> \"comments\"");
  const approval = findApproval(root, ref);
  dropApproval(root, approval.id);
  const card = readCards(root).find((c) => c.id === approval.taskId || c.name === approval.task);
  if (card) {
    try {
      incrementAudit(root, card.id);
    } catch {
      // the card is gone: the spec is still discarded
    }
  }
  const master = masterRole(readRoles(root));
  const warning = await prompt(
    master.agent,
    `The operator rejected your spec for task "${approval.task}". Comments: ${comments.trim()} ` +
      `Revise it, commit, and send a new git_handoff to ${approval.to || "the next role"}.`,
  );
  return { approval, warning };
}

// -- new task -------------------------------------------------------------------

const slugUnderscore = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "_");

export function noteContent(taskId: string, name: string, to: string, text: string, now = new Date()): { file: string; content: string } {
  const iso = now.toISOString();
  const stamp = iso.replace(/[^0-9A-Za-z]/g, "");
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return {
    file: `50_${stamp}_from_New_Task_to_${slugUnderscore(to)}.handoff`,
    content:
      `id: ${stamp}_from_New_Task\nfrom: (New Task)\nto: ${to}\npriority: 50\ntype: note\n` +
      `task_id: ${taskId}\ntask: ${name}\ncreated_at: ${iso}\n\n${body}`,
  };
}

export async function createTask(root: string, name: string, text: string): Promise<string> {
  if (!name.trim()) throw new CliError("Missing task name.");
  const master = masterRole(readRoles(root));
  const taskId = newTaskId(name);
  try {
    createCard(root, name, master.role, taskId, text);
  } catch (e) {
    if (e instanceof BoardError) throw new CliError(e.message);
    throw e;
  }
  const note = noteContent(taskId, name, master.role, text);
  const outbox = state(root, "handoffs", "outbox");
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, note.file), note.content);
  return taskId;
}

// -- cli --------------------------------------------------------------------------

const usage = `Usage: swarm <command>
  status [--json]                    roles, tasks and what is waiting for you
  task new <name> [text...]          create a task (--file <path> reads the text from a file)
  approve <id>                       release a spec the specifier submitted
  reject <id> <comments...>          send a spec back with your comments
Options: --root <dir> (default: this project)`;

async function projectRoot(explicit?: string): Promise<string> {
  if (explicit) return resolve(explicit);
  try {
    const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return dirname(stdout.trim());
  } catch {
    return process.cwd();
  }
}

function takeFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
}

function takeOption(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const explicitRoot = takeOption(args, "--root");
  const file = takeOption(args, "--file");
  const json = takeFlag(args, "--json");
  const [command, sub, ...rest] = args;
  try {
    if (!command || command === "help" || command === "--help") {
      console.log(usage);
      return command ? 0 : 1;
    }
    const root = await projectRoot(explicitRoot);
    switch (command) {
      case "status": {
        const status = await collectStatus(root);
        console.log(json ? JSON.stringify(status, null, 2) : formatStatus(status));
        return 0;
      }
      case "task": {
        if (sub !== "new" || !rest.length) throw new CliError("Usage: swarm task new <name> [text...]");
        const [name, ...words] = rest;
        const text = file ? readFileSync(file, "utf8") : words.join(" ");
        await createTask(root, name, text);
        console.log(`Created task '${name}' and sent it to the ${masterRole(readRoles(root)).role}.`);
        return 0;
      }
      case "approve": {
        if (!sub) throw new CliError("Usage: swarm approve <id>");
        const approval = approve(root, sub);
        console.log(`Approved ${approval.id}. The handoff daemon will deliver it to ${approval.to}.`);
        return 0;
      }
      case "reject": {
        if (!sub) throw new CliError('Usage: swarm reject <id> "comments"');
        const { approval, warning } = await reject(root, sub, rest.join(" "));
        console.log(`Rejected ${approval.id}. Your comments went to the ${masterRole(readRoles(root)).role}.`);
        if (warning) console.error(`Warning: could not reach the agent (${warning}). Tell it yourself in its pane.`);
        return 0;
      }
      default:
        throw new CliError(`Unknown command '${command}'.\n${usage}`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
