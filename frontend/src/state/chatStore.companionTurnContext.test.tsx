/**
 * F1a-review #1 in the real chat store: what a message to the agent's
 * conversation V refers to (metaAgentContext.refs, DESIGN-v2 §2.8 T4) is read
 * when the user sends it and goes with that message: a send queued while V
 * answers still carries it after the panel closed, queued sends combined
 * carry all of theirs, and a retry or an edit sends the original's again
 * without taking what the user's next send is about to carry.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-tc-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChatAndObserve: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  ensureSession: vi.fn(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' })),
  streamMessage: vi.fn(() => () => {}),
  steerChat: vi.fn(async () => ({ accepted: true })),
  getSavedTurn: vi.fn(async () => null),
}));
vi.mock('../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../services/api/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api/assistant')>()),
  fetchAssistant: vi.fn(() => new Promise(() => {})),
}));
const metaAgent = vi.hoisted(() => ({ refresh: vi.fn(async () => {}) }));
vi.mock('./metaAgent/useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./metaAgent/useMetaAgent')>()),
  refreshMetaAgent: metaAgent.refresh,
}));

import * as api from '../services/api';
import { metaAgentTurnContextFor } from '../services/api/assistant';
import type { MetaAgentChatTurnContext } from 'michi-shared';
import { ChatProvider, isCompanionSelfMessage, revealInCompanionPanel, useChatActions, useChatNodesSnapshot, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';
import { resetUserWorkspaceForTests } from './assistant/userWorkspace';
import { addAssistantAttachments, noteAssistantContextSent, resetAssistantComposerForTests } from './assistant/assistantComposer';
import { resetCompanionStoreForTests, type CompanionAssistantState } from './companion/companionStore';
import { closeCompanionPanel, getCompanionPanelState, resetCompanionPanelForTests } from './companion/companionPanel';
import { getSourceNavState, openConversationFromSpaces, registerSourceNavigator, resetSourceNavForTests } from './sourceNav/sourceNav';
import { noteCompanionPostReply, resetCompanionRepliesForTests, takeCompanionPostReply } from './companion/companionReply';
import { resetCompanionScreenForTests } from './companion/companionScreen';
import { ensureCompanionTurnSource } from './companion/companionTurnSource';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

ensureCompanionTurnSource();

const mockStream = api.streamMessage as unknown as ReturnType<typeof vi.fn>;
/** What each request to the agent's conversation carried, read as stream.ts reads it when it builds the request. */
let sent: Array<MetaAgentChatTurnContext | undefined> = [];

const SYSTEM = {
  workspace: { id: 'sys', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }) },
  trees: [{ id: 't-sys', root_node_id: 'n-sys', last_active_at: 1 }],
  nodes: [{ id: 'n-sys', created_at: 1 }],
  edges: [],
  messages: [],
};
const runs = { runtimeId: 'claude' as const, providerId: null, modelId: null, reasoning: null };
const ASSISTANT: CompanionAssistantState = {
  status: 'ready', error: null,
  info: { nodeId: 'n-sys', workspaceId: 'sys', treeId: 't-sys', settings: runs, conversation: runs, supportedRuntimes: ['claude'] },
};

function useHarness() {
  return { store: useChatStore(), actions: useChatActions(), nodes: useChatNodesSnapshot() };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <PrefsProvider><ChatProvider>{children}</ChatProvider></PrefsProvider>;
}

async function mountWithAssistant() {
  const view = renderHook(() => useHarness(), { wrapper });
  await waitFor(() => expect(view.result.current.store.hydrated).toBe(true));
  await act(async () => { await view.result.current.store.createProject('Work', '/work'); });
  act(() => { view.result.current.actions.installWorkspaceSnapshot(SYSTEM); });
  await waitFor(() => expect(view.result.current.nodes['n-sys']).toBeTruthy());
  act(() => {
    resetCompanionStoreForTests({ availability: 'available', assistant: ASSISTANT });
    resetCompanionPanelForTests({ open: true, tab: 'chat' });
  });
  return view;
}

type Handlers = { onDone: (...args: unknown[]) => void; onError: (...args: unknown[]) => void };
const handlersOf = (call: number) => mockStream.mock.calls[call][2] as Handlers;
const userMetadataOf = (call: number) => (mockStream.mock.calls[call][3] as { userMetadata?: Record<string, unknown> }).userMetadata;

/** The chips the user handed over and sent (what TPane does as the composer's send goes out). */
function sendChips(items: Parameters<typeof addAssistantAttachments>[1]) {
  addAssistantAttachments('n-sys', items);
  noteAssistantContextSent('n-sys');
}

const queued = (id: string, value: string) => ({ id, value, mentions: [], attachments: [], queuedAt: Date.now() });

beforeEach(() => {
  localStorage.clear();
  sent = [];
  mockStream.mockReset();
  mockStream.mockImplementation((nodeId: string) => {
    sent.push(metaAgentTurnContextFor(nodeId));
    return () => {};
  });
  resetUserWorkspaceForTests();
  resetAssistantComposerForTests();
  resetCompanionRepliesForTests();
  resetCompanionScreenForTests();
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => { resetCompanionStoreForTests(); resetCompanionPanelForTests(); });
});

describe('what a message to the agent refers to goes with it (F1a-review #1)', () => {
  it('sends a queued message’s refs after the panel closed, every queued send’s refs when they combine', async () => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.store.sendMessage('n-sys', 'Tidy my pages'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    expect(sent[0]).toBeUndefined();

    // While V answers: a Today item handed over, then rows and a reply to a post, each queued.
    act(() => {
      sendChips([{ kind: 'companion_item', id: 'i1', title: 'CR 1' }]);
      result.current.actions.queueMessage('n-sys', queued('q1', 'What about this?'));
      sendChips([{ kind: 'row', id: 'db2:r9', title: 'Row' }]);
      noteCompanionPostReply('n-sys', 'cmp-post-r1');
      result.current.actions.queueMessage('n-sys', queued('q2', 'And that check-in?'));
    });
    // The panel closes (the Chat tab unmounts) before V's turn ends.
    act(() => { closeCompanionPanel(); });
    metaAgent.refresh.mockClear();
    act(() => { handlersOf(0).onDone('end_turn', undefined, 'turn-1', true, Date.now()); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    // The turn's end re-reads the Pages upkeep's state, panel shown or not (F1a-review #7).
    expect(metaAgent.refresh).toHaveBeenCalled();

    const refs = [
      { kind: 'companion_item', itemId: 'i1' },
      { kind: 'rows', databaseId: 'db2', rowIds: ['r9'] },
      { kind: 'post', messageId: 'cmp-post-r1' },
    ];
    expect(sent[1]?.refs).toEqual(refs);
    // Kept on the stored row, so a retry after a reload still sends them.
    expect(userMetadataOf(1)?.companionRefs).toEqual(refs);
  });

  it('steers a queued message into the running turn with the refs it was queued with (T4 on steer)', async () => {
    const { result } = await mountWithAssistant();
    act(() => { result.current.store.sendMessage('n-sys', 'Tidy my pages'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    act(() => {
      noteCompanionPostReply('n-sys', 'cmp-post-r1');
      result.current.actions.queueMessage('n-sys', queued('q1', 'And that check-in?'));
    });
    const steer = vi.mocked(api.steerChat);
    steer.mockClear();
    await act(async () => { await result.current.actions.steerMessage('n-sys', 'And that check-in?', { queueId: 'q1' }); });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]![3]).toMatchObject({ refs: [{ kind: 'post', messageId: 'cmp-post-r1' }] });
    // The reply went with the queued message: the next send does not take it again.
    expect(takeCompanionPostReply('n-sys')).toBeNull();
  });

  it('retries and edits with the original refs, without taking the next send’s reply', async () => {
    const { result } = await mountWithAssistant();
    act(() => {
      sendChips([{ kind: 'row', id: 'db1:r1', title: 'Row' }]);
      result.current.store.sendMessage('n-sys', 'Look at this row');
    });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    expect(sent[0]?.refs).toEqual([{ kind: 'rows', databaseId: 'db1', rowIds: ['r1'] }]);
    act(() => { handlersOf(0).onError('connection dropped'); });
    await waitFor(() => expect(result.current.nodes['n-sys']?.status).toBe('error'));

    // A post's chip filled the composer for the user's next message meanwhile.
    noteCompanionPostReply('n-sys', 'cmp-post-r7');
    act(() => { result.current.store.retryLastTurn('n-sys'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    expect(sent[1]?.refs).toEqual([{ kind: 'rows', databaseId: 'db1', rowIds: ['r1'] }]);
    act(() => { handlersOf(1).onDone('end_turn', undefined, 'turn-2', true, Date.now()); });
    await waitFor(() => expect(result.current.nodes['n-sys']?.status).not.toBe('streaming'));

    const userIndex = result.current.nodes['n-sys']!.messages.findIndex((message) => message.role === 'user');
    act(() => { void result.current.store.editAndResend('n-sys', userIndex, 'Look at this row again'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(3));
    expect(sent[2]?.refs).toEqual([{ kind: 'rows', databaseId: 'db1', rowIds: ['r1'] }]);
    // The reply the user is about to send is still theirs.
    expect(takeCompanionPostReply('n-sys')).toBe('cmp-post-r7');
  });
});

describe('the agent’s own messages and reveals into the panel', () => {
  it('counts only posts (the shared cmp-post- contract) and narration as the agent’s own (F1b-review #7)', () => {
    const assistant = (id: string) => ({ id, role: 'assistant' as const });
    expect(isCompanionSelfMessage(assistant('cmp-post-r1'))).toBe(true);
    expect(isCompanionSelfMessage(assistant('mna-1'))).toBe(true);
    // A check-in's own turn id never names a message of V.
    expect(isCompanionSelfMessage(assistant('cmp-r1'))).toBe(false);
    expect(isCompanionSelfMessage(assistant('cmp-post-'))).toBe(false);
    expect(isCompanionSelfMessage({ id: 'cmp-post-r1', role: 'user' })).toBe(false);
  });

  it('turns a source jump into V into the panel showing the message, with no Back bar left (F1b-review #6)', async () => {
    resetSourceNavForTests();
    resetCompanionStoreForTests({ assistant: ASSISTANT });
    resetCompanionPanelForTests();
    const projects = [{ system: 'assistant' as const, chatIds: ['n-sys'] }];
    registerSourceNavigator({
      currentOrigin: () => ({ kind: 'page', backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', title: 'Plan' }),
      reveal: async (_workspaceId, nodeId) => revealInCompanionPanel(projects, nodeId),
      returnTo: () => {},
    });
    await act(async () => {
      expect(await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'sys', nodeId: 'n-sys', messageId: 'cmp-post-r1' })).toBe(true);
    });
    expect(getSourceNavState()).toMatchObject({ back: null, reference: null, focus: null });
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', focusMessage: { id: 'cmp-post-r1' } });
    resetSourceNavForTests();
  });
});
