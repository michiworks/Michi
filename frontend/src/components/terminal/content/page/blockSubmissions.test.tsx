import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_BLOCK_CATALOG, blockSubmissionSignature, type BlockSubmission } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';

afterEach(() => { cleanup(); });

const form = { ...PAGE_BLOCK_CATALOG.form.example!, id: 'f' };
const poll = { ...PAGE_BLOCK_CATALOG.poll.example!, id: 'p' };
const choice = { ...PAGE_BLOCK_CATALOG.choice.example!, id: 'c' };
const actions = { type: 'actions' as const, id: 'a', buttons: [{ label: 'Retry', prompt: 'Run the failing test again' }, { label: 'Skip', prompt: 'Skip this test' }] };
const NOW = Date.UTC(2026, 10, 15, 12);
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000;
const submission = (blockId: string, value: unknown, minutesAgo = 5): BlockSubmission => ({ blockId, signature: 's', value, text: 'sent', submittedAt: at(minutesAgo) });

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('interactive block submissions', () => {
  it('shows a submitted form read-only with its answers and when it was sent', () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock block={form} ctx={{ depth: 0, now: NOW, requestAssistant, submissionFor: () => submission('f', { city: 'Kyoto' }),
      recordSubmission: vi.fn(async () => true) }} />);
    // A record, not a locked form: each answer as text beside its label, no controls (DESIGN ST-31).
    const answer = screen.getByText('Kyoto');
    expect(answer.tagName).toBe('DD');
    expect(answer.previousElementSibling?.textContent).toMatch(/City/);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.getByText(/Submitted ·/).textContent).toBe('Submitted · 5m ago');
    expect(requestAssistant).not.toHaveBeenCalled();
  });

  it('stores the form answers before it hands them to the assistant', async () => {
    const requestAssistant = vi.fn(() => true);
    const stored = deferred();
    const recordSubmission = vi.fn<NonNullable<MichiBlockCtx['recordSubmission']>>(() => stored.promise);
    render(<MichiBlock block={form} ctx={{ depth: 0, requestAssistant, recordSubmission, submissionFor: () => undefined }} />);
    fireEvent.change(screen.getByRole('textbox', { name: /City/ }), { target: { value: 'Kyoto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(recordSubmission).toHaveBeenCalledTimes(1);
    const [block, signature, value, text] = recordSubmission.mock.calls[0];
    expect(block).toMatchObject({ id: 'f' });
    expect(signature).toBe(blockSubmissionSignature(block));
    expect(value).toEqual({ city: 'Kyoto' });
    expect(text).toBe('Plan a trip with these answers\n\n{"city":"Kyoto"}');
    // Nothing goes until the submission is stored, and a second click cannot store another.
    expect(requestAssistant).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Submit' }).matches(':disabled')).toBe(true);
    await act(async () => { stored.resolve(true); await stored.promise; });
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' }), text, 'Trip', false);
  });

  it('sends nothing when the poll was already submitted elsewhere, and then shows the stored pick', async () => {
    const requestAssistant = vi.fn(() => true);
    let stored: BlockSubmission | undefined;
    const ctx = (): MichiBlockCtx => ({ depth: 0, now: NOW, requestAssistant, submissionFor: () => stored,
      recordSubmission: vi.fn(async () => { stored = submission('p', [0], 0); return false; }) });
    const { rerender } = render(<MichiBlock block={poll} ctx={ctx()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Sushi' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vote' })); });
    expect(requestAssistant).not.toHaveBeenCalled();
    // The host's submissions changed, so its context does too.
    rerender(<MichiBlock block={poll} ctx={ctx()} />);
    expect((screen.getByRole('radio', { name: 'Ramen' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Ramen' }).matches(':disabled')).toBe(true);
    expect((screen.getByRole('radio', { name: 'Sushi' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
    expect(screen.getByText(/Submitted ·/).textContent).toBe('Submitted · just now');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when a pick could not be stored and lets it be tried again', async () => {
    const requestAssistant = vi.fn(() => true);
    const recordSubmission = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<MichiBlock block={poll} ctx={{ depth: 0, requestAssistant, recordSubmission, submissionFor: () => undefined }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Sushi' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vote' })); });
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn’t save your answer/);
    expect(requestAssistant).not.toHaveBeenCalled();
    expect(recordSubmission.mock.calls[0][2]).toEqual([1]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vote' })); });
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), 'For “Lunch?” I pick: Sushi', 'Lunch?', true);
  });

  it('stores a choice before it sends and saves it on the page, and shows a stored one read-only', async () => {
    const requestAssistant = vi.fn(() => true);
    const updateBlock = vi.fn();
    const stored = deferred();
    const recordSubmission = vi.fn(() => stored.promise);
    const { unmount } = render(<MichiBlock block={choice} ctx={{ depth: 0, requestAssistant, updateBlock, recordSubmission, submissionFor: () => undefined }} />);
    fireEvent.click(screen.getByRole('button', { name: 'West' }));
    expect(recordSubmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), expect.any(String), 1, 'For “Which route?” I pick: West');
    expect(requestAssistant).not.toHaveBeenCalled();
    expect(updateBlock).not.toHaveBeenCalled();
    await act(async () => { stored.resolve(true); await stored.promise; });
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), 'For “Which route?” I pick: West', 'Which route?', true);
    expect(updateBlock).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), expect.objectContaining({ selected: 1 }));
    unmount();

    render(<MichiBlock block={choice} ctx={{ depth: 0, now: NOW, requestAssistant, recordSubmission, submissionFor: () => submission('c', 0, 120) }} />);
    expect(screen.getByRole('button', { name: 'East' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'East' }).matches(':disabled')).toBe(true);
    expect(screen.getByText(/Submitted ·/).textContent).toBe('Submitted · 2h ago');
  });

  it('without submission support sends at once, as before, and can send again', () => {
    vi.useFakeTimers();
    try {
      const requestAssistant = vi.fn(() => true);
      const updateBlock = vi.fn();
      render(<MichiBlock block={choice} ctx={{ depth: 0, requestAssistant, updateBlock }} />);
      fireEvent.click(screen.getByRole('button', { name: 'West' }));
      expect(requestAssistant).toHaveBeenCalledTimes(1);
      expect(updateBlock).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(2000); });
      fireEvent.click(screen.getByRole('button', { name: 'East' }));
      expect(requestAssistant).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/Submitted ·/)).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('in a chat reply, stores the button pressed before it sends, then keeps the group locked on it', async () => {
    const requestAssistant = vi.fn(() => true);
    let stored: BlockSubmission | undefined;
    const recordSubmission = vi.fn<NonNullable<MichiBlockCtx['recordSubmission']>>(async (_block, signature, value, text) => {
      stored = { blockId: 'a', signature, value, text, submittedAt: NOW };
      return true;
    });
    const ctx = (): MichiBlockCtx => ({ depth: 0, now: NOW, sendsAlways: true, requestAssistant, recordSubmission, submissionFor: () => stored });
    const view = render(<MichiBlock block={actions} ctx={ctx()} />);
    // Before a press, what each button sends in the user's name is listed under them.
    expect(screen.getByText('“Skip this test”', { exact: false }).textContent).toBe('Skip sends “Skip this test”');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip' })); });
    expect(recordSubmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.any(String), { button: 1, label: 'Skip' }, 'Skip this test');
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'Skip this test', 'Skip', true);
    view.rerender(<MichiBlock block={actions} ctx={ctx()} />);
    // Answered: which button was pressed, as text; no buttons to press again.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Skip').closest('.desk-actions-answer')).toBeTruthy();
    expect(screen.getByText(/Submitted ·/)).toBeTruthy();
    expect(screen.queryByText(/sends “/)).toBeNull();
  });

  it('on a page, buttons stay repeatable and store nothing', () => {
    const requestAssistant = vi.fn(() => true);
    const recordSubmission = vi.fn(async () => true);
    render(<MichiBlock block={actions} ctx={{ depth: 0, requestAssistant, recordSubmission, submissionFor: () => undefined }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(recordSubmission).not.toHaveBeenCalled();
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'Run the failing test again', 'Retry', false);
    expect(screen.queryByText(/sends “/)).toBeNull();
  });
  it('says what a form sends in the user\'s name where a press sends at once, and not on a page', () => {
    const view = render(<MichiBlock block={form} ctx={{ depth: 0, sendsAlways: true, requestAssistant: vi.fn(() => true) }} />);
    expect(screen.getByText('Sends “Plan a trip with these answers” with your answers')).toBeTruthy();
    view.unmount();
    render(<MichiBlock block={form} ctx={{ depth: 0, requestAssistant: vi.fn(() => true) }} />);
    expect(screen.queryByText(/^Sends “/)).toBeNull();
  });
});
