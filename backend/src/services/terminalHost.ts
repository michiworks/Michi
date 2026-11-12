import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TERMINAL_ERROR_CODES,
  TERMINAL_ID_PATTERN,
  TERMINAL_MAX_INPUT_CHARS,
  type TerminalPeers,
  type TerminalStreamEvent,
  type TerminalSummary,
} from 'michi-shared';

/** The part of node-pty's IPty this host uses. */
export interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (file: string, args: string[], options: {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}) => PtyProcess;

/** node-pty is optional: a machine that could not build it runs no terminals. */
export function loadNodePty(): { spawn: SpawnPty } | { error: string } {
  try {
    // A runtime require keeps the native module out of the esbuild bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require('node-pty') as { spawn: SpawnPty };
    return { spawn: (file, args, options) => pty.spawn(file, args, options) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export class TerminalError extends Error {
  constructor(readonly code: (typeof TERMINAL_ERROR_CODES)[keyof typeof TERMINAL_ERROR_CODES], readonly status: number, message: string) {
    super(message);
  }
}

/** One attached window's stream. `send` returns false once the stream is gone. */
export interface TerminalSubscriber {
  clientId: string;
  phone: boolean;
  send(event: TerminalStreamEvent): boolean;
  close(): void;
}

interface Subscription extends TerminalSubscriber {
  /** The last seq this subscriber was sent. */
  seq: number;
}

interface Terminal {
  id: string;
  instance: string;
  cwd: string;
  createdAt: number;
  lastActiveAt: number;
  process: PtyProcess | null;
  exited: boolean;
  exitCode?: number;
  cols: number;
  rows: number;
  /** The newest output, at most replayChars long; it ends at `total`. */
  replay: string;
  total: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<Subscription>;
  sizes: Map<string, { cols: number; rows: number }>;
  /** The window that typed last: its size is the terminal's. */
  activeClient?: string;
  unattachedSince: number | null;
}

export interface TerminalHostOptions {
  /** null: node-pty is unavailable, for `unsupportedReason`. */
  spawn: SpawnPty | null;
  unsupportedReason?: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  maxTerminals?: number;
  replayChars?: number;
  /** A live terminal no window has attached to for this long is closed. */
  idleMs?: number;
  /** An exited terminal no window shows is removed after this long. */
  exitedIdleMs?: number;
  flushMs?: number;
  sweepMs?: number;
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

/** The backend's own secrets stay out of the shells it starts. */
const SECRET_ENV = /^MICHI_.*(?:TOKEN|SECRET|PASSWORD|_KEY)$|^BETTER_AUTH_SECRET$/;

export function terminalEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || SECRET_ENV.test(key)) continue;
    // A backend Electron forks runs as Node; programs started in the shell must not.
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    result[key] = value;
  }
  return { ...result, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

function defaultShell(env: NodeJS.ProcessEnv): string {
  if (env.SHELL && path.isAbsolute(env.SHELL)) return env.SHELL;
  if (process.platform === 'win32') return 'powershell.exe';
  return fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
}

function usableCwd(cwd: unknown): string {
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    try { if (fs.statSync(cwd).isDirectory()) return cwd; } catch { /* fall back */ }
  }
  return os.homedir();
}

/**
 * The PTYs this backend runs. A terminal outlives the windows showing it: it
 * ends when its shell exits and the last window closes it, or after idleMs
 * with no window attached.
 */
export class TerminalHost {
  private readonly terminals = new Map<string, Terminal>();
  private readonly now: () => number;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly maxTerminals: number;
  private readonly replayChars: number;
  private readonly idleMs: number;
  private readonly exitedIdleMs: number;
  private readonly flushMs: number;

  constructor(private readonly options: TerminalHostOptions) {
    this.now = options.now ?? Date.now;
    this.maxTerminals = options.maxTerminals ?? 16;
    this.replayChars = options.replayChars ?? 1024 * 1024;
    this.idleMs = options.idleMs ?? 24 * 60 * 60_000;
    this.exitedIdleMs = options.exitedIdleMs ?? 10 * 60_000;
    this.flushMs = options.flushMs ?? 8;
    this.sweeper = setInterval(() => this.sweep(), options.sweepMs ?? 60_000);
    this.sweeper.unref?.();
  }

  get supported(): boolean { return this.options.spawn !== null; }
  get unsupportedReason(): string { return this.options.unsupportedReason ?? 'Terminals are unavailable on this machine.'; }

  list(): TerminalSummary[] {
    return [...this.terminals.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(t => this.summary(t));
  }

  get(terminalId: string): TerminalSummary | null {
    const terminal = this.terminals.get(terminalId);
    return terminal ? this.summary(terminal) : null;
  }

  create(request: { terminalId: unknown; cwd: unknown; cols: unknown; rows: unknown; clientId: string }): TerminalSummary {
    const id = request.terminalId;
    if (typeof id !== 'string' || !TERMINAL_ID_PATTERN.test(id)) throw new TerminalError(TERMINAL_ERROR_CODES.notFound, 400, 'Invalid terminal id');
    const existing = this.terminals.get(id);
    if (existing) return this.summary(existing);
    if (!this.options.spawn) throw new TerminalError(TERMINAL_ERROR_CODES.unsupported, 503, this.unsupportedReason);
    if ([...this.terminals.values()].filter(t => !t.exited).length >= this.maxTerminals) {
      throw new TerminalError(TERMINAL_ERROR_CODES.limit, 429, `This machine already runs ${this.maxTerminals} terminals. Close one to open another.`);
    }
    const now = this.now();
    const terminal: Terminal = {
      id,
      instance: randomBytes(8).toString('hex'),
      cwd: usableCwd(request.cwd),
      createdAt: now,
      lastActiveAt: now,
      process: null,
      exited: false,
      cols: clampInt(request.cols, 2, 500, 80),
      rows: clampInt(request.rows, 1, 300, 24),
      replay: '',
      total: 0,
      flushTimer: null,
      subscribers: new Set(),
      sizes: new Map(),
      unattachedSince: now,
    };
    terminal.sizes.set(request.clientId, { cols: terminal.cols, rows: terminal.rows });
    terminal.activeClient = request.clientId;
    this.spawn(terminal);
    this.terminals.set(id, terminal);
    return this.summary(terminal);
  }

  /** Streams output after `after` (the last seq of `instance` the window saw), then live output. */
  attach(terminalId: string, subscriber: TerminalSubscriber, after: number, instance?: string): () => void {
    const terminal = this.require(terminalId);
    const subscription: Subscription = Object.assign(subscriber, {
      seq: instance === terminal.instance && Number.isInteger(after) && after >= 0 && after <= terminal.total ? after : -1,
    });
    terminal.subscribers.add(subscription);
    terminal.unattachedSince = null;
    // A reset carries the exit state; output after a known seq does not.
    const reset = subscription.seq < terminal.total - terminal.replay.length;
    this.catchUp(terminal, subscription, true);
    if (terminal.exited && !reset) subscription.send({ type: 'exit', seq: terminal.total, exitCode: terminal.exitCode ?? 0 });
    this.announcePeers(terminal);
    return () => {
      if (!terminal.subscribers.delete(subscription)) return;
      if (terminal.subscribers.size === 0) terminal.unattachedSince = this.now();
      this.announcePeers(terminal);
    };
  }

  write(terminalId: string, clientId: string, data: unknown): void {
    const terminal = this.require(terminalId);
    if (typeof data !== 'string' || data.length > TERMINAL_MAX_INPUT_CHARS) {
      throw new TerminalError(TERMINAL_ERROR_CODES.limit, 413, 'Terminal input is too long');
    }
    if (!terminal.process || terminal.exited || !data) return;
    terminal.activeClient = clientId;
    const size = terminal.sizes.get(clientId);
    if (size) this.applySize(terminal, size.cols, size.rows);
    terminal.lastActiveAt = this.now();
    terminal.process.write(data);
  }

  resize(terminalId: string, clientId: string, cols: unknown, rows: unknown): void {
    const terminal = this.require(terminalId);
    const size = { cols: clampInt(cols, 2, 500, terminal.cols), rows: clampInt(rows, 1, 300, terminal.rows) };
    terminal.sizes.set(clientId, size);
    const active = terminal.activeClient;
    const activeAttached = active !== undefined && [...terminal.subscribers].some(s => s.clientId === active);
    if (active === clientId || !activeAttached) {
      terminal.activeClient = clientId;
      this.applySize(terminal, size.cols, size.rows);
    }
  }

  /** Starts a new shell in an exited terminal, for every window showing it. */
  restart(terminalId: string, clientId: string): TerminalSummary {
    const terminal = this.require(terminalId);
    if (!terminal.exited) return this.summary(terminal);
    if (!this.options.spawn) throw new TerminalError(TERMINAL_ERROR_CODES.unsupported, 503, this.unsupportedReason);
    terminal.exited = false;
    delete terminal.exitCode;
    terminal.activeClient = clientId;
    const size = terminal.sizes.get(clientId);
    if (size) { terminal.cols = size.cols; terminal.rows = size.rows; }
    this.spawn(terminal);
    for (const subscription of terminal.subscribers) subscription.send({ type: 'restart', seq: terminal.total });
    return this.summary(terminal);
  }

  /**
   * A window closed its pane. The terminal ends only when no other window
   * shows it; otherwise this window just detaches.
   */
  close(terminalId: string, clientId: string): { closed: boolean } {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return { closed: true };
    for (const subscription of [...terminal.subscribers]) {
      if (subscription.clientId !== clientId) continue;
      terminal.subscribers.delete(subscription);
      subscription.close();
    }
    terminal.sizes.delete(clientId);
    if (terminal.subscribers.size > 0) {
      this.announcePeers(terminal);
      return { closed: false };
    }
    this.destroy(terminal, 'closed');
    return { closed: true };
  }

  /** Phone access to terminals was turned off: end every phone's stream. */
  disconnectPhones(): void {
    for (const terminal of this.terminals.values()) {
      let changed = false;
      for (const subscription of [...terminal.subscribers]) {
        if (!subscription.phone) continue;
        terminal.subscribers.delete(subscription);
        subscription.send({ type: 'closed', reason: 'phone-off' });
        subscription.close();
        changed = true;
      }
      if (!changed) continue;
      if (terminal.subscribers.size === 0) terminal.unattachedSince = this.now();
      this.announcePeers(terminal);
    }
  }

  sweep(): void {
    const now = this.now();
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.subscribers.size > 0) { terminal.unattachedSince = null; continue; }
      const since = terminal.unattachedSince ??= now;
      const idleFor = now - Math.max(since, terminal.lastActiveAt);
      if (terminal.exited ? now - since >= this.exitedIdleMs : idleFor >= this.idleMs) this.destroy(terminal, 'closed');
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const terminal of [...this.terminals.values()]) this.destroy(terminal, 'closed');
  }

  private require(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new TerminalError(TERMINAL_ERROR_CODES.notFound, 404, 'This terminal is no longer running');
    return terminal;
  }

  private spawn(terminal: Terminal): void {
    const env = this.options.env ?? process.env;
    const child = this.options.spawn!(this.options.shell ?? defaultShell(env), process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color',
      cols: terminal.cols,
      rows: terminal.rows,
      cwd: terminal.cwd,
      env: terminalEnvironment(env),
    });
    terminal.process = child;
    child.onData((data) => {
      if (terminal.process !== child || !data) return;
      terminal.replay += data;
      if (terminal.replay.length > this.replayChars) terminal.replay = terminal.replay.slice(-this.replayChars);
      terminal.total += data.length;
      terminal.lastActiveAt = this.now();
      if (terminal.flushTimer) return;
      terminal.flushTimer = setTimeout(() => this.flush(terminal), this.flushMs);
    });
    child.onExit(({ exitCode }) => {
      if (terminal.process !== child) return;
      this.flush(terminal);
      terminal.process = null;
      terminal.exited = true;
      terminal.exitCode = exitCode;
      terminal.lastActiveAt = this.now();
      for (const subscription of terminal.subscribers) subscription.send({ type: 'exit', seq: terminal.total, exitCode });
    });
  }

  private flush(terminal: Terminal): void {
    if (terminal.flushTimer) { clearTimeout(terminal.flushTimer); terminal.flushTimer = null; }
    for (const subscription of terminal.subscribers) this.catchUp(terminal, subscription, false);
  }

  private catchUp(terminal: Terminal, subscription: Subscription, attaching: boolean): void {
    if (subscription.seq === terminal.total && !attaching) return;
    const start = terminal.total - terminal.replay.length;
    const ok = subscription.seq < start || subscription.seq < 0
      ? subscription.send({
        type: 'reset', seq: terminal.total, instance: terminal.instance, data: terminal.replay,
        exited: terminal.exited, ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      })
      : subscription.seq < terminal.total
        ? subscription.send({ type: 'data', seq: terminal.total, data: terminal.replay.slice(subscription.seq - start) })
        : true;
    if (ok) subscription.seq = terminal.total;
    else terminal.subscribers.delete(subscription);
  }

  private applySize(terminal: Terminal, cols: number, rows: number): void {
    if (terminal.cols === cols && terminal.rows === rows) return;
    terminal.cols = cols; terminal.rows = rows;
    try { terminal.process?.resize(cols, rows); } catch { /* the shell exited */ }
  }

  private announcePeers(terminal: Terminal): void {
    for (const subscription of terminal.subscribers) {
      const others = this.peers(terminal, subscription.clientId);
      subscription.send({ type: 'peers', ...others });
    }
  }

  private peers(terminal: Terminal, except?: string): TerminalPeers {
    const phone = new Set<string>();
    const desktop = new Set<string>();
    for (const s of terminal.subscribers) if (s.clientId !== except) (s.phone ? phone : desktop).add(s.clientId);
    return { phone: phone.size, desktop: desktop.size };
  }

  private destroy(terminal: Terminal, reason: 'closed'): void {
    this.terminals.delete(terminal.id);
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
    const child = terminal.process;
    terminal.process = null;
    try { child?.kill(); } catch { /* already exited */ }
    const subscriptions = [...terminal.subscribers];
    terminal.subscribers.clear();
    for (const subscription of subscriptions) {
      subscription.send({ type: 'closed', reason });
      subscription.close();
    }
  }

  private summary(terminal: Terminal): TerminalSummary {
    return {
      terminalId: terminal.id,
      instance: terminal.instance,
      cwd: terminal.cwd,
      createdAt: terminal.createdAt,
      lastActiveAt: terminal.lastActiveAt,
      exited: terminal.exited,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      cols: terminal.cols,
      rows: terminal.rows,
      clients: this.peers(terminal),
    };
  }
}
