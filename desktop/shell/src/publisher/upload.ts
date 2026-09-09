/**
 * Putting a file into a network's file input.
 *
 * A page cannot be handed a file by script: `input.files` is read-only to page
 * JavaScript, and clicking the input opens a native OS dialog that nothing in
 * this process can drive. The supported route is CDP's `DOM.setFileInputFiles`,
 * which sets the selection from a path the way a person choosing a file does,
 * and fires the same `change` the page is listening for.
 *
 * The debugger is already attached for UA emulation (`applyEmulation` attaches
 * "1.3" and guards with `isAttached`), so this reuses that session rather than
 * opening a second one — attaching twice throws, and the two features run on
 * the same `webContents` within one publish.
 *
 * Every path handed here has already been re-hashed against the approval by
 * `resolveApprovedMedia`. Nothing in this file decides what is allowed to be
 * uploaded; it only performs the upload.
 */

import type { WebContents } from "electron";
import { createLogger, errorFields } from "../logger";

const log = createLogger("publisher.upload");

export type UploadResult =
  | { ok: true }
  | { ok: false; detail: string };

type NodeIdResult = { root: { nodeId: number } };

/**
 * Ensures a CDP session exists without stealing one that already does.
 *
 * `applyEmulation` owns attach/detach for the lifetime of the publish window.
 * If it failed to attach — it logs and continues rather than aborting the post
 * — this attaches so an upload is still possible, and says so, because a
 * silently missing debugger would look like a missing file input.
 */
function ensureAttached(contents: WebContents): boolean {
  if (contents.debugger.isAttached()) return true;
  try {
    contents.debugger.attach("1.3");
    return true;
  } catch (error) {
    log.error("Could not attach the debugger to upload a file", errorFields(error));
    return false;
  }
}

/**
 * Selects `paths` in the first file input matching `selector`.
 *
 * Networks hide the real `<input type="file">` behind a styled button and
 * often mark it `display:none`, so the input is looked up structurally rather
 * than by visibility — an invisible input is the normal case here, not a
 * broken one.
 */
export async function setFileInput(
  contents: WebContents,
  selector: string,
  paths: string[],
): Promise<UploadResult> {
  if (paths.length === 0) return { ok: true };
  if (!ensureAttached(contents)) {
    return {
      ok: false,
      detail:
        "The shell could not open a debugger session on the composer, which is the only way to attach a file.",
    };
  }

  try {
    const document = (await contents.debugger.sendCommand(
      "DOM.getDocument",
      {},
    )) as NodeIdResult;

    const { nodeId } = (await contents.debugger.sendCommand("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    })) as { nodeId: number };

    // CDP answers a miss with nodeId 0 rather than an error.
    if (!nodeId) {
      return {
        ok: false,
        detail: `No file input matched \`${selector}\`. The composer's upload control has moved; nothing was posted.`,
      };
    }

    await contents.debugger.sendCommand("DOM.setFileInputFiles", {
      nodeId,
      files: paths,
    });

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: `Attaching the file failed: ${
        error instanceof Error ? error.message : String(error)
      }. Nothing was posted.`,
    };
  }
}
