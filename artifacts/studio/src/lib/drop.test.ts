import assert from 'node:assert/strict';
import { test } from 'node:test';

import { draggingFiles, leftTheCard } from './drop.ts';

test('a drag carrying files is recognised', () => {
  assert.equal(draggingFiles(['Files']), true);
  assert.equal(draggingFiles(['text/plain', 'Files']), true);
});

test('a drag carrying anything else is not a file drop', () => {
  // Dragging selected text across a card must not offer to attach it.
  assert.equal(draggingFiles(['text/plain']), false);
  assert.equal(draggingFiles(['text/uri-list']), false);
  assert.equal(draggingFiles([]), false);
  assert.equal(draggingFiles(undefined), false);
});

test('the decision is made from types, not from files', () => {
  // The reason this function exists: `dataTransfer.files` is empty during
  // dragover by design, so a check on its length would never fire and the drop
  // target would silently never appear. `types` is populated throughout.
  assert.equal(draggingFiles(['Files']), true, 'types is the only signal available early');
});

const card = (children: Node[]) => ({
  contains: (node: Node | null) => node !== null && children.includes(node),
});

test('crossing onto a child is not leaving', () => {
  // The flicker bug: dragleave fires for every child boundary, so clearing the
  // highlight on each one makes it strobe as the pointer moves over the text,
  // the buttons, the thumbnails.
  const textarea = {} as Node;
  const button = {} as Node;
  const target = card([textarea, button]);

  assert.equal(leftTheCard(target, textarea), false);
  assert.equal(leftTheCard(target, button), false);
});

test('crossing onto something outside is leaving', () => {
  const inside = {} as Node;
  const elsewhere = {} as Node;
  assert.equal(leftTheCard(card([inside]), elsewhere), true);
});

test('leaving the window entirely counts as leaving', () => {
  // `relatedTarget` is null when the pointer goes outside the window; the
  // highlight has to clear or it sticks until the next drag.
  assert.equal(leftTheCard(card([]), null), true);
});
