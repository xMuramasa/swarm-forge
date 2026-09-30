#!/usr/bin/env bun
// Receive the next handoff: dispatch on the role's receive mode.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { ExitError, role, roleReceiveMode } from "./handoff_lib.ts";

function main(): number {
  try {
    const name = role();
    const mode = roleReceiveMode(name);
    if (mode !== "batch" && mode !== "task") {
      process.stderr.write(`INVALID_RECEIVE_MODE: ${mode} for role ${name}\n`);
      return 2;
    }
    const script = join(dirname(import.meta.path), `ready_for_next_${mode}.sh`);
    return spawnSync(script, [], { stdio: "inherit" }).status ?? 1;
  } catch (e) {
    if (e instanceof ExitError) {
      process.stderr.write(`${e.message}\n`);
      return e.exit;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main());
