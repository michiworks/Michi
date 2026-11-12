import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReplyMemorySource } from 'michi-shared';

const api = vi.hoisted(() => ({ fetchReplyMemorySources: vi.fn(), deleteMemory: vi.fn(), hideRecalledTurn: vi.fn() }));
const nav = vi.hoisted(() => ({ openSourcePopover: vi.fn(), requestMemoryReveal: vi.fn() }));
vi.mock('../../services/api/memories', async (original) => ({
  ...(await original<typeof import('../../services/api/memories')>()),
  fetchReplyMemorySources: api.fetchReplyMemorySources, deleteMemory: api.deleteMemory, hideRecalledTurn: api.hideRecalledTurn,
}));
vi.mock('../../state/sourceNav/sourceNav', () => ({ openSourcePopover: nav.openSourcePopover }));
vi.mock('./pages/settings/memoryReveal', () => ({ requestMemoryReveal: nav.requestMemoryReveal }));

import { MemoryApiError } from '../../services/api/memories';
import { ReplySourcesContext, resetReplySources, type ReplySourcesTarget } from '../../state/memory/replySources';
import { ReplyMemorySources, sourceDate } from './ReplyMemorySources';

const LOCAL: ReplySourcesTarget = { apiBase: 'http://localhost:3000/api', nodeId: 'n-1', backendConnectionId: 'local', workspaceId: 'ws-1', local: true };
const REMOTE: ReplySourcesTarget = { apiBase: 'http://localhost:3000/api/backend-connections/r-1/proxy', nodeId: 'n-1', backendConnectionId: 'r-1', workspaceId: 'ws-9', local: false };
const NOW = new Date(2026, 10, 9, 12).getTime();
const saved: ReplyMemorySource = { kind: 'memory', memoryId: 'mem-1', text: 'Use pnpm, never npm.', savedBy: 'user', at: NOW - 3_600_000,
  from: { nodeId: 'n-src', messageId: 'u-1', title: 'Repo setup' } };
const noted: ReplyMemorySource = { kind: 'memory', memoryId: 'mem-2', text: 'The user is a night owl.', savedBy: 'michi', at: NOW - 86_400_000, from: null };
const imported: ReplyMemorySource = { kind: 'memory', memoryId: 'mem-3', text: 'Run tests with vitest.', savedBy: 'import', importSource: 'codex',
  at: new Date(2025, 10, 6).getTime(), from: null };
const pastChat: ReplyMemorySource = { kind: 'conversation', docId: 7, text: 'The launch is on March 3', at: new Date(2026, 10, 6).getTime(),
  from: { nodeId: 'n-old', messageId: 'u-7', title: 'Launch plan' } };

function answer(sources: ReplyMemorySource[]) {
  api.fetchReplyMemorySources.mockImplementation(async (_apiBase: string, _nodeId: string, ids: string[]) => ({
    messages: ids.map((messageId) => ({ messageId, sources })),
  }));
}

function show(target: ReplySourcesTarget | null = LOCAL, settled = true) {
  return render(
    target ? <ReplySourcesContext.Provider value={target}><ReplyMemorySources messageId="a-1" settled={settled} /></ReplySourcesContext.Provider>
      : <ReplyMemorySources messageId="a-1" settled={settled} />,
  );
}

async function expanded(target: ReplySourcesTarget = LOCAL) {
  show(target);
  const toggle = await screen.findByRole('button', { name: /^Based on/ });
  fireEvent.click(toggle);
  return toggle;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  for (const fn of [api.fetchReplyMemorySources, api.deleteMemory, api.hideRecalledTurn, nav.openSourcePopover, nav.requestMemoryReveal]) fn.mockReset();
  resetReplySources();
});
afterEach(() => vi.useRealTimers());

describe('ReplyMemorySources', () => {
  it('renders nothing outside a conversation that offers it, before the reply settles, or without sources', async () => {
    answer([saved]);
    const { container, unmount } = show(null);
    expect(container.innerHTML).toBe('');
    unmount();
    const unsettled = show(LOCAL, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(unsettled.container.innerHTML).toBe('');
    expect(api.fetchReplyMemorySources).not.toHaveBeenCalled();
    unsettled.unmount();
    resetReplySources();
    answer([]);
    const none = show();
    await waitFor(() => expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(none.container.innerHTML).toBe('');
  });

  it('is a quiet, collapsed line: singular and plural, with its tooltip and labels', async () => {
    answer([saved]);
    const { unmount } = show();
    const one = await screen.findByRole('button', { name: 'Based on 1 thing you told me' });
    expect(one.getAttribute('title')).toBe('What Michi remembered for this reply. It may not list everything.');
    expect(one.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('region', { name: 'What this reply was based on' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    unmount();
    resetReplySources();
    answer([saved, pastChat]);
    show();
    expect(await screen.findByRole('button', { name: 'Based on 2 things you told me' })).toBeTruthy();
  });

  it('expands into who, when and where; the source opens its conversation; Escape collapses and keeps focus on the toggle', async () => {
    answer([saved, noted, imported, pastChat]);
    const toggle = await expanded();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list');
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.t-reply-sources-meta')!.textContent)).toEqual([
      'Saved by you · today · Repo setup', 'Noted by Michi · yesterday', 'From Codex · Nov 6, 2025', 'From a past chat · Nov 6 · Launch plan',
    ]);
    expect(items[3]!.textContent).toContain('“The launch is on March 3”');
    fireEvent.click(screen.getByRole('button', { name: 'Launch plan' }));
    expect(nav.openSourcePopover).toHaveBeenCalledWith(expect.objectContaining({
      target: { backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n-old', messageId: 'u-7' },
    }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]!);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm forget' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Confirm forget' })).toBeNull();
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('list')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it('Forget asks first, then deletes on the conversation\'s backend; the item becomes a status line and the count drops; a 404 counts as done', async () => {
    answer([saved, noted]);
    api.deleteMemory.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new MemoryApiError(404, 'Memory not found', { code: 'not_found' }));
    await expanded();
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]!);
    expect(api.deleteMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm forget' }));
    await screen.findByRole('status');
    expect(api.deleteMemory).toHaveBeenCalledWith('mem-1', LOCAL.apiBase);
    expect(screen.getByRole('status').textContent).toBe('Forgotten.');
    expect(screen.getByRole('button', { name: 'Based on 1 thing you told me' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm forget' }));
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2));
    // Nothing left: no "0" count while it stays open; collapsed, the line goes.
    expect(screen.queryByRole('button', { name: /Based on 0/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'What this reply was based on' }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('a failed Forget says so and keeps the buttons; Don\'t recall asks first, then hides the past turn', async () => {
    answer([saved, pastChat]);
    api.deleteMemory.mockRejectedValueOnce(new MemoryApiError(500, 'disk full'));
    api.hideRecalledTurn.mockResolvedValueOnce(undefined);
    await expanded();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm forget' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t forget it: disk full');
    expect(screen.getByRole('button', { name: 'Confirm forget' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t recall' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('status');
    expect(api.hideRecalledTurn).toHaveBeenCalledWith(LOCAL.apiBase, 7);
    expect(screen.getByRole('status').textContent).toBe('Michi won’t recall this again.');
  });

  it('Edit opens Settings › Memory at the memory, on this machine\'s backend only', async () => {
    answer([saved]);
    const { unmount } = show();
    fireEvent.click(await screen.findByRole('button', { name: /^Based on/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(nav.requestMemoryReveal).toHaveBeenCalledWith({ id: 'mem-1', body: 'Use pnpm, never npm.' });
    unmount();
    resetReplySources();
    await expanded(REMOTE);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy();
  });

  it('dates: today, yesterday, a day this year, a day of another year', () => {
    const now = new Date(2026, 10, 9, 9);
    expect(sourceDate(new Date(2026, 10, 9, 1).getTime(), now)).toBe('today');
    expect(sourceDate(new Date(2026, 10, 8, 23).getTime(), now)).toBe('yesterday');
    expect(sourceDate(new Date(2026, 10, 6).getTime(), now)).toBe('Nov 6');
    expect(sourceDate(new Date(2025, 10, 6).getTime(), now)).toBe('Nov 6, 2025');
  });

  it('every control is a button: a tap\'s hover lands on a control (MessageBlock reveals nothing for it)', async () => {
    answer([saved, pastChat]);
    await expanded();
    for (const control of screen.getByRole('region').querySelectorAll('button, a, [role="button"]')) {
      expect(control.tagName).toBe('BUTTON');
      expect(control.getAttribute('type')).toBe('button');
    }
    await act(async () => {});
  });
});

describe('ReplyMemorySources, timing and freshness', () => {
  it('a reply whose turn still runs after its visible answer asks only once the turn is done', async () => {
    answer([saved]);
    const running = { ...LOCAL, runningMessageId: 'a-1' };
    const { rerender } = render(<ReplySourcesContext.Provider value={running}><ReplyMemorySources messageId="a-1" settled /></ReplySourcesContext.Provider>);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(api.fetchReplyMemorySources).not.toHaveBeenCalled();
    rerender(<ReplySourcesContext.Provider value={{ ...LOCAL, runningMessageId: null }}><ReplyMemorySources messageId="a-1" settled /></ReplySourcesContext.Provider>);
    expect(await screen.findByRole('button', { name: 'Based on 1 thing you told me' })).toBeTruthy();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(1);
  });

  it('opening asks again: what was forgotten elsewhere is gone from the list', async () => {
    answer([saved, pastChat]);
    show();
    const toggle = await screen.findByRole('button', { name: 'Based on 2 things you told me' });
    answer([saved]);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Based on 1 thing you told me' })).toBeTruthy();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(2);
  });
});
