import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliError, approve, collectStatus, createTask, findApproval, formatStatus, main,
  newTaskId, noteContent, parseMessage, readCards, reject, withApproved,
} from "../../swarmforge/scripts/swarmctl.ts";

const fakeHerdr = join(import.meta.dir, "./fake-herdr.sh");
let root: string;
let fakeDir: string;
let savedEnv: NodeJS.ProcessEnv;

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const state = (...parts: string[]) => join(root, ".swarmforge", ...parts);

/** A live agent for herdr's fake, with the status `agent get` will report. */
const agent = (name: string, status = "idle") => {
  write(join(fakeDir, "agents", name), "");
  write(join(fakeDir, "status", name), status);
};
const prompts = () =>
  existsSync(join(fakeDir, "prompts.log")) ? readFileSync(join(fakeDir, "prompts.log"), "utf8").trim().split("\n") : [];

const APPROVAL = "50_from_specifier_to_coder";
const seedApproval = (id = APPROVAL, task = "R-030") =>
  write(
    state("handoffs", "pending_approval", `${id}.handoff`),
    `from: specifier\nto: coder\npriority: 50\ntype: git_handoff\ntask_id: 2026-r-030\ntask: ${task}\n` +
      `commit: 1234567890abcdef\nartifacts: features/a.feature, qa/a.qa.md\n\npayload\n`,
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "swarmctl-"));
  fakeDir = mkdtempSync(join(tmpdir(), "swarmctl-herdr-"));
  const bin = mkdtempSync(join(tmpdir(), "swarmctl-bin-"));
  copyFileSync(fakeHerdr, join(bin, "herdr"));
  Bun.spawnSync(["chmod", "+x", join(bin, "herdr")]);
  savedEnv = { ...process.env };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_HERDR_DIR = fakeDir;
  write(
    state("roles.tsv"),
    `specifier\tmaster\t${root}\tsf-specifier\tSpecifier\tclaude\ttask\tforward-only\n` +
      `coder\tcoder\t${root}/.worktrees/coder\tsf-coder\tCoder\tclaude\ttask\tforward-only\n`,
  );
  write(state("board", "tasks.tsv"), "R-030\tspecifier\t2026-01-01T00:00:00Z\t2026-01-01T00:00:00Z\t2026-r-030\t0\n");
});

afterEach(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("parsing", () => {
  test("parseMessage splits headers from the body", () => {
    expect(parseMessage("a: 1\nb: two: three\n\nbody\nmore")).toEqual({
      headers: { a: "1", b: "two: three" },
      body: "body\nmore",
    });
  });

  test("withApproved adds the header once", () => {
    const once = withApproved("to: coder\n\nbody");
    expect(once).toBe("to: coder\napproved: true\n\nbody");
    expect(withApproved(once)).toBe(once);
  });

  test("a new task id sorts by time and carries the slug", () => {
    expect(newTaskId("Mi Tarea #1", new Date("2026-09-30T12:15:30.123Z"))).toBe("20260930T121530123000Z-mi-tarea-1");
  });

  test("the new-task note matches what the daemon delivers", () => {
    const note = noteContent("id-1", "R-030", "specifier", "do it", new Date("2026-09-30T12:15:30.123Z"));
    expect(note.file).toBe("50_20260930T121530123Z_from_New_Task_to_specifier.handoff");
    expect(parseMessage(note.content).headers).toMatchObject({
      from: "(New Task)", to: "specifier", type: "note", task_id: "id-1", task: "R-030", priority: "50",
    });
    expect(parseMessage(note.content).body).toBe("do it\n");
  });
});

describe("status", () => {
  test("shows agent states, a blocked role, and what waits for approval", async () => {
    agent("sf-specifier", "working");
    agent("sf-coder", "blocked");
    seedApproval();
    const status = await collectStatus(root);
    expect(status.roles.map((r) => [r.role, r.state])).toEqual([["specifier", "working"], ["coder", "blocked"]]);
    expect(status.tasks).toEqual([{ name: "R-030", lane: "specifier", id: "2026-r-030", auditCount: 0, status: "waiting for your approval" }]);
    expect(status.approvals[0]).toMatchObject({ id: APPROVAL, to: "coder", artifacts: ["features/a.feature", "qa/a.qa.md"] });
    const text = formatStatus(status);
    expect(text).toContain("waiting for input in herdr");
    expect(text).toContain(`swarm approve <id>`);
    expect(text).toContain("commit 12345678");
  });

  test("a role without an agent says so, and a task in progress is marked", async () => {
    write(
      join(root, ".swarmforge/handoffs/inbox/in_process/50_x.handoff"),
      "task: R-030\n\nbody\n",
    );
    const status = await collectStatus(root);
    expect(status.roles[0].state).toBe("no agent");
    expect(status.tasks[0].status).toBe("in progress");
  });

  test("--json is machine readable", async () => {
    agent("sf-specifier");
    const lines: string[] = [];
    const log = console.log;
    console.log = (text: string) => lines.push(text);
    try {
      expect(await main(["status", "--json", "--root", root])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(lines.join("\n")).roles[0].role).toBe("specifier");
  });
});

describe("approve", () => {
  test("releases the handoff to the outbox marked approved", () => {
    seedApproval();
    approve(root, APPROVAL);
    expect(existsSync(state("handoffs", "pending_approval", `${APPROVAL}.handoff`))).toBe(false);
    const released = readFileSync(state("handoffs", "outbox", `${APPROVAL}.handoff`), "utf8");
    expect(parseMessage(released).headers.approved).toBe("true");
  });

  test("finds an approval by id prefix or task name, and explains a miss", () => {
    seedApproval();
    expect(findApproval(root, "50_from").id).toBe(APPROVAL);
    expect(findApproval(root, "R-030").id).toBe(APPROVAL);
    expect(() => findApproval(root, "nope")).toThrow(/No pending approval matches 'nope'/);
    seedApproval("50_from_specifier_to_qa", "R-031");
    expect(() => findApproval(root, "50_from")).toThrow(/matches 2 approvals/);
  });

  test("with nothing pending it says so", () => {
    expect(() => findApproval(root, "x")).toThrow(/Nothing is waiting for approval/);
  });
});

describe("reject", () => {
  test("discards the spec, counts the audit, and sends the comments to the specifier as one line", async () => {
    seedApproval();
    agent("sf-specifier");
    const { warning } = await reject(root, "R-030", "Split the login\nscenario in two");
    expect(warning).toBeNull();
    expect(existsSync(state("handoffs", "pending_approval", `${APPROVAL}.handoff`))).toBe(false);
    expect(existsSync(state("handoffs", "outbox", `${APPROVAL}.handoff`))).toBe(false);
    expect(readCards(root)[0].auditCount).toBe(1);
    const [sent] = prompts();
    expect(sent).toStartWith("sf-specifier\t");
    expect(sent).toContain("Split the login scenario in two");
    expect(sent).not.toContain("\\n");
    expect(sent).toContain("send a new git_handoff to coder");
  });

  test("counts the audit even when the held handoff has no task_id (found by task name)", async () => {
    write(
      state("handoffs", "pending_approval", `${APPROVAL}.handoff`),
      "from: specifier\nto: coder\ntype: git_handoff\ntask: R-030\n\npayload\n",
    );
    agent("sf-specifier");
    await reject(root, APPROVAL, "change it");
    expect(readCards(root)[0].auditCount).toBe(1);
  });

  test("warns when the specifier cannot be reached, but still discards the spec", async () => {
    seedApproval();
    const { warning } = await reject(root, APPROVAL, "change it");
    expect(warning).toContain("not found");
    expect(existsSync(state("handoffs", "pending_approval", `${APPROVAL}.handoff`))).toBe(false);
  });

  test("requires comments", async () => {
    seedApproval();
    await expect(reject(root, APPROVAL, "  ")).rejects.toThrow(CliError);
    expect(existsSync(state("handoffs", "pending_approval", `${APPROVAL}.handoff`))).toBe(true);
  });
});

describe("task new", () => {
  test("creates the card in the master lane and queues a note for the master role", async () => {
    const id = await createTask(root, "R-031", "Add a health check");
    expect(readCards(root).find((c) => c.name === "R-031")).toMatchObject({ lane: "specifier", id });
    const outbox = state("handoffs", "outbox");
    const [file] = Bun.spawnSync(["ls", outbox]).stdout.toString().trim().split("\n");
    const { headers, body } = parseMessage(readFileSync(join(outbox, file), "utf8"));
    expect(headers).toMatchObject({ from: "(New Task)", to: "specifier", type: "note", task: "R-031", task_id: id });
    expect(body).toBe("Add a health check\n");
  });

  test("refuses a duplicate name and a missing name", async () => {
    await expect(createTask(root, "R-030", "again")).rejects.toThrow(/Duplicate/);
    await expect(createTask(root, " ", "x")).rejects.toThrow(/Missing task name/);
  });
});

describe("cli", () => {
  test("help exits 0 and no command exits 1", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      expect(await main(["help"])).toBe(0);
      expect(await main([])).toBe(1);
    } finally {
      console.log = log;
    }
  });

  test("an unknown command fails with the usage", async () => {
    const error = console.error;
    const seen: string[] = [];
    console.error = (text: string) => seen.push(text);
    try {
      expect(await main(["frobnicate", "--root", root])).toBe(1);
    } finally {
      console.error = error;
    }
    expect(seen.join("\n")).toContain("Unknown command 'frobnicate'");
  });
});
