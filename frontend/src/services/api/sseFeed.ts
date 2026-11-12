import { BACKEND_CONNECTION_READY } from '../../config/backendConnectionState';
import { readSseStream, SseHttpError } from './sseParser';
import { fetchStream } from './streamTransport';

export interface SseFeedOptions {
  /** Names the feed in its errors. */
  label: string;
  init?: Omit<RequestInit, 'signal'>;
  /** fetchStream's own options. */
  transport?: { mapPayload?: boolean };
  /** Each frame; a returned promise holds the next frame until it settles. */
  onFrame: (event: string, data: string) => void | Promise<void>;
  onOpen?: () => void;
  /**
   * Once per feed, never after stop: the error, an SseHttpError for a non-ok
   * answer, or undefined when the server ended the stream.
   */
  onDisconnect?: (error?: Error) => void;
  /** Abort when nothing, heartbeats included, arrives for this long. */
  silenceMs?: number;
}

/** Opens one GET-style SSE feed over fetchStream. Returns stop. */
export function openSseFeed(url: string, options: SseFeedOptions): () => void {
  const controller = new AbortController();
  let stopped = false;
  let silent = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!options.silenceMs) return;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { silent = true; controller.abort(); }, options.silenceMs);
  };
  void (async () => {
    let disconnectError: Error | undefined;
    try {
      arm();
      const response = await fetchStream(url, { ...options.init, signal: controller.signal }, options.transport);
      if (!response.ok) throw new SseHttpError(response.status, `${options.label} failed`);
      if (!response.body) throw new Error(`${options.label} response has no body`);
      if (stopped) {
        await response.body.cancel().catch(() => {});
        return;
      }
      options.onOpen?.();
      await readSseStream(response.body.getReader(), options.onFrame, { onRead: arm, shouldStop: () => stopped });
    } catch (error) {
      disconnectError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(watchdog);
      if (silent) disconnectError = new Error(`${options.label} stalled — no data received`);
      if (!stopped) options.onDisconnect?.(disconnectError);
    }
  })();
  return () => {
    stopped = true;
    clearTimeout(watchdog);
    controller.abort();
  };
}

export interface ReconnectingFeedOptions {
  /**
   * Opens one attempt and returns its stop. onDisconnect ends the attempt;
   * `fatal` overrides isFatal for feeds that classify their own ends.
   */
  open: (handlers: { onOpen: () => void; onDisconnect: (error?: Error, fatal?: boolean) => void }) => () => void;
  /** An end that retrying cannot fix: no reconnect follows. */
  isFatal?: (error: Error | undefined) => boolean;
  baseMs: number;
  maxMs: number;
  /**
   * How long an open attempt must last before the backoff starts over.
   * Headers alone prove little: a feed can fail right after its 200.
   */
  healthyMs: number;
  /** Jitter source, for ±25 % on every delay. */
  random?: () => number;
  /**
   * The backend connection whose readiness reconnects at once, as going
   * online and a window coming back to the foreground do.
   */
  connectionId?: string;
  /** Those wake-ups also restart a feed a fatal end stopped. */
  wakeAfterFatal?: boolean;
  onOpen?: () => void;
  /** An attempt ended and a reconnect is scheduled. */
  onRetry?: (error?: Error) => void;
  onFatal?: (error?: Error) => void;
}

/**
 * Keeps one feed connected: exponential backoff with jitter, reset after a
 * healthy open, and an immediate reconnect on the wake-ups above, never over
 * a live attempt.
 */
export function createReconnectingFeed(opts: ReconnectingFeedOptions): { start(): void; stop(): void } {
  let stopped = false;
  let fatal = false;
  let attempt = 0;
  let cancel: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let healthyTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHealthy = () => {
    if (healthyTimer) clearTimeout(healthyTimer);
    healthyTimer = null;
  };

  const connect = () => {
    if (stopped) return;
    timer = null;
    let ended = false;
    const stopAttempt = opts.open({
      onOpen: () => {
        if (ended || stopped) return;
        clearHealthy();
        healthyTimer = setTimeout(() => { attempt = 0; }, opts.healthyMs);
        opts.onOpen?.();
      },
      onDisconnect: (error, fatalEnd) => {
        if (ended) return;
        ended = true;
        clearHealthy();
        cancel = null;
        if (stopped) return;
        if (fatalEnd ?? opts.isFatal?.(error) ?? false) {
          fatal = true;
          opts.onFatal?.(error);
          return;
        }
        opts.onRetry?.(error);
        const delay = Math.min(opts.maxMs, opts.baseMs * (2 ** attempt++));
        timer = setTimeout(connect, Math.round(delay * (0.75 + (opts.random ?? Math.random)() * 0.5)));
      },
    });
    if (!ended) cancel = stopAttempt;
  };

  const wake = (event: Event) => {
    if (stopped || (fatal && !opts.wakeAfterFatal)) return;
    if (event.type === BACKEND_CONNECTION_READY
      && (event as CustomEvent<{ connectionId: string }>).detail?.connectionId !== opts.connectionId) return;
    if (event.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
    if (cancel) return; // A live attempt owns the feed; do not overlap it.
    if (timer) clearTimeout(timer);
    timer = null;
    fatal = false;
    connect();
  };

  return {
    start() {
      if (typeof window !== 'undefined') {
        window.addEventListener('online', wake);
        window.addEventListener(BACKEND_CONNECTION_READY, wake);
      }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
      if (!stopped && !cancel && !timer) connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      clearHealthy();
      cancel?.();
      cancel = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', wake);
        window.removeEventListener(BACKEND_CONNECTION_READY, wake);
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
    },
  };
}
