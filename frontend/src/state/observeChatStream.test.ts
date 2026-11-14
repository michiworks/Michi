import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, dispatchChatStreamEvent } from '../services/chatStreamEvents';
import type { ChatStreamEvent } from '../services/chatStreamEvents';
import { createBackgroundTurnBinding } from './observeChatStream';
import { reduceNodes } from './chatReducers';
import { mapMessageRow } from './chatHydration';
import { applyTurnEvent, createDurableTurn } from 'michi-shared';
import type { ChatNodeState } from './chatTypes';
import type { ChatAction } from './chatTypes';
import { cancelChatAndObserve, settleCancellationObservation } from '../services/api/stream';
import { fetchStream } from '../services/api/streamTransport';

import { indexBackendProjects, setKnownBackendConnections } from '../config/backendConnections';
import { closeRemoteAuthentication, completeRemoteAuthentication, getRemoteAuthentication, reportRemoteCredentialError } from './remoteAuthentication';
import { resetTurnPageReceiptInvalidationForTests } from '../lib/turnPageReceipt';
import { subscribePageChanges } from './pages/pageEvents';

vi.mock('../services/api/streamTransport', () => ({ fetchStream: vi.fn() }));
vi.mock('../config/backendConnections', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/backendConnections')>(),
  backendApiBase: () => 'http://localhost:3000/api',
  nodeBackendApiBase: () => 'http://localhost:3000/api',
}));
vi.mock('../../../shared/src/remoteCredentials', () => ({ REMOTE_CREDENTIALS: {
  name: 'Example SSO', localAction: 'Refresh Example SSO on this computer', localCommand: ['example-login'],
  remoteCommand: ['example-login', '--remote'], remoteCookie: null,
  remoteCredentialError: /example-login|example sso.*expired/i, localCredentialError: null,
} }));

function envelope(seq: number) {
  return {
    chatId: 'chat-1',
    nodeId: 'node-1',
    turnId: 'self-turn-1',
    assistantId: 'self-a-1',
    seq,
  };
}

describe('createBackgroundTurnBinding', () => {
  it('runs the shared structural side-effect adapter exactly once per seq', () => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onSpawnBranches = vi.fn();
    const onArtifactSaved = vi.fn();
    const onArtifactUpdated = vi.fn();
    const onArtifactDeleted = vi.fn();
    const lastTurnRef = { current: '' };
    const lastSeqRef = { current: -1 };
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef,
      lastSeqRef,
      extraHandlers: { onSpawnBranches, onArtifactSaved, onArtifactUpdated, onArtifactDeleted },
    }).createHandlers();

    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { ...envelope(0), userText: '', selfInitiated: true },
    }, handlers);
    const spawn: ChatStreamEvent = {
      event: CHAT_STREAM_EVENTS.spawnBranches,
      data: {
        ...envelope(1),
        topics: [{ chatId: 'child-chat', nodeId: 'child-node', title: 'Child' }],
      },
    };
    dispatchChatStreamEvent(spawn, handlers);
    dispatchChatStreamEvent(spawn, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.artifactSaved,
      data: { ...envelope(2), name: 'notes', filePath: '/tmp/notes.md', size: 12 },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.artifactUpdated,
      data: { ...envelope(3), name: 'notes', filePath: '/tmp/notes.md', size: 18 },
    }, handlers);
    const deleted: ChatStreamEvent = {
      event: CHAT_STREAM_EVENTS.artifactDeleted,
      data: { ...envelope(4), contextId: 'ctx-1', name: 'notes' },
    };
    dispatchChatStreamEvent(deleted, handlers);
    dispatchChatStreamEvent(deleted, handlers);

    expect(onSpawnBranches).toHaveBeenCalledTimes(1);
    expect(onArtifactSaved).toHaveBeenCalledWith('notes', '/tmp/notes.md', 12, undefined);
    expect(onArtifactUpdated).toHaveBeenCalledWith('notes', '/tmp/notes.md', 18, undefined);
    expect(onArtifactDeleted.mock.calls).toEqual([['notes', 'ctx-1']]);
    expect(lastTurnRef.current).toBe('self-turn-1');
    expect(lastSeqRef.current).toBe(4);
  });

  it('shares durable terminal semantics and completion callbacks with foreground turns', () => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onTurnEnd = vi.fn();
    const onStreamComplete = vi.fn();
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef: { current: '' },
      lastSeqRef: { current: -1 },
      onTurnEnd,
      onStreamComplete,
    }).createHandlers();

    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { ...envelope(0), userText: '', selfInitiated: true },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.done,
      data: { ...envelope(1), stopReason: 'end_turn', persisted: true, nodeCompletionSeq: 3, nodeSeenCompletionSeq: 2 },
    }, handlers);

    // The turn and the server's completion counts travel with it (completionFacts.ts).
    expect(dispatch).toHaveBeenCalledWith({
      type: 'done', nodeId: 'node-1', assistantId: 'self-a-1', turnId: 'self-turn-1',
      completion: { completionSeq: 3, seenCompletionSeq: 2 },
    });
    expect(onTurnEnd).toHaveBeenCalledWith('done', 'node-1');
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'cancelled'])('does not announce a turn cancelled elsewhere as finished (stopReason %s)', (stopReason) => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onStreamComplete = vi.fn();
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1', nodeId: 'node-1', dispatch, lastTurnRef: { current: '' }, lastSeqRef: { current: -1 }, onStreamComplete,
    }).createHandlers();
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.turnStart, data: { ...envelope(0), userText: '', selfInitiated: true } }, handlers);
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { ...envelope(1), stopReason, persisted: true } }, handlers);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', aborted: true }));
    expect(onStreamComplete).not.toHaveBeenCalled();
  });

  it('turns an unpersisted terminal frame into the same visible error path', () => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onTurnEnd = vi.fn();
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef: { current: '' },
      lastSeqRef: { current: -1 },
      onTurnEnd,
    }).createHandlers();

    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { ...envelope(0), userText: '', selfInitiated: true },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.done,
      data: { ...envelope(1), stopReason: 'end_turn', persisted: false },
    }, handlers);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', nodeId: 'node-1', assistantId: 'self-a-1',
    }));
    expect(onTurnEnd).toHaveBeenCalledWith('error', 'node-1');
  });
});

describe('the side effects of a background turn', () => {
  const CREDENTIAL_ERROR = 'Run example-login --remote';
  const bind = (cursor?: 'foreground' | 'background') => createBackgroundTurnBinding({
    chatId: 'chat-1', nodeId: 'node-1', dispatch: vi.fn(), lastTurnRef: { current: '' }, lastSeqRef: { current: -1 },
    workspaceId: () => 'p1', ...(cursor ? { cursor } : {}),
  }).createHandlers();
  const turn = (handlers: ReturnType<typeof bind>, id: string, options: { selfInitiated?: boolean; start?: boolean } = {}) => {
    const at = (seq: number) => ({ ...envelope(seq), turnId: id, assistantId: `a-${id}` });
    if (options.start !== false) {
      dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.turnStart, data: { ...at(0), userText: '', ...(options.selfInitiated ? { selfInitiated: true } : {}) } }, handlers);
    }
    return {
      fail: (message: string) => dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.error, data: { ...at(1), message } }, handlers),
      warn: (message: string) => dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.warning, data: { ...at(1), source: 'claude-cli', category: 'runtime', message } }, handlers),
      done: (stopReason = 'end_turn') => dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { ...at(2), stopReason, persisted: true } }, handlers),
    };
  };
  const signInShown = () => getRemoteAuthentication()?.key === 'runtime:sso-remote';
  /** Whether a sign-in the connection still owes would open again: a clean turn forgets it. */
  const signInOwed = () => {
    closeRemoteAuthentication();
    reportRemoteCredentialError('node-1', CREDENTIAL_ERROR);
    const owed = getRemoteAuthentication() === null;
    closeRemoteAuthentication();
    return owed;
  };

  beforeEach(() => {
    setKnownBackendConnections([{ id: 'sso-remote', name: 'Remote', transport: 'ssh', sshHost: 'box', hasToken: true, createdAt: 1, updatedAt: 1 }]);
    indexBackendProjects([{ id: 'p1', backendConnectionId: 'sso-remote', chatIds: ['node-1'] }]);
  });
  afterEach(() => {
    closeRemoteAuthentication(); completeRemoteAuthentication('runtime:sso-remote');
    setKnownBackendConnections([]); indexBackendProjects([]);
  });

  it("asks for remote sign-in on a self-initiated turn's credential error, until a later turn completes cleanly", () => {
    const handlers = bind();
    turn(handlers, 't1', { selfInitiated: true }).fail(CREDENTIAL_ERROR);
    expect(signInShown()).toBe(true);
    expect(signInOwed()).toBe(true);
    const failed = turn(handlers, 't2', { selfInitiated: true });
    failed.warn(CREDENTIAL_ERROR);
    failed.done();
    expect(signInOwed()).toBe(true);
    turn(handlers, 't3', { selfInitiated: true }).done('cancelled');
    expect(signInOwed()).toBe(true);
    turn(handlers, 't4', { selfInitiated: true }).done();
    expect(signInOwed()).toBe(false);
  });

  // foreground: reattached on load; background: the feed resumed past the turn's start.
  it.each(['foreground', 'background'] as const)('asks for sign-in on the credential error of a turn joined mid-way (%s cursor)', cursor => {
    turn(bind(cursor), 't1', { start: false }).fail(CREDENTIAL_ERROR);
    expect(signInShown()).toBe(true);
  });

  it('asks for sign-in on the credential error of a turn another window sent, and clears it when one completes', () => {
    const handlers = bind();
    turn(handlers, 't1').fail(CREDENTIAL_ERROR);
    expect(signInShown()).toBe(true);
    expect(signInOwed()).toBe(true);
    turn(handlers, 't2').done();
    expect(signInOwed()).toBe(false);
  });

  it('refreshes the boards of the workspace a background turn made a task database for', () => {
    resetTurnPageReceiptInvalidationForTests();
    const changed = vi.fn();
    const stop = subscribePageChanges({ backendConnectionId: 'sso-remote' }, changed);
    try {
      const handlers = bind();
      turn(handlers, 't1');
      const output = JSON.stringify({ kind: 'taskDatabase', created: true, databaseId: 'db-t', workspaceId: 'ws-real' });
      dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.toolCall, data: { ...envelope(1), turnId: 't1', assistantId: 'a-t1', toolCallId: 'open-1', title: 'mcp__michi__open_task_database', status: 'in_progress' } }, handlers);
      dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.toolCallUpdate, data: { ...envelope(2), turnId: 't1', assistantId: 'a-t1', toolCallId: 'open-1', title: '', status: 'completed', output } }, handlers);
      expect(changed).toHaveBeenCalledWith({ backendConnectionId: 'sso-remote', workspaceId: 'remote:sso-remote:ws-real', databaseId: 'remote:sso-remote:db-t' });
    } finally { stop(); }
  });
});

describe('a background cursor a replay-gap install moved past the gap', () => {
  it('drops the output its body holds, and still raises and clears an unsequenced permission prompt', () => {
    let nodes: Record<string, ChatNodeState> = {
      'node-1': {
        nodeId: 'node-1', projectId: 'ws', kind: 'chat', chatId: 'chat-1', followUps: [], status: 'streaming',
        activeTurnId: 'self-turn-1', lastAppliedBackgroundTurnId: 'self-turn-1', lastAppliedBackgroundSeq: 20,
        messages: [{ id: 'self-a-1', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true }],
      },
    };
    const dispatch = vi.fn((action: ChatAction) => { nodes = reduceNodes(nodes, action); });
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1', nodeId: 'node-1', dispatch,
      lastTurnRef: { get current() { return nodes['node-1'].lastAppliedBackgroundTurnId ?? ''; }, set current(_value: string) {} },
      lastSeqRef: { get current() { return nodes['node-1'].lastAppliedBackgroundSeq ?? -1; }, set current(_value: number) {} },
    }).createHandlers();
    const permission = { requestId: 7, title: 'Run tests', options: [] };

    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope(13), text: 'in the body' } }, handlers);
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.permissionRequest, data: { ...envelope(14), seq: undefined, ...permission } }, handlers);
    expect(nodes['node-1'].pendingPermission?.requestId).toBe(7);
    expect(nodes['node-1'].lastAppliedBackgroundSeq).toBe(20);
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.permissionResolved, data: { ...envelope(15), seq: undefined, requestId: 7 } }, handlers);
    expect(nodes['node-1'].pendingPermission).toBeNull();
    // Replaying the prompt and its answer again ends in the same state.
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.permissionRequest, data: { ...envelope(14), seq: undefined, ...permission } }, handlers);
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.permissionResolved, data: { ...envelope(15), seq: undefined, requestId: 7 } }, handlers);
    expect(nodes['node-1'].pendingPermission).toBeNull();
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope(21), text: 'new output' } }, handlers);

    expect(dispatch.mock.calls.filter(([action]) => action.type === 'chunk').map(([action]) => (action as { text: string }).text))
      .toEqual(['new output']);
    expect(nodes['node-1'].lastAppliedBackgroundSeq).toBe(21);
  });
});

describe('cancellation settlement from the existing background binding', () => {
  const stops: Array<() => void> = [];
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(fetchStream).mockReset().mockImplementation(async () => new Response(null, { status: 410 }));
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function observe(turnId = 'self-turn-1', chatId = 'chat-1') {
    const status = vi.fn();
    stops.push(cancelChatAndObserve(chatId, turnId, status));
    return status;
  }

  function background() {
    return createBackgroundTurnBinding({
      chatId: 'chat-1', nodeId: 'node-1', dispatch: vi.fn(),
      lastTurnRef: { current: '' }, lastSeqRef: { current: -1 },
    }).createHandlers();
  }

  it('retries 410 without claiming success, then reports unconfirmed at 30 seconds', async () => {
    const status = observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(fetchStream).mock.calls.length).toBeGreaterThan(1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'pending' }));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(status.mock.calls.map(([value]) => value.state)).toEqual(['pending', 'error']);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringMatching(/not be confirmed/i) }));
    for (const [url] of vi.mocked(fetchStream).mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/chats/chat-1/stream');
      expect(parsed.searchParams.get('fromTurnId')).toBe('self-turn-1');
    }
    const requests = vi.mocked(fetchStream).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStream).toHaveBeenCalledTimes(requests);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('settles fast background cancellation exactly once without a pending flash or another background subscription', async () => {
    const status = observe();
    const handlers = background();
    await vi.advanceTimersByTimeAsync(0);
    const done: ChatStreamEvent = {
      event: CHAT_STREAM_EVENTS.done,
      data: { ...envelope(1), stopReason: 'cancelled', persisted: true },
    };
    dispatchChatStreamEvent(done, handlers);
    dispatchChatStreamEvent(done, handlers);
    expect(status).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status).toHaveBeenCalledTimes(1);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchStream).mock.calls[0][0])).toContain('/chats/chat-1/stream?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chats/chat-1/cancel');
  });

  it.each(['error', 'done-error', 'unpersisted'] as const)('reports background %s as cancellation failure', async (terminal) => {
    const status = observe();
    const handlers = background();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'pending' }));
    const event: ChatStreamEvent = terminal === 'error'
      ? { event: CHAT_STREAM_EVENTS.error, data: { ...envelope(1), message: 'Native cleanup failed' } }
      : { event: CHAT_STREAM_EVENTS.done, data: {
          ...envelope(1), stopReason: terminal === 'done-error' ? 'error' : 'cancelled',
          persisted: terminal !== 'unpersisted',
        } };
    dispatchChatStreamEvent(event, handlers);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }));
    if (terminal === 'error') expect(status).toHaveBeenLastCalledWith({ state: 'error', detail: 'Native cleanup failed' });
    const requests = vi.mocked(fetchStream).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status.mock.calls.map(([value]) => value.state)).toEqual(['pending', 'error']);
    expect(fetchStream).toHaveBeenCalledTimes(requests);
  });

  it('cannot settle a replacement observer using an old turn or another chat', async () => {
    const oldStatus = observe('old-turn');
    const newStatus = observe('self-turn-1');
    settleCancellationObservation('chat-1', 'old-turn', { state: 'error', detail: 'old cleanup' });
    settleCancellationObservation('another-chat', 'self-turn-1', { state: 'settled' });
    expect(oldStatus).not.toHaveBeenCalled();
    expect(newStatus).not.toHaveBeenCalled();
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: {
      ...envelope(1), stopReason: 'cancelled', persisted: true,
    } }, background());
    expect(newStatus).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(oldStatus).not.toHaveBeenCalled();
    expect(newStatus).toHaveBeenCalledTimes(1);
  });

  it('accepts a background terminal before the cancel response without opening replay later', async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const status = observe();
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: {
      ...envelope(1), stopReason: 'cancelled', persisted: true,
    } }, background());
    expect(status).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    release(new Response('{}', { status: 200 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStream).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
  });
});


it.each(['foreground', 'background'] as const)('preserves durable fields through delayed %s observer replay and hydration', cursor => {
  const initial = () => createDurableTurn({ turnId: 'self-turn-1', assistantId: 'self-a-1', nodeId: 'node-1', workspaceId: 'ws', displayUserText: 'ask', startedAt: 1 });
  const frames: ChatStreamEvent[] = [
    { event: 'tool_call', data: { ...envelope(1), toolCallId: 'read', title: 'Read', status: 'running', observedAt: 100 } },
    { event: 'tool_call_update', data: { ...envelope(2), toolCallId: 'read', title: '', status: 'completed', observedAt: 700, inputJson: '{"path":"a"}', output: 'done' } },
    { event: 'user_input_request', data: { ...envelope(3), requestId: 1, interactionId: 'interaction-1', questions: [{ id: 'question-1', question: 'Continue?', options: [], multiSelect: false }] } },
    { event: 'user_input_resolved', data: { ...envelope(4), requestId: 1, interactionId: 'interaction-1', answers: [{ id: 'question-1', question: 'Continue?', answer: 'Yes' }], outcome: 'answered' } },
    { event: 'usage_summary', data: { ...envelope(5), source: 'estimated', charge: { amount: 0.0123, unit: 'USD', provenance: 'sdk_estimate' } } },
    { event: 'warning', data: { ...envelope(6), source: 'anthropic-api', category: 'provider', message: 'Retrying' } },
    { event: 'error', data: { ...envelope(7), message: 'Durability failed', code: 'turn_persistence_failed', recoverable: true, completedAt: 800 } },
  ];
  const expected = frames.reduce(applyTurnEvent, initial());
  let state: Record<string, ChatNodeState> = { 'node-1': { nodeId: 'node-1', chatId: 'chat-1', projectId: 'ws', kind: 'chat', status: 'streaming', activeTurnId: 'self-turn-1', messages: [{ id: 'self-a-1', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: 1 }], followUps: [] } };
  const now = vi.spyOn(Date, 'now').mockReturnValue(9_000_000);
  try {
    const handlers = createBackgroundTurnBinding({ chatId: 'chat-1', nodeId: 'node-1', cursor, dispatch: action => { state = reduceNodes(state, action); }, lastTurnRef: { current: '' }, lastSeqRef: { current: -1 } }).createHandlers();
    for (const frame of frames) { dispatchChatStreamEvent(frame, handlers); dispatchChatStreamEvent(frame, handlers); }
  } finally { now.mockRestore(); }
  const message = state['node-1'].messages[0];
  expect(message.blocks).toEqual(expected.assistantMessage.blocks);
  expect(message.toolCalls).toEqual(expected.assistantMessage.toolCalls);
  expect(message.usageSummary?.charge).toEqual(expected.assistantMessage.metadata?.usageSummary?.charge);
  expect(message.warnings?.[0]).toMatchObject({ source: 'anthropic-api', category: 'provider' });
  expect(state['node-1']).toMatchObject({ errorKind: 'turn_persistence_failed', errorRecoverable: true, errorCompletedAt: 800 });
  const hydrated = mapMessageRow({ id: message.id, node_id: 'node-1', role: 'assistant', content: '', seq: 1, created_at: 1, blocks: JSON.stringify(message.blocks), tool_calls: JSON.stringify(message.toolCalls), metadata: JSON.stringify({ usageSummary: message.usageSummary, warnings: message.warnings }) });
  expect(hydrated.blocks).toEqual(message.blocks);
  expect(hydrated.toolCalls).toEqual(message.toolCalls);
  expect(hydrated.usageSummary?.charge?.unit).toBe('USD');
});

it('does not attach an older assistant usage, warning or question to the latest reply', () => {
  let state: Record<string, ChatNodeState> = { n: { nodeId: 'n', chatId: 'chat', projectId: 'ws', kind: 'chat', status: 'streaming', activeTurnId: 'new-turn', messages: [
    { id: 'old', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: false },
    { id: 'new', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true },
  ], followUps: [] } };
  state = reduceNodes(state, { type: 'usage-summary', nodeId: 'n', assistantId: 'old', charge: { amount: 1, unit: 'USD', provenance: 'sdk_estimate' } });
  state = reduceNodes(state, { type: 'warning', nodeId: 'n', assistantId: 'old', warning: { source: 'claude-cli', category: 'runtime', message: 'old warning' } });
  state = reduceNodes(state, { type: 'user-input-request', nodeId: 'n', assistantId: 'old', userInput: { requestId: 1, interactionId: 'old-input', questions: [], answers: [] } });
  expect(state.n.messages[1]).toMatchObject({ id: 'new', blocks: [] });
  expect(state.n.messages[1].warnings).toBeUndefined();
  expect(state.n.messages[1].usageSummary).toBeUndefined();
  expect(state.n.pendingUserInput).toBeUndefined();
  expect(state.n.usageSummary).toBeUndefined();
});
