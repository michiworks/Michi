import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companionSnapshot } from '../../test/companionFixtures';
import { adoptCompanionSnapshot, getCompanionState, resetCompanionStoreForTests } from './companionStore';
import { resetCompanionOffNoticeForTests, useCompanionOffNotice } from './companionOffNotice';

const mocks = vi.hoisted(() => ({ toast: vi.fn(), mark: vi.fn(async () => undefined) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../../services/api/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/companion')>()),
  markCompanionOffNotice: mocks.mark,
}));

const settings = companionSnapshot().settings;
const snapshot = (paused: boolean, offNoticeAt: number | null | undefined) => {
  const base = companionSnapshot({ settings: { ...settings, paused } });
  if (offNoticeAt === undefined) return base;
  return { ...base, offNoticeAt };
};

beforeEach(() => {
  mocks.toast.mockReset();
  mocks.mark.mockClear();
  resetCompanionOffNoticeForTests();
});
afterEach(() => resetCompanionStoreForTests());

describe('the one-time "Michi is off" notice (Q29)', () => {
  it('says once, when setup is done and Michi is off, where to turn it on; the backend keeps that it was said', () => {
    resetCompanionStoreForTests({ snapshot: snapshot(true, null) });
    const open = vi.fn();
    const { rerender } = renderHook(({ ready }) => useCompanionOffNotice(ready, 'Robin', open), { initialProps: { ready: false } });
    expect(mocks.toast).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(mocks.toast).toHaveBeenCalledOnce();
    const [text, options] = mocks.toast.mock.calls[0]!;
    expect(text).toBe('Robin is off · Turn it on in Settings');
    options.action.onClick();
    expect(open).toHaveBeenCalledOnce();
    expect(mocks.mark).toHaveBeenCalledOnce();
    expect(getCompanionState().snapshot?.offNoticeAt).toEqual(expect.any(Number));
    // A later snapshot from before the record, or another render, says nothing again.
    act(() => adoptCompanionSnapshot({ ...snapshot(true, null), revision: 9 }));
    rerender({ ready: true });
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it('records it without a word when Michi is on, so turning it off later says nothing', () => {
    resetCompanionStoreForTests({ snapshot: snapshot(false, null) });
    renderHook(() => useCompanionOffNotice(true, 'Michi', vi.fn()));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.mark).toHaveBeenCalledOnce();
  });

  it('says nothing once it was said, nor on a backend that keeps no record', () => {
    for (const offNoticeAt of [123, undefined]) {
      resetCompanionOffNoticeForTests();
      resetCompanionStoreForTests({ snapshot: snapshot(true, offNoticeAt) });
      const { unmount } = renderHook(() => useCompanionOffNotice(true, 'Michi', vi.fn()));
      unmount();
    }
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
  });
});
