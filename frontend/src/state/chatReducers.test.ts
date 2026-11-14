import { describe, it, expect } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState, ChatAction } from './chatTypes';

function makeNode(over: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: 'c1',
    projectId: 'p1',
    messages: [
      { id: 'a1', role: 'assistant', text: 'hi', toolCalls: [], blocks: [], streaming: true, createdAt: 1 },
    ],
    followUps: [],
    status: 'streaming',
    ...over,
  };
}

describe('reduceNodes main-response titles', () => {
  function firstTurn() {
    return reduceNodes({ n1: makeNode({ runtimeId: 'claude', messages: [], status: 'idle' }) }, {
      type: 'user-send', nodeId: 'n1', userText: '/btw Claude 标题应该如何生成？', assistantId: 'a1',
    });
  }

  it('persists the user-message fallback only after a response omits title metadata', () => {
    const streaming = firstTurn();
    expect(streaming.n1.title).toBeUndefined();
    const answered = reduceNodes(streaming, {
      type: 'chunk', nodeId: 'n1', assistantId: 'a1', text: '回答内容',
    });
    const done = reduceNodes(answered, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect(done.n1.title).toBe('Claude 标题应该如何生成？');
    expect(done.n1.titleNeedsPersistence).toBe(true);

    const later = reduceNodes(done, { type: 'set-title', nodeId: 'n1', title: 'Later title' });
    expect(later.n1.title).toBe(done.n1.title);
  });
});

describe('reduceNodes done — branch overview', () => {
  it('stores a valid branch overview from assistant metadata', () => {
    const before = {
      n1: makeNode({
        messages: [{
          id: 'a1',
          role: 'assistant',
          text: 'Answer.\n\n[BRANCH-OVERVIEW: The branch compares two auth models and currently favors rotating tokens.]',
          toolCalls: [],
          streaming: true,
          createdAt: 1,
        }],
      }),
    };
    const after = reduceNodes(before, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect(after.n1.branchOverview).toBe(
      'The branch compares two auth models and currently favors rotating tokens.',
    );
  });
});

describe('reduceNodes node-viewed', () => {
  it('is a no-op if the node is missing', () => {
    const before = { n1: makeNode() };
    const action: ChatAction = { type: 'node-viewed', nodeId: 'missing', viewedAt: 1 };
    const after = reduceNodes(before, action);
    expect(after).toBe(before);
  });
});

describe('reduceNodes mark-all-read', () => {
  it('leaves already-read chat nodes and their reference untouched', () => {
    const read = makeNode({ nodeId: 'a', status: 'idle', lastAssistantAt: 100, viewedAt: 500 });
    const before = { a: read };
    const action: ChatAction = { type: 'mark-all-read', viewedAt: 9_999 };
    const after = reduceNodes(before, action);
    // Nothing was unread → same reference back (no re-render churn).
    expect(after).toBe(before);
    expect(after.a).toBe(read);
  });

  it('does not touch digest nodes (separate read model)', () => {
    const digest = makeNode({
      nodeId: 'd',
      kind: 'digest',
      status: 'idle',
      lastAssistantAt: 800,
      viewedAt: 100,
    });
    const before = {
      d: digest,
      c: makeNode({ nodeId: 'c', status: 'idle', lastAssistantAt: 800, viewedAt: 100 }),
    };
    const action: ChatAction = { type: 'mark-all-read', viewedAt: 9_999 };
    const after = reduceNodes(before, action);
    expect(after.d).toBe(digest);
    expect(after.c.viewedAt).toBe(9_999);
  });
});

describe('reduceNodes pin-node / unpin-node', () => {
  it('pin-node stamps pinnedAt with the action timestamp', () => {
    const before = { n1: makeNode({ status: 'idle' }) };
    const after = reduceNodes(before, { type: 'pin-node', nodeId: 'n1', now: 555 });
    expect(after.n1.pinnedAt).toBe(555);
    // Immutable update: the previous node object is untouched.
    expect(before.n1.pinnedAt).toBeUndefined();
  });

  it('unpin-node removes the pinnedAt key entirely', () => {
    const before = { n1: makeNode({ status: 'idle', pinnedAt: 555 }) };
    const after = reduceNodes(before, { type: 'unpin-node', nodeId: 'n1' });
    expect(after.n1.pinnedAt).toBeUndefined();
    expect('pinnedAt' in after.n1).toBe(false);
  });

  it('ignores unknown node ids', () => {
    const before = { n1: makeNode({ status: 'idle' }) };
    expect(reduceNodes(before, { type: 'pin-node', nodeId: 'missing', now: 1 })).toBe(before);
    expect(reduceNodes(before, { type: 'unpin-node', nodeId: 'missing' })).toBe(before);
  });
});

describe('permission expiry', () => {
  it('only closes the matching card, preserving a newer pending request', () => {
    const before = { n1: makeNode({ pendingPermission: { requestId: 9, title: 'Current tool', options: [] } }) };
    expect(reduceNodes(before, { type: 'permission-resolved', nodeId: 'n1', requestId: 8 })).toBe(before);
    expect(reduceNodes(before, { type: 'permission-resolved', nodeId: 'n1', requestId: 9 }).n1.pendingPermission).toBeNull();
  });
});

describe('reduceNodes agent-spawn', () => {
  const spawn = (blocks: NonNullable<ChatNodeState['messages'][number]['blocks']>) => {
    const next = reduceNodes({ n1: makeNode({ messages: [{ id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks, streaming: true, createdAt: 1 }] }) }, {
      type: 'agent-spawn', parentNodeId: 'n1', projectId: 'p1',
      nodes: [{ nodeId: 'b1', chatId: 'cb1', title: 'Try A' }, { nodeId: 'b2', chatId: 'cb2', title: 'Try B' }],
    });
    return next.n1.messages[0]!;
  };

  it('adds a completed spawn chip at the end of the answer run and closes the text before it', () => {
    const message = spawn([{ id: 'a1-b-0', kind: 'answer', rawText: 'before', streaming: true }]);
    const tool = message.toolCalls[0]!;
    expect(tool).toMatchObject({
      title: 'Spawned 2 branches', status: 'completed', kind: 'spawn_branches',
      detail: 'Try A, Try B', output: '→ Try A\n→ Try B', textOffset: 6,
    });
    expect(message.blocks).toEqual([
      { id: 'a1-b-0', kind: 'answer', rawText: 'before', streaming: false },
      { id: 'a1-b-1', kind: 'tool', toolCallId: tool.id, section: 'answer', rawOffset: 6 },
    ]);
  });

  it('keeps the chip in the thinking run that a tool already continues', () => {
    const message = spawn([
      { id: 'a1-b-0', kind: 'thinking', rawText: 'inspect', streaming: false },
      { id: 'a1-b-1', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 7 },
    ]);
    expect(message.blocks?.[2]).toEqual({ id: 'a1-b-2', kind: 'tool', toolCallId: message.toolCalls[0]!.id, section: 'thinking', rawOffset: 7 });
  });
});
