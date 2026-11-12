/**
 * The composer's permission chip ("Ask", "Trust", …): every pane shows it as
 * before; a pane that says its conversation has no tool that asks (the
 * Companion's, `permissionControl={false}`) leaves it out.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';

if (typeof CSS === 'undefined') {
  (globalThis as { CSS?: unknown }).CSS = {};
}
if (!(CSS as unknown as { highlights?: unknown }).highlights) {
  (CSS as unknown as { highlights: Map<string, unknown> }).highlights = new Map();
}

const node: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
  title: 't', messages: [], followUps: [], status: 'idle',
};

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  const noop = () => {};
  const actions = () => ({
    createContext: noop, focusPane: noop, closePane: noop, reorderPane: noop, sendMessage: noop, retryLastTurn: noop,
    cancelStream: noop, createChildChat: () => Promise.resolve(), fanoutBranches: () => Promise.resolve(), setFocusedNodeId: noop,
    switchAgent: () => Promise.resolve(), resolvePermission: noop, denyPermission: noop, addPendingComment: noop,
    removePendingComment: noop, clearPendingComments: noop, queueMessage: noop, steerMessage: async () => false,
    dequeueMessage: noop, setComposerDraft: noop, deleteContext: noop, setChatPermissionMode: noop,
  });
  const projects = () => ({ activeProject: mockProject, availableModes: [], agentStatus: null, refreshAgentStatus: noop });
  const panes = () => ({ focusedPane: 'n1', openPanes: ['n1'], focusNonce: 0, paneItems: {}, viewMode: 'single' as const });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...panes(), ...actions() }),
    useChatActions: () => actions(),
    useChatProjects: () => projects(),
    useChatPanes: () => panes(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) => selector({ n1: node }),
    useChatNodesSnapshot: () => ({ n1: node }),
    useChatNode: () => node,
    chatLabel: () => '',
  };
});

vi.mock('../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../state/prefs')>('../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      prefs: {
        fontFamily: 'sans', showThoughts: false, terminalPalette: 'michi',
        terminalDensity: 'compact', paneRules: true, focusDim: 0, quoteMaxLines: 2,
        permissionMode: 'ask', globalPermissions: false,
      },
    }),
  };
});

vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../SlashPopup', () => ({ default: () => null }));
vi.mock('../AtMentionPopup', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: unknown, _ref: unknown) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

describe('TPane permission chip', () => {
  it('shows in a pane as before', async () => {
    render(<TPane nodeId="n1" />);
    await screen.findByTestId('composer');
    expect(screen.getByRole('button', { name: 'Permissions: Ask' })).toBeTruthy();
  });

  it('shows in an embedded assistant pane as before', async () => {
    render(<TPane nodeId="n1" embedded />);
    await screen.findByTestId('composer');
    expect(screen.getByRole('button', { name: 'Permissions: Ask' })).toBeTruthy();
  });

  it('is left out where no tool asks (the Companion)', async () => {
    render(<TPane nodeId="n1" embedded permissionControl={false} />);
    await screen.findByTestId('composer');
    expect(screen.queryByRole('button', { name: /^Permissions:/ })).toBeNull();
    // The rest of the composer is there.
    expect(screen.getByRole('button', { name: 'Send (Enter)' })).toBeTruthy();
  });
});
