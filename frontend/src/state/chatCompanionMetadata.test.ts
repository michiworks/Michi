import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/api', () => ({
  __esModule: true,
  streamMessage: vi.fn(() => () => {}),
}));

import * as api from '../services/api';
import { CHAT_STREAM_EVENTS, dispatchChatStreamEvent, parseChatStreamEvent } from '../services/chatStreamEvents';
import { createBackgroundTurnBinding } from './observeChatStream';
import { runChatStream } from './chatStreamRunner';
import { reduceNodes } from './chatReducers';
import { mapMessageRow } from './chatHydration';
import { serializeMessageRowsForNode } from './workspacePersistence';
import type { ChatAction, ChatNodeState } from './chatTypes';

const POST = { runId: 'r1', kind: 'heartbeat', changes: [{ kind: 'item', id: 'i1', applied: 1, proposed: 0, action: 'snooze', reason: 'later' }] };

function node(messages: ChatNodeState['messages'] = []): ChatNodeState {
  return { nodeId: 'v', kind: 'chat', chatId: 'v', projectId: 'ws-assistant', messages, followUps: [], status: 'idle' };
}

/** A dispatch that keeps the reducer's state, so a test reads the messages a window would render. */
function store(initial: ChatNodeState) {
  let nodes: Record<string, ChatNodeState> = { v: initial };
  const dispatch = (action: ChatAction) => { nodes = reduceNodes(nodes, action); };
  return { dispatch, read: () => nodes.v };
}

describe('companion metadata after a reload (mapMessageRow)', () => {
  it('survives a write-back of a user message that also quotes something (F1a-review)', () => {
    const refs = [{ kind: 'post', messageId: 'cmp-post-r1' }];
    const user = mapMessageRow({ id: 'u1', node_id: 'v', role: 'user', content: 'hi', metadata: JSON.stringify({
      quotedText: 'a line', companionTurn: { carriedTaint: 'checkin' }, companionRefs: refs,
    }) });
    expect(user.companionTurn).toEqual({ carriedTaint: 'checkin' });
    const [row] = serializeMessageRowsForNode({ v: node([user]) }, 'v');
    expect(JSON.parse(row!.metadata!)).toMatchObject({ quotedText: 'a line', companionTurn: { carriedTaint: 'checkin' }, companionRefs: refs });
    // Without anything else to write, the route's own metadata is still written back, not erased.
    const plain = mapMessageRow({ id: 'u2', node_id: 'v', role: 'user', content: 'hi', metadata: JSON.stringify({ companionTurn: { startTaint: 'collector' } }) });
    expect(JSON.parse(serializeMessageRowsForNode({ v: node([plain]) }, 'v')[0]!.metadata!)).toMatchObject({ companionTurn: { startTaint: 'collector' } });
  });

  it('reads companionPost from an assistant row and companionTurn from a user row', () => {
    const post = mapMessageRow({ id: 'cmp-post-r1', node_id: 'v', role: 'assistant', content: 'Done.', metadata: JSON.stringify({ companionPost: POST }) });
    expect(post.companionPost).toEqual(POST);
    const user = mapMessageRow({ id: 'u1', node_id: 'v', role: 'user', content: 'hi', metadata: JSON.stringify({ companionTurn: { startTaint: 'checkin' } }) });
    expect(user.companionTurn).toEqual({ startTaint: 'checkin' });
  });

  it('keeps neither on the other role, nor a malformed one', () => {
    const user = mapMessageRow({ id: 'u1', node_id: 'v', role: 'user', content: 'x', metadata: JSON.stringify({ companionPost: POST }) });
    expect(user.companionPost).toBeUndefined();
    const assistant = mapMessageRow({ id: 'a1', node_id: 'v', role: 'assistant', content: 'x', metadata: JSON.stringify({ companionTurn: { rulesUnavailable: true } }) });
    expect(assistant.companionTurn).toBeUndefined();
    const bad = mapMessageRow({ id: 'a2', node_id: 'v', role: 'assistant', content: 'x', metadata: JSON.stringify({ companionPost: { runId: 'r', kind: 'nope' } }) });
    expect(bad.companionPost).toBeUndefined();
  });

  it('reads the refs a user message carried, so a retry after a reload sends them again (F1a-review #1)', () => {
    const refs = [{ kind: 'post', messageId: 'cmp-post-r1' }, { kind: 'rows', databaseId: 'db1', rowIds: ['r1'] }];
    const user = mapMessageRow({ id: 'u1', node_id: 'v', role: 'user', content: 'x', metadata: JSON.stringify({ companionRefs: refs }) });
    expect(user.companionRefs).toEqual(refs);
    const malformed = mapMessageRow({ id: 'u2', node_id: 'v', role: 'user', content: 'x', metadata: JSON.stringify({ companionRefs: [{ kind: 'shell' }] }) });
    expect(malformed.companionRefs).toBeUndefined();
  });

  it('reads the first run’s closing options, the conversation one may open included (F1a-review #5)', () => {
    const narration = { kind: 'end', options: [{ label: 'Archive' }, { label: 'Continue in Launch', open: { nodeId: 'n-l', workspaceId: 'w', draft: 'Go on' } }, { label: 7 }] };
    const end = mapMessageRow({ id: 'mna-end', node_id: 'v', role: 'assistant', content: 'Where next?', metadata: JSON.stringify({ metaAgentNarration: narration }) });
    expect(end.narrationOptions).toEqual([{ label: 'Archive' }, { label: 'Continue in Launch', open: { nodeId: 'n-l', workspaceId: 'w', draft: 'Go on' } }]);
    const progress = mapMessageRow({ id: 'mna-1', node_id: 'v', role: 'assistant', content: 'Reading…', metadata: JSON.stringify({ metaAgentNarration: { kind: 'start' } }) });
    expect(progress.narrationOptions).toBeUndefined();
  });
});

describe('companion metadata live', () => {
  it('an open window renders a post as one from its turn_start (observer)', () => {
    const { dispatch, read } = store(node());
    const handlers = createBackgroundTurnBinding({
      chatId: 'v', nodeId: 'v', dispatch, lastTurnRef: { current: '' }, lastSeqRef: { current: -1 },
    }).createHandlers();
    const frame = parseChatStreamEvent(CHAT_STREAM_EVENTS.turnStart, JSON.stringify({
      chatId: 'v', nodeId: 'v', turnId: 'cmp-post-r1', assistantId: 'cmp-post-r1', seq: 0,
      userText: '', selfInitiated: true, assistantMetadata: { companionPost: POST },
    }));
    expect(frame).not.toBeNull();
    dispatchChatStreamEvent(frame!, handlers);
    const message = read().messages.find((m) => m.id === 'cmp-post-r1');
    expect(message?.companionPost).toEqual(POST);
    // A self turn with no user side: no user bubble is made up for it.
    expect(read().messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('a replayed turn_start for a message the window already has puts the post on it', () => {
    const { dispatch, read } = store(node([{ id: 'cmp-post-r1', role: 'assistant', text: 'Done.', toolCalls: [] }]));
    dispatch({ type: 'observer-turn-start', nodeId: 'v', turnId: 'cmp-post-r1', assistantId: 'cmp-post-r1', userText: '',
      selfInitiated: true, assistantMetadata: { companionPost: POST as never } });
    expect(read().messages[0].companionPost).toEqual(POST);
  });

  it('a post’s turn_start clears the earlier reply’s follow-up chips, as the backend does for a reload', () => {
    const { dispatch, read } = store({
      ...node([{ id: 'a-1', role: 'assistant', text: 'Here you go.', toolCalls: [] }]),
      followUps: ['What changed?'], followUpsSourceMessageId: 'a-1',
    });
    dispatch({ type: 'observer-turn-start', nodeId: 'v', turnId: 'cmp-post-r1', assistantId: 'cmp-post-r1', userText: '',
      selfInitiated: true, assistantMetadata: { companionPost: POST as never } });
    expect(read().followUps).toEqual([]);
    expect(read().followUpsSourceMessageId).toBeUndefined();
  });

  it('the observer carries the route\'s companionTurn onto the user message it adds', () => {
    const { dispatch, read } = store(node());
    dispatch({ type: 'observer-turn-start', nodeId: 'v', turnId: 't1', assistantId: 'a-t1', userText: 'hi',
      userMetadata: { companionTurn: { rulesUnavailable: true } } });
    expect(read().messages.find((m) => m.role === 'user')?.companionTurn).toEqual({ rulesUnavailable: true });
  });

  it('the sending window puts companionTurn on the message it already shows', () => {
    const mockStream = api.streamMessage as ReturnType<typeof vi.fn>;
    mockStream.mockClear();
    const { dispatch, read } = store(node([
      { id: 'u-earlier', role: 'user', text: 'before', toolCalls: [] },
      { id: 'a-earlier', role: 'assistant', text: 'ok', toolCalls: [] },
      { id: 'u1', role: 'user', text: 'hi', toolCalls: [] },
      { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true },
    ]));
    runChatStream({ prompt: 'hi', nodeId: 'v', assistantId: 'a1', dispatch, assistantTextBufs: { current: {} }, cancelFns: { current: {} } });
    const handlers = mockStream.mock.calls[0][2];
    handlers.onTurnStart({ turnId: 't1', assistantId: 'a1', nodeId: 'v', userText: 'hi', userMetadata: { companionTurn: { startTaint: 'collector' } } });
    const messages = read().messages;
    expect(messages.find((m) => m.id === 'u1')?.companionTurn).toEqual({ startTaint: 'collector' });
    expect(messages.find((m) => m.id === 'u-earlier')?.companionTurn).toBeUndefined();
  });

  it('ignores a turn_start whose user metadata says nothing about the agent', () => {
    const { dispatch, read } = store(node([{ id: 'u1', role: 'user', text: 'hi', toolCalls: [] }, { id: 'a1', role: 'assistant', text: '', toolCalls: [] }]));
    const before = read();
    dispatch({ type: 'turn-start-metadata', nodeId: 'v', assistantId: 'a1', userMetadata: { quotedText: 'q' } });
    expect(read()).toBe(before);
  });
});
