#!/usr/bin/env bun
// git commit-msg hook: sign the message with the role that made the commit.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { samePath } from "./handoff_lib.ts";

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

function rolesFile(): string | undefined {
  const top = git("rev-parse", "--show-toplevel");
  if (!top) return undefined;
  const direct = join(top, ".swarmforge", "roles.tsv");
  if (existsSync(direct)) return direct;
  const common = git("rev-parse", "--git-common-dir");
  if (!common) return undefined;
  const candidate = join(dirname(isAbsolute(common) ? common : resolve(common)), ".swarmforge", "roles.tsv");
  return existsSync(candidate) ? candidate : undefined;
}

function inferRole(): string | undefined {
  const file = rolesFile();
  if (!file) return undefined;
  const here = git("rev-parse", "--show-toplevel") ?? process.cwd();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [role, , worktree] = line.split("\t");
    if (role && worktree && samePath(worktree, here)) return role;
  }
  return undefined;
}

export const byline = (role: string) => `By ${role}.`;
export const appendByline = (text: string, role: string) => `${text.trimEnd()}\n\n${byline(role)}\n`;

function main(args: string[]): void {
  if (args.length !== 1) return;
  const role = process.env.SWARMFORGE_ROLE || inferRole();
  if (!role) return;
  const text = readFileSync(args[0], "utf8");
  if (!text.includes(byline(role))) writeFileSync(args[0], appendByline(text, role));
}

if (import.meta.main) {
  main(process.argv.slice(2));
  process.exit(0);
}
