/**
 * The system beacon (DESIGN §3.2): how long the computer has had no keyboard
 * or mouse input (powerMonitor.getSystemIdleTime), sent to the backend every
 * minute as POST /api/companion/presence {systemIdleSeconds}, so the user
 * working in another app is not taken for away. The windows' own beacons say
 * what they show; this one says only that the user is at the computer.
 *
 * Nothing here imports `electron`: main injects the idle time, so it is
 * testable in Node.
 */
import * as http from 'node:http';

/** The backend's presence route (routes/companion.ts). */
export const SYSTEM_PRESENCE_PATH = '/api/companion/presence';
export const SYSTEM_PRESENCE_INTERVAL_MS = 60_000;
/** After a refusal (no Companion on this backend), ask this seldom. */
export const SYSTEM_PRESENCE_REFUSED_MS = 10 * 60_000;

export interface SystemPresenceOptions {
  /** Current backend port; null skips a beat. */
  port(): number | null;
  /** Seconds since the last input on the computer. */
  idleSeconds(): number;
  intervalMs?: number;
  refusedRetryMs?: number;
  /** Sends one beacon; resolves to the HTTP status, or 0 when it could not be sent (default: a loopback POST). */
  post?(port: number, body: string): Promise<number>;
  /** Runs `callback` after `delayMs`; the returned function cancels it (default: an unref'd setTimeout). */
  setTimer?(callback: () => void, delayMs: number): () => void;
}

function postBeacon(port: number, body: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: SYSTEM_PRESENCE_PATH,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 5_000,
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

function unrefTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class SystemPresenceReporter {
  private cancel: (() => void) | null = null;
  private running = false;

  constructor(private readonly options: SystemPresenceOptions) {}

  /** Sends a beacon now, then one a minute. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.beat();
  }

  stop(): void {
    this.running = false;
    this.cancel?.();
    this.cancel = null;
  }

  private async beat(): Promise<void> {
    if (!this.running) return;
    let next = this.options.intervalMs ?? SYSTEM_PRESENCE_INTERVAL_MS;
    const port = this.options.port();
    if (port) {
      let idle = 0;
      try {
        idle = Math.max(0, Math.floor(this.options.idleSeconds()));
      } catch {
        idle = 0;
      }
      const status = await (this.options.post ?? postBeacon)(port, JSON.stringify({ systemIdleSeconds: idle }));
      if (status === 403 || status === 404) next = this.options.refusedRetryMs ?? SYSTEM_PRESENCE_REFUSED_MS;
    }
    if (!this.running) return;
    this.cancel = (this.options.setTimer ?? unrefTimer)(() => {
      this.cancel = null;
      void this.beat();
    }, next);
  }
}
