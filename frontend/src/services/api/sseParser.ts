// Shared Server-Sent-Events frame parser.
//
// The backend speaks newline-delimited SSE: frames separated by a blank line
// (`\n\n`), each frame a set of `event:` / `data:` lines. Three transports
// (foreground `streamMessage`, foreground replay `subscribeChat`, and the
// window-lifetime `subscribeBackground`) all consumed this byte stream with an
// identical hand-written read+frame loop. This module collapses that loop into
// one place; the per-frame semantics stay with each caller via `onFrame`.

import { HttpResponseError } from './httpError';

/**
 * A non-2xx HTTP response on an SSE subscribe endpoint. Callers inspect
 * `.status` to decide whether a reconnect is worthwhile; shouldRetryRequest
 * tells a transient answer from a refusal.
 */
export class SseHttpError extends HttpResponseError {
  constructor(status: number, prefix = 'subscribe failed', code?: string, message?: string) {
    super(message || `${prefix}: ${status}`, status, code);
    this.name = 'SseHttpError';
  }
}

export interface ReadSseStreamOptions {
  /**
   * Fired after every non-terminal read (including heartbeat-only reads),
   * before the chunk is framed. Callers use it to re-arm a silence watchdog.
   */
  onRead?: () => void;
  /**
   * Checked immediately after each read. When it returns true the loop exits
   * without processing the just-read chunk — matches the legacy `if (stopped)
   * break;` guard on the background feed.
   */
  shouldStop?: () => boolean;
}

export interface SseBlock {
  /** The `event:` field, trimmed; `message` when the frame names none. */
  event: string;
  /** The `data:` lines, each without one leading space, joined with `\n`. */
  data: string;
  /** Every line that is not a `data:` line, as written. */
  otherLines: string[];
}

/** One frame (the text between blank lines) read as the SSE spec reads it. */
export function parseSseBlock(block: string): SseBlock {
  let event = 'message';
  const data: string[] = [];
  const otherLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      const rest = line.slice(5);
      data.push(rest.startsWith(' ') ? rest.slice(1) : rest);
      continue;
    }
    if (line.startsWith('event:')) event = line.slice(6).trim();
    otherLines.push(line);
  }
  return { event, data: data.join('\n'), otherLines };
}

/**
 * Drain an SSE byte stream, invoking `onFrame(event, data)` once per frame that
 * carries non-empty data. `onFrame` may return a promise; when it does the loop
 * awaits it, turning a frame into a real ordering barrier (used by the
 * background feed's replay-gap reconciliation). When it returns void the loop
 * stays fully synchronous, preserving legacy frame-dispatch timing.
 *
 * Frames are read by parseSseBlock. Never `.trim()` data — that ate
 * whitespace inside JSON payloads and corrupted multi-byte UTF-8 frames whose
 * first byte happened to be ASCII whitespace.
 */
export async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFrame: (event: string, data: string) => void | Promise<void>,
  opts: ReadSseStreamOptions = {},
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (opts.shouldStop?.()) break;
      opts.onRead?.();
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        if (opts.shouldStop?.()) return;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const { event, data } = parseSseBlock(block);
        if (!data) continue;
        const maybe = onFrame(event, data);
        if (maybe) await maybe;
      }
    }
  } finally {
    // Parser/handler failures must detach their transport channel too. A
    // renderer disconnect releases a subscriber, never cancels a durable turn.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
