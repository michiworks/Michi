import type { TurnErrorCode } from 'michi-shared';
import { mapMessageRow } from './chatHydration';
import type { ChatMessage } from './chatTypes';
import { interruptionCauseOfKind } from './turnInterruption';
import { getSavedTurn, type SavedTurn } from '../services/api';

type TurnErrorAction = 'inspect-existing-turn' | 'rerun-prompt' | 'resume-turn';

/**
 * Missing replay, unknown execution and persistence failure never authorize
 * execution again. A restart interruption is a known outcome: the backend
 * wrote the receipt itself, the partial output is checkpointed, and the turn
 * is carried on with a continuation prompt (turnInterruption.buildResumePrompt)
 * rather than re-sent. Exhaustive, so a new turn code must be classified here.
 */
const TURN_ERROR_ACTIONS: Record<TurnErrorCode, TurnErrorAction> = {
  turn_active: 'rerun-prompt',
  turn_begin_failed: 'rerun-prompt',
  turn_already_began: 'inspect-existing-turn',
  turn_persistence_failed: 'inspect-existing-turn',
  turn_replay_unavailable: 'inspect-existing-turn',
  backend_restarted: 'resume-turn',
  turn_outcome_unknown: 'inspect-existing-turn',
};

/** Kinds outside the turn protocol (runtime and diagnostic codes) keep Retry, but for expired credentials. */
export function turnErrorAction(errorKind?: string): TurnErrorAction {
  // A runtime's expired credentials are an interruption as well: resumed once the user signs in.
  if (interruptionCauseOfKind(errorKind)) return 'resume-turn';
  return errorKind && Object.hasOwn(TURN_ERROR_ACTIONS, errorKind)
    ? TURN_ERROR_ACTIONS[errorKind as TurnErrorCode]
    : 'rerun-prompt';
}

/** The result of a saved turn that finished: completed (not by error) or
 * cancelled, with its completion time and stored assistant row. Null otherwise. */
export function savedTurnResult(saved: SavedTurn): {
  assistant: ChatMessage;
  lastSeq: number;
  completedAt: number;
  stopReason: string;
} | null {
  const finished = saved.status === 'cancelled' || (saved.status === 'completed' && saved.stopReason !== 'error');
  if (!finished || saved.completedAt === null || saved.message?.role !== 'assistant'
    || saved.message.id !== saved.assistantId) return null;
  return {
    assistant: mapMessageRow(saved.message),
    lastSeq: saved.lastSeq,
    completedAt: saved.completedAt,
    stopReason: saved.status === 'cancelled' ? 'cancelled' : saved.stopReason ?? 'end_turn',
  };
}

/** A bounded, read-only check of the saved turn. A turn that has not finished
 * (or cannot be read) is not evidence that the prompt never ran. */
export function inspectOriginalTurn(options: {
  chatId: string;
  turnId: string;
  onResult: (result: { persisted: boolean; completedAt?: number; assistant?: ChatMessage; lastSeq?: number; stopReason?: string }) => void;
}): () => void {
  const controller = new AbortController();
  let finished = false;
  const stop = () => {
    finished = true;
    clearTimeout(deadline);
    controller.abort();
  };
  const finish = (result: Parameters<typeof options.onResult>[0]) => {
    if (finished) return;
    stop();
    options.onResult(result);
  };
  const deadline = setTimeout(() => finish({ persisted: false }), 10_000);
  void getSavedTurn(options.chatId, options.turnId, controller.signal).then((saved) => {
    const result = saved && savedTurnResult(saved);
    finish(result
      ? { persisted: true, completedAt: result.completedAt, assistant: result.assistant, lastSeq: result.lastSeq, stopReason: result.stopReason }
      : { persisted: false });
  });
  return stop;
}
