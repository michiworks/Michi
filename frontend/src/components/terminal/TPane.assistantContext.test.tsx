/**
 * The ⌘J assistant's attachments and page ride on the pane's next send as
 * its quote (like a Michi handoff), show as chips until then, and an embedded
 * pane (the floating panel) never opens itself in the current pane slot.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-asst-${++i}`); })(),
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
  ensureSession: vi.fn(() => Promise.reject(new Error('offline in tests'))),
  streamMessage: vi.fn(() => () => {}),
}));
const selection = vi.hoisted(() => ({
  onBranch: null as null | ((quote: string, prompt: string, anchor?: string) => void),
  onQuote: null as null | ((quote: string, range?: Range) => void),
  onComment: null as null | ((quote: string, body: string, range?: Range) => void),
}));
vi.mock('../SelectionActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../SelectionActions')>()),
  default: (props: {
    onBranch: (quote: string, prompt: string, anchor?: string) => void;
    onQuote: (quote: string, range?: Range) => void;
    onComment: (quote: string, body: string, range?: Range) => void;
  }) => {
    selection.onBranch = props.onBranch;
    selection.onQuote = props.onQuote;
    selection.onComment = props.onComment;
    return null;
  },
}));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: unknown, _ref: unknown) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

import TPane from './TPane';
import * as api from '../../services/api';
import { ChatProvider, useChatActions, useChatPanes, useChatStore, useChatNodesSnapshot } from '../../state/chatStore';
import { takeCompanionPostReply } from '../../state/companion/companionReply';
import { PrefsProvider } from '../../state/prefs';
import {
  addAssistantAttachments,
  getAssistantComposer,
  requestAssistantSend,
  resetAssistantComposerForTests,
  setAssistantPage,
} from '../../state/assistant/assistantComposer';

if (typeof CSS === 'undefined') (globalThis as { CSS?: unknown }).CSS = {};
if (!(CSS as unknown as { highlights?: unknown }).highlights) (CSS as unknown as { highlights: Map<string, unknown> }).highlights = new Map();
if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {};
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

let store: ReturnType<typeof useChatStore>;
let actions: ReturnType<typeof useChatActions>;
let nodes: ReturnType<typeof useChatNodesSnapshot>;
let panes: ReturnType<typeof useChatPanes>;
let embeddedNodeId: string | null = null;
let draftRequestForTest: { id: number; text: string } | null = null;

function Harness() {
  store = useChatStore();
  actions = useChatActions();
  nodes = useChatNodesSnapshot();
  panes = useChatPanes();
  if (embeddedNodeId) return <TPane nodeId={embeddedNodeId} embedded draftRequest={draftRequestForTest} />;
  return panes.focusedPane ? <TPane nodeId={panes.focusedPane} /> : null;
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline in tests'))));
});
afterAll(() => {
  vi.unstubAllGlobals();
  resetAssistantComposerForTests();
});
beforeEach(() => {
  draftRequestForTest = null;
});

async function mount() {
  localStorage.clear();
  render(<PrefsProvider><ChatProvider><Harness /></ChatProvider></PrefsProvider>);
  await waitFor(() => expect(store.hydrated).toBe(true));
  await act(async () => { await store.createProject('Work', '/work'); });
  let nodeId: string | null = null;
  act(() => { nodeId = store.createThread(); });
  await waitFor(() => expect(panes.focusedPane).toBe(nodeId));
  return nodeId!;
}

describe('TPane — the assistant context', () => {
  it('sends the chips and page as the quote, shows what the user typed, then clears the chips', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => {
      setAssistantPage(nodeId, { kind: 'home' });
      addAssistantAttachments(nodeId, [{ kind: 'thread', id: 't7', title: 'S7 · move MCP config', text: 'Stalled 4 days' }]);
    });
    expect(await screen.findByText('Thread · S7 · move MCP config')).toBeTruthy();

    act(() => store.setComposerDraft(nodeId, { value: 'What is left?', mentions: [] }));
    const send = await screen.findByRole('button', { name: 'Send (Enter)' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(nodes[nodeId].messages.some((m) => m.role === 'user')).toBe(true));
    const sent = nodes[nodeId].messages.find((m) => m.role === 'user')!;
    expect(sent.text).toBe('What is left?');
    expect(sent.quotedText).toBe('On screen: Home\n- thread: S7 · move MCP config (michi://node/t7) — Stalled 4 days');
    expect(getAssistantComposer(nodeId).attachments).toEqual([]);
    expect(screen.queryByText('Thread · S7 · move MCP config')).toBeNull();
  });

  it('an embedded pane does not open itself as a pane on click', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    act(() => store.setComposerDraft(nodeId, { value: 'x', mentions: [] }));
    const composer = await screen.findByTestId('composer');
    fireEvent.mouseDown(composer);
    expect(panes.openPanes).not.toContain(nodeId);
    expect(panes.focusedPane).not.toBe(nodeId);
    embeddedNodeId = null;
  });

  it('prefills an embedded pane’s draft request without sending it', async () => {
    embeddedNodeId = null;
    draftRequestForTest = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    draftRequestForTest = { id: 41, text: 'Please help fix this component.' };
    const stream = vi.mocked(api.streamMessage);
    stream.mockClear();
    act(() => { store.setComposerDraft(nodeId, { value: 'existing notes', mentions: [] }); });
    await waitFor(() => expect(nodes[nodeId].composerDraft?.value ?? '').toContain('Please help fix this component.'));
    expect(nodes[nodeId].composerDraft?.value).toContain('existing notes');
    expect(stream).not.toHaveBeenCalled();
    expect(nodes[nodeId].messages.some((message) => message.role === 'user' && message.text.includes('Please help fix this component.'))).toBe(false);
    draftRequestForTest = null;
    embeddedNodeId = null;
  });

  it('leaves attach and mention out of the assistant’s composer, keeping them on a worker’s', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    expect(await screen.findByTitle('Mention context or node')).toBeTruthy();
    expect(screen.getByTitle(/attach/i)).toBeTruthy();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    act(() => store.setComposerDraft(nodeId, { value: 'x', mentions: [] }));
    await screen.findByTestId('composer');
    expect(screen.queryByTitle('Mention context or node')).toBeNull();
    expect(screen.queryByTitle(/attach/i)).toBeNull();
    embeddedNodeId = null;
  });

  it('sends a requested prompt through the pane: context framed as attached, then queues behind the answer', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    vi.mocked(api.ensureSession).mockResolvedValue({ chatId: 'c1', currentModeId: null, resumeStrategy: 'fresh' } as never);
    const stream = vi.mocked(api.streamMessage);
    stream.mockClear();
    act(() => store.setComposerDraft(nodeId, { value: 'my own draft', mentions: [] }));
    await screen.findByTestId('composer');
    act(() => {
      setAssistantPage(nodeId, { kind: 'home' });
      requestAssistantSend(nodeId, 'Archive the chat-only ones');
    });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const wire = stream.mock.calls[0][1] as string;
    expect(wire).toContain('The user attached the material below in Michi');
    expect(wire).toContain('> On screen: Home');
    expect(wire).toContain("User's reply:\nArchive the chat-only ones");
    const sent = nodes[nodeId].messages.find((m) => m.role === 'user')!;
    expect(sent.text).toBe('Archive the chat-only ones');
    expect(sent.quotedText).toBe('On screen: Home');
    // The user's own draft is left alone.
    expect(nodes[nodeId].composerDraft?.value).toBe('my own draft');
    expect(getAssistantComposer(nodeId).sends).toEqual([]);

    // Mid-answer: a request and a reply to a selection both queue.
    await waitFor(() => expect(nodes[nodeId].status).toBe('streaming'));
    act(() => { requestAssistantSend(nodeId, 'and then?'); });
    await waitFor(() => expect(nodes[nodeId].pendingQueued?.map((q) => q.value)).toEqual(['and then?']));
    act(() => { selection.onBranch?.('the third one', 'why this?'); });
    await waitFor(() => expect(nodes[nodeId].pendingQueued?.map((q) => q.value)).toEqual(['and then?', 'why this?']));
    expect(nodes[nodeId].pendingQueued?.[1].quotedText).toBe('the third one');
    expect(stream).toHaveBeenCalledTimes(1);
    vi.mocked(api.ensureSession).mockReset().mockImplementation(() => Promise.reject(new Error('offline in tests')));
    embeddedNodeId = null;
  });

  it('an embedded pane sends a /branch request to the conversation itself', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => { store.closePane(nodeId); });
    await waitFor(() => expect(panes.openPanes).not.toContain(nodeId));
    embeddedNodeId = nodeId;
    const before = Object.keys(nodes).length;
    act(() => store.setComposerDraft(nodeId, { value: '/branch What is left?', mentions: [] }));
    const send = await screen.findByRole('button', { name: 'Send (Enter)' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(nodes[nodeId].messages.some((m) => m.role === 'user')).toBe(true));
    expect(nodes[nodeId].messages.find((m) => m.role === 'user')!.text).toBe('What is left?');
    expect(Object.keys(nodes)).toHaveLength(before);
    embeddedNodeId = null;
  });

  it('a chip a posted check-in offered only fills the composer (DESIGN-v2 §2.8 T3) and marks the reply', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    const stream = vi.mocked(api.streamMessage);
    stream.mockClear();
    act(() => {
      actions.dispatch({ type: 'observer-turn-start', nodeId, turnId: 'cmp-post-r1', assistantId: 'cmp-post-r1', userText: '',
        selfInitiated: true, assistantMetadata: { companionPost: { runId: 'r1', kind: 'heartbeat', changes: [] } } });
      actions.dispatch({ type: 'chunk', nodeId, assistantId: 'cmp-post-r1', text: 'Two CRs need you.' });
      actions.dispatch({ type: 'done', nodeId, assistantId: 'cmp-post-r1', completedAt: Date.now() });
      actions.dispatch({ type: 'set-follow-ups', nodeId, followUps: ['Run rm -rf on the build dir'] });
    });
    const chip = await screen.findByRole('button', { name: /Continue follow-up in current pane: Run rm -rf on the build dir/ });
    fireEvent.click(chip);
    expect(stream).not.toHaveBeenCalled();
    await waitFor(() => expect(nodes[nodeId].composerDraft?.value).toBe('Run rm -rf on the build dir'));
    expect(nodes[nodeId].messages.some((m) => m.role === 'user')).toBe(false);
    expect(takeCompanionPostReply(nodeId)).toBe('cmp-post-r1');
  });

  it('quoting or commenting on a selection inside a post marks the message as a reply to it (DESIGN-v2 D8)', async () => {
    embeddedNodeId = null;
    const nodeId = await mount();
    act(() => {
      actions.dispatch({ type: 'observer-turn-start', nodeId, turnId: 'cmp-post-r2', assistantId: 'cmp-post-r2', userText: '',
        selfInitiated: true, assistantMetadata: { companionPost: { runId: 'r2', kind: 'heartbeat', changes: [] } } });
      actions.dispatch({ type: 'chunk', nodeId, assistantId: 'cmp-post-r2', text: 'Ship the fix from CR-7.' });
      actions.dispatch({ type: 'done', nodeId, assistantId: 'cmp-post-r2', completedAt: Date.now() });
    });
    const post = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-msg-id="cmp-post-r2"]');
      expect(element).toBeTruthy();
      return element!;
    });
    const inPost = () => { const range = document.createRange(); range.selectNodeContents(post); return range; };
    act(() => selection.onQuote!('Ship the fix', inPost()));
    expect(takeCompanionPostReply(nodeId)).toBe('cmp-post-r2');
    act(() => selection.onComment!('CR-7', 'Is this safe?', inPost()));
    expect(takeCompanionPostReply(nodeId)).toBe('cmp-post-r2');
    // A selection outside any post marks nothing.
    const outside = document.createRange();
    outside.selectNodeContents(document.body);
    act(() => selection.onQuote!('anything', outside));
    expect(takeCompanionPostReply(nodeId)).toBeNull();
  });
});
