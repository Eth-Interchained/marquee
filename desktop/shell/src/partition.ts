/**
 * Partition keys: the name of a workspace's cookie jar and profile directory.
 *
 * Kept apart from `workspace-contexts.ts` (which imports Electron) so the rule
 * can be tested under plain Node — a collision here is a cross-workspace
 * session leak, which is the one failure this product cannot have.
 */

import { createHash } from "node:crypto";

/**
 * Partition keys become directory names, so unsafe characters have to go — but
 * folding them away is how two workspaces end up sharing one cookie jar
 * ("team/a" and "team-a" both flatten to "team-a"). The readable part is kept
 * for anyone looking at the profile directory, and a digest of the *original*
 * id is appended so distinct ids can never land on the same partition.
 */
export function partitionFor(workspaceId: string): string {
  // Dots are dropped along with everything else unsafe: "../x" must not turn
  // into a name containing "..", whatever a future caller does with it.
  const readable = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const digest = createHash("sha256").update(workspaceId, "utf8").digest("hex").slice(0, 16);
  return `persist:mq-${readable}-${digest}`;
}

/** Directory name under `<userData>/Partitions` for a partition key. */
export function profileDirectoryName(partition: string): string {
  return partition.replace(/^persist:/, "");
}
