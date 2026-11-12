import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMemoryMode, MemoryMode } from 'michi-shared';
import { MemoryApiError } from '../../services/api/memories';
import { noteMemoryOn, resetConversationMemory } from '../../state/memory/conversationMemory';
import { ConversationMemoryControl } from './ConversationMemoryControl';

/** The conversation's backend: its memory setting per chat, and memory on or off. */
const backend = vi.hoisted(() => ({
  modes: {} as Record<string, ConversationMemoryMode>,
  memory: 'auto' as MemoryMode,
  removed: 0,
  readError: null as Error | null,
  saveErrors: [] as Error[],
  saves: [] as Array<{ apiBase: string; nodeId: string; mode: ConversationMemoryMode }>,
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('../../services/api/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api/memories')>();
  return {
    ...actual,
    fetchMemorySettings: vi.fn(async () => ({ mode: backend.memory })),
    fetchConversationMemoryMode: vi.fn(async (_apiBase: string, nodeId: string) => {
      if (backend.readError) throw backend.readError;
      return backend.modes[nodeId] ?? 'learn';
    }),
    saveConversationMemoryMode: vi.fn(async (apiBase: string, nodeId: string, mode: ConversationMemoryMode) => {
      const failure = backend.saveErrors.shift();
      if (failure) throw failure;
      backend.saves.push({ apiBase, nodeId, mode });
      backend.modes[nodeId] = mode;
      return { mode, removedMemories: backend.removed };
    }),
  };
});

const chip = (name: string) => screen.findByRole('button', { name });
const notFound = () => new MemoryApiError(404, 'Conversation not found', { code: 'not_found' });
/** Lets the control's reads settle. */
const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });

beforeEach(() => {
  resetConversationMemory();
  Object.assign(backend, { modes: {}, memory: 'auto', removed: 0, readError: null, saveErrors: [], saves: [] });
  toast.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a chat’s memory control', () => {
  it('is a quiet icon in Learn; its menu works from the keyboard and names the choice once it is not Learn', async () => {
    render(<ConversationMemoryControl apiBase="/api" nodeId="n-1" />);
    const learn = await chip('Memory: Learn');
    expect(learn.getAttribute('data-icononly')).toBe('true');
    learn.focus();
    fireEvent.keyDown(learn, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu', { name: 'Memory for this chat' });
    expect(learn.getAttribute('aria-expanded')).toBe('true');
    // Focus starts on the current choice; arrows wrap, Home and End jump.
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /^Learn/, checked: true }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /^Off/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /^Use only/ }));
    expect(menu.textContent).toContain('Leaving Learn also forgets what Michi learned from this chat on its own.');
    fireEvent.click(document.activeElement!);

    const useOnly = await chip('Memory: Use only');
    expect(backend.saves).toEqual([{ apiBase: '/api', nodeId: 'n-1', mode: 'use_only' }]);
    expect(useOnly.hasAttribute('data-icononly')).toBe(false);
    expect(useOnly.textContent).toBe('Use only');
    expect(document.activeElement).toBe(useOnly);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape or Tab, giving focus back, and picking the current choice saves nothing', async () => {
    backend.modes['n-1'] = 'off';
    render(<ConversationMemoryControl apiBase="/api" nodeId="n-1" />);
    const off = await chip('Memory: Off');
    fireEvent.click(off);
    expect(screen.getByRole('menu').textContent).not.toContain('Leaving Learn');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(off);
    fireEvent.click(off);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(off);
    fireEvent.click(off);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Off/, checked: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(backend.saves).toEqual([]);
  });

  it('is absent where the backend has no such setting, and while memory is off for every chat until Settings turns it on', async () => {
    backend.readError = new MemoryApiError(404, 'Not found');
    const { unmount } = render(<ConversationMemoryControl apiBase="/api" nodeId="n-1" />);
    await settle();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    backend.readError = null;
    backend.memory = 'off';
    resetConversationMemory();
    render(<ConversationMemoryControl apiBase="/api" nodeId="n-2" />);
    await settle();
    expect(screen.queryByRole('button')).toBeNull();
    act(() => noteMemoryOn('/remote', true));
    expect(screen.queryByRole('button')).toBeNull();
    act(() => noteMemoryOn('/api', true));
    expect(await chip('Memory: Learn')).toBeTruthy();
    act(() => noteMemoryOn('/api', false));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('treats a chat its backend has not stored yet as Learn, and saves a choice once the chat arrives there', async () => {
    backend.readError = notFound();
    backend.saveErrors = [notFound()];
    render(<ConversationMemoryControl apiBase="/api" nodeId="n-new" />);
    fireEvent.click(await chip('Memory: Learn'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Off/ }));
    expect(screen.getByRole('button', { name: 'Memory: Learn' }).textContent).toBe('Saving…');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(backend.saves).toEqual([{ apiBase: '/api', nodeId: 'n-new', mode: 'off' }]);
    expect(screen.getByRole('button', { name: 'Memory: Off' })).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says what leaving Learn forgot, and when a change failed', async () => {
    backend.removed = 2;
    render(<ConversationMemoryControl apiBase="/api" nodeId="n-1" />);
    fireEvent.click(await chip('Memory: Learn'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Off/ }));
    await chip('Memory: Off');
    expect(toast).toHaveBeenCalledWith('Forgot 2 memories Michi had learned from this chat');

    backend.saveErrors = [new Error('offline')];
    fireEvent.click(screen.getByRole('button', { name: 'Memory: Off' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Learn/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t change memory for this chat: offline'));
    expect(screen.getByRole('button', { name: 'Memory: Off' })).toBeTruthy();
  });

  it('is disabled while the chat streams, and its menu closes', async () => {
    const { rerender } = render(<ConversationMemoryControl apiBase="/api" nodeId="n-1" />);
    fireEvent.click(await chip('Memory: Learn'));
    expect(screen.getByRole('menu')).toBeTruthy();
    rerender(<ConversationMemoryControl apiBase="/api" nodeId="n-1" disabled />);
    expect((screen.getByRole('button', { name: 'Memory: Learn' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});
