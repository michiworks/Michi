import type { BackgroundTurn } from '../contract/host';

/**
 * Discards a self-started turn nobody can see, as BackgroundTurnConsumer
 * requires: stop it, so nothing it asks for waits on an answer, then drain
 * it, so the session's turn mutex is released. Never rejects.
 */
export async function discardBackgroundTurn(turn: Pick<BackgroundTurn, 'events' | 'cancel'>): Promise<void> {
  try { await turn.cancel?.(); } catch { /* draining still ends it */ }
  try {
    for await (const discarded of turn.events) void discarded;
  } catch { /* the turn is discarded either way */ }
}
