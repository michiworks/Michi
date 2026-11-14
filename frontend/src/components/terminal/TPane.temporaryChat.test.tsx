/**
 * A temporary chat's pane opens with one line saying so, as wide as its
 * composer, with nothing to close or change; a regular chat's pane has none.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';

if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {};
}
if (!(CSS as any).highlights) {
  (CSS as any).highlights = new Map();
}

const state = vi.hoisted(() => ({ node: null as unknown as ChatNodeState }));

const chat = (patch: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId: 'n1', chatId: 'n1', projectId: 'p1', kind: 'chat', title: 'Compare two job offers', followUps: [], status: 'idle',
  messages: [
    { id: 'u1', role: 'user', text: 'Which offer pays more over five years?', toolCalls: [] },
    { id: 'a1', role: 'assistant', text: 'The second one, by a little.', toolCalls: [] },
  ],
  ...patch,
});

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const actions = () => ({
    createContext: () => {},
    focusPane: () => {},
    closePane: () => {},
    reorderPane: () => {},
    sendMessage: () => {},
    retryLastTurn: () => {},
    cancelStream: () => {},
    createChildChat: () => Promise.resolve(),
    fanoutBranches: () => Promise.resolve(),
    setFocusedNodeId: () => {},
    switchAgent: () => Promise.resolve(),
    resolvePermission: () => {},
    denyPermission: () => {},
    addPendingComment: () => {},
    removePendingComment: () => {},
    clearPendingComments: () => {},
    queueMessage: () => {},
    steerMessage: async () => false,
    dequeueMessage: () => {},
    setComposerDraft: () => {},
    deleteContext: () => {},
  });
  const projects = () => ({ activeProject: mockProject, availableModes: [], agentStatus: null, refreshAgentStatus: () => {} });
  const panes = () => ({ focusedPane: 'n1', openPanes: ['n1'], focusNonce: 0, paneItems: {}, viewMode: 'single' as const });
  const nodes = () => ({ n1: state.node });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...panes(), ...actions() }),
    useChatActions: () => actions(),
    useOptionalChatActions: () => actions(),
    useChatProjects: () => projects(),
    useChatPanes: () => panes(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) => selector(nodes()),
    useChatNodesSnapshot: () => nodes(),
    useChatNode: () => state.node,
    chatLabel: () => '',
  };
});

vi.mock('../../state/prefs', async () => {
  const actual = await vi.importActual<any>('../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      prefs: {
        fontFamily: 'sans', showThoughts: false, terminalPalette: 'michi',
        terminalDensity: 'compact', paneRules: true, focusDim: 0, quoteMaxLines: 2,
      },
    }),
  };
});

vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../SlashPopup', () => ({ default: () => null }));
vi.mock('../AtMentionPopup', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: any, _ref: any) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

const NOTE_TEXT = 'Temporary chat · Memory is off here, and other chats can’t read it.';
const temporaryNote = () => screen.queryByText('· Memory is off here, and other chats can’t read it.')?.closest('[role="note"]') ?? null;

describe('a temporary chat’s pane', () => {
  it('opens with one note saying so, as wide as its composer, with nothing to close or change', () => {
    state.node = chat({ temporary: true });
    render(<TPane nodeId="n1" contentMaxWidth={720} />);
    const note = temporaryNote() as HTMLElement | null;
    expect(note).not.toBeNull();
    expect(note!.textContent).toBe(NOTE_TEXT);
    expect(note!.querySelector('strong')?.textContent).toBe('Temporary chat');
    expect(note!.querySelector('[data-temporary-chat-mark]')).not.toBeNull();
    expect(note!.querySelectorAll('button')).toHaveLength(0);
    // The composer's column: the same max width.
    expect((note!.firstElementChild as HTMLElement).style.maxWidth).toBe('720px');
  });

  it('shows no note in a regular chat’s pane', () => {
    state.node = chat();
    render(<TPane nodeId="n1" />);
    expect(temporaryNote()).toBeNull();
    expect(screen.queryByText(/Memory is off here/)).toBeNull();
  });
});
