#!/usr/bin/env bun
// Finish the batch in process: stamp every item, move the batch to completed, archive, announce.

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
  if (files.length) fail(2, "CURRENT_WORK_IS_SINGLE_TASK: use done_with_current.sh.", list(files));
  if (!batches.length) fail(1, "NO_CURRENT_BATCH");
  if (batches.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple batches are in process.", list(batches));

  const sourceDir = batches[0];
  const batchFiles = handoffFiles(sourceDir);
  const targetDir = join(completed, basename(sourceDir));
  const completedAt = timestamp();
  if (!batchFiles.length) fail(2, `AMBIGUOUS_TASK_STATE: batch contains no tasks: ${sourceDir}`);
  if (existsSync(targetDir)) fail(2, `AMBIGUOUS_TASK_STATE: completed batch already exists: ${targetDir}`);
  mkdirSync(targetDir);
  for (const source of batchFiles) {
    setHeader(source, "completed_at", completedAt);
    const target = join(targetDir, basename(source));
    if (existsSync(target)) fail(2, `AMBIGUOUS_TASK_STATE: completed batch file already exists: ${target}`);
    renameSync(source, target);
    console.log(`COMPLETED: ${target}`);
  }
  rmSync(sourceDir, { recursive: true });
  console.log(`COMPLETED_BATCH: ${targetDir}`);
  finishDone();
}

if (import.meta.main) main();
