import {
  parseTerminalStreamEvent,
  TERMINAL_ERROR_CODES,
  TERMINAL_MAX_INPUT_CHARS,
  type TerminalCreateRequest,
  type TerminalListResponse,
  type TerminalStreamEvent,
  type TerminalSummary,
} from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendFetch } from './backendRequest';
import { readSseStream } from './sseParser';
import { fetchStream } from './streamTransport';

/**
 * Terminals a Michi backend runs (backend/src/routes/terminals.ts). Requests
 * use the browser's default (same-origin) credentials, as mobileAccess.ts
 * explains: the loopback API refuses credentialed cross-origin requests.
 */

export class TerminalApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
}

const terminalsUrl = (connectionId: string) => `${backendApiBase(connectionId)}/terminals`;
const terminalUrl = (connectionId: string, terminalId: string) => `${terminalsUrl(connectionId)}/${encodeURIComponent(terminalId)}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function failure(response: Response): Promise<TerminalApiError> {
  const body = await response.json().catch(() => ({})) as { code?: unknown; error?: unknown };
  return new TerminalApiError(response.status, typeof body.code === 'string' ? body.code : undefined,
    typeof body.error === 'string' ? body.error : `Terminal request failed (${response.status})`);
}

/** An older backend has no terminal routes. */
const OUTDATED: TerminalListResponse = {
  available: false, reason: 'unsupported', terminals: [],
  message: 'Update Michi on this machine to use its terminals here.',
};

export async function listTerminals(connectionId: string, signal?: AbortSignal): Promise<TerminalListResponse> {
  const response = await backendFetch(terminalsUrl(connectionId), { signal });
  if (response.status === 404) return OUTDATED;
  if (!response.ok) throw await failure(response);
  return await response.json() as TerminalListResponse;
}

export async function createTerminal(connectionId: string, request: TerminalCreateRequest): Promise<TerminalSummary> {
  const response = await backendFetch(terminalsUrl(connectionId), {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(request),
  });
  if (response.status === 404) throw new TerminalApiError(404, TERMINAL_ERROR_CODES.unsupported, OUTDATED.message!);
  if (!response.ok) throw await failure(response);
  return await response.json() as TerminalSummary;
}

export async function restartTerminal(connectionId: string, terminalId: string, clientId: string): Promise<TerminalSummary> {
  const response = await backendFetch(`${terminalUrl(connectionId, terminalId)}/restart`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ clientId }),
  });
  if (!response.ok) throw await failure(response);
  return await response.json() as TerminalSummary;
}

/** Closing a pane: the terminal ends unless another window still shows it. */
export async function closeTerminal(connectionId: string, terminalId: string, clientId: string): Promise<void> {
  const response = await backendFetch(`${terminalUrl(connectionId, terminalId)}?clientId=${encodeURIComponent(clientId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) throw await failure(response);
}

export type TerminalLinkStatus = 'connecting' | 'open' | 'reconnecting';

export interface TerminalLinkHandlers {
  onEvent(event: TerminalStreamEvent): void;
  onStatus(status: TerminalLinkStatus): void;
  /** The stream will not resume: the terminal closed, or this phone lost access. */
  onEnd(error: TerminalApiError): void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;
/** The backend sends a keepalive every 15s. */
const STALL_MS = 45_000;
const RESIZE_DEBOUNCE_MS = 80;

const ENDING_CODES: ReadonlySet<string> = new Set([
  TERMINAL_ERROR_CODES['phone-off'], TERMINAL_ERROR_CODES.hosted, TERMINAL_ERROR_CODES.unsupported, TERMINAL_ERROR_CODES.notFound,
]);
const ends = (error: TerminalApiError) => error.status === 400 || error.status === 403 || (error.code !== undefined && ENDING_CODES.has(error.code));

/**
 * One window's live connection to a terminal. Output resumes from the last
 * seq after a dropped connection. Input is sent in order, one request at a
 * time; input whose delivery is uncertain is dropped, never sent twice (a
 * repeated Enter could run a command again).
 */
export class TerminalLink {
  private seq = -1;
  private instance: string | undefined;
  private stopped = false;
  private open = false;
  private attempt = 0;
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private queue = '';
  private sending = false;
  private size: { cols: number; rows: number } | null = null;

  constructor(
    private readonly connectionId: string,
    private readonly terminalId: string,
    private readonly clientId: string,
    private readonly handlers: TerminalLinkHandlers,
  ) {}

  start(): void {
    if (this.stopped || this.abort) return;
    void this.connect();
  }

  get connected(): boolean { return this.open; }

  write(data: string): void {
    if (!this.open || this.stopped || !data) return;
    this.queue += data;
    void this.pump();
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { this.resizeTimer = null; this.sendSize(); }, RESIZE_DEBOUNCE_MS);
  }

  dispose(): void {
    this.stopped = true;
    this.open = false;
    this.abort?.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.queue = '';
  }

  private async connect(): Promise<void> {
    this.handlers.onStatus(this.seq < 0 ? 'connecting' : 'reconnecting');
    const controller = new AbortController();
    this.abort = controller;
    let closed: TerminalApiError | null = null;
    let stall: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), STALL_MS);
    };
    try {
      const query = new URLSearchParams({ after: String(this.seq), clientId: this.clientId });
      if (this.instance) query.set('instance', this.instance);
      const response = await fetchStream(`${terminalUrl(this.connectionId, this.terminalId)}/stream?${query}`, { signal: controller.signal });
      if (!response.ok) {
        const error = await failure(response);
        if (ends(error) || response.status === 404) closed = error;
        else throw error;
      } else if (response.body) {
        this.open = true;
        this.attempt = 0;
        this.handlers.onStatus('open');
        this.sendSize();
        arm();
        await readSseStream(response.body.getReader(), (name, data) => {
          const event = parseTerminalStreamEvent(name, data);
          if (!event || this.stopped) return;
          if ('seq' in event) this.seq = event.seq;
          if (event.type === 'reset') this.instance = event.instance;
          if (event.type === 'closed') {
            closed = event.reason === 'phone-off'
              ? new TerminalApiError(403, TERMINAL_ERROR_CODES['phone-off'], 'Terminals were turned off for phones on this machine.')
              : new TerminalApiError(404, TERMINAL_ERROR_CODES.notFound, 'This terminal was closed.');
          }
          this.handlers.onEvent(event);
        }, { onRead: arm, shouldStop: () => this.stopped });
      }
    } catch {
      // A dropped connection: reconnect from the last seq below.
    } finally {
      if (stall) clearTimeout(stall);
      this.open = false;
      this.queue = '';
      if (this.abort === controller) this.abort = null;
    }
    if (this.stopped) return;
    if (closed) { this.stopped = true; this.handlers.onEnd(closed); return; }
    this.handlers.onStatus('reconnecting');
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (!this.stopped) void this.connect(); }, delay);
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue && this.open && !this.stopped) {
        let end = Math.min(this.queue.length, TERMINAL_MAX_INPUT_CHARS);
        // Never split a surrogate pair across two requests.
        if (end < this.queue.length && /[\uD800-\uDBFF]/.test(this.queue[end - 1])) end--;
        const data = this.queue.slice(0, end);
        this.queue = this.queue.slice(end);
        const response = await fetchStream(`${terminalUrl(this.connectionId, this.terminalId)}/input`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ clientId: this.clientId, data }),
        });
        if (!response.ok) {
          this.queue = '';
          const error = await failure(response);
          if (ends(error)) { this.abort?.abort(); }
          break;
        }
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      this.queue = '';
    } finally {
      this.sending = false;
    }
  }

  private sendSize(): void {
    if (!this.size || !this.open || this.stopped) return;
    void fetchStream(`${terminalUrl(this.connectionId, this.terminalId)}/resize`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ clientId: this.clientId, ...this.size }),
    }).then((response) => response.body?.cancel()).catch(() => {});
  }
}
