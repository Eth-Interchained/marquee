/**
 * The two decisions in a file drop that are easy to get subtly wrong.
 *
 * Both are pure so they can be tested without a DOM, because neither failure
 * is obvious from looking at the code: one makes the drop silently impossible,
 * the other makes the highlight flicker on every child element the pointer
 * crosses.
 */

/**
 * Whether a drag is carrying files.
 *
 * `dataTransfer.files` is deliberately empty during `dragover` — a page is not
 * allowed to see file contents until the operator commits to the drop — so the
 * decision has to be made from `types`, which is populated the whole time.
 * Reading `files.length` here would mean no drag was ever recognised.
 */
export function draggingFiles(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  return Array.from(types).includes('Files');
}

/**
 * Whether a `dragleave` means the pointer has really left the card.
 *
 * `dragleave` also fires when the pointer crosses from the card onto one of
 * its own children, so clearing the highlight on every event makes it strobe
 * as the pointer moves across the text, the buttons, the thumbnails. It has
 * only really left when whatever it moved onto is not inside the card.
 *
 * `relatedTarget` is null when the pointer left the window entirely, which
 * counts as leaving.
 */
export function leftTheCard(
  card: { contains(node: Node | null): boolean },
  relatedTarget: Node | null,
): boolean {
  if (!relatedTarget) return true;
  return !card.contains(relatedTarget);
}
