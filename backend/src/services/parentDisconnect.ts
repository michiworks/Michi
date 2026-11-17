type ParentLink = Pick<NodeJS.Process, 'send' | 'connected' | 'once'>;

/**
 * Runs `shutdown` when the process that forked the backend with an IPC
 * channel goes away: the desktop app (electron/main.ts forkBackend). A crash
 * or force-quit of the app sends no SIGTERM, only closes the channel, and
 * without this the old backend kept its port and data.db while the next
 * launch forked a second backend on another port beside it. A backend
 * started without IPC (a shell, launchd's background service, the dev
 * watcher) has no parent to follow.
 *
 * `shuttingDown` is read when the channel closes. On a normal quit the app
 * sends SIGTERM and the channel closes as the app exits; a second shutdown
 * then would end the first one before it closed the database.
 */
export function shutdownWhenParentDisconnects(
  shutdown: () => void,
  shuttingDown: () => boolean,
  proc: ParentLink = process,
): void {
  if (typeof proc.send !== 'function') return;
  // A channel that closed before this ran has already emitted its event.
  if (!proc.connected) {
    shutdown();
    return;
  }
  proc.once('disconnect', () => {
    if (!shuttingDown()) shutdown();
  });
}
