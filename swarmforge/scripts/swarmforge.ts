#!/usr/bin/env bun
// The launcher: read swarmforge/swarmforge.conf, create the role worktrees, start the handoff
// daemon, and start each role as a herdr agent in a pane of the project's workspace.
//   swarmforge.ts [project-root]           start the swarm
//   swarmforge.ts --stop-project <root>    archive the panes, stop the daemon, close the workspace

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync, appendFileSync, chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, openSync,
  readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as herdr from "./herdr.ts";

const red = "\u001b[0;31m";
const green = "\u001b[0;32m";
const yellow = "\u001b[1;33m";
const cyan = "\u001b[0;36m";
const bold = "\u001b[1m";
const reset = "\u001b[0m";

// -- small helpers ----------------------------------------------------------------

/** Print the message to stderr and exit 1. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const configFail = (message: string): never => fail(`${red}Error:${reset} ${message}`);
const rejectIf = (condition: unknown, message: string): void => {
  if (condition) configFail(message);
};

function sh(command: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const commandExists = (command: string) => spawnSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`]).status === 0;
const sq = (value: string) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const isBlank = (s: string | undefined) => !s || s.trim() === "";
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const splitLines = (text: string) => text.split(/\r?\n/).filter((_, i, all) => !(i === all.length - 1 && all[i] === ""));

export const displayNameForRole = (role: string) =>
  role.replace(/[-_]/g, " ").split(/\s+/).filter(Boolean).map(capitalize).join(" ");

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// -- context ------------------------------------------------------------------------

export type Row = {
  role: string; agent: string; session: string; displayName: string; worktreeName: string;
  worktreePath: string; receiveMode: string; propagation: string; extraArgs?: string; visible: boolean;
};

export type Ctx = {
  workingDir: string; scriptDir: string; swarmForgeDir: string; worktreesDir: string; configFile: string;
  rolesDir: string; constitutionFile: string; stateDir: string; notifyDir: string; sessionsFile: string;
  rolesFile: string; promptsDir: string; daemonDir: string; handoffDaemonLog: string;
  roles: Row[]; accountName?: string; account?: { name: string; dirs: Record<string, string> };
};

export function context(workingDir: string): Ctx {
  const wd = resolve(workingDir);
  const swarmForgeDir = join(wd, "swarmforge");
  const stateDir = join(wd, ".swarmforge");
  const daemonDir = join(stateDir, "daemon");
  return {
    workingDir: wd,
    scriptDir: dirname(import.meta.path),
    swarmForgeDir,
    worktreesDir: join(wd, ".worktrees"),
    configFile: join(swarmForgeDir, "swarmforge.conf"),
    rolesDir: join(swarmForgeDir, "roles"),
    constitutionFile: join(swarmForgeDir, "constitution.prompt"),
    stateDir,
    notifyDir: join(stateDir, "notify"),
    sessionsFile: join(stateDir, "sessions.tsv"),
    rolesFile: join(stateDir, "roles.tsv"),
    promptsDir: join(stateDir, "prompts"),
    daemonDir,
    handoffDaemonLog: join(daemonDir, "handoffd.log"),
    roles: [],
  };
}

// -- git ------------------------------------------------------------------------------

function ensureInFile(file: string, pattern: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "");
  if (!splitLines(readFileSync(file, "utf8")).includes(pattern)) appendFileSync(file, `${pattern}\n`);
}

function ensureInitialGitignore(ctx: Ctx): void {
  const gitignore = join(ctx.workingDir, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, ".swarmforge/\n.worktrees/\n");
  } else {
    ensureInFile(gitignore, ".swarmforge/");
    ensureInFile(gitignore, ".worktrees/");
  }
}

function ensureRuntimeGitExcludes(ctx: Ctx): void {
  const path = sh("git", "-C", ctx.workingDir, "rev-parse", "--git-path", "info/exclude").out;
  const exclude = isAbsolute(path) ? path : resolve(ctx.workingDir, path);
  ensureInFile(exclude, ".swarmforge/");
  ensureInFile(exclude, ".worktrees/");
}

function initializeGitRepo(ctx: Ctx): void {
  if (existsSync(join(ctx.workingDir, ".git"))) return;
  sh("git", "init", ctx.workingDir);
  sh("git", "-C", ctx.workingDir, "branch", "-M", "master");
  ensureInitialGitignore(ctx);
  sh("git", "-C", ctx.workingDir, "add", ".");
  sh("git", "-C", ctx.workingDir, "commit", "-m", "Initial swarmforge repository");
}

// -- config ---------------------------------------------------------------------------

export const skipConfigLine = (line: string) => isBlank(line) || line.startsWith("#");
export const specialWorktree = (worktree: string) => worktree === "none" || worktree === "master";
const receiveModes = new Set(["task", "batch"]);
const propagationModes = new Set(["forward-only", "back-one", "back-all"]);
export const knownAgents = new Set(["claude", "codex", "copilot", "grok"]);

export function visibleWindow(directive: string, lineNo: number): boolean {
  if (directive === "window") return true;
  if (directive === "window-invisible") return false;
  return configFail(`Unknown config directive on line ${lineNo}: ${directive}`);
}

function receiveFields(trailing: string[]): [string, string, string[]] {
  let rest = trailing;
  let receive = "task";
  if (receiveModes.has(rest[0])) [receive, ...rest] = rest;
  let propagation = "forward-only";
  if (propagationModes.has(rest[0])) [propagation, ...rest] = rest;
  return [receive, propagation, rest];
}

function validateWindow(ctx: Ctx, lineNo: number, role: string, agent: string, worktree: string, receive: string, roles: Set<string>, worktrees: Set<string>): void {
  rejectIf(role.includes("_"), `Invalid role '${role}' on line ${lineNo}: role names may not contain underscores`);
  rejectIf(roles.has(role), `Duplicate role '${role}' in ${ctx.configFile}`);
  rejectIf(!specialWorktree(worktree) && worktrees.has(worktree), `Duplicate worktree '${worktree}' in ${ctx.configFile}`);
  rejectIf(worktree.includes("/") || worktree === "." || worktree === "..", `Invalid worktree '${worktree}' for role '${role}'`);
  rejectIf(!knownAgents.has(agent), `Unsupported agent '${agent}' for role '${role}'`);
  rejectIf(!receiveModes.has(receive), `Invalid receive mode '${receive}' for role '${role}' on line ${lineNo}: expected task or batch`);
  rejectIf(!existsSync(join(ctx.rolesDir, `${role}.prompt`)), `Missing role prompt ${join(ctx.rolesDir, `${role}.prompt`)}`);
}

function windowRow(ctx: Ctx, role: string, agent: string, worktree: string, receiveMode: string, propagation: string, extraArgs: string | undefined, visible: boolean): Row {
  return {
    role, agent,
    session: herdr.agentName(ctx.workingDir, role),
    displayName: displayNameForRole(role),
    worktreeName: worktree,
    worktreePath: specialWorktree(worktree) ? ctx.workingDir : join(ctx.worktreesDir, worktree),
    receiveMode, propagation, extraArgs, visible,
  };
}

function parseWindowLine(ctx: Ctx, lineNo: number, line: string, roles: Set<string>, worktrees: Set<string>): Row {
  const fields = line.split(/\s+/);
  rejectIf(fields.length < 4, `Invalid config line ${lineNo}: ${line}`);
  const [directive, role, agentRaw, worktree, ...trailing] = fields;
  const agent = agentRaw.toLowerCase();
  const [receive, propagation, extra] = receiveFields(trailing);
  const visible = visibleWindow(directive, lineNo);
  validateWindow(ctx, lineNo, role, agent, worktree, receive, roles, worktrees);
  return windowRow(ctx, role, agent, worktree, receive, propagation, extra.length ? extra.join(" ") : undefined, visible);
}

function requireMasterWorktree(rows: Row[]): void {
  rejectIf(rows.filter((r) => r.worktreeName === "master").length !== 1, "Config must name exactly one master worktree");
}

export const accountEnvVars: Record<string, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

const expandHome = (path: string) => (path.startsWith("~") ? homedir() + path.slice(1) : path);

export const accountsFile = () =>
  process.env.SWARMFORGE_ACCOUNTS_FILE || join(homedir(), ".config", "swarmforge", "accounts.conf");

/** `account <name> <backend>=<dir> ...` lines -> {name: {backend: dir}}. */
export function parseAccounts(text: string): Record<string, Record<string, string>> {
  const accounts: Record<string, Record<string, string>> = {};
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (skipConfigLine(line)) continue;
    const [directive, name, ...pairs] = line.split(/\s+/);
    rejectIf(directive !== "account" || !name, `Invalid line in ${accountsFile()}: ${line}`);
    const dirs: Record<string, string> = {};
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      const backend = eq < 0 ? pair : pair.slice(0, eq);
      const dir = eq < 0 ? "" : pair.slice(eq + 1);
      rejectIf(isBlank(backend) || isBlank(dir), `Invalid account entry '${pair}' in ${accountsFile()}; expected <backend>=<dir>`);
      dirs[backend] = expandHome(dir);
    }
    accounts[name] = dirs;
  }
  return accounts;
}

/** The project's billing account, chosen by SWARMFORGE_ACCOUNT or an `account <name>` line in the
 *  conf. Without a choice the agents inherit their environment. */
export function resolveAccount(ctx: Ctx): Ctx {
  const name = process.env.SWARMFORGE_ACCOUNT || ctx.accountName;
  if (!name) return ctx;
  const file = accountsFile();
  rejectIf(!existsSync(file) || !statSync(file).isFile(), `Account '${name}' is selected but ${file} does not exist.`);
  const dirs = parseAccounts(readFileSync(file, "utf8"))[name];
  rejectIf(!dirs, `Unknown account '${name}' in ${file}`);
  return { ...ctx, account: { name, dirs } };
}

/** Every claude or codex role needs its account directory, already logged in. */
export function checkAccountDirs(ctx: Ctx): void {
  if (!ctx.account) return;
  const { name, dirs } = ctx.account;
  for (const agent of new Set(ctx.roles.map((r) => r.agent).filter((a) => a in accountEnvVars))) {
    const dir = dirs[agent];
    rejectIf(!dir, `Account '${name}' has no ${agent} directory, but a role uses ${agent}.`);
    rejectIf(!existsSync(dir) || !statSync(dir).isDirectory(),
      `Account '${name}' ${agent} directory ${dir} does not exist. Log in once with ${accountEnvVars[agent]}=${dir} ${agent}.`);
  }
}

function parseAccountLine(line: string, lineNo: number): string {
  const fields = line.split(/\s+/);
  rejectIf(fields.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(fields[1]), `Invalid account line ${lineNo}: ${line}`);
  return fields[1];
}

export function parseConfig(ctx: Ctx): Ctx {
  rejectIf(!existsSync(ctx.configFile), `Config not found at ${ctx.configFile}`);
  rejectIf(!existsSync(ctx.constitutionFile), `Constitution prompt not found at ${ctx.constitutionFile}`);
  const rows: Row[] = [];
  const roles = new Set<string>();
  const worktrees = new Set<string>();
  let account: string | undefined;
  splitLines(readFileSync(ctx.configFile, "utf8")).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (skipConfigLine(line)) return;
    if (line.startsWith("account ")) {
      rejectIf(account, `Duplicate account line ${lineNo}`);
      account = parseAccountLine(line, lineNo);
      return;
    }
    const row = parseWindowLine(ctx, lineNo, line, roles, worktrees);
    rows.push(row);
    roles.add(row.role);
    if (!specialWorktree(row.worktreeName)) worktrees.add(row.worktreeName);
  });
  rejectIf(!rows.length, `No windows defined in ${ctx.configFile}`);
  requireMasterWorktree(rows);
  return { ...ctx, roles: rows, accountName: account };
}

function prepareCtx(ctx: Ctx): Ctx {
  const resolved = resolveAccount(parseConfig(ctx));
  checkAccountDirs(resolved);
  return resolved;
}

// -- workspace ------------------------------------------------------------------------

function writeSessionsFile(ctx: Ctx): void {
  writeFileSync(ctx.sessionsFile, ctx.roles.map((r, i) => `${i + 1}\t${r.role}\t${r.session}\t${r.displayName}\t${r.agent}\n`).join(""));
}

function writeRolesFile(ctx: Ctx): void {
  writeFileSync(ctx.rolesFile, ctx.roles.map((r) =>
    `${r.role}\t${r.worktreeName}\t${r.worktreePath}\t${r.session}\t${r.displayName}\t${r.agent}\t${r.receiveMode}\t${r.propagation}\n`).join(""));
}

export const requiredHelpers = [
  "handoff_lib.ts", "swarm_handoff.sh", "swarm_handoff.ts",
  "swarm_tool.sh", "swarm_tool.ts",
  "commit-msg-hook.sh", "commit_msg_hook.ts",
  "merge_and_process.sh", "merge_and_process.ts",
  "ready_for_next.sh", "ready_for_next.ts",
  "done_with_current.sh", "done_with_current.ts",
  "ready_for_next_task.sh", "ready_for_next_task.ts",
  "done_with_current_task.sh", "done_with_current_task.ts",
  "ready_for_next_batch.sh", "ready_for_next_batch.ts",
  "done_with_current_batch.sh", "done_with_current_batch.ts",
  "handoffd.ts", "stop_handoff_daemon.ts", "stop_handoff_daemon.sh",
  "swarmforge.sh", "swarmforge.ts",
  "pack_board.sh", "pack_board.ts",
  "swarmctl.sh", "swarmctl.ts",
];

function checkHelperScripts(ctx: Ctx): void {
  for (const helper of requiredHelpers) {
    const path = join(ctx.scriptDir, helper);
    if (!existsSync(path) || !executable(path)) fail(`${red}Error:${reset} Required helper script not found or not executable: ${path}`);
  }
}

function gitHooksDir(ctx: Ctx): string {
  const path = sh("git", "-C", ctx.workingDir, "rev-parse", "--git-path", "hooks").out;
  return isAbsolute(path) ? path : resolve(ctx.workingDir, path);
}

function installCommitMsgHook(ctx: Ctx): void {
  const dir = gitHooksDir(ctx);
  const hook = join(dir, "commit-msg");
  const script = resolve(ctx.scriptDir, "commit_msg_hook.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(hook, `#!/usr/bin/env zsh\nset -euo pipefail\nexec bun ${sq(script)} "$@"\n`);
  chmodSync(hook, 0o755);
}

function prepareWorkspace(ctx: Ctx): void {
  for (const dir of [ctx.stateDir, ctx.notifyDir, ctx.promptsDir, ctx.worktreesDir, ctx.daemonDir]) mkdirSync(dir, { recursive: true });
  checkHelperScripts(ctx);
  writeSessionsFile(ctx);
  writeRolesFile(ctx);
}

function prepareWorktrees(ctx: Ctx): void {
  for (const row of ctx.roles) {
    if (specialWorktree(row.worktreeName)) continue;
    if (existsSync(join(row.worktreePath, ".git"))) continue;
    sh("git", "-C", ctx.workingDir, "worktree", "add", "--force", "-B", `swarmforge-${row.worktreeName}`, row.worktreePath, "HEAD");
  }
}

function prepareHandoffDirs(ctx: Ctx): void {
  for (const row of ctx.roles) {
    for (const dir of ["outbox/tmp", "sent", "failed", "inbox/new", "inbox/in_process", "inbox/completed"]) {
      mkdirSync(join(row.worktreePath, ".swarmforge", "handoffs", dir), { recursive: true });
    }
  }
}

function copyTreeInto(src: string, dest: string): void {
  if (!existsSync(src) || !statSync(src).isDirectory()) return;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

function syncWorktreeRoles(ctx: Ctx, worktreePath: string): void {
  copyTreeInto(ctx.rolesDir, join(worktreePath, "swarmforge", "roles"));
  copyTreeInto(join(ctx.swarmForgeDir, "constitution"), join(worktreePath, "swarmforge", "constitution"));
  if (existsSync(ctx.constitutionFile)) {
    mkdirSync(join(worktreePath, "swarmforge"), { recursive: true });
    copyFileSync(ctx.constitutionFile, join(worktreePath, "swarmforge", "constitution.prompt"));
  }
}

function syncWorktreeScripts(ctx: Ctx): void {
  for (const row of ctx.roles) {
    if (row.worktreePath === ctx.workingDir) continue;
    const scripts = join(row.worktreePath, "swarmforge", "scripts");
    const state = join(row.worktreePath, ".swarmforge");
    mkdirSync(scripts, { recursive: true });
    for (const entry of readdirSync(ctx.scriptDir)) {
      const source = join(ctx.scriptDir, entry);
      if (statSync(source).isDirectory()) cpSync(source, join(scripts, entry), { recursive: true, force: true });
      else copyFileSync(source, join(scripts, entry));
    }
    syncWorktreeRoles(ctx, row.worktreePath);
    mkdirSync(join(state, "notify"), { recursive: true });
    copyFileSync(ctx.sessionsFile, join(state, "sessions.tsv"));
    copyFileSync(ctx.rolesFile, join(state, "roles.tsv"));
  }
}

function checkDependency(command: string): void {
  if (!commandExists(command)) fail(`${red}Error:${reset} '${command}' is required but not installed.`);
}

const checkBackendDependencies = (ctx: Ctx) => ctx.roles.forEach((r) => checkDependency(r.agent));

function checkHerdr(): void {
  checkDependency("herdr");
  if (!herdr.cli("workspace", "list").ok) fail(`${red}Error:${reset} herdr is installed but its server is not running. Start herdr first.`);
}

// -- what the agents are told ---------------------------------------------------------

const apsToolPurpose: Record<string, string> = {
  "gherkin-parser": "APS parsing", "ir-dry-checker": "IR DRY", "gherkin-mutator": "Gherkin mutation",
};

const roleRequiredTools: Record<string, string[]> = {
  specifier: ["gherkin-parser", "ir-dry-checker"],
  coder: ["gherkin-parser"],
  refactorer: ["gherkin-parser"],
  hardender: ["gherkin-parser", "gherkin-mutator"],
  architect: ["gherkin-parser", "gherkin-mutator"],
  QA: ["gherkin-parser"],
};

const requireEnsureLines = (tools: string[]) =>
  tools.map((t) => `- \`${t}\` (${apsToolPurpose[t]}): \`swarm_tool.sh require ${t}\`\n  If missing, run exactly: \`swarm_tool.sh ensure ${t}\`\n`).join("");

const parseDryCheckLines = (tools: string[]) =>
  (tools.includes("gherkin-parser") ? "- Parse with the two-arg form: `gherkin-parser <feature> ./tmp/<stem>.json`\n" : "") +
  (tools.includes("ir-dry-checker") ? "- Dry-check with the two-arg form: `ir-dry-checker <ir> ./tmp/<stem>.dry.json`\n" : "");

export function toolStartupSection(role: string, lastRole: boolean): string {
  const tools = roleRequiredTools[role] ?? [];
  return [
    "## Tool Startup\n\n",
    "- Do not search `$HOME` or run `find` for APS tools.\n",
    requireEnsureLines(tools),
    parseDryCheckLines(tools),
    "- Write scratch files and handoff drafts in `./tmp/` in the assigned worktree.\n",
    "- Do not use `/tmp` or `.swarmforge/handoffs/outbox/tmp/` as scratch.\n",
    "- Receive with `ready_for_next.sh`. Send with `swarm_handoff.sh ./tmp/<draft>`.\n",
    "- Do not search the tree or `$HOME` for those scripts.\n",
    "- Do not invoke helpers as `./swarmforge/scripts/...`. They are already on PATH.\n",
    "- Board cards live in `.swarmforge/board/tasks.tsv`. Use that card name as `task:`.\n",
    "- Operator task documents live in `tasks/<task-name>.md`. Re-read that file as operator intent. The master agent commits it with the task's first git work.\n",
    "- A retry audit may include remedial comments on named documents. Read those comments as findings.\n",
    "- Do not search the worktree for `.swarmforge/board/tasks.tsv`. That file is on the project (master).\n",
    "- Use TASK_NAME from `ready_for_next.sh` or the inbound `task:` header. For a batch, that name is the top item. The helper fills `task:` from the in-process batch, else the sender-lane card.\n",
    "- Do not invent a name or hunt `sessions.tsv`.\n",
    "- Constitution tools: `swarm_tool.sh require crap4clj` (also dry4clj, clj-mutate, cloverage, speclj, speclj-structure-check, APS, or the language table). If missing, `swarm_tool.sh ensure <tool>`. Do not invent project `bb` proxies.\n",
    "- Run constitution tools one at a time. Worker-limited tools use `--max-workers 4` or `--workers 4`. Mutation is differential: no `--mutate-all`, no `--level full`.\n",
    "- Do not clone those repos into `./tmp`.\n",
    "- If merge_and_process.sh or ready_for_next reports a merge conflict, resolve the conflicted files, git add, and commit. Do not invent git merge. Parallel cards on one tree will conflict; that is expected.\n",
    "- If you are the master agent, ask the operator directly in this pane. Otherwise send a `note` handoff to the master agent with your one-line question; do not ask in your own pane.\n",
    "- Do not ask for approval in the pane. Queue `git_handoff`; the operator approves with `./swarm approve`.\n",
    lastRole ? "- You are the last role in this pack. After this pack step, queue a git_handoff. The helper marks the card Done. Do not list every other role on to: to finish the card.\n" : "",
    role === "specifier"
      ? "- Specify from the board card and the current product tree. Do not import behavior from sibling projects.\n" +
        "- Do not ask the operator what new feature to specify or what the card already states.\n" +
        "- Finish the assigned TASK_NAME and payload (the whole card), then one git_handoff. Do not hand off after the first feature in a folder.\n"
      : "",
    role === "QA" ? "- One commit is one git_handoff. Do not send two git_handoffs of the same SHA.\n" : "",
  ].join("");
}

const lastPackRole = (ctx: Ctx, role: string) => role === ctx.roles.at(-1)?.role;

function writeAgentInstructionFile(ctx: Ctx, role: string, promptFile: string, lastRole: boolean): void {
  writeFileSync(promptFile,
    "Read swarmforge/constitution.prompt, then read every file it refers to recursively, and obey all of those instructions.\n" +
    `Read swarmforge/roles/${role}.prompt, then read every file it refers to recursively, and follow all of those instructions.\n\n` +
    toolStartupSection(role, lastRole));
}

const extraHas = (row: Pick<Row, "extraArgs">, needle: string) => (row.extraArgs ?? "").includes(needle);

export function yoloFlag(agent: string, row: Pick<Row, "extraArgs">): string {
  switch (agent) {
    case "codex": case "copilot": return extraHas(row, "--yolo") ? "" : "--yolo ";
    case "claude": return extraHas(row, "bypassPermissions") ? "" : "--permission-mode bypassPermissions ";
    default: return "";
  }
}

const altScreenEnv = (agent: string, row: Row) =>
  agent === "claude" && !extraHas(row, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN") ? "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 " : "";

const noAltScreenFlag = (agent: string, row: Row) =>
  (agent === "codex" || agent === "copilot") && !extraHas(row, "--no-alt-screen") ? "--no-alt-screen " : "";

/** Whitespace split, so a quoted extra arg containing spaces is not supported. */
const splitArgs = (s: string | undefined) => (isBlank(s) ? [] : s!.trim().split(/\s+/));

export function agentArgv(row: Row, display: string, roleWorktree: string, promptFile: string, prompt: string): string[] {
  const { agent } = row;
  const extra = splitArgs(row.extraArgs);
  switch (agent) {
    case "claude":
      return ["--append-system-prompt-file", promptFile, ...splitArgs(yoloFlag(agent, row)), "-n", `SwarmForge ${display}`, ...extra, prompt];
    case "codex":
      return ["-C", roleWorktree, ...splitArgs(noAltScreenFlag(agent, row)), ...splitArgs(yoloFlag(agent, row)), ...extra, prompt];
    case "copilot":
      return ["-C", roleWorktree, ...splitArgs(noAltScreenFlag(agent, row)), "--name", `SwarmForge ${display}`, ...splitArgs(yoloFlag(agent, row)), ...extra, "-i", prompt];
    case "grok":
      return ["--cwd", roleWorktree, "--permission-mode", "bypassPermissions", ...extra, "--minimal", "--rules", prompt, "--verbatim", prompt];
    default:
      return [];
  }
}

function accountEnv(ctx: Ctx, agent: string): Record<string, string> {
  const dir = ctx.account?.dirs[agent];
  const variable = accountEnvVars[agent];
  return dir && variable ? { [variable]: dir } : {};
}

export type LaunchSpec = { agent: string; prompt: string; promptFile: string; pathDirs: string[]; env: Record<string, string>; argv: string[] };

/** What to run for a role: `env` is set on the role's pane shell; `argv` goes to
 *  `herdr agent start --kind <agent>`. */
export function launchSpec(ctx: Ctx, row: Row): LaunchSpec {
  const roleScriptDir = row.worktreePath === ctx.workingDir ? ctx.scriptDir : join(row.worktreePath, "swarmforge", "scripts");
  const promptFile = join(ctx.promptsDir, `${row.role}.md`);
  writeAgentInstructionFile(ctx, row.role, promptFile, lastPackRole(ctx, row.role));
  const prompt = readFileSync(promptFile, "utf8");
  const env: Record<string, string> = { SWARMFORGE_ROLE: row.role, ...accountEnv(ctx, row.agent) };
  if (altScreenEnv(row.agent, row)) env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
  return {
    agent: row.agent, prompt, promptFile,
    pathDirs: [join(ctx.workingDir, ".swarmforge", "bin"), roleScriptDir],
    env,
    argv: agentArgv(row, row.displayName, row.worktreePath, promptFile, prompt),
  };
}

// -- codex trust ------------------------------------------------------------------------

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const projectTableHeader = (dir: string) => `[projects.${JSON.stringify(resolve(dir))}]`;
const ensureNewline = (text: string) => (isBlank(text) ? "" : text.endsWith("\n") ? text : `${text}\n`);

export function ensureCodexTrust(dir: string, accountHome?: string): void {
  if (isBlank(String(dir))) return;
  const home = accountHome || codexHome();
  const cfg = join(home, "config.toml");
  const header = projectTableHeader(dir);
  const text = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (text.includes(header)) return;
  mkdirSync(home, { recursive: true });
  writeFileSync(cfg, `${ensureNewline(text)}\n${header}\ntrust_level = "trusted"\n`);
}

// -- launching --------------------------------------------------------------------------

function launchRole(ctx: Ctx, row: Row, openPane: (cwd: string, env: Record<string, string>) => string): void {
  if (row.agent === "codex") ensureCodexTrust(row.worktreePath, ctx.account?.dirs.codex);
  const { agent, env, pathDirs, argv } = launchSpec(ctx, row);
  const pane = openPane(row.worktreePath, env);
  herdr.labelPane(pane, row.displayName);
  herdr.prependPath(pane, pathDirs);
  const result = herdr.startAgent(row.session, agent, pane, argv);
  if (result.ok) console.log(`  ${cyan}[${row.displayName}]${reset} started as ${row.session}`);
  else console.log(`  ${yellow}[${row.displayName}]${reset} ${row.session} is not ready: ${result.error?.message}. Answer it in herdr; the role keeps running.`);
}

function launchRoles(ctx: Ctx): void {
  console.log(`${green}Starting agents...${reset}`);
  const plan = herdr.gridPlan(ctx.roles.length);
  const panes: string[] = [];
  ctx.roles.forEach((row, i) => {
    launchRole(ctx, row, (cwd, env) => {
      const pane = i === 0
        ? herdr.openWorkspace(ctx.workingDir, cwd, env)
        : herdr.splitPane(panes[plan[i - 1][0]], plan[i - 1][1], plan[i - 1][2], cwd, env);
      panes.push(pane);
      return pane;
    });
  });
}

function stopHandoffDaemon(ctx: Ctx): void {
  spawnSync("bun", [join(ctx.scriptDir, "stop_handoff_daemon.ts"), ctx.workingDir]);
}

export function sleepInhibitorPrefix(): string[] | undefined {
  if (process.env.SWARMFORGE_PREVENT_SLEEP === "0") return undefined;
  switch (sh("uname", "-s").out) {
    case "Darwin": return commandExists("caffeinate") ? ["caffeinate", "-dims"] : undefined;
    case "Linux": {
      const state = sh("systemctl", "is-system-running").out;
      return commandExists("systemd-inhibit") && commandExists("systemctl") && ["running", "degraded"].includes(state)
        ? ["systemd-inhibit", "--what=sleep:idle", "--who=SwarmForge", "--why=SwarmForge swarm is active"]
        : undefined;
    }
    default: return undefined;
  }
}

function startHandoffDaemon(ctx: Ctx): void {
  rmStop(ctx);
  const prefix = sleepInhibitorPrefix() ?? [];
  const command = [...prefix, join(ctx.scriptDir, "handoffd.ts"), ctx.workingDir];
  mkdirSync(ctx.daemonDir, { recursive: true });
  const log = openSync(ctx.handoffDaemonLog, "w");
  spawn(command[0], command.slice(1), { detached: true, stdio: ["ignore", log, log] }).unref();
  console.log(`${green}Started handoff daemon${command.length > 2 ? " with OS sleep prevention" : ""}.${reset}`);
}

function rmStop(ctx: Ctx): void {
  spawnSync("rm", ["-f", join(ctx.daemonDir, "stop")]);
}

export const launchPlanLines = (ctx: Ctx) => ctx.roles.map((r) => `start-agent ${r.role}`);

function killExistingSessions(ctx: Ctx): void {
  if (!herdr.workspaceId(ctx.workingDir)) return;
  console.log(`${yellow}Existing SwarmForge workspace found. Closing it...${reset}`);
  herdr.closeWorkspace(ctx.workingDir);
}

function announceReady(ctx: Ctx): void {
  console.log(`\n${green}${bold}SwarmForge is ready.${reset}`);
  console.log(`Working directory: ${ctx.workingDir}`);
  if (ctx.account) console.log(`Account: ${ctx.account.name}`);
  console.log("Sessions:");
  for (const row of ctx.roles) console.log(`  ${row.displayName}: ${row.session}`);
  console.log(`\n${green}Operate the swarm from this directory:${reset}`);
  console.log("  ./swarm status                              roles, tasks, and what waits for you");
  console.log('  ./swarm task new <name> "description"      start work: it goes to the master agent');
  console.log("  ./swarm approve <id>                        release a spec the specifier submitted");
  console.log('  ./swarm reject <id> "comments"             send a spec back');
  console.log(`${green}Talk to the master agent directly in its pane of the herdr workspace '${herdr.projectSlug(ctx.workingDir)}'.${reset}\n`);
}

function bootBanner(): void {
  console.log(`${cyan}${bold}`);
  console.log("  SwarmForge v1.0 Starting");
  console.log("  Disciplined agents build better software");
  console.log(`${reset}`);
}

// -- start / stop -----------------------------------------------------------------------

export const protectedBranches = new Set(["main", "master", "develop"]);

const currentBranch = (dir: string): string | undefined => {
  const r = sh("git", "-C", dir, "symbolic-ref", "--short", "-q", "HEAD");
  return r.ok ? r.out : undefined;
};

/** The master role commits and merges its results directly on the checked-out branch, so a
 *  protected branch is refused. A repo without commits yet has nothing to protect. */
export function checkIntegrationBranch(ctx: Ctx): void {
  const branch = currentBranch(ctx.workingDir);
  if (branch && protectedBranches.has(branch) && sh("git", "-C", ctx.workingDir, "rev-parse", "--verify", "-q", "HEAD").ok && process.env.SWARMFORGE_ALLOW_BRANCH !== "1") {
    fail(`${red}Error:${reset} Refusing to start on '${branch}'. The swarm's master role commits and merges its results directly on the checked-out branch.\n` +
      "Start from an integration branch instead:  git switch -c swarm/<task>\n" +
      `To run on '${branch}' anyway, set SWARMFORGE_ALLOW_BRANCH=1.`);
  }
}

function runMain(root: string): void {
  checkHerdr();
  checkDependency("git");
  checkIntegrationBranch(context(root));
  const base = context(root);
  initializeGitRepo(base);
  ensureRuntimeGitExcludes(base);
  installCommitMsgHook(base);
  const ctx = prepareCtx(base);
  checkBackendDependencies(ctx);
  prepareWorkspace(ctx);
  prepareWorktrees(ctx);
  prepareHandoffDirs(ctx);
  stopHandoffDaemon(ctx);
  killExistingSessions(ctx);
  bootBanner();
  syncWorktreeScripts(ctx);
  startHandoffDaemon(ctx);
  launchRoles(ctx);
  announceReady(ctx);
}

function runStopProject(root: string): void {
  const ctx = context(root);
  // keep each role's transcript before its pane goes away
  spawnSync(join(ctx.scriptDir, "pack_board.sh"), ["archive-all", "--root", ctx.workingDir]);
  stopHandoffDaemon(ctx);
  herdr.closeWorkspace(ctx.workingDir);
}

// -- test entry points (the black-box tests drive these flags) ------------------------------

function testParse(root: string): void {
  const ctx = prepareCtx(context(root));
  prepareWorkspace(ctx);
  for (const row of ctx.roles) {
    console.log(`${row.role} ${row.displayName} ${row.worktreePath} ${row.receiveMode} ${row.propagation}${row.extraArgs ? ` ${row.extraArgs}` : ""} ${row.visible ? "visible" : "invisible"}`);
  }
  if (ctx.account) console.log(`account ${ctx.account.name}`);
  process.stdout.write(readFileSync(ctx.rolesFile, "utf8"));
  process.stdout.write(readFileSync(ctx.sessionsFile, "utf8"));
}

function printLaunchSpec(ctx: Ctx, row: Row): void {
  const { agent, env, pathDirs, argv, prompt } = launchSpec(ctx, row);
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1))) console.log(`${k}=${v}`);
  console.log(`PATH=${pathDirs.join(":")}:$PATH`);
  console.log([`kind=${agent}`, "--", ...argv.map((a) => (a === prompt ? "<prompt>" : a))].join(" "));
}

function testLaunchCommand(root: string, agent: string, extraArgs?: string): void {
  const ctx = resolveAccount(context(root));
  const row: Row = {
    role: "coder", agent, session: "sf-coder", displayName: "Coder", worktreeName: "master",
    worktreePath: resolve(root), receiveMode: "task", propagation: "forward-only", extraArgs, visible: true,
  };
  mkdirSync(ctx.promptsDir, { recursive: true });
  printLaunchSpec(ctx, row);
}

function main(args: string[]): void {
  const cwd = process.cwd();
  const root = (i = 1) => args[i] ?? cwd;
  switch (args[0]) {
    case "--test-parse": return testParse(root());
    case "--test-required-helpers": return requiredHelpers.forEach((h) => console.log(h));
    case "--test-branch-check": {
      checkIntegrationBranch(context(root()));
      return console.log("branch ok");
    }
    case "--test-launch-plan": return launchPlanLines(prepareCtx(context(root()))).forEach((l) => console.log(l));
    case "--test-launch-roles": {
      const ctx = prepareCtx(context(root()));
      prepareWorkspace(ctx);
      return launchRoles(ctx);
    }
    case "--test-launch-command": return testLaunchCommand(root(), args[2], args[3] ? args.slice(3).join(" ") : undefined);
    case "--test-install-hooks": {
      const ctx = context(args[1]);
      installCommitMsgHook(ctx);
      return console.log(join(gitHooksDir(ctx), "commit-msg"));
    }
    case "--test-sleep-inhibitor-prefix": return console.log((sleepInhibitorPrefix() ?? []).join(" "));
    case "--test-ensure-codex-trust": return ensureCodexTrust(args[1], args[2]);
    case "--stop-project": return runStopProject(args[1]);
    default: return runMain(args[0] ?? cwd);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
  process.exit(0);
}
