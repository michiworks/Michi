import { isWindowId, WINDOW_ID_HEADER } from 'michi-shared';

// Existing high-frequency probes and runtime transport requests.
const SILENT_SUCCESS_PATHS = [
  /^\/(?:health|ready)$/,
  /^\/agent\/(?:status|models)$/,
  /^\/mcp\/[^/]+$/,
  /^\/nodes\/[^/]+\/ensure-session$/,
  /^\/workspaces(?:\/all)?$/,
  /^\/workspaces\/[^/]+\/sync$/,
  /^\/chats\/[^/]+\/heartbeat$/,
  // The tray's minute refresh (electron/tray.ts TRAY_STALE_REFRESH_MS): about 1,440 a day.
  /^\/companion\/tray$/,
];

const POLLING_PATHS = [
  /^\/spaces$/,
  /^\/workspaces\/[^/]+\/(?:pages|databases|maintenance)$/,
  /^\/pages\/[^/]+(?:\/(?:changes|activity-seen))?$/,
  /^\/databases\/[^/]+$/,
];

/** Quiet routine polling, while retaining changed reads, mutations and errors. */
export function shouldLogAccess(method: string, requestPath: string, status: number): boolean {
  if (status >= 400) return true;
  const pathname = requestPath.replace(/^\/api(?=\/)/, '');
  if (SILENT_SUCCESS_PATHS.some((pattern) => pattern.test(pathname))) return false;
  if (method !== 'GET') return true;
  if (/^\/backend-connections\/recovery$/.test(pathname)) return false;
  return !((status === 204 || status === 304) && POLLING_PATHS.some((pattern) => pattern.test(pathname)));
}

/**
 * The hop that forwarded a request: the phone gateway, or another Michi's
 * backend-connections proxy. Any client can send this header, so it never
 * grants anything. `phone` may only take access away (isPhoneRequest): the
 * phone gateway stamps it on every request it forwards, so a phone cannot
 * drop it, and anyone else who sends it only restricts themselves.
 */
export const VIA_HEADER = 'x-michi-via';

/** A request that arrived through phone access (see VIA_HEADER): deny-only. */
export function isPhoneRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return headers[VIA_HEADER] === 'phone';
}
export type AccessVia = 'phone' | 'desktop-proxy';
const VIA_VALUES: ReadonlySet<string> = new Set<AccessVia>(['phone', 'desktop-proxy']);

type RequestHeaders = Record<string, string | string[] | undefined>;

/** Logged origin fields: `via` only from its allowlist, a well-formed window id only as a short prefix. */
export function accessOriginFields(headers: RequestHeaders): { via?: AccessVia; window?: string } {
  const via = headers[VIA_HEADER];
  const windowId = headers[WINDOW_ID_HEADER];
  return {
    ...(typeof via === 'string' && VIA_VALUES.has(via) ? { via: via as AccessVia } : {}),
    ...(isWindowId(windowId) ? { window: windowId.slice(0, 8) } : {}),
  };
}

export interface AccessLogLine {
  level: 'info' | 'warn' | 'error';
  meta: Record<string, unknown>;
}

/**
 * One access line. A finished response logs its status (when shouldLogAccess
 * allows it). A response closed before it finished (client gone, tunnel
 * dropped, SSE detached) logs status=aborted with the bytes written so far.
 * The origin fields follow the existing ones, so the line keeps its format.
 */
export function accessLogLine(input: {
  method: string;
  path: string;
  status: number;
  aborted: boolean;
  headersSent: boolean;
  durMs: number;
  requestId: unknown;
  bytes?: number;
  headers: RequestHeaders;
}): AccessLogLine | null {
  const origin = accessOriginFields(input.headers);
  if (input.aborted) {
    return {
      level: 'info',
      meta: {
        status: 'aborted', durMs: input.durMs, requestId: input.requestId,
        ...(input.headersSent ? { sentStatus: input.status } : {}),
        ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
        ...origin,
      },
    };
  }
  if (!shouldLogAccess(input.method, input.path, input.status)) return null;
  return {
    level: input.status >= 500 ? 'error' : input.status >= 400 ? 'warn' : 'info',
    meta: { status: input.status, durMs: input.durMs, requestId: input.requestId, ...origin },
  };
}

/** Hands `write` the request's access line once: when its response finishes, or when it closes unfinished. */
export function observeAccess(
  req: { method: string; path: string; headers: RequestHeaders; socket?: { bytesWritten: number } | null },
  res: { statusCode: number; headersSent: boolean; writableFinished: boolean; on(event: 'finish' | 'close', listener: () => void): unknown },
  requestId: unknown,
  write: (line: AccessLogLine) => void,
): void {
  const t0 = Date.now();
  // Requests on one keep-alive socket run in turn, so the delta is this response's bytes.
  const socketBytesAtStart = req.socket?.bytesWritten ?? 0;
  const emit = (aborted: boolean) => {
    const line = accessLogLine({
      method: req.method, path: req.path, status: res.statusCode, aborted, headersSent: res.headersSent,
      durMs: Date.now() - t0, requestId, headers: req.headers,
      ...(aborted ? { bytes: Math.max(0, (req.socket?.bytesWritten ?? 0) - socketBytesAtStart) } : {}),
    });
    if (line) write(line);
  };
  res.on('finish', () => emit(false));
  // A response the client or a tunnel dropped never finishes; log it rather than leave a gap.
  res.on('close', () => { if (!res.writableFinished) emit(true); });
}
