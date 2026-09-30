import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentWorkStateErrors, parseDraft, taskStateErrors, validate, validateRecipients,
} from "../../swarmforge/scripts/swarm_handoff.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-handoff-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const draft = (text: string) => {
  const file = join(dir, "draft.handoff");
  writeFileSync(file, text);
  return file;
};

const allKnown = { known: () => true };
const has = (result: { errors: string[] }, pattern: RegExp) => result.errors.some((e) => pattern.test(e));
const note = (extra: Record<string, string> = {}) => ({ type: "note", to: "receiver", priority: "50", message: "hello", ...extra });
const git = (extra: Record<string, string> = {}) => ({
  type: "git_handoff", to: "receiver", priority: "50", task_id: "t1", task: "t1", commit: "abcdef1234", ...extra,
});
const ok = (commit: string) => ({ canonical: () => [commit, undefined] as [string, undefined] });

describe("parseDraft", () => {
  test("reads a note draft", () => {
    const { headers, errors } = parseDraft(draft("type: note\nto: cleaner\npriority: 50\nmessage: hello\n"));
    expect(errors).toEqual([]);
    expect(headers).toEqual({ type: "note", to: "cleaner", priority: "50", message: "hello" });
  });

  test("reports duplicate, unknown, reserved and empty headers, and ignores the body", () => {
    const { errors, ordered } = parseDraft(draft("type: note\ntype: note\nid: 1\nbogus: x\nto: \n\nfrom: body-is-ignored\n"));
    expect(errors).toEqual([
      "Line 2: duplicate header 'type'.",
      "Line 3: header 'id' is reserved and must not be written by agents.",
      "Line 4: unknown header 'bogus'.",
      "Line 5: field and value must both be non-empty.",
    ]);
    expect(ordered).toEqual(["type"]);
  });

  test("a value may contain colons", () => {
    expect(parseDraft(draft("message: a: b\n")).headers.message).toBe("a: b");
  });
});

describe("state errors outside git handoffs", () => {
  test("notes have none", () => {
    expect(currentWorkStateErrors({ type: "note" })).toEqual([]);
    expect(taskStateErrors({ type: "note" })).toEqual([]);
  });
});

describe("validate", () => {
  test("a good note has no errors and a single recipient", () => {
    const result = validate(note(), ["type", "to", "priority", "message"], allKnown);
    expect(result.errors).toEqual([]);
    expect(result.recipients).toEqual(["receiver"]);
    expect(result.canonicalCommit).toBeUndefined();
  });

  test("required headers, type and priority", () => {
    const missing = validate({}, [], allKnown);
    expect(has(missing, /Missing required header 'type'/)).toBe(true);
    expect(has(missing, /Missing required header 'to'/)).toBe(true);
    expect(has(missing, /Missing required header 'priority'/)).toBe(true);
    expect(has(validate({ type: "fax", to: "receiver", priority: "50" }, ["type", "to", "priority"], allKnown), /must be one of git_handoff or note/)).toBe(true);
    expect(has(validate(note({ priority: "zz" }), ["type", "to", "priority", "message"], allKnown), /two digits from 00 to 99/)).toBe(true);
  });

  test("headers a type does not allow", () => {
    const result = validate(note({ commit: "abcdef1234", task: "nope" }), ["type", "to", "priority", "message", "commit", "task"], allKnown);
    expect(has(result, /Header 'commit' is not allowed for type 'note'/)).toBe(true);
    expect(has(result, /Header 'task' is not allowed for type 'note'/)).toBe(true);
    expect(has(result, /Header 'commit' is only allowed for git_handoff/)).toBe(true);
    expect(has(result, /Header 'task' is only allowed for git_handoff/)).toBe(true);
  });

  test("note messages are required and at most 80 characters", () => {
    expect(has(validate({ type: "note", to: "receiver", priority: "50" }, ["type", "to", "priority"], allKnown), /Missing required header 'message'/)).toBe(true);
    expect(has(validate(note({ message: "x".repeat(81) }), ["type", "to", "priority", "message"], allKnown), /Header 'message' must be no longer than 80/)).toBe(true);
  });

  test("a message on a git handoff is refused", () => {
    const result = validate(git({ message: "nope" }), ["type", "to", "priority", "task_id", "task", "commit", "message"], { ...allKnown, ...ok("abcdef1234") });
    expect(has(result, /Header 'message' is not allowed for type 'git_handoff'/)).toBe(true);
    expect(has(result, /Header 'message' is only allowed for note/)).toBe(true);
  });

  test("git handoffs need a commit, task_id and task", () => {
    const result = validate({ type: "git_handoff", to: "receiver", priority: "50" }, ["type", "to", "priority"], allKnown);
    expect(has(result, /Missing required header 'commit'/)).toBe(true);
    expect(has(result, /Missing required header 'task_id'/)).toBe(true);
    expect(has(result, /Missing required header 'task'/)).toBe(true);
  });

  test("the commit must be ten hex characters, and the task at most 80 characters", () => {
    const fields = ["type", "to", "priority", "task_id", "task", "commit"];
    expect(has(validate(git({ commit: "not-a-sha!" }), fields, allKnown), /exactly 10 hexadecimal characters/)).toBe(true);
    expect(has(validate(git({ task: "t".repeat(81) }), fields, { ...allKnown, ...ok("abcdef1234") }), /Header 'task' must be no longer than 80/)).toBe(true);
  });

  test("a valid git handoff resolves to the canonical commit", () => {
    const result = validate(git(), ["type", "to", "priority", "task_id", "task", "commit"], { ...allKnown, ...ok("abcdef1234") });
    expect(result.errors).toEqual([]);
    expect(result.canonicalCommit).toBe("abcdef1234");
  });

  test("an ambiguous or non-commit object is refused", () => {
    const fields = ["type", "to", "priority", "task_id", "task", "commit"];
    const ambiguous = validate(git(), fields, { ...allKnown, canonical: () => [undefined, "Header 'commit' must resolve to exactly one Git object; 'abcdef1234' matched 2."] });
    expect(has(ambiguous, /must resolve to exactly one Git object/)).toBe(true);
    const blob = validate(git(), fields, { ...allKnown, canonical: () => [undefined, "Header 'commit' must resolve to a commit; 'abcdef1234' resolves to 'blob'."] });
    expect(has(blob, /must resolve to a commit/)).toBe(true);
  });

  test("unknown recipients are refused", () => {
    const result = validate(note({ to: "ghost" }), ["type", "to", "priority", "message"], { known: () => false });
    expect(has(result, /Unknown recipient role 'ghost'/)).toBe(true);
  });
});

describe("validateRecipients", () => {
  test("blank means no recipients and no errors", () => {
    expect(validateRecipients("", () => true)).toEqual([[], []]);
  });

  test("empty, underscored and duplicate recipients", () => {
    const [, errors] = validateRecipients("receiver,,receiver,bad_role", () => true);
    expect(errors.some((e) => /empty recipient/.test(e))).toBe(true);
    expect(errors.some((e) => /underscores/.test(e))).toBe(true);
    expect(errors.some((e) => /Duplicate recipient 'receiver'/.test(e))).toBe(true);
  });
});
