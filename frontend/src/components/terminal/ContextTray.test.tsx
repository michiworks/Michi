import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingComment } from '../../state/chatTypes';
import { ContextTray, type ContextTrayProps } from './ContextTray';

const comment = (id: string, quotedText: string, body: string, createdAt = 1): PendingComment => ({ id, quotedText, body, createdAt });

function mount(overrides: Partial<ContextTrayProps> = {}) {
  const props: ContextTrayProps = {
    comments: [comment('c1', 'the first passage', 'tighten this'), comment('c2', 'the second passage', 'and this')],
    quotedText: null,
    quoteMeta: null,
    quoteMaxLines: 2,
    afterMount: { current: false },
    onEditComment: vi.fn(),
    onRemoveComment: vi.fn(),
    onDismissQuote: vi.fn(),
    ...overrides,
  };
  // The pane and its composer: where the keyboard goes once nothing is left.
  const ui = (next: ContextTrayProps) => (
    <div className="terminal-pane">
      <div className="terminal-composer">
        <ContextTray {...next} />
        <div role="textbox" aria-label="Message" contentEditable suppressContentEditableWarning tabIndex={0} />
      </div>
    </div>
  );
  const view = render(ui(props));
  return { props, rerender: (next: Partial<ContextTrayProps>) => view.rerender(ui({ ...props, ...next })) };
}

const tray = () => screen.getByRole('group', { name: 'Sent with your message' });
const row = () => tray().querySelector('.t-ctx-tray-row') as HTMLElement;
const card = () => screen.getByRole('dialog', { name: 'Sent with your message' });

/** jsdom lays nothing out: give the row a scroll width past its own. */
function overflowRow(el: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

afterEach(() => {
  // Unmount first: the card is portaled to <body>.
  cleanup();
  document.body.innerHTML = '';
});

describe('ContextTray row', () => {
  it('shows one chip per comment, then the quote, each with its start: no +N folding', () => {
    const many = Array.from({ length: 6 }, (_, i) => comment(`c${i + 1}`, `passage ${i + 1}`, `note ${i + 1}`));
    mount({ comments: many, quotedText: 'a warm cache\ncuts the build', quoteMeta: 'notes.md' });
    const chips = [...tray().querySelectorAll('.t-ctx-chip')];
    expect(chips).toHaveLength(7);
    expect(screen.queryByText(/^\+\d/)).toBeNull();
    // A comment: its bubble mark (no number), its passage, the person's note.
    expect(chips[0].querySelector('.t-ctx-chip-mark')!.textContent).toBe('');
    expect(chips[0].querySelector('.t-ctx-chip-mark svg')).toBeTruthy();
    expect(chips[0].classList.contains('is-comment')).toBe(true);
    expect(chips[6].querySelector('.t-ctx-chip-mark svg')).toBeTruthy();
    expect(chips[0].querySelector('.t-ctx-chip-excerpt')!.textContent).toBe('passage 1');
    expect(chips[0].querySelector('.t-ctx-chip-text')!.textContent).toBe('note 1');
    // The quote: what it is, where it came from, the passage on one flow.
    expect(chips[6].classList.contains('is-quote')).toBe(true);
    expect(chips[6].querySelector('.t-ctx-chip-label')!.textContent).toBe('Replying to · notes.md');
    expect(chips[6].querySelector('.t-ctx-chip-text')!.textContent).toBe('a warm cache cuts the build');
    expect(screen.getByRole('button', { name: 'Comment: note 1' }).getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.getByRole('button', { name: 'Quote: a warm cache cuts the build' })).toBeTruthy();
  });

  it('shows nothing when nothing waits on the send', () => {
    const { container } = render(<ContextTray comments={[]} quotedText={null} quoteMeta={null} quoteMaxLines={2}
      afterMount={{ current: true }} onEditComment={vi.fn()} onRemoveComment={vi.fn()} onDismissQuote={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('fades in only chips that are new; a quote is new when it appears after mount', () => {
    const now = Date.now();
    const afterMount = { current: false };
    const { rerender } = mount({ comments: [comment('c1', 'old', 'old note', 1)], afterMount });
    const fresh = () => [...tray().querySelectorAll('.t-ctx-chip[data-fresh]')].map((el) => el.getAttribute('data-ctx-key'));
    expect(fresh()).toEqual([]);
    afterMount.current = true;
    rerender({ comments: [comment('c1', 'old', 'old note', 1), comment('c2', 'new', 'new note', now)], quotedText: 'picked later', afterMount });
    expect(fresh()).toEqual(['c2', 'quote']);
  });

  it('marks the ends that have chips scrolled past them', () => {
    mount();
    const el = row();
    overflowRow(el, { scrollWidth: 900, clientWidth: 600 });
    fireEvent.scroll(el);
    expect(tray().getAttribute('data-overflow')).toBe('end');
    el.scrollLeft = 150;
    fireEvent.scroll(el);
    expect(tray().getAttribute('data-overflow')).toBe('start end');
    el.scrollLeft = 300;
    fireEvent.scroll(el);
    expect(tray().getAttribute('data-overflow')).toBe('start');
  });

  it('turns a mouse wheel into sideways scrolling while chips are out of view', () => {
    mount();
    const el = row();
    overflowRow(el, { scrollWidth: 900, clientWidth: 600 });
    const wheel = (deltaY: number, deltaX = 0) => {
      const event = new WheelEvent('wheel', { deltaY, deltaX, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel(120)).toBe(true);
    expect(el.scrollLeft).toBe(120);
    // A sideways swipe is the browser's own.
    expect(wheel(0, 40)).toBe(false);
    el.scrollLeft = 300;
    // At the end the wheel goes back to whatever it scrolled.
    expect(wheel(120)).toBe(false);
  });

  it('removes a chip with its revealed ×, handing the keyboard to the chip that took its place', () => {
    const { props, rerender } = mount();
    const remove = screen.getByRole('button', { name: 'Remove comment: tighten this' });
    expect(remove.classList.contains('t-reveal')).toBe(true);
    expect(remove.closest('.t-ctx-chip')!.classList.contains('t-reveal-host')).toBe(true);
    fireEvent.click(remove);
    expect(props.onRemoveComment).toHaveBeenCalledWith('c1');
    rerender({ comments: [props.comments[1]] });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comment: and this' }));
  });

  it('removing the last chip hands the keyboard to the composer', () => {
    const { props } = mount({ comments: [], quotedText: 'the passage' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss quote' }));
    expect(props.onDismissQuote).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });
});

describe('ContextTray card', () => {
  it('a chip opens the full list on its item, with the note ready to edit', () => {
    mount({ quotedText: 'a warm cache' });
    const chip = screen.getByRole('button', { name: 'Comment: and this' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const dialog = card();
    expect(chip.getAttribute('aria-controls')).toBe(dialog.querySelector('.t-ctx-card-body')!.id);
    expect(within(dialog).getByText('2 comments and a quote · sent with your message')).toBeTruthy();
    expect(dialog.querySelectorAll('.t-ctx.is-comment')).toHaveLength(2);
    expect(dialog.querySelector('.t-ctx.is-quote')).toBeTruthy();
    expect([...dialog.querySelectorAll('[data-target]')].map((el) => el.getAttribute('data-ctx-key'))).toEqual(['c2']);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Edit comment: and this' }));
  });

  it('another chip moves the card to its item; the open chip closes it', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Comment: tighten this' }));
    fireEvent.click(screen.getByRole('button', { name: 'Comment: and this' }));
    expect([...card().querySelectorAll('[data-target]')].map((el) => el.getAttribute('data-ctx-key'))).toEqual(['c2']);
    const chip = screen.getByRole('button', { name: 'Comment: and this' });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(chip);
  });

  it('edits a note in the card and hands the keyboard back to it (ST-10)', () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Comment: tighten this' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Edit comment: tighten this' }));
    const field = within(card()).getByRole('textbox', { name: 'Edit comment' });
    fireEvent.change(field, { target: { value: 'tighten this a lot' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(props.onEditComment).toHaveBeenCalledWith('c1', 'tighten this a lot');
    expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'Edit comment: tighten this' }));
  });

  it('Esc in a note cancels the edit and keeps the card; the next Esc closes it on the chip', async () => {
    const { props } = mount();
    const chip = screen.getByRole('button', { name: 'Comment: tighten this' });
    fireEvent.click(chip);
    fireEvent.click(within(card()).getByRole('button', { name: 'Edit comment: tighten this' }));
    const field = within(card()).getByRole('textbox', { name: 'Edit comment' });
    fireEvent.change(field, { target: { value: 'discard me' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(props.onEditComment).not.toHaveBeenCalled();
    expect(card()).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(chip);
  });

  it('a press outside closes it, saving a note being edited', async () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Comment: tighten this' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Edit comment: tighten this' }));
    const field = within(card()).getByRole('textbox', { name: 'Edit comment' });
    field.focus();
    fireEvent.change(field, { target: { value: 'kept on the way out' } });
    fireEvent.pointerDown(document.body);
    expect(props.onEditComment).toHaveBeenCalledWith('c1', 'kept on the way out');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a press on the tray is not outside', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Comment: tighten this' }));
    fireEvent.pointerDown(row());
    expect(card()).toBeTruthy();
  });

  it('removes and dismisses from the card; the last item closes it on the composer', async () => {
    const { props, rerender } = mount({ comments: [comment('c1', 'the passage', 'tighten this')], quotedText: 'a warm cache' });
    fireEvent.click(screen.getByRole('button', { name: 'Comment: tighten this' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove comment: tighten this' }));
    expect(props.onRemoveComment).toHaveBeenCalledWith('c1');
    rerender({ comments: [] });
    expect(within(card()).getByText('Quote · sent with your message')).toBeTruthy();
    expect(card().contains(document.activeElement)).toBe(true);
    fireEvent.click(within(card()).getByRole('button', { name: 'Dismiss quote' }));
    expect(props.onDismissQuote).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    rerender({ comments: [], quotedText: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
