// A role must not take new work while its own git handoff is still held or queued.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  headerField, inferRoleFromWorktree, projectRootOrUndefined, roleRows,
} from "./handoff_lib.ts";

export function currentRole(): string | undefined {
  if (process.env.SWARMFORGE_ROLE) return process.env.SWARMFORGE_ROLE;
  try {
    return inferRoleFromWorktree();
  } catch {
    return undefined;
  }
}

function handoffFilesRecursive(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return handoffFilesRecursive(path);
    return entry.isFile() && entry.name.endsWith(".handoff") ? [path] : [];
  });
}

function activeOutboxDirs(): string[] {
  const root = projectRootOrUndefined();
  const rows = root ? roleRows() : [];
  return [
    ...(root ? [join(root, ".swarmforge", "handoffs", "outbox")] : []),
    ...rows.map((cols) => cols[2]).filter(Boolean).map((wt) => join(wt, ".swarmforge", "handoffs", "outbox")),
  ];
}

/** git handoffs from `role` that are waiting for approval or delivery. */
export function activeOutboundGitFiles(role: string | undefined): string[] {
  if (!role) return [];
  const root = projectRootOrUndefined();
  const pending = root ? handoffFilesRecursive(join(root, ".swarmforge", "handoffs", "pending_approval")) : [];
  const outbox = activeOutboxDirs().flatMap(handoffFilesRecursive);
  return [...new Set([...pending, ...outbox])].filter(
    (file) => headerField(file, "type") === "git_handoff" && headerField(file, "from") === role,
  );
}

export const waitMessage = (active: string[]): string[] => [
  "WAITING_FOR_APPROVAL: current git handoff is still active",
  active.map((f) => `- ${f}`).join("\n"),
];

