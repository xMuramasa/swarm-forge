// Thin wrapper over the herdr CLI. One herdr workspace per project holding every role as a
// pane in one tab, and one herdr agent per role named sf-<project>-<role>.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const maxNameLength = 32;
const readLines = 2000;

export type Cli = {
  ok: boolean;
  out: string;
  // deno-lint-ignore no-explicit-any
  result: any;
  error?: { code?: string; message?: string };
};

/** Run herdr. `result` and `error` come from its JSON body. */
export function cli(...args: (string | number)[]): Cli {
  const r = spawnSync("herdr", args.map(String), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout ?? "";
  let body: { result?: unknown; error?: Cli["error"] } | undefined;
  try {
    body = JSON.parse(out.trim() ? out : (r.stderr ?? ""));
  } catch {
    body = undefined;
  }
  return { ok: r.status === 0, out, result: body?.result, error: body?.error };
}

export function cliOrThrow(...args: (string | number)[]): Cli["result"] {
  const r = cli(...args);
  if (r.ok) return r.result;
  throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${r.error?.message ?? r.out.trim()}`);
}

export const clean = (s: string) =>
  String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export const projectSlug = (root: string) => clean(basename(resolve(root)));

/** sf-<project>-<role>, lowercased, at most 32 characters (herdr's limit).
 *  Two projects with the same directory name collide; add a hash if that bites. */
export function agentName(root: string, role: string): string {
  const r = clean(role);
  const room = maxNameLength - "sf--".length - r.length;
  if (room <= 0) throw new Error(`role name too long for a herdr agent name: ${r}`);
  const slug = projectSlug(root);
  return `sf-${slug.slice(0, Math.min(room, slug.length))}-${r}`;
}

// -- workspace -------------------------------------------------------------

export const workspaceFile = (root: string) => join(root, ".swarmforge", "herdr-workspace");

export function workspaceId(root: string): string | undefined {
  const file = workspaceFile(root);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").trim() || undefined;
}

const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

export type Split = [from: number, direction: "right" | "down", ratio: number];

/** How to split panes into a grid for `n` roles: two rows, ceil(n/2) columns, the top row
 *  filled first. One split per pane after the first; `from` is the pane to split and `ratio`
 *  the share the split pane keeps, so columns come out equal. */
export function gridPlan(n: number): Split[] {
  const cols = n <= 2 ? n : Math.ceil(n / 2);
  const plan: Split[] = [];
  for (let i = 1; i < n; i++) {
    plan.push(i < cols ? [i - 1, "right", 1 / (cols + 1 - i)] : [i - cols, "down", 0.5]);
  }
  return plan;
}

export const labelPane = (pane: string, label: string) => cli("pane", "rename", pane, label);

/** Create the project workspace with its shell started with `env`. Env goes in at spawn:
 *  typing exports into a fresh pane races the shell's startup. Returns the first pane id. */
export function openWorkspace(root: string, cwd: string, env: Record<string, string>): string {
  const result = cliOrThrow("workspace", "create", "--cwd", cwd, "--label", projectSlug(root), "--no-focus", ...envArgs(env));
  mkdirSync(dirname(workspaceFile(root)), { recursive: true });
  writeFileSync(workspaceFile(root), `${result.workspace.workspace_id}\n`);
  cli("tab", "rename", result.tab.tab_id, "swarm");
  return result.root_pane.pane_id;
}

/** Split `from` into a new pane started with `env`. Returns the new pane id. */
export function splitPane(from: string, direction: string, ratio: number, cwd: string, env: Record<string, string>): string {
  const result = cliOrThrow("pane", "split", from, "--direction", direction, "--ratio", ratio, "--cwd", cwd, "--no-focus", ...envArgs(env));
  return result.pane.pane_id;
}

export const sq = (value: string) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

/** Put `dirs` first on the pane shell's PATH. Shell startup files reorder PATH, so this runs in
 *  the live shell; a command typed before the shell is up is dropped, hence the retries. The
 *  marker is computed by the shell, so the typed command line itself never matches it. */
export function prependPath(pane: string, dirs: string[]): void {
  const command = `export PATH=${dirs.map(sq).join(":")}:$PATH; echo SF_PATH_$((1+1))`;
  for (let attempt = 0; attempt < 6; attempt++) {
    cli("pane", "run", pane, command);
    if (cli("pane", "wait-output", pane, "--match", "SF_PATH_2", "--timeout", 2500).ok) return;
  }
  throw new Error(`the shell in pane ${pane} never became ready`);
}

/** herdr rejects control characters (newline, tab) in agent arguments, and delivers multi-line
 *  prompts as a paste that Claude does not answer, so multi-line text is joined with spaces. */
export const oneLine = (arg: string) => String(arg).replace(/\s*[\r\n\t]+\s*/g, " ");

/** Start `kind` in `pane` and wait until it is ready for prompts. `error.code` is
 *  agent_not_ready when it is parked on a dialog. */
export function startAgent(name: string, kind: string, pane: string, args: string[]): Cli {
  return cli("agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", 60000, "--", ...args.map(oneLine));
}

export function closeWorkspace(root: string): void {
  const ws = workspaceId(root);
  if (!ws) return;
  cli("workspace", "close", ws);
  rmSync(workspaceFile(root), { force: true });
}

// -- agents ----------------------------------------------------------------

export function agentInfo(name: string): { agent_status?: string } | undefined {
  const r = cli("agent", "get", name);
  return r.ok ? r.result?.agent : undefined;
}

export const alive = (name: string) => agentInfo(name) !== undefined;

/** idle | working | blocked | done | unknown, or undefined when the agent is gone. */
export const status = (name: string) => agentInfo(name)?.agent_status;

/** Submit `text` to the agent as if typed. Throws when herdr refuses (agent gone or blocked). */
export function prompt(name: string, text: string): void {
  cliOrThrow("agent", "prompt", name, oneLine(text));
}

/** Recent terminal text of the agent, or undefined. */
export function readText(name: string): string | undefined {
  const r = cli("agent", "read", name, "--source", "recent-unwrapped", "--lines", readLines);
  return r.ok ? r.out : undefined;
}
