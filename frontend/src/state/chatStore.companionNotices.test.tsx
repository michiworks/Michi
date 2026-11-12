/**
 * DESIGN-v2 §1.2, §1.5, §3.3 in the real chat store: the agent's conversation
 * V notifies like any other conversation, under its name, through the
 * attention policy (services/attention/policy.ts); its own posts and
 * first-run narration never raise a chat notification; the panel showing V
 * counts as in view; and every reveal of a node in the assistant's workspace
 * opens the panel instead of a pane.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-cn-${++i}`); })(),
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
  getSavedTurn: vi.fn(async () => null),
}));
vi.mock('../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../services/attention/policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/attention/policy')>()),
  presentAttention: vi.fn(),
}));

import * as api from '../services/api';
import { dispatchChatStreamEvent } from '../services/chatStreamEvents';
import { presentAttention, type AttentionIntent } from '../services/attention/policy';
import { ChatProvider, isAssistantConversation, isCompanionSelfMessage, useChatActions, useChatNodesSnapshot, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';
import { resetUserWorkspaceForTests } from './assistant/userWorkspace';
import { resetCompanionStoreForTests, type CompanionAssistantState } from './companion/companionStore';
import { getCompanionPanelState, resetCompanionPanelForTests } from './companion/companionPanel';
import { DEFAULT_COMPANION_SETTINGS } from 'michi-shared';
import { companionSnapshot } from '../test/companionFixtures';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const mockStream = api.streamMessage as unknown as ReturnType<typeof vi.fn>;
const mockPresentAttention = vi.mocked(presentAttention);
const lastIntent = (): AttentionIntent => mockPresentAttention.mock.calls.at(-1)![0];
const intents = (): AttentionIntent[] => mockPresentAttention.mock.calls.map(([intent]) => intent);

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
  let userId = '';
  await act(async () => { userId = await view.result.current.store.createProject('Work', '/work'); });
  let threadId = '';
  act(() => { threadId = view.result.current.store.createThread()!; });
  act(() => { view.result.current.actions.installWorkspaceSnapshot(SYSTEM); });
  await waitFor(() => expect(view.result.current.nodes['n-sys']).toBeTruthy());
  return { ...view, userId, threadId };
}

/** The agent named `name`, its conversation known, the panel as given. */
function agent(name: string, panel: { open: boolean; tab?: 'chat' | 'today' }) {
  const settings = { ...structuredClone(DEFAULT_COMPANION_SETTINGS), displayName: name };
  act(() => {
    resetCompanionStoreForTests({ availability: 'available', snapshot: companionSnapshot({ settings }), assistant: ASSISTANT });
    resetCompanionPanelForTests({ open: panel.open, tab: panel.tab ?? 'chat' });
  });
}

/** One frame of V's background feed (a turn this window didn't start). */
function frame(event: Parameters<typeof dispatchChatStreamEvent>[0]) {
  const handlersForChat = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![0];
  dispatchChatStreamEvent(event, handlersForChat('n-sys', 'n-sys'));
}

/** A whole self turn in V with this id: turn_start → chunk → done. */
function selfTurn(id: string, text: string) {
  act(() => {
    frame({ event: 'turn_start', data: { chatId: 'n-sys', nodeId: 'n-sys', turnId: id, assistantId: id, seq: 0, userText: '', selfInitiated: true } });
    frame({ event: 'chunk', data: { chatId: 'n-sys', nodeId: 'n-sys', turnId: id, assistantId: id, seq: 1, text } });
    frame({ event: 'done', data: { chatId: 'n-sys', nodeId: 'n-sys', turnId: id, assistantId: id, seq: 2, persisted: true, stopReason: 'end_turn' } });
  });
}

beforeEach(() => {
  localStorage.clear();
  mockPresentAttention.mockReset();
  mockStream.mockClear();
  resetUserWorkspaceForTests();
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => { resetCompanionStoreForTests(); resetCompanionPanelForTests(); });
});

describe('the agent’s conversation in the chat store', () => {
  it('asks under the agent’s name, counts the panel showing it as in view, and reveals in the panel', async () => {
    const { result, userId } = await mountWithAssistant();
    agent('Robin', { open: true });
    act(() => { result.current.store.sendMessage('n-sys', 'Archive the chat-only threads'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    mockPresentAttention.mockClear();
    const handlers = mockStream.mock.calls[0][2] as { onUserInputRequest: (data: unknown) => void };
    const ask = (requestId: number) => act(() => {
      handlers.onUserInputRequest({ requestId, questions: [{ question: 'Send it to S7?', options: [], multiSelect: false }] });
    });

    // The policy stays quiet while the panel shows V on Chat.
    ask(1);
    expect(lastIntent()).toMatchObject({ kind: 'needs_input', title: 'Robin: has a question', body: 'Send it to S7?' });
    expect(lastIntent().isTargetVisible!()).toBe(true);
    // On Today the conversation is not in view.
    act(() => resetCompanionPanelForTests({ open: true, tab: 'today' }));
    ask(2);
    expect(lastIntent()).toMatchObject({ kind: 'needs_input', title: 'Robin: has a question', body: 'Send it to S7?' });
    expect(lastIntent().isTargetVisible!()).toBe(false);

    act(() => resetCompanionPanelForTests({ open: false }));
    ask(3);
    expect(mockPresentAttention).toHaveBeenCalledTimes(3);
    expect(lastIntent().isTargetVisible!()).toBe(false);
    act(() => { lastIntent().onOpen!(); });
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
    expect(result.current.store.activeProject?.id).toBe(userId);
    expect(result.current.store.openPanes).not.toContain('n-sys');
  });

  it('asks for an approval V needs under the agent’s name, and any other conversation under its own', async () => {
    const { result, threadId } = await mountWithAssistant();
    agent('Robin', { open: true });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => { result.current.store.sendMessage('n-sys', 'Run the tests'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    const assistant = mockStream.mock.calls[0][2] as { onPermissionRequest: (data: unknown) => void };
    mockPresentAttention.mockClear();
    act(() => { assistant.onPermissionRequest({ requestId: 1, title: 'Bash: npm test', toolCallId: 't1', options: [] }); });
    expect(lastIntent()).toMatchObject({ kind: 'needs_input', title: 'Robin: needs your approval', body: 'Bash: npm test' });
    act(() => { lastIntent().onOpen!(); });
    expect(getCompanionPanelState().open).toBe(true);

    // Any other conversation keeps its own title.
    act(() => { result.current.store.sendMessage(threadId, 'Run them here'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    const thread = mockStream.mock.calls[1][2] as { onPermissionRequest: (data: unknown) => void };
    mockPresentAttention.mockClear();
    act(() => { thread.onPermissionRequest({ requestId: 2, title: 'Bash: npm test', toolCallId: 't2', options: [] }); });
    expect(lastIntent()).toMatchObject({ kind: 'needs_input', title: 'Tool approval needed', body: 'Bash: npm test' });
  });

  it('says "<name> replied" for an answer in V, in view while the panel shows it', async () => {
    const { result } = await mountWithAssistant();
    agent('Robin', { open: true });
    act(() => { result.current.store.sendMessage('n-sys', 'What is stalled?'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(1));
    mockPresentAttention.mockClear();
    const first = mockStream.mock.calls[0][2] as { onDone: () => void };
    act(() => { first.onDone(); });
    expect(lastIntent()).toMatchObject({ kind: 'finished', title: 'Robin replied' });
    expect(lastIntent().isTargetVisible!()).toBe(true);

    act(() => resetCompanionPanelForTests({ open: false }));
    act(() => { result.current.store.sendMessage('n-sys', 'And now?'); });
    await waitFor(() => expect(mockStream).toHaveBeenCalledTimes(2));
    const second = mockStream.mock.calls[1][2] as { onDone: () => void };
    act(() => { second.onDone(); });
    expect(lastIntent()).toMatchObject({ kind: 'finished', title: 'Robin replied' });
    expect(lastIntent().isTargetVisible!()).toBe(false);
  });

  it('raises no chat notification for a check-in’s post or first-run narration, but does for any other turn in V', async () => {
    await mountWithAssistant();
    agent('Robin', { open: false });
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalled());
    mockPresentAttention.mockClear();
    selfTurn('cmp-post-r1', 'Updated Tasks (3 changes).');
    selfTurn('mna-start-1', 'Taking a first look at your pages.');
    expect(intents().filter((intent) => intent.kind === 'finished')).toEqual([]);
    // A turn the backend started in V for another reason still says it replied.
    selfTurn('self-n-sys-rerun', 'Here is the rest.');
    expect(intents().filter((intent) => intent.kind === 'finished')).toEqual([
      expect.objectContaining({ title: 'Robin replied', key: 'node:n-sys' }),
    ]);
  });
});

describe('isAssistantConversation / isCompanionSelfMessage', () => {
  it('knows V by its workspace, by the agent’s id before it loads, and every check-in node', () => {
    const projects = [{ system: 'assistant' as const, chatIds: ['n-v', 'n-old'] }, { system: undefined, chatIds: ['n-user'] }];
    expect(isAssistantConversation(projects, 'n-v')).toBe(true);
    expect(isAssistantConversation(projects, 'n-old')).toBe(true);
    expect(isAssistantConversation(projects, 'n-user')).toBe(false);
    expect(isAssistantConversation(projects, 'n-cmph-r1')).toBe(true);
    expect(isAssistantConversation([], 'n-sys')).toBe(false);
    act(() => resetCompanionStoreForTests({ assistant: ASSISTANT }));
    expect(isAssistantConversation([], 'n-sys')).toBe(true);
    expect(isAssistantConversation([], '')).toBe(false);
  });

  it('tells the agent’s own messages from replies', () => {
    expect(isCompanionSelfMessage({ id: 'cmp-post-r1', role: 'assistant' })).toBe(true);
    expect(isCompanionSelfMessage({ id: 'mna-end-5', role: 'assistant' })).toBe(true);
    expect(isCompanionSelfMessage({ id: 'x', role: 'assistant', companionPost: { runId: 'r', kind: 'heartbeat', changes: [] } as never })).toBe(true);
    expect(isCompanionSelfMessage({ id: 'a-n-sys-1', role: 'assistant' })).toBe(false);
    expect(isCompanionSelfMessage({ id: 'cmp-post-r1', role: 'user' })).toBe(false);
    expect(isCompanionSelfMessage(undefined)).toBe(false);
  });
});
