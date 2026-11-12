import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './useNow';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('moves on once per interval while enabled', () => {
    const { result } = renderHook(() => useNow(1_000));
    expect(result.current).toBe(1_000_000);
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current).toBe(1_000_000);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(1_001_000);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(result.current).toBe(1_003_000);
  });

  it('runs no timer while disabled', () => {
    const { result } = renderHook(() => useNow(1_000, false));
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toBe(1_000_000);
  });

  it('reads the time afresh when it is enabled again', () => {
    const { result, rerender } = renderHook(({ on }) => useNow(60_000, on), { initialProps: { on: true } });
    rerender({ on: false });
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(result.current).toBe(1_000_000);
    rerender({ on: true });
    expect(result.current).toBe(1_045_000);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current).toBe(1_105_000);
  });
});
