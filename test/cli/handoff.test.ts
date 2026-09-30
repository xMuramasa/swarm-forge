import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  addWorktree, auditAndSubmitGitHandoff, auditFiles, auditPendingDir, auditSenderDirs, boardAuditCount,
  emptyAuditSenderDirs, exists, fake, handoffPath, handoffText, headSha, header, initRepo, isDir, listFiles,
  commitWork, handoffBody, makeQueuedHandoff, outboxHandoffs, outboxTo, putHandoff, queueGitFrom, queuedPath,
  readFile, repoRoot, run, script, setupProject, tmpDir, writeFile,
} from "./support.ts";

const swarmHandoff = script("swarm_handoff.sh");
const readyForNext = script("ready_for_next.sh");
const doneWithCurrent = script("done_with_current.sh");
const senderEnv = { SWARMFORGE_ROLE: "sender" };
const receiverEnv = { SWARMFORGE_ROLE: "receiver" };
const roles = (root: string, sender: string, receiver: string, modes = "task\ntask") =>
  writeFile(join(root, ".swarmforge/roles.tsv"), `sender\t${sender}\t${sender === "master" ? root : sender}\tsession\tSender\tcodex\t${modes.split("\n")[0]}\nreceiver\treceiver\t${receiver}\tsession\tReceiver\tcodex\t${modes.split("\n")[1]}\n`);

const inbox = (root: string, state: string) => join(root, ".swarmforge/handoffs/inbox", state);
const nextNote = { id: "next", from: "(New Task)", to: "sender", recipient: "sender", priority: "50", type: "note", taskId: "task-two", task: "task-two", body: "next task" };
const pendingText = "from: sender\nto: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\n\npayload\n";

describe("swarm_handoff", () => {
  test("--help and -h print usage and are not a missing draft", () => {
    for (const flag of ["--help", "-h"]) {
      const r = run({ dir: repoRoot, ok: false }, swarmHandoff, flag);
      const text = r.err + r.out;
      expect(r.exit).toBe(0);
      expect(text).toContain("Usage:");
      expect(text).not.toContain("Draft file not found");
    }
  });

  test("queues on the project from a worktree, with the worktree's HEAD", () => {
    const root = tmpDir();
    initRepo(root);
    const wt = addWorktree(root, "sender");
    setupProject(root);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tsender\t${wt}\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t${root}\tsession\tReceiver\tcodex\ttask\n`);
    writeFile(join(wt, "slice.md"), "from the worktree\n");
    run({ dir: wt }, "git", "add", "slice.md");
    run({ dir: wt }, "git", "commit", "-q", "-m", "Worktree slice");
    const wtHead = headSha(wt);
    const masterHead = headSha(root);
    expect(wtHead).not.toBe(masterHead);
    const draft = writeFile(join(wt, "tmp", "from-wt.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ntask: task-from-worktree\ncommit: ${wtHead}\n`);
    const result = auditAndSubmitGitHandoff({ dir: wt, env: senderEnv }, draft);
    const queued = queuedPath(result.out)!;
    const content = readFile(queued);
    expect(result.exit).toBe(0);
    expect(realpathSync(queued).startsWith(realpathSync(join(root, ".swarmforge/handoffs/outbox")))).toBe(true);
    expect(queued).not.toContain("/.worktrees/");
    expect(content).toContain(`commit: ${wtHead}\n`);
    expect(content).not.toContain(`commit: ${masterHead}\n`);
  });

  test("infers the role from the worktree and fills the worktree HEAD", () => {
    const root = tmpDir();
    initRepo(root);
    const wt = addWorktree(root, "sender");
    setupProject(root);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tsender\t${wt}\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t${root}\tsession\tReceiver\tcodex\ttask\n`);
    writeFile(join(wt, "slice.md"), "from the worktree\n");
    run({ dir: wt }, "git", "add", "slice.md");
    run({ dir: wt }, "git", "commit", "-q", "-m", "Worktree slice");
    const wtHead = headSha(wt);
    const masterHead = headSha(root);

    const noEnv = writeFile(join(wt, "tmp", "no-env.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ntask: inferred-role\ncommit: ${wtHead}\n`);
    const inferred = auditAndSubmitGitHandoff({ dir: wt, ok: false }, noEnv);
    expect(inferred.exit).toBe(0);
    expect(readFile(queuedPath(inferred.out)!)).toContain("from: sender\n");

    const wrong = writeFile(join(wt, "tmp", "wrong-sha.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ntask: ignore-typed-sha\ncommit: ${masterHead}\n`);
    const filled = auditAndSubmitGitHandoff({ dir: wt, env: senderEnv, ok: false }, wrong);
    expect(filled.exit).toBe(0);
    const content = readFile(queuedPath(filled.out)!);
    expect(content).toContain(`commit: ${wtHead}\n`);
    expect(content).not.toContain(`commit: ${masterHead}\n`);

    const omitted = writeFile(join(wt, "tmp", "no-commit.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: omit-commit\n");
    const omit = auditAndSubmitGitHandoff({ dir: wt, env: senderEnv, ok: false }, omitted);
    expect(omit.exit).toBe(0);
    expect(readFile(queuedPath(omit.out)!)).toContain(`commit: ${wtHead}\n`);
  });

  test("rejects drafts outside the worktree's tmp", () => {
    const root = tmpDir();
    const commit = initRepo(root);
    setupProject(root);
    const bad = join("/tmp", `swarmforge-bad-draft-${Date.now()}.handoff`);
    try {
      writeFile(bad, `type: git_handoff\nto: receiver\npriority: 50\ntask: scratch-tmp\ncommit: ${commit}\n`);
      const r = run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, bad);
      expect(r.exit).toBe(1);
      expect(r.err + r.out).toContain("./tmp/");
      expect(exists(bad)).toBe(true);
    } finally {
      rmSync(bad, { force: true });
    }
    const outboxDraft = writeFile(join(root, ".swarmforge/handoffs/outbox/tmp/htw-console-app-coder.draft"),
      `type: git_handoff\nto: receiver\npriority: 50\ntask: outbox-scratch\ncommit: ${commit}\n`);
    const r = run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, outboxDraft);
    expect(r.exit).toBe(1);
    expect(r.err + r.out).toContain("./tmp/");
    expect(exists(outboxDraft)).toBe(true);
  });

  test("validates and queues git handoffs", () => {
    const root = tmpDir();
    const commit = initRepo(root);
    setupProject(root);
    const missing = writeFile(join(root, "tmp", "missing-task.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ncommit: ${commit}\n`);
    const bad = run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, missing);
    expect(bad.exit).toBe(2);
    expect(bad.err).toContain("Missing required header 'task'");
    expect(exists(missing)).toBe(true);

    const draft = writeFile(join(root, "tmp", "valid.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ntask: task-1-cave-setup\ncommit: ${commit}\n`);
    const result = auditAndSubmitGitHandoff({ dir: root, env: senderEnv }, draft);
    const queued = queuedPath(result.out)!;
    const content = readFile(queued);
    expect(content).toContain("task: task-1-cave-setup\n");
    expect(content).toContain(`commit: ${commit}\n`);
    expect(content).toContain("artifacts: README.md\n");
    expect(content).toContain(`merge_and_process.sh sender ${commit}`);
    expect(exists(queued)).toBe(true);
    expect(exists(draft)).toBe(false);
  });

  test("a draft naming a different task id than the in-process one is rejected", () => {
    const root = tmpDir();
    const commit = initRepo(root);
    setupProject(root);
    writeFile(join(root, ".swarmforge/board/tasks.tsv"), "Visible Task\tsender\tcreated\tupdated\t20260825T120000000000Z-visible-task\n");
    putHandoff(root, "in_process", "50_current.handoff", {
      id: "current", from: "master", to: "sender", recipient: "sender", priority: "50", type: "note",
      taskId: "20260825T120000000000Z-visible-task", task: "Visible Task",
    });
    const draft = writeFile(join(root, "tmp", "stale.handoff"),
      `type: git_handoff\nto: receiver\npriority: 50\ntask_id: old-task-id\ntask: Visible Task\ncommit: ${commit}\n`);
    const r = run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, draft);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("does not match current in-process task_id");
    expect(listFiles(join(root, ".swarmforge/handoffs/outbox"), ".handoff")).toEqual([]);
  });

  test("fills the task id from the in-process task for a name-only draft", () => {
    const root = tmpDir();
    const commit = initRepo(root);
    const hidden = "20260826T162611432618Z-htw";
    setupProject(root);
    writeFile(join(root, ".swarmforge/board/tasks.tsv"), `HTW\tcoder\tcreated\tupdated\t${hidden}\nextras\tsender\tcreated\tupdated\textras-id\n`);
    putHandoff(root, "in_process", "50_retry.handoff", {
      id: "retry", from: "(Retry)", to: "sender", recipient: "sender", priority: "50", type: "note", taskId: hidden, task: "HTW",
    });
    const draft = writeFile(join(root, "tmp", "htw.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ntask: HTW\ncommit: ${commit}\n`);
    const result = auditAndSubmitGitHandoff({ dir: root, env: senderEnv }, draft);
    const queued = queuedPath(result.out);
    expect(result.exit).toBe(0);
    expect(queued).toBeDefined();
    const content = readFile(queued!);
    expect(content).toContain(`task_id: ${hidden}\n`);
    expect(content).toContain("task: HTW\n");
    expect(result.err + result.out).not.toContain("does not match");
  });

  test("help does not ask for a hidden task id", () => {
    const r = run({ dir: repoRoot, ok: false }, swarmHandoff, "--help");
    const text = r.err + r.out;
    expect(r.exit).toBe(0);
    expect(text).toContain("task: <short-stable-task-name>");
    expect(text).not.toContain("task_id: <hidden-task-id>");
  });
});

describe("project root", () => {
  test("pack_board and handoff_lib agree on the project root from a worktree", () => {
    const root = tmpDir();
    initRepo(root);
    const wt = addWorktree(root, "coder");
    setupProject(root, { coder: "task" });
    writeFile(join(root, ".swarmforge/roles.tsv"), `coder\tmaster\t${wt}\tsession\tCoder\tcodex\ttask\n`);
    run({ dir: root }, script("pack_board.sh"), "create", "--name", "HTW", "--lane", "coder", "--root", root);
    const fromLib = run({ dir: wt }, script("handoff_lib.ts"), "project-root");
    const listed = run({ dir: wt }, script("pack_board.sh"), "list");
    expect(realpathSync(root)).toBe(realpathSync(fromLib.out.trim()));
    expect(listed.out).toContain("HTW");
  });
});

describe("ready_for_next", () => {
  test("prints a (New Task) note's task name and body", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { receiver: "task" });
    makeQueuedHandoff(root, "50_20260615T000001Z_000001_from_New_Task_to_receiver.handoff", {
      id: "20260615T000001Z_000001_from_New_Task", from: "(New Task)", type: "note", task: "Holy Hand Grenade",
      body: "The grenade is placed at setup.\n",
    });
    const r = run({ dir: root, env: receiverEnv }, readyForNext);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("FROM: (New Task)");
    expect(r.out).toContain("TYPE: note");
    expect(r.out).toContain("TASK_NAME: Holy Hand Grenade");
    expect(r.out).toContain("The grenade is placed at setup.");
  });

  test("accepts one task, then resumes it before any queued task", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { receiver: "task" });
    makeQueuedHandoff(root, "50_20260615T000001Z_000001_from_sender_to_receiver.handoff", { id: "20260615T000001Z_000001_from_sender", task: "task-alpha" });
    const first = run({ dir: root, env: receiverEnv }, readyForNext);
    const inProcess = join(inbox(root, "in_process"), "50_20260615T000001Z_000001_from_sender_to_receiver.handoff");
    expect(first.out).toContain("TASK:");
    expect(first.out).toContain("TASK_NAME: task-alpha");
    expect(exists(inProcess)).toBe(true);
    expect(header(inProcess, "dequeued_at")).toBeDefined();

    makeQueuedHandoff(root, "40_20260615T000002Z_000002_from_sender_to_receiver.handoff", { id: "20260615T000002Z_000002_from_sender", priority: "40", task: "task-beta" });
    const second = run({ dir: root, env: receiverEnv }, readyForNext);
    expect(second.out).toContain("task-alpha");
    expect(exists(join(inbox(root, "new"), "40_20260615T000002Z_000002_from_sender_to_receiver.handoff"))).toBe(true);
  });

  const waitingProject = (mode: string, place: "pending_approval" | "outbox") => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { sender: mode, receiver: "task" });
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tmaster\t${root}\tsession\tSender\tcodex\t${mode}\nreceiver\treceiver\t${join(root, ".worktrees/receiver")}\tsession\tReceiver\tcodex\ttask\n`);
    writeFile(join(root, ".swarmforge/handoffs", place, "50_pending.handoff"), pendingText);
    putHandoff(root, "new", "50_next.handoff", nextNote);
    return root;
  };

  test("waits while an outbound handoff is pending approval", () => {
    const root = waitingProject("task", "pending_approval");
    const r = run({ dir: root, env: senderEnv, ok: false }, readyForNext);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("WAITING_FOR_APPROVAL");
    expect(exists(join(inbox(root, "new"), "50_next.handoff"))).toBe(true);
    expect(listFiles(inbox(root, "in_process"), ".handoff")).toEqual([]);
  });

  test("waits while an outbound handoff is still in the outbox", () => {
    const root = waitingProject("task", "outbox");
    const r = run({ dir: root, env: senderEnv, ok: false }, readyForNext);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("WAITING_FOR_APPROVAL");
    expect(exists(join(inbox(root, "new"), "50_next.handoff"))).toBe(true);
    expect(listFiles(inbox(root, "in_process"), ".handoff")).toEqual([]);
  });

  test("batch mode waits too, and creates no batch", () => {
    const root = waitingProject("batch", "pending_approval");
    const r = run({ dir: root, env: senderEnv, ok: false }, readyForNext);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("WAITING_FOR_APPROVAL");
    expect(exists(join(inbox(root, "new"), "50_next.handoff"))).toBe(true);
    expect(listFiles(inbox(root, "in_process")).filter((f) => f.includes("batch_"))).toEqual([]);
  });

  test("starts the next task once the prior approved handoff is in the receiver's process", () => {
    const root = tmpDir();
    const receiver = join(root, ".worktrees/receiver");
    initRepo(root);
    setupProject(root);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tmaster\t${root}\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t${receiver}\tsession\tReceiver\tcodex\ttask\n`);
    writeFile(join(receiver, ".swarmforge/handoffs/inbox/in_process/50_prior.handoff"),
      "from: sender\nto: receiver\nrecipient: receiver\npriority: 50\ntype: git_handoff\ntask_id: task-one\ntask: task-one\ncommit: 1234567890\napproved: true\n\npayload\n");
    putHandoff(root, "new", "50_next.handoff", nextNote);
    const r = run({ dir: root, env: senderEnv }, readyForNext);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("TASK_NAME: task-two");
    expect(exists(join(inbox(root, "in_process"), "50_next.handoff"))).toBe(true);
    expect(exists(join(inbox(root, "new"), "50_next.handoff"))).toBe(false);
  });

  test("batch mode groups the handoffs of the top priority", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { receiver: "batch" });
    for (const [n, priority, task] of [["1", "10", "task-a"], ["2", "10", "task-b"], ["3", "20", "task-c"]]) {
      makeQueuedHandoff(root, `${priority}_20260615T00000${n}Z_00000${n}_from_sender_to_receiver.handoff`, { id: `20260615T00000${n}Z_00000${n}_from_sender`, priority, task });
    }
    const r = run({ dir: root, env: receiverEnv }, readyForNext);
    const lines = r.out.split("\n");
    const batchDir = lines.find((l) => l.startsWith("BATCH: "))!.slice(7);
    expect(r.out).toContain("COUNT: 2");
    expect(r.out).toContain("TASK_NAME: task-a");
    expect(r.out).toContain("TASK_NAME: task-b");
    expect(r.out).not.toContain("TASK_NAME: task-c");
    const batchAt = lines.findIndex((l) => l.startsWith("BATCH:"));
    const nameAt = lines.findIndex((l) => l.startsWith("TASK_NAME:"));
    const itemAt = lines.findIndex((l) => l.startsWith("BATCH_ITEM:"));
    expect(batchAt).toBeLessThan(nameAt);
    expect(nameAt).toBeLessThan(itemAt);
    expect(lines[nameAt]).toBe("TASK_NAME: task-a");
    expect(listFiles(batchDir, ".handoff").length).toBe(2);
    expect(exists(join(inbox(root, "new"), "20_20260615T000003Z_000003_from_sender_to_receiver.handoff"))).toBe(true);
  });
});

describe("handoffd wakes", () => {
  test("wakes the receiver and the sender that the approved handoff unblocks", () => {
    const root = tmpDir();
    const receiver = join(root, ".worktrees/receiver");
    initRepo(root);
    setupProject(root);
    fake.addAgents(root, ["sender-session", "receiver-session"]);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tmaster\t${root}\tsender-session\tSender\tcodex\ttask\nreceiver\treceiver\t${receiver}\treceiver-session\tReceiver\tcodex\ttask\n`);
    writeFile(join(root, ".swarmforge/handoffs/outbox/50_approved.handoff"), `${pendingText.replace("\n\npayload", "\napproved: true\n\npayload")}`);
    putHandoff(root, "new", "50_next.handoff", nextNote);
    const r = run({ dir: root }, script("handoffd.ts"), "--once", root);
    const woken = new Set(fake.prompts(root).map(([name]) => name));
    expect(r.exit).toBe(0);
    expect(exists(join(receiver, ".swarmforge/handoffs/inbox/new/50_approved.handoff"))).toBe(true);
    expect(exists(join(inbox(root, "new"), "50_next.handoff"))).toBe(true);
    expect(woken.has("receiver-session")).toBe(true);
    expect(woken.has("sender-session")).toBe(true);
    expect(readFile(join(root, ".swarmforge/daemon/handoffd.log"))).toContain("notified-unblocked-sender sender");
  });
});

describe("done_with_current", () => {
  test("replaces an existing completed file", () => {
    const root = tmpDir();
    const name = "50_retry_htw.handoff";
    initRepo(root);
    setupProject(root, { receiver: "task" });
    const base = { from: "(Retry)", to: "receiver", recipient: "receiver", priority: "50", type: "note", task: "htw" };
    putHandoff(root, "in_process", name, { id: "retry", ...base });
    putHandoff(root, "completed", name, { id: "retry-old", ...base, completedAt: "2026-08-26T22:45:36.178441Z" });
    const r = run({ dir: root, env: receiverEnv }, doneWithCurrent);
    const completed = join(inbox(root, "completed"), name);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("COMPLETED:");
    expect(exists(join(inbox(root, "in_process"), name))).toBe(false);
    expect(exists(completed)).toBe(true);
    expect(header(completed, "completed_at")).not.toBe("2026-08-26T22:45:36.178441Z");
  });
});

const outboxFiles = (root: string) => listFiles(join(root, ".swarmforge/handoffs/outbox"), ".handoff");
const commitFile = (root: string, name: string, text: string, message: string) => {
  writeFile(join(root, name), text);
  run({ dir: root }, "git", "add", name);
  run({ dir: root }, "git", "commit", "-q", "-m", message);
};

describe("done_with_current (more)", () => {
  test("completes the current task without accepting the next", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { receiver: "task" });
    putHandoff(root, "in_process", "50_20260615T000001Z_000001_from_sender_to_receiver.handoff", {
      id: "20260615T000001Z_000001_from_sender", from: "sender", to: "receiver", recipient: "receiver",
      priority: "50", type: "git_handoff", task: "task-current", commit: headSha(root),
    });
    makeQueuedHandoff(root, "50_20260615T000002Z_000002_from_sender_to_receiver.handoff", { id: "20260615T000002Z_000002_from_sender", task: "task-next" });
    const r = run({ dir: root, env: receiverEnv }, doneWithCurrent);
    const completed = join(inbox(root, "completed"), "50_20260615T000001Z_000001_from_sender_to_receiver.handoff");
    const nextFile = join(inbox(root, "new"), "50_20260615T000002Z_000002_from_sender_to_receiver.handoff");
    expect(r.out).toContain("COMPLETED:");
    expect(r.out).toContain("MAIL_WAITING");
    expect(r.out).not.toContain("TASK_NAME: task-next");
    expect(header(completed, "completed_at")).toBeDefined();
    expect(exists(nextFile)).toBe(true);
    expect(header(nextFile, "dequeued_at")).toBeUndefined();
  });

  test("completes a whole batch without accepting the next", () => {
    const root = tmpDir();
    const batch = join(inbox(root, "in_process"), "batch_20260615T000001Z_000001");
    initRepo(root);
    setupProject(root, { receiver: "batch" });
    const item = (n: string, task: string) => writeFile(join(batch, `10_20260615T00000${n}Z_00000${n}_from_sender_to_receiver.handoff`),
      handoffText({ id: `20260615T00000${n}Z_00000${n}_from_sender`, from: "sender", to: "receiver", recipient: "receiver", priority: "10", type: "git_handoff", task, commit: headSha(root) }));
    item("1", "task-a");
    item("2", "task-b");
    makeQueuedHandoff(root, "20_20260615T000003Z_000003_from_sender_to_receiver.handoff", { id: "20260615T000003Z_000003_from_sender", priority: "20", task: "task-c" });
    const r = run({ dir: root, env: receiverEnv }, doneWithCurrent);
    const completedBatch = join(inbox(root, "completed"), "batch_20260615T000001Z_000001");
    expect(r.out).toContain("COMPLETED_BATCH:");
    expect(r.out).toContain("MAIL_WAITING");
    expect(r.out).not.toContain("TASK_NAME: task-c");
    const files = listFiles(completedBatch, ".handoff");
    expect(files.length).toBe(2);
    expect(files.every((f) => header(f, "completed_at") !== undefined)).toBe(true);
    expect(exists(join(inbox(root, "new"), "20_20260615T000003Z_000003_from_sender_to_receiver.handoff"))).toBe(true);
  });
});

describe("swarm_handoff audits", () => {
  const opts = (root: string) => ({ dir: root, env: senderEnv });
  const queue = (root: string, draft: string) => run(opts(root), swarmHandoff, draft);
  const project = () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root);
    return root;
  };

  test("auto-completes the current work after the audited git handoff is queued", () => {
    const root = tmpDir();
    const base = initRepo(root);
    const currentFile = "50_20260615T000001Z_000001_from_planner_to_sender.handoff";
    const nextFile = "50_20260615T000002Z_000002_from_planner_to_sender.handoff";
    const completed = join(inbox(root, "completed"), currentFile);
    const queuedNext = join(inbox(root, "new"), nextFile);
    const draft = join(root, "tmp", "jump.handoff");
    setupProject(root);
    writeFile(join(root, ".swarmforge/board/tasks.tsv"), "jump\tsender\tcreated\tupdated\tjump-id\nextras\tsender\tcreated\tupdated\textras-id\n");
    expect(boardAuditCount(root, "jump")).toBe(0);
    expect(boardAuditCount(root, "extras")).toBe(0);
    putHandoff(root, "in_process", currentFile, {
      id: "20260615T000001Z_000001_from_planner", from: "planner", to: "sender", recipient: "sender", priority: "50",
      type: "note", taskId: "jump-id", task: "jump", taskBaseCommit: base, body: "jump",
    });
    putHandoff(root, "new", nextFile, {
      id: "20260615T000002Z_000002_from_planner", from: "planner", to: "sender", recipient: "sender", priority: "50",
      type: "note", taskId: "extras-id", task: "extras", body: "extras",
    });
    commitFile(root, "jump.md", "jump\n", "Jump");
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 50\ntask: jump\n");

    const first = queue(root, draft);
    expect(first.exit).toBe(0);
    expect(first.out).toContain("AUDIT_REQUIRED");
    expect(outboxFiles(root)).toEqual([]);
    expect(auditFiles(root).length).toBe(1);
    expect(boardAuditCount(root, "jump")).toBe(1);
    expect(boardAuditCount(root, "extras")).toBe(0);
    expect(exists(handoffPath(root, "in_process", currentFile))).toBe(true);
    expect(exists(completed)).toBe(false);
    expect(exists(draft)).toBe(true);

    const second = queue(root, draft);
    const queued = queuedPath(second.out)!;
    expect(second.exit).toBe(0);
    expect(second.out).toContain("HANDOFF QUEUED:");
    expect(second.out).toContain("COMPLETED:");
    expect(second.out).toContain("MAIL_WAITING");
    expect(readFile(queued)).toContain("task_id: jump-id\n");
    expect(boardAuditCount(root, "jump")).toBe(1);
    expect(auditFiles(root)).toEqual([]);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
    expect(header(completed, "completed_at")).toBeDefined();
    expect(exists(queuedNext)).toBe(true);
    expect(header(queuedNext, "dequeued_at")).toBeUndefined();
  });

  test("a changed commit needs a new audit", () => {
    const root = project();
    writeFile(join(root, ".swarmforge/board/tasks.tsv"), "changed-commit\tsender\tcreated\tupdated\tchanged-commit-id\t0\n");
    const draft = writeFile(join(root, "tmp", "changed-commit.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: changed-commit\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    expect(boardAuditCount(root, "changed-commit")).toBe(1);
    commitFile(root, "changed.md", "changed\n", "Change after audit");
    const changed = queue(root, draft);
    expect(changed.out).toContain("AUDIT_REQUIRED");
    expect(boardAuditCount(root, "changed-commit")).toBe(2);
    expect(outboxFiles(root)).toEqual([]);
    const submitted = queue(root, draft);
    const queued = queuedPath(submitted.out);
    expect(queued).toBeDefined();
    expect(boardAuditCount(root, "changed-commit")).toBe(2);
    expect(readFile(queued!)).toContain(`commit: ${headSha(root)}\n`);
  });

  test("an audit is invalidated before a changed commit is rejected", () => {
    const root = project();
    const draft = writeFile(join(root, "tmp", "invalid-commit-change.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: invalid-commit-change\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    run({ dir: root }, "git", "commit", "-q", "--allow-empty", "-m", "Empty change");
    const invalid = run({ ...opts(root), ok: false }, swarmHandoff, draft);
    expect(invalid.exit).toBe(1);
    expect(invalid.err).toContain("has no changed files");
    run({ dir: root }, "git", "reset", "--hard", "HEAD^");
    const restored = queue(root, draft);
    expect(restored.out).toContain("AUDIT_REQUIRED");
    expect(queuedPath(restored.out)).toBeUndefined();
    expect(queuedPath(queue(root, draft).out)).toBeDefined();
  });

  test("a changed draft needs a new audit", () => {
    const root = project();
    const draft = writeFile(join(root, "tmp", "changed-draft.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: changed-draft\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 40\ntask: changed-draft\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    expect(outboxFiles(root)).toEqual([]);
    const queued = queuedPath(queue(root, draft).out);
    expect(queued).toBeDefined();
    expect(readFile(queued!)).toContain("priority: 40\n");
  });

  test("an older task's audit for the same sender is invalidated", () => {
    const root = project();
    const draft = join(root, "tmp", "switch-task.handoff");
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 50\ntask_id: first-id\ntask: first\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 50\ntask_id: second-id\ntask: second\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    expect(auditFiles(root).length).toBe(1);
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 50\ntask_id: first-id\ntask: first\n");
    const back = queue(root, draft);
    expect(back.out).toContain("AUDIT_REQUIRED");
    expect(queuedPath(back.out)).toBeUndefined();
    expect(queuedPath(queue(root, draft).out)).toBeDefined();
  });

  test("an audit is invalidated when the changed draft is invalid", () => {
    const root = project();
    const draft = join(root, "tmp", "invalid-change.handoff");
    const valid = "type: git_handoff\nto: receiver\npriority: 50\ntask_id: task-id\ntask: task\n";
    writeFile(draft, valid);
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    writeFile(draft, `${valid}unknown: value\n`);
    expect(run({ ...opts(root), ok: false }, swarmHandoff, draft).exit).toBe(2);
    expect(auditFiles(root)).toEqual([]);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
    writeFile(draft, valid);
    const repaired = queue(root, draft);
    expect(repaired.out).toContain("AUDIT_REQUIRED");
    expect(queuedPath(repaired.out)).toBeUndefined();
    expect(queuedPath(queue(root, draft).out)).toBeDefined();
  });

  test("audits are isolated by sender", () => {
    const root = project();
    const senderDraft = writeFile(join(root, "tmp", "sender.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask_id: first-id\ntask: first\n");
    const receiverDraft = writeFile(join(root, "tmp", "receiver.handoff"), "type: git_handoff\nto: sender\npriority: 50\ntask_id: second-id\ntask: second\n");
    const asReceiver = { dir: root, env: receiverEnv };
    run(opts(root), swarmHandoff, senderDraft);
    run(asReceiver, swarmHandoff, receiverDraft);
    expect(auditFiles(root).length).toBe(2);
    expect(queuedPath(run(opts(root), swarmHandoff, senderDraft).out)).toBeDefined();
    expect(auditFiles(root).length).toBe(1);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
    expect(queuedPath(run(asReceiver, swarmHandoff, receiverDraft).out)).toBeDefined();
    expect(auditFiles(root)).toEqual([]);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
  });

  test("empty audit_pending sender directories are removed", () => {
    const root = project();
    const draft = join(root, "tmp", "empty-dirs.handoff");
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 50\ntask: empty-dirs\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    expect(auditFiles(root).length).toBe(1);
    expect(auditSenderDirs(root).length).toBe(1);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
    expect(queuedPath(queue(root, draft).out)).toBeDefined();
    expect(auditFiles(root)).toEqual([]);
    expect(auditSenderDirs(root)).toEqual([]);
    expect(isDir(auditPendingDir(root))).toBe(true);
    for (const path of outboxFiles(root)) rmSync(path, { force: true });
    commitFile(root, "next.md", "next\n", "Next slice");
    writeFile(draft, "type: git_handoff\nto: receiver\npriority: 50\ntask: empty-dirs-next\n");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    expect(auditFiles(root).length).toBe(1);
    expect(auditSenderDirs(root).length).toBe(1);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
    commitFile(root, "changed.md", "changed\n", "Change after audit");
    expect(queue(root, draft).out).toContain("AUDIT_REQUIRED");
    expect(auditFiles(root).length).toBe(1);
    expect(emptyAuditSenderDirs(root)).toEqual([]);
    expect(queuedPath(queue(root, draft).out)).toBeDefined();
    expect(auditFiles(root)).toEqual([]);
    expect(auditSenderDirs(root)).toEqual([]);
    expect(isDir(auditPendingDir(root))).toBe(true);
  });

  test("ambiguous current work is refused before anything is queued", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root);
    for (const filename of ["40_20260615T000001Z_000001_from_planner_to_sender.handoff", "50_20260615T000002Z_000002_from_planner_to_sender.handoff"]) {
      putHandoff(root, "in_process", filename, {
        id: filename, from: "planner", to: "sender", recipient: "sender", priority: "50", type: "note", taskId: "jump-id", task: "jump", body: "jump",
      });
    }
    commitFile(root, "jump.md", "jump\n", "Jump");
    const draft = writeFile(join(root, "tmp", "ambiguous.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: jump-id\n");
    const r = run({ ...opts(root), ok: false }, swarmHandoff, draft);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("Ambiguous current work: multiple tasks are in process.");
    expect(outboxFiles(root)).toEqual([]);
    expect(exists(draft)).toBe(true);
  });
});

describe("handoff daemon lifecycle", () => {
  test("stop_handoff_daemon stops a running daemon and removes its pid file", async () => {
    const root = tmpDir();
    initRepo(root);
    mkdirSync(join(root, ".swarmforge/daemon"), { recursive: true });
    writeFile(join(root, ".swarmforge/roles.tsv"), `coder\tmaster\t${root}\tsession\tCoder\tcodex\ttask\n`);
    run({ dir: root, ok: false }, "sh", "-c", `${script("handoffd.ts")} ${root} >/dev/null 2>&1 &`);
    await Bun.sleep(1500);
    const pidFile = join(root, ".swarmforge/daemon/handoffd.pid");
    expect(exists(pidFile)).toBe(true);
    const pid = readFile(pidFile).trim();
    const stop = run({ dir: root }, script("stop_handoff_daemon.ts"), root);
    expect(stop.exit).toBe(0);
    await Bun.sleep(300);
    expect(exists(pidFile)).toBe(false);
    expect(run({ dir: root, ok: false }, "kill", "-0", pid).exit).not.toBe(0);
  });
});

describe("swarm_handoff artifacts and headers", () => {
  const project = () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root);
    return root;
  };
  const submit = (root: string, draft: string, role = "sender") =>
    auditAndSubmitGitHandoff({ dir: root, env: { SWARMFORGE_ROLE: role }, ok: false }, draft);

  test("artifacts list the files the commit added", () => {
    const root = project();
    commitFile(root, "slice.md", "work\n", "Add slice");
    const draft = writeFile(join(root, "tmp", "with-files.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: fill-artifacts\n");
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv }, draft);
    const content = readFile(queuedPath(r.out)!);
    expect(r.exit).toBe(0);
    expect(content).toContain("artifacts: slice.md\n");
    expect(content).not.toContain("artifacts: none");
  });

  test("a committed task document is included", () => {
    const root = project();
    commitFile(root, "tasks/htw.md", "# htw\n\nImplement the stories.\n", "Add task document");
    const draft = writeFile(join(root, "tmp", "task-doc.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: htw\n");
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv }, draft);
    expect(r.exit).toBe(0);
    expect(readFile(queuedPath(r.out)!)).toContain("artifacts: tasks/htw.md\n");
  });

  test("deleted files are not listed as artifacts", () => {
    const root = project();
    writeFile(join(root, "keep.md"), "before\n");
    writeFile(join(root, "gone.md"), "delete me\n");
    run({ dir: root }, "git", "add", "keep.md", "gone.md");
    run({ dir: root }, "git", "commit", "-q", "-m", "Add docs");
    writeFile(join(root, "keep.md"), "after\n");
    rmSync(join(root, "gone.md"));
    run({ dir: root }, "git", "add", "keep.md", "gone.md");
    run({ dir: root }, "git", "commit", "-q", "-m", "Update docs");
    const draft = writeFile(join(root, "tmp", "deleted-artifact.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: docs\n");
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv }, draft);
    const content = readFile(queuedPath(r.out)!);
    expect(r.exit).toBe(0);
    expect(content).toContain("artifacts: keep.md\n");
    expect(content).not.toContain("gone.md");
  });

  test("a merge's artifacts come from the task base, not HEAD^", () => {
    const root = project();
    const base = headSha(root);
    writeFile(join(root, ".swarmforge/board/tasks.tsv"), "extras\tsender\tcreated\tupdated\textras-id\n");
    run({ dir: root }, "git", "checkout", "-q", "-b", "jump");
    commitFile(root, "features/console/wumpus_jump.feature", "jump\n", "Jump spec");
    const jump = headSha(root);
    run({ dir: root }, "git", "checkout", "-q", "master");
    writeFile(join(root, "features/console/command_extras.feature"), "commands\n");
    writeFile(join(root, "features/console/holy_hand_grenade.feature"), "grenade\n");
    run({ dir: root }, "git", "add", "features/console/command_extras.feature", "features/console/holy_hand_grenade.feature");
    run({ dir: root }, "git", "commit", "-q", "-m", "Extras spec");
    run({ dir: root }, "git", "merge", "--no-ff", "jump", "-m", "Merge jump into extras");
    const mergeHead = headSha(root);
    putHandoff(root, "in_process", "50_extras.handoff", {
      id: "current", from: "(New Task)", to: "sender", recipient: "sender", priority: "50", type: "note",
      taskId: "extras-id", task: "extras", taskBaseCommit: jump, body: "extras",
    });
    const draft = writeFile(join(root, "tmp", "extras.handoff"), `type: git_handoff\nto: receiver\npriority: 50\ntask: extras\ncommit: ${base}\n`);
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv }, draft);
    const content = readFile(queuedPath(r.out)!);
    expect(r.exit).toBe(0);
    expect(content).toContain(`commit: ${mergeHead}\n`);
    expect(content).toContain("artifacts: features/console/command_extras.feature,features/console/holy_hand_grenade.feature\n");
    expect(content).not.toContain("wumpus_jump.feature");
  });

  test("a merge with no changed files is refused", () => {
    const root = project();
    run({ dir: root }, "git", "checkout", "-q", "-b", "side");
    commitFile(root, "side.md", "side\n", "Side");
    run({ dir: root }, "git", "checkout", "-q", "master");
    run({ dir: root }, "git", "merge", "-q", "--no-ff", "-s", "ours", "-m", "Ours", "side");
    const draft = writeFile(join(root, "tmp", "merge.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: merge-empty\n");
    const r = run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, draft);
    expect(r.exit).not.toBe(0);
    expect(r.err + r.out).toContain("no changed files");
    expect(r.err + r.out).not.toContain("artifacts: none");
    expect(outboxFiles(root)).toEqual([]);
    expect(exists(draft)).toBe(true);
  });

  test("evidence headers are invalid, and a note takes only type, to, priority and message", () => {
    const root = project();
    const run1 = (name: string, text: string) => run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, writeFile(join(root, "tmp", name), text));
    const coverage = run1("coverage.handoff", "type: git_handoff\nto: receiver\npriority: 50\ntask: cave\ncoverage: 92\n");
    expect(coverage.exit).toBe(2);
    expect(coverage.err).toContain("unknown header 'coverage'");
    expect(exists(join(root, "tmp", "coverage.handoff"))).toBe(true);
    const extra = run1("note-extra.handoff", "type: note\nto: receiver\npriority: 50\nmessage: hello\ncoverage: 92\n");
    expect(extra.exit).toBe(2);
    expect(extra.err).toContain("unknown header 'coverage'");
    const ok = run1("note-ok.handoff", "type: note\nto: receiver\npriority: 50\nmessage: hello\n");
    expect(ok.exit).toBe(0);
    expect(ok.out).toContain("HANDOFF QUEUED:");
    expect(auditFiles(root)).toEqual([]);
  });

  test("a missing or invalid priority becomes 50, and a valid one is kept", () => {
    const root = project();
    commitFile(root, "slice.md", "work\n", "Add slice");
    const queued = (name: string, text: string) => {
      const r = submit(root, writeFile(join(root, "tmp", name), text));
      expect(r.exit).toBe(0);
      return readFile(queuedPath(r.out)!);
    };
    expect(queued("no-priority.handoff", "type: git_handoff\nto: receiver\ntask: fill-priority\n")).toContain("priority: 50\n");
    const word = queued("word-priority.handoff", "type: git_handoff\nto: receiver\npriority: normal\ntask: fill-priority-word\n");
    expect(word).toContain("priority: 50\n");
    expect(word).not.toContain("priority: normal\n");
    expect(queued("keep-priority.handoff", "type: git_handoff\nto: receiver\npriority: 00\ntask: keep-priority\n")).toContain("priority: 00\n");
  });

  test("prose after the headers is replaced by the helper's payload", () => {
    const root = project();
    commitFile(root, "slice.md", "work\n", "Add slice");
    const sha = headSha(root);
    const draft = writeFile(join(root, "tmp", "with-payload.handoff"),
      "type: git_handoff\nto: receiver\npriority: 50\ntask: strip-payload\n\nPlease merge this and run the tests.\n");
    const r = submit(root, draft);
    const content = readFile(queuedPath(r.out)!);
    expect(r.exit).toBe(0);
    expect(content).toContain(`merge_and_process.sh sender ${sha}`);
    expect(content).not.toContain("Please merge this and run the tests.");
  });

  test("the last pack role's git handoff is tagged non-forwarding, and a middle role's is not", () => {
    const last = project();
    commitFile(last, "slice.md", "work\n", "Add slice");
    const lastDraft = writeFile(join(last, "tmp", "last-role.handoff"), "type: git_handoff\nto: sender\npriority: 00\ntask: HTW\n");
    const lastResult = submit(last, lastDraft, "receiver");
    expect(lastResult.exit).toBe(0);
    expect(readFile(queuedPath(lastResult.out)!)).toContain("non-forwarding: true\n");
    expect(outboxFiles(last).length).toBe(1);

    const mid = project();
    commitFile(mid, "slice.md", "work\n", "Add slice");
    const midDraft = writeFile(join(mid, "tmp", "mid-role.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: HTW\n");
    const midResult = submit(mid, midDraft);
    expect(midResult.exit).toBe(0);
    expect(readFile(queuedPath(midResult.out)!)).not.toContain("non-forwarding:");
  });
});

describe("roles and merges in worktrees", () => {
  test("ready_for_next and done_with_current infer the role from the worktree", () => {
    const root = tmpDir();
    initRepo(root);
    const wt = addWorktree(root, "receiver");
    setupProject(root, { receiver: "task" });
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tsender\t${root}\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t${wt}\tsession\tReceiver\tcodex\ttask\n`);
    for (const dir of ["outbox/tmp", "sent", "failed", "inbox/new", "inbox/in_process", "inbox/completed"]) {
      mkdirSync(join(wt, ".swarmforge/handoffs", dir), { recursive: true });
    }
    makeQueuedHandoff(wt, "50_20260615T000001Z_000001_from_sender_to_receiver.handoff", { id: "20260615T000001Z_000001_from_sender", task: "task-inferred" });
    const lib = run({ dir: wt, ok: false }, script("handoff_lib.ts"), "role");
    const ready = run({ dir: wt, ok: false }, readyForNext);
    const done = run({ dir: wt, ok: false }, doneWithCurrent);
    expect(lib.exit).toBe(0);
    expect(lib.out.trim()).toBe("receiver");
    expect(ready.exit).toBe(0);
    expect(ready.out).toContain("TASK_NAME: task-inferred");
    expect(done.exit).toBe(0);
    expect(done.out).toContain("COMPLETED:");
    expect(done.out).toContain("NO_TASK");
  });

  const senderAndReceiver = () => {
    const root = tmpDir();
    initRepo(root);
    const sender = addWorktree(root, "sender");
    const receiver = addWorktree(root, "receiver");
    setupProject(root);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `sender\tsender\t${sender}\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t${receiver}\tsession\tReceiver\tcodex\ttask\n`);
    writeFile(join(sender, "slice.md"), "from sender\n");
    run({ dir: sender }, "git", "add", "slice.md");
    run({ dir: sender }, "git", "commit", "-q", "-m", "Sender slice");
    return { root, sender, receiver, sha: headSha(sender) };
  };

  test("merge_and_process merges the inbound commit", () => {
    const { receiver, sha } = senderAndReceiver();
    const r = run({ dir: receiver, ok: false }, script("merge_and_process.sh"), "sender", sha);
    const merged = run({ dir: receiver, ok: false }, "git", "merge-base", "--is-ancestor", sha, "HEAD");
    expect(r.exit).toBe(0);
    expect(r.out + r.err).toContain("MERGED:");
    expect(merged.exit).toBe(0);
    expect(exists(join(receiver, "slice.md"))).toBe(true);
  });

  test("ready_for_next merges an inbound git handoff, so the agent never runs git merge", () => {
    const { receiver, sha } = senderAndReceiver();
    for (const dir of ["inbox/new", "inbox/in_process", "inbox/completed"]) mkdirSync(join(receiver, ".swarmforge/handoffs", dir), { recursive: true });
    makeQueuedHandoff(receiver, "50_20260615T000001Z_000001_from_sender_to_receiver.handoff", {
      id: "20260615T000001Z_000001_from_sender", from: "sender", to: "receiver", commit: sha, task: "merge-on-receive",
      body: `merge_and_process sender ${sha}`,
    });
    const ready = run({ dir: receiver, env: receiverEnv, ok: false }, readyForNext);
    const merged = run({ dir: receiver, ok: false }, "git", "merge-base", "--is-ancestor", sha, "HEAD");
    expect(ready.exit).toBe(0);
    expect(ready.out).toContain("TASK_NAME: merge-on-receive");
    expect(merged.exit).toBe(0);
    expect(exists(join(receiver, "slice.md"))).toBe(true);
  });
});

describe("reverse copies (back-one and back-all)", () => {
  const fourPack: [string, string, string][] = [["specifier", "task", "forward-only"], ["coder", "task", "forward-only"], ["refactorer", "task", "back-one"], ["architect", "batch", "back-all"]];
  const sixPack: [string, string, string][] = [
    ["specifier", "task", "forward-only"], ["coder", "task", "forward-only"], ["cleaner", "task", "back-one"],
    ["architect", "batch", "back-all"], ["hardender", "task", "forward-only"], ["QA", "task", "back-all"],
  ];
  const extra = "Please also rewrite the layout.";
  const base = (name: string) => name.split("/").at(-1)!;
  const packProject = (rows: [string, string, string][]) => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, rows);
    return root;
  };
  const forwardCopy = (root: string) => outboxHandoffs(root).find((f) => base(f).startsWith("50_"))!;

  test("a four-pack refactorer's back-one gives the coder a separate merge-only copy", () => {
    const root = packProject(fourPack);
    const sha = commitWork(root);
    const result = queueGitFrom(root, "refactorer", "architect", "HTW");
    const forward = outboxTo(root, "architect")!;
    const reverse = outboxTo(root, "coder")!;
    expect(result.exit).toBe(0);
    expect(forward).toBeDefined();
    expect(reverse).toBeDefined();
    expect(forward).not.toBe(reverse);
    expect(base(reverse).startsWith("00_")).toBe(true);
    expect(base(forward).startsWith("50_")).toBe(true);
    expect(header(forward, "to")).toBe("architect");
    expect(header(reverse, "to")).toBe("coder");
    expect(header(reverse, "non-forwarding")).toBe("true");
    expect(header(forward, "non-forwarding")).not.toBe("true");
    expect(handoffBody(reverse)).toContain(`merge_and_process.sh refactorer ${sha}`);
    expect(handoffBody(reverse)).toContain("inbound tree is the structure");
    expect(handoffBody(forward)).toContain(`merge_and_process.sh refactorer ${sha}`);
    expect(handoffBody(forward)).toContain("current tree is the structure");
    expect(handoffBody(forward)).not.toContain("inbound tree is the structure");
    expect(handoffBody(forward)).not.toContain(extra);
    expect(handoffBody(reverse)).not.toContain(extra);
    expect(outboxHandoffs(root).length).toBe(2);
  });

  test("a four-pack architect's back-all gives every earlier role a merge-only copy", () => {
    const root = packProject(fourPack);
    commitWork(root);
    expect(queueGitFrom(root, "architect", "specifier", "HTW").exit).toBe(0);
    for (const role of ["specifier", "coder", "refactorer"]) {
      const copy = outboxTo(root, role)!;
      expect(copy).toBeDefined();
      expect(base(copy).startsWith("00_")).toBe(true);
      expect(header(copy, "non-forwarding")).toBe("true");
      expect(header(copy, "to")).toBe(role);
      expect(handoffBody(copy)).toContain("merge_and_process.sh architect");
      expect(handoffBody(copy)).toContain("inbound tree is the structure");
      expect(handoffBody(copy)).not.toContain(extra);
    }
    const forward = forwardCopy(root);
    expect(header(forward, "to")).toBe("specifier");
    expect(header(forward, "non-forwarding")).toBe("true");
    expect(handoffBody(forward)).toContain("merge_and_process.sh architect");
    expect(handoffBody(forward)).toContain("inbound tree is the structure");
    expect(handoffBody(forward)).not.toContain("current tree is the structure");
    expect(handoffBody(forward)).not.toContain(extra);
  });

  test("a six-pack architect's back-all reaches the earlier roles but not the later ones", () => {
    const root = packProject(sixPack);
    commitWork(root);
    expect(queueGitFrom(root, "architect", "hardender", "HTW").exit).toBe(0);
    expect(header(outboxTo(root, "hardender")!, "to")).toBe("hardender");
    expect(header(outboxTo(root, "hardender")!, "non-forwarding")).not.toBe("true");
    for (const role of ["specifier", "coder", "cleaner"]) {
      expect(header(outboxTo(root, role)!, "non-forwarding")).toBe("true");
      expect(base(outboxTo(root, role)!).startsWith("00_")).toBe(true);
    }
    expect(outboxTo(root, "QA")).toBeUndefined();
  });

  test("a six-pack QA's back-all copies every earlier window", () => {
    const root = packProject(sixPack);
    commitWork(root);
    expect(queueGitFrom(root, "QA", "specifier", "HTW").exit).toBe(0);
    for (const role of ["specifier", "coder", "cleaner", "architect", "hardender"]) {
      expect(outboxTo(root, role)).toBeDefined();
      expect(header(outboxTo(root, role)!, "non-forwarding")).toBe("true");
    }
    expect(header(forwardCopy(root), "non-forwarding")).toBe("true");
  });

  test("a two-pack cleaner's back-one copies the coder", () => {
    const root = packProject([["coder", "task", "forward-only"], ["cleaner", "task", "back-one"]]);
    commitWork(root);
    expect(queueGitFrom(root, "cleaner", "coder", "HTW").exit).toBe(0);
    expect(header(outboxTo(root, "coder")!, "non-forwarding")).toBe("true");
    expect(base(outboxTo(root, "coder")!).startsWith("00_")).toBe(true);
    expect(header(forwardCopy(root), "non-forwarding")).toBe("true");
  });

  test("the last window on forward-only has no reverse copies", () => {
    const root = packProject([["coder", "task", "forward-only"], ["cleaner", "task", "forward-only"]]);
    commitWork(root);
    expect(queueGitFrom(root, "cleaner", "coder", "HTW").exit).toBe(0);
    expect(outboxHandoffs(root).length).toBe(1);
    expect(header(outboxTo(root, "coder")!, "non-forwarding")).toBe("true");
    expect(handoffBody(outboxTo(root, "coder")!)).toContain("inbound tree is the structure");
    expect(handoffBody(outboxTo(root, "coder")!)).not.toContain("current tree is the structure");
  });

  test("a git handoff is refused while the inbound one is non-forwarding", () => {
    const root = packProject([["sender", "task", ""], ["receiver", "task", ""]]);
    commitWork(root);
    writeFile(join(root, ".swarmforge/handoffs/inbox/in_process/00_from_architect.handoff"),
      "from: architect\nto: sender\npriority: 00\ntype: git_handoff\ntask: HTW\nnon-forwarding: true\n\nmerge\n");
    const draft = writeFile(join(root, "tmp", "forward.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: HTW\n");
    const r = run({ dir: root, env: senderEnv, ok: false }, swarmHandoff, draft);
    expect(r.exit).not.toBe(0);
    expect(r.err + r.out).toContain("non-forwarding");
    expect(exists(draft)).toBe(true);
  });

  test("done_with_current after a reverse copy queues no git handoff", () => {
    const root = packProject([["sender", "task", ""], ["receiver", "task", ""]]);
    const inbound = writeFile(join(root, ".swarmforge/handoffs/inbox/in_process/00_from_architect.handoff"),
      "from: architect\nto: sender\npriority: 00\ntype: git_handoff\ntask: HTW\nnon-forwarding: true\n\nmerge\n");
    const r = run({ dir: root, env: senderEnv }, doneWithCurrent);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("COMPLETED:");
    expect(exists(join(inbox(root, "completed"), "00_from_architect.handoff"))).toBe(true);
    expect(exists(inbound)).toBe(false);
    expect(outboxFiles(root)).toEqual([]);
  });
});

describe("swarm_handoff task names and merges", () => {
  const project = (roleSpec: Record<string, string> = { sender: "task", receiver: "task" }) => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, roleSpec);
    return root;
  };

  test("a draft task naming a lane card keeps that task name", () => {
    const root = project();
    writeFile(join(root, ".swarmforge/board/tasks.tsv"),
      "Command syntax\tsender\t2026-06-15T00:00:00Z\t2026-06-15T00:00:00Z\nHoly Hand Grenade\tsender\t2026-06-15T00:00:01Z\t2026-06-15T00:00:01Z\n");
    commitFile(root, "slice.md", "work\n", "Add slice");
    const draft = writeFile(join(root, "tmp", "hhg.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: Holy Hand Grenade\n");
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv, ok: false }, draft);
    expect(r.exit).toBe(0);
    const content = readFile(queuedPath(r.out)!);
    expect(content).toContain("task: Holy Hand Grenade\n");
    expect(content).not.toContain("task: Command syntax\n");
  });

  test("from a worktree with a copied roles.tsv, the file lands in the master outbox", () => {
    const root = tmpDir();
    initRepo(root);
    const wt = addWorktree(root, "sender");
    setupProject(root);
    const rolesText = `sender\tsender\t${wt}\tsession\tSender\tcodex\ttask\nreceiver\treceiver\t${root}\tsession\tReceiver\tcodex\ttask\n`;
    writeFile(join(root, ".swarmforge/roles.tsv"), rolesText);
    writeFile(join(wt, ".swarmforge/roles.tsv"), rolesText);
    writeFile(join(wt, "slice.md"), "from the worktree\n");
    run({ dir: wt }, "git", "add", "slice.md");
    run({ dir: wt }, "git", "commit", "-q", "-m", "Worktree slice");
    const draft = writeFile(join(wt, "tmp", "copied-roles.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: copied-roles\n");
    const r = auditAndSubmitGitHandoff({ dir: wt, env: senderEnv }, draft);
    const queued = queuedPath(r.out)!;
    expect(r.exit).toBe(0);
    expect(realpathSync(queued).startsWith(realpathSync(join(root, ".swarmforge/handoffs/outbox")))).toBe(true);
    expect(queued).not.toContain("/.worktrees/");
  });

  test("a merge is queued with its first-parent files", () => {
    const root = project();
    run({ dir: root }, "git", "checkout", "-q", "-b", "side");
    commitFile(root, "side.md", "side\n", "Side");
    run({ dir: root }, "git", "checkout", "-q", "master");
    commitFile(root, "main.md", "main\n", "Main");
    run({ dir: root }, "git", "merge", "-q", "--no-edit", "side");
    const draft = writeFile(join(root, "tmp", "merge-files.handoff"), "type: git_handoff\nto: receiver\npriority: 50\ntask: merge-files\n");
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv, ok: false }, draft);
    expect(r.exit).toBe(0);
    const content = readFile(queuedPath(r.out)!);
    expect(content).toContain("artifacts:");
    expect(content).toContain("side.md");
  });

  test("done_with_current archives the completing role's pane", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { receiver: "task" });
    putHandoff(root, "in_process", "50_20260615T000001Z_000001_from_sender_to_receiver.handoff", {
      id: "20260615T000001Z_000001_from_sender", from: "sender", to: "receiver", recipient: "receiver",
      priority: "50", type: "git_handoff", task: "task-current", commit: headSha(root),
    });
    const r = run({ dir: root, env: { ...receiverEnv, SWARMFORGE_PANE_STUB: "receiver pane\n" } }, doneWithCurrent);
    const pane = join(root, ".swarmforge/sessions/receiver/pane.txt");
    expect(r.exit).toBe(0);
    expect(exists(pane)).toBe(true);
    expect(readFile(pane)).toBe("receiver pane\n");
  });

  test("the top in-process batch item names the task", () => {
    const root = project({ sender: "batch", receiver: "task" });
    const batch = join(inbox(root, "in_process"), "batch_20260824T182225Z_000001");
    const item = (file: string, id: string, task: string) => writeFile(join(batch, file),
      handoffText({ id, from: "coder", to: "sender", recipient: "sender", priority: "50", type: "git_handoff", task, commit: headSha(root) }));
    item("50_20260824T181141Z_000002_from_coder_to_sender.handoff", "20260824T181141Z_000002_from_coder", "Command syntax");
    item("50_20260824T181302Z_000003_from_coder_to_sender.handoff", "20260824T181302Z_000003_from_coder", "validate");
    writeFile(join(root, ".swarmforge/board/tasks.tsv"),
      "HTW\tsender\t2026-08-24T18:05:33Z\t2026-08-24T18:05:33Z\nCommand syntax\tsender\t2026-08-24T18:06:05Z\t2026-08-24T18:06:05Z\nvalidate\tsender\t2026-08-24T18:06:45Z\t2026-08-24T18:06:45Z\n");
    commitFile(root, "slice.md", "work\n", "Add slice");
    const draft = writeFile(join(root, "tmp", "htw.handoff"), "type: git_handoff\nto: receiver\npriority: 00\ntask: HTW\n");
    const r = auditAndSubmitGitHandoff({ dir: root, env: senderEnv, ok: false }, draft);
    expect(r.exit).toBe(0);
    const content = readFile(queuedPath(r.out)!);
    expect(content).toContain("task: Command syntax\n");
    expect(content).not.toContain("task: HTW\n");
  });

  test("the task helpers refuse an in-process batch", () => {
    const root = tmpDir();
    initRepo(root);
    setupProject(root, { receiver: "batch" });
    writeFile(join(inbox(root, "in_process"), "batch_20260615T000001Z_000001", "10_20260615T000001Z_000001_from_sender_to_receiver.handoff"),
      handoffText({ id: "20260615T000001Z_000001_from_sender", from: "sender", to: "receiver", recipient: "receiver", priority: "10", type: "git_handoff", task: "task-a", commit: headSha(root) }));
    const ready = run({ dir: root, env: receiverEnv, ok: false }, script("ready_for_next_task.sh"));
    const done = run({ dir: root, env: receiverEnv, ok: false }, script("done_with_current_task.sh"));
    expect(ready.exit).toBe(2);
    expect(ready.err).toContain("TASK_IN_PROCESS_IS_BATCH");
    expect(done.exit).toBe(2);
    expect(done.err).toContain("CURRENT_WORK_IS_BATCH");
  });
});
