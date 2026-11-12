/**
 * Terminals a Michi backend runs (backend/src/services/terminalHost.ts), for
 * windows without Electron's local PTY: phones, browsers and remote
 * workspaces. Several windows can attach to one terminal at once.
 *
 * Output is numbered by `seq`, the count of UTF-16 code units the terminal
 * has written since it started. A client that reconnects with the last seq it
 * saw receives only what it missed, or a `reset` when that output is no
 * longer in the backend's replay buffer.
 */

export const TERMINAL_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

/** Why this backend runs no terminals for the caller. */
export type TerminalUnavailableReason =
  /** A phone, and Settings › Phone access › Terminal is off on that machine. */
  | 'phone-off'
  /** A multi-user or signed-in deployment. */
  | 'hosted'
  /** node-pty could not be loaded on that machine. */
  | 'unsupported';

export const TERMINAL_ERROR_CODES = {
  'phone-off': 'terminal_phone_off',
  hosted: 'terminal_hosted',
  unsupported: 'terminal_unsupported',
  notFound: 'terminal_not_found',
  limit: 'terminal_limit',
} as const;

/** Other windows attached to a terminal, by the way they reached it. */
export interface TerminalPeers {
  phone: number;
  desktop: number;
}

export interface TerminalSummary {
  terminalId: string;
  /** Names this run of the backend's terminal; seq values of another instance do not apply. */
  instance: string;
  cwd: string;
  createdAt: number;
  /** Last output or input. */
  lastActiveAt: number;
  exited: boolean;
  exitCode?: number;
  cols: number;
  rows: number;
  /** Every attached window. */
  clients: TerminalPeers;
}

/** GET /terminals. A phone with Terminal off gets available: false, not an error. */
export interface TerminalListResponse {
  available: boolean;
  reason?: TerminalUnavailableReason;
  message?: string;
  terminals: TerminalSummary[];
}

/** POST /terminals. An existing terminal with this id is returned as it is. */
export interface TerminalCreateRequest {
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
  clientId: string;
}

/** POST /terminals/:id/input */
export interface TerminalInputRequest {
  clientId: string;
  data: string;
}

/** POST /terminals/:id/resize. The size of the window that typed last wins. */
export interface TerminalResizeRequest {
  clientId: string;
  cols: number;
  rows: number;
}

/** Largest input one request may carry; clients split longer pastes. */
export const TERMINAL_MAX_INPUT_CHARS = 16 * 1024;

/**
 * GET /terminals/:id/stream?after=<seq>&instance=<instance>&clientId=<id>
 * (SSE; the event name is the type, the data is this JSON). after=-1, or an
 * instance other than the terminal's, asks for the whole buffer.
 */
export type TerminalStreamEvent =
  /** Clear the screen, then write `data`: the whole replay buffer. */
  | { type: 'reset'; seq: number; instance: string; data: string; exited: boolean; exitCode?: number }
  | { type: 'data'; seq: number; data: string }
  | { type: 'exit'; seq: number; exitCode: number }
  /** Restarted after an exit: a new shell writes on from `seq`. */
  | { type: 'restart'; seq: number }
  /** Other attached windows; this subscriber is not counted. */
  | { type: 'peers'; phone: number; desktop: number }
  /** The terminal was closed, or this phone's access was turned off. */
  | { type: 'closed'; reason?: 'closed' | 'phone-off' };

export type TerminalStreamEventType = TerminalStreamEvent['type'];

export function parseTerminalStreamEvent(event: string, data: string): TerminalStreamEvent | null {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const seq = typeof body.seq === 'number' && Number.isFinite(body.seq) ? body.seq : null;
  switch (event) {
    case 'reset':
      return seq !== null && typeof body.data === 'string' && typeof body.instance === 'string'
        ? { type: 'reset', seq, instance: body.instance, data: body.data, exited: body.exited === true, ...(typeof body.exitCode === 'number' ? { exitCode: body.exitCode } : {}) }
        : null;
    case 'data':
      return seq !== null && typeof body.data === 'string' ? { type: 'data', seq, data: body.data } : null;
    case 'exit':
      return seq !== null && typeof body.exitCode === 'number' ? { type: 'exit', seq, exitCode: body.exitCode } : null;
    case 'restart':
      return seq !== null ? { type: 'restart', seq } : null;
    case 'peers':
      return typeof body.phone === 'number' && typeof body.desktop === 'number'
        ? { type: 'peers', phone: body.phone, desktop: body.desktop } : null;
    case 'closed':
      return { type: 'closed', ...(body.reason === 'phone-off' || body.reason === 'closed' ? { reason: body.reason } : {}) };
    default:
      return null;
  }
}
