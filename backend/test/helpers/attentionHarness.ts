import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type DurableMessageMetadata } from 'michi-shared';
import { getDb } from '../../src/services/db';
import { beginTurn, finalizeTurn } from '../../src/services/dbRepository';
import type { AttentionFeed } from '../../src/services/attention/attentionFeed';
import type { AttentionClock } from '../../src/services/attention/attentionService';

// Shared by the attention tests that drive the service with turn events on a
// manual clock (attentionStructure, attentionWakeChains, attentionRoutes).

interface Timer { at: number; fn: () => void; every?: number }

export function manualClock(start = 1_000_000): AttentionClock & { advance(ms: number): void } {
  let now = start;
  let next = 0;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++next, { at: now + ms, fn }); return next; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    setInterval: (fn, ms) => { timers.set(++next, { at: now + ms, fn, every: ms }); return next; },
    clearInterval: (handle) => { timers.delete(handle as number); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every) timer.at += timer.every; else timers.delete(id);
        timer.fn();
      }
      now = target;
    },
  };
}

export interface Frame { event: string; data: any }

/** One window's background feed: the attention frames it received. */
export function collect(feed: AttentionFeed, owner: string): { frames: Frame[]; stop(): void; of(event: string): any[] } {
  const frames: Frame[] = [];
  const stop = feed.subscribe(owner, {
    send(frame) {
      const [eventLine, dataLine] = frame.trimEnd().split('\n');
      frames.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
    },
  });
  return { frames, stop, of: (event) => frames.filter((frame) => frame.event === event).map((frame) => frame.data) };
}

export function ev(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

let turnSeq = 0;
/** Persists a turn that completed with an answer, as ChatHub would before broadcasting `done`. */
export function completeTurn(nodeId: string, workspaceId: string, turnId: string, userMetadata?: DurableMessageMetadata): void {
  let snapshot = createDurableTurn({
    turnId, assistantId: `a-${turnId}-${++turnSeq}`, nodeId, workspaceId, displayUserText: 'Go', startedAt: 1,
    ...(userMetadata ? { userMetadata } : {}),
  });
  beginTurn(snapshot);
  snapshot = applyTurnEvent(snapshot, ev('chunk', { seq: 1, text: 'All done.' }));
  snapshot = applyTurnEvent(snapshot, ev('done', { seq: 2, stopReason: 'end_turn', completedAt: 5 }));
  finalizeTurn(snapshot);
}

export const turnStart = (nodeId: string, turnId: string, userMetadata?: DurableMessageMetadata) =>
  ev('turn_start', { nodeId, chatId: nodeId, turnId, assistantId: `a-${turnId}`, userText: 'Go', ...(userMetadata ? { userMetadata } : {}) });
export const done = (nodeId: string, turnId: string, stopReason = 'end_turn') =>
  ev('done', { nodeId, chatId: nodeId, turnId, stopReason, persisted: true });
export const permission = (nodeId: string, turnId: string, requestId: number) =>
  ev('permission_request', { nodeId, chatId: nodeId, turnId, requestId, title: 'Run npm test', options: [] });

/** Every attention row, oldest first. */
export function records(): Array<Record<string, unknown>> {
  return (getDb().prepare(`SELECT id, key, fact, kind, reason, status, resolve_reason, owner_user_id, workspace_id, target_id
    FROM attention_notifications ORDER BY created_at, rowid`).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}
