#!/usr/bin/env bun
// Take the next batch: every queued handoff of the top priority, moved together.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import {
  batchDirs, currentHead, fail, handoffFiles, headerField, idTimestamp, inboxDir, mergeGitHandoff,
  printBatch, setHeader, timestamp,
} from "./handoff_lib.ts";
import { activeOutboundGitFiles, currentRole, waitMessage } from "./ready_for_next_guard.ts";

const list = (files: string[]) => files.map((f) => `- ${f}`).join("\n");
const priorityOf = (file: string) => headerField(file, "priority") ?? "50";

function newBatchDir(inProcess: string): string {
  for (let suffix = 1; ; suffix++) {
    const dir = join(inProcess, `batch_${idTimestamp()}_${String(suffix).padStart(6, "0")}`);
    if (!existsSync(dir)) return dir;
  }
}

function main(): void {
  const inbox = inboxDir();
  const newDir = join(inbox, "new");
  const inProcess = join(inbox, "in_process");
  for (const dir of [newDir, inProcess, join(inbox, "completed")]) mkdirSync(dir, { recursive: true });

  const batches = batchDirs(inProcess);
  const files = handoffFiles(inProcess);
  if (files.length) fail(2, "TASK_IN_PROCESS_IS_SINGLE: use ready_for_next.sh or done_with_current.sh.", list(files));
  if (batches.length > 1) fail(2, "AMBIGUOUS_TASK_STATE: multiple batches are already in process.", list(batches));

  if (batches.length === 1) {
    for (const file of handoffFiles(batches[0])) mergeGitHandoff(file);
    printBatch(batches[0]);
    return;
  }

  const active = activeOutboundGitFiles(currentRole());
  if (active.length) fail(2, ...waitMessage(active));
  const queued = handoffFiles(newDir);
  if (!queued.length) {
    console.log("NO_TASK");
    return;
  }
  const priority = priorityOf(queued[0]);
  const batchDir = newBatchDir(inProcess);
  const selected = queued.filter((f) => priorityOf(f) === priority);
  mkdirSync(batchDir);
  for (const source of selected) {
    const target = join(batchDir, basename(source));
    if (existsSync(target)) fail(2, `AMBIGUOUS_TASK_STATE: target batch file already exists: ${target}`);
    renameSync(source, target);
    setHeader(target, "dequeued_at", timestamp());
    setHeader(target, "task_base_commit", currentHead());
  }
  if (!selected.length) fail(2, `AMBIGUOUS_TASK_STATE: no tasks selected for batch priority ${priority}.`);
  for (const file of handoffFiles(batchDir)) mergeGitHandoff(file);
  printBatch(batchDir);
}

if (import.meta.main) main();
