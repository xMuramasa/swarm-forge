#!/usr/bin/env bun
// Stop the handoff daemon of a project: ask it to stop, then TERM and KILL if it lingers.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const defaultTimeoutMs = 5000;
const pollMs = 100;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stop(projectRoot: string, timeoutMs = defaultTimeoutMs): void {
  const daemonDir = join(projectRoot, ".swarmforge", "daemon");
  const pidFile = join(daemonDir, "handoffd.pid");
  const stopFile = join(daemonDir, "stop");
  mkdirSync(daemonDir, { recursive: true });
  if (!existsSync(stopFile)) writeFileSync(stopFile, "");
  if (existsSync(pidFile)) {
    const text = readFileSync(pidFile, "utf8").trim();
    if (/^[0-9]+$/.test(text) && alive(Number(text))) {
      const pid = Number(text);
      process.kill(pid, "SIGTERM");
      for (let waited = 0; waited < timeoutMs && alive(pid); waited += pollMs) sleep(pollMs);
      if (alive(pid)) {
        process.kill(pid, "SIGKILL");
        sleep(pollMs);
      }
    }
    rmSync(pidFile, { force: true });
  }
  rmSync(stopFile, { force: true });
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write("Usage: stop_handoff_daemon.ts <project-root>\n");
    process.exit(1);
  }
  stop(root);
  process.exit(0);
}
