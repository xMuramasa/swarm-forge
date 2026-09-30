#!/usr/bin/env bun
// The handoff daemon: delivers each role's outbox to its recipients' inboxes, holds the master
// agent's spec for the operator's approval, moves board cards, and wakes the receiving agents.
//   handoffd.ts [--once] <project-root>

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import * as herdr from "./herdr.ts";
import { run as boardRun } from "./pack_board.ts";

const pollMs = 1000;
const wakeMessage = "You have new handoff mail. If idle, run ready_for_next.sh.";

type RoleInfo = { role: string; worktreeName: string; worktreePath: string; session: string };
type Roles = Map<string, RoleInfo>;
type Headers = Record<string, string>;
type Message = { headers: Headers; body: string };

type Ctx = { root: string; stateDir: string; daemonDir: string; rolesFile: string; pidFile: string; stopFile: string; logFile: string };
let ctx: Ctx;
let stopping = false;

export function configure(root: string): void {
  const stateDir = join(root, ".swarmforge");
  const daemonDir = join(stateDir, "daemon");
  ctx = {
    root, stateDir, daemonDir,
    rolesFile: join(stateDir, "roles.tsv"),
    pidFile: join(daemonDir, "handoffd.pid"),
    stopFile: join(daemonDir, "stop"),
    logFile: join(daemonDir, "handoffd.log"),
  };
}

const now = () => new Date().toISOString();

function log(...parts: unknown[]): void {
  mkdirSync(ctx.daemonDir, { recursive: true });
  appendFileSync(ctx.logFile, `${now()} ${parts.join(" ")}\n`);
}

const readLines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((_, i, all) => !(i === all.length - 1 && all[i] === "")) : [];

export function loadRoles(): Roles {
  const roles: Roles = new Map();
  for (const line of readLines(ctx.rolesFile)) {
    if (!line.trim()) continue;
    const [role, worktreeName, worktreePath, session] = line.split("\t");
    roles.set(role, { role, worktreeName, worktreePath, session });
  }
  return roles;
}

export function parseMessage(content: string): Message {
  const at = content.indexOf("\n\n");
  const head = at < 0 ? content : content.slice(0, at);
  const headers: Headers = {};
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(": ");
    if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return { headers, body: at < 0 ? "" : content.slice(at + 2) };
}

const parseFile = (path: string) => parseMessage(readFileSync(path, "utf8"));

const preferred = [
  "id", "from", "to", "recipient", "priority", "type", "role", "task_id", "task", "commit",
  "artifacts", "task_base_commit", "message", "created_at", "enqueued_at", "dequeued_at", "completed_at",
];

export function renderMessage(headers: Headers, body: string): string {
  const remaining = Object.keys(headers).filter((k) => !preferred.includes(k)).sort();
  const lines = [...preferred, ...remaining].filter((k) => headers[k]).map((k) => `${k}: ${headers[k]}`);
  return `${lines.join("\n")}\n\n${body}`;
}

const targetPath = (info: RoleInfo, filename: string) =>
  join(info.worktreePath, ".swarmforge", "handoffs", "inbox", "new", filename);

/** Wake the agent. The message is already in its inbox, so a refused wake (agent blocked on a
 *  dialog, or gone) is logged, not fatal: ready_for_next finds it later. */
function notify(session: string): void {
  try {
    herdr.prompt(session, wakeMessage);
  } catch (e) {
    log("wake-failed", session, (e as Error).message);
  }
}

function moveWithCollision(source: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  const base = basename(source);
  const target = join(targetDir, base);
  renameSync(source, existsSync(target) ? join(targetDir, `${now()}_${base}`) : target);
}

function fail(path: string, reason: string): void {
  const failedDir = join(dirname(dirname(path)), "failed");
  log("failed", path, reason);
  writeFileSync(`${path}.error`, `${reason}\n`);
  moveWithCollision(path, failedDir);
}

export function recipientList(headers: Headers): string[] {
  return (headers.to ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

const boardFile = () => join(ctx.root, ".swarmforge", "board", "tasks.tsv");

function board(...args: string[]): void {
  try {
    boardRun([...args, "--root", ctx.root]);
  } catch (e) {
    log("pack-board-failed", args.join(","), (e as Error).message);
    throw e;
  }
}

export const phantomSender = (from: string) => /^\(.+\)$/.test(from);

function archiveSender(headers: Headers): void {
  const from = headers.from ?? "";
  if (from.trim() && !phantomSender(from)) board("archive", "--role", from);
}

const masterRoleName = (roles: Roles) => [...roles.values()].find((r) => r.worktreeName === "master")?.role;
const specifierPack = (roles: Roles) => roles.has("specifier");
const fromMaster = (roles: Roles, headers: Headers) => headers.from === masterRoleName(roles);
export const nonForwarding = (headers: Headers) => headers["non-forwarding"] === "true";
const packRoleNames = () => readLines(ctx.rolesFile).filter((l) => l.trim()).map((l) => l.split("\t")[0]);
const lastPackRole = (role: string | undefined) => role === packRoleNames().at(-1);
const terminalHandoff = (headers: Headers) => lastPackRole(headers.from);

function listedHandoffs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".handoff") && statSync(join(dir, f)).isFile())
    .map((f) => join(dir, f));
}

function listedBatches(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("batch_") && statSync(join(dir, f)).isDirectory())
    .map((f) => join(dir, f));
}

function inboxHandoffs(info: RoleInfo, state: string): string[] {
  const dir = join(info.worktreePath, ".swarmforge", "handoffs", "inbox", state);
  return [...listedHandoffs(dir), ...listedBatches(dir).flatMap(listedHandoffs)];
}

const roleHasInboxState = (info: RoleInfo, state: string) => inboxHandoffs(info, state).length > 0;
const taskKey = (headers: Headers) => headers.task_id || headers.task;

function finishedTaskKeys(info: RoleInfo | undefined): Set<string> {
  if (!info) return new Set();
  const keys = [...inboxHandoffs(info, "completed"), ...inboxHandoffs(info, "in_process")]
    .map((f) => taskKey(parseFile(f).headers))
    .filter((k): k is string => !!k && !!k.trim());
  return new Set(keys);
}

const boardRowKey = (line: string) => {
  const [name, , , , taskId] = line.split("\t");
  return taskId || name;
};
const boardRowName = (line: string) => line.split("\t")[0];

function keysInLane(lane: string): string[] {
  const keys: string[] = [];
  for (const line of readLines(boardFile()).filter((l) => l.trim())) {
    const cols = line.split("\t");
    if (cols[1] !== lane) continue;
    for (const key of [boardRowKey(line), cols[0]]) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function terminalTaskKeys(roles: Roles, headers: Headers): string[] {
  const from = headers.from;
  const finished = finishedTaskKeys(roles.get(from));
  const inLane = new Set(keysInLane(from));
  const candidates = [taskKey(headers), ...[...inLane].filter((k) => finished.has(k))];
  return [...new Set(candidates.filter((k): k is string => !!k && !!k.trim()))];
}

function boardNameForKey(key: string | undefined): string | undefined {
  for (const line of readLines(boardFile())) {
    const name = boardRowName(line);
    if (key === boardRowKey(line) || key === name) return name;
  }
  return undefined;
}

function updateBoard(roles: Roles, headers: Headers): void {
  if (!existsSync(boardFile()) || headers.type !== "git_handoff" || !recipientList(headers).length) return;
  if (terminalHandoff(headers)) {
    for (const key of terminalTaskKeys(roles, headers)) {
      const name = boardNameForKey(key) ?? headers.task;
      if (name && name.trim()) board("done", "--name", name);
    }
  } else if (!nonForwarding(headers)) {
    const task = boardNameForKey(taskKey(headers)) ?? headers.task;
    if (task && task.trim()) board("move", "--name", task, "--lane", recipientList(headers)[0]);
  }
}

const singleRecipient = (headers: Headers) => recipientList(headers).length === 1;
const alreadyApproved = (headers: Headers) => !!(headers.approved ?? "").trim();

/** The master agent's spec waits in pending_approval until the operator runs `swarm approve`. */
export const shouldHold = (roles: Roles, headers: Headers) =>
  headers.type === "git_handoff" && specifierPack(roles) && fromMaster(roles, headers) &&
  singleRecipient(headers) && !alreadyApproved(headers);

const pendingDir = () => join(ctx.stateDir, "handoffs", "pending_approval");

function hold(path: string): void {
  moveWithCollision(path, pendingDir());
  log("held", path);
}

const sentDir = (roles: Roles, sender: string) =>
  phantomSender(sender)
    ? join(ctx.root, ".swarmforge", "handoffs", "sent")
    : join(roles.get(sender)!.worktreePath, ".swarmforge", "handoffs", "sent");

const approvedGitHandoff = (headers: Headers) => headers.type === "git_handoff" && !!(headers.approved ?? "").trim();

function outboxFiles(worktreePath: string): string[] {
  const outbox = join(worktreePath, ".swarmforge", "handoffs", "outbox");
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((f) => f.endsWith(".handoff") && statSync(join(outbox, f)).isFile())
    .sort()
    .map((f) => join(outbox, f));
}

const allOutboxFiles = (roles: Roles) => [
  ...new Set([...[...roles.values()].flatMap((r) => outboxFiles(r.worktreePath)), ...outboxFiles(ctx.root)]),
];

function activeOutboundGitFiles(roles: Roles, sender: string): string[] {
  if (!sender.trim()) return [];
  return [...listedHandoffs(pendingDir()), ...allOutboxFiles(roles)].filter((file) => {
    const { headers } = parseFile(file);
    return headers.type === "git_handoff" && headers.from === sender;
  });
}

function senderReadyWork(roles: Roles, sender: string): boolean {
  const info = roles.get(sender);
  return !!info && roleHasInboxState(info, "new") && !roleHasInboxState(info, "in_process") &&
    activeOutboundGitFiles(roles, sender).length === 0;
}

function maybeNotifyUnblockedSender(roles: Roles, headers: Headers, sender: string): void {
  if (approvedGitHandoff(headers) && senderReadyWork(roles, sender) && !recipientList(headers).includes(sender)) {
    notify(roles.get(sender)!.session);
    log("notified-unblocked-sender", sender);
  }
}

function deliver(roles: Roles, sender: string, path: string): void {
  const filename = basename(path);
  const message = parseFile(path);
  const recipients = recipientList(message.headers);
  if (!recipients.length) return fail(path, "missing to header");
  updateBoard(roles, message.headers);
  for (const recipient of recipients) {
    const info = roles.get(recipient);
    if (!info) throw new Error(`unknown recipient ${recipient}`);
    const target = targetPath(info, filename);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      writeFileSync(target, renderMessage({ ...message.headers, recipient, enqueued_at: now() }, message.body));
    }
    notify(info.session);
  }
  moveWithCollision(path, sentDir(roles, sender));
  archiveSender(message.headers);
  maybeNotifyUnblockedSender(roles, message.headers, sender);
  log("delivered", path);
}

const shouldStop = () => stopping || existsSync(ctx.stopFile);

function processOutboxFile(roles: Roles, path: string): void {
  const { headers } = parseFile(path);
  if (shouldHold(roles, headers)) hold(path);
  else deliver(roles, headers.from ?? "", path);
}

export function pollOnce(): void {
  if (shouldStop()) return;
  const roles = loadRoles();
  for (const path of allOutboxFiles(roles)) {
    if (shouldStop()) break;
    try {
      processOutboxFile(roles, path);
    } catch (e) {
      const message = (e as Error).message;
      log("error", path, message);
      try {
        fail(path, message);
      } catch (nested) {
        log("failed-to-archive", path, (nested as Error).message);
      }
    }
  }
}

function shutdown(): void {
  stopping = true;
  try {
    rmSync(ctx.pidFile, { force: true });
    log("stopped");
  } catch {
    // nothing left to clean up
  }
}

async function runDaemon(): Promise<void> {
  mkdirSync(ctx.daemonDir, { recursive: true });
  rmSync(ctx.stopFile, { force: true });
  writeFileSync(ctx.pidFile, `${process.pid}\n`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shutdown();
      process.exit(0);
    });
  }
  log("started");
  try {
    while (!shouldStop()) {
      pollOnce();
      for (let waited = 0; waited < pollMs && !shouldStop(); waited += 100) await Bun.sleep(100);
    }
  } finally {
    rmSync(ctx.pidFile, { force: true });
    log("stopped");
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const root = args.find((a) => a !== "--once");
  if (!root) {
    process.stderr.write("Usage: handoffd.ts [--once] <project-root>\n");
    process.exit(1);
  }
  configure(root);
  if (once) pollOnce();
  else await runDaemon();
}
