import type { ChatNodeState } from '../../state/chatTypes';
import { turnErrorAction } from '../../state/turnErrorRecovery';
import type { InterruptedTurn } from '../../services/api/interruptedTurns';

/** One reminder per backend turn. */
export function interruptedTurnKey(item: Pick<InterruptedTurn, 'backendConnectionId' | 'turnId'>): string {
  return `${item.backendConnectionId}:${item.turnId}`;
}

/**
 * Where a listed turn stands in this window's store. `ready`: the node shows
 * this turn's interruption, so Resume can carry it on. `moved-on`: it runs
 * again or failed in a newer turn. `unknown`: not loaded (yet), or loaded
 * without its receipt.
 */
export function interruptedTurnState(
  node: Pick<ChatNodeState, 'status' | 'errorKind' | 'errorTurnId'> | undefined,
  turnId: string,
): 'ready' | 'moved-on' | 'unknown' {
  if (!node) return 'unknown';
  if (node.status === 'streaming') return 'moved-on';
  if (node.status !== 'error') return 'unknown';
  if (node.errorTurnId && node.errorTurnId !== turnId) return 'moved-on';
  return turnErrorAction(node.errorKind) === 'resume-turn' ? 'ready' : 'unknown';
}

/** A running or failed node's outcome, as the bar reads it. */
export type TurnOutcome = Pick<ChatNodeState, 'status' | 'errorKind' | 'errorTurnId'>;

/**
 * Every running or failed node's outcome. A change means a turn started,
 * ended or failed somewhere, so the backend's list may have changed too.
 * Reads structural fields only (status, and the error fields only an
 * `error` action, which moves the structure version, writes).
 */
export function selectTurnOutcomes(nodes: Record<string, ChatNodeState>): Record<string, TurnOutcome> {
  const outcomes: Record<string, TurnOutcome> = {};
  for (const id in nodes) {
    const { status, errorKind, errorTurnId } = nodes[id];
    if (status === 'streaming' || status === 'error') outcomes[id] = { status, errorKind, errorTurnId };
  }
  return outcomes;
}

export function turnOutcomesEqual(a: Record<string, TurnOutcome>, b: Record<string, TurnOutcome>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const x = a[key];
    const y = b[key];
    return !!y && x.status === y.status && x.errorKind === y.errorKind && x.errorTurnId === y.errorTurnId;
  });
}
