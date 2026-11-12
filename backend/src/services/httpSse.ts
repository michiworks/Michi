import { log } from './logger';

const MiB = 1024 * 1024;

/**
 * A slow consumer is one whose outgoing buffer stays large, not one that got
 * a burst: a subscription's synchronous replay can queue megabytes in one tick
 * and drain in milliseconds. A hard ceiling bounds memory at once, and a soft
 * level held for `softMs` catches a client that stopped reading (the shape of
 * Redis's pubsub output-buffer limit). Disconnecting is the recovery signal:
 * every stream reconnects from its cursor and reads what it missed from SQLite.
 */
export interface SlowConsumerLimits {
  softBytes: number;
  softMs: number;
  hardBytes: number;
}

export const SLOW_CONSUMER_LIMITS: Readonly<SlowConsumerLimits> = { softBytes: 4 * MiB, softMs: 30_000, hardBytes: 32 * MiB };

export type SlowConsumerReason = 'hard' | 'soft';

/**
 * What one subscription's opening replay may write, in UTF-8 bytes. On an
 * upgraded gateway every stream of a window shares one WebSocket, whose
 * re-escaping of each chunk as a JSON string at most doubles these bytes, so a
 * replay alone stays under the soft level. What a stream leaves out it marks,
 * and the client reads that from SQLite.
 */
export const SSE_REPLAY_BYTES = 2_000_000;

export interface SlowConsumerGuard {
  /** Sample the buffer around a write: false once the consumer is slow (onSlow ran). */
  check(): boolean;
  dispose(): void;
}

export function createSlowConsumerGuard(options: {
  bufferedBytes: () => number;
  onSlow: (reason: SlowConsumerReason, bufferedBytes: number) => void;
  /** The consumer is still connected; a sample after it closed decides nothing. */
  active?: () => boolean;
  limits?: SlowConsumerLimits;
}): SlowConsumerGuard {
  const limits = options.limits ?? SLOW_CONSUMER_LIMITS;
  let tripped = false;
  /** When the buffer last rose above the soft level; null while below it. */
  let overSince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    overSince = null;
  };
  const trip = (reason: SlowConsumerReason, bytes: number): false => {
    tripped = true;
    clear();
    options.onSlow(reason, bytes);
    return false;
  };
  const check = (): boolean => {
    if (tripped) return false;
    if (options.active && !options.active()) {
      clear();
      return true;
    }
    const bytes = options.bufferedBytes();
    if (bytes > limits.hardBytes) return trip('hard', bytes);
    if (bytes <= limits.softBytes) {
      clear();
      return true;
    }
    if (overSince === null) {
      overSince = Date.now();
      // A consumer that stopped reading gets no further writes to sample on.
      timer = setTimeout(() => {
        timer = null;
        if (!tripped && overSince !== null) check();
      }, limits.softMs);
      timer.unref?.();
      return true;
    }
    return Date.now() - overSince >= limits.softMs ? trip('soft', bytes) : true;
  };
  return {
    check,
    dispose() {
      tripped = true;
      clear();
    },
  };
}

/** Small writable surface shared by Express, multiplexed responses and tests. */
export interface SseWritableResponse {
  writableEnded: boolean;
  destroyed: boolean;
  writableLength: number;
  write(frame: string): unknown;
  destroy(error?: Error): unknown;
  once?(event: 'error', listener: () => void): unknown;
}

function disconnect(response: SseWritableResponse, message: string): void {
  try {
    // Standalone writer callers also need to consume async destroy(error) events.
    response.once?.('error', () => {});
    response.destroy(new Error(message));
  } catch { /* peer already gone */ }
}

/** The request path an Express response answers, for the log line only. */
function responsePath(response: SseWritableResponse): string | undefined {
  const req = (response as { req?: { originalUrl?: unknown; url?: unknown } }).req;
  const path = req?.originalUrl ?? req?.url;
  return typeof path === 'string' ? path.split('?')[0] : undefined;
}

const guards = new WeakMap<SseWritableResponse, SlowConsumerGuard>();

function guardFor(response: SseWritableResponse): SlowConsumerGuard {
  let guard = guards.get(response);
  if (!guard) {
    guard = createSlowConsumerGuard({
      bufferedBytes: () => response.writableLength,
      active: () => !response.writableEnded && !response.destroyed,
      onSlow: (reason, bufferedBytes) => {
        log.warn('http', 'SSE consumer too slow; disconnecting', { reason, bufferedBytes, path: responsePath(response) });
        disconnect(response, 'SSE client exceeded buffer limit');
      },
    });
    guards.set(response, guard);
  }
  return guard;
}

/** Bound this observer's outgoing bytes; never cancel the producer or its turn. */
export function writeSseFrame(response: SseWritableResponse, frame: string): boolean {
  if (response.writableEnded || response.destroyed) return false;
  const guard = guardFor(response);
  if (!guard.check()) return false;
  try {
    response.write(frame);
  } catch {
    guard.dispose();
    disconnect(response, 'SSE write failed');
    return false;
  }
  return guard.check();
}

interface SseObserverResponse extends SseWritableResponse {
  on(event: 'close' | 'error', listener: () => void): unknown;
  off(event: 'close' | 'error', listener: () => void): unknown;
}

/** Owns only subscription/heartbeat cleanup, including failed synchronous replay. */
export function createSseObserver(response: SseObserverResponse) {
  let closed = false;
  const cleanups = new Set<() => void>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    response.off('close', close);
    // Keep the error listener until the response is collected: destroy(error) may
    // emit asynchronously after failed-write cleanup has already run.
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* cleanup of another observer resource must continue */ }
    }
    cleanups.clear();
  };
  response.on('close', close);
  response.on('error', close);
  if (response.writableEnded || response.destroyed) close();
  const addCleanup = (cleanup: () => void): void => {
    if (closed) cleanup();
    else cleanups.add(cleanup);
  };
  const write = (frame: string): boolean => {
    if (closed) return false;
    if (writeSseFrame(response, frame)) return true;
    close();
    return false;
  };
  return {
    get closed() { return closed; },
    close,
    write,
    addCleanup,
    heartbeat(frame: string | (() => string), intervalMs: number): void {
      if (closed) return;
      const timer = setInterval(() => write(typeof frame === 'function' ? frame() : frame), intervalMs);
      timer.unref?.();
      addCleanup(() => clearInterval(timer));
    },
  };
}

interface SseResponse extends SseObserverResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): void;
}

/** Commit an SSE response's status and headers; answer errors before calling it. */
export function beginSse(response: SseResponse): ReturnType<typeof createSseObserver> {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream');
  // no-transform and X-Accel-Buffering keep compressing or buffering proxies (nginx) from holding frames back.
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();
  return createSseObserver(response);
}
