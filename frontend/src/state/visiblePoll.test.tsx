import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisiblePoll } from './visiblePoll';

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useVisiblePoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('polls only while the document is visible, and catches up once it is visible again', () => {
    const refresh = vi.fn();
    renderHook(() => useVisiblePoll(refresh, { intervalMs: 10_000 }));
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes once for a focus that comes with the visibility change', () => {
    const refresh = vi.fn();
    renderHook(() => useVisiblePoll(refresh, { intervalMs: 10_000 }));
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('ignores focus when asked to, but still catches up on visibility', () => {
    const refresh = vi.fn();
    renderHook(() => useVisiblePoll(refresh, { intervalMs: 10_000, focus: false }));
    window.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled();
    setVisibility('hidden');
    setVisibility('visible');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled, and stops on unmount', () => {
    const refresh = vi.fn();
    const { rerender, unmount } = renderHook(({ enabled }) => useVisiblePoll(refresh, { intervalMs: 10_000, enabled }), { initialProps: { enabled: false } });
    vi.advanceTimersByTime(20_000);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled();
    rerender({ enabled: true });
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
