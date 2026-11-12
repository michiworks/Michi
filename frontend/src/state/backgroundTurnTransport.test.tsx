import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ subscribeBackground: vi.fn() }));
vi.mock('../services/api', () => api);
import { createBackgroundTurnTransport } from './backgroundTurnTransport';
import { BACKEND_CONNECTION_READY } from '../config/backendConnectionState';

describe('remote event replay after connection recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); api.subscribeBackground.mockReset().mockReturnValue(vi.fn()); });
  afterEach(() => vi.useRealTimers());
  it('resumes with the retained cursor immediately on readiness and never overlaps a live feed', async () => {
    let seq = 8;
    const transport = createBackgroundTurnTransport({ connectionId: 'remote', handlersForChat: () => ({}),
      cursorSnapshot: () => ({ chat: { turnId: 'durable-turn', seq } }), random: () => 0.5 });
    transport.start();
    expect(api.subscribeBackground.mock.calls[0][1].cursors.chat.seq).toBe(8);
    seq = 12;
    api.subscribeBackground.mock.calls[0][1].onDisconnect({ retryable: true });
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId: 'other' } }));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId: 'remote' } }));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    expect(api.subscribeBackground.mock.calls[1][1].cursors.chat).toEqual({ turnId: 'durable-turn', seq: 12 });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    transport.stop();
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId: 'remote' } }));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
  });

  it('reconnects at once when the window comes back to the foreground, not while hidden', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const transport = createBackgroundTurnTransport({ handlersForChat: () => ({}), random: () => 0.5, reconnectDelayMs: 60_000, maxReconnectDelayMs: 60_000 });
    transport.start();
    api.subscribeBackground.mock.calls[0][1].onDisconnect({ retryable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    // A live subscription is not overlapped.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    transport.stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('says when the feed opens again after a disconnect (the backend may be another build), never at its first open', async () => {
    const onReconnect = vi.fn();
    const transport = createBackgroundTurnTransport({ connectionId: 'local', handlersForChat: () => ({}), onReconnect, random: () => 0.5 });
    transport.start();
    api.subscribeBackground.mock.calls[0][1].onOpen();
    expect(onReconnect).not.toHaveBeenCalled();
    // The backend goes away; the first attempt after it fails before opening, the next one opens.
    api.subscribeBackground.mock.calls[0][1].onDisconnect({ retryable: true });
    await vi.advanceTimersByTimeAsync(500);
    api.subscribeBackground.mock.calls[1][1].onDisconnect({ retryable: true });
    expect(onReconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.subscribeBackground).toHaveBeenCalledTimes(3);
    api.subscribeBackground.mock.calls[2][1].onOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    transport.stop();
  });
});
