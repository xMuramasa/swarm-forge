// Black-box tests for the launcher, handoff_lib's command line, swarm_tool, the commit hook,
// close-swarm, get-swarm-forge and the account plumbing.

import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  exists, fake, initRepo, readFile, repoRoot, run, script, tmpDir, writeFile,
} from "./support.ts";

const launcher = script("swarmforge.ts");
const lib = script("handoff_lib.ts");
const tool = script("swarm_tool.sh");
const isExecutable = (path: string) => exists(path) && (statSync(path).mode & 0o111) !== 0;
const rolesLine = (root: string, mode = "task") => `specifier\tmaster\t${root}\tsession\tSpecifier\tcodex\t${mode}\n`;

/** A project with a constitution, the given conf and one prompt per role. */
function packProject(conf: string, roles: string[] = ["coder"]): string {
  const root = tmpDir();
  writeFile(join(root, "swarmforge/constitution.prompt"), "Read articles.\n");
  writeFile(join(root, "swarmforge/swarmforge.conf"), conf);
  for (const role of roles) writeFile(join(root, `swarmforge/roles/${role}.prompt`), `${role}\n`);
  return root;
}

const parse = (root: string, env: Record<string, string> = {}, ok = true) =>
  run({ dir: root, env, ok }, "bun", launcher, "--test-parse", root);
const launchCommand = (root: string, agent: string, ...extra: string[]) =>
  run({ dir: root }, "bun", launcher, "--test-launch-command", root, agent, ...extra).out;

describe("handoff_lib command line", () => {
  test("parses and prints a handoff file", () => {
    const root = tmpDir();
    writeFile(join(root, "task.handoff"),
      "id: 1\nfrom: coder\nto: cleaner\npriority: 10\ntype: git_handoff\ntask: task-alpha\n\nmerge_and_process coder abcdef1234\n");
    const at = (...args: string[]) => run({ dir: root }, "bun", lib, ...args).out;
    expect(at("header-field", "task.handoff", "task")).toContain("task-alpha");
    expect(at("body", "task.handoff")).toContain("merge_and_process coder abcdef1234");
    const task = at("print-task", "task.handoff");
    expect(task).toContain("TASK: task.handoff");
    expect(task).toContain("FROM: coder");
    expect(task).toContain("TASK_NAME: task-alpha");
  });

  test("updates headers and reads role state", () => {
    const root = tmpDir();
    initRepo(root);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `coder\tmaster\t${root}\tsession\tCoder\tcodex\ttask\ncleaner\tcleaner\t${root}/.worktrees/cleaner\tsession\tCleaner\tcodex\tbatch\n`);
    writeFile(join(root, ".swarmforge/handoffs/inbox/new/item.handoff"),
      "id: 1\nfrom: coder\nto: cleaner\npriority: 20\ntype: note\n\npayload\n");
    const at = (...args: string[]) => run({ dir: root }, "bun", lib, ...args).out;
    at("role-known", "cleaner");
    at("set-header", ".swarmforge/handoffs/inbox/new/item.handoff", "dequeued_at", "2026-06-16T00:00:00Z");
    expect(at("role-receive-mode", "cleaner")).toContain("batch");
    expect(at("role-worktree-name", "cleaner")).toContain("cleaner");
    expect(at("header-field", ".swarmforge/handoffs/inbox/new/item.handoff", "dequeued_at")).toContain("2026-06-16T00:00:00Z");
    expect(at("next-sequence")).toContain("000001");
    expect(at("next-sequence")).toContain("000002");
  });

  test("reads role propagation", () => {
    const root = tmpDir();
    initRepo(root);
    writeFile(join(root, ".swarmforge/roles.tsv"),
      `coder\tmaster\t${root}\tsession\tCoder\tcodex\ttask\ncleaner\tcleaner\t${root}\tsession\tCleaner\tcodex\tbatch\tback-one\narchitect\tarchitect\t${root}\tsession\tArchitect\tcodex\tbatch\tback-all\n`);
    const at = (role: string) => run({ dir: root }, "bun", lib, "role-propagation", role).out;
    expect(at("coder")).toContain("forward-only");
    expect(at("cleaner")).toContain("back-one");
    expect(at("architect")).toContain("back-all");
  });

  test("a blank receive mode means task", () => {
    const root = tmpDir();
    initRepo(root);
    writeFile(join(root, ".swarmforge/roles.tsv"), `sender\tmaster\t${root}\tsession\tSender\tcodex\t\n`);
    for (const dir of ["outbox/tmp", "sent", "failed", "inbox/new", "inbox/in_process", "inbox/completed"]) {
      mkdirSync(join(root, ".swarmforge/handoffs", dir), { recursive: true });
    }
    const env = { SWARMFORGE_ROLE: "sender" };
    expect(run({ dir: root, env }, "bun", lib, "role-receive-mode", "sender").out).toContain("task");
    const ready = run({ dir: root, env }, script("ready_for_next.sh"));
    expect(ready.out).toContain("NO_TASK");
    writeFile(join(root, ".swarmforge/handoffs/inbox/in_process/50_item.handoff"),
      "id: 1\nfrom: sender\nto: sender\npriority: 50\ntype: note\ntask: HTW\n\nbody\n");
    const done = run({ dir: root, env }, script("done_with_current.sh"));
    expect(done.out).toContain("COMPLETED:");
    expect(done.out).toMatch(/MAIL_WAITING|NO_TASK/);
  });

  test("ready_for_next and done_with_current refuse an unknown role", () => {
    const root = tmpDir();
    initRepo(root);
    writeFile(join(root, ".swarmforge/roles.tsv"), `sender\tmaster\t${root}\tsession\tSender\tcodex\ttask\n`);
    const env = { SWARMFORGE_ROLE: "ghost" };
    for (const name of ["ready_for_next.sh", "done_with_current.sh"]) {
      const r = run({ dir: root, env, ok: false }, script(name));
      expect(r.exit).not.toBe(0);
      expect(r.err + r.out).toContain("Unknown role");
    }
  });

  test("finish-done logs a failed archive and still announces", () => {
    const root = tmpDir();
    initRepo(root);
    writeFile(join(root, ".swarmforge/roles.tsv"), `sender\tmaster\t${root}\tsession\tSender\tcodex\ttask\n`);
    mkdirSync(join(root, ".swarmforge/handoffs/inbox/new"), { recursive: true });
    const copy = join(root, "handoff_lib.ts");
    copyFileSync(lib, copy);
    const r = run({ dir: root, env: { SWARMFORGE_ROLE: "sender" } }, "bun", copy, "finish-done");
    expect(r.out).toMatch(/MAIL_WAITING|NO_TASK/);
    expect(r.err).toContain("archive failed");
    expect(r.err).toContain("sender");
    expect(r.err).toContain(root);
  });
});

describe("launcher config", () => {
  test("parses the config and writes the state files", () => {
    const root = packProject("# comment\nwindow coder codex master\nwindow cleaner codex cleaner batch\n", ["coder", "cleaner"]);
    const out = parse(root).out;
    expect(out).toContain("coder Coder");
    expect(out).toContain("cleaner Cleaner");
    expect(out).toContain("cleaner batch");
    expect(out).toMatch(/\bsf-\S+-coder\b/);
    expect(out).toMatch(/\bsf-\S+-cleaner\b/);
  });

  test("a duplicate role is rejected", () => {
    const root = packProject("window coder codex master\nwindow coder codex other\n");
    const r = parse(root, {}, false);
    expect(r.exit).toBe(1);
    expect(r.err).toContain("Duplicate role 'coder'");
  });

  test("window-invisible roles are listed as invisible", () => {
    const root = packProject("window-invisible specifier codex master\n", ["specifier"]);
    const out = parse(root).out;
    expect(out).toContain("specifier");
    expect(out).toContain("invisible");
  });

  test("the required helpers include the pack scripts", () => {
    const names = run({ dir: repoRoot }, "bun", launcher, "--test-required-helpers").out.trim().split("\n");
    expect(names).toContain("swarmctl.sh");
    expect(names).toContain("pack_board.sh");
  });

  test("exactly one master worktree is required", () => {
    const none = parse(packProject("window coder codex coder\n"), {}, false);
    expect(none.exit).toBe(1);
    expect(none.err).toContain("master");
    const two = parse(packProject("window specifier codex master\nwindow coder codex master\n", ["specifier", "coder"]), {}, false);
    expect(two.exit).toBe(1);
    expect(two.err).toContain("master");
  });

  test("sleep prevention can be disabled", () => {
    const r = run({ dir: repoRoot, env: { SWARMFORGE_PREVENT_SLEEP: "0" } }, "bun", launcher, "--test-sleep-inhibitor-prefix");
    expect(r.out.trim()).toBe("");
  });

  test("extra CLI args follow the receive mode", () => {
    const root = packProject("window coder copilot master --yolo\nwindow cleaner copilot cleaner batch --allow-all-tools\n", ["coder", "cleaner"]);
    const out = parse(root).out;
    expect(out).toContain("coder Coder");
    expect(out).toContain("task forward-only --yolo");
    expect(out).toContain("batch forward-only --allow-all-tools");
  });

  test("propagation tokens round-trip through roles.tsv", () => {
    const root = packProject(
      "window specifier grok master\nwindow coder grok coder task --yolo\nwindow refactorer grok refactorer task back-one\nwindow architect grok architect batch back-all --allow-all-tools\n",
      ["specifier", "coder", "refactorer", "architect"]);
    const r = parse(root);
    expect(r.out).toContain("specifier Specifier");
    expect(r.out).toContain("task forward-only --yolo");
    expect(r.out).toContain("task back-one");
    expect(r.out).toContain("batch back-all --allow-all-tools");
    const lines = readFile(join(root, ".swarmforge/roles.tsv")).trim().split("\n");
    expect(lines[0].endsWith("\ttask\tforward-only")).toBe(true);
    expect(lines[1]).toContain("\ttask\tforward-only");
    expect(lines[2].endsWith("\ttask\tback-one")).toBe(true);
    expect(lines[3].endsWith("\tbatch\tback-all")).toBe(true);
  });

  test("the launch plan starts every agent, invisible or not", () => {
    const root = packProject("window-invisible specifier codex master\nwindow coder codex coder\n", ["specifier", "coder"]);
    const out = run({ dir: root }, "bun", launcher, "--test-launch-plan", root).out;
    expect(out).toContain("start-agent specifier");
    expect(out).toContain("start-agent coder");
  });

  test("launching gives each role a pane and starts its agent", () => {
    const root = packProject("window coder claude master\nwindow cleaner claude cleaner\n", ["coder", "cleaner"]);
    const launched = run({ dir: root }, "bun", launcher, "--test-launch-roles", root);
    const calls = fake.calls(root);
    const starts = calls.filter((c) => c.startsWith("agent start"));
    expect(launched.out).not.toContain("is not ready");
    expect(calls.filter((c) => c.startsWith("workspace create")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("tab create")).length).toBe(0);
    expect(calls.filter((c) => c.startsWith("pane split w1:p1 --direction right --ratio 0.5")).length).toBe(1);
    expect(calls.some((c) => c.startsWith("workspace create") && c.includes("--env SWARMFORGE_ROLE=coder"))).toBe(true);
    expect(calls.some((c) => c.startsWith("pane split") && c.includes("--env SWARMFORGE_ROLE=cleaner"))).toBe(true);
    expect(calls.some((c) => /^pane run w1:p1 export PATH='[^']*\/\.swarmforge\/bin':/.test(c))).toBe(true);
    expect(calls.some((c) => /^pane run w1:p2 export PATH='[^']*\/\.swarmforge\/bin':/.test(c))).toBe(true);
    expect(starts[0]).toMatch(/^agent start sf-\S+-coder --kind claude --pane w1:p1 /);
    expect(starts[1]).toMatch(/^agent start sf-\S+-cleaner --kind claude --pane w1:p2 /);
    expect(readFile(join(root, ".swarmforge/herdr-workspace")).trim()).toBe("w1");
  });

  test("a protected branch is refused unless allowed", () => {
    const root = tmpDir();
    const fresh = tmpDir();
    const plain = tmpDir();
    const check = (dir: string, env: Record<string, string> = {}) =>
      run({ dir, env, ok: false }, "bun", launcher, "--test-branch-check", dir);
    initRepo(root);
    for (const branch of ["develop", "main", "master"]) {
      run({ dir: root }, "git", "checkout", "-q", "-B", branch);
      const r = check(root);
      expect(r.exit).toBe(1);
      expect(r.err).toContain(`Refusing to start on '${branch}'`);
      expect(r.err).toContain("git switch -c swarm/<task>");
    }
    expect(check(root, { SWARMFORGE_ALLOW_BRANCH: "1" }).exit).toBe(0);
    run({ dir: root }, "git", "checkout", "-q", "-b", "swarm/r-030");
    expect(check(root).out).toContain("branch ok");
    run({ dir: fresh }, "git", "init", "-q", "-b", "main");
    expect(check(fresh).exit).toBe(0);
    expect(check(plain).exit).toBe(0);
  });
});

describe("launch commands", () => {
  test("copilot passes the extra CLI args", () => {
    const root = tmpDir();
    const command = launchCommand(root, "copilot", "--yolo");
    expect(command).toContain("kind=copilot -- -C ");
    expect(command).toMatch(/--name SwarmForge Coder --yolo -i/);
  });

  test("grok gets its rules and the initial prompt", () => {
    const root = tmpDir();
    const command = launchCommand(root, "grok");
    expect(command).toContain("kind=grok -- --cwd ");
    expect(command).toContain("--permission-mode bypassPermissions");
    expect(command).toContain("--rules <prompt>");
    expect(command).toContain("--verbatim <prompt>");
    expect(exists(join(root, ".swarmforge/prompts/coder.md"))).toBe(true);
  });

  test("grok keeps bypass permissions next to --always-approve", () => {
    const command = launchCommand(tmpDir(), "grok", "--always-approve");
    expect(command).toContain("--permission-mode bypassPermissions");
    expect(command).toContain("--always-approve");
    expect(command).not.toContain("--permission-mode acceptEdits");
  });

  test("every backend puts the transcript in scrollback", () => {
    for (const [agent, needle] of [["codex", "--no-alt-screen"], ["copilot", "--no-alt-screen"], ["claude", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"], ["grok", "--minimal"]]) {
      expect(launchCommand(tmpDir(), agent)).toContain(needle);
    }
  });

  test("every backend bypasses permission prompts", () => {
    for (const [agent, needle] of [["codex", "--yolo"], ["copilot", "--yolo"], ["claude", "--permission-mode bypassPermissions"], ["grok", "--permission-mode bypassPermissions"]]) {
      expect(launchCommand(tmpDir(), agent)).toContain(needle);
    }
  });

  test("the project tool bin is on PATH", () => {
    expect(launchCommand(tmpDir(), "codex")).toContain(".swarmforge/bin:");
  });
});

describe("codex trust", () => {
  const trust = (root: string, home: string, ...extra: string[]) =>
    run({ dir: root, env: { CODEX_HOME: home, HOME: home } }, "bun", launcher, "--test-ensure-codex-trust", root, ...extra);
  const header = (wt: string) => `[projects.${JSON.stringify(wt)}]`;
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  test("a worktree is trusted once", () => {
    const root = tmpDir();
    const home = tmpDir("codex-home.");
    trust(root, home);
    trust(root, home);
    const cfg = readFile(join(home, "config.toml"));
    expect(cfg).toContain(header(root));
    expect(cfg).toContain('trust_level = "trusted"');
    expect(count(cfg, header(root))).toBe(1);
  });

  test("an existing project block is left alone", () => {
    const root = tmpDir();
    const home = tmpDir("codex-home.");
    const original = `${header(root)}\ntrust_level = "untrusted"\nnote = "keep"\n`;
    writeFile(join(home, "config.toml"), original);
    trust(root, home);
    expect(readFile(join(home, "config.toml"))).toBe(original);
  });

  test("other config is kept exactly once", () => {
    const root = tmpDir();
    const home = tmpDir("codex-home.");
    writeFile(join(home, "config.toml"), 'model = "gpt-5.5"\n\n[projects."/other"]\ntrust_level = "trusted"\n');
    trust(root, home);
    const cfg = readFile(join(home, "config.toml"));
    expect(count(cfg, 'model = "gpt-5.5"')).toBe(1);
    expect(count(cfg, '[projects."/other"]')).toBe(1);
    expect(count(cfg, header(root))).toBe(1);
  });

  test("trust is written into the account home", () => {
    const root = tmpDir();
    const home = tmpDir("codex-account.");
    run({ dir: root, env: { HOME: root } }, "bun", launcher, "--test-ensure-codex-trust", root, home);
    expect(readFile(join(home, "config.toml"))).toContain(header(root));
  });
});

describe("swarm_tool", () => {
  const project = () => {
    const root = tmpDir();
    writeFile(join(root, ".swarmforge/roles.tsv"), rolesLine(root));
    return root;
  };
  /** A stand-in `bb` that prints its arguments, so the wrappers' rewriting shows. */
  const echoBb = () => {
    const bin = tmpDir("echo-bb.");
    writeFile(join(bin, "bb"), '#!/bin/sh\necho "$@"\n');
    chmodSync(join(bin, "bb"), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  };
  const stubSource = (root: string, name: string) => {
    writeFile(join(root, ".swarmforge/tools", name, "bb.edn"), `{:tasks {${name} identity}}\n`);
  };

  test("knows the constitution tool names", () => {
    const root = project();
    const missing = run({ dir: root, ok: false }, tool, "require", "clj-mutate");
    const help = run({ dir: root, ok: false }, tool, "--help");
    const text = help.err + help.out;
    expect(missing.exit).not.toBe(0);
    expect(missing.err).toContain("MISSING: clj-mutate");
    expect(missing.err).not.toContain("Unknown tool");
    for (const name of ["clj-mutate", "crap4clj", "dry4clj", "cloverage", "speclj", "speclj-structure-check"]) expect(text).toContain(name);
  });

  test("ensure installs exec wrappers for jscpd and lizard", () => {
    const root = project();
    for (const [name, command] of [["jscpd", 'exec pnpm dlx jscpd "$@"'], ["lizard", 'exec uvx lizard "$@"']]) {
      run({ dir: root }, tool, "ensure", name);
      expect(readFile(join(root, ".swarmforge/bin", name))).toContain(command);
      expect(run({ dir: root }, tool, "require", name).out).toContain("OK:");
    }
  });

  test("ensure cloverage invokes cloverage, not crap4clj", () => {
    const root = project();
    run({ dir: root }, tool, "ensure", "cloverage");
    const wrapper = readFile(join(root, ".swarmforge/bin/cloverage"));
    for (const needle of ["cloverage.coverage", "cloverage/cloverage", '"src"', '"spec"', '"test"', "-s spec", "-r speclj", "speclj/speclj"]) {
      expect(wrapper).toContain(needle);
    }
    expect(wrapper).not.toContain("crap4clj");
    expect(run({ dir: root }, tool, "require", "cloverage").exit).toBe(0);
    expect(run({ dir: root }, tool, "require", "Cloverage").exit).toBe(0);
  });

  test("ensure speclj runs speclj.main", () => {
    const root = project();
    run({ dir: root }, tool, "ensure", "speclj");
    const wrapper = readFile(join(root, ".swarmforge/bin/speclj"));
    expect(wrapper).toContain("speclj.main");
    expect(wrapper).toContain("-c spec");
    expect(wrapper).toContain("3.13.0");
    expect(wrapper).not.toContain("speclj.cli");
  });

  test("ensure crap4clj and clj-mutate also install cloverage", () => {
    for (const name of ["crap4clj", "clj-mutate"]) {
      const root = project();
      stubSource(root, name);
      run({ dir: root }, tool, "ensure", name);
      expect(isExecutable(join(root, ".swarmforge/bin", name))).toBe(true);
      expect(isExecutable(join(root, ".swarmforge/bin/cloverage"))).toBe(true);
      expect(readFile(join(root, ".swarmforge/bin/cloverage"))).toContain("cloverage.coverage");
    }
  });

  test("require reports missing APS tools, and ensure installs wrappers from a local source", () => {
    const root = project();
    const aps = join(root, "aps-src");
    writeFile(join(aps, "bb.edn"), "{:tasks {gherkin-parser identity\n  gherkin-ir-dry-checker identity}}\n");
    const missing = run({ dir: root, ok: false }, tool, "require", "gherkin-parser");
    expect(missing.exit).not.toBe(0);
    expect(missing.err).toContain("MISSING: gherkin-parser");
    for (const name of ["gherkin-parser", "ir-dry-checker"]) run({ dir: root, env: { SWARMFORGE_TOOL_SRC: aps } }, tool, "ensure", name);
    expect(isExecutable(join(root, ".swarmforge/bin/gherkin-parser"))).toBe(true);
    expect(isExecutable(join(root, ".swarmforge/bin/ir-dry-checker"))).toBe(true);
    expect(run({ dir: root }, tool, "require", "gherkin-parser").exit).toBe(0);
    expect(run({ dir: root }, tool, "require", "ir-dry-checker").exit).toBe(0);
  });

  test("the clj-mutate wrapper is differential with four workers", () => {
    const root = project();
    const env = echoBb();
    stubSource(root, "clj-mutate");
    run({ dir: root, env }, tool, "ensure", "clj-mutate");
    const wrapper = join(root, ".swarmforge/bin/clj-mutate");
    const out = run({ dir: root, env }, wrapper, "src/htw/game.clj", "--reuse-lcov", "--mutate-all", "--test-command", "bb test").out;
    expect(out).toContain("--max-workers 4");
    expect(out).not.toContain("--mutate-all");
    const scan = run({ dir: root, env }, wrapper, "src/htw/game.clj", "--scan").out;
    expect(scan).not.toContain("--max-workers");
  });

  test("the gherkin-mutator wrapper is differential with four workers", () => {
    const root = project();
    const env = echoBb();
    const aps = join(root, "aps-src");
    writeFile(join(aps, "bb.edn"), "{:tasks {gherkin-mutator identity}}\n");
    run({ dir: root, env: { ...env, SWARMFORGE_TOOL_SRC: aps } }, tool, "ensure", "gherkin-mutator");
    const out = run({ dir: root, env }, join(root, ".swarmforge/bin/gherkin-mutator"),
      "--feature", "features/a.feature", "--level", "full", "--runner-worker", "true").out;
    expect(out).toContain("--level hard");
    expect(out).toContain("--workers 4");
    expect(out).not.toContain("--level full");
  });

  test("the wrappers take no lock file", () => {
    const root = project();
    stubSource(root, "crap4clj");
    run({ dir: root }, tool, "ensure", "crap4clj");
    const wrapper = readFile(join(root, ".swarmforge/bin/crap4clj"));
    expect(wrapper).not.toContain("constitution-tools.lock");
    expect(wrapper).not.toContain("SWARMFORGE_TOOL_HELD");
  });
});

describe("commit-msg hook", () => {
  const body = (root: string) => run({ dir: root }, "git", "log", "-1", "--format=%B").out;
  const hooked = () => {
    const root = tmpDir();
    initRepo(root);
    writeFile(join(root, ".swarmforge/roles.tsv"), rolesLine(root));
    run({ dir: root }, "bun", launcher, "--test-install-hooks", root);
    return root;
  };
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  test("adds the missing role byline once", () => {
    const root = hooked();
    const env = { SWARMFORGE_ROLE: "specifier" };
    writeFile(join(root, "spec.md"), "hunt\n");
    run({ dir: root }, "git", "add", "spec.md");
    run({ dir: root, env }, "git", "commit", "-q", "-m", "Specify Hunt the Wumpus console app");
    expect(body(root)).toContain("Specify Hunt the Wumpus console app");
    expect(count(body(root), "By specifier.")).toBe(1);
    writeFile(join(root, "spec.md"), "hunt two\n");
    run({ dir: root }, "git", "add", "spec.md");
    run({ dir: root, env }, "git", "commit", "-q", "-m", "Add a scenario\n\nBy specifier.");
    expect(count(body(root), "By specifier.")).toBe(1);
  });

  test("infers the role from the worktree", () => {
    const root = hooked();
    writeFile(join(root, "spec.md"), "hunt\n");
    run({ dir: root }, "git", "add", "spec.md");
    run({ dir: root }, "git", "commit", "-q", "-m", "Specify Hunt the Wumpus console app");
    expect(body(root)).toContain("By specifier.");
  });
});

describe("close-swarm", () => {
  const closeSwarm = join(repoRoot, "close-swarm");

  test("reports when there is no swarm state", () => {
    const root = tmpDir();
    const r = run({ dir: root, ok: false }, closeSwarm, root);
    expect(r.exit).not.toBe(0);
    expect(r.err + r.out).toContain("No SwarmForge swarm");
  });

  test("closes the workspace and stops the daemon", () => {
    const root = tmpDir();
    // Not our child, so it is reaped by init as soon as it dies and `kill -0` stops seeing it.
    const pid = Number(run({ dir: root }, "sh", "-c", "sleep 120 >/dev/null 2>&1 & echo $!").out.trim());
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      writeFile(join(root, ".swarmforge/herdr-workspace"), "w7\n");
      writeFile(join(root, ".swarmforge/daemon/handoffd.pid"), `${pid}\n`);
      const r = run({ dir: root }, closeSwarm, root);
      expect(r.exit).toBe(0);
      expect(fake.closed(root)).toEqual(["w7"]);
      expect(exists(join(root, ".swarmforge/herdr-workspace"))).toBe(false);
      expect(exists(join(root, ".swarmforge/daemon/handoffd.pid"))).toBe(false);
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, "SIGKILL");
    }
  });
});

describe("get-swarm-forge", () => {
  const getSwarmForge = join(repoRoot, "get-swarm-forge");
  /** A main checkout and a pack tree, just big enough to compose a project. */
  const fixture = (projectPrompt = "PACK-PROJECT\n") => {
    const base = tmpDir();
    const pack = tmpDir();
    for (const name of ["swarmforge.sh", "handoffd.ts", "done_with_current.sh"]) writeFile(join(base, "swarmforge/scripts", name), `${name}\n`);
    for (const article of ["engineering", "workflow", "handoffs"]) writeFile(join(base, "swarmforge/constitution/articles", `${article}.prompt`), `MAIN-${article}\n`);
    writeFile(join(pack, "swarm"), "#!/bin/sh\necho pack-swarm\n");
    writeFile(join(pack, "swarmforge/swarmforge.conf"), "window specifier claude master\n");
    writeFile(join(pack, "swarmforge/constitution.prompt"), "PACK-CONSTITUTION\n");
    writeFile(join(pack, "swarmforge/roles/specifier.prompt"), "specifier\n");
    writeFile(join(pack, "swarmforge/constitution/articles/project.prompt"), projectPrompt);
    writeFile(join(pack, "swarmforge/constitution/articles/engineering.prompt"), "PACK-STALE\n");
    const install = (project: string, ...args: string[]) =>
      run({ dir: project, ok: false, env: { SWARMFORGE_BASE_DIR: base, SWARMFORGE_PACKS_DIR: pack } }, getSwarmForge, "mini-forge", ...args);
    return { install };
  };
  const articlePath = (project: string, name: string) => join(project, "swarmforge/constitution/articles", `${name}.prompt`);

  test("composes mini-forge from main and the pack", () => {
    const project = tmpDir();
    const r = fixture().install(project);
    expect(r.exit).toBe(0);
    expect(exists(join(project, "swarmforge/scripts/handoffd.ts"))).toBe(true);
    expect(readFile(articlePath(project, "engineering"))).toBe("MAIN-engineering\n");
    expect(readFile(articlePath(project, "project"))).toBe("PACK-PROJECT\n");
    expect(readFile(join(project, "swarm"))).toBe("#!/bin/sh\necho pack-swarm\n");
    expect(exists(join(project, "swarmforge/roles/specifier.prompt"))).toBe(true);
  });

  test("writes the project language into the constitution", () => {
    const { install } = fixture("# Project Rules\n- Project language: not set.\n- Keep state local.\n");
    const typed = tmpDir();
    const untyped = tmpDir();
    const bad = tmpDir();
    expect(install(typed, "typescript").exit).toBe(0);
    expect(readFile(articlePath(typed, "project"))).toContain("- Project language: TypeScript.\n");
    expect(readFile(articlePath(typed, "project"))).toContain("- Keep state local.");
    const none = install(untyped);
    expect(none.exit).toBe(0);
    expect(none.err).toContain("project language is not set");
    expect(readFile(articlePath(untyped, "project"))).toContain("not set");
    const unknown = install(bad, "cobol");
    expect(unknown.exit).toBe(1);
    expect(unknown.err).toContain("unknown language 'cobol'");
  });
});

describe("crap.sh", () => {
  test("fails when a function is over the threshold", () => {
    const root = tmpDir();
    const bin = join(root, "bin");
    writeFile(join(bin, "lizard"),
      "#!/bin/sh\nprintf '%s\\n' '13,5,60,1,14,\"classify@1-14@src/c.ts\",\"src/c.ts\",\"classify\",\"classify ( n )\",1,14'\n");
    chmodSync(join(bin, "lizard"), 0o755);
    writeFile(join(root, "cov.lcov"), "SF:src/c.ts\nDA:2,2\nDA:3,1\nDA:6,0\nDA:7,0\nend_of_record\n");
    const crap = (threshold: string) =>
      run({ dir: root, ok: false, env: { PATH: `${bin}:${process.env.PATH}` } }, script("crap.sh"), "--lcov", "cov.lcov", "--threshold", threshold, "src/c.ts");
    const strict = crap("5");
    const lenient = crap("10");
    expect(strict.exit).toBe(1);
    expect(strict.out).toContain("classify");
    expect(lenient.exit).toBe(0);
    expect(lenient.out).toContain("0 over CRAP");
  });
});

describe("accounts", () => {
  const fixture = (root: string) => {
    const dir = (name: string) => { mkdirSync(join(root, "accounts", name), { recursive: true }); return join(root, "accounts", name); };
    const personal = dir("personal-claude");
    const codex = dir("personal-codex");
    const work = dir("work-claude");
    const registry = writeFile(join(root, "accounts.conf"),
      `# name and one dir per backend\naccount personal claude=${personal} codex=${codex}\naccount work claude=${work}\n`);
    return { personal, codex, work, env: { SWARMFORGE_ACCOUNTS_FILE: registry } };
  };
  const setConf = (root: string, conf: string) => {
    writeFile(join(root, "swarmforge/constitution.prompt"), "Read articles.\n");
    writeFile(join(root, "swarmforge/swarmforge.conf"), conf);
    writeFile(join(root, "swarmforge/roles/coder.prompt"), "coder\n");
    writeFile(join(root, "swarmforge/roles/cleaner.prompt"), "cleaner\n");
  };

  test("the project conf selects the billing account", () => {
    const root = tmpDir();
    const { env } = fixture(root);
    setConf(root, "account personal\nwindow coder claude master\n");
    expect(parse(root, env).out).toContain("account personal");
  });

  test("SWARMFORGE_ACCOUNT overrides the conf", () => {
    const root = tmpDir();
    const { env } = fixture(root);
    setConf(root, "account personal\nwindow coder claude master\n");
    const out = parse(root, { ...env, SWARMFORGE_ACCOUNT: "work" }).out;
    expect(out).toContain("account work");
    expect(out).not.toContain("account personal");
  });

  test("each backend's config dir is set for its agent", () => {
    const root = tmpDir();
    const { env, personal, codex } = fixture(root);
    const spec = (agent: string, extra: Record<string, string>) =>
      run({ dir: root, env: { ...env, ...extra } }, "bun", launcher, "--test-launch-command", root, agent).out;
    expect(spec("claude", { SWARMFORGE_ACCOUNT: "personal" })).toContain(`CLAUDE_CONFIG_DIR=${personal}`);
    expect(spec("codex", { SWARMFORGE_ACCOUNT: "personal" })).toContain(`CODEX_HOME=${codex}`);
    expect(spec("claude", {})).not.toContain("CLAUDE_CONFIG_DIR");
  });

  test("account problems stop the launch with a reason", () => {
    const root = tmpDir();
    const { env, work } = fixture(root);
    const attempt = (conf: string) => {
      setConf(root, conf);
      return parse(root, env, false);
    };
    let r = attempt("account nobody\nwindow coder claude master\n");
    expect(r.exit).toBe(1);
    expect(r.err).toContain("Unknown account 'nobody'");
    r = attempt("account work\nwindow coder codex master\n");
    expect(r.exit).toBe(1);
    expect(r.err).toContain("has no codex directory");
    rmSync(work, { recursive: true, force: true });
    r = attempt("account work\nwindow coder claude master\n");
    expect(r.exit).toBe(1);
    expect(r.err).toContain("does not exist");
    r = attempt("account work\naccount work\nwindow coder claude master\n");
    expect(r.exit).toBe(1);
    expect(r.err).toContain("Duplicate account line");
  });

  test("the account reaches every role pane through herdr", () => {
    const root = tmpDir();
    const { env, personal } = fixture(root);
    setConf(root, "account personal\nwindow coder claude master\nwindow cleaner claude cleaner\n");
    run({ dir: root, env }, "bun", launcher, "--test-launch-roles", root);
    const opens = fake.calls(root).filter((c) => /^(workspace create|pane split)/.test(c));
    expect(opens.length).toBe(2);
    expect(opens.every((c) => c.includes(`--env CLAUDE_CONFIG_DIR=${personal}`))).toBe(true);
  });
});
