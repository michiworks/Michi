import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act, screen } from '@testing-library/react';
import TPane from './TPane';
import type { ChatNodeState } from '../../state/chatTypes';
import type { SlashEntry, SlashSkillCatalog } from '../../state/slashEntries';

if (typeof CSS === 'undefined') (globalThis as any).CSS = {};
if (!(CSS as any).highlights) (CSS as any).highlights = new Map();

const mockNode: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat', runtimeId: 'kiro',
  title: 't', messages: [], followUps: [], status: 'idle',
};

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

const librarySkill = (name: string) => ({ id: `library:${name}`, name, description: `${name} skill`, origin: 'library' as const,
  userInvocable: true, modelInvocable: true, enabled: true });
const mockCatalog: SlashSkillCatalog = { skills: [librarySkill('explore'), librarySkill('context')], commands: [{ name: 'context' }] };

const sendMessageFn = vi.fn();
const queueMessageFn = vi.fn();
const fanoutBranchesFn = vi.fn(() => Promise.resolve());
let pickName = 'explore';

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const actions = () => ({
    createContext: () => {}, focusPane: () => {}, closePane: () => {}, reorderPane: () => {},
    sendMessage: sendMessageFn, retryLastTurn: () => {}, cancelStream: () => {},
    createChildChat: () => Promise.resolve(), fanoutBranches: fanoutBranchesFn,
    setFocusedNodeId: () => {}, switchAgent: () => Promise.resolve(),
    resolvePermission: () => {}, denyPermission: () => {},
    addPendingComment: () => {}, removePendingComment: () => {}, clearPendingComments: () => {},
    queueMessage: queueMessageFn, steerMessage: () => Promise.resolve(true), dequeueMessage: () => {},
    setComposerDraft: () => {}, deleteContext: () => {},
  });
  const projects = () => ({ activeProject: mockProject, availableModes: [], agentStatus: null, refreshAgentStatus: () => {} });
  const panes = () => ({ focusedPane: 'n1', openPanes: ['n1'], focusNonce: 0, paneItems: {}, viewMode: 'single' as const });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...panes(), ...actions() }),
    useChatActions: () => actions(),
    useOptionalChatActions: () => actions(),
    useChatProjects: () => projects(),
    useChatPanes: () => panes(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) => selector({ n1: mockNode }),
    useChatNodesSnapshot: () => ({ n1: mockNode }),
    useChatNode: () => mockNode,
    chatLabel: () => '',
  };
});

vi.mock('../../state/skillCatalog', async () => ({
  ...await vi.importActual<any>('../../state/skillCatalog'),
  useSkillCatalog: () => ({ catalog: mockCatalog, load: () => {} }),
  useRuntimeLabel: () => 'Kiro',
}));

vi.mock('../../state/prefs', async () => ({
  ...await vi.importActual<any>('../../state/prefs'),
  usePrefs: () => ({ prefs: { fontFamily: 'sans', showThoughts: false, terminalPalette: 'michi', terminalDensity: 'compact',
    paneRules: true, focusDim: 0, quoteMaxLines: 2 } }),
}));

// The editor stub picks the skill row named `pickName` from the entries TPane gives the menu.
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef(function MentionEditorStub(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, editor: null }));
    return (
      <>
        <textarea data-testid="composer-editor" value={props.value}
          onChange={(event) => props.onChange({ value: event.target.value, mentions: [] })} />
        <button type="button" data-testid="pick-skill" onClick={() => props.onSlashPick?.(
          (props.slashEntries as SlashEntry[]).find((entry) => entry.source === 'skill' && entry.name === pickName))}>pick</button>
        <button type="button" data-testid="editor-submit" onClick={() => props.onSubmit?.({ branch: false })}>submit</button>
      </>
    );
  }),
}));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

beforeEach(() => {
  sendMessageFn.mockReset();
  queueMessageFn.mockReset();
  fanoutBranchesFn.mockClear();
  pickName = 'explore';
  mockNode.status = 'idle';
  delete mockNode.pendingQueued;
});

async function pickAndSubmit(text: string, pick = true) {
  const editor = await screen.findByTestId('composer-editor');
  await act(async () => {
    fireEvent.change(editor, { target: { value: text } });
    if (pick) fireEvent.click(screen.getByTestId('pick-skill'));
    fireEvent.click(screen.getByTestId('editor-submit'));
  });
}

const skillPick = (name: string) => ({
  entry: expect.objectContaining({ name, source: 'skill', tag: 'Skill', skill: expect.objectContaining({ id: `library:${name}` }) }),
  runtimeId: 'kiro',
});

describe('TPane / menu picks', () => {
  it('sends a skill row picked for the name of a Michi command as that skill, where the typed name runs the command', async () => {
    render(<TPane nodeId="n1" />);
    await pickAndSubmit('/explore the repo');
    expect(fanoutBranchesFn).not.toHaveBeenCalled();
    expect(sendMessageFn).toHaveBeenCalledWith('n1', '/explore the repo',
      expect.objectContaining({ displayText: '/explore the repo', slash: skillPick('explore') }));

    await pickAndSubmit('/explore auth; billing', false);
    expect(fanoutBranchesFn).toHaveBeenCalledWith('n1', ['auth', 'billing'], expect.anything());
    expect(sendMessageFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the pick through the queue, a restore and a rejected send, and drops it once the text leaves its /name', async () => {
    pickName = 'context';
    mockNode.status = 'streaming';
    const view = render(<TPane nodeId="n1" />);
    await pickAndSubmit('/context why');
    expect(queueMessageFn).toHaveBeenCalledWith('n1', expect.objectContaining({ value: '/context why', slash: skillPick('context') }));

    mockNode.status = 'idle';
    mockNode.pendingQueued = [{ ...queueMessageFn.mock.calls[0][1], id: 'q1' }];
    view.rerender(<TPane nodeId="n1" contentMaxWidth={800} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dequeue message' })); });
    await act(async () => { fireEvent.click(screen.getByTestId('editor-submit')); });
    expect(sendMessageFn).toHaveBeenLastCalledWith('n1', '/context why', expect.objectContaining({ slash: skillPick('context') }));

    act(() => { sendMessageFn.mock.calls[0][2].onRejected(); });
    await pickAndSubmit('/context why', false);
    expect(sendMessageFn).toHaveBeenLastCalledWith('n1', '/context why', expect.objectContaining({ slash: skillPick('context') }));

    // Edited away from its /name and typed again by hand, the name runs by the typed-name rules.
    act(() => { sendMessageFn.mock.lastCall![2].onRejected(); });
    const editor = screen.getByTestId('composer-editor');
    await act(async () => {
      for (const value of ['/context why', '/contex', '/context now']) fireEvent.change(editor, { target: { value } });
      fireEvent.click(screen.getByTestId('editor-submit'));
    });
    expect(sendMessageFn).toHaveBeenLastCalledWith('n1', '/context now', expect.not.objectContaining({ slash: expect.anything() }));
    expect(sendMessageFn.mock.lastCall![2]).toMatchObject({ slashRuntimeId: 'kiro' });
  });
});
