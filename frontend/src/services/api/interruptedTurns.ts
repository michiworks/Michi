import { parseInterruptedTurns, type InterruptedTurnV1 } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendFetch } from './backendRequest';

/** An interrupted turn as this window holds it: node and workspace ids are scoped to their backend. */
export interface InterruptedTurn extends InterruptedTurnV1 {
  backendConnectionId: string;
}

/** GET /interrupted-turns on one backend; backendFetch scopes the node and workspace ids. */
export async function fetchInterruptedTurns(connectionId: string, signal?: AbortSignal): Promise<InterruptedTurn[]> {
  const response = await backendFetch(`${backendApiBase(connectionId)}/interrupted-turns`, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Interrupted turns: HTTP ${response.status}`);
  return parseInterruptedTurns(await response.json()).items.map((item) => ({ ...item, backendConnectionId: connectionId }));
}

/** Stops listing the turn on its backend (turn ids are not scoped). */
export async function dismissInterruptedTurn(item: Pick<InterruptedTurn, 'backendConnectionId' | 'turnId'>): Promise<void> {
  const response = await backendFetch(
    `${backendApiBase(item.backendConnectionId)}/interrupted-turns/${encodeURIComponent(item.turnId)}/dismiss`,
    { method: 'POST' },
  );
  if (!response.ok && response.status !== 404) throw new Error(`Dismiss interrupted turn: HTTP ${response.status}`);
}
