#!/usr/bin/env bun
// Queue a handoff: validate the agent's draft, make the sender audit a git handoff once,
// and write it (and any reverse copies) to the outbox for the handoff daemon.
//   swarm_handoff.sh <draft-file>

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ExitError, batchDirs, fail, gitToplevel, handoffFiles, headerField, idTimestamp, nextSequence,
  projectRoot as libProjectRoot, role as libRole, roleKnown, rolePropagation, rolesFile, splitLines,
  timestamp, validPriority, withLockDir,
} from "./handoff_lib.ts";
import { incrementAudit } from "./pack_board.ts";

export const usageText = `Usage:
  swarm_handoff.sh <draft-file>
  swarm_handoff.sh --help

Write the draft under ./tmp/ in the assigned worktree.
Do not use /tmp or the handoff outbox as scratch.

Draft formats:

type: git_handoff
to: <role>[,<role>...]
priority: NN
task: <short-stable-task-name>

The helper fills priority 50, commit, artifacts, and task_id from current work or the board card.
Do not type a SHA or a hidden task_id. Extra headers (coverage, CRAP) are invalid.
Extra lines after the headers are ignored.

type: note
to: <role>[,<role>...]
priority: NN
message: <one line, max 80 chars>`;

const reservedFields = new Set(["id", "from", "role", "recipient", "created_at", "enqueued_at", "dequeued_at", "completed_at", "task_base_commit", "non-forwarding"]);
const allowedFields = new Set(["type", "to", "priority", "task_id", "task", "commit", "message"]);
const allowedTypes = new Set(["git_handoff", "note"]);
const allowedFieldsByType: Record<string, Set<string>> = {
  git_handoff: new Set(["type", "to", "priority", "task_id", "task", "commit"]),
  note: new Set(["type", "to", "priority", "message"]),
};

type Headers = Record<string, string>;

// -- environment ------------------------------------------------------------------

const memo = <T>(f: () => T): (() => T) => {
  let value: { v: T } | undefined;
  return () => (value ??= { v: f() }).v;
};

/** Run a handoff_lib function that signals problems by throwing ExitError. */
function guard<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ExitError) fail(e.exit, e.message);
    throw e;
  }
}

const projectRoot = memo(() => guard(libProjectRoot));
const senderRole = memo(() => guard(libRole));
const stateDir = () => join(projectRoot(), ".swarmforge", "handoffs");

function git(dir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

const roleLines = () => splitLines(readFileSync(rolesFile(), "utf8"));
const packRoleNames = () => roleLines().filter((l) => l.trim()).map((l) => l.split("\t")[0]);
const roleWorktree = (role: string) => roleLines().map((l) => l.split("\t")).find((c) => c[0] === role && c.length >= 3)?.[2];
const gitCwd = memo(() => roleWorktree(senderRole()) || gitToplevel() || ".");

const inProcessDir = () => join(process.cwd(), ".swarmforge", "handoffs", "inbox", "in_process");

const taskIdOf = (file: string) => headerField(file, "task_id") || headerField(file, "task");
const inProcessTaskFiles = () => [...handoffFiles(inProcessDir()), ...batchDirs(inProcessDir()).flatMap(handoffFiles)];
const currentInProcessTaskId = () => {
  const [file] = inProcessTaskFiles();
  return file ? taskIdOf(file) : undefined;
};
const currentInProcessTask = () => {
  const [file] = inProcessTaskFiles();
  return file ? headerField(file, "task") : undefined;
};
const currentTaskBase = () => {
  const [file] = inProcessTaskFiles();
  return file ? headerField(file, "task_base_commit") : undefined;
};

// -- board ------------------------------------------------------------------------

type Card = { name: string; lane: string; id: string };

const boardFile = () => join(projectRoot(), ".swarmforge", "board", "tasks.tsv");
const boardPresent = () => existsSync(boardFile());

function boardCards(): Card[] {
  if (!boardPresent()) return [];
  return splitLines(readFileSync(boardFile(), "utf8"))
    .map((line) => line.split("\t"))
    .filter((cols) => cols[0]?.trim())
    .map(([name, lane, , , id]) => ({ name, lane, id: id || name }));
}

const cardsInLane = (lane: string) => boardCards().filter((c) => c.lane === lane);
const cardNamed = (name: string | undefined) => boardCards().find((c) => c.name === name);

// -- headers ----------------------------------------------------------------------

function withLaneTask(headers: Headers, sender: string): Headers {
  const cards = cardsInLane(sender);
  const draftedId = headers.task_id;
  const drafted = headers.task;
  if (cards.some((c) => c.id === draftedId)) return headers;
  if (draftedId?.trim()) return headers;
  const named = cards.find((c) => c.name === drafted);
  if (named) return { ...headers, task_id: named.id, task: named.name };
  if (cards.length === 1) return { ...headers, task_id: cards[0].id, task: cards[0].name };
  return headers;
}

function withInProcessTask(headers: Headers): Headers {
  const id = currentInProcessTaskId();
  const name = currentInProcessTask();
  return { ...headers, ...(id ? { task_id: id } : {}), ...(name ? { task: name } : {}) };
}

function withBoardTask(headers: Headers, sender: string): Headers {
  if (headers.type !== "git_handoff") return headers;
  if (headers.task_id?.trim()) return headers;
  if (currentInProcessTaskId()) return withInProcessTask(headers);
  const card = cardNamed(headers.task);
  const filled = card ? { ...headers, task_id: card.id, task: card.name } : withLaneTask(headers, sender);
  return !filled.task_id?.trim() && filled.task?.trim() ? { ...filled, task_id: filled.task } : filled;
}

const lastPackRole = (role: string) => role === packRoleNames().at(-1);

function reverseRoles(sender: string): string[] {
  const roles = packRoleNames();
  const idx = roles.indexOf(sender);
  if (idx < 0) return [];
  switch (rolePropagation(sender)) {
    case "back-one": return idx > 0 ? [roles[idx - 1]] : [];
    case "back-all": return roles.slice(0, idx);
    default: return [];
  }
}

const withNonForwarding = (headers: Headers, sender: string): Headers =>
  headers.type === "git_handoff" && lastPackRole(sender) ? { ...headers, "non-forwarding": "true" } : headers;

const inboundNonForwarding = () => inProcessTaskFiles().some((f) => headerField(f, "non-forwarding") === "true");

const worktreeHead = (): string => {
  const r = git(gitCwd(), "rev-parse", "--short=10", "HEAD");
  if (!r.ok) fail(1, "Cannot read HEAD commit.");
  return r.out.trim();
};

const fillCommit = (h: Headers): Headers => (h.type === "git_handoff" ? { ...h, commit: worktreeHead() } : h);
const fillPriority = (h: Headers): Headers => (validPriority(h.priority ?? "") ? h : { ...h, priority: "50" });

const prepareHeaders = (headers: Headers, sender: string) =>
  fillPriority(withNonForwarding(withBoardTask(fillCommit(headers), sender), sender));

// -- git --------------------------------------------------------------------------

function draftUnderTmp(draft: string): boolean {
  const dir = join(gitCwd(), "tmp");
  mkdirSync(dir, { recursive: true });
  return `${realpathSync(draft)}`.startsWith(`${realpathSync(dir)}/`);
}

const commitOnSenderBranch = (sha: string) => git(gitCwd(), "merge-base", "--is-ancestor", sha, "HEAD").ok;
const commitDescendsFrom = (base: string, sha: string) => git(gitCwd(), "merge-base", "--is-ancestor", base, sha).ok;

const namedFiles = (out: string) => [...new Set(splitLines(out).filter((l) => l.trim()))];

function commitArtifacts(sha: string): string[] {
  const base = currentTaskBase();
  if (base) return namedFiles(git(gitCwd(), "diff", "--name-only", "--diff-filter=ACMRT", base, sha).out);
  const parent = git(gitCwd(), "diff", "--name-only", "--diff-filter=ACMRT", `${sha}^`, sha);
  if (parent.ok) return namedFiles(parent.out);
  return namedFiles(git(gitCwd(), "diff-tree", "--root", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", "-r", sha).out);
}

// -- audit ------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(String(text), "utf8").digest("hex");

type Fingerprint = {
  sender: string; taskId: string; type: string; recipients: string[]; priority: string; task: string;
  commit: string; taskBaseCommit: string; nonForwarding: boolean; draftFingerprint: string;
};
type Candidate = Fingerprint & { version: number; artifacts: string[] };

const auditPendingDir = () => join(stateDir(), "audit_pending");
const senderAuditDir = (sender: string) => join(auditPendingDir(), sha256(sender));
const auditTaskId = (h: Headers) => h.task_id || h.task || "";
const auditFile = (sender: string, taskId: string) => join(senderAuditDir(sender), `${sha256(taskId)}.json`);

function senderAuditFiles(sender: string): string[] {
  const dir = senderAuditDir(sender);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
}

function readAudit(path: string): Candidate | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")).candidate;
  } catch {
    return undefined;
  }
}

function writeAudit(path: string, candidate: Candidate): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ candidate, createdAt: timestamp() })}\n`);
  renameSync(tmp, path);
}

const withAuditLock = <T>(f: () => T): T => withLockDir(join(auditPendingDir(), ".lock.d"), f);

function removeEmptySenderAuditDir(sender: string): void {
  const dir = senderAuditDir(sender);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

function deleteSenderAudits(sender: string): void {
  for (const path of senderAuditFiles(sender)) rmSync(path, { force: true });
  removeEmptySenderAuditDir(sender);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function invocationFingerprint(draft: string, sender: string, headers: Headers): Fingerprint {
  return {
    sender,
    taskId: auditTaskId(headers),
    type: headers.type,
    recipients: (headers.to ?? "").split(","),
    priority: headers.priority,
    task: headers.task,
    commit: headers.commit,
    taskBaseCommit: currentTaskBase() ?? "",
    nonForwarding: headers["non-forwarding"] === "true",
    draftFingerprint: sha256(readFileSync(draft, "utf8")),
  };
}

function invalidateChangedInvocationAudits(sender: string, invocation: Fingerprint): void {
  withAuditLock(() => {
    for (const path of senderAuditFiles(sender)) {
      const candidate = readAudit(path) as unknown as Record<string, unknown> | undefined;
      const changed = Object.entries(invocation).some(([key, value]) => !same(value, candidate?.[key]));
      if (changed) rmSync(path, { force: true });
    }
    removeEmptySenderAuditDir(sender);
  });
}

function auditCandidate(draft: string, sender: string, headers: Headers, recipients: string[], commit: string, artifacts: string[]): Candidate {
  return {
    version: 1,
    sender,
    taskId: auditTaskId(headers),
    type: headers.type,
    recipients: [...recipients],
    priority: headers.priority,
    task: headers.task,
    commit,
    artifacts: [...artifacts],
    taskBaseCommit: currentTaskBase() ?? "",
    nonForwarding: headers["non-forwarding"] === "true",
    draftFingerprint: sha256(readFileSync(draft, "utf8")),
  };
}

function printAuditRequired(candidate: Candidate): void {
  console.log(`AUDIT_REQUIRED
HANDOFF_NOT_QUEUED
TASK_ID: ${candidate.taskId}
COMMIT: ${candidate.commit}

Re-read the complete inbound task payload and every source it references.
Compare the completed work product against every requirement and constraint,
including interactions, boundaries, failure cases, and negative requirements.
Establish requirement-to-evidence traceability appropriate to your role:
every requirement must be covered by the work, supported by relevant verification,
or identified as a gap.
Review the complete committed diff, tests and checks, generated artifacts,
and unrelated working-tree changes. Passing tools or clean formatting alone do
not establish that the task is complete.
Fix every finding, commit the corrections, rerun applicable checks, and repeat
this audit against the revised candidate before running the handoff command again.`);
}

function incrementAuditCount(taskId: string): void {
  try {
    incrementAudit(projectRoot(), taskId);
  } catch (e) {
    fail(1, (e as Error).message);
  }
}

/** The first submission of a candidate only asks for an audit; the same candidate submitted
 *  again (unchanged) goes through. */
function submitAfterAudit<T>(candidate: Candidate, submit: () => T): T | undefined {
  return withAuditLock(() => {
    const path = auditFile(candidate.sender, candidate.taskId);
    if (same(candidate, readAudit(path))) {
      const result = submit();
      deleteSenderAudits(candidate.sender);
      return result;
    }
    deleteSenderAudits(candidate.sender);
    writeAudit(path, candidate);
    incrementAuditCount(candidate.taskId);
    printAuditRequired(candidate);
    return undefined;
  });
}

// -- validation -------------------------------------------------------------------

const rejectedTask = (card: Card | undefined) =>
  !!card?.name.trim() && existsSync(join(projectRoot(), ".swarmforge", "notify", `reject-${card.name}`));

export function currentWorkStateErrors(headers: Headers): string[] {
  if (headers.type !== "git_handoff") return [];
  const files = handoffFiles(inProcessDir());
  const batches = batchDirs(inProcessDir());
  const emptyBatches = batches.filter((b) => handoffFiles(b).length === 0);
  const errors: string[] = [];
  if (files.length && batches.length) errors.push("Ambiguous current work: both task and batch work are in process.");
  if (files.length > 1) errors.push("Ambiguous current work: multiple tasks are in process.");
  if (batches.length > 1) errors.push("Ambiguous current work: multiple batches are in process.");
  if (emptyBatches.length) errors.push(`Ambiguous current work: empty in-process batch ${emptyBatches[0]}.`);
  return errors;
}

export function taskStateErrors(headers: Headers): string[] {
  if (headers.type !== "git_handoff") return [];
  const taskId = headers.task_id || headers.task;
  const inProcessId = currentInProcessTaskId();
  const task = boardCards().find((c) => c.id === taskId);
  const errors: string[] = [];
  if (!taskId?.trim()) errors.push("Missing required header 'task_id' for git_handoff.");
  if (inProcessId && taskId !== inProcessId) {
    errors.push(`Handoff task_id '${taskId}' does not match current in-process task_id '${inProcessId}'.`);
  }
  if (boardPresent() && !inProcessId && !task) errors.push(`Handoff task_id '${taskId}' is not a current board task.`);
  if (task && task.lane === "done") errors.push(`Task '${task.name}' is done and cannot accept new handoffs.`);
  if (rejectedTask(task)) errors.push(`Task '${task!.name}' is rejected and must be retried before handoff.`);
  return errors;
}

function recursiveHandoffFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return recursiveHandoffFiles(path);
    return entry.isFile() && entry.name.endsWith(".handoff") ? [path] : [];
  });
}

const rolesWorktrees = () => roleLines().map((l) => l.split("\t")[2]).filter((wt) => wt?.trim());

const activeStates: [string, () => string[]][] = [
  ["pending approvals", () => [join(stateDir(), "pending_approval")]],
  ["sent", () => [join(stateDir(), "sent"), ...rolesWorktrees().map((wt) => join(wt, ".swarmforge", "handoffs", "sent"))]],
  ["recipient inbox", () => rolesWorktrees().flatMap((wt) => ["new", "in_process"].map((s) => join(wt, ".swarmforge", "handoffs", "inbox", s)))],
];

function headerMap(file: string): Headers {
  const map: Headers = {};
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    if (!line.trim()) break;
    const colon = line.indexOf(": ");
    if (colon > 0) map[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return map;
}

function sameActiveHandoff(sender: string, recipients: string[], headers: Headers, commit: string, path: string): boolean {
  const h = headerMap(path);
  const taskId = headers.task_id || headers.task;
  const otherId = h.task_id || h.task;
  const a = new Set(recipients);
  const b = new Set((h.to ?? "").split(","));
  return sender === h.from && a.size === b.size && [...a].every((r) => b.has(r)) && taskId === otherId && commit === h.commit;
}

function duplicateErrors(sender: string, recipients: string[], headers: Headers, commit: string): string[] {
  if (headers.type !== "git_handoff") return [];
  const matches: string[] = [];
  for (const [label, dirs] of activeStates) {
    for (const dir of dirs()) {
      for (const file of recursiveHandoffFiles(dir)) {
        if (sameActiveHandoff(sender, recipients, headers, commit, file)) matches.push(`${label}: ${file}`);
      }
    }
  }
  return matches.length ? [`Duplicate active handoff for same from/to/task_id/commit exists: ${matches.join(", ")}`] : [];
}

function ancestryErrors(headers: Headers, commit: string | undefined): string[] {
  if (headers.type !== "git_handoff") return [];
  const base = currentTaskBase();
  return base?.trim() && commit?.trim() && !commitDescendsFrom(base, commit)
    ? [`Result commit ${commit} is not a descendant of task base ${base}.`]
    : [];
}

type Draft = { headers: Headers; ordered: string[]; errors: string[] };

export function parseDraft(draft: string): Draft {
  const headers: Headers = {};
  const ordered: string[] = [];
  const errors: string[] = [];
  let bodySeen = false;
  splitLines(readFileSync(draft, "utf8")).forEach((line, index) => {
    const lineNo = index + 1;
    if (bodySeen || !line.trim() || !line.includes(": ")) {
      bodySeen = true;
      return;
    }
    const colon = line.indexOf(": ");
    const field = line.slice(0, colon);
    const value = line.slice(colon + 2);
    if (!field.trim() || !value.trim()) errors.push(`Line ${lineNo}: field and value must both be non-empty.`);
    else if (reservedFields.has(field)) errors.push(`Line ${lineNo}: header '${field}' is reserved and must not be written by agents.`);
    else if (!allowedFields.has(field)) errors.push(`Line ${lineNo}: unknown header '${field}'.`);
    else if (field in headers) errors.push(`Line ${lineNo}: duplicate header '${field}'.`);
    else {
      headers[field] = value;
      ordered.push(field);
    }
  });
  return { headers, ordered, errors };
}

const ensureField = (ordered: string[], field: string) => (ordered.includes(field) ? ordered : [...ordered, field]);

type Deps = {
  known: (role: string) => boolean;
  canonical: (commit: string) => [string | undefined, string | undefined];
};

const defaultDeps = (): Deps => ({ known: (role) => guard(() => roleKnown(role)), canonical: canonicalCommit });

export function validateRecipients(to: string | undefined, known = defaultDeps().known): [string[], string[]] {
  if (!to?.trim()) return [[], []];
  const recipients = to.split(",");
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const recipient of recipients) {
    if (!recipient.trim()) errors.push("Header 'to' contains an empty recipient.");
    if (recipient.includes("_")) errors.push(`Recipient role '${recipient}' is invalid; role names may not contain underscores.`);
    if (seen.has(recipient)) errors.push(`Duplicate recipient '${recipient}'.`);
    if (recipient.trim() && !known(recipient)) errors.push(`Unknown recipient role '${recipient}'.`);
    seen.add(recipient);
  }
  return [recipients, errors];
}

export function canonicalCommit(commit: string): [string | undefined, string | undefined] {
  const dir = gitCwd();
  const matches = splitLines(git(dir, "rev-parse", `--disambiguate=${commit}`).out);
  if (matches.length !== 1) {
    return [undefined, `Header 'commit' must resolve to exactly one Git object; '${commit}' matched ${matches.length}.`];
  }
  const object = matches[0];
  const type = git(dir, "cat-file", "-t", object).out.trim();
  if (type !== "commit") return [undefined, `Header 'commit' must resolve to a commit; '${commit}' resolves to '${type}'.`];
  return [git(dir, "rev-parse", "--short=10", object).out.trim(), undefined];
}

function commitCheck(
  type: string | undefined, commit: string | undefined, canonical = canonicalCommit,
): [string | undefined, string | undefined] {
  if (type !== "git_handoff") return [undefined, undefined];
  if (!commit?.trim()) return [undefined, "Missing required header 'commit' for git_handoff."];
  if (!/^[0-9a-fA-F]{10}$/.test(commit)) return [undefined, `Header 'commit' must be exactly 10 hexadecimal characters; got '${commit}'.`];
  return canonical(commit);
}

function baseErrors(headers: Headers): string[] {
  const { type, to, priority } = headers;
  const errors: string[] = [];
  if (!type?.trim()) errors.push("Missing required header 'type'.");
  if (!to?.trim()) errors.push("Missing required header 'to'.");
  if (!priority?.trim()) errors.push("Missing required header 'priority'.");
  if (type?.trim() && !allowedTypes.has(type)) errors.push(`Header 'type' must be one of git_handoff or note; got '${type}'.`);
  if (priority?.trim() && !validPriority(priority)) errors.push(`Header 'priority' must be two digits from 00 to 99; got '${priority}'.`);
  return errors;
}

const fieldErrors = (type: string | undefined, ordered: string[]) =>
  type ? ordered.filter((f) => !allowedFieldsByType[type]?.has(f)).map((f) => `Header '${f}' is not allowed for type '${type}'.`) : [];

function gitHeaderErrors(type: string | undefined, headers: Headers): string[] {
  const { task, commit } = headers;
  const errors: string[] = [];
  if (type === "git_handoff") {
    if (!headers.task_id?.trim()) errors.push("Missing required header 'task_id' for git_handoff.");
    if (!task?.trim()) errors.push("Missing required header 'task' for git_handoff.");
    if ((task ?? "").length > 80) errors.push(`Header 'task' must be no longer than 80 characters; got ${task!.length}.`);
  } else {
    if (commit?.trim()) errors.push("Header 'commit' is only allowed for git_handoff.");
    if (task?.trim()) errors.push("Header 'task' is only allowed for git_handoff.");
  }
  return errors;
}

function noteErrors(type: string | undefined, message: string | undefined): string[] {
  const errors: string[] = [];
  if (type === "note") {
    if (!message?.trim()) errors.push("Missing required header 'message' for note.");
    if ((message ?? "").length > 80) errors.push(`Header 'message' must be no longer than 80 characters; got ${message!.length}.`);
  } else if (message?.trim()) {
    errors.push("Header 'message' is only allowed for note.");
  }
  return errors;
}

export function validate(headers: Headers, ordered: string[], deps: Partial<Deps> = {}) {
  const { known, canonical: canonicalOf } = { ...defaultDeps(), ...deps };
  const [recipients, recipientErrors] = validateRecipients(headers.to, known);
  const [canonical, commitError] = commitCheck(headers.type, headers.commit, canonicalOf);
  return {
    recipients,
    canonicalCommit: canonical,
    errors: [
      ...baseErrors(headers), ...recipientErrors, ...fieldErrors(headers.type, ordered),
      ...gitHeaderErrors(headers.type, headers), ...(commitError ? [commitError] : []),
      ...noteErrors(headers.type, headers.message),
    ],
  };
}

// -- writing ----------------------------------------------------------------------

const structureInstruction = (handback: boolean) =>
  handback
    ? "The inbound tree is the structure. Replay this role's current task onto that shape."
    : "This role's current tree is the structure. Replay the inbound work onto that shape.";

type Ctx = {
  headers: Headers; recipients: string[]; canonicalCommit?: string; artifacts?: string; sender: string;
  priority?: string; nonForwarding?: boolean; reverse?: boolean;
};

function writeHandoff(ctx: Ctx): string {
  const { headers, recipients, canonicalCommit: commit, artifacts, sender } = ctx;
  const timestampId = idTimestamp();
  const createdAt = timestamp();
  const sequence = nextSequence(stateDir());
  const id = `${timestampId}_${sequence}_from_${sender}`;
  const priority = ctx.priority ?? headers.priority;
  const type = headers.type;
  const nonForwarding = ctx.nonForwarding ?? headers["non-forwarding"] === "true";
  const filename = `${priority}_${timestampId}_${sequence}_from_${sender}_to_${recipients.join("_")}.handoff`;
  const outbox = join(stateDir(), "outbox");
  const tmpDir = join(outbox, "tmp");
  const tmpFile = join(tmpDir, `${filename}.tmp`);
  const outboxFile = join(outbox, filename);
  const handback = ctx.reverse || nonForwarding;
  const body = type === "git_handoff"
    ? `Re-read your role and constitution.\n\nmerge_and_process.sh ${sender} ${commit}\n\n${structureInstruction(!!handback)}`
    : `Re-read your role and constitution.\n\n${headers.message}`;
  const base = currentTaskBase();
  const lines = [
    `id: ${id}`, `from: ${sender}`, `to: ${recipients.join(",")}`, `priority: ${priority}`, `type: ${type}`,
    ...(type === "git_handoff"
      ? [`role: ${sender}`, `task_id: ${headers.task_id}`, `task: ${headers.task}`, `commit: ${commit}`, `artifacts: ${artifacts}`]
      : []),
    ...(type === "git_handoff" && base?.trim() ? [`task_base_commit: ${base}`] : []),
    ...(nonForwarding ? ["non-forwarding: true"] : []),
    ...(type === "note" ? [`message: ${headers.message}`] : []),
    `created_at: ${createdAt}`, "", body,
  ];
  for (const dir of [tmpDir, outbox, join(stateDir(), "sent"), join(stateDir(), "failed")]) mkdirSync(dir, { recursive: true });
  writeFileSync(tmpFile, `${lines.join("\n")}\n`);
  renameSync(tmpFile, outboxFile);
  return outboxFile;
}

function writeHandoffs(ctx: Ctx): string[] {
  const forward = writeHandoff({ ...ctx, reverse: false });
  const reverse = ctx.headers.type === "git_handoff"
    ? reverseRoles(ctx.sender).map((role) => writeHandoff({ ...ctx, recipients: [role], priority: "00", nonForwarding: true, reverse: true }))
    : [];
  return [forward, ...reverse];
}

function completeCurrentAfterGitHandoff(headers: Headers): void {
  if (headers.type !== "git_handoff" || !inProcessTaskFiles().length) return;
  const r = spawnSync(join(dirname(import.meta.path), "done_with_current.sh"), [], { encoding: "utf8" });
  if (r.error) throw r.error;
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) fail(r.status ?? 1, "CURRENT COMPLETION FAILED after handoff queued.");
}

function errorReport(draft: string, errors: string[]): void {
  process.stderr.write(`HANDOFF INVALID: ${draft}\n\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n${usageText}\n`);
}

// -- main -------------------------------------------------------------------------

export function main(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(`${usageText}\n`);
    process.exit(0);
  }
  if (args.length !== 1) {
    process.stderr.write(`${usageText}\n`);
    process.exit(1);
  }
  const draft = args[0];
  if (!existsSync(draft) || !statSync(draft).isFile()) fail(1, `Draft file not found: ${draft}`);
  const sender = senderRole();
  if (!guard(() => roleKnown(sender))) fail(1, `Unknown sender role: ${sender}`);
  if (!draftUnderTmp(draft)) fail(1, `Draft must live in ./tmp/ in the assigned worktree; got ${draft}`);

  const parsed = parseDraft(draft);
  const headers = prepareHeaders(parsed.headers, sender);
  let ordered = ensureField(parsed.ordered, "priority");
  if (headers.type === "git_handoff") ordered = ensureField(ordered, "commit");
  const sha = headers.commit;
  invalidateChangedInvocationAudits(sender, invocationFingerprint(draft, sender, headers));

  if (headers.type === "git_handoff" && inboundNonForwarding()) fail(1, "Current inbound handoff is non-forwarding; do not send a git_handoff.");
  if (headers.type === "git_handoff" && !commitOnSenderBranch(sha)) fail(1, `Result commit ${sha} is not reachable from sender worktree`);

  const validation = validate(headers, ordered);
  const allErrors = [
    ...parsed.errors, ...validation.errors, ...currentWorkStateErrors(headers), ...taskStateErrors(headers),
    ...ancestryErrors(headers, validation.canonicalCommit),
    ...duplicateErrors(sender, validation.recipients, headers, validation.canonicalCommit ?? ""),
  ];
  if (allErrors.length) {
    errorReport(draft, allErrors);
    process.exit(2);
  }

  const isGit = headers.type === "git_handoff";
  const files = isGit ? commitArtifacts(sha) : undefined;
  if (isGit && !files!.length) fail(1, `Result commit ${sha} has no changed files`);
  const submit = () => writeHandoffs({
    headers, recipients: validation.recipients, canonicalCommit: validation.canonicalCommit,
    artifacts: files?.join(","), sender,
  });
  const queued = isGit
    ? submitAfterAudit(auditCandidate(draft, sender, headers, validation.recipients, validation.canonicalCommit ?? "", files!), submit)
    : submit();
  if (!queued) return;
  rmSync(draft);
  for (const file of queued) console.log(`HANDOFF QUEUED: ${file}`);
  completeCurrentAfterGitHandoff(headers);
}

if (import.meta.main) main(process.argv.slice(2));
