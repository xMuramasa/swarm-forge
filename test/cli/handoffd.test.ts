import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configure, loadRoles, nonForwarding, parseMessage, phantomSender, recipientList, renderMessage, shouldHold,
} from "../../swarmforge/scripts/handoffd.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "handoffd-"));
  mkdirSync(join(root, ".swarmforge"), { recursive: true });
  configure(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("messages", () => {
  test("recipients are trimmed and blanks dropped", () => {
    expect(recipientList({ to: "coder, cleaner ,, " })).toEqual(["coder", "cleaner"]);
    expect(recipientList({})).toEqual([]);
  });

  test("phantom senders are the (New Task) style names", () => {
    expect(phantomSender("(New Task)")).toBe(true);
    expect(phantomSender("coder")).toBe(false);
    expect(nonForwarding({ "non-forwarding": "true" })).toBe(true);
    expect(nonForwarding({})).toBe(false);
  });

  test("parse then render keeps the headers in the daemon's order and the body", () => {
    const message = parseMessage("type: note\nfrom: coder\nx-extra: 1\nto: cleaner\n\npayload\n");
    expect(message.body).toBe("payload\n");
    expect(renderMessage(message.headers, message.body)).toBe("from: coder\nto: cleaner\ntype: note\nx-extra: 1\n\npayload\n");
  });

  test("a message without a body separator has an empty body", () => {
    expect(parseMessage("from: a").body).toBe("");
  });
});

describe("approval gate", () => {
  const roles = () => {
    writeFileSync(join(root, ".swarmforge", "roles.tsv"), "specifier\tmaster\t/p\ts\tS\tclaude\ttask\nqa\tqa\t/p/qa\tq\tQ\tclaude\ttask\n");
    return loadRoles();
  };

  test("the master's git handoff to a single role is held until approved", () => {
    const held = { type: "git_handoff", from: "specifier", to: "coder" };
    expect(shouldHold(roles(), held)).toBe(true);
    expect(shouldHold(roles(), { ...held, approved: "true" })).toBe(false);
    expect(shouldHold(roles(), { ...held, to: "coder,qa" })).toBe(false);
    expect(shouldHold(roles(), { ...held, from: "qa" })).toBe(false);
    expect(shouldHold(roles(), { ...held, type: "note" })).toBe(false);
  });

  test("a pack without a specifier never holds", () => {
    writeFileSync(join(root, ".swarmforge", "roles.tsv"), "coder\tmaster\t/p\tc\tC\tclaude\ttask\n");
    expect(shouldHold(loadRoles(), { type: "git_handoff", from: "coder", to: "cleaner" })).toBe(false);
  });
});
