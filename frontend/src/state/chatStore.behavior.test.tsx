/**
 * Feature 5: Auto-branch on streaming — real behavior test (Task 5.4).
 *
 * Renders ChatProvider and invokes sendMessage / createChildChat on nodes in
 * different statuses, verifying that the services/api mock's streamMessage is
 * (or is not) called. Stronger than the pure-function contract tests in
 * chatStore.test.ts because it exercises the real reducer + useCallback
 * wiring inside the provider.
 *
 * Mock note: Jest 27 + CRA babel-jest had a quirk where `jest.fn(impl)` called
 * inside a `jest.mock` factory silently dropped the implementation. The verbose
 * pattern below (non-spied fns as plain arrows, spied fns as vi.fn()) is a
 * historical workaround preserved during the vitest migration; it can be
 * simplified in a follow-up commit since vitest has no equivalent quirk.
 */
import React from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  // Non-spied: plain arrow that returns what the provider expects.
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  reattachTurnReplay: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  cancelChatAndObserve: vi.fn(() => () => {}),
  getSavedTurn: vi.fn(async () => null),
  postArtifactWatchPaths: async () => ({ ok: true }),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchWorkspace: vi.fn(),
  fetchWorkspaceStructure: vi.fn(),
  fetchTreeMessagePage: vi.fn(),
  fetchTreeMessageSnapshot: vi.fn(),
  fetchNodeWorkspace: vi.fn(async () => null),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  // Spied: implementation set in beforeEach.
  bindPendingPrimaryAgent: vi.fn(),
  ensureSession: vi.fn(),
  streamMessage: vi.fn(),
  steerChat: vi.fn(),
}));

vi.mock('../services/attention/policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/attention/policy')>(),
  presentAttention: vi.fn(),
  dismissAttention: vi.fn(),
}));
vi.mock('../services/api/sessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api/sessions')>(),
  executeChatCommand: vi.fn(),
}));
vi.mock('../services/digestApi', () => ({
  streamDigest: vi.fn(async () => '# Decisions\n\nKeep the source thread context.'),
}));
vi.mock('../services/api/skills', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api/skills')>(),
  fetchSkillCatalog: vi.fn(),
}));
// The history reader (useMessageHistory) reads pages here, not through ../services/api.
vi.mock('../services/api/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api/persistence')>();
  return { ...actual, fetchTreeMessagePage: vi.fn(actual.fetchTreeMessagePage) };
});

import * as api from '../services/api';
import * as persistence from '../services/api/persistence';
import { dismissAttention, presentAttention, type AttentionIntent } from '../services/attention/policy';
import { setPanePresenceDashboardVisible } from './panePresenceVisibility';
import { ChatProvider, useChatStore, useChatNode, useChatNodesSnapshot } from './chatStore';
import { PrefsProvider } from './prefs';
import type { ChatNodeState } from './chatTypes';
import { dispatchChatStreamEvent } from '../services/chatStreamEvents';
import { ensureSession as ensureSessionRequest, executeChatCommand } from '../services/api/sessions';
import { turnErrorAction } from './turnErrorRecovery';
import { receiveServerAttentionFrame, resetServerAttentionStore } from '../services/serverAttentionStore';
import { onOpenCompanionTargetRequest, onOpenScheduledRunRequest } from './attentionOpenRequests';
import { agentRunPaneId } from './paneItems';
import { fetchSkillCatalog } from '../services/api/skills';
import { loadSkillCatalog, readSkillCatalog, resetSkillCatalogs } from './skillCatalog';
import { joinMessageParts } from '../lib/commentFormat';
import { appendAttachmentsSentinel } from '../lib/composerAttachments';
import { encodeNodeMentionToken } from '../lib/nodeMentionTokens';
import { getSourceNavState, resetSourceNavForTests } from './sourceNav/sourceNav';
import type { SkillCatalogResponse } from 'michi-shared';

/** What GET /skills/catalog lists for Claude: the commands its SDK bridge runs. */
const CLAUDE_COMMANDS = [{ name: 'status' }, { name: 'model', argumentHint: '<model>' }];
const loadClaudeCommands = () => act(async () => { await loadSkillCatalog('cancel-ws', 'claude'); });

function useStoreAndNodes() {
  const store = useChatStore();
  const nodes = useChatNodesSnapshot();
  return { store, nodes };
}

const mockEnsureSession = api.ensureSession as ReturnType<typeof vi.fn>;
const mockStreamMessage = api.streamMessage as ReturnType<typeof vi.fn>;
const mockPresentAttention = vi.mocked(presentAttention);

/** The intents of one kind handed to the attention policy, oldest first. */
function attentionIntents(kind: AttentionIntent['kind']): AttentionIntent[] {
  return mockPresentAttention.mock.calls.map(([intent]) => intent).filter((intent) => intent.kind === kind);
}

/** Whether the intent reports its node visible while this window shows the Dashboard. */
function visibleOnDashboard(intent: AttentionIntent): boolean {
  setPanePresenceDashboardVisible(true);
  try {
    return intent.isTargetVisible!();
  } finally {
    setPanePresenceDashboardVisible(false);
  }
}

// Stub matchMedia — jsdom lacks it and some hooks probe for it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

function assistantAnswerRaw(node: ChatNodeState | undefined): string {
  const assistant = node?.messages.find((m) => m.role === 'assistant');
  return (assistant?.blocks ?? [])
    .filter((b) => b.kind === 'answer')
    .map((b) => b.rawText)
    .join('');
}

describe('auto-branch behavior (real provider)', () => {
  beforeEach(() => {
    mockEnsureSession.mockReset();
    mockStreamMessage.mockReset();
    vi.mocked(api.steerChat).mockReset();
    mockPresentAttention.mockReset();
    vi.mocked(dismissAttention).mockReset();
    vi.mocked(api.cancelChatAndObserve).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.subscribeChat).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.reattachTurnReplay).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.subscribeBackground).mockReset().mockImplementation(() => () => {});
    vi.mocked(api.fetchAllWorkspacesMeta).mockReset().mockResolvedValue([]);
    vi.mocked(api.fetchWorkspace).mockReset();
    vi.mocked(api.fetchWorkspaceStructure).mockReset().mockResolvedValue(null);
    vi.mocked(api.fetchTreeMessagePage).mockReset().mockResolvedValue({ messages: [] });
    vi.mocked(api.fetchTreeMessageSnapshot).mockReset().mockRejectedValue(new Error('No tree snapshot in this test'));
    vi.mocked(api.fetchNodeWorkspace).mockReset().mockResolvedValue(null);
    vi.mocked(api.fetchTreeMessages).mockReset().mockResolvedValue([]);
    vi.mocked(api.bindPendingPrimaryAgent).mockReset();
    vi.mocked(executeChatCommand).mockReset().mockResolvedValue({ success: true, message: 'Claude is connected.' });
    mockEnsureSession.mockImplementation(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' }));
    // Real streamMessage returns a cancel fn AND starts an async stream. For
    // our guard test we only need it to be callable and return a no-op cancel.
    mockStreamMessage.mockImplementation(() => () => {});
    resetSkillCatalogs();
    vi.mocked(fetchSkillCatalog).mockReset().mockResolvedValue({ skills: [], errors: [], libraryAvailable: true, commands: CLAUDE_COMMANDS });
    localStorage.clear();
  });

  it('validates captured file feedback before mutation and captures only same-tree file origins', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('feedback'); });
    let rootId = '';
    await act(async () => { rootId = (await result.current.store.createThread()) ?? ''; });
    const project = result.current.store.activeProject!;
    const context = { backendConnectionId: project.backendConnectionId ?? 'local', projectId: project.id, treeId: project.activeTreeId!, nodeId: rootId };
    const source = { type: 'artifact' as const, filePath: 'a.md', snapshot: { hashKind: 'sha256-text-utf8' as const, contentHash: 'abc', backendConnectionId: context.backendConnectionId, projectId: project.id, resolvedFilePath: '/a.md' } };
    act(() => {
      expect(result.current.store.addPendingComment(rootId, 'old', 'edit', source, { ...context, backendConnectionId: 'changed-backend' })).toBe(false);
      expect(result.current.store.addPendingComment(rootId, 'old', 'edit', source, { ...context, treeId: 'missing-tree' })).toBe(false);
      expect(result.current.store.addPendingComment('missing', 'old', 'edit', source, context)).toBe(false);
      expect(result.current.store.addPendingComment(rootId, 'old', 'edit', { ...source, snapshot: { ...source.snapshot, projectId: 'other-workspace' } }, context)).toBe(false);
    });
    expect(result.current.nodes[rootId].pendingComments).toBeUndefined();
    act(() => { expect(result.current.store.addPendingComment(rootId, 'old', 'edit', source, context)).toBe(true); });
    expect(result.current.nodes[rootId].pendingComments?.[0].source).toEqual(source);
    act(() => { result.current.store.focusPane(rootId); });
    let paneId = '';
    act(() => { paneId = result.current.store.openFilePane('a.md'); });
    expect(result.current.store.paneItems[paneId]).toMatchObject({ originChatNodeId: rootId });
    act(() => { result.current.store.archiveTree(context.treeId); });
    const before = result.current.nodes[rootId].pendingComments;
    act(() => { expect(result.current.store.addPendingComment(rootId, 'old', 'later', source, context)).toBe(false); });
    expect(result.current.nodes[rootId].pendingComments).toBe(before);
  });

  it.each([false, true])('retains distinct queued file snapshots through flush and retry (success=%s)', async (success) => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('queue feedback'); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    await act(async () => { result.current.store.sendMessage(nodeId, 'first'); });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    const source = (hash: string) => ({ type: 'artifact' as const, filePath: 'a.md', snapshot: { hashKind: 'sha256-text-utf8' as const, contentHash: hash, backendConnectionId: 'local', projectId: result.current.store.activeProject!.id, resolvedFilePath: '/a.md' } });
    const comment = { id: 'c', quotedText: 'old', body: 'fix', createdAt: 1, source: source('comment-hash') };
    act(() => {
      result.current.store.queueMessage(nodeId, { id: 'q1', value: 'one', mentions: [], attachments: [], quotedText: 'version one', quoteSource: source('first-hash'), commentBlock: 'comment-hash context', comments: [comment], queuedAt: 1 });
      result.current.store.queueMessage(nodeId, { id: 'q2', value: 'two', mentions: [], attachments: [], quotedText: 'version two', quoteSource: source('second-hash'), queuedAt: 2 });
      mockStreamMessage.mock.calls[0][2].onDone?.();
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    const [, prompt, handlers, options] = mockStreamMessage.mock.calls[1];
    expect(prompt).toContain('first-hash');
    expect(prompt).toContain('second-hash');
    expect(options.userMetadata.comments).toEqual([comment]);
    expect(options.userMetadata.quotedText).toBeUndefined();
    const savedUser = result.current.nodes[nodeId].messages.filter(message => message.role === 'user').at(-1)!;
    expect(savedUser.text).toContain('first-hash');
    expect(savedUser.text).toContain('second-hash');
    expect(savedUser.quotedText).toBeUndefined();
    expect(savedUser.quoteSource).toBeUndefined();
    if (success) {
      act(() => { handlers.onDone?.(); });
      await act(async () => { result.current.store.retryLastTurn(nodeId); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(3));
      const [, retryPrompt, retryHandlers, retryOptions] = mockStreamMessage.mock.calls[2];
      expect(retryPrompt).toContain('first-hash');
      expect(retryPrompt).toContain('second-hash');
      expect(retryPrompt).toContain('comment-hash');
      expect(retryOptions.userMetadata.quotedText).toBeUndefined();
      expect(retryOptions.userMetadata.comments).toEqual([comment]);
      act(() => { retryHandlers.onDone?.(); });
      return;
    }
    act(() => { handlers.onError('busy', undefined, undefined, 'turn_active'); });
    const draft = result.current.nodes[nodeId].composerDraft!;
    expect(draft.value).toContain('first-hash');
    expect(draft.value).toContain('second-hash');
    expect(draft.value).toContain('comment-hash context');
    expect(draft.quotedText).toBeUndefined();
  });

  it.each([true, false])('keeps a steer request out of queue auto-send and records only accepted input (%s)', async (accepted) => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    await act(async () => { result.current.store.sendMessage(nodeId, 'hello'); });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    const assistantId = result.current.nodes[nodeId].messages.at(-1)!.id;
    act(() => { result.current.store.queueMessage(nodeId, { id: 'q1', value: 'Use cobalt', mentions: [], attachments: [], queuedAt: 1 }); });
    let finish!: (response: Awaited<ReturnType<typeof api.steerChat>>) => void;
    vi.mocked(api.steerChat).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let steering!: Promise<boolean>;
    act(() => { steering = result.current.store.steerMessage(nodeId, 'Use cobalt', { queueId: 'q1', displayText: 'Use cobalt' }); });
    expect(result.current.nodes[nodeId].pendingQueued?.[0].steering).toBe(true);
    const message = { messageId: 's1', text: 'Use cobalt', assistantId, createdAt: 2, queueId: 'q1' };
    const handlers = mockStreamMessage.mock.calls[0][2];
    await act(async () => {
      if (accepted) dispatchChatStreamEvent({ event: 'steer_accepted', data: message }, handlers);
      handlers.onDone();
    });
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ accepted, ...(accepted ? { message } : {}) }); await steering; });
    expect(result.current.nodes[nodeId].messages.filter((m) => m.steered)).toHaveLength(accepted ? 1 : 0);
    expect(result.current.nodes[nodeId].pendingQueued?.length ?? 0).toBe(accepted ? 0 : 1);
    expect(result.current.nodes[nodeId].pendingQueued?.[0]?.steering).not.toBe(true);
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
  });

  it('includes a newly created tree in an immediate first-turn prerequisite', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    let rootId = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
      result.current.store.sendMessage(rootId, 'hello');
    });

    await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledTimes(1));
    const options = mockEnsureSession.mock.calls[0][0] as {
      graphPrerequisite: {
        workspace: { activeTreeId: string | null };
        tree?: { id: string; rootNodeId: string };
        node: { id: string; treeId: string | null };
      };
    };
    const prerequisite = options.graphPrerequisite;

    expect(prerequisite.tree).toEqual(expect.objectContaining({ rootNodeId: rootId }));
    expect(prerequisite.node).toEqual(expect.objectContaining({ id: rootId }));
    expect(prerequisite.node.treeId).toBe(prerequisite.tree?.id);
    expect(prerequisite.workspace.activeTreeId).toBe(prerequisite.tree?.id);
  });

  it.each([
    { lastUsedUpdated: true, reloads: 1 },
    { lastUsedUpdated: false, reloads: 0 },
  ])('reloads agent status after a send only when the remembered model changed ($lastUsedUpdated)', async ({ lastUsedUpdated, reloads }) => {
    mockEnsureSession.mockImplementation(() => Promise.resolve({
      chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh', runtimeId: 'claude', modelId: 'sonnet', lastUsedUpdated,
    }));
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

    const reload = vi.fn();
    window.addEventListener('michi:reload-agent-status', reload);
    try {
      await act(async () => {
        const rootId = (await result.current.store.createThread()) ?? '';
        result.current.store.sendMessage(rootId, 'hello', { runtimeId: 'claude', modelId: 'sonnet' });
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(reload).toHaveBeenCalledTimes(reloads);
    } finally {
      window.removeEventListener('michi:reload-agent-status', reload);
    }
  });

  it('clears the unread focus exemption when the focused pane is closed', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    let rootId = '';
    await act(async () => {
      rootId = await result.current.store.createThread() ?? '';
      result.current.store.setFocusedNodeId(rootId);
    });
    expect(result.current.store.focusedNodeId).toBe(rootId);

    act(() => result.current.store.closePane(rootId));

    expect(result.current.store.focusedPane).toBeNull();
    expect(result.current.store.focusedNodeId).toBeNull();
  });

  it('views the pane that takes the focus of a closed pane, not the last one open', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = await result.current.store.createThread() ?? ''; });
    let firstId = '';
    let secondId = '';
    await act(async () => { firstId = await result.current.store.createBlankChild(rootId); });
    await act(async () => { secondId = await result.current.store.createBlankChild(rootId); });
    let fileId = '';
    act(() => { fileId = result.current.store.openFilePane('src/a.ts'); });
    expect(result.current.store.openPanes).toEqual([rootId, firstId, secondId, fileId]);

    act(() => { result.current.store.focusPane(secondId); });
    act(() => result.current.store.closePane(secondId));
    expect(result.current.store.focusedPane).toBe(firstId);
    expect(result.current.store.focusedNodeId).toBe(firstId);

    act(() => { result.current.store.focusPane(fileId); });
    act(() => result.current.store.closePane(fileId));
    expect(result.current.store.focusedPane).toBe(firstId);
    expect(result.current.store.focusedNodeId).toBe(firstId);
  });

  it('reveals a node in its own thread, scrolled to a message, and refuses an id no workspace holds', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let firstRoot = '';
    await act(async () => { firstRoot = result.current.store.createThread()!; });
    const firstTree = result.current.store.activeProject!.activeTreeId;
    await act(async () => { result.current.store.createThread(); });
    expect(result.current.store.activeProject!.activeTreeId).not.toBe(firstTree);
    resetSourceNavForTests();
    let revealed = false;
    act(() => { revealed = result.current.store.revealNode(firstRoot, { messageId: 'm1' }); });
    expect(revealed).toBe(true);
    expect(result.current.store.activeProject!.activeTreeId).toBe(firstTree);
    expect(result.current.store.focusedPane).toBe(firstRoot);
    expect(getSourceNavState().jump).toMatchObject({ nodeId: firstRoot, messageId: 'm1' });

    act(() => { revealed = result.current.store.revealNode('missing'); });
    expect(revealed).toBe(false);
    expect(result.current.store.openPanes).not.toContain('missing');
  });

  it('reveals a restored thread in its own slot, not in the thread shown after the delete', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let deletedRoot = '';
    await act(async () => { deletedRoot = result.current.store.createThread()!; });
    const deletedTree = result.current.store.activeProject!.activeTreeId!;
    let shownRoot = '';
    await act(async () => { shownRoot = result.current.store.createThread()!; });
    const shownTree = result.current.store.activeProject!.activeTreeId!;
    act(() => { result.current.store.activateTree(deletedTree); });
    act(() => { result.current.store.deleteTree(deletedTree); });
    expect(result.current.store.activeProject!.activeTreeId).toBe(shownTree);

    let restored: string | null = null;
    act(() => { restored = result.current.store.restoreLastDeletion(); });
    expect(restored).toBe(deletedRoot);
    act(() => { result.current.store.revealNode(deletedRoot); });

    expect(result.current.store.activeProject!.activeTreeId).toBe(deletedTree);
    expect(result.current.store.openPanes).toContain(deletedRoot);
    expect(result.current.store.focusedPane).toBe(deletedRoot);
    act(() => { result.current.store.activateTree(shownTree); });
    expect(result.current.store.openPanes).toEqual([shownRoot]);
  });

  it('stops treating the chat as viewed when a link re-opens its already open file pane', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = await result.current.store.createThread() ?? ''; });
    let firstPaneId = '';
    act(() => { result.current.store.setFocusedNodeId(rootId); });
    act(() => { firstPaneId = result.current.store.openFilePane('src/a.ts:10', { parseSourceLocation: true }); });
    expect(result.current.store.focusedNodeId).toBeNull();

    // The second link's mousedown lands on the chat pane first.
    act(() => { result.current.store.setFocusedNodeId(rootId); });
    let secondPaneId = '';
    act(() => { secondPaneId = result.current.store.openFilePane('src/a.ts:50', { parseSourceLocation: true }); });

    expect(secondPaneId).toBe(firstPaneId);
    expect(result.current.store.focusedPane).toBe(firstPaneId);
    expect(result.current.store.focusedNodeId).toBeNull();
  });

  // Ctrl+Tab, a caption or tab, the phone switcher and a caption's zoom all
  // switch panes this way: the chat switched to is the one being viewed.
  it('views the chat a pane switch lands on, and no chat after a switch to another pane', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = await result.current.store.createThread() ?? ''; });
    let childId = '';
    await act(async () => { childId = await result.current.store.createBlankChild(rootId); });
    let fileId = '';
    act(() => { fileId = result.current.store.openFilePane('src/a.ts'); });
    expect(result.current.store.focusedNodeId).toBeNull();

    act(() => { result.current.store.focusPane(rootId); });
    expect(result.current.store.focusedNodeId).toBe(rootId);

    act(() => { result.current.store.focusPane(fileId); });
    expect(result.current.store.focusedPane).toBe(fileId);
    expect(result.current.store.focusedNodeId).toBeNull();

    act(() => { result.current.store.closePane(childId); });
    act(() => { result.current.store.openPane(childId); });
    expect(result.current.store.focusedNodeId).toBe(childId);

    act(() => { result.current.store.zoomPane(fileId); });
    expect(result.current.store.focusedNodeId).toBeNull();
    act(() => { result.current.store.zoomPane(rootId); });
    expect(result.current.store.focusedPane).toBe(rootId);
    expect(result.current.store.focusedNodeId).toBe(rootId);
  });

  it('views the new branch a branch gesture moves the focus to, and keeps the chat a background branch leaves', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = await result.current.store.createThread() ?? ''; });
    expect(result.current.store.focusedNodeId).toBe(rootId);

    let blankId = '';
    await act(async () => { blankId = await result.current.store.createBlankChild(rootId); });
    expect(result.current.store.focusedPane).toBe(blankId);
    expect(result.current.store.focusedNodeId).toBe(blankId);

    let childId = '';
    await act(async () => { childId = await result.current.store.createChildChat(rootId, 'branch off'); });
    expect(result.current.store.focusedPane).toBe(childId);
    expect(result.current.store.focusedNodeId).toBe(childId);

    let tangentId = '';
    await act(async () => { tangentId = await result.current.store.createChildChat(rootId, 'tangent', undefined, { focus: false }); });
    expect(result.current.store.openPanes).toContain(tangentId);
    expect(result.current.store.focusedNodeId).toBe(childId);

    let fanned: string[] = [];
    await act(async () => { fanned = await result.current.store.fanoutBranches(rootId, ['a', 'b']); });
    expect(result.current.store.focusedPane).toBe(fanned[0]);
    expect(result.current.store.focusedNodeId).toBe(fanned[0]);
  });

  it('sendMessage on a streaming node does NOT call streamMessage (guard fires)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
    });

    // First send: idle → streaming. streamMessage is called once.
    await act(async () => {
      result.current.store.sendMessage(rootId, 'hello');
    });
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    mockStreamMessage.mockClear();

    // Second send to the still-streaming node: guard fires, no call.
    await act(async () => {
      result.current.store.sendMessage(rootId, 'second message');
    });
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sendMessage called on streaming node'),
    );

    warnSpy.mockRestore();
  });

  it('sendMessage on an idle node calls streamMessage (normal in-place reply)', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
    });
    expect(result.current.nodes[rootId].status).toBe('idle');

    await act(async () => {
      result.current.store.sendMessage(rootId, 'hello');
    });

    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
  });

  it('validates follow-ups without uploading the already-bound transcript again', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    await act(async () => { result.current.store.sendMessage(nodeId, 'first prompt'); });
    expect(mockEnsureSession.mock.calls[0][0].priorMessages).toEqual([]);
    act(() => {
      const handlers = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
      handlers.onChunk?.('first answer');
      handlers.onDone?.();
    });

    await act(async () => { result.current.store.sendMessage(nodeId, 'follow-up'); });

    expect(mockEnsureSession).toHaveBeenCalledTimes(2);
    expect(mockEnsureSession.mock.calls[1][0].priorMessages).toBeUndefined();
    expect(mockEnsureSession.mock.calls[1][0].nodeId).toBe(nodeId);
    expect(mockStreamMessage).toHaveBeenCalledTimes(2);
  });

  it('retains recovery history after a stream failure', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    await act(async () => { result.current.store.sendMessage(nodeId, 'remember this'); });
    act(() => {
      const handlers = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
      handlers.onChunk?.('partial answer');
      handlers.onError?.('runtime disconnected');
    });

    await act(async () => { result.current.store.sendMessage(nodeId, 'retry'); });

    expect(mockEnsureSession.mock.calls[1][0].priorMessages).toEqual([
      { role: 'user', text: 'remember this' },
      { role: 'assistant', text: 'partial answer' },
    ]);
  });

  it('keeps a sustained setup wait loading without a separate activity label and allows Stop', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    mockEnsureSession.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      act(() => { result.current.store.sendMessage(nodeId, 'hello'); });
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(result.current.nodes[nodeId].status).toBe('streaming');
      expect(result.current.nodes[nodeId].runtimeActivity).toBeUndefined();
      const assistant = result.current.nodes[nodeId].messages.at(-1);
      expect(assistant?.role).toBe('assistant');
      expect(assistant?.streaming).toBe(true);
      expect(assistant?.text).toBe('');
      act(() => { result.current.store.cancelStream(nodeId); });
      expect(result.current.nodes[nodeId].status).toBe('idle');
      expect(result.current.nodes[nodeId].runtimeActivity).toBeUndefined();
      act(() => { vi.advanceTimersByTime(3_000); });
      expect(result.current.nodes[nodeId].runtimeActivity).toBeUndefined();
      expect(mockStreamMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['resolve', 'setup'],
    ['reject', 'setup'],
    ['resolve', 'streaming'],
    ['reject', 'streaming'],
  ] as const)('isolates a cancelled ensure that later %ss while the new send is %s', async (outcome, newerPhase) => {
    type Ensured = Awaited<ReturnType<typeof api.ensureSession>>;
    let resolveOld!: (value: Ensured) => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: Ensured) => void;
    const oldEnsure = new Promise<Ensured>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    const newEnsure = new Promise<Ensured>((resolve) => { resolveNew = resolve; });
    // Ignore abort deliberately: a late transport completion must remain harmless.
    mockEnsureSession.mockImplementationOnce(() => oldEnsure).mockImplementationOnce(() => newEnsure);
    const cancelOutput = vi.fn();
    mockStreamMessage.mockImplementation((_nodeId, _text, handlers: api.StreamHandlers) => () => {
      cancelOutput();
      handlers.onAborted?.();
    });
    const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread() ?? ''; });

    act(() => { result.current.store.sendMessage(nodeId, 'cancelled prompt'); });
    expect(result.current.nodes[nodeId].status).toBe('streaming');
    const oldSignal = mockEnsureSession.mock.calls[0][0].signal as AbortSignal;
    expect(oldSignal.aborted).toBe(false);
    const oldAssistantId = result.current.nodes[nodeId].messages.at(-1)!.id;
    act(() => { result.current.store.cancelStream(nodeId); });
    expect(oldSignal.aborted).toBe(true);
    expect(result.current.nodes[nodeId].status).toBe('idle');
    expect(result.current.nodes[nodeId].messages.at(-1)?.streaming).toBe(false);
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(api.cancelChatAndObserve).not.toHaveBeenCalled();

    act(() => { result.current.store.sendMessage(nodeId, 'new prompt'); });
    expect(mockEnsureSession).toHaveBeenCalledTimes(2);
    const newSignal = mockEnsureSession.mock.calls[1][0].signal as AbortSignal;
    const newAssistantId = result.current.nodes[nodeId].messages.at(-1)!.id;
    expect(newSignal).not.toBe(oldSignal);
    expect(newSignal.aborted).toBe(false);
    expect(newAssistantId).not.toBe(oldAssistantId);
    const openNew = async () => {
      await act(async () => {
        resolveNew({ chatId: nodeId, currentModeId: 'new-mode', resumeStrategy: 'fresh', runtimeId: 'claude', modelId: 'new-model' });
      });
      const handlers = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
      act(() => { handlers.onRetryStart?.({ detail: 'Restoring new turn' }); });
      rerender();
    };
    if (newerPhase === 'streaming') await openNew();

    await act(async () => {
      if (outcome === 'resolve') {
        resolveOld({ chatId: nodeId, currentModeId: 'old-mode', resumeStrategy: 'fresh', runtimeId: 'codex', modelId: 'old-model' });
      } else {
        rejectOld(new Error('late failure from cancelled setup'));
      }
    });
    rerender();
    expect(result.current.nodes[nodeId].status).toBe('streaming');
    expect(result.current.nodes[nodeId].error).toBeUndefined();
    expect(result.current.nodes[nodeId].messages.at(-1)?.id).toBe(newAssistantId);
    expect(newSignal.aborted).toBe(false);
    expect(cancelOutput).not.toHaveBeenCalled();
    if (newerPhase === 'setup') {
      expect(result.current.nodes[nodeId].chatId).toBeNull();
      expect(mockStreamMessage).not.toHaveBeenCalled();
      await openNew();
    }
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    expect(mockStreamMessage.mock.calls[0][1]).toBe('new prompt');
    expect(result.current.nodes[nodeId]).toMatchObject({
      status: 'streaming', runtimeId: 'claude', modelId: 'new-model',
      currentModeId: 'new-mode', runtimeActivity: 'Restoring new turn',
    });
    act(() => { result.current.store.cancelStream(nodeId); });
    expect(cancelOutput).toHaveBeenCalledTimes(1);
    expect(result.current.nodes[nodeId].status).toBe('idle');
  });

  function hydratedCancellationNode(status: 'idle' | 'streaming', bound = true) {
    vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [{ id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 }],
      nodes: [{
        id: 'cancel-node', status, acp_session_id: bound ? 'native-session' : null, runtime_id: 'claude',
        last_applied_turn_id: 'old-foreground', last_applied_seq: 1,
      }],
      messages: [
        { id: 'old-user', node_id: 'cancel-node', role: 'user', content: 'earlier prompt', seq: 0 },
        { id: 'old-a', node_id: 'cancel-node', role: 'assistant', content: 'partial', seq: 1 },
      ],
    }]);
    return renderHook(() => ({ store: useChatStore(), node: useChatNode('cancel-node'), nodes: useChatNodesSnapshot() }), { wrapper });
  }

  it.each([true, false])('renders another device’s user turn once (already bound: %s)', async (bound) => {
    const { result } = hydratedCancellationNode('idle', bound);
    await waitFor(() => expect(result.current.node?.messages.length).toBe(2));
    const handlers = backgroundForCancellationNode();
    const envelope = { chatId: 'cancel-node', nodeId: 'cancel-node', turnId: 'phone-turn', assistantId: 'phone-a' };
    const start = { event: 'turn_start' as const, data: { ...envelope, seq: 0, userText: 'sent on phone', userMetadata: { quotedText: 'a quote' } } };
    const chunk = { event: 'chunk' as const, data: { ...envelope, seq: 1, text: 'phone answer' } };
    act(() => { dispatchChatStreamEvent(start, handlers); dispatchChatStreamEvent(chunk, handlers); dispatchChatStreamEvent(chunk, handlers); });
    expect(result.current.node?.status).toBe('streaming');
    expect(result.current.node?.messages.filter(message => message.text === 'sent on phone')).toHaveLength(1);
    expect(result.current.node?.messages.find(message => message.text === 'sent on phone')?.quotedText).toBe('a quote');
    expect(result.current.node?.messages.find(message => message.id === 'phone-a')?.blocks?.filter(block => block.kind === 'answer').map(block => block.rawText).join('')).toBe('phone answer');
    act(() => { dispatchChatStreamEvent({ event: 'done', data: { ...envelope, seq: 2, stopReason: 'end_turn', persisted: true } }, handlers); });
    expect(result.current.node?.status).toBe('idle');
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

  function backgroundForCancellationNode() {
    const handlersForChat = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![0];
    return handlersForChat('cancel-node', 'cancel-node');
  }

  function scheduledSnapshot(nodeId: string, status: 'idle' | 'streaming', text: string, seq: number, model = 'sonnet') {
    return {
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [{ id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 },
        ...(nodeId === 'cancel-node' ? [] : [{ id: 'scheduled-tree', root_node_id: nodeId, created_at: 2, last_active_at: 2 }])],
      nodes: [{ id: nodeId, tree_id: nodeId === 'cancel-node' ? 'cancel-tree' : 'scheduled-tree', status,
        acp_session_id: 'native-scheduled', runtime_id: 'claude', model_id: model,
        last_applied_turn_id: 'scheduled-turn', last_applied_seq: seq }],
      messages: [{ id: 'scheduled-user', node_id: nodeId, role: 'user', content: 'scheduled prompt', seq: 0 },
        { id: 'scheduled-answer', node_id: nodeId, role: 'assistant', content: text, seq: 1 }],
    };
  }

  type Snapshot = ReturnType<typeof scheduledSnapshot>;
  // A node read is its workspace's structure, then one page of the node. Each
  // page here comes from the snapshot the latest structure read returned.
  let servedSnapshot: Snapshot | undefined;
  function serveNodeReads(reads: Array<Snapshot | Promise<unknown>>, otherwise?: Snapshot) {
    const structure = vi.mocked(api.fetchWorkspaceStructure);
    if (otherwise) structure.mockImplementation(async () => { servedSnapshot = otherwise; return otherwise; });
    for (const read of reads) {
      structure.mockImplementationOnce(async () => {
        const snapshot = await read as Snapshot;
        servedSnapshot = snapshot;
        return snapshot;
      });
    }
    vi.mocked(api.fetchTreeMessagePage).mockImplementation(async (_workspaceId, _treeId, _connectionId, _signal, page) => ({
      messages: (servedSnapshot?.messages ?? []).filter((row) => row.node_id === page?.nodeId),
    }));
  }

  function scheduledEvent(nodeId: string, phase: 'started' | 'finished') {
    const options = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![1]!;
    options.onScheduledJobRun?.({ phase, runId: 'scheduled-run', jobId: 'scheduled-job', jobName: 'Scheduled job',
      workspaceId: 'cancel-ws', nodeId, treeId: 'scheduled-tree', status: phase === 'started' ? 'running' : 'succeeded',
      summary: null, error: null, notify: false, at: 1 });
  }

  it('keeps the finished scheduled snapshot when its earlier start fetch completes last', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    let finishStart!: (value: unknown) => void;
    let finishFinal!: (value: unknown) => void;
    serveNodeReads([
      new Promise(resolve => { finishStart = resolve; }),
      new Promise(resolve => { finishFinal = resolve; }),
    ]);
    act(() => { scheduledEvent('scheduled-node', 'started'); });
    expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(1);
    act(() => { scheduledEvent('scheduled-node', 'finished'); });
    expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(2);
    let opened!: Promise<boolean>;
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    try {
      act(() => { opened = result.current.store.revealBackendNode('cancel-ws', 'scheduled-node'); });
      await act(async () => {
        finishFinal(scheduledSnapshot('scheduled-node', 'idle', 'final answer', 8));
        expect(await opened).toBe(true);
      });
    } finally { focus.mockRestore(); }
    await act(async () => { finishStart(scheduledSnapshot('scheduled-node', 'streaming', 'partial', 2)); });
    const scheduled = result.current.nodes['scheduled-node'];
    expect(scheduled.status).toBe('idle');
    expect(assistantAnswerRaw(scheduled)).toBe('final answer');
    expect(scheduled.lastAppliedBackgroundSeq).toBe(8);
    // The superseded start read never asked for the node's page.
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledWith('cancel-ws', 'scheduled-tree', undefined, expect.any(AbortSignal), { nodeId: 'scheduled-node', limit: 50 });
    expect(api.fetchWorkspace).not.toHaveBeenCalled();
  });

  it('cancels a scheduled run\'s read once its finish supersedes it, or the window goes', async () => {
    const { result, unmount } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    serveNodeReads([new Promise(() => {}), new Promise(() => {})]);
    const readSignal = (call: number) => vi.mocked(api.fetchWorkspaceStructure).mock.calls[call][1]!;
    act(() => { scheduledEvent('scheduled-node', 'started'); });
    expect(readSignal(0).aborted).toBe(false);
    act(() => { scheduledEvent('scheduled-node', 'finished'); });
    expect(readSignal(0).aborted).toBe(true);
    expect(readSignal(1).aborted).toBe(false);
    unmount();
    expect(readSignal(1).aborted).toBe(true);
  });

  describe('a conversation another device started after this window loaded', () => {
    const envelope = { chatId: 'phone-node', nodeId: 'phone-node', turnId: 'scheduled-turn', assistantId: 'scheduled-answer' };
    const frame = (event: Parameters<typeof dispatchChatStreamEvent>[0]) => {
      const handlersForChat = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![0];
      dispatchChatStreamEvent(event, handlersForChat(event.data.chatId ?? '', event.data.nodeId));
    };
    const start = { event: 'turn_start' as const, data: { ...envelope, seq: 0, userText: 'sent on phone' } };
    const done = { event: 'done' as const, data: { ...envelope, seq: 8, stopReason: 'end_turn', persisted: true } };

    it('shows up in its workspace and settles on the exact transcript when its turn ends', async () => {
      const { result } = hydratedCancellationNode('idle');
      await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
      vi.mocked(api.fetchNodeWorkspace).mockResolvedValue({ workspaceId: 'cancel-ws', treeId: 'scheduled-tree' });
      serveNodeReads([
        scheduledSnapshot('phone-node', 'streaming', 'partial', 1),
        scheduledSnapshot('phone-node', 'idle', 'final phone answer', 8),
      ]);
      act(() => { frame(start); frame({ event: 'chunk', data: { ...envelope, seq: 1, text: 'partial' } }); });
      await waitFor(() => expect(result.current.nodes['phone-node']?.status).toBe('streaming'));
      expect(api.fetchNodeWorkspace).toHaveBeenCalledTimes(1);
      const workspace = result.current.store.projects.find(project => project.id === 'cancel-ws');
      expect(workspace?.chatIds).toContain('phone-node');
      expect(workspace?.trees.map(tree => tree.id)).toContain('scheduled-tree');
      act(() => { frame({ event: 'chunk', data: { ...envelope, seq: 2, text: ' more' } }); frame(done); });
      await waitFor(() => expect(assistantAnswerRaw(result.current.nodes['phone-node'])).toBe('final phone answer'));
      expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(2);
      expect(result.current.nodes['phone-node'].status).toBe('idle');
      expect(result.current.nodes['phone-node'].lastAppliedBackgroundSeq).toBe(8);
    });

    it('re-reads it when its turn ends before the install lands', async () => {
      const { result } = hydratedCancellationNode('idle');
      await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
      let finishFirst!: (value: unknown) => void;
      vi.mocked(api.fetchNodeWorkspace).mockResolvedValue({ workspaceId: 'cancel-ws', treeId: 'scheduled-tree' });
      serveNodeReads([
        new Promise(resolve => { finishFirst = resolve; }),
        scheduledSnapshot('phone-node', 'idle', 'final phone answer', 8),
      ]);
      act(() => { frame(start); });
      await waitFor(() => expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(1));
      act(() => { frame(done); });
      await act(async () => { finishFirst(scheduledSnapshot('phone-node', 'streaming', 'partial', 1)); });
      await waitFor(() => expect(result.current.nodes['phone-node']?.status).toBe('idle'));
      expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(2);
      expect(assistantAnswerRaw(result.current.nodes['phone-node'])).toBe('final phone answer');
    });

    it('leaves a chat the backend cannot place alone for a while', async () => {
      const { result } = hydratedCancellationNode('idle');
      await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
      act(() => { frame(start); frame({ event: 'chunk', data: { ...envelope, seq: 1, text: 'x' } }); });
      await act(async () => {});
      act(() => { frame({ event: 'chunk', data: { ...envelope, seq: 2, text: 'y' } }); frame(done); });
      await act(async () => {});
      expect(api.fetchNodeWorkspace).toHaveBeenCalledTimes(1);
      expect(api.fetchWorkspaceStructure).not.toHaveBeenCalled();
      expect(result.current.nodes['phone-node']).toBeUndefined();
    });
  });

  it('preserves a cold command and its SDK state while a scheduled refresh converges', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    await loadClaudeCommands();
    let finishSnapshot!: (value: unknown) => void;
    let finishCommand!: (value: Awaited<ReturnType<typeof executeChatCommand>>) => void;
    serveNodeReads([new Promise(resolve => { finishSnapshot = resolve; })],
      scheduledSnapshot('cancel-node', 'idle', 'final answer', 8, 'opus'));
    vi.mocked(executeChatCommand).mockImplementationOnce(() => new Promise(resolve => { finishCommand = resolve; }));
    mockEnsureSession.mockResolvedValueOnce({ chatId: 'cancel-node', currentModeId: null, resumeStrategy: 'exact',
      runtimeId: 'claude', modelId: 'opus', sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk', modelId: 'opus' } });
    act(() => { scheduledEvent('cancel-node', 'finished'); });
    await act(async () => { result.current.store.sendMessage('cancel-node', '/model opus'); });
    expect(result.current.node?.commandResult?.status).toBe('running');
    await act(async () => { finishSnapshot(scheduledSnapshot('cancel-node', 'idle', 'older answer', 2)); });
    expect(result.current.node?.commandResult?.status).toBe('running');
    expect(result.current.node?.sessionState?.nativeEngine).toBe('agent-sdk');
    await act(async () => { finishCommand({ success: true, message: 'Model changed.',
      sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk', modelId: 'opus' } }); });
    await waitFor(() => expect(assistantAnswerRaw(result.current.node)).toBe('final answer'));
    expect(result.current.node?.commandResult).toMatchObject({ status: 'completed', message: 'Model changed.' });
    expect(result.current.node?.sessionState).toMatchObject({ nativeEngine: 'agent-sdk', modelId: 'opus' });
    expect(result.current.node?.modelId).toBe('opus');
  });

  it('refetches a scheduled snapshot when background output advances during its fetch', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    let finishSnapshot!: (value: unknown) => void;
    serveNodeReads([new Promise(resolve => { finishSnapshot = resolve; })],
      scheduledSnapshot('cancel-node', 'idle', 'final background answer', 8));
    act(() => { scheduledEvent('cancel-node', 'finished'); });
    const handlers = backgroundForCancellationNode();
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'scheduled-turn', assistantId: 'scheduled-answer', seq: 0, userText: '', selfInitiated: true,
      } }, handlers);
      dispatchChatStreamEvent({ event: 'chunk', data: {
        turnId: 'scheduled-turn', assistantId: 'scheduled-answer', seq: 3, text: 'new background output',
      } }, handlers);
      dispatchChatStreamEvent({ event: 'done', data: {
        turnId: 'scheduled-turn', assistantId: 'scheduled-answer', seq: 8, persisted: true,
      } }, handlers);
    });
    await act(async () => { finishSnapshot(scheduledSnapshot('cancel-node', 'streaming', 'stale partial', 2)); });
    await waitFor(() => expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(2));
    expect(result.current.node?.status).toBe('idle');
    expect(result.current.node?.lastAppliedBackgroundSeq).toBe(8);
    expect(assistantAnswerRaw(result.current.node)).toBe('final background answer');
  });

  describe('a background replay gap', () => {
    const structureRow = (id: string, treeId = 'cancel-tree') => ({
      id, tree_id: treeId, status: 'idle', acp_session_id: 'native', runtime_id: 'claude',
      last_applied_turn_id: 'old-foreground', last_applied_seq: 1, message_count: 2,
    });
    const structure = (rows = [structureRow('cancel-node'), structureRow('sibling-node')]) => ({
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [{ id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 }],
      nodes: rows, edges: [], messages: [], contexts: [],
    });
    const gap = { chatId: 'cancel-node', nodeId: 'cancel-node', turnId: 'gap-turn', seq: 4 };

    function hydratedPair() {
      vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
        ...structure(),
        messages: ['cancel-node', 'sibling-node'].flatMap((id) => [
          { id: `${id}-u`, node_id: id, role: 'user', content: 'earlier prompt', seq: 0 },
          { id: `${id}-a`, node_id: id, role: 'assistant', content: 'partial', seq: 1 },
        ]),
      }]);
      return renderHook(() => ({ store: useChatStore(), node: useChatNode('cancel-node'), nodes: useChatNodesSnapshot() }), { wrapper });
    }
    const options = () => vi.mocked(api.subscribeBackground).mock.calls.at(-1)![1]!;

    it('installs from the structure and one page of the node, and output elsewhere does not restart the read', async () => {
      const { result } = hydratedPair();
      await waitFor(() => expect(result.current.nodes['sibling-node']?.messages).toHaveLength(2));
      let finishStructure!: (value: unknown) => void;
      vi.mocked(api.fetchWorkspaceStructure).mockImplementationOnce(() => new Promise(resolve => { finishStructure = resolve; }));
      vi.mocked(api.fetchTreeMessagePage).mockResolvedValueOnce({
        messages: [
          { id: 'cancel-node-u', node_id: 'cancel-node', role: 'user', content: 'earlier prompt', seq: 0 },
          { id: 'cancel-node-a', node_id: 'cancel-node', role: 'assistant', content: 'durable answer', seq: 1 },
        ],
        pages: [{ nodeId: 'cancel-node', total: 2, before: null }],
        turns: [{ node_id: 'cancel-node', turn_id: 'gap-turn', status: 'completed', last_seq: 9, error: null, completed_at: 5 }],
      });
      const controller = new AbortController();
      let installed!: Promise<unknown>;
      act(() => { installed = Promise.resolve(options().onReplayGap!(gap, controller.signal)); });
      await waitFor(() => expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(1));
      // Another node streams while the structure read is in flight.
      const sibling = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![0]('sibling-node', 'sibling-node');
      const envelope = { chatId: 'sibling-node', nodeId: 'sibling-node', turnId: 'sibling-turn', assistantId: 'sibling-a' };
      act(() => {
        dispatchChatStreamEvent({ event: 'turn_start', data: { ...envelope, seq: 0, userText: 'go' } }, sibling);
        dispatchChatStreamEvent({ event: 'chunk', data: { ...envelope, seq: 1, text: 'streaming elsewhere' } }, sibling);
      });
      await act(async () => {
        finishStructure(structure());
        await expect(installed).resolves.toEqual({ turnId: 'gap-turn', seq: 9 });
      });
      expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(1);
      expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
      expect(api.fetchTreeMessagePage).toHaveBeenCalledWith('cancel-ws', 'cancel-tree', undefined, controller.signal,
        { nodeId: 'cancel-node', limit: 50 });
      expect(api.fetchWorkspace).not.toHaveBeenCalled();
      expect(assistantAnswerRaw(result.current.node)).toBe('durable answer');
      expect(result.current.node).toMatchObject({ status: 'idle', lastAppliedBackgroundTurnId: 'gap-turn', lastAppliedBackgroundSeq: 9 });
      expect(result.current.nodes['sibling-node'].status).toBe('streaming');
    });

    it('installs nothing for a node its workspace no longer lists', async () => {
      const { result } = hydratedPair();
      await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
      const before = result.current.node;
      vi.mocked(api.fetchWorkspaceStructure).mockResolvedValueOnce(structure([structureRow('sibling-node')]));
      await act(async () => {
        await expect(options().onReplayGap!(gap, new AbortController().signal)).resolves.toBeUndefined();
      });
      expect(api.fetchTreeMessagePage).not.toHaveBeenCalled();
      expect(result.current.node).toBe(before);
    });

    it('waits for a host command on the node before reading, as a scheduled run\'s install does', async () => {
      const { result } = hydratedCancellationNode('idle');
      await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
      await loadClaudeCommands();
      let finishCommand!: (value: Awaited<ReturnType<typeof executeChatCommand>>) => void;
      vi.mocked(executeChatCommand).mockImplementationOnce(() => new Promise(resolve => { finishCommand = resolve; }));
      mockEnsureSession.mockResolvedValueOnce({ chatId: 'cancel-node', currentModeId: null, resumeStrategy: 'exact', runtimeId: 'claude' });
      await act(async () => { result.current.store.sendMessage('cancel-node', '/model opus'); });
      expect(result.current.node?.commandResult?.status).toBe('running');
      vi.mocked(api.fetchWorkspaceStructure).mockResolvedValue(structure());
      vi.mocked(api.fetchTreeMessagePage).mockResolvedValue({
        messages: [
          { id: 'old-user', node_id: 'cancel-node', role: 'user', content: 'earlier prompt', seq: 0 },
          { id: 'old-a', node_id: 'cancel-node', role: 'assistant', content: 'durable answer', seq: 1 },
        ],
        pages: [{ nodeId: 'cancel-node', total: 2, before: null }],
      });
      let installed!: Promise<unknown>;
      act(() => { installed = Promise.resolve(options().onReplayGap!(gap, new AbortController().signal)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      expect(api.fetchWorkspaceStructure).not.toHaveBeenCalled();
      await act(async () => { finishCommand({ success: true, message: 'Model changed.' }); });
      await act(async () => { await installed; });
      expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(1);
      expect(result.current.node?.commandResult).toMatchObject({ status: 'completed', message: 'Model changed.' });
    });

    it('reads the structure again when the page lacks the node, and stops once it moved threads', async () => {
      const { result } = hydratedPair();
      await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
      const before = result.current.node;
      vi.mocked(api.fetchWorkspaceStructure)
        .mockResolvedValueOnce(structure())
        .mockResolvedValueOnce(structure([structureRow('cancel-node', 'extracted-tree'), structureRow('sibling-node')]));
      vi.mocked(api.fetchTreeMessagePage).mockResolvedValueOnce({ messages: [], pages: [], turns: [] });
      await act(async () => {
        await expect(options().onReplayGap!(gap, new AbortController().signal)).resolves.toBeUndefined();
      });
      expect(api.fetchWorkspaceStructure).toHaveBeenCalledTimes(2);
      expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
      expect(result.current.node).toBe(before);
    });
  });

  it('restores a cold Claude session before a host command without adding transcript messages', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    await loadClaudeCommands();
    let finish!: (value: api.EnsureSessionResult) => void;
    mockEnsureSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => { result.current.store.sendMessage('cancel-node', '/status'); });
    expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'cancel-node', runtimeId: 'claude', workspaceId: 'cancel-ws',
      priorMessages: [{ role: 'user', text: 'earlier prompt' }, { role: 'assistant', text: 'partial' }],
    }));
    expect(executeChatCommand).not.toHaveBeenCalled();
    await act(async () => { finish({ chatId: 'cancel-node', currentModeId: null, resumeStrategy: 'exact', runtimeId: 'claude' }); });
    await waitFor(() => expect(executeChatCommand).toHaveBeenCalledWith('cancel-node', 'status', undefined));
    await waitFor(() => expect(result.current.node?.commandResult?.status).toBe('completed'));
    expect(result.current.node?.messages).toHaveLength(2);
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

  it('initializes a never-sent anchored child through the durable graph before a Claude command', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    await loadClaudeCommands();
    let childId = '';
    await act(async () => { childId = await result.current.store.createBlankChild('cancel-node', { anchorMessageId: 'old-a' }); });
    await act(async () => { result.current.store.sendMessage(childId, '/model claude-sonnet-4-6', { runtimeId: 'claude' }); });
    await waitFor(() => expect(executeChatCommand).toHaveBeenCalledWith(childId, 'model', { value: 'claude-sonnet-4-6' }));
    expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: childId, parentChatId: 'cancel-node', priorMessages: [],
      graphPrerequisite: expect.objectContaining({
        node: expect.objectContaining({ id: childId, parentNodeId: 'cancel-node' }),
        edges: expect.arrayContaining([expect.objectContaining({ sourceNodeId: 'cancel-node', targetNodeId: childId, anchorMessageId: 'old-a' })]),
      }),
    }));
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

  it('runs a cold chat’s command once its runtime’s catalog first answers, sent before that answer', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    let respond!: (value: SkillCatalogResponse) => void;
    vi.mocked(fetchSkillCatalog).mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));
    act(() => { result.current.store.sendMessage('cancel-node', '/status'); });
    expect(mockEnsureSession).not.toHaveBeenCalled();
    // The commands come at once, while Claude is still listing its skills.
    await act(async () => { respond({ skills: [], errors: [], libraryAvailable: true, commands: CLAUDE_COMMANDS, pending: ['claude'] }); });
    await waitFor(() => expect(executeChatCommand).toHaveBeenCalledWith('cancel-node', 'status', undefined));
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(result.current.node?.messages).toHaveLength(2);
  });

  it('sends a /word in the assistant’s conversation at once while its runtime is still listing skills, which run nowhere there', async () => {
    vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
      workspace: { id: 'cancel-ws', name: 'Assistant', created_at: 1, active_tree_id: 'cancel-tree', settings: JSON.stringify({ system: 'assistant' }) },
      trees: [{ id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 }],
      nodes: [{ id: 'cancel-node', status: 'idle', acp_session_id: 'native-session', runtime_id: 'claude' }],
      messages: [],
    }]);
    const { result } = renderHook(() => ({ store: useChatStore(), node: useChatNode('cancel-node') }), { wrapper });
    await waitFor(() => expect(result.current.node).toBeDefined());
    vi.mocked(fetchSkillCatalog).mockResolvedValueOnce({ skills: [], errors: [], libraryAvailable: true, commands: CLAUDE_COMMANDS, pending: ['claude'] });
    await loadClaudeCommands();
    vi.mocked(fetchSkillCatalog).mockReturnValue(new Promise(() => {}));
    await act(async () => { result.current.store.sendMessage('cancel-node', '/plan the week'); });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(mockStreamMessage.mock.calls[0][1]).toBe('/plan the week');
    expect(fetchSkillCatalog).toHaveBeenCalledTimes(1);
  });

  it('does not execute a Claude command after its session restore fails', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages).toHaveLength(2));
    await loadClaudeCommands();
    mockEnsureSession.mockRejectedValueOnce(new Error('Native restore failed'));
    await act(async () => { result.current.store.sendMessage('cancel-node', '/status'); });
    await waitFor(() => expect(result.current.node?.commandResult).toMatchObject({ status: 'error', message: 'Native restore failed' }));
    expect(executeChatCommand).not.toHaveBeenCalled();
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(result.current.node?.messages).toHaveLength(2);
    act(() => { result.current.store.sendMessage('cancel-node', 'next prompt'); });
    expect(result.current.node?.commandResult).toBeUndefined();
  });

  describe('a message that names a skill', () => {
    const review = { id: 'library:review', name: 'review', description: 'Review a change', origin: 'library' as const,
      userInvocable: true, modelInvocable: true, enabled: true };

    async function kiroThread() {
      vi.mocked(fetchSkillCatalog).mockReset().mockResolvedValue({ skills: [review], errors: [], libraryAvailable: true, commands: [{ name: 'context' }] });
      mockEnsureSession.mockImplementation(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh', runtimeId: 'kiro' }));
      const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
      await act(async () => { await result.current.store.createProject('skills'); });
      let nodeId = '';
      await act(async () => { nodeId = result.current.store.createThread()!; });
      await act(async () => { await loadSkillCatalog(result.current.store.activeProject!.id, 'kiro'); });
      return { result, nodeId };
    }

    it('runs it as a turn with the arguments as its text, and a /word nothing runs as a message', async () => {
      const { result, nodeId } = await kiroThread();
      await act(async () => {
        result.current.store.sendMessage(nodeId, joinMessageParts(null, 'old code', '/review src/app.ts'),
          { displayText: '/review src/app.ts', quotedText: 'old code', runtimeId: 'kiro' });
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      const [, text, handlers, options] = mockStreamMessage.mock.calls[0];
      expect(text).toBe(joinMessageParts(null, 'old code', 'src/app.ts'));
      expect(options).toMatchObject({ displayText: '/review src/app.ts', userMetadata: { quotedText: 'old code' } });
      expect(options.skill).toEqual({ id: 'library:review', name: 'review', args: 'src/app.ts' });
      expect(executeChatCommand).not.toHaveBeenCalled();
      expect(result.current.nodes[nodeId].messages.find((message) => message.role === 'user')).toMatchObject({
        text: '/review src/app.ts', quotedText: 'old code',
        skill: { id: 'library:review', name: 'review', origin: 'library', args: 'src/app.ts' },
      });

      act(() => { handlers.onDone?.(); });
      await act(async () => { result.current.store.sendMessage(nodeId, '/unknown', { runtimeId: 'kiro' }); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
      expect(mockStreamMessage.mock.calls[1][1]).toBe('/unknown');
      expect(mockStreamMessage.mock.calls[1][3].skill).toBeUndefined();
      act(() => { mockStreamMessage.mock.calls[1][2].onDone?.(); });
      await act(async () => { result.current.store.sendMessage(nodeId, '/context', { runtimeId: 'kiro' }); });
      await waitFor(() => expect(executeChatCommand).toHaveBeenCalledWith(nodeId, 'context', undefined));
      expect(mockStreamMessage).toHaveBeenCalledTimes(2);
    });

    it('waits for a first catalog answer before running a typed name the live session runs as its own skill, so the library skill wins', async () => {
      mockEnsureSession.mockImplementation(() => Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh', runtimeId: 'kiro',
        sessionState: { runtimeId: 'kiro', commands: [{ name: 'review', kind: 'skill' }] } }));
      const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
      await act(async () => { await result.current.store.createProject('skills'); });
      let nodeId = '';
      await act(async () => { nodeId = result.current.store.createThread()!; });
      await act(async () => { result.current.store.sendMessage(nodeId, 'first', { runtimeId: 'kiro' }); });
      await waitFor(() => expect(result.current.nodes[nodeId].agentCommands).toEqual([{ name: 'review', kind: 'skill' }]));
      act(() => { mockStreamMessage.mock.calls[0][2].onDone?.(); });

      let respond!: (value: SkillCatalogResponse) => void;
      vi.mocked(fetchSkillCatalog).mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));
      await act(async () => { result.current.store.sendMessage(nodeId, '/review 1', { runtimeId: 'kiro' }); });
      expect(mockStreamMessage).toHaveBeenCalledTimes(1);
      await act(async () => { respond({ skills: [review], errors: [], libraryAvailable: true, commands: [], pending: ['kiro'] }); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
      expect(mockStreamMessage.mock.calls[1][3].skill).toEqual({ id: 'library:review', name: 'review', args: '1' });
    });

    it('resolves a /name against the runtime whose menu the composer showed', async () => {
      const { result, nodeId } = await kiroThread();
      vi.mocked(fetchSkillCatalog).mockResolvedValueOnce({ skills: [], errors: [], libraryAvailable: true, commands: CLAUDE_COMMANDS });
      await act(async () => { await loadSkillCatalog(result.current.store.activeProject!.id, 'claude'); });
      await act(async () => { result.current.store.sendMessage(nodeId, '/status', { slashRuntimeId: 'claude' }); });
      await waitFor(() => expect(executeChatCommand).toHaveBeenCalledWith(nodeId, 'status', undefined));
      expect(mockStreamMessage).not.toHaveBeenCalled();
    });

    it('runs the skill row picked for a name a command also has', async () => {
      const { result, nodeId } = await kiroThread();
      const contextSkill = { ...review, id: 'library:context', name: 'context' };
      const entry = { name: 'context', source: 'skill' as const, takesArgs: true,
        skill: { id: contextSkill.id, name: 'context', origin: 'library' as const } };
      await act(async () => {
        result.current.store.sendMessage(nodeId, '/context the plan', { runtimeId: 'kiro', slash: { entry, runtimeId: 'kiro' } });
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(mockStreamMessage.mock.calls[0][3].skill).toEqual({ id: 'library:context', name: 'context', args: 'the plan' });
      expect(executeChatCommand).not.toHaveBeenCalled();
    });

    it('drains a queued skill as its own turn, not merged with the message after it', async () => {
      const { result, nodeId } = await kiroThread();
      await act(async () => { result.current.store.sendMessage(nodeId, 'first', { runtimeId: 'kiro' }); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      act(() => {
        result.current.store.queueMessage(nodeId, { id: 'q1', value: '/review', mentions: [], attachments: [], queuedAt: 1 });
        result.current.store.queueMessage(nodeId, { id: 'q2', value: 'and then this', mentions: [], attachments: [], queuedAt: 2 });
        mockStreamMessage.mock.calls[0][2].onDone?.();
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
      expect(mockStreamMessage.mock.calls[1][1]).toBe('');
      expect(mockStreamMessage.mock.calls[1][3]).toMatchObject({ displayText: '/review', skill: { id: 'library:review', args: '' } });
      act(() => { mockStreamMessage.mock.calls[1][2].onDone?.(); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(3));
      expect(mockStreamMessage.mock.calls[2][1]).toBe('and then this');
      expect(mockStreamMessage.mock.calls[2][3].skill).toBeUndefined();
      expect(executeChatCommand).not.toHaveBeenCalled();
    });

    it('ends the wire text with the arguments the request carries, attached files and mentioned chats going first', async () => {
      const { result, nodeId } = await kiroThread();
      let otherId = '';
      await act(async () => { otherId = result.current.store.createThread()!; });
      const typed = `/review ${encodeNodeMentionToken(otherId)} check png`;
      const attachments = [{ name: 'shot.png', absPath: '/ws/shot.png' }];
      await act(async () => {
        result.current.store.sendMessage(nodeId, appendAttachmentsSentinel(typed, attachments), { displayText: typed, attachments, runtimeId: 'kiro' });
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      const [, text, , options] = mockStreamMessage.mock.calls[0];
      expect(options.skill).toEqual({ id: 'library:review', name: 'review', args: 'check png' });
      expect(text).toMatch(/^The user referenced the following chat nodes\./);
      expect(text).toMatch(/\n\n\[Attached files: shot\.png — \/ws\/shot\.png\]\n\ncheck png$/);
    });

    function hydratedSkillMessage() {
      vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
        workspace: { id: 'skill-ws', name: 'Skills', created_at: 1, active_tree_id: 'skill-tree' },
        trees: [{ id: 'skill-tree', root_node_id: 'skill-node', created_at: 1, last_active_at: 1 }],
        nodes: [{ id: 'skill-node', status: 'idle', acp_session_id: 'native-session', runtime_id: 'kiro' }],
        messages: [
          // A Kiro power skill: only the live session that ran it listed it.
          { id: 'skill-user', node_id: 'skill-node', role: 'user', content: '/power-skill draft it', seq: 0,
            metadata: { skill: { id: 'live:kiro:power-skill', name: 'power-skill', origin: 'runtime', runtimeId: 'kiro', args: 'draft it' } } },
          { id: 'skill-answer', node_id: 'skill-node', role: 'assistant', content: 'partial', seq: 1 },
        ],
      }]);
      mockEnsureSession.mockImplementation(() => Promise.resolve({ chatId: 'skill-node', currentModeId: null, resumeStrategy: 'fresh', runtimeId: 'kiro' }));
      return renderHook(() => ({ store: useChatStore(), node: useChatNode('skill-node') }), { wrapper });
    }

    it('retries a skill message by the skill it ran, after a reload left no catalog or session command to find it by', async () => {
      const { result } = hydratedSkillMessage();
      await waitFor(() => expect(result.current.node?.messages[0]?.skill?.id).toBe('live:kiro:power-skill'));
      await act(async () => { result.current.store.retryLastTurn('skill-node'); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      const [, text, , options] = mockStreamMessage.mock.calls[0];
      expect(text).toBe('draft it');
      expect(options).toMatchObject({ displayText: '/power-skill draft it' });
      expect(options.skill).toEqual({ id: 'live:kiro:power-skill', name: 'power-skill', args: 'draft it' });
      expect(executeChatCommand).not.toHaveBeenCalled();
    });

    it('runs an edit that keeps the /name by the skill the message ran, and an edit to another name as typed', async () => {
      const { result } = hydratedSkillMessage();
      await waitFor(() => expect(result.current.node?.messages[0]?.skill?.id).toBe('live:kiro:power-skill'));
      await act(async () => { result.current.store.editAndResend('skill-node', 0, '/power-skill draft it twice'); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(mockStreamMessage.mock.calls[0][3].skill).toEqual({ id: 'live:kiro:power-skill', name: 'power-skill', args: 'draft it twice' });

      act(() => { mockStreamMessage.mock.calls[0][2].onDone?.(); });
      await act(async () => { result.current.store.editAndResend('skill-node', 0, '/other thing'); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
      expect(mockStreamMessage.mock.calls[1][3].skill).toBeUndefined();
      expect(executeChatCommand).not.toHaveBeenCalled();
    });

    it('resends an edit on the binding the composer passes, keeping the skill it ran', async () => {
      const { result } = hydratedSkillMessage();
      await waitFor(() => expect(result.current.node?.messages[0]?.skill?.id).toBe('live:kiro:power-skill'));
      mockEnsureSession.mockClear();
      await act(async () => {
        result.current.store.editAndResend('skill-node', 0, '/power-skill draft it twice', { runtimeId: 'kiro', modelId: 'opus', reasoning: 'high' });
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'skill-node', runtimeId: 'kiro', modelId: 'opus', reasoning: 'high' }));
      expect(mockStreamMessage.mock.calls[0][3].skill).toMatchObject({ id: 'live:kiro:power-skill' });
    });

    it('says why a refused skill did not run, stops offering it, and a retry asks for that skill again rather than anything else', async () => {
      const { result, nodeId } = await kiroThread();
      const workspaceId = result.current.store.activeProject!.id;
      await act(async () => { result.current.store.sendMessage(nodeId, '/review 1', { displayText: '/review 1', runtimeId: 'kiro' }); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      let respond!: (value: SkillCatalogResponse) => void;
      vi.mocked(fetchSkillCatalog).mockReturnValueOnce(new Promise<SkillCatalogResponse>((resolve) => { respond = resolve; }));
      act(() => {
        mockStreamMessage.mock.calls[0][2].onErrorPayload({ message: 'Couldn’t run /review: it’s turned off in Settings › Skills.', code: 'skill_not_found' });
      });
      expect(result.current.nodes[nodeId].error).toBe('Couldn’t run /review: it’s turned off in Settings › Skills.');
      expect(readSkillCatalog(workspaceId, 'kiro')?.skills).toEqual([]);
      expect(fetchSkillCatalog).toHaveBeenCalledTimes(2);

      const moved = { ...review, id: 'runtime:kiro:user:review', origin: 'runtime' as const, runtimeId: 'kiro', scope: 'user' };
      await act(async () => { respond({ skills: [moved], errors: [], libraryAvailable: true, commands: [{ name: 'review' }] }); });
      await act(async () => { result.current.store.retryLastTurn(nodeId); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
      expect(mockStreamMessage.mock.calls[1][3].skill).toEqual({ id: 'library:review', name: 'review', args: '1' });
      expect(executeChatCommand).not.toHaveBeenCalled();
    });
  });

  it('fallback Stop targets the active background turn after a completed foreground turn', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.status).toBe('idle'));
    await act(async () => { result.current.store.openPane('cancel-node'); });
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.store.sendMessage('cancel-node', 'foreground'); });
    const foreground = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'foreground-turn', assistantId: 'foreground-a', seq: 0, userText: 'foreground',
      } }, foreground);
    });
    expect(result.current.node?.activeTurnId).toBe('foreground-turn');
    act(() => { foreground.onDone?.('end_turn', 'foreground-a', 'foreground-turn', true); });
    expect(result.current.node?.activeTurnId).toBeUndefined();

    const background = backgroundForCancellationNode();
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'background-turn', assistantId: 'background-a', seq: 0, userText: '', selfInitiated: true,
      } }, background);
    });
    expect(result.current.node).toMatchObject({
      status: 'streaming', activeTurnId: 'background-turn', lastAppliedTurnId: 'foreground-turn',
    });
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith(
      'cancel-node', 'background-turn', expect.any(Function),
    );
    expect(result.current.node?.status).toBe('idle');
    expect(result.current.node?.messages.at(-1)?.streaming).toBe(false);
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);
  });

  it('recovered Stop finalizes the captured assistant and delivers cleanup status through useChatNode', async () => {
    const detach = vi.fn();
    vi.mocked(api.reattachTurnReplay).mockImplementation(() => detach);
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    expect(result.current.node?.activeTurnId).toBe('old-foreground');
    const replay = vi.mocked(api.reattachTurnReplay).mock.calls[0][1].handlers;
    act(() => {
      dispatchChatStreamEvent({ event: 'chunk', data: {
        turnId: 'old-foreground', assistantId: 'old-a', seq: 2, text: ' still streaming',
      } }, replay);
    });
    await waitFor(() => expect(result.current.node?.messages.at(-1)?.blocks?.some((block) =>
      block.kind === 'answer' && block.streaming,
    )).toBe(true));
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(result.current.node?.status).toBe('idle');
    expect(result.current.node?.activeTurnId).toBeUndefined();
    expect(result.current.node?.messages.at(-1)?.streaming).toBe(false);
    expect(result.current.node?.messages.at(-1)?.blocks?.some((block) =>
      (block.kind === 'answer' || block.kind === 'thinking') && block.streaming,
    )).toBe(false);
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith(
      'cancel-node', 'old-foreground', expect.any(Function),
    );
    const onStatus = vi.mocked(api.cancelChatAndObserve).mock.calls[0][2];
    act(() => { onStatus({ state: 'pending', detail: 'Waiting for cleanup' }); });
    expect(result.current.node?.runtimeActivity).toBe('Waiting for cleanup');
    act(() => { onStatus({ state: 'settled' }); });
    expect(result.current.node?.runtimeActivity).toBeUndefined();
    expect(result.current.node?.status).toBe('idle');
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.store.sendMessage('cancel-node', 'new foreground'); });
    const newAssistant = result.current.node?.messages.at(-1)?.id;
    act(() => { onStatus({ state: 'error', detail: 'late old cleanup error' }); });
    expect(result.current.node?.status).toBe('streaming');
    expect(result.current.node?.error).toBeUndefined();
    expect(result.current.node?.messages.at(-1)?.id).toBe(newAssistant);
    act(() => { (mockStreamMessage.mock.calls[0][2] as api.StreamHandlers).onDone?.(); });
  });

  it('a recovered self-turn refused by replay drops the stale Stop callback while background retains the live node', async () => {
    const detach = vi.fn();
    vi.mocked(api.reattachTurnReplay).mockImplementation(() => detach);
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.store.openPane('cancel-node'); });
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
    const replay = vi.mocked(api.reattachTurnReplay).mock.calls[0][1];
    act(() => { replay.onBackgroundOwned('This reply arrives on the background feed.'); });
    expect(result.current.node?.status).toBe('streaming');
    expect(result.current.node?.error).toBeUndefined();
    const background = backgroundForCancellationNode();
    act(() => {
      dispatchChatStreamEvent({ event: 'turn_start', data: {
        nodeId: 'cancel-node', turnId: 'background-turn', assistantId: 'background-a', seq: 0, userText: '', selfInitiated: true,
      } }, background);
      result.current.store.cancelStream('cancel-node');
    });
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith(
      'cancel-node', 'background-turn', expect.any(Function),
    );
    expect(result.current.node?.status).toBe('idle');
    expect(detach).not.toHaveBeenCalled();
  });

  const REPLAY_GONE = 'The live reply is no longer available. Reopen the conversation to check its saved state before retrying.';

  it('a recovered turn whose live replay is gone finishes from its saved row', async () => {
    vi.mocked(api.getSavedTurn).mockResolvedValueOnce({
      turnId: 'old-foreground', assistantId: 'old-a', status: 'completed', stopReason: 'end_turn', completedAt: 5, lastSeq: 9,
      message: { id: 'old-a', node_id: 'cancel-node', role: 'assistant', content: 'saved answer', seq: 1 },
    });
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    const replay = vi.mocked(api.reattachTurnReplay).mock.calls[0][1];
    act(() => { replay.onReplayGone(REPLAY_GONE, 'turn_replay_unavailable'); });
    await waitFor(() => expect(result.current.node?.status).toBe('idle'));
    expect(api.getSavedTurn).toHaveBeenCalledWith('cancel-node', 'old-foreground', expect.any(AbortSignal));
    expect(result.current.node?.messages.at(-1)?.blocks?.filter(block => block.kind === 'answer').map(block => block.rawText).join('')).toBe('saved answer');
    expect(result.current.node?.error).toBeUndefined();
  });

  it('a recovered turn that is gone and unfinished fails so Retry inspects it instead of re-sending', async () => {
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    const replay = vi.mocked(api.reattachTurnReplay).mock.calls[0][1];
    act(() => { replay.onReplayGone(REPLAY_GONE, 'turn_replay_unavailable'); });
    await waitFor(() => expect(result.current.node?.status).toBe('error'));
    expect(result.current.node).toMatchObject({ errorKind: 'turn_replay_unavailable', errorTurnId: 'old-foreground' });
    expect(turnErrorAction(result.current.node?.errorKind)).toBe('inspect-existing-turn');
  });

  it('a recovered turn reattaches as the sending window does, from the seq after the one it applied', async () => {
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    const [chatId, replay] = vi.mocked(api.reattachTurnReplay).mock.calls[0];
    expect(chatId).toBe('cancel-node');
    expect(replay.turnId).toBe('old-foreground');
    expect(replay.nextSeq()).toBe(2);
    expect(replay.isCurrent()).toBe(true);
    act(() => {
      dispatchChatStreamEvent({ event: 'chunk', data: { turnId: 'old-foreground', assistantId: 'old-a', seq: 2, text: ' more' } }, replay.handlers);
    });
    expect(replay.nextSeq()).toBe(3);
    act(() => { replay.onUnavailable('subscribe failed: 404', 'turn_outcome_unknown'); });
    expect(result.current.node).toMatchObject({ status: 'error', errorKind: 'turn_outcome_unknown', errorTurnId: 'old-foreground' });
    expect(turnErrorAction(result.current.node?.errorKind)).toBe('inspect-existing-turn');
  });

  it('a Stop while a recovered replay waits to reconnect also stops the reconnect, and a later send keeps its own Stop', async () => {
    const stopReplay = vi.fn();
    vi.mocked(api.reattachTurnReplay).mockImplementation(() => stopReplay);
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    const replay = vi.mocked(api.reattachTurnReplay).mock.calls[0][1];
    const cancelNew = vi.fn();
    mockStreamMessage.mockImplementationOnce(() => cancelNew);
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(stopReplay).toHaveBeenCalledOnce();
    expect(replay.isCurrent()).toBe(false);
    expect(api.cancelChatAndObserve).toHaveBeenCalledExactlyOnceWith('cancel-node', 'old-foreground', expect.any(Function));
    await act(async () => { result.current.store.sendMessage('cancel-node', 'new foreground'); });
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1);
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(cancelNew).toHaveBeenCalledTimes(1);
    expect(api.cancelChatAndObserve).toHaveBeenCalledTimes(1);
  });

  it('a queued message waits for the next turn end when another turn starts before it is sent', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages.length).toBe(2));
    await act(async () => { result.current.store.openPane('cancel-node'); });
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.store.sendMessage('cancel-node', 'first'); });
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.store.queueMessage('cancel-node', { id: 'q-1', value: 'queued while busy', mentions: [], attachments: [], queuedAt: 1 });
    });
    const background = backgroundForCancellationNode();
    const self = { nodeId: 'cancel-node', turnId: 'self-turn', assistantId: 'self-a' };
    act(() => {
      (mockStreamMessage.mock.calls[0][2] as api.StreamHandlers).onDone?.();
      dispatchChatStreamEvent({ event: 'turn_start', data: { ...self, seq: 0, userText: '', selfInitiated: true } }, background);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(result.current.node?.pendingQueued?.map((entry) => entry.id)).toEqual(['q-1']);
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchChatStreamEvent({ event: 'done', data: { ...self, seq: 1, stopReason: 'end_turn', persisted: true } }, background);
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    expect(mockStreamMessage.mock.calls[1][1]).toContain('queued while busy');
    expect(result.current.node?.pendingQueued).toBeUndefined();
  });

  it('a send that waited for a mentioned chat’s history goes back to the composer when another turn started meanwhile', async () => {
    vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [
        { id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 },
        { id: 'lazy-tree', root_node_id: 'lazy-node', created_at: 2, last_active_at: 2 },
      ],
      nodes: [
        { id: 'cancel-node', tree_id: 'cancel-tree', status: 'idle', acp_session_id: 'native-session', runtime_id: 'claude',
          last_applied_turn_id: 'old-foreground', last_applied_seq: 1 },
        { id: 'lazy-node', tree_id: 'lazy-tree', status: 'idle', runtime_id: 'claude', message_count: 2 },
      ],
      messages: [
        { id: 'old-user', node_id: 'cancel-node', role: 'user', content: 'earlier prompt', seq: 0 },
        { id: 'old-a', node_id: 'cancel-node', role: 'assistant', content: 'partial', seq: 1 },
      ],
    }]);
    vi.mocked(api.fetchTreeMessagePage).mockReturnValue(new Promise(() => {}));
    const actual = await vi.importActual<typeof import('../services/api/persistence')>('../services/api/persistence');
    let answerPage!: () => void;
    vi.mocked(persistence.fetchTreeMessagePage).mockImplementationOnce(() => new Promise((resolve) => {
      answerPage = () => resolve({ messages: [
        { id: 'lazy-u', node_id: 'lazy-node', role: 'user', content: 'lazy question', seq: 0 },
        { id: 'lazy-a', node_id: 'lazy-node', role: 'assistant', content: 'lazy answer', seq: 1 },
      ] });
    }));
    try {
      const { result } = renderHook(() => ({ store: useChatStore(), node: useChatNode('cancel-node'), lazy: useChatNode('lazy-node') }), { wrapper });
      await waitFor(() => expect(result.current.lazy?.messagesLoaded).toBe(false));
      await act(async () => { result.current.store.openPane('cancel-node'); });
      await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
      const text = `compare with ${encodeNodeMentionToken('lazy-node')}`;
      act(() => { result.current.store.sendMessage('cancel-node', text); });
      await waitFor(() => expect(persistence.fetchTreeMessagePage).toHaveBeenCalled());
      act(() => {
        dispatchChatStreamEvent({ event: 'turn_start', data: {
          nodeId: 'cancel-node', turnId: 'self-turn', assistantId: 'self-a', seq: 0, userText: '', selfInitiated: true,
        } }, backgroundForCancellationNode());
      });
      expect(result.current.node?.status).toBe('streaming');
      await act(async () => { answerPage(); });
      await waitFor(() => expect(result.current.lazy?.messagesLoaded).toBe(true));
      await waitFor(() => expect(result.current.node?.composerDraft?.value).toBe(text));
      expect(mockStreamMessage).not.toHaveBeenCalled();
    } finally {
      vi.mocked(persistence.fetchTreeMessagePage).mockImplementation(actual.fetchTreeMessagePage);
    }
  });

  it('a send that waits for a mentioned chat’s history goes through when that chat is renamed meanwhile', async () => {
    vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [
        { id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 },
        { id: 'lazy-tree', root_node_id: 'lazy-node', created_at: 2, last_active_at: 2 },
      ],
      nodes: [
        { id: 'cancel-node', tree_id: 'cancel-tree', status: 'idle', acp_session_id: 'native-session', runtime_id: 'claude' },
        { id: 'lazy-node', tree_id: 'lazy-tree', status: 'idle', runtime_id: 'claude', message_count: 2 },
      ],
      messages: [],
    }]);
    vi.mocked(api.fetchTreeMessagePage).mockReturnValue(new Promise(() => {}));
    const actual = await vi.importActual<typeof import('../services/api/persistence')>('../services/api/persistence');
    let answerPage!: () => void;
    vi.mocked(persistence.fetchTreeMessagePage).mockImplementationOnce(() => new Promise((resolve) => {
      answerPage = () => resolve({ messages: [
        { id: 'lazy-u', node_id: 'lazy-node', role: 'user', content: 'lazy question', seq: 0 },
        { id: 'lazy-a', node_id: 'lazy-node', role: 'assistant', content: 'lazy answer', seq: 1 },
      ], pages: [{ nodeId: 'lazy-node', total: 2, before: null }] });
    }));
    try {
      const { result } = renderHook(() => ({ store: useChatStore(), lazy: useChatNode('lazy-node') }), { wrapper });
      await waitFor(() => expect(result.current.lazy?.messagesLoaded).toBe(false));
      act(() => { result.current.store.sendMessage('cancel-node', `compare with ${encodeNodeMentionToken('lazy-node')}`); });
      await waitFor(() => expect(persistence.fetchTreeMessagePage).toHaveBeenCalled());
      act(() => { result.current.store.renameNode('lazy-node', 'Renamed meanwhile'); });
      await act(async () => { answerPage(); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(result.current.lazy).toMatchObject({ messagesLoaded: true, title: 'Renamed meanwhile' });
    } finally {
      vi.mocked(persistence.fetchTreeMessagePage).mockImplementation(actual.fetchTreeMessagePage);
    }
  });

  it('a Stop on a running chat Michi has no handle for does not stop the next message', async () => {
    vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
      workspace: { id: 'cancel-ws', name: 'Cancellation', created_at: 1, active_tree_id: 'cancel-tree' },
      trees: [{ id: 'cancel-tree', root_node_id: 'cancel-node', created_at: 1, last_active_at: 1 }],
      // Running, with no turn this window could replay or cancel.
      nodes: [{ id: 'cancel-node', status: 'streaming', acp_session_id: 'native-session', runtime_id: 'claude' }],
      messages: [
        { id: 'old-user', node_id: 'cancel-node', role: 'user', content: 'earlier prompt', seq: 0 },
        { id: 'old-a', node_id: 'cancel-node', role: 'assistant', content: 'partial', seq: 1 },
      ],
    }]);
    const { result } = renderHook(() => ({ store: useChatStore(), node: useChatNode('cancel-node') }), { wrapper });
    await waitFor(() => expect(result.current.node?.status).toBe('streaming'));
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(result.current.node?.status).toBe('idle');
    const cancelNext = vi.fn();
    mockStreamMessage.mockImplementationOnce(() => cancelNext);
    await act(async () => { result.current.store.sendMessage('cancel-node', 'next message'); });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(cancelNext).not.toHaveBeenCalled();
    expect(result.current.node?.status).toBe('streaming');
  });

  it('a queue an error paused stays queued after the next turn ends', async () => {
    const { result } = hydratedCancellationNode('idle');
    await waitFor(() => expect(result.current.node?.messages.length).toBe(2));
    await act(async () => { result.current.store.sendMessage('cancel-node', 'first'); });
    act(() => {
      result.current.store.queueMessage('cancel-node', { id: 'q-1', value: 'queued while busy', mentions: [], attachments: [], queuedAt: 1 });
    });
    act(() => { (mockStreamMessage.mock.calls[0][2] as api.StreamHandlers).onError?.('model unavailable'); });
    expect(result.current.node?.status).toBe('error');
    expect(result.current.node?.queueErrored).toBe(true);

    await act(async () => { result.current.store.sendMessage('cancel-node', 'sent by hand'); });
    expect(mockStreamMessage).toHaveBeenCalledTimes(2);
    act(() => { (mockStreamMessage.mock.calls[1][2] as api.StreamHandlers).onDone?.(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(mockStreamMessage).toHaveBeenCalledTimes(2);
    expect(result.current.node?.pendingQueued?.map((entry) => entry.id)).toEqual(['q-1']);
    expect(result.current.node?.queueErrored).toBe(true);
  });

  it('a recovered replay whose turn ended elsewhere while it waited to reconnect does not take over the next turn', async () => {
    const { result } = hydratedCancellationNode('streaming');
    await waitFor(() => expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.store.openPane('cancel-node'); });
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalledTimes(1));
    const replay = vi.mocked(api.reattachTurnReplay).mock.calls[0][1];
    const cancelNew = vi.fn();
    mockStreamMessage.mockImplementationOnce(() => cancelNew);
    act(() => {
      dispatchChatStreamEvent({ event: 'done', data: {
        nodeId: 'cancel-node', turnId: 'old-foreground', assistantId: 'old-a', seq: 3, stopReason: 'end_turn', persisted: true,
      } }, backgroundForCancellationNode());
    });
    expect(result.current.node?.status).toBe('idle');
    // Waiting to reconnect, the replay finds it no longer owns the node.
    expect(replay.isCurrent()).toBe(false);
    act(() => { replay.onStale?.(); });
    await act(async () => { result.current.store.sendMessage('cancel-node', 'new foreground'); });
    expect(api.reattachTurnReplay).toHaveBeenCalledTimes(1);
    act(() => { result.current.store.cancelStream('cancel-node'); });
    expect(cancelNew).toHaveBeenCalledTimes(1);
    expect(api.cancelChatAndObserve).not.toHaveBeenCalled();
  });

  it('createChildChat from a streaming parent starts an independent new stream', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());
    // Workspaces start empty; create the first thread explicitly so we have
    // a node to send messages to. Mirrors what Home composer's submit does.
    let rootId: string = '';
    await act(async () => {
      rootId = (await result.current.store.createThread()) ?? '';
    });

    await act(async () => {
      result.current.store.sendMessage(rootId, 'parent turn');
    });
    await waitFor(() => expect(result.current.nodes[rootId].status).toBe('streaming'));
    mockStreamMessage.mockClear();
    mockEnsureSession.mockClear();

    let childId: string | undefined;
    await act(async () => {
      childId = await result.current.store.createChildChat(rootId, 'branch off');
    });

    expect(childId).toBeDefined();
    expect(result.current.nodes[childId!]).toBeDefined();
    expect(result.current.nodes[childId!].parentNodeId).toBe(rootId);
    expect(mockEnsureSession).toHaveBeenCalled();
    expect(mockStreamMessage).toHaveBeenCalledTimes(1);
    // Parent node remains streaming; child gets its own turn.
    expect(result.current.nodes[rootId].status).toBe('streaming');
  });

  it('starts a branch on the parent runtime and model unless the caller names a runtime', async () => {
    mockEnsureSession.mockImplementation(() => Promise.resolve({
      chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh', runtimeId: 'codex', providerId: 'openai', modelId: 'gpt-x', reasoning: 'high',
    }));
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = (await result.current.store.createThread()) ?? ''; });
    await act(async () => { result.current.store.sendMessage(rootId, 'parent turn'); });
    await waitFor(() => expect(result.current.nodes[rootId].runtimeId).toBe('codex'));

    const ensuredFor = async (meta?: Parameters<typeof result.current.store.createChildChat>[2], opts?: Parameters<typeof result.current.store.createChildChat>[3]) => {
      mockEnsureSession.mockClear();
      let childId = '';
      await act(async () => { childId = await result.current.store.createChildChat(rootId, 'branch off', meta, opts); });
      await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({ nodeId: childId })));
      return mockEnsureSession.mock.calls.find(([input]) => input.nodeId === childId)![0];
    };
    expect(await ensuredFor()).toMatchObject({ runtimeId: 'codex', providerId: 'openai', modelId: 'gpt-x', reasoning: 'high' });
    expect(await ensuredFor({ displayText: 'branch off' })).toMatchObject({ runtimeId: 'codex', modelId: 'gpt-x' });
    const named = await ensuredFor({ runtimeId: 'claude' });
    expect(named).toMatchObject({ runtimeId: 'claude' });
    expect(named.modelId).toBeUndefined();
    const agent = await ensuredFor(undefined, { primaryAgent: { backendConnectionId: 'local', definitionId: 'implementer' } });
    expect(agent.runtimeId).toBeUndefined();
  });

  it.each(['mode', 'primary'] as const)('starts a digest follow-up with its selected %s Agent and source context', async (selection) => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = result.current.store.createThread()!; });
    const projectId = result.current.store.activeProject!.id;
    const treeId = result.current.store.activeProject!.activeTreeId;
    let digestId = '';
    await act(async () => { digestId = await result.current.store.createDigest(projectId, [rootId]); });
    await waitFor(() => expect(result.current.nodes[digestId].digest?.status).toBe('idle'));

    let childId = '';
    await act(async () => {
      childId = await result.current.store.createChildChat(digestId, 'Explain the decisions', {
        runtimeId: 'codex', modelId: 'test-model', reasoning: 'high',
      }, selection === 'mode' ? { modeId: 'build' } : {
        primaryAgent: { backendConnectionId: 'local', definitionId: 'implementer' },
      });
    });

    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledOnce());
    expect(result.current.nodes[childId].parentNodeId).toBe(rootId);
    expect(result.current.store.activeProject!.activeTreeId).toBe(treeId);
    expect(result.current.store.focusedPane).toBe(childId);
    expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: childId,
      workspaceId: projectId,
      modeId: selection === 'mode' ? 'build' : undefined,
      runtimeId: 'codex', modelId: 'test-model', reasoning: 'high',
      mergeContexts: [expect.stringContaining('Keep the source thread context.')],
      graphPrerequisite: expect.objectContaining({
        node: expect.objectContaining({ id: childId, treeId }),
      }),
    }));
    if (selection === 'primary') {
      expect(api.bindPendingPrimaryAgent).toHaveBeenCalledWith(childId, {
        workspaceId: projectId, backendConnectionId: 'local', definitionId: 'implementer',
      });
      expect(vi.mocked(api.bindPendingPrimaryAgent).mock.invocationCallOrder[0])
        .toBeLessThan(mockEnsureSession.mock.invocationCallOrder[0]);
    }
  });

  it.each(['blank child', 'launcher side chat'] as const)('puts a %s of a digest in its source thread, with the digest as first-send context', async (entry) => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test', undefined); });
    let rootId = '';
    await act(async () => { rootId = result.current.store.createThread()!; });
    const projectId = result.current.store.activeProject!.id;
    const treeId = result.current.store.activeProject!.activeTreeId;
    let digestId = '';
    await act(async () => { digestId = await result.current.store.createDigest(projectId, [rootId]); });
    await waitFor(() => expect(result.current.nodes[digestId].digest?.status).toBe('idle'));

    let childId = '';
    if (entry === 'blank child') {
      await act(async () => { childId = await result.current.store.createBlankChild(digestId); });
    } else {
      act(() => { result.current.store.focusPane(digestId); });
      let launcherId = '';
      act(() => { launcherId = result.current.store.openLauncherPane(); });
      await act(async () => { childId = await result.current.store.activateLauncherPane(launcherId, 'side-chat'); });
    }

    expect(result.current.nodes[childId].parentNodeId).toBe(rootId);
    expect(result.current.store.activeProject!.edges).toContainEqual(expect.objectContaining({ source: rootId, target: childId }));
    expect(result.current.store.focusedPane).toBe(childId);

    await act(async () => { result.current.store.sendMessage(childId, 'What was decided?'); });
    await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledOnce());
    expect(mockEnsureSession).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: childId,
      mergeContexts: [expect.stringContaining('Keep the source thread context.')],
      graphPrerequisite: expect.objectContaining({
        node: expect.objectContaining({ id: childId, treeId }),
      }),
    }));
  });

  /** A project with threads; the last one created holds pane focus. */
  async function threadsInFocusedWindow(count: number) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const view = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => {
      await view.result.current.store.createProject('test', undefined);
    });
    await waitFor(() => expect(view.result.current.store.activeProject).toBeTruthy());
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await act(async () => {
        ids.push((await view.result.current.store.createThread()) ?? '');
      });
    }
    await waitFor(() => expect(view.result.current.store.focusedPane).toBe(ids.at(-1)));
    return { ...view, ids };
  }

  async function streamingHandlers(result: Awaited<ReturnType<typeof threadsInFocusedWindow>>['result'], nodeId: string, text: string) {
    await act(async () => {
      result.current.store.sendMessage(nodeId, text);
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalled());
    mockPresentAttention.mockClear();
    return mockStreamMessage.mock.calls.at(-1)![2] as {
      onDone?: () => void;
      onPermissionRequest?: (data: unknown) => void;
      onPermissionResolved?: (data: unknown) => void;
      onUserInputRequest?: (data: unknown) => void;
      onUserInputResolved?: (data: unknown) => void;
    };
  }

  it('hands a finished turn in the focused pane to the attention policy too', async () => {
    const { result, ids: [rootId] } = await threadsInFocusedWindow(1);
    const handlers = await streamingHandlers(result, rootId, 'hello');
    act(() => {
      handlers.onDone?.();
    });

    // No early return for the focused pane: with the window in the
    // background nobody sees it finish. The policy keeps quiet while this
    // window shows the pane and has focus.
    const [finished] = attentionIntents('finished');
    expect(finished).toMatchObject({
      key: `node:${rootId}`, body: 'Streaming finished',
      target: { type: 'node', nodeId: rootId, workspaceId: result.current.store.activeProject!.id, backendConnectionId: 'local' },
    });
    expect(visibleOnDashboard(finished)).toBe(true);
    expect(finished.isTargetVisible!()).toBe(false);
    expect(finished.isStillCurrent!()).toBe(true);
  });

  it('reports a finished turn in another thread as not visible', async () => {
    const { result, ids: [firstRootId] } = await threadsInFocusedWindow(2);
    const handlers = await streamingHandlers(result, firstRootId, 'background work');
    act(() => {
      handlers.onDone?.();
    });

    // The notification carries the thread's derived title instead of the
    // generic 'Branch complete' fallback — the first turn's title is derived
    // from the first user message ('background work') at turn-end, so
    // node.title is set by the time the notification builds.
    const [finished] = attentionIntents('finished');
    expect(finished).toMatchObject({ title: 'background work', body: 'Streaming finished' });
    expect(visibleOnDashboard(finished)).toBe(false);
  });

  it('renames a thread by renaming its root, and announces its finish by that name', async () => {
    const { result, ids: [firstRootId] } = await threadsInFocusedWindow(2);
    const tree = result.current.store.activeProject!.trees.find((candidate) => candidate.rootNodeId === firstRootId)!;
    act(() => {
      result.current.store.renameTree(tree.id, 'Memory workflow');
    });
    // One name: the root's title, saved like any rename; no thread name beside it.
    expect(result.current.nodes[firstRootId]).toMatchObject({ title: 'Memory workflow', titleNeedsPersistence: true });
    expect(result.current.store.activeProject!.trees.find((candidate) => candidate.id === tree.id)).not.toHaveProperty('name');
    const handlers = await streamingHandlers(result, firstRootId, 'background work');
    act(() => {
      handlers.onDone?.();
    });
    const [finished] = attentionIntents('finished');
    expect(finished).toMatchObject({ title: 'Memory workflow', body: 'Streaming finished' });
  });

  it('drops a finish once a queued follow-up has started', async () => {
    const { result, ids: [rootId] } = await threadsInFocusedWindow(1);
    const handlers = await streamingHandlers(result, rootId, 'first');
    act(() => {
      result.current.store.queueMessage(rootId, { id: 'q1', value: 'and then', mentions: [], attachments: [], queuedAt: 1 });
      handlers.onDone?.();
    });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    const [finished] = attentionIntents('finished');
    expect(finished.isStillCurrent!()).toBe(false);
  });

  it('raises a tool approval in a background pane while the window is focused, until it is answered', async () => {
    const { result, ids: [approvingId] } = await threadsInFocusedWindow(2);
    const handlers = await streamingHandlers(result, approvingId, 'background work');
    act(() => {
      handlers.onPermissionRequest?.({ requestId: 7, title: 'Run npm test', options: [] });
    });

    // Pre-fix this was gated on `!document.hasFocus()`: silent in a focused window.
    const [approval] = attentionIntents('needs_input');
    expect(approval).toMatchObject({ key: `node:${approvingId}`, title: 'Tool approval needed', body: 'Run npm test' });
    expect(visibleOnDashboard(approval)).toBe(false);
    expect(approval.isStillCurrent!()).toBe(true);

    act(() => {
      handlers.onPermissionResolved?.({ requestId: 7 });
    });
    expect(approval.isStillCurrent!()).toBe(false);
    expect(dismissAttention).toHaveBeenCalledWith(`node:${approvingId}`, 'needs_input');
  });

  it('raises an Ask User request in a background pane while the window is focused, until it is answered', async () => {
    const { result, ids: [askingId] } = await threadsInFocusedWindow(2);
    const handlers = await streamingHandlers(result, askingId, 'background work');
    act(() => {
      handlers.onUserInputRequest?.({
        requestId: 3,
        questions: [{ question: 'Which database?', options: [], multiSelect: false }],
      });
    });

    const [ask] = attentionIntents('needs_input');
    expect(ask).toMatchObject({ key: `node:${askingId}`, title: 'Agent needs your input', body: 'Which database?' });
    expect(visibleOnDashboard(ask)).toBe(false);
    expect(ask.isStillCurrent!()).toBe(true);
    expect(result.current.nodes[askingId].pendingUserInput?.requestId).toBe(3);

    act(() => {
      handlers.onUserInputResolved?.({ requestId: 3, answers: [] });
    });
    expect(ask.isStillCurrent!()).toBe(false);
    expect(dismissAttention).toHaveBeenCalledWith(`node:${askingId}`, 'needs_input');
  });

  it('reports an Ask User request on the focused pane as visible, so a focused window stays quiet', async () => {
    const { result, ids: [rootId] } = await threadsInFocusedWindow(1);
    const handlers = await streamingHandlers(result, rootId, 'hello');
    act(() => {
      handlers.onUserInputRequest?.({
        requestId: 1,
        questions: [{ question: 'Which database?', options: [], multiSelect: false }],
      });
    });

    // The inline ask card is already on screen — the pending state (and the
    // global alert bar it drives) is reminder enough.
    const [ask] = attentionIntents('needs_input');
    expect(visibleOnDashboard(ask)).toBe(true);
    expect(result.current.nodes[rootId].pendingUserInput?.requestId).toBe(1);
  });

  it('does not let a stale RAF commit roll streaming text backward', async () => {
    const originalWindowRaf = window.requestAnimationFrame;
    const originalGlobalRaf = globalThis.requestAnimationFrame;
    const rafCallbacks: FrameRequestCallback[] = [];
    const fakeRaf = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: fakeRaf,
    });
    (globalThis as any).requestAnimationFrame = fakeRaf;

    try {
      const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });

      await act(async () => {
        await result.current.store.createProject('test', undefined);
      });
      await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

      let rootId = '';
      await act(async () => {
        rootId = (await result.current.store.createThread()) ?? '';
      });

      await act(async () => {
        result.current.store.sendMessage(rootId, 'hello');
      });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));

      const handlers = mockStreamMessage.mock.calls[0][2] as {
        onChunk?: (text: string) => void;
      };

      await act(async () => {
        handlers.onChunk?.('a');
        expect(rafCallbacks).toHaveLength(1);
        rafCallbacks.shift()?.(performance.now());
        handlers.onChunk?.('b');
      });

      // Let the React commit from the first RAF run its effect. The committed
      // state only contains "a"; nodesRef has already advanced to "ab".
      await act(async () => {});

      act(() => {
        handlers.onChunk?.('c');
      });

      await act(async () => {
        while (rafCallbacks.length > 0) {
          rafCallbacks.shift()?.(performance.now());
        }
      });

      rerender();
      expect(assistantAnswerRaw(result.current.nodes[rootId])).toBe('abc');
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRaf,
      });
      (globalThis as any).requestAnimationFrame = originalGlobalRaf;
    }
  });

  it('does not let a pending draft RAF resurrect a draft cleared before commit', async () => {
    const originalWindowRaf = window.requestAnimationFrame;
    const originalGlobalRaf = globalThis.requestAnimationFrame;
    const rafCallbacks: FrameRequestCallback[] = [];
    const fakeRaf = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: fakeRaf,
    });
    (globalThis as any).requestAnimationFrame = fakeRaf;

    try {
      const { result, rerender } = renderHook(() => useStoreAndNodes(), { wrapper });
      await act(async () => {
        await result.current.store.createProject('test', undefined);
      });
      await waitFor(() => expect(result.current.store.activeProject).toBeTruthy());

      let rootId = '';
      await act(async () => {
        rootId = await result.current.store.createThread() ?? '';
      });

      act(() => {
        result.current.store.setComposerDraft(rootId, {
          value: 'do not resurrect',
          mentions: [],
          quotedText: 'selected passage',
        });
        result.current.store.setComposerDraft(rootId, null);
      });
      expect(rafCallbacks).toHaveLength(1);

      await act(async () => {
        while (rafCallbacks.length > 0) {
          rafCallbacks.shift()?.(performance.now());
        }
      });
      rerender();

      expect(result.current.nodes[rootId].composerDraft).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalWindowRaf,
      });
      (globalThis as any).requestAnimationFrame = originalGlobalRaf;
    }
  });

  it('refuses a Windows folder nested in one the workspace has', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test'); });
    const projectId = result.current.store.activeProject!.id;
    act(() => {
      result.current.store.addFolder(projectId, 'C:\\Users\\me\\proj');
      result.current.store.addFolder(projectId, 'C:\\Users\\me\\proj\\sub');
    });
    expect(result.current.store.activeProject?.folders?.map((folder) => folder.path)).toEqual(['C:\\Users\\me\\proj']);
  });

  it('uses the first added folder for fresh sessions and protects it when removing folders', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
    await act(async () => { await result.current.store.createProject('test'); });
    const projectId = result.current.store.activeProject!.id;
    act(() => {
      result.current.store.addFolder(projectId, '/tmp/primary');
      result.current.store.addFolder(projectId, '/tmp/reference');
    });
    expect(result.current.store.activeProject?.cwd).toBe('/tmp/primary');
    const [primary, reference] = result.current.store.activeProject!.folders!;
    act(() => {
      result.current.store.removeFolder(projectId, primary.id);
      result.current.store.removeFolder(projectId, reference.id);
    });
    expect(result.current.store.activeProject?.folders).toEqual([primary]);
    expect(result.current.store.activeProject?.cwd).toBe(primary.path);

    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    await act(async () => { result.current.store.sendMessage(nodeId, 'Read the workspace'); });
    await waitFor(() => expect(mockEnsureSession).toHaveBeenCalledTimes(1));
    expect(mockEnsureSession.mock.calls[0][0]).toMatchObject({ cwd: primary.path, workspaceId: projectId });
  });

  it('updates the default folder without changing an already bound session', async () => {
    const { result } = renderHook(() => useStoreAndNodes(), { wrapper });

    await act(async () => {
      await result.current.store.createProject('test', '/tmp/original');
    });
    await waitFor(() => expect(result.current.store.activeProject?.cwd).toBe('/tmp/original'));
    const projectId = result.current.store.activeProject!.id;
    act(() => { result.current.store.addFolder(projectId, '/tmp/reference', 'Reference'); });
    let nodeId = '';
    await act(async () => { nodeId = result.current.store.createThread()!; });
    await act(async () => { result.current.store.sendMessage(nodeId, 'Keep this native session'); });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    const boundChatId = result.current.nodes[nodeId].chatId;
    expect(boundChatId).toBeTruthy();

    act(() => {
      result.current.store.setProjectCwd(projectId, '/tmp/relinked');
    });

    expect(result.current.store.activeProject?.cwd).toBe('/tmp/relinked');
    expect(result.current.store.activeProject?.folders?.map((folder) => folder.path)).toEqual(['/tmp/relinked', '/tmp/reference']);
    expect(result.current.nodes[nodeId].chatId).toBe(boundChatId);
    expect(mockEnsureSession).toHaveBeenCalledTimes(1);

    act(() => { result.current.store.setProjectCwd(projectId, '/tmp/reference'); });
    expect(result.current.store.activeProject?.cwd).toBe('/tmp/reference');
    expect(result.current.store.activeProject?.folders?.map((folder) => folder.path)).toEqual(['/tmp/reference', '/tmp/relinked']);
    expect(result.current.store.activeProject?.folders?.[0].label).toBe('Reference');
    expect(result.current.nodes[nodeId].chatId).toBe(boundChatId);
  });

  // The previous reply is visibly finished but its runtime cleanup still holds
  // the session, so ensure-session answers 409 turn_active for a short while.
  describe('sending right after a reply while its cleanup holds the session', () => {
    let ensureResponses: Array<() => Response>;
    let fetchMock: ReturnType<typeof vi.fn>;
    const busy = () => new Response(JSON.stringify({ code: 'turn_active', error: 'Cannot replace an active turn' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    });
    const ensureCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/ensure-session'));

    async function finishedFirstTurn() {
      const rendered = renderHook(() => useStoreAndNodes(), { wrapper });
      const { result } = rendered;
      await act(async () => { await result.current.store.createProject('test', undefined); });
      let nodeId = '';
      await act(async () => { nodeId = result.current.store.createThread()!; });
      await act(async () => { result.current.store.sendMessage(nodeId, 'first'); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      act(() => {
        const handlers = mockStreamMessage.mock.calls[0][2] as api.StreamHandlers;
        handlers.onChunk?.('first answer');
        handlers.onDone?.();
      });
      expect(result.current.nodes[nodeId].status).toBe('idle');
      const firstAssistant = result.current.nodes[nodeId].messages.at(-1)!;
      // From here on ensure-session goes through the real request code.
      ensureResponses = [];
      fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        if (!String(url).includes('/ensure-session')) return new Response(null, { status: 404 });
        return (ensureResponses.shift() ?? busy)();
      });
      vi.stubGlobal('fetch', fetchMock);
      mockEnsureSession.mockImplementation(ensureSessionRequest);
      vi.useFakeTimers();
      return { ...rendered, nodeId, firstAssistant };
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('waits silently and sends the message once the session is free', async () => {
      const { result, nodeId } = await finishedFirstTurn();
      ensureResponses.push(busy, () => new Response(JSON.stringify({ chatId: nodeId, currentModeId: null, resumeStrategy: 'live' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
      act(() => { result.current.store.sendMessage(nodeId, 'second'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(ensureCalls()).toHaveLength(1);
      expect(result.current.nodes[nodeId].status).toBe('streaming');
      expect(result.current.nodes[nodeId].error).toBeUndefined();
      expect(result.current.nodes[nodeId].runtimeActivity).toBeUndefined();
      expect(result.current.nodes[nodeId].messages.at(-1)).toMatchObject({ role: 'assistant', text: '', streaming: true });

      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(ensureCalls()).toHaveLength(2);
      expect(ensureCalls()[1][1].body).toBe(ensureCalls()[0][1].body);
      expect(mockStreamMessage).toHaveBeenCalledTimes(2);
      expect(mockStreamMessage.mock.calls[1][1]).toBe('second');
      expect(result.current.nodes[nodeId].status).toBe('streaming');
      expect(result.current.nodes[nodeId].error).toBeUndefined();
      });

    it('shows the existing setup error when the session stays busy', async () => {
      const { result, nodeId } = await finishedFirstTurn();
      act(() => { result.current.store.sendMessage(nodeId, 'second'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
      expect(result.current.nodes[nodeId].error).toBeUndefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(ensureCalls()).toHaveLength(7);
      expect(mockStreamMessage).toHaveBeenCalledTimes(1);
      expect(result.current.nodes[nodeId]).toMatchObject({ status: 'error', error: 'Cannot replace an active turn' });
    });

    it('stops retrying on cancel and leaves the previous turn alone', async () => {
      const { result, nodeId, firstAssistant } = await finishedFirstTurn();
      act(() => { result.current.store.sendMessage(nodeId, 'second'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(ensureCalls()).toHaveLength(1);
      act(() => { result.current.store.cancelStream(nodeId); });
      expect(result.current.nodes[nodeId].status).toBe('idle');
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(ensureCalls()).toHaveLength(1);
      expect(mockStreamMessage).toHaveBeenCalledTimes(1);
      expect(api.cancelChatAndObserve).not.toHaveBeenCalled();
      expect(result.current.nodes[nodeId].error).toBeUndefined();
      expect(result.current.nodes[nodeId].messages.find((message) => message.id === firstAssistant.id)).toEqual(firstAssistant);
    });
  });

  describe('a rerun of a thread whose older history is not loaded yet', () => {
    const olderPage = {
      messages: [
        { id: 'u1', node_id: 'part-node', role: 'user', content: 'first question', seq: 0 },
        { id: 'a1', node_id: 'part-node', role: 'assistant', content: 'first answer', seq: 1 },
      ],
      pages: [{ nodeId: 'part-node', total: 4, before: null }],
    };

    async function partlyLoadedThread() {
      vi.mocked(api.fetchAllWorkspacesMeta).mockResolvedValue([{
        workspace: { id: 'part-ws', name: 'Partial', created_at: 1, active_tree_id: 'part-tree' },
        trees: [{ id: 'part-tree', root_node_id: 'part-node', created_at: 1, last_active_at: 1 }],
        nodes: [{ id: 'part-node', tree_id: 'part-tree', status: 'idle', runtime_id: 'claude', message_count: 4 }],
        messages: [],
      }]);
      // The first page carries the latest two messages; the older two page in on demand.
      vi.mocked(api.fetchTreeMessageSnapshot).mockResolvedValue({
        messages: [
          { id: 'u2', node_id: 'part-node', role: 'user', content: 'second question', seq: 2 },
          { id: 'a2', node_id: 'part-node', role: 'assistant', content: 'second answer', seq: 3 },
        ],
        pages: [{ nodeId: 'part-node', total: 4, before: { seq: 2, id: 'u2' } }],
      });
      const hook = renderHook(() => ({ store: useChatStore(), node: useChatNode('part-node') }), { wrapper });
      await waitFor(() => expect(hook.result.current.node?.messages.map((m) => m.id)).toEqual(['u2', 'a2']));
      expect(hook.result.current.node?.messagesLoaded).toBe(false);
      return hook;
    }

    afterEach(async () => {
      const actual = await vi.importActual<typeof import('../services/api/persistence')>('../services/api/persistence');
      vi.mocked(persistence.fetchTreeMessagePage).mockImplementation(actual.fetchTreeMessagePage);
    });

    it('an edit completes the history and resends from the same message, now further down', async () => {
      const { result } = await partlyLoadedThread();
      vi.mocked(persistence.fetchTreeMessagePage).mockResolvedValueOnce(olderPage);
      await act(async () => { await result.current.store.editAndResend('part-node', 0, 'second question, edited'); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(mockStreamMessage.mock.calls[0][1]).toBe('second question, edited');
      expect(result.current.node?.messages.slice(0, 2).map((m) => m.id)).toEqual(['u1', 'a1']);
      expect(result.current.node?.messages.some((m) => m.id === 'u2' || m.id === 'a2')).toBe(false);
    });

    it('a retry from a message completes the history and reruns that message', async () => {
      const { result } = await partlyLoadedThread();
      vi.mocked(persistence.fetchTreeMessagePage).mockResolvedValueOnce(olderPage);
      await act(async () => { await result.current.store.retryLastTurn('part-node', 0); });
      await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
      expect(mockStreamMessage.mock.calls[0][1]).toBe('second question');
      expect(result.current.node?.messages.slice(0, 2).map((m) => m.id)).toEqual(['u1', 'a1']);
    });

    it('a failed history read sends nothing and trims nothing', async () => {
      const { result } = await partlyLoadedThread();
      vi.mocked(persistence.fetchTreeMessagePage).mockRejectedValue(new Error('history read failed'));
      await act(async () => { await result.current.store.editAndResend('part-node', 0, 'edited'); });
      await act(async () => { await result.current.store.retryLastTurn('part-node', 0); });
      expect(mockStreamMessage).not.toHaveBeenCalled();
      expect(result.current.node?.messages.map((m) => m.id)).toEqual(['u2', 'a2']);
    });

    it('a thread that started a turn during the read is left alone', async () => {
      const { result } = await partlyLoadedThread();
      await act(async () => { result.current.store.openPane('part-node'); });
      await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalled());
      let answer!: () => void;
      vi.mocked(persistence.fetchTreeMessagePage).mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve(olderPage); }));
      let edit!: Promise<void>;
      act(() => { edit = Promise.resolve(result.current.store.editAndResend('part-node', 0, 'edited')); });
      await waitFor(() => expect(persistence.fetchTreeMessagePage).toHaveBeenCalled());
      act(() => {
        const handlers = vi.mocked(api.subscribeBackground).mock.calls.at(-1)![0]('part-node', 'part-node');
        dispatchChatStreamEvent({ event: 'turn_start', data: {
          nodeId: 'part-node', turnId: 'self-turn', assistantId: 'self-a', seq: 0, userText: '', selfInitiated: true,
        } }, handlers);
      });
      expect(result.current.node?.status).toBe('streaming');
      await act(async () => { answer(); await edit; });
      expect(mockStreamMessage).not.toHaveBeenCalled();
      expect(result.current.node?.status).toBe('streaming');
    });
  });

  describe('a server notice opened from its toast or OS notification', () => {
    afterEach(() => {
      resetServerAttentionStore();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const runNotice = (id: string, workspaceId: string) => ({
      id, key: `agent_run:${id}`, kind: 'finished', reason: 'run_completed', title: 'Reviewer completed', body: 'All checks pass',
      target: { type: 'agent_run', runId: `run-${id}`, workspaceId }, createdAt: Date.now(), claimedByWindowId: null, claimedAt: null,
    });

    async function presented(record: ReturnType<typeof runNotice>): Promise<AttentionIntent> {
      receiveServerAttentionFrame('local', 'attention_notification', JSON.stringify(record));
      await waitFor(() => expect(mockPresentAttention.mock.calls.some(([intent]) => intent.target.type === 'agent_run'
        && intent.target.runId === record.target.runId)).toBe(true));
      return mockPresentAttention.mock.calls.map(([intent]) => intent)
        .find((intent) => intent.target.type === 'agent_run' && intent.target.runId === record.target.runId)!;
    }

    it('opens the Agent Run pane under the default title, not the notice title, and survives a workspace this window lacks', async () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      // Every claim is answered "unknown record": a focused window still shows its toast.
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => useStoreAndNodes(), { wrapper });
      await act(async () => { await result.current.store.createProject('runs'); });
      const workspaceId = result.current.store.activeProject!.id;

      const intent = await presented(runNotice('a1', workspaceId));
      act(() => { intent.onOpen!(); });
      // Not in agent domain state here (no provider), so the default: the notice's title names an outcome.
      expect(result.current.store.paneItems[agentRunPaneId('local', 'run-a1')]).toMatchObject({ kind: 'agent-run', title: 'Agent Run' });

      const elsewhere = await presented(runNotice('a2', 'workspace-not-loaded'));
      expect(() => act(() => { elsewhere.onOpen!(); })).not.toThrow();
      expect(warn).toHaveBeenCalledWith('[attention] could not open the notice target', expect.any(Error));
      expect(result.current.store.paneItems[agentRunPaneId('local', 'run-a2')]).toBeUndefined();
    });

    it('Michi\'s records and a scheduled run\'s open through the shell\'s openers, with their reason for the level', async () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
      renderHook(() => useStoreAndNodes(), { wrapper });
      const companionOpens: unknown[] = [];
      const runOpens: unknown[] = [];
      const stopCompanion = onOpenCompanionTargetRequest((target) => companionOpens.push(target));
      const stopRuns = onOpenScheduledRunRequest((target) => runOpens.push(target));
      const open = { kind: 'companion', tab: 'today', itemId: 'cmi-1' };
      receiveServerAttentionFrame('local', 'attention_notification', JSON.stringify({
        id: 'attn-m', key: 'agent:item:cmi-1', kind: 'needs_input', reason: 'needs_you', title: 'Michi', body: 'MyService is blocked',
        target: { type: 'agent', ref: 'item:cmi-1', open, workspaceId: 'ws-michi' }, createdAt: Date.now(), claimedByWindowId: null, claimedAt: null,
      }));
      receiveServerAttentionFrame('local', 'attention_notification', JSON.stringify({
        id: 'attn-s', key: 'scheduled_run:run-1', kind: 'failed', reason: 'run_failed', title: 'Nightly', body: 'Failed: boom',
        target: { type: 'scheduled_run', runId: 'run-1', jobId: 'job-1', nodeId: null, workspaceId: 'ws-1' }, createdAt: Date.now(), claimedByWindowId: null, claimedAt: null,
      }));
      await waitFor(() => expect(mockPresentAttention.mock.calls.filter(([intent]) => intent.source === 'server')).toHaveLength(2));
      const [michi, run] = mockPresentAttention.mock.calls.map(([intent]) => intent).filter((intent) => intent.source === 'server');
      expect([michi!.reason, run!.reason]).toEqual(['needs_you', 'run_failed']);
      act(() => { michi!.onOpen!(); run!.onOpen!(); });
      expect(companionOpens).toEqual([open]);
      expect(runOpens).toEqual([{ runId: 'run-1', jobId: 'job-1', workspaceId: 'ws-1', nodeId: null }]);
      stopCompanion();
      stopRuns();
    });
  });
});
