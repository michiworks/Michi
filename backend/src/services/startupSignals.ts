import os from 'node:os';
import { log } from './logger';

const STARTUP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * SIGINT and SIGTERM while the backend starts. Without a listener Node ends the
 * process at once: in the middle of a pre-migration snapshot, so the next start
 * copies the database again and a launcher that stops every slow start (on a
 * health timeout) never lets the migrations run; or after runtimes were
 * spawned, orphaning them.
 *
 * With these listeners a signal waits for the event loop. Startup runs
 * synchronously up to the point where server.ts installs its graceful
 * shutdown, so a signal that arrives during the snapshot is handled after the
 * snapshot and the migrations complete, by that graceful shutdown. A snapshot
 * therefore never stops halfway; its own cleanup removes the temporary copy
 * when it fails, and the next start removes one left by a SIGKILL. Should the
 * event loop run before the graceful shutdown is installed, the signal ends
 * the process here, with the status a shell reports for that signal
 * (128 + its number).
 *
 * Returns a function that removes these listeners. Call it only after adding
 * the graceful shutdown's: a signal still waiting then goes to them, while one
 * still waiting when its signal loses the last listener is dropped.
 */
export function installStartupSignalHandlers(): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    log.warn('boot', 'signal received while starting; exiting', { signal });
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  };
  for (const signal of STARTUP_SIGNALS) process.on(signal, onSignal);
  return () => {
    for (const signal of STARTUP_SIGNALS) process.off(signal, onSignal);
  };
}
