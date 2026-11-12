import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyPageChanged } from './pageEvents';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from '../remoteFirstPaint';
import { useHomeSections, useProgressCards, useSpacesHome, useWorkspaceHome } from './useSpacesHome';

const api = vi.hoisted(() => ({
  fetchSpacesHome: vi.fn(),
  fetchWorkspaceHome: vi.fn(),
  fetchHomeSections: vi.fn(),
  fetchSpaceActivity: vi.fn(),
  fetchProgressCards: vi.fn(),
  fetchWorkspaceHomes: vi.fn(),
}));

vi.mock('../../services/api/spacesHome', () => api);

afterEach(() => vi.clearAllMocks());

const sections = (total: number) => ({
  waiting: { items: [], total }, stalled: { items: [], total: 0 }, done: { items: [], total: 0 }, conversations: { available: true },
});

describe('Spaces Home hooks', () => {
  it('reads the Home once per backend and refreshes on that backend’s page events only', async () => {
    api.fetchSpacesHome.mockResolvedValue({ role: 'spaces-home', page: { id: 'home' }, layoutRules: [] });
    const { result } = renderHook(() => useSpacesHome('home-events'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.fetchSpacesHome).toHaveBeenCalledTimes(1);
    expect(api.fetchSpacesHome.mock.calls[0][0]).toBe('home-events');

    act(() => notifyPageChanged({ backendConnectionId: 'elsewhere', pageId: 'p' }));
    expect(api.fetchSpacesHome).toHaveBeenCalledTimes(1);
    act(() => notifyPageChanged({ backendConnectionId: 'home-events', pageId: 'p' }));
    await waitFor(() => expect(api.fetchSpacesHome).toHaveBeenCalledTimes(2));
  });

  it('keeps the last sections, marked stale, when a later read fails', async () => {
    api.fetchHomeSections.mockResolvedValueOnce(sections(3)).mockRejectedValueOnce(new Error('Backend unavailable'));
    const { result } = renderHook(() => useHomeSections('home-stale'));
    await waitFor(() => expect(result.current.data?.waiting.total).toBe(3));
    expect(api.fetchHomeSections.mock.calls[0][0]).toBe('home-stale');

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.data?.waiting.total).toBe(3);
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBe('Backend unavailable');
  });

  it('reports an error, not an empty Home, when the first read fails', async () => {
    api.fetchHomeSections.mockRejectedValue(new Error('Backend unavailable'));
    const { result } = renderHook(() => useHomeSections('home-first-fail'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toBeNull();
  });

  it('keeps each workspace home separate and skips the read without a workspace', async () => {
    api.fetchWorkspaceHome.mockImplementation(async (workspaceId: string) => ({ role: 'workspace-home', workspaceId, page: { id: `home-${workspaceId}` } }));
    const { result, rerender } = renderHook(({ id }) => useWorkspaceHome(id, 'ws-homes'), { initialProps: { id: 'ws-a' } });
    await waitFor(() => expect(result.current.data?.workspaceId).toBe('ws-a'));
    rerender({ id: 'ws-b' });
    await waitFor(() => expect(result.current.data?.workspaceId).toBe('ws-b'));

    api.fetchWorkspaceHome.mockClear();
    renderHook(() => useWorkspaceHome('', 'ws-homes'));
    expect(api.fetchWorkspaceHome).not.toHaveBeenCalled();
  });

  it('ignores an answer that arrives after a newer read started', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    api.fetchHomeSections
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(sections(5));
    const { result } = renderHook(() => useHomeSections('home-race'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.waiting.total).toBe(5));
    await act(async () => { resolveFirst(sections(1)); await Promise.resolve(); });
    expect(result.current.data?.waiting.total).toBe(5);
  });

  it('lets a background progress reader wait for the remote to paint, but not the Spaces page', async () => {
    api.fetchProgressCards.mockResolvedValue([]);
    const background = renderHook(() => useProgressCards('remote-progress', { deferToFirstPaint: true }));
    await act(async () => { await Promise.resolve(); });
    expect(api.fetchProgressCards).not.toHaveBeenCalled();
    background.unmount();
    renderHook(() => useProgressCards('remote-progress'));
    expect(api.fetchProgressCards).toHaveBeenCalledTimes(1);
    resetRemoteFirstPaint();
    const waiting = renderHook(() => useProgressCards('remote-progress-2', { deferToFirstPaint: true }));
    await act(async () => { markRemoteFirstPaint('remote-progress-2'); });
    await waitFor(() => expect(waiting.result.current.status).toBe('ready'));
    expect(api.fetchProgressCards).toHaveBeenCalledTimes(2);
    resetRemoteFirstPaint();
  });

  it('polls shared progress through the reader that does not wait for the remote', async () => {
    vi.useFakeTimers();
    try {
      api.fetchProgressCards.mockResolvedValue([]);
      const page = renderHook(() => useProgressCards('remote-progress-poll'));
      const background = renderHook(() => useProgressCards('remote-progress-poll', { deferToFirstPaint: true }));
      expect(api.fetchProgressCards).toHaveBeenCalledTimes(1);

      // The background reader's own mount read gives up waiting after 1.5 s.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(api.fetchProgressCards).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(api.fetchProgressCards).toHaveBeenCalledTimes(3);
      page.unmount();
      background.unmount();
    } finally {
      vi.useRealTimers();
      resetRemoteFirstPaint();
    }
  });
});
