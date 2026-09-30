import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendByline, byline } from "../../swarmforge/scripts/commit_msg_hook.ts";
import { headerField, setHeader, setHeaderLines, splitLines } from "../../swarmforge/scripts/handoff_lib.ts";
import { waitMessage } from "../../swarmforge/scripts/ready_for_next_guard.ts";

describe("commit hook", () => {
  test("signs the message with the role", () => {
    expect(byline("specifier")).toBe("By specifier.");
    expect(appendByline("hello", "coder")).toBe("hello\n\nBy coder.\n");
  });
});

describe("ready_for_next guard", () => {
  test("the wait message names the held handoffs", () => {
    const [first, second] = waitMessage(["/tmp/a.handoff"]);
    expect(first).toContain("WAITING_FOR_APPROVAL");
    expect(second).toContain("/tmp/a.handoff");
  });
});

describe("handoff header editing", () => {
  test("splitLines drops the empty last line like Clojure's split-lines", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  test("setHeaderLines replaces in place, appends at the end of the headers, and keeps the body", () => {
    expect(setHeaderLines(["a: 1", "b: 2", "", "body"], "b", "9")).toEqual(["a: 1", "b: 9", "", "body"]);
    expect(setHeaderLines(["a: 1", "", "body"], "c", "3")).toEqual(["a: 1", "c: 3", "", "body"]);
    expect(setHeaderLines(["a: 1"], "c", "3")).toEqual(["a: 1", "c: 3"]);
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "protocol-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("setHeader rewrites the file without growing it on each call", () => {
    const file = join(dir, "x.handoff");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "type: note\nto: coder\n\nbody\n");
    setHeader(file, "dequeued_at", "t1");
    setHeader(file, "dequeued_at", "t2");
    expect(readFileSync(file, "utf8")).toBe("type: note\nto: coder\ndequeued_at: t2\n\nbody\n");
    expect(headerField(file, "dequeued_at")).toBe("t2");
    expect(headerField(file, "missing")).toBeUndefined();
  });
});
