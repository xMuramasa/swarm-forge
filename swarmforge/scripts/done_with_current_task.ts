#!/usr/bin/env bun
// Finish the single task in process: stamp it, move it to completed, archive, announce.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { batchDirs, fail, finishDone, handoffFiles, inboxDir, setHeader, timestamp } from "./handoff_lib.ts";

const list = (files: string[]) => files.map((f) => `- ${f}`).join("\n");

function main(): void {
  const inbox = inboxDir();
  const inProcess = join(inbox, "in_process");
  const completed = join(inbox, "completed");
  for (const dir of [inProcess, completed]) mkdirSync(dir, { recursive: true });

  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (batches.length) fail(2, "CURRENT_WORK_IS_BATCH: use done_with_current.sh.", list(batches));
  if (!files.length) fail(1, "NO_CURRENT_TASK");
  if (files.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple tasks are in process.", list(files));

  const source = files[0];
  const target = join(completed, basename(source));
  if (existsSync(target)) rmSync(target);
  setHeader(source, "completed_at", timestamp());
  renameSync(source, target);
  console.log(`COMPLETED: ${target}`);
  finishDone();
}

if (import.meta.main) main();
