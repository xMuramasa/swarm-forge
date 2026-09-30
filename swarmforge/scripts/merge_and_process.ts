#!/usr/bin/env bun
// Merge a sender's commit into this worktree unless it is already an ancestor.

import { spawnSync } from "node:child_process";

const usage = "Usage: merge_and_process.sh <sender> <commit>";
const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

function main(args: string[]): number {
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(`${usage}\n`);
    return 0;
  }
  if (args.length !== 2) {
    process.stderr.write(`${usage}\n`);
    return 1;
  }
  const [sender, sha] = args;
  if (git("merge-base", "--is-ancestor", sha, "HEAD").status !== 0) {
    const r = git("merge", "--no-edit", "-m", `Merge ${sender} ${sha}`, sha);
    if (r.status !== 0) {
      process.stderr.write(`${`${r.stderr}\n${r.stdout}`.trim()}\n`);
      return 1;
    }
  }
  console.log(`MERGED: ${sender} ${sha}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
