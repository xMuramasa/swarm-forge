import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentArgv, displayNameForRole, ensureCodexTrust, parseAccounts, protectedBranches, sleepInhibitorPrefix,
  skipConfigLine, specialWorktree, visibleWindow, yoloFlag,
} from "../../swarmforge/scripts/swarmforge.ts";

describe("config lines", () => {
  test("blank lines and comments are skipped", () => {
    expect(skipConfigLine("# hi")).toBe(true);
    expect(skipConfigLine("")).toBe(true);
    expect(skipConfigLine("window coder claude master")).toBe(false);
  });

  test("master and none are special worktrees", () => {
    expect(specialWorktree("master")).toBe(true);
    expect(specialWorktree("none")).toBe(true);
    expect(specialWorktree("coder")).toBe(false);
  });

  test("window is visible and window-invisible is not", () => {
    expect(visibleWindow("window", 1)).toBe(true);
    expect(visibleWindow("window-invisible", 2)).toBe(false);
  });

  test("display names capitalize each word", () => {
    expect(displayNameForRole("project-manager")).toBe("Project Manager");
    expect(displayNameForRole("QA")).toBe("Qa");
  });
});

describe("backend flags", () => {
  test("each backend bypasses permission prompts unless the conf already did", () => {
    expect(yoloFlag("codex", {})).toBe("--yolo ");
    expect(yoloFlag("codex", { extraArgs: "--yolo" })).toBe("");
    expect(yoloFlag("claude", {})).toBe("--permission-mode bypassPermissions ");
    expect(yoloFlag("claude", { extraArgs: "--permission-mode bypassPermissions" })).toBe("");
    expect(yoloFlag("unknown", {})).toBe("");
  });

  const row = (agent: string, extraArgs?: string) => ({
    role: "coder", agent, session: "sf-x-coder", displayName: "Coder", worktreeName: "coder",
    worktreePath: "/w", receiveMode: "task", propagation: "forward-only", extraArgs, visible: true,
  });

  test("claude gets the prompt file, a name, the model and the prompt last", () => {
    expect(agentArgv(row("claude", "--model sonnet"), "Coder", "/w", "/p.md", "PROMPT")).toEqual([
      "--append-system-prompt-file", "/p.md", "--permission-mode", "bypassPermissions", "-n", "SwarmForge Coder", "--model", "sonnet", "PROMPT",
    ]);
  });

  test("codex and copilot run without the alternate screen; grok reads its rules and starts verbatim", () => {
    expect(agentArgv(row("codex"), "Coder", "/w", "/p.md", "P")).toEqual(["-C", "/w", "--no-alt-screen", "--yolo", "P"]);
    expect(agentArgv(row("copilot"), "Coder", "/w", "/p.md", "P")).toEqual(["-C", "/w", "--no-alt-screen", "--name", "SwarmForge Coder", "--yolo", "-i", "P"]);
    expect(agentArgv(row("grok"), "Coder", "/w", "/p.md", "P")).toEqual(["--cwd", "/w", "--permission-mode", "bypassPermissions", "--minimal", "--rules", "P", "--verbatim", "P"]);
  });
});

describe("branch protection", () => {
  test("main, master and develop are protected", () => {
    expect([...protectedBranches].sort()).toEqual(["develop", "main", "master"]);
  });
});

describe("accounts", () => {
  test("parses one directory per backend and expands ~", () => {
    const accounts = parseAccounts("# c\naccount personal claude=~/.claude-personal codex=/x/codex\naccount work claude=/w\n");
    expect(accounts.personal.claude.endsWith("/.claude-personal")).toBe(true);
    expect(accounts.personal.claude.startsWith("~")).toBe(false);
    expect(accounts.personal.codex).toBe("/x/codex");
    expect(accounts.work).toEqual({ claude: "/w" });
  });
});

describe("codex trust", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("trusts a worktree once and keeps existing config", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), "model = \"x\"");
    ensureCodexTrust("/some/worktree", home);
    ensureCodexTrust("/some/worktree", home);
    const text = readFileSync(join(home, "config.toml"), "utf8");
    expect(text.startsWith('model = "x"\n')).toBe(true);
    expect(text.match(/\[projects\."\/some\/worktree"\]/g)?.length).toBe(1);
    expect(text).toContain('trust_level = "trusted"');
  });
});

describe("sleep prevention", () => {
  test("is a command prefix or nothing", () => {
    const prefix = sleepInhibitorPrefix();
    expect(prefix === undefined || Array.isArray(prefix)).toBe(true);
  });
});
