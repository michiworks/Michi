import { describe, expect, it } from 'vitest';
import { applyTreeMessages } from './chatHydration';
import { reduceNodes } from './chatReducers';
import type { ChatMessage, ChatNodeState } from './chatTypes';
import { nodeMessageCount } from './nodeMessageCount';

const msg = (id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage => ({ id, role, text: id, toolCalls: [] });
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => msg(`m${from + i}`, i % 2 ? 'assistant' : 'user'));
const node = (extras: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId: 'n', kind: 'chat', chatId: null, projectId: 'p', messages: [], followUps: [], status: 'idle', ...extras,
});

/** A remote node of 40 messages after its first page of 15. */
function partialPage(): Record<string, ChatNodeState> {
  return applyTreeMessages({ n: node({ messagesLoaded: false, messageCount: 40 }) }, { n: rows(25, 15) },
    [{ nodeId: 'n', total: 40, before: { seq: 25, id: 'm25' } }]);
}

describe('nodeMessageCount', () => {
  it('counts a placeholder by its stored total', () => {
    expect(nodeMessageCount(node({ messagesLoaded: false, messageCount: 40 }))).toBe(40);
  });

  it('counts a partial page by the node total, not the page', () => {
    expect(nodeMessageCount(partialPage().n)).toBe(40);
  });

  it('counts a send on a partial page', () => {
    const sent = reduceNodes(partialPage(), { type: 'user-send', nodeId: 'n', userText: 'more', assistantId: 'a-new' });
    expect(nodeMessageCount(sent.n)).toBe(42);
  });

  it('keeps counting after an older page loads', () => {
    const sent = reduceNodes(partialPage(), { type: 'user-send', nodeId: 'n', userText: 'more', assistantId: 'a-new' });
    const older = reduceNodes(sent, {
      type: 'history-page-loaded', nodeId: 'n', expectedBefore: { seq: 25, id: 'm25' },
      messages: rows(10, 15), before: { seq: 10, id: 'm10' }, total: 42,
    });
    expect(older.n.messages).toHaveLength(32);
    expect(nodeMessageCount(older.n)).toBe(42);
    const sentAgain = reduceNodes(older, { type: 'user-send', nodeId: 'n', userText: 'again', assistantId: 'a-2' });
    expect(nodeMessageCount(sentAgain.n)).toBe(44);
  });

  it('counts loaded messages over a count stored before a send', () => {
    expect(nodeMessageCount(node({ messagesLoaded: true, messageCount: 10, messages: rows(0, 12) }))).toBe(12);
    expect(nodeMessageCount(node({ messageCount: 10, messages: rows(0, 12) }))).toBe(12);
  });

  it('counts a node created here by its messages', () => {
    expect(nodeMessageCount(node({ messages: rows(0, 3) }))).toBe(3);
  });
});
