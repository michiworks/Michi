import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as streamTransport from './streamTransport';
import { createReconnectingFeed, openSseFeed, type ReconnectingFeedOptions } from './sseFeed';
import { BACKEND_CONNECTION_READY } from '../../config/backendConnectionState';
import { SseHttpError } from './sseParser';

const encoder = new TextEncoder();

/** A 200 SSE answer that stays open; push() sends bytes, end() closes it. */
function liveResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  return {
    response,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: () => controller.error(new DOMException('aborted', 'AbortError')),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('openSseFeed', () => {
  it('opens, hands over frames in order and reports a clean end without an error', async () => {
    const live = liveResponse();
    const fetchStream = vi.spyOn(streamTransport, 'fetchStream').mockResolvedValue(live.response);
    const frames: string[] = [];
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    openSseFeed('/api/feed', {
      label: 'feed', init: { headers: { 'X-Probe': '1' } }, transport: { mapPayload: false },
      onFrame: (event, data) => { frames.push(`${event}:${data}`); }, onOpen, onDisconnect,
    });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(fetchStream.mock.calls[0][0]).toBe('/api/feed');
    expect(fetchStream.mock.calls[0][1]).toMatchObject({ headers: { 'X-Probe': '1' } });
    expect(fetchStream.mock.calls[0][2]).toEqual({ mapPayload: false });
    live.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    live.end();
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(frames).toEqual(['a:1', 'b:2']);
    expect(onDisconnect).toHaveBeenCalledWith(undefined);
  });

  it('turns a non-ok answer into an SseHttpError with its status, without opening', async () => {
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValue(new Response('{}', { status: 404 }));
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    openSseFeed('/api/feed', { label: 'subscribeProbe', onFrame: () => {}, onOpen, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    const error = onDisconnect.mock.calls[0][0];
    expect(error).toBeInstanceOf(SseHttpError);
    expect(error).toMatchObject({ status: 404, message: 'subscribeProbe failed: 404' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('awaits a frame handler that returns a promise before the next frame', async () => {
    const live = liveResponse();
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValue(live.response);
    let release!: () => void;
    const seen: string[] = [];
    openSseFeed('/api/feed', {
      label: 'feed',
      onFrame: (_event, data) => {
        seen.push(data);
        if (data === '1') return new Promise<void>((resolve) => { release = resolve; });
      },
    });
    live.push('data: 1\n\ndata: 2\n\n');
    await vi.waitFor(() => expect(seen).toEqual(['1']));
    release();
    await vi.waitFor(() => expect(seen).toEqual(['1', '2']));
  });

  it('says nothing once stopped, opened or not', async () => {
    let answer!: (response: Response) => void;
    vi.spyOn(streamTransport, 'fetchStream').mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    const stop = openSseFeed('/api/feed', { label: 'feed', onFrame: () => {}, onOpen, onDisconnect });
    stop();
    answer(liveResponse().response);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('aborts a feed that stays silent for silenceMs, and any bytes restart the wait', async () => {
    vi.useFakeTimers();
    const live = liveResponse();
    vi.spyOn(streamTransport, 'fetchStream').mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener('abort', () => live.fail());
      return live.response;
    });
    const onDisconnect = vi.fn();
    openSseFeed('/api/feed', { label: 'feed', silenceMs: 1_000, onFrame: () => {}, onDisconnect });
    await vi.advanceTimersByTimeAsync(900);
    live.push(': keepalive\n\n');
    await vi.advanceTimersByTimeAsync(900);
    expect(onDisconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onDisconnect.mock.calls[0][0]).toMatchObject({ message: 'feed stalled — no data received' });
  });
});

describe('createReconnectingFeed', () => {
  type Handlers = Parameters<ReconnectingFeedOptions['open']>[0];
  function feed(options: Partial<ReconnectingFeedOptions> = {}) {
    const attempts: Handlers[] = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const loop = createReconnectingFeed({
      baseMs: 1_000, maxMs: 8_000, healthyMs: 5_000, random: () => 0.5,
      open: (handlers) => { attempts.push(handlers); const stop = vi.fn(); stops.push(stop); return stop; },
      ...options,
    });
    return { loop, attempts, stops, last: () => attempts[attempts.length - 1] };
  }
  const ready = (connectionId: string) => window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId } }));

  beforeEach(() => { vi.useFakeTimers(); });

  it('keeps growing the delay while each open fails before healthyMs', async () => {
    const { loop, attempts, last } = feed();
    loop.start();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 8_000]) {
      last().onOpen();
      await vi.advanceTimersByTimeAsync(100);
      last().onDisconnect(new Error('dropped after headers'));
      const before = attempts.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(attempts).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(before + 1);
    }
    loop.stop();
  });

  it('starts the delay over once an open lasted healthyMs', async () => {
    const { loop, attempts, last } = feed();
    loop.start();
    last().onDisconnect(new Error('a'));
    await vi.advanceTimersByTimeAsync(1_000);
    last().onDisconnect(new Error('b'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toHaveLength(3);
    last().onOpen();
    await vi.advanceTimersByTimeAsync(5_000);
    last().onDisconnect(new Error('c'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toHaveLength(4);
    loop.stop();
  });

  it('keeps every delay within ±25 %', async () => {
    for (const [random, delay] of [[0, 750], [1, 1_250]] as const) {
      const { loop, attempts, last } = feed({ random: () => random });
      loop.start();
      last().onDisconnect();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(attempts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(2);
      loop.stop();
    }
  });

  it('reconnects at once on its own connection\'s readiness, never over a live attempt or after stop', async () => {
    const { loop, attempts, last } = feed({ connectionId: 'remote', baseMs: 60_000, maxMs: 60_000 });
    loop.start();
    ready('remote');
    expect(attempts).toHaveLength(1);
    last().onDisconnect(new Error('gone'));
    ready('other');
    expect(attempts).toHaveLength(1);
    ready('remote');
    expect(attempts).toHaveLength(2);
    window.dispatchEvent(new Event('online'));
    expect(attempts).toHaveLength(2);
    // The scheduled retry was replaced, not kept alongside.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
    loop.stop();
    ready('remote');
    expect(attempts).toHaveLength(2);
  });

  it('stops on a fatal end; a wake-up restarts it only with wakeAfterFatal', async () => {
    const onFatal = vi.fn();
    const onRetry = vi.fn();
    const refused = new SseHttpError(403);
    const plain = feed({ connectionId: 'remote', isFatal: (error) => error instanceof SseHttpError, onFatal, onRetry });
    plain.loop.start();
    plain.last().onDisconnect(refused);
    expect(onFatal).toHaveBeenCalledWith(refused);
    await vi.advanceTimersByTimeAsync(60_000);
    ready('remote');
    window.dispatchEvent(new Event('online'));
    expect(plain.attempts).toHaveLength(1);
    plain.loop.stop();

    const waking = feed({ connectionId: 'remote', wakeAfterFatal: true, onRetry });
    waking.loop.start();
    // The attempt's own verdict overrides isFatal.
    waking.last().onDisconnect(undefined, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waking.attempts).toHaveLength(1);
    ready('remote');
    expect(waking.attempts).toHaveLength(2);
    expect(onRetry).not.toHaveBeenCalled();
    waking.loop.stop();
  });

  it('stops the live attempt on stop and ignores its late end', async () => {
    const onRetry = vi.fn();
    const { loop, attempts, stops, last } = feed({ onRetry });
    loop.start();
    loop.stop();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    last().onDisconnect(new Error('late'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
