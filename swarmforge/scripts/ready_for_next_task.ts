#!/usr/bin/env bun
// Take the next single task: move it to in_process, stamp it, merge its commit, print it.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import {
  batchDirs, currentHead, fail, handoffFiles, inboxDir, mergeGitHandoff, printTask,
  setHeader, timestamp,
} from "./handoff_lib.ts";
import { activeOutboundGitFiles, currentRole, waitMessage } from "./ready_for_next_guard.ts";

const list = (files: string[]) => files.map((f) => `- ${f}`).join("\n");

function main(): void {
  const inbox = inboxDir();
  const newDir = join(inbox, "new");
  const inProcess = join(inbox, "in_process");
  for (const dir of [newDir, inProcess, join(inbox, "completed")]) mkdirSync(dir, { recursive: true });

  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (batches.length) fail(2, "TASK_IN_PROCESS_IS_BATCH: use ready_for_next.sh or done_with_current.sh.", list(batches));
  if (files.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple tasks are already in process.", list(files));

  if (files.length === 1) {
    mergeGitHandoff(files[0]);
    printTask(files[0]);
    return;
  }

  const active = activeOutboundGitFiles(currentRole());
  if (active.length) fail(2, ...waitMessage(active));
  const [source] = handoffFiles(newDir);
  if (!source) {
    console.log("NO_TASK");
    return;
  }
  const target = join(inProcess, basename(source));
  if (existsSync(target)) fail(2, `AMBIGUOUS_TASK_STATE: target in-process file already exists: ${target}`);
  renameSync(source, target);
  setHeader(target, "dequeued_at", timestamp());
  setHeader(target, "task_base_commit", currentHead());
  mergeGitHandoff(target);
  printTask(target);
}

if (import.meta.main) main();
