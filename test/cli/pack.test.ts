// The board and the daemon together: how handoffd moves cards between lanes, finishes them, holds the
// specifier's handoff for approval, and archives panes. Everything runs as the real scripts.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { exists, fake, listFiles, readFile, repoRoot, run, script, tmpDir, writeFile } from "./support.ts";

const sixPack = ["specifier", "coder", "cleaner", "architect", "hardender", "QA"];
const fourPack = ["specifier", "coder", "refactorer", "architect"];
const twoPack = ["coder", "cleaner"];
const reverseBody = "Re-read your role and constitution.\n\nmerge_and_process.sh refactorer abcdef1234\n\nThe inbound tree is the structure. Replay this role's current task onto that shape.";

type Pack = { root: string; roles: string[] };

const worktree = ({ root, roles }: Pack, role: string) => (role === roles[0] ? root : join(root, ".worktrees", role));

/** A pack whose first role is on master, with live fake-herdr agents for every role. */
function setupPack(roles: string[], propagation: Record<string, string> = {}): Pack {
  const pack = { root: tmpDir("swarmforge-pack."), roles };
  writeFile(join(pack.root, ".swarmforge/roles.tsv"), roles.map((role, i) =>
    [role, i === 0 ? "master" : role, worktree(pack, role), role, role[0].toUpperCase() + role.slice(1).toLowerCase(), "codex", "task", propagation[role] ?? "forward-only"].join("\t") + "\n").join(""));
  for (const role of roles) {
    for (const dir of ["outbox", "sent", "failed", "inbox/new"]) mkdirSync(join(worktree(pack, role), ".swarmforge/handoffs", dir), { recursive: true });
  }
  mkdirSync(join(pack.root, ".swarmforge/handoffs/pending_approval"), { recursive: true });
  fake.addAgents(pack.root, roles);
  return pack;
}

const board = (root: string, ...args: string[]) => run({ dir: root }, script("pack_board.sh"), ...args, "--root", root);
const createTask = (root: string, name: string, lane: string) => board(root, "create", "--name", name, "--lane", lane, "--text", "Integrate HTW stories");
const cards = (root: string) =>
  readFile(join(root, ".swarmforge/board/tasks.tsv")).split("\n").filter(Boolean).map((row) => {
    const [name, lane, , , id, audit] = row.split("\t");
    return { name, lane, id, audit: Number(audit) };
  });
const card = (root: string, name: string) => cards(root).find((c) => c.name === name)!;
const lane = (root: string, name: string) => card(root, name).lane;
const swarmctl = (root: string, ...args: string[]) => run({ dir: root }, script("swarmctl.sh"), ...args, "--root", root);
const status = (root: string) => JSON.parse(swarmctl(root, "status", "--json").out);

type Queued = { from: string; to: string; task: string; artifacts?: string; nonForwarding?: boolean; priority?: string; body?: string };
function queue(root: string, q: Queued): void {
  const priority = q.priority ?? "50";
  writeFile(join(root, ".swarmforge/handoffs/outbox", `${priority}_from_${q.from}_to_${q.to.replaceAll(",", "_")}.handoff`),
    `from: ${q.from}\nto: ${q.to}\npriority: ${priority}\ntype: git_handoff\ntask: ${q.task}\n${q.artifacts ? `artifacts: ${q.artifacts}\n` : ""}${q.nonForwarding ? "non-forwarding: true\n" : ""}\n${q.body ?? "payload"}\n`);
}

const handoffdOnce = (root: string, env: Record<string, string> = {}) => run({ dir: root, env }, script("handoffd.ts"), "--once", root);
const names = (dir: string) => listFiles(dir, ".handoff").map((f) => f.split("/").at(-1)!);
const pending = (root: string) => names(join(root, ".swarmforge/handoffs/pending_approval"));
const inbox = (pack: Pack, role: string) => names(join(worktree(pack, role), ".swarmforge/handoffs/inbox/new"));
const paneFile = (root: string, role: string) => join(root, ".swarmforge/sessions", role, "pane.txt");

describe("pack_board", () => {
  test("creates a card in the master lane", () => {
    const { root } = setupPack(["specifier"]);
    expect(createTask(root, "htw-console-app", "specifier").exit).toBe(0);
    const listed = board(root, "list").out;
    expect(listed).toBe(readFile(join(root, ".swarmforge/board/tasks.tsv")));
    const cols = listed.split("\n").find((l) => l.startsWith("htw-console-app\t"))!.split("\t");
    expect(cols[1]).toBe("specifier");
    expect(cols[2]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(cols[3]).toBe(cols[2]);
    expect(cols[5]).toBe("0");
  });

  test("a new task writes the card, its body and its document", () => {
    const root = tmpDir();
    writeFile(join(root, ".swarmforge/roles.tsv"), `specifier\tmaster\t${root}\tsession\tSpecifier\tcodex\ttask\n`);
    const text = "Integrate HTW stories…";
    board(root, "create", "--name", "htw-console-app", "--lane", "specifier", "--text", text);
    expect(lane(root, "htw-console-app")).toBe("specifier");
    expect(readFile(join(root, ".swarmforge/board/htw-console-app.txt"))).toBe(text);
    expect(readFile(join(root, "tasks/htw-console-app.md"))).toBe(`# htw-console-app\n\n${text}\n`);
  });

  test("concurrent audit increments are all counted", async () => {
    const { root } = setupPack(["specifier"]);
    createTask(root, "HTW", "specifier");
    const id = card(root, "HTW").id;
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", script("pack_board.ts"), "increment-audit", "--root", root, "--task-id", id], { stdout: "ignore", stderr: "pipe" }));
    for (const p of procs) expect(await p.exited).toBe(0);
    expect(card(root, "HTW").audit).toBe(8);
  });

  test("lists the lanes in role order and reports the master lane", () => {
    const { root } = setupPack(["specifier", "coder", "QA"]);
    expect(board(root, "lanes").out).toBe("specifier\ncoder\nQA\n");
    expect(board(root, "master-lane").out).toBe("specifier\n");
  });

  test("a duplicate task name is rejected and the original is unchanged", () => {
    const { root } = setupPack(["specifier"]);
    createTask(root, "htw-console-app", "specifier");
    const before = board(root, "list").out;
    const r = run({ dir: root, ok: false }, script("pack_board.sh"), "create", "--name", "htw-console-app", "--lane", "specifier", "--root", root);
    expect(r.exit).not.toBe(0);
    expect(r.err + r.out).toContain("Duplicate");
    expect(board(root, "list").out).toBe(before);
  });

  test("move matches the task name ignoring case", () => {
    const { root } = setupPack(["specifier"]);
    createTask(root, "HTW", "specifier");
    board(root, "move", "--name", "htw", "--lane", "coder");
    expect(lane(root, "HTW")).toBe("coder");
  });

  test("archive-all saves the live lanes' panes and skips done cards", () => {
    const { root } = setupPack(twoPack);
    createTask(root, "htw-console-app", "coder");
    createTask(root, "already-done", "done");
    const r = run({ dir: root, env: { SWARMFORGE_PANE_STUB: "pane\n" } }, script("pack_board.sh"), "archive-all", "--root", root);
    expect(r.exit).toBe(0);
    expect(readFile(paneFile(root, "coder"))).toBe("pane\n");
    expect(exists(paneFile(root, "done"))).toBe(false);
  });

  test("close-swarm archives the live role panes", () => {
    const { root } = setupPack(twoPack);
    createTask(root, "htw-console-app", "coder");
    run({ dir: root, env: { SWARMFORGE_PANE_STUB: "pane\n" } }, join(repoRoot, "close-swarm"), root);
    expect(readFile(paneFile(root, "coder"))).toBe("pane\n");
  });
});

describe("handoffd moves cards", () => {
  test("to the recipient, keeping the audit count", () => {
    const pack = setupPack(["specifier", "coder", "cleaner"]);
    createTask(pack.root, "htw-console-app", "coder");
    board(pack.root, "increment-audit", "--task-id", card(pack.root, "htw-console-app").id);
    queue(pack.root, { from: "coder", to: "cleaner", task: "htw-console-app" });
    handoffdOnce(pack.root);
    expect(lane(pack.root, "htw-console-app")).toBe("cleaner");
    expect(card(pack.root, "htw-console-app").audit).toBe(1);
  });

  test("matching the handoff's task name ignoring case", () => {
    const pack = setupPack(twoPack);
    createTask(pack.root, "HTW", "coder");
    queue(pack.root, { from: "coder", to: "cleaner", task: "htw" });
    handoffdOnce(pack.root);
    expect(lane(pack.root, "HTW")).toBe("cleaner");
  });

  test("but delivers nothing when the board does not know the task", () => {
    const pack = setupPack(twoPack);
    createTask(pack.root, "HTW", "coder");
    queue(pack.root, { from: "coder", to: "cleaner", task: "other-task" });
    handoffdOnce(pack.root);
    expect(lane(pack.root, "HTW")).toBe("coder");
    expect(inbox(pack, "cleaner")).toEqual([]);
  });

  test("and archives the sender's pane", () => {
    const pack = setupPack(twoPack);
    createTask(pack.root, "htw-console-app", "coder");
    queue(pack.root, { from: "coder", to: "cleaner", task: "htw-console-app" });
    handoffdOnce(pack.root, { SWARMFORGE_PANE_STUB: "pane\n" });
    expect(readFile(paneFile(pack.root, "coder"))).toBe("pane\n");
    expect(exists(join(pack.root, ".swarmforge/sessions/coder/htw-console-app/pane.txt"))).toBe(false);
  });
});

describe("handoffd finishes cards", () => {
  /** Queue the handoffs, run the daemon once and return the pack. */
  const deliver = (roles: string[], propagation: Record<string, string>, cardLane: string, handoffs: Queued[]) => {
    const pack = setupPack(roles, propagation);
    createTask(pack.root, "HTW", cardLane);
    for (const h of handoffs) queue(pack.root, h);
    handoffdOnce(pack.root);
    return pack;
  };
  const others = (roles: string[], me: string) => roles.filter((r) => r !== me);

  test("a broadcast from the last role is done", () => {
    for (const [roles, from] of [[twoPack, "cleaner"], [fourPack, "architect"], [sixPack, "QA"]] as const) {
      const targets = others(roles, from);
      const pack = deliver([...roles], {}, from, [{ from, to: targets.join(","), task: "HTW" }]);
      expect(lane(pack.root, "HTW")).toBe("done");
      expect(pending(pack.root)).toEqual([]);
      for (const role of targets) expect(inbox(pack, role).length).toBeGreaterThan(0);
    }
  });

  test("a terminal git handoff from the last role is done even to a subset", () => {
    const pack = deliver(fourPack, {}, "architect", [{ from: "architect", to: "specifier,coder", task: "HTW" }]);
    expect(lane(pack.root, "HTW")).toBe("done");
  });

  test("a non-forwarding handoff to one role is done, not moved", () => {
    const pack = deliver(fourPack, {}, "architect", [{ from: "architect", to: "specifier", task: "HTW", nonForwarding: true }]);
    expect(lane(pack.root, "HTW")).toBe("done");
    expect(inbox(pack, "specifier").length).toBeGreaterThan(0);
  });

  test("a four-pack refactorer's back-one neither finishes nor holds the card", () => {
    const pack = setupPack(fourPack, { refactorer: "back-one", architect: "back-all" });
    createTask(pack.root, "HTW", "refactorer");
    writeFile(join(worktree(pack, "coder"), ".swarmforge/handoffs/inbox/new/50_next_card.handoff"),
      "from: specifier\nto: coder\npriority: 50\ntype: note\nmessage: next card\n\nnote\n");
    queue(pack.root, { from: "refactorer", to: "architect", task: "HTW" });
    queue(pack.root, { from: "refactorer", to: "coder", task: "HTW", priority: "00", nonForwarding: true, body: reverseBody });
    handoffdOnce(pack.root);
    const mail = inbox(pack, "coder").sort();
    const delivered = readFile(join(worktree(pack, "coder"), ".swarmforge/handoffs/inbox/new", mail[0]));
    expect(mail[0].startsWith("00_")).toBe(true);
    expect(mail[1].startsWith("50_")).toBe(true);
    expect(delivered).toContain("merge_and_process.sh refactorer");
    expect(delivered).toContain("inbound tree is the structure");
    expect(delivered).toContain("non-forwarding: true");
    expect(inbox(pack, "architect").length).toBeGreaterThan(0);
    expect(pending(pack.root)).toEqual([]);
    expect(lane(pack.root, "HTW")).toBe("architect");
  });

  test("a four-pack architect's back-all is done because it is the last role", () => {
    const back = { refactorer: "back-one", architect: "back-all" };
    const reverse = ["specifier", "coder", "refactorer"].map((to): Queued => ({ from: "architect", to, task: "HTW", priority: "00", nonForwarding: true, body: reverseBody }));
    const pack = deliver(fourPack, back, "architect", [{ from: "architect", to: "specifier", task: "HTW", nonForwarding: true }, ...reverse]);
    for (const role of ["specifier", "coder", "refactorer"]) expect(inbox(pack, role).length).toBeGreaterThan(0);
    expect(lane(pack.root, "HTW")).toBe("done");
  });

  test("a six-pack architect's back-all moves the card to hardender", () => {
    const back = { cleaner: "back-one", architect: "back-all", QA: "back-all" };
    const reverse = ["specifier", "coder", "cleaner"].map((to): Queued => ({ from: "architect", to, task: "HTW", priority: "00", nonForwarding: true }));
    const pack = deliver(sixPack, back, "architect", [{ from: "architect", to: "hardender", task: "HTW" }, ...reverse]);
    for (const role of ["specifier", "coder", "cleaner", "hardender"]) expect(inbox(pack, role).length).toBeGreaterThan(0);
    expect(inbox(pack, "QA")).toEqual([]);
    expect(lane(pack.root, "HTW")).toBe("hardender");
  });

  test("a six-pack QA's back-all is done because it is the last role", () => {
    const back = { cleaner: "back-one", architect: "back-all", QA: "back-all" };
    const earlier = ["specifier", "coder", "cleaner", "architect", "hardender"];
    const reverse = earlier.map((to): Queued => ({ from: "QA", to, task: "HTW", priority: "00", nonForwarding: true }));
    const pack = deliver(sixPack, back, "QA", [{ from: "QA", to: "specifier", task: "HTW", nonForwarding: true }, ...reverse]);
    for (const role of earlier) expect(inbox(pack, role).length).toBeGreaterThan(0);
    expect(lane(pack.root, "HTW")).toBe("done");
  });

  test("a two-pack cleaner's back-one is done because it is the last role", () => {
    const pack = deliver(twoPack, { cleaner: "back-one" }, "cleaner", [
      { from: "cleaner", to: "coder", task: "HTW", nonForwarding: true },
      { from: "cleaner", to: "coder", task: "HTW", priority: "00", nonForwarding: true },
    ]);
    expect(inbox(pack, "coder").length).toBeGreaterThan(0);
    expect(lane(pack.root, "HTW")).toBe("done");
  });

  test("a terminal handoff finishes the batch cards of a completed batch", () => {
    const pack = setupPack(twoPack);
    const batch = join(worktree(pack, "cleaner"), ".swarmforge/handoffs/inbox/completed/batch_20260824T150500Z_000001");
    for (const name of ["HTW", "Command syntax", "validation"]) createTask(pack.root, name, "cleaner");
    writeFile(join(batch, "50_command.handoff"), "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: Command syntax\n\npayload\n");
    writeFile(join(batch, "50_validation.handoff"), "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: validation\n\npayload\n");
    queue(pack.root, { from: "cleaner", to: "coder", task: "HTW" });
    handoffdOnce(pack.root);
    for (const name of ["HTW", "Command syntax", "validation"]) expect(lane(pack.root, name)).toBe("done");
  });

  test("a terminal handoff leaves the lane's unfinished cards", () => {
    const pack = setupPack(twoPack);
    createTask(pack.root, "HTW", "cleaner");
    createTask(pack.root, "Command syntax", "cleaner");
    writeFile(join(worktree(pack, "cleaner"), ".swarmforge/handoffs/inbox/completed/50_htw.handoff"),
      "from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: HTW\n\npayload\n");
    queue(pack.root, { from: "cleaner", to: "coder", task: "HTW" });
    handoffdOnce(pack.root);
    expect(lane(pack.root, "HTW")).toBe("done");
    expect(lane(pack.root, "Command syntax")).toBe("cleaner");
  });

  test("a terminal handoff finishes the cards of the in-process batch", () => {
    const pack = setupPack(twoPack);
    const batch = join(worktree(pack, "cleaner"), ".swarmforge/handoffs/inbox/in_process/batch_20260824T202830Z_000001");
    const inBatch = ["one liners", "validate", "Holy Hand Grenade"];
    for (const name of [...inBatch, "Command syntax"]) createTask(pack.root, name, "cleaner");
    inBatch.forEach((name, i) => writeFile(join(batch, `50_${i}.handoff`), `from: coder\nto: cleaner\npriority: 50\ntype: git_handoff\ntask: ${name}\n\npayload\n`));
    queue(pack.root, { from: "cleaner", to: "coder", task: "one liners" });
    handoffdOnce(pack.root);
    for (const name of inBatch) expect(lane(pack.root, name)).toBe("done");
    expect(lane(pack.root, "Command syntax")).toBe("cleaner");
  });
});

describe("the operator's approval gate", () => {
  const held = () => {
    const pack = setupPack(sixPack);
    createTask(pack.root, "htw-console-app", "specifier");
    board(pack.root, "increment-audit", "--task-id", card(pack.root, "htw-console-app").id);
    queue(pack.root, { from: "specifier", to: "coder", task: "htw-console-app", artifacts: "features/console.feature,qa/console.md" });
    handoffdOnce(pack.root);
    return pack;
  };

  test("the specifier's git handoff waits for approval and shows in status", () => {
    const pack = held();
    expect(pending(pack.root)).toEqual(["50_from_specifier_to_coder.handoff"]);
    expect(inbox(pack, "coder")).toEqual([]);
    expect(lane(pack.root, "htw-console-app")).toBe("specifier");
    expect(card(pack.root, "htw-console-app").audit).toBe(1);
    const s = status(pack.root);
    expect(s.approvals.map((a: any) => ({ id: a.id, task: a.task, from: a.from, to: a.to, artifacts: a.artifacts }))).toEqual([
      { id: "50_from_specifier_to_coder", task: "htw-console-app", from: "specifier", to: "coder", artifacts: ["features/console.feature", "qa/console.md"] },
    ]);
    expect(s.tasks[0].status).toBe("waiting for your approval");
  });

  test("a two-pack handoff does not wait", () => {
    const pack = setupPack(twoPack);
    createTask(pack.root, "htw-console-app", "coder");
    queue(pack.root, { from: "coder", to: "cleaner", task: "htw-console-app" });
    handoffdOnce(pack.root);
    expect(inbox(pack, "cleaner").length).toBeGreaterThan(0);
    expect(pending(pack.root)).toEqual([]);
    expect(lane(pack.root, "htw-console-app")).toBe("cleaner");
    expect(status(pack.root).approvals).toEqual([]);
  });

  test("approve releases the held handoff to the coder", () => {
    const pack = held();
    swarmctl(pack.root, "approve", "htw-console-app");
    handoffdOnce(pack.root);
    expect(inbox(pack, "coder").length).toBeGreaterThan(0);
    expect(lane(pack.root, "htw-console-app")).toBe("coder");
    expect(card(pack.root, "htw-console-app").audit).toBe(1);
    expect(pending(pack.root)).toEqual([]);
    expect(status(pack.root).approvals).toEqual([]);
  });

  test("reject sends the spec back with the comments", () => {
    const pack = held();
    swarmctl(pack.root, "reject", "50_from_specifier", "Split the login", "scenario");
    handoffdOnce(pack.root);
    expect(pending(pack.root)).toEqual([]);
    expect(inbox(pack, "coder")).toEqual([]);
    expect(lane(pack.root, "htw-console-app")).toBe("specifier");
    expect(card(pack.root, "htw-console-app").audit).toBe(2);
    const [agent, text] = fake.prompts(pack.root).at(-1)!;
    expect(agent).toBe("specifier");
    expect(text).toContain("Split the login scenario");
    expect(text).toContain("send a new git_handoff to coder");
  });

  test("task new reaches the master without moving the card", () => {
    const pack = setupPack(sixPack);
    swarmctl(pack.root, "task", "new", "HTW", "Print hello");
    handoffdOnce(pack.root);
    expect(lane(pack.root, "HTW")).toBe("specifier");
    expect(pending(pack.root)).toEqual([]);
    expect(inbox(pack, "specifier").length).toBeGreaterThan(0);
    expect(names(join(pack.root, ".swarmforge/handoffs/sent")).length).toBeGreaterThan(0);
    expect(names(join(worktree(pack, "coder"), ".swarmforge/handoffs/sent"))).toEqual([]);
  });
});
