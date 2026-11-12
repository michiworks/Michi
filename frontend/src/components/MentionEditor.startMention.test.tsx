import { createRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';

async function editorWith(text: string) {
  const ref = createRef<MentionEditorHandle>();
  render(<MentionEditor ref={ref} value="" mentions={[]} onChange={vi.fn()} currentNodeId="current" sameTreeNodes={[]}
    onSubmit={vi.fn()} artifacts={[{ id: 'notes', name: 'Design notes', filePath: 'notes.md', source: 'user', createdAt: 1, updatedAt: 1 }]} />);
  await waitFor(() => expect(ref.current?.editor).toBeTruthy());
  const editor = ref.current!.editor!;
  if (text) await act(async () => { editor.commands.insertContent(text); });
  return { handle: ref.current!, editor };
}

const caretAt = (editor: NonNullable<MentionEditorHandle['editor']>, pos: number) =>
  act(() => { editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))); });

describe('MentionEditorHandle.startMention', () => {
  it.each([
    ['', '@'],
    ['Look at', 'Look at @'],
    ['帮我看看', '帮我看看 @'],
    ['Look ', 'Look @'],
  ])('types @ after %j so the picker opens', async (text, expected) => {
    const { handle, editor } = await editorWith(text);
    await act(async () => { handle.startMention(); });
    expect(editor.getText()).toBe(expected);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  });

  it('spaces a caret in the middle of the text from the word before it', async () => {
    const { handle, editor } = await editorWith('看看这个');
    caretAt(editor, 3);
    await act(async () => { handle.startMention(); });
    expect(editor.getText()).toBe('看看 @这个');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  });

  it('types at the end when asked to, wherever the caret is', async () => {
    const { handle, editor } = await editorWith('Look at');
    caretAt(editor, 1);
    await act(async () => { handle.startMention('end'); });
    expect(editor.getText()).toBe('Look at @');
  });
});
