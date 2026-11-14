/**
 * The tray's "<name> is waiting for you" (conversationWaiting.ts): V asking
 * for an approval or an answer, its answer, and the turn's end after it each
 * tell the tray (`companion_changed`, reason `conversation`); nothing about
 * any other conversation does. No database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent } from 'michi-shared';
import { CompanionEventBus } from '../src/services/companion/delivery';
import { watchConversationWaiting, type ConversationWaitingHub } from '../src/services/companion/conversationWaiting';

const ev = (event: string, data: Record<string, unknown>) => ({ event, data }) as unknown as ChatStreamEvent;

test('V\'s requests, their answers and the end of a turn that waited reach the tray; other conversations do not', () => {
  let send: ((chatId: string, event: ChatStreamEvent) => void) | null = null;
  let detached = false;
  const hub: ConversationWaitingHub = { subscribeBackground: (subscriber) => { send = subscriber.send; return () => { detached = true; }; } };
  let revision = 0;
  const bus = new CompanionEventBus({ current: () => revision, bump: () => ++revision });
  const reasons: string[] = [];
  bus.subscribe({ changed: (event) => reasons.push(event.reason) });
  const stop = watchConversationWaiting({ hub, bus, conversationNodeId: () => 'n-v' });
  send!('n-v', ev('permission_request', { nodeId: 'n-v', turnId: 't1', requestId: 1 }));
  send!('n-v', ev('permission_resolved', { nodeId: 'n-v', turnId: 't1', requestId: 1 }));
  send!('n-v', ev('user_input_request', { nodeId: 'n-v', turnId: 't1', requestId: 2 }));
  send!('n-v', ev('done', { nodeId: 'n-v', turnId: 't1', stopReason: 'end_turn' }));
  send!('n-v', ev('done', { nodeId: 'n-v', turnId: 't2', stopReason: 'end_turn' }));
  send!('n-1', ev('permission_request', { nodeId: 'n-1', turnId: 't3', requestId: 1 }));
  send!('n-1', ev('done', { nodeId: 'n-1', turnId: 't3', stopReason: 'end_turn' }));
  assert.deepEqual(reasons, ['conversation', 'conversation', 'conversation', 'conversation'], 'two requests, an answer, and the end of the turn that waited');
  stop();
  assert.equal(detached, true);
});
