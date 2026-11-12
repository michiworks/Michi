import { afterEach, describe, expect, it, vi } from 'vitest';
import { markRemoteFirstPaint, remoteFirstPainted, resetRemoteFirstPaint, whenRemoteFirstPaint } from './remoteFirstPaint';

describe('remoteFirstPaint', () => {
  afterEach(() => {
    resetRemoteFirstPaint();
    vi.useRealTimers();
  });

  it('never parks local or absent connections', async () => {
    expect(remoteFirstPainted('local')).toBe(true);
    expect(remoteFirstPainted(undefined)).toBe(true);
    await expect(whenRemoteFirstPaint('local', 10_000)).resolves.toBeUndefined();
  });

  it('releases waiters when the connection paints', async () => {
    let released = false;
    const wait = whenRemoteFirstPaint('remote-a', 10_000).then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    markRemoteFirstPaint('remote-a');
    await wait;
    expect(released).toBe(true);
    expect(remoteFirstPainted('remote-a')).toBe(true);
    await expect(whenRemoteFirstPaint('remote-a')).resolves.toBeUndefined();
  });

  it('bounds every wait', async () => {
    vi.useFakeTimers();
    let released = false;
    void whenRemoteFirstPaint('remote-b', 500).then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
  });

  it('keeps connections independent and reset releases parked waiters', async () => {
    let otherReleased = false;
    void whenRemoteFirstPaint('remote-d', 10_000).then(() => { otherReleased = true; });
    markRemoteFirstPaint('remote-c');
    await Promise.resolve();
    expect(otherReleased).toBe(false);
    resetRemoteFirstPaint('remote-d');
    await Promise.resolve();
    expect(otherReleased).toBe(true);
    expect(remoteFirstPainted('remote-d')).toBe(false);
  });
});
