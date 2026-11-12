import type { Editor } from '@tiptap/react';

/**
 * The space an `@` typed at the caret needs before it. The @ picker opens
 * only after a plain space or where a line starts, and a sent `@name` must
 * stand apart from the word before it; Chinese has no spaces to rely on.
 */
export function spaceBeforeMention(editor: Editor): '' | ' ' {
  const before = editor.state.selection.$from.nodeBefore;
  if (!before || before.type.name === 'hardBreak') return '';
  return before.isText && before.text?.endsWith(' ') ? '' : ' ';
}
