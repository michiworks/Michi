import { Editor } from '@tiptap/react';
import Mention from '@tiptap/extension-mention';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerStarterKit } from './MentionEditor';
import { MENTION_ENTER_MS, MentionEnter, markMentionEnter } from './mentionEnter';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  vi.useRealTimers();
});

function mount(): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: [composerStarterKit, Mention.configure({ HTMLAttributes: { class: 'mention-chip' } }), MentionEnter],
    content: '<p>Compare this with </p>',
  });
  return editor;
}

describe('mentionEnter', () => {
  it('marks a picked chip as growing out of the typed query, then clears the mark', () => {
    vi.useFakeTimers();
    const ed = mount();
    const at = ed.state.doc.content.size - 1;
    ed.commands.insertContentAt(at, [{ type: 'mention', attrs: { id: 'n1', label: 'Notarize the DMG' } }, { type: 'text', text: ' ' }]);
    markMentionEnter(ed, at, '@not', 31.6);

    const chip = ed.view.dom.querySelector('.mention-chip') as HTMLElement;
    expect(chip.classList.contains('mention-chip--enter')).toBe(true);
    expect(chip.getAttribute('data-from')).toBe('@not');
    expect(chip.style.getPropertyValue('--mention-from-w')).toBe('32px');
    // Decorations never reach the document the composer serializes.
    expect(JSON.stringify(ed.getJSON())).not.toContain('mention-chip--enter');

    vi.advanceTimersByTime(MENTION_ENTER_MS);
    const settled = ed.view.dom.querySelector('.mention-chip') as HTMLElement;
    expect(settled.classList.contains('mention-chip--enter')).toBe(false);
    expect(settled.hasAttribute('data-from')).toBe(false);
  });

  it('follows the chip through typing that lands before it', () => {
    const ed = mount();
    const at = ed.state.doc.content.size - 1;
    ed.commands.insertContentAt(at, [{ type: 'mention', attrs: { id: 'n1', label: 'Notarize the DMG' } }]);
    markMentionEnter(ed, at, '@not', 30);
    ed.commands.insertContentAt(1, 'Please ');
    expect(ed.view.dom.querySelector('.mention-chip')?.classList.contains('mention-chip--enter')).toBe(true);
  });

  it('ignores a position that holds no mention', () => {
    const ed = mount();
    markMentionEnter(ed, 1, '@x', 10);
    expect(ed.view.dom.querySelector('.mention-chip--enter')).toBeNull();
  });
});
