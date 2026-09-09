/**
 * Checking the files a publish request wants to attach.
 *
 * The API server stores uploads content-addressed under the data directory and
 * sends this process paths, not bytes. Both see one filesystem — the shell
 * chose `NEDB_DATA_DIR` and spawned the server with it — so a path is all that
 * needs to cross the bridge.
 *
 * Two checks stand between a path and a network, and each exists for its own
 * reason:
 *
 *  - **Inside the data directory.** The bridge is loopback and token-gated, but
 *    a path is still an instruction to read a file, and the one component that
 *    can turn a bad request into "upload `~/.ssh/id_rsa` to X" should not be
 *    the one component that trusts its input.
 *  - **Hashes to what was approved.** An approval is for exact content, and
 *    content now includes the picture. A file that no longer matches the hash
 *    recorded at approval time is not the file that was approved, so the post
 *    does not go out. It costs one read of a file that is about to be read
 *    anyway.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type MediaInput = {
  /** Absolute path, produced by the API server's media store. */
  path: string;
  sha256: string;
  filename: string;
  mimeType: string;
  altText?: string;
};

export type MediaResolution =
  | { ok: true; paths: string[] }
  | { ok: false; detail: string };

export function resolveApprovedMedia(input: {
  dataDir: string;
  media: readonly MediaInput[];
}): MediaResolution {
  const root = path.resolve(input.dataDir);
  const paths: string[] = [];

  for (const item of input.media) {
    const file = path.resolve(item.path);

    if (file !== root && !file.startsWith(root + path.sep)) {
      return {
        ok: false,
        detail: `The attachment "${item.filename}" is outside this app's data directory, so it was not uploaded and nothing was posted.`,
      };
    }

    if (!/^[0-9a-f]{64}$/.test(item.sha256)) {
      return {
        ok: false,
        detail: `The attachment "${item.filename}" arrived without a usable checksum, so it could not be matched to the approval. Nothing was posted.`,
      };
    }

    if (!existsSync(file) || !statSync(file).isFile()) {
      return {
        ok: false,
        detail: `The attachment "${item.filename}" is no longer on disk. Nothing was posted.`,
      };
    }

    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== item.sha256) {
      return {
        ok: false,
        detail: `The file behind "${item.filename}" is not the one that was approved. Nothing was posted; re-attach it and approve again.`,
      };
    }

    paths.push(file);
  }

  return { ok: true, paths };
}
