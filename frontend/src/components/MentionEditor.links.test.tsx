import { createRef } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';

const openPreferredUrl = vi.hoisted(() => vi.fn());
vi.mock('../services/openUrl', () => ({ openPreferredUrl }));

async function renderEditor() {
  const ref = createRef<MentionEditorHandle>();
  const view = render(<MentionEditor ref={ref} value="" mentions={[]} onChange={() => {}} currentNodeId="current"
    sameTreeNodes={[]} artifacts={[]} onSubmit={() => {}} />);
  await waitFor(() => expect(ref.current?.editor).toBeTruthy());
  return { view, editor: ref.current!.editor! };
}

async function setup() {
  const { view, editor } = await renderEditor();
  act(() => { editor.commands.setContent('<p>see <a href="https://example.com/x">https://example.com/x</a></p>'); });
  const link = view.container.querySelector<HTMLAnchorElement>('.ProseMirror a[href]')!;
  const host = view.container.querySelector<HTMLElement>('.mention-editor-host')!;
  return { link, host, editor, view };
}

// Typed input reaches the doc as insertText at the caret, which takes the
// marks the caret inherits — the path the link's inclusiveness decides.
function typeAtEnd(editor: Editor, text: string) {
  act(() => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.dispatch(editor.state.tr.insertText(text));
  });
}

const linkTexts = (container: HTMLElement) =>
  [...container.querySelectorAll('.ProseMirror a[href]')].map((a) => a.textContent);

describe('MentionEditor links', () => {
  beforeEach(() => openPreferredUrl.mockClear());

  it('does not open a link on a plain click or let it navigate', async () => {
    const { link } = await setup();
    expect(fireEvent.click(link)).toBe(false);
    expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(openPreferredUrl).not.toHaveBeenCalled();
  });

  it('opens a link on Cmd+click or Ctrl+click', async () => {
    const { link } = await setup();
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(openPreferredUrl.mock.calls).toEqual([['https://example.com/x'], ['https://example.com/x']]);
  });

  it('flags the host only while Cmd/Ctrl is held', async () => {
    const { host } = await setup();
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
    expect(host.hasAttribute('data-link-modifier')).toBe(true);
    fireEvent.keyUp(window, { key: 'Meta' });
    expect(host.hasAttribute('data-link-modifier')).toBe(false);
    fireEvent.mouseMove(host, { ctrlKey: true });
    expect(host.hasAttribute('data-link-modifier')).toBe(true);
    fireEvent.blur(window);
    expect(host.hasAttribute('data-link-modifier')).toBe(false);
  });

  it('does not extend a link to text typed right after it', async () => {
    const { editor, view } = await setup();
    typeAtEnd(editor, ' 收拾收拾');
    expect(linkTexts(view.container)).toEqual(['https://example.com/x']);
  });

  it('links a pasted URL but not the text typed after it', async () => {
    const { view, editor } = await renderEditor();
    act(() => { editor.view.pasteText('https://reviews.example.com/reviews/CR-1', new Event('paste') as ClipboardEvent); });
    expect(linkTexts(view.container)).toEqual(['https://reviews.example.com/reviews/CR-1']);
    typeAtEnd(editor, ' 收拾收拾');
    expect(linkTexts(view.container)).toEqual(['https://reviews.example.com/reviews/CR-1']);
  });
});
