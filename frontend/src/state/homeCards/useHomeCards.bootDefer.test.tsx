import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from '../remoteFirstPaint';
import { __resetHomeCardsCacheForTests, useHomeCards } from './useHomeCards';

const mocks = vi.hoisted(() => ({
  scope: { base: '/x', connectionId: 'local', key: 'k' },
  fetchHomeCards: vi.fn(),
}));
vi.mock('../../hooks/useBackendScope', () => ({ useBackendScope: () => mocks.scope }));
vi.mock('../../services/api/homeCards', () => ({
  EMPTY_HOME_CARDS: { greeting: null, sets: [], generatedAt: null, inputFingerprint: null },
  fetchHomeCards: mocks.fetchHomeCards,
  markHomeCardUsed: vi.fn(),
}));

afterEach(() => { vi.clearAllMocks(); resetRemoteFirstPaint(); __resetHomeCardsCacheForTests(); mocks.scope = { base: '/x', connectionId: 'local', key: 'k' }; });

describe('home cards boot read', () => {
  it('reads a local backend at once', () => {
    mocks.fetchHomeCards.mockResolvedValue({ greeting: null, sets: [], generatedAt: null, inputFingerprint: null });
    renderHook(() => useHomeCards());
    expect(mocks.fetchHomeCards).toHaveBeenCalledTimes(1);
  });

  it('holds a remote read until it paints', async () => {
    mocks.scope = { base: '/r', connectionId: 'remote-cards', key: 'rk' };
    mocks.fetchHomeCards.mockResolvedValue({ greeting: null, sets: [], generatedAt: null, inputFingerprint: null });
    renderHook(() => useHomeCards());
    await act(async () => { await Promise.resolve(); });
    expect(mocks.fetchHomeCards).not.toHaveBeenCalled();
    await act(async () => { markRemoteFirstPaint('remote-cards'); });
    expect(mocks.fetchHomeCards).toHaveBeenCalledTimes(1);
  });

  it('never reads after the view left while it waited', async () => {
    mocks.scope = { base: '/r', connectionId: 'remote-cards', key: 'rk' };
    const { unmount } = renderHook(() => useHomeCards());
    unmount();
    await act(async () => { markRemoteFirstPaint('remote-cards'); });
    expect(mocks.fetchHomeCards).not.toHaveBeenCalled();
  });
});
