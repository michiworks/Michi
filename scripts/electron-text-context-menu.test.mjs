import assert from 'node:assert/strict';
import test from 'node:test';
import { textContextMenuTemplate } from '../electron/dist/textContextMenu.js';

const editFlags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const lookUp = () => {};
const items = (template) => template?.map((item) => item.role ?? item.label ?? item.type);

test('selected text gets Look Up on macOS, then Copy and Select All', () => {
  const params = { selectionText: 'memory', isEditable: false, editFlags };
  assert.deepEqual(items(textContextMenuTemplate(params, lookUp, 'darwin')), ['Look Up', 'separator', 'copy', 'separator', 'selectAll']);
  assert.deepEqual(items(textContextMenuTemplate(params, lookUp, 'linux')), ['copy', 'separator', 'selectAll']);
});

test('a text field gets Cut, Copy and Paste even with nothing selected', () => {
  const params = { selectionText: '', isEditable: true, editFlags: { ...editFlags, canCut: false, canCopy: false } };
  const template = textContextMenuTemplate(params, lookUp, 'darwin');
  assert.deepEqual(items(template), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
  assert.deepEqual(template.slice(0, 3).map((item) => item.enabled), [false, false, true]);
});

test('other right-clicks get no menu', () => {
  assert.equal(textContextMenuTemplate({ selectionText: '  ', isEditable: false, editFlags }, lookUp, 'darwin'), null);
});
