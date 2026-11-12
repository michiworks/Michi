import { turnLeftAnswer } from 'michi-shared';
import type { ChatMessage, ChatNodeState } from './chatTypes';
import { assistantPersistenceContent } from './assistantBlocks';
import { isServerAttentionActive } from '../services/serverAttentionStore';
import { backendConnectionIdForWorkspace } from '../config/backendConnections';

/**
 * Server completion facts (backend migration 0064, services/attention): how
 * many turns of a node completed with an answer, and how many of them a
 * focused window had on screen. A backend that sends them decides unread;
 * without them (an older backend, legacy local state) the renderer keeps its
 * own rule, the last reply against the last view.
 *
 * A window gets them from the hydration rows and from every `done` frame,
 * which carries the counts the server committed with that turn. A node this
 * window created before it knew that its backend keeps facts (the capability
 * probe and the first rows arrive asynchronously; a new remote has no rows)
 * starts without them and adopts them from its first `done`. Migration 0064
 * starts every existing node at none completed and none seen, so a reply
 * from before it reads as read; it did after a reload before the migration
 * too, since hydration never restored `lastAssistantAt`.
 */
type CompletionFields = Pick<ChatNodeState, 'completionSeq' | 'seenCompletionSeq' | 'lastCompletedAt' | 'lastCompletedTurnId'>;

const factsBackends = new Set<string>();

/** This connection's backend keeps completion facts: its hydration rows carried them. */
export function noteCompletionFactsBackend(connectionId: string): void {
  factsBackends.add(connectionId);
}

/** Its rows carried facts, or it decides attention (capability or feed snapshot): the two ship together. */
function keepsCompletionFacts(connectionId: string): boolean {
  return factsBackends.has(connectionId) || isServerAttentionActive(connectionId);
}

/**
 * The facts of a node this window creates: on a backend that keeps them it
 * starts with none completed and none seen, exactly as its new row does, so
 * this window counts and marks its completions from the first turn. (Left
 * without facts, its completions would never be marked seen and would read
 * as unread after a reload; its first `done` brings them, see above.)
 */
export function initialCompletionFacts(projectId: string): CompletionFields {
  const connectionId = backendConnectionIdForWorkspace(projectId);
  return keepsCompletionFacts(connectionId) ? { completionSeq: 0, seenCompletionSeq: 0 } : {};
}

/** True while the node has a completion the user has not seen. */
export function hasUnseenCompletion(
  node: Pick<ChatNodeState, 'completionSeq' | 'seenCompletionSeq' | 'lastAssistantAt' | 'viewedAt'>,
): boolean {
  if (node.completionSeq !== undefined) return node.completionSeq > (node.seenCompletionSeq ?? 0);
  return (node.lastAssistantAt ?? 0) > (node.viewedAt ?? 0);
}

/**
 * Herdr's rule for recording a completion as seen: this window is focused and
 * visible. Absent a document (tests, workers) nothing is seen.
 */
export function isWindowAttentive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** The reply left something to read, by the rule the server counts with (shared turnLeftAnswer). */
function leftAnswer(message: ChatMessage): boolean {
  return turnLeftAnswer(assistantPersistenceContent(message), message.blocks ?? []);
}

/** What a `done` action says about the completion (chatTypes `done`). */
export interface DoneCompletion {
  assistantId: string;
  /** The turn that ended. Without it only a reply still streaming here counts. */
  turnId?: string;
  aborted?: boolean;
  completedAt?: number;
  /** The counts the server committed with the turn, on the `done` frame of a backend that keeps them. */
  completion?: { completionSeq: number; seenCompletionSeq: number };
}

/**
 * The facts once this window applies a turn's `done`.
 *
 * With the server's counts on the frame the window takes them: exact, and the
 * same however often the frame is replayed; a node without facts adopts them.
 * Both counts only grow. Without them (a backend that predates them on the
 * frame, or a turn finished from its saved receipt) a node with facts counts
 * the completion itself, once per turn, whether or not the reply was still
 * streaming here: one that streamed its three follow-ups stopped streaming
 * before `done`, and an observed turn may start on a message this window
 * already had. With no turn named, only a reply still streaming here counts,
 * so a replayed `done` for a finished message does not count twice.
 */
export function completionAfterDone(node: ChatNodeState, done: DoneCompletion): CompletionFields {
  const completedAt = done.completedAt ?? Date.now();
  if (done.completion) {
    const completionSeq = Math.max(node.completionSeq ?? 0, done.completion.completionSeq);
    const seenCompletionSeq = Math.min(completionSeq, Math.max(node.seenCompletionSeq ?? 0, done.completion.seenCompletionSeq));
    const counted = completionSeq > (node.completionSeq ?? 0);
    return {
      completionSeq,
      seenCompletionSeq,
      ...(counted ? { lastCompletedAt: completedAt } : {}),
      ...(counted && done.turnId ? { lastCompletedTurnId: done.turnId } : {}),
    };
  }
  if (node.completionSeq === undefined || done.aborted) return {};
  const message = node.messages.find((candidate) => candidate.id === done.assistantId);
  if (!message || message.role !== 'assistant' || !leftAnswer(message)) return {};
  if (done.turnId !== undefined ? node.lastCompletedTurnId === done.turnId : message.streaming !== true) return {};
  return {
    completionSeq: node.completionSeq + 1,
    lastCompletedAt: completedAt,
    ...(done.turnId ? { lastCompletedTurnId: done.turnId } : {}),
  };
}

/** Every completion of the node counts as seen; nothing changes without facts or news. */
export function seenAllCompletions(node: ChatNodeState): CompletionFields {
  if (node.completionSeq === undefined || node.completionSeq <= (node.seenCompletionSeq ?? 0)) return {};
  return { seenCompletionSeq: node.completionSeq };
}

/** A server snapshot of a node this window may already be ahead of: both counts only grow. */
export function mergeCompletionFacts(server: ChatNodeState, local: ChatNodeState | undefined): CompletionFields {
  if (server.completionSeq === undefined && local?.completionSeq === undefined) return {};
  const latest = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
  // The turn counted last is the one of the side that counted more.
  const lastCompletedTurnId = (local?.completionSeq ?? -1) > (server.completionSeq ?? -1)
    ? local?.lastCompletedTurnId
    : server.lastCompletedTurnId ?? local?.lastCompletedTurnId;
  return {
    completionSeq: latest(server.completionSeq, local?.completionSeq),
    seenCompletionSeq: latest(server.seenCompletionSeq, local?.seenCompletionSeq),
    lastCompletedAt: latest(server.lastCompletedAt, local?.lastCompletedAt),
    ...(lastCompletedTurnId !== undefined ? { lastCompletedTurnId } : {}),
  };
}
