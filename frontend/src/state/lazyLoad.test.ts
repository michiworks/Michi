/**
 * Message lazy-load: the invariant that keeps it safe is that a placeholder
 * node (messagesLoaded:false, empty messages) is NEVER treated as authoritative
 * — not for write-back, not for hydration, not for digest staleness.
 */
import { describe, expect, it } from 'vitest';

import { buildMessagesByNode } from './chatHydration';
import { reduceNodes } from './chatReducers';
import { visibleMessageText } from './assistantBlocks';
import { staleSources } from './digest';
import type { ChatAction, ChatNodeState } from './chatTypes';
import { installTreeMessagePage } from './treeMessageInstall';
function placeholderNode(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1', projectId: 'ws-1', kind: 'chat', chatId: null,
    messages: [], messagesLoaded: false, messageCount: 5,
    followUps: [], status: 'idle', ...overrides,
  };
}

describe('messages-loaded install', () => {
  it('tracks partial history and prepends old pages without changing the live tail or replay cursor', () => {
    const newest = buildMessagesByNode([{ id: 'm50', node_id: 'n1', role: 'assistant', content: 'live tail', seq: 50, created_at: 1 }]);
    const before = { id: 'm50', seq: 50 };
    const initial = reduceNodes({ n1: placeholderNode({ lastAppliedSeq: 23 }) }, {
      type: 'messages-loaded', nodeIds: ['n1'], messagesByNode: newest,
      pages: [{ nodeId: 'n1', total: 51, before }],
    });
    expect(initial.n1.messagesLoaded).toBe(false);
    expect(initial.n1.messageCount).toBe(51);
    const older = buildMessagesByNode([
      { id: 'm49', node_id: 'n1', role: 'user', content: 'older', seq: 49, created_at: 1 },
      { id: 'm50', node_id: 'n1', role: 'assistant', content: 'stale overlap', seq: 50, created_at: 1 },
    ]);
    const complete = reduceNodes(initial, { type: 'history-page-loaded', nodeId: 'n1', expectedBefore: before,
      before: null, total: 51, messages: older.n1 });
    expect(complete.n1.messages.map(visibleMessageText)).toEqual(['older', 'live tail']);
    expect(complete.n1.messagesLoaded).toBe(true);
    expect(complete.n1.lastAppliedSeq).toBe(23);
    expect(reduceNodes(complete, { type: 'history-page-loaded', nodeId: 'n1', expectedBefore: before,
      before: null, total: 51, messages: older.n1 })).toBe(complete);
  });
  it('flips placeholders to loaded and installs bodies via the reducer', () => {
    const nodes = { n1: placeholderNode() };
    const byNode = buildMessagesByNode([
      { id: 'm1', node_id: 'n1', role: 'user', content: 'hello', seq: 0, created_at: 1 },
      { id: 'm2', node_id: 'n1', role: 'assistant', content: 'hi', seq: 1, created_at: 2 },
    ]);
    const next = reduceNodes(nodes, { type: 'messages-loaded', nodeIds: ['n1'], messagesByNode: byNode });
    expect(next.n1.messagesLoaded).toBe(true);
    expect(next.n1.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(next.n1.messageCount).toBe(2);
  });
});

describe('installing a tree read', () => {
  function target(nodes: Record<string, ChatNodeState>) {
    const nodesRef = { current: nodes };
    return { nodesRef, dispatch: (action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); } };
  }

  it('never empties a node with history the response does not account for', () => {
    const start = { n1: placeholderNode(), n2: placeholderNode({ nodeId: 'n2' }), n3: placeholderNode({ nodeId: 'n3', messageCount: 0 }) };
    const install = target(start);
    const result = installTreeMessagePage(install, { messages: [
      { id: 'm1', node_id: 'n1', role: 'user', content: 'kept', seq: 0, created_at: 1 },
    ] }, ['n1', 'n2', 'n3'], new Map(Object.entries(start)));
    expect(result).toEqual({ installed: ['n1', 'n3'], changed: [], missing: ['n2'] });
    expect(install.nodesRef.current.n2).toBe(start.n2);
    expect(install.nodesRef.current.n3.messagesLoaded).toBe(true);
  });

  it('installs an empty thread only when the server reports a total of zero', () => {
    const start = { n1: placeholderNode(), n2: placeholderNode({ nodeId: 'n2' }) };
    const install = target(start);
    const result = installTreeMessagePage(install, { messages: [], pages: [
      { nodeId: 'n1', total: 0, before: null }, { nodeId: 'n2', total: 5, before: null },
    ] }, ['n1', 'n2'], new Map(Object.entries(start)));
    expect(result).toEqual({ installed: ['n1'], changed: [], missing: ['n2'] });
    expect(install.nodesRef.current.n1).toMatchObject({ messagesLoaded: true, messageCount: 0 });
  });

  it('skips a node that changed while the read was in flight', () => {
    const start = { n1: placeholderNode() };
    const install = target({ n1: placeholderNode({ status: 'streaming', messages: [
      { id: 'live', role: 'assistant', text: 'live', toolCalls: [], createdAt: 1 },
    ] }) });
    const result = installTreeMessagePage(install, { messages: [
      { id: 'm1', node_id: 'n1', role: 'assistant', content: 'stale', seq: 0, created_at: 1 },
    ] }, ['n1'], new Map(Object.entries(start)));
    expect(result.changed).toEqual(['n1']);
    expect(install.nodesRef.current.n1.messages[0].text).toBe('live');
  });
});

describe('digest staleness respects lazy load', () => {
  it('does not mark an unloaded source stale (would be a false positive)', () => {
    const digest = {
      sources: ['n1'], sourceFingerprints: { n1: 'realhash' },
      content: 'x', generatedAt: 1, viewedAt: 0, status: 'idle' as const,
    };
    // Placeholder source: empty trail would hash to something != 'realhash',
    // but the guard must skip it rather than report a false stale.
    const nodes = { n1: placeholderNode() };
    expect(staleSources(digest, nodes)).toEqual([]);
  });
});
