import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';
import { reduceNodes } from './chatReducers';
import { mergeCompletionFacts } from './completionFacts';
import { isNodeUnread } from './sidebarSelectors';
import { sameTreeMessageNode } from './treeMessageRequests';
import { buildExplicitWorkspaceCommands, emptyWorkspaceDirtyDelta } from './workspacePersistence';
import { noteServerAttentionCapabilities } from '../services/serverAttentionStore';
import type { ChatNodeState, Project } from './chatTypes';

// Server completion facts (backend migration 0064) in the renderer: hydration,
// the unread rule that prefers them, the reducers that keep them current, and
// the view mark that carries the seen count back.

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'n1', kind: 'chat', chatId: 'n1', projectId: 'ws-1', messages: [], followUps: [], status: 'idle', ...overrides };
}

function streaming(overrides: Partial<ChatNodeState> = {}, text = 'All done.'): Record<string, ChatNodeState> {
  return {
    n1: node({
      status: 'streaming',
      messages: [{ id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true,
        blocks: text ? [{ id: 'a1-b-0', kind: 'answer', rawText: text, streaming: true }] : [] }],
      ...overrides,
    }),
  };
}

describe('hydration', () => {
  it('maps the facts from a backend that keeps them, and none from one that does not', () => {
    const state = hydrateBackendWorkspaces([{
      workspace: { id: 'ws-1', name: 'Test', created_at: 1 },
      trees: [
        { id: 't1', root_node_id: 'facts', created_at: 1, last_active_at: 1 },
        { id: 't2', root_node_id: 'legacy', created_at: 2, last_active_at: 2 },
        { id: 't3', root_node_id: 'skewed', created_at: 3, last_active_at: 3 },
      ],
      nodes: [
        { id: 'facts', created_at: 1, kind: 'chat', message_count: 2, completion_seq: 3, seen_completion_seq: 1, last_completed_at: 1_700 },
        { id: 'legacy', created_at: 2, kind: 'chat', message_count: 2 },
        { id: 'skewed', created_at: 3, kind: 'chat', message_count: 2, completion_seq: 1, seen_completion_seq: 4 },
      ],
      edges: [], messages: [], artifacts: [],
    }]);
    expect([state.nodes.facts.completionSeq, state.nodes.facts.seenCompletionSeq, state.nodes.facts.lastCompletedAt])
      .toEqual([3, 1, 1_700]);
    expect(state.nodes.legacy.completionSeq).toBeUndefined();
    expect(state.nodes.legacy.seenCompletionSeq).toBeUndefined();
    expect(state.nodes.skewed.seenCompletionSeq).toBe(1);
    expect(isNodeUnread(state.nodes.facts, null)).toBe(true);
    expect(isNodeUnread(state.nodes.legacy, null)).toBe(false);
  });
});

describe('a node this window creates', () => {
  const create = (projectId: string) =>
    reduceNodes({}, { type: 'create', nodeId: 'new', projectId }).new;

  it('starts at none completed and none seen once its backend is known to keep facts', () => {
    expect(create('remote:conn-unknown:ws-1').completionSeq, 'an older or not yet known backend').toBeUndefined();
    noteServerAttentionCapabilities('conn-capable', { attention: 'v1' });
    expect([create('remote:conn-capable:ws-1').completionSeq, create('remote:conn-capable:ws-1').seenCompletionSeq]).toEqual([0, 0]);
    hydrateBackendWorkspaces([{
      workspace: { id: 'ws-1', name: 'Test', created_at: 1 },
      trees: [{ id: 't1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
      nodes: [{ id: 'n1', created_at: 1, kind: 'chat', message_count: 0, completion_seq: 0, seen_completion_seq: 0 }],
      edges: [], messages: [], artifacts: [],
    }], null, 'conn-hydrated');
    expect(create('remote:conn-hydrated:ws-1').completionSeq, 'its rows carried facts').toBe(0);
  });

  it('then counts and marks its first completion like any other', () => {
    noteServerAttentionCapabilities('conn-first', { attention: 'v1' });
    const created = { n1: { ...create('remote:conn-first:ws-1'), nodeId: 'n1' } };
    const streamingReply = { ...created.n1, status: 'streaming' as const, messages: streaming().n1.messages };
    const done = reduceNodes({ n1: streamingReply }, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect([done.n1.completionSeq, isNodeUnread(done.n1, null)]).toEqual([1, true]);
    const seen = reduceNodes(done, { type: 'node-viewed', nodeId: 'n1', viewedAt: Date.now(), seen: true });
    expect([seen.n1.seenCompletionSeq, isNodeUnread(seen.n1, null)]).toEqual([1, false]);
  });
});

describe('the unread rule', () => {
  it('prefers the server facts and falls back to the reply-against-view rule', () => {
    expect(isNodeUnread(node({ completionSeq: 2, seenCompletionSeq: 1, lastAssistantAt: 1, viewedAt: 9 }), null)).toBe(true);
    expect(isNodeUnread(node({ completionSeq: 2, seenCompletionSeq: 2, lastAssistantAt: 9, viewedAt: 1 }), null)).toBe(false);
    expect(isNodeUnread(node({ completionSeq: 1 }), null)).toBe(true);
    expect(isNodeUnread(node({ lastAssistantAt: 9, viewedAt: 1 }), null)).toBe(true);
    expect(isNodeUnread(node({ lastAssistantAt: 1, viewedAt: 9 }), null)).toBe(false);
    expect(isNodeUnread(node({ completionSeq: 2 }), 'n1')).toBe(false);
    expect(isNodeUnread(node({ kind: 'digest', completionSeq: 2 }), null)).toBe(false);
  });
});

describe('reducers', () => {
  it('a reply watched streaming counts as a completion, once', () => {
    const done = { type: 'done' as const, nodeId: 'n1', assistantId: 'a1', completedAt: 1_234 };
    const counted = reduceNodes(streaming({ completionSeq: 4, seenCompletionSeq: 4 }), done);
    expect([counted.n1.completionSeq, counted.n1.lastCompletedAt]).toEqual([5, 1_234]);
    expect(isNodeUnread(counted.n1, null)).toBe(true);
    expect(reduceNodes(counted, done).n1.completionSeq).toBe(5);
    expect(reduceNodes(streaming({ completionSeq: 4 }), { ...done, aborted: true }).n1.completionSeq).toBe(4);
    expect(reduceNodes(streaming({ completionSeq: 4 }, ''), done).n1.completionSeq).toBe(4);
    expect(reduceNodes(streaming(), done).n1.completionSeq).toBeUndefined();
  });

  it('a seen view and Read all record the completions as seen; a plain view does not', () => {
    const unread = { n1: node({ completionSeq: 3, seenCompletionSeq: 1 }), n2: node({ nodeId: 'n2', lastAssistantAt: 5, viewedAt: 1 }) };
    expect(reduceNodes(unread, { type: 'node-viewed', nodeId: 'n1', viewedAt: 10 }).n1.seenCompletionSeq).toBe(1);
    const seen = reduceNodes(unread, { type: 'node-viewed', nodeId: 'n1', viewedAt: 10, seen: true });
    expect([seen.n1.seenCompletionSeq, seen.n1.viewedAt]).toEqual([3, 10]);
    const all = reduceNodes(unread, { type: 'mark-all-read', viewedAt: 20 });
    expect([all.n1.seenCompletionSeq, all.n2.viewedAt]).toEqual([3, 20]);
    expect(reduceNodes(all, { type: 'mark-all-read', viewedAt: 30 })).toBe(all);
  });

  it('a gap snapshot never moves the counts back', () => {
    const server = node({ completionSeq: 3, seenCompletionSeq: 1, lastCompletedAt: 30 });
    expect(mergeCompletionFacts(server, node({ completionSeq: 2, seenCompletionSeq: 3, lastCompletedAt: 20 })))
      .toEqual({ completionSeq: 3, seenCompletionSeq: 3, lastCompletedAt: 30 });
    expect(mergeCompletionFacts(node(), node())).toEqual({});
    // The turn counted last is the one of the side that counted more.
    const named = { ...server, lastCompletedTurnId: 't3' };
    expect(mergeCompletionFacts(named, node({ completionSeq: 2, lastCompletedTurnId: 't2' })).lastCompletedTurnId).toBe('t3');
    expect(mergeCompletionFacts(named, node({ completionSeq: 4, lastCompletedTurnId: 't4' })).lastCompletedTurnId).toBe('t4');
  });

  it('a pending tree read ignores the seen count like the view mark', () => {
    const before = node({ completionSeq: 2, seenCompletionSeq: 1, viewedAt: 1 });
    expect(sameTreeMessageNode(before, { ...before, seenCompletionSeq: 2, viewedAt: 5 })).toBe(true);
    expect(sameTreeMessageNode(before, { ...before, completionSeq: 3 })).toBe(false);
  });
});

describe('a turn counts once, whatever ended its stream', () => {
  const followUps = 'All done. [FOLLOW-UP 1/3: a] [FOLLOW-UP 2/3: b] [FOLLOW-UP 3/3: c]';

  it('a reply whose three follow-ups completed it before done (the server counts it, so does the window)', () => {
    const visible = reduceNodes(streaming({ completionSeq: 4, seenCompletionSeq: 4 }, followUps),
      { type: 'visible-response-complete', nodeId: 'n1', assistantId: 'a1' });
    expect(visible.n1.messages[0].streaming).toBe(false);
    const done = { type: 'done' as const, nodeId: 'n1', assistantId: 'a1', turnId: 't5', completedAt: 50 };
    const counted = reduceNodes(visible, done);
    expect([counted.n1.completionSeq, counted.n1.lastCompletedTurnId, counted.n1.lastCompletedAt]).toEqual([5, 't5', 50]);
    expect(isNodeUnread(counted.n1, null)).toBe(true);
    expect(reduceNodes(counted, done).n1.completionSeq, 'a replay of the same turn').toBe(5);
    expect(reduceNodes(visible, { ...done, aborted: true }).n1.completionSeq).toBe(4);
  });

  it('a reply that left only its title or follow-ups is not counted, as on the server', () => {
    for (const raw of ['[TITLE: Notes]', '[TITLE: Notes]\n[FOLLOW-UP 1/3: Next?]', 'Title: Notes\n']) {
      const done = reduceNodes(streaming({ completionSeq: 3, seenCompletionSeq: 3 }, raw),
        { type: 'done', nodeId: 'n1', assistantId: 'a1', turnId: 't4' });
      expect(done.n1.completionSeq, raw).toBe(3);
    }
  });

  it('an observed turn that starts on a reply this window already has', () => {
    const hydrated = { n1: node({
      completionSeq: 2, seenCompletionSeq: 2,
      messages: [{ id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks: [] }],
    }) };
    let nodes = reduceNodes(hydrated, { type: 'observer-turn-start', nodeId: 'n1', turnId: 't3', assistantId: 'a1', userText: '' });
    nodes = reduceNodes(nodes, { type: 'chunk', nodeId: 'n1', assistantId: 'a1', text: 'Here it is' });
    nodes = reduceNodes(nodes, { type: 'done', nodeId: 'n1', assistantId: 'a1', turnId: 't3' });
    expect(nodes.n1.completionSeq).toBe(3);
    expect(reduceNodes(nodes, { type: 'done', nodeId: 'n1', assistantId: 'a1', turnId: 't3' }).n1.completionSeq).toBe(3);
  });

  it('a replayed done of the turn the server counted last is not counted again after a reload', () => {
    const state = hydrateBackendWorkspaces([{
      workspace: { id: 'ws-1', name: 'Test', created_at: 1 },
      trees: [{ id: 't1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
      nodes: [{ id: 'n1', created_at: 1, kind: 'chat', message_count: 2, completion_seq: 3, seen_completion_seq: 3, last_completed_turn_id: 'turn-3' }],
      edges: [],
      messages: [{ id: 'a1', node_id: 'n1', role: 'assistant', content: 'Answer', seq: 1, created_at: 1 }],
      artifacts: [],
    }]);
    expect(state.nodes.n1.lastCompletedTurnId).toBe('turn-3');
    const replayed = reduceNodes(state.nodes, { type: 'done', nodeId: 'n1', assistantId: 'a1', turnId: 'turn-3' });
    expect([replayed.n1.completionSeq, isNodeUnread(replayed.n1, null)]).toEqual([3, false]);
  });

  it('takes the counts the server committed with the turn, however often the frame comes', () => {
    const completion = { completionSeq: 7, seenCompletionSeq: 5 };
    // This window missed two completions (another window, a disconnect): the frame catches it up.
    const done = { type: 'done' as const, nodeId: 'n1', assistantId: 'a1', turnId: 't7', completedAt: 70, completion };
    const caughtUp = reduceNodes(streaming({ completionSeq: 4, seenCompletionSeq: 4 }), done);
    expect([caughtUp.n1.completionSeq, caughtUp.n1.seenCompletionSeq, caughtUp.n1.lastCompletedTurnId]).toEqual([7, 5, 't7']);
    expect(reduceNodes(caughtUp, done).n1).toEqual(caughtUp.n1);
    // A seen mark this window already has is kept; counts never go back.
    const ahead = reduceNodes(streaming({ completionSeq: 8, seenCompletionSeq: 8 }), done);
    expect([ahead.n1.completionSeq, ahead.n1.seenCompletionSeq]).toEqual([8, 8]);
    // The server's word is final for a reply it did not count.
    expect(reduceNodes(streaming({ completionSeq: 7, seenCompletionSeq: 5 }), done).n1.completionSeq).toBe(7);
  });

  it('a node created before its backend was known to keep facts adopts them from its first done', () => {
    const created = reduceNodes({}, { type: 'create', nodeId: 'n1', projectId: 'remote:conn-late:ws-1' });
    expect(created.n1.completionSeq).toBeUndefined();
    const streamingReply = { n1: { ...created.n1, status: 'streaming' as const, messages: streaming().n1.messages } };
    const done = reduceNodes(streamingReply, {
      type: 'done', nodeId: 'n1', assistantId: 'a1', turnId: 't1', completion: { completionSeq: 1, seenCompletionSeq: 0 },
    });
    expect([done.n1.completionSeq, done.n1.seenCompletionSeq, isNodeUnread(done.n1, null)]).toEqual([1, 0, true]);
  });

  it('Read all then sends the count the server holds', () => {
    const project: Project = {
      id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], createdAt: 1,
      trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 't1', artifacts: [],
    };
    const visible = reduceNodes(streaming({ completionSeq: 4, seenCompletionSeq: 4, viewedAt: 1 }, followUps),
      { type: 'visible-response-complete', nodeId: 'n1', assistantId: 'a1' });
    const done = reduceNodes(visible, {
      type: 'done', nodeId: 'n1', assistantId: 'a1', turnId: 't5', completion: { completionSeq: 5, seenCompletionSeq: 4 },
    });
    const read = reduceNodes(done, { type: 'mark-all-read', viewedAt: 900 });
    const delta = emptyWorkspaceDirtyDelta();
    delta.nodeIds.add('n1');
    const known = new Map(buildExplicitWorkspaceCommands(project, read, delta, new Map()).nodeProjectionUpdates);
    const marks = buildExplicitWorkspaceCommands(project, read, delta, known, undefined, new Map([['n1', 1]]), new Map([['n1', 4]]));
    expect(marks.commands).toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 900, seen_completion_seq: 5 } }]);
  });
});

describe('the view mark carries the seen count', () => {
  const project: Project = {
    id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], createdAt: 1,
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 't1', artifacts: [],
  };
  const reply = { id: 'a1', role: 'assistant' as const, text: 'Done', toolCalls: [] };
  const delta = () => { const value = emptyWorkspaceDirtyDelta(); value.nodeIds.add('n1'); return value; };
  const viewPatches = (nodes: Record<string, ChatNodeState>, knownView: number, knownSeen: number) => {
    const known = new Map(buildExplicitWorkspaceCommands(project, nodes, delta(), new Map()).nodeProjectionUpdates);
    return buildExplicitWorkspaceCommands(project, nodes, delta(), known, undefined, new Map([['n1', knownView]]), new Map([['n1', knownSeen]]));
  };

  it('sends a newer seen count with the mark, even when the mark itself did not move', () => {
    const seen = { n1: node({ messages: [reply], viewedAt: 500, completionSeq: 3, seenCompletionSeq: 3 }) };
    const both = viewPatches({ n1: { ...seen.n1, viewedAt: 900 } }, 500, 1);
    expect(both.commands).toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 900, seen_completion_seq: 3 } }]);
    expect([...both.seenCompletionUpdates]).toEqual([['n1', 3]]);
    const seenOnly = viewPatches(seen, 500, 1);
    expect(seenOnly.commands).toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 500, seen_completion_seq: 3 } }]);
    expect([...seenOnly.viewedAtUpdates]).toEqual([]);
    expect(viewPatches(seen, 500, 3).commands, 'nothing new').toEqual([]);
  });

  it('a node without facts (an older backend) sends the plain mark', () => {
    const legacy = { n1: node({ messages: [reply], viewedAt: 900, seenCompletionSeq: 3 }) };
    expect(viewPatches(legacy, 500, 0).commands).toEqual([{ type: 'node.patch', payload: { id: 'n1', viewed_at: 900 } }]);
  });
});
