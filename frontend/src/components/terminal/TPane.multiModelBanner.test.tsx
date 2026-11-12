/**
 * A branch a multi-model plan created says so in its banner, and whether it
 * got the caller's history (fork) or only its prompt (fresh); Open plan goes
 * back to the run in the caller's Background work drawer. An agent's
 * spawn_branches child keeps "spawned by agent".
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';
import { OPEN_BACKGROUND_WORK_EVENT, type OpenBackgroundWorkDetail } from './backgroundWork/backgroundWorkEvents';

if (typeof CSS === 'undefined') {
  (globalThis as any).CSS = {};
}
if (!(CSS as any).highlights) {
  (CSS as any).highlights = new Map();
}

const state = vi.hoisted(() => ({ child: null as unknown as ChatNodeState, retryLastTurn: vi.fn() }));

const caller: ChatNodeState = {
  nodeId: 'p0', chatId: null, projectId: 'p1', kind: 'chat', title: 'Memory timing', followUps: [], status: 'idle', messages: [],
};
const branch = (patch: Partial<ChatNodeState>): ChatNodeState => ({
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat', title: 'Codex · GPT-6.1 Sol', followUps: [], status: 'idle',
  messages: [], parentNodeId: 'p0', spawnedByAgent: true, ...patch,
});

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['p0', 'n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'p0', createdAt: 0, lastActiveAt: 0 }],
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
    retryLastTurn: state.retryLastTurn,
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
  const nodes = () => ({ p0: caller, n1: state.child });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...panes(), ...actions() }),
    useChatActions: () => actions(),
    useOptionalChatActions: () => actions(),
    useChatProjects: () => projects(),
    useChatPanes: () => panes(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) => selector(nodes()),
    useChatNodesSnapshot: () => nodes(),
    useChatNode: (id: string) => nodes()[id as 'p0' | 'n1'],
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

describe('TPane branch banner', () => {
  it('names a fork branch of a multi-model plan and the chat it inherits', () => {
    state.child = branch({ multiModelRunId: 'wfr_1' });
    render(<TPane nodeId="n1" />);
    expect(screen.getByTestId('pane-spawn-banner').textContent).toBe('⎇multi-model branch · inherits Memory timing' + 'Open plan');
  });

  it('says a fresh branch got only its prompt', () => {
    state.child = branch({ multiModelRunId: 'wfr_1', freshContext: true });
    render(<TPane nodeId="n1" />);
    expect(screen.getByTestId('pane-spawn-banner').textContent).toBe('⎇multi-model branch · fresh context, prompt only' + 'Open plan');
  });

  it('opens the plan in the drawer of the chat that started it', () => {
    state.child = branch({ multiModelRunId: 'wfr_1' });
    render(<TPane nodeId="n1" />);
    const details: OpenBackgroundWorkDetail[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
    window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    } finally {
      window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
    }
    // Without the run in the store, the branch's parent is the run's caller.
    expect(details).toEqual([{ nodeId: 'p0', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']) } }]);
  });

  it('sends the composer\'s Retry of a failed plan step to the plan, not a pane retry', () => {
    state.child = branch({
      multiModelRunId: 'wfr_1', status: 'error', error: 'Codex exited',
      messages: [
        { id: 'u1', role: 'user', text: 'Assess it.', toolCalls: [], threadMessage: { fromNodeId: 'p0', plan: { runId: 'wfr_1', step: 'answer', context: 'fork' } } },
        { id: 'a1', role: 'assistant', text: '', toolCalls: [] },
      ],
    });
    render(<TPane nodeId="n1" />);
    const details: OpenBackgroundWorkDetail[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
    window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Retry last turn' }));
    } finally {
      window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
    }
    expect(state.retryLastTurn).not.toHaveBeenCalled();
    expect(details.map((detail) => detail.nodeId)).toEqual(['p0']);
  });

  it('keeps "spawned by agent" for an agent\'s own branches', () => {
    state.child = branch({});
    render(<TPane nodeId="n1" />);
    expect(screen.getByTestId('pane-spawn-banner').textContent).toBe('⎇spawned by agent · inherits Memory timing');
    expect(screen.queryByRole('button', { name: 'Open plan' })).toBeNull();
  });
});
