import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardError, createCard, deleteCard, incrementAudit, masterLane, newTaskId, run, tasksFile, withBoardLock,
} from "../../swarmforge/scripts/pack_board.ts";

let root: string;
const rows = () => readFileSync(tasksFile(root), "utf8").trim().split("\n").map((l) => l.split("\t"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "board-"));
  mkdirSync(join(root, ".swarmforge"), { recursive: true });
  writeFileSync(join(root, ".swarmforge", "roles.tsv"), `specifier\tmaster\t${root}\ts\tS\tclaude\ttask\tforward-only\ncoder\tcoder\t${root}/c\tc\tC\tclaude\ttask\tforward-only\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("task ids", () => {
  test("carry a sortable timestamp and the slug of the name", () => {
    expect(newTaskId("Hello, World!", new Date("2026-09-30T12:15:30.123Z"))).toBe("20260930T121530123000Z-hello-world");
    expect(newTaskId("!!!", new Date("2026-09-30T12:15:30.123Z"))).toEndWith("-task");
  });
});

describe("cards", () => {
  test("create writes the row, the body and the task document", () => {
    createCard(root, "R-1", "specifier", "id-1", "Do it");
    expect(rows()[0].slice(0, 2)).toEqual(["R-1", "specifier"]);
    expect(rows()[0][4]).toBe("id-1");
    expect(rows()[0][5]).toBe("0");
    expect(readFileSync(join(root, ".swarmforge/board/R-1.txt"), "utf8")).toBe("Do it");
    expect(readFileSync(join(root, "tasks/R-1.md"), "utf8")).toBe("# R-1\n\nDo it\n");
  });

  test("names are unique ignoring case", () => {
    createCard(root, "R-1", "specifier");
    expect(() => createCard(root, "r-1", "coder")).toThrow(/Duplicate task name: r-1/);
  });

  test("move and done change the lane; an unknown name fails", () => {
    createCard(root, "R-1", "specifier");
    run(["move", "r-1", "coder", "--root", root]);
    expect(rows()[0][1]).toBe("coder");
    run(["done", "R-1", "--root", root]);
    expect(rows()[0][1]).toBe("done");
    expect(() => run(["move", "nope", "coder", "--root", root])).toThrow(/Unknown task name: nope/);
  });

  test("increment-audit counts by task id, and an unknown id fails", () => {
    createCard(root, "R-1", "specifier", "id-1");
    incrementAudit(root, "id-1");
    incrementAudit(root, "id-1");
    expect(rows()[0][5]).toBe("2");
    expect(() => incrementAudit(root, "zzz")).toThrow(/Unknown task ID: zzz/);
  });

  test("delete removes the card and its body", () => {
    createCard(root, "R-1", "specifier", "id-1", "x");
    deleteCard(root, "R-1");
    expect(readFileSync(tasksFile(root), "utf8")).toBe("");
    expect(existsSync(join(root, ".swarmforge/board/R-1.txt"))).toBe(false);
  });

  test("the master lane is the role on the master worktree", () => {
    expect(masterLane(root)).toBe("specifier");
  });

  test("a missing flag value is an error", () => {
    expect(() => run(["list", "--root"])).toThrow(BoardError);
  });
});

describe("board lock", () => {
  test("runs the function and releases the lock", () => {
    expect(withBoardLock(root, () => 42)).toBe(42);
    expect(existsSync(join(root, ".swarmforge/board/tasks.lock.d"))).toBe(false);
  });

  test("releases the lock when the function throws", () => {
    expect(() => withBoardLock(root, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(join(root, ".swarmforge/board/tasks.lock.d"))).toBe(false);
  });

  test("takes over a lock left by a dead process", () => {
    const lock = join(root, ".swarmforge/board/tasks.lock.d");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999");
    expect(withBoardLock(root, () => "ok")).toBe("ok");
  });

  test("takes over a lock that is too old even if its owner is alive", () => {
    const lock = join(root, ".swarmforge/board/tasks.lock.d");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withBoardLock(root, () => "ok")).toBe("ok");
  });
});
