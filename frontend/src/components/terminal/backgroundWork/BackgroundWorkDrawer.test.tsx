import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SUBAGENT_UNTRACKED_ERROR, type MultiModelRunView, type WorkflowRunDtoV1 } from 'michi-shared';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import type { ChatMessage, ChatNodeState, SubagentInfo } from '../../../state/chatTypes';
import { WorkflowDomainProvider, type WorkflowDomainApi } from '../../../state/workflowDomain';
import BackgroundWorkDrawer from './BackgroundWorkDrawer';
import type { OpenBackgroundWorkDetail } from './backgroundWorkEvents';
import { useZhCnDefaultLocale } from '../../../test/zhCnLocale';

const project = vi.hoisted(() => {
  const initial = () => ({
    id: 'ws', name: 'WS', chatIds: ['root', 'child', 'idle', 'unloaded', 'other-root'], createdAt: 0, activeTreeId: 'tree',
    trees: [{ id: 'tree', rootNodeId: 'root', name: 'Thread', createdAt: 0 }, { id: 'other', rootNodeId: 'other-root', name: 'Other', createdAt: 0 }],
    edges: [{ source: 'root', target: 'child' }, { source: 'root', target: 'idle' }, { source: 'child', target: 'unloaded' }],
  });
  // Chat actions, as ChatProvider gives them; null outside it (the default here).
  return { initial, current: initial(), actions: null as null | Record<string, ReturnType<typeof vi.fn>> };
});

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../../state/chatStore')>('../../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({ activeProject: project.current }),
    useOptionalChatActions: () => project.actions,
    useOptionalChatProjects: () => (project.actions ? { projects: [project.current], activeProject: project.current } : null),
  };
});

// The Replace model picker's list: nothing to fetch here.
vi.mock('../../../services/api/multiModelRuns', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/multiModelRuns')>('../../../services/api/multiModelRuns');
  return { ...actual, fetchReadyModels: vi.fn(async () => ({ version: 1, runtimes: [] })) };
});

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

const assistant = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', text: '', toolCalls: [], ...patch });
const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'go', toolCalls: [] });

function chat(nodeId: string, title: string, messages: ChatMessage[], patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, title, kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status: 'idle', messagesLoaded: true, ...patch } as ChatNodeState;
}

const oldDone = subagent({ sessionId: 'old-done', agentName: 'Archivist', status: 'terminated', outcome: 'completed', prompt: 'Summarize the archive.', result: 'Archive summarized.' });
// Launched in the earlier turn, which ended 12s in; it keeps running in the background.
const oldBackground = subagent({ sessionId: 'old-bg', agentName: 'Scanner', status: 'terminated', background: true, prompt: 'Scan the repo.', startedAt: 1_000, endedAt: 13_000 });
const latestDone = subagent({ sessionId: 'latest-done', agentName: 'Planner', status: 'terminated', outcome: 'completed', result: '**Plan** ready', usage: { durationMs: 3_200, toolUses: 6 } });
const latestRunning = subagent({ sessionId: 'latest-running', agentName: 'Explore', currentTool: 'Read src/auth.ts', startedAt: 1_000, activity: [{ id: 't1', kind: 'tool', title: 'Read src/auth.ts', status: 'in_progress' }] });

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf_1', workspaceId: 'ws', nodeId: 'root', parentToolCallId: 'tool-wf',
    name: 'probe', status: 'running',
    nodes: [
      { id: 'alpha', kind: 'step', title: 'alpha', status: 'completed', result: 'ALPHA' },
      { id: 'beta', kind: 'step', title: 'beta', status: 'running', currentTool: 'Read beta.txt' },
    ],
    log: [], actions: ['pause', 'stop'], startedAt: 50, updatedAt: 60, revision: 1,
    ...patch,
  };
}

function nodes(): Record<string, ChatNodeState> {
  return {
    root: chat('root', 'Root chat', [
      user('u1'),
      assistant('a1', { subagents: [oldDone, oldBackground], toolCalls: [{ id: 'tool-wf', title: 'Workflow', status: 'completed' }] }),
      user('u2'),
      assistant('a2', { subagents: [latestDone, latestRunning] }),
    ], { status: 'streaming' }),
    child: chat('child', 'Child branch', [user('u1'), assistant('c1', { subagents: [subagent({ sessionId: 'child-agent', agentName: 'Tester', statusMessage: 'Running the suite' })] })], { status: 'streaming' }),
    idle: chat('idle', 'Quiet branch', [user('u1'), assistant('i1')]),
    unloaded: chat('unloaded', 'Not loaded yet', [], { messagesLoaded: false }),
    // Another thread, the active one in some tests.
    'other-root': chat('other-root', 'Other thread', [user('u1'), assistant('o1', { subagents: [subagent({ sessionId: 'other-agent', agentName: 'Elsewhere' })] })], { status: 'streaming' }),
    busy: busyChat(),
  };
}

/** One agent still working, three that finished (one failed), all in the latest turn. */
function busyChat(patch: Partial<SubagentInfo> = {}, extra: ChatMessage[] = []): ChatNodeState {
  return chat('busy', 'Busy chat', [
    user('u1'),
    assistant('b1', {
      subagents: [
        subagent({ sessionId: 'run-1', agentName: 'Runner', currentTool: 'Grep', ...patch }),
        subagent({ sessionId: 'done-1', agentName: 'First', status: 'terminated', outcome: 'completed', result: 'One.' }),
        subagent({ sessionId: 'done-2', agentName: 'Second', status: 'terminated', outcome: 'failed', error: 'Boom.', prompt: 'Try it.' }),
        subagent({ sessionId: 'done-3', agentName: 'Third', status: 'terminated', outcome: 'completed', result: 'Three.' }),
      ],
    }),
    ...extra,
  ], { status: 'streaming' });
}

function nodeStore(initial: Record<string, ChatNodeState>) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    value: {
      getNode: (id: string) => current[id],
      getNodes: () => current,
      subscribeNode: () => () => {},
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getStructureVersion: () => 0,
      subscribeStructure: () => () => {},
    },
    set(next: Record<string, ChatNodeState>) { current = next; for (const listener of listeners) listener(); },
  };
}

function setup(request: OpenBackgroundWorkDetail, initialRuns: WorkflowRunDtoV1[] = [run()], initialNodes = nodes()) {
  const store = nodeStore(initialNodes);
  const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
  let latest = initialRuns[0];
  const api: WorkflowDomainApi = {
    get: vi.fn(async () => latest),
    act: vi.fn(async (_backend, _id, action) => { latest = run({ status: action === 'stop' ? 'cancelled' : 'paused', actions: [], revision: latest.revision + 1 }); return latest; }),
    answer: vi.fn(async () => { latest = { ...latest, approvals: [], revision: latest.revision + 1 }; return latest; }),
    subscribe: vi.fn((_workspaceId, options) => {
      handlers.push(options);
      for (const value of initialRuns) options.onRun(value);
      return () => {};
    }),
  };
  const onClose = vi.fn();
  const ui = (detail: OpenBackgroundWorkDetail, seq: number) => (
    <ChatNodeStoreContext.Provider value={store.value}>
      <WorkflowDomainProvider api={api}>
        <BackgroundWorkDrawer open motion="instant" onClose={onClose} request={detail} requestSeq={seq} />
      </WorkflowDomainProvider>
    </ChatNodeStoreContext.Provider>
  );
  const result = render(ui(request, 1));
  return { ...result, store, api, handlers, onClose, reopen: (detail: OpenBackgroundWorkDetail, seq: number) => result.rerender(ui(detail, seq)) };
}

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  project.current = project.initial();
  project.actions = null;
});
afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const subagentRows = () => screen.queryAllByTestId('background-subagent-row');
const rowIds = () => subagentRows().map((row) => row.getAttribute('data-subagent-id'));
const rowLabel = (row: HTMLElement) => within(row).getAllByRole('button')[0].getAttribute('aria-label');
const scopeButton = () => screen.getByRole('button', { name: /^Show background work for/ });
/** The scope is a menu beside the title. */
function chooseScope(name: 'This conversation' | 'Whole thread') {
  fireEvent.click(scopeButton());
  fireEvent.click(screen.getByRole('menuitemradio', { name }));
}
/** A workflow card's agents (Claude) or steps (Kiro) line, which opens them. */
const agentsToggle = (card: HTMLElement) => within(card).getByRole('button', { name: /^(Steps|Agents)\b/ });

describe('BackgroundWorkDrawer', () => {
  it('lists this conversation\'s work: a card per workflow, a line per subagent, running first', () => {
    setup({ nodeId: 'root' });
    const dialog = screen.getByRole('dialog', { name: 'Background work' });
    expect(within(dialog).getByRole('button', { name: 'Show background work for: This conversation' }).getAttribute('aria-haspopup')).toBe('menu');
    expect(within(dialog).getByTestId('background-work-running').textContent).toBe('3 running');
    // The earlier turn's finished agent is hidden; its background one still runs.
    expect(rowIds()).toEqual(['old-bg', 'latest-running', 'latest-done']);
    const [background, running, done] = subagentRows();
    expect(background.textContent).toContain('Scanner');
    expect(background.textContent).toContain('Scan the repo.');
    expect(background.textContent).toContain('in background');
    expect(background.getAttribute('data-active')).toBe('true');
    expect(running.textContent).toContain('Explore');
    // The tool as a label and its argument: no "now ❯" ornament, no status word.
    expect(running.textContent).toContain('Read src/auth.ts');
    expect(running.textContent).not.toMatch(/now ❯|working/);
    expect(rowLabel(running)).toBe('Explore, working: Read src/auth.ts');
    expect(done.textContent).toContain('Plan ready');
    expect(done.textContent).toContain('3.2s');
    expect(rowLabel(done)).toBe('Planner, completed: Plan ready');
    // Rows stay one line until expanded.
    expect(screen.queryByTestId('subagent-detail')).toBeNull();

    const workflow = screen.getByTestId('background-workflow-row');
    expect(workflow.getAttribute('aria-label')).toBe('Workflow probe, running');
    expect(within(workflow).getByTestId('background-workflow-title').textContent).toBe('Probe');
    expect(within(workflow).getByTestId('background-workflow-status').textContent).toContain('Running');
    expect(workflow.textContent).toContain('1/2 steps');
    // Its steps stay folded until asked for; the one at work still says what it does.
    expect(agentsToggle(workflow).getAttribute('aria-expanded')).toBe('false');
    expect(agentsToggle(workflow).textContent).toContain('beta: Read beta.txt');
    expect(within(workflow).queryAllByTestId('workflow-node')).toHaveLength(0);
  });

  it('expands and scrolls to the focused subagent, even a finished one from an earlier turn', () => {
    setup({ nodeId: 'root', focus: { kind: 'subagent', sessionId: 'old-done' } });
    expect(rowIds()).toEqual(['old-bg', 'latest-running', 'old-done', 'latest-done']);
    const row = subagentRows()[2];
    expect(within(row).getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(within(row).getByTestId('subagent-task').textContent).toBe('Summarize the archive.');
    expect(within(row).getByTestId('subagent-result').textContent).toContain('Archive summarized.');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(row);

    // One expanded at a time; a click toggles.
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    expect(screen.getAllByTestId('subagent-detail')).toHaveLength(1);
    expect(within(subagentRows()[0]).getByTestId('subagent-detail')).toBeTruthy();
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    expect(screen.queryByTestId('subagent-detail')).toBeNull();
  });

  it('switches to the whole thread, grouped by conversation', () => {
    setup({ nodeId: 'root' });
    chooseScope('Whole thread');
    const groups = screen.getAllByTestId('background-work-group');
    // Quiet branch has nothing to show; the unloaded one says it is loading.
    expect(groups.map((group) => group.getAttribute('data-node-id'))).toEqual(['root', 'child', 'unloaded']);
    expect(within(groups[0]).getByTestId('background-work-group-title').textContent).toBe('Root chat');
    expect(groups[0].textContent).toContain('this conversation');
    expect(within(groups[1]).getByTestId('background-subagent-row').textContent).toContain('Running the suite');
    expect(within(groups[2]).getByRole('status').textContent).toBe('loading…');
    expect(screen.getByTestId('background-work-running').textContent).toBe('4 running');
  });

  it('scopes the whole thread to the requested conversation\'s thread, not the active one', () => {
    project.current = { ...project.initial(), activeTreeId: 'other' };
    setup({ nodeId: 'child' });
    chooseScope('Whole thread');
    expect(screen.getAllByTestId('background-work-group').map((group) => group.getAttribute('data-node-id'))).toEqual(['root', 'child', 'unloaded']);
    expect(rowIds()).not.toContain('other-agent');
  });

  it('expands a workflow run with its steps, controls and approvals', async () => {
    const pending = run({
      approvals: [{ id: 'appr_1', nodeId: 'beta', title: 'Read beta.txt', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }], requestedAt: 1 }],
    });
    const { api } = setup({ nodeId: 'root', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']) } }, [pending]);
    const row = screen.getByTestId('background-workflow-row');
    expect(row.getAttribute('aria-label')).toBe('Workflow probe, needs approval');
    expect(within(row).getByTestId('background-workflow-status').textContent).toContain('Needs you');
    expect(screen.getByTestId('background-work-waiting').textContent).toBe('1 needs you');
    // The focus opens its steps; the step the approval names waits on you.
    expect(agentsToggle(row).getAttribute('aria-expanded')).toBe('true');
    const agents = within(row).getByTestId('background-workflow-agents');
    expect(within(agents).getAllByTestId('workflow-node').map((node) => [node.getAttribute('data-node-id'), node.getAttribute('data-node-status')]))
      .toEqual([['alpha', 'completed'], ['beta', 'waiting']]);
    // The full run is fetched for the expanded view.
    expect(api.get).toHaveBeenCalledWith('local', 'wfr_1');

    // The approval is on the card itself, not behind the steps.
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Allow once' })); });
    expect(api.answer).toHaveBeenCalledWith('local', 'wfr_1', 'appr_1', 'allow');
    expect(within(row).queryByTestId('workflow-approval')).toBeNull();

    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Stop workflow probe' })); });
    expect(api.act).toHaveBeenCalledWith('local', 'wfr_1', 'stop');
    expect(within(row).getByTestId('background-workflow-status').textContent).toContain('Stopped');
    expect(screen.queryByTestId('background-work-waiting')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Stop workflow probe' })).toBeNull();
  });

  it('counts a run\'s steps, not its watches, in its count, its strip and its summary', () => {
    const watched = run({
      status: 'failed', actions: [],
      nodes: [
        { id: 'wait-loop', kind: 'loop', title: 'wait-loop', status: 'completed' },
        { id: 'ticker', kind: 'watch', title: 'ticker', parentId: 'wait-loop', status: 'completed' },
        { id: 'react', kind: 'step', title: 'react', parentId: 'wait-loop', status: 'completed' },
        { id: 'survey', kind: 'parallel', title: 'survey', status: 'failed' },
        { id: 'count-lines', kind: 'step', title: 'count-lines', parentId: 'survey', status: 'completed' },
        { id: 'missing-file', kind: 'step', title: 'missing-file', parentId: 'survey', status: 'failed', error: 'No such file' },
      ],
    });
    setup({ nodeId: 'root', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']) } }, [watched]);
    const card = screen.getByTestId('background-workflow-row');
    expect(card.textContent).toContain('2/3 steps');
    const segments = [...card.querySelectorAll('span[title]')].filter((segment) => segment.getAttribute('title')!.includes(' · '));
    expect(segments.map((segment) => segment.getAttribute('title'))).toEqual(['react · done', 'count-lines · done', 'missing-file · failed']);
    expect(agentsToggle(card).textContent).toContain('3 finished · 1 failed');
    // The watch is still listed with its loop, behind the finished loop's fold.
    fireEvent.click(within(card).getByRole('button', { name: /^wait-loop/ }));
    expect(within(card).getAllByTestId('workflow-node').map((node) => node.getAttribute('data-node-id'))).toEqual(['ticker', 'react', 'missing-file']);
  });

  it('updates live while open', () => {
    const { store, handlers, reopen } = setup({ nodeId: 'root' });
    act(() => handlers[0].onRun(run({ revision: 2, nodes: [{ id: 'gamma', kind: 'step', title: 'gamma', status: 'running', currentTool: 'Write out.txt' }] })));
    expect(agentsToggle(screen.getByTestId('background-workflow-row')).textContent).toContain('gamma: Write out.txt');
    const next = nodes();
    next.root = chat('root', 'Root chat', [
      ...next.root.messages,
      user('u3'),
      assistant('a3', { subagents: [subagent({ sessionId: 'fresh', agentName: 'Fresh', currentTool: 'Glob' })] }),
    ], { status: 'streaming' });
    act(() => store.set(next));
    // The new turn is now the latest and its agent shows. What the drawer
    // already listed stays while it is open; the previous turn's working
    // entry no longer runs and reads as ended.
    expect(rowIds()).toEqual(['old-bg', 'fresh', 'latest-done', 'latest-running']);
    const stale = subagentRows()[3];
    expect(stale.getAttribute('data-active')).toBeNull();
    expect(stale.textContent).toContain('ended');
    expect(stale.textContent).not.toContain('now ❯');
    // A new request applies the history rule again.
    reopen({ nodeId: 'root' }, 2);
    expect(rowIds()).toEqual(['old-bg', 'fresh']);
  });

  it('keeps an expanded earlier-turn workflow run and an earlier-turn agent listed when they finish', async () => {
    const { store, handlers, reopen } = setup({ nodeId: 'root' });
    // The earlier turn's background agent finishes while expanded.
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    const next = nodes();
    next.root = chat('root', 'Root chat', next.root.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [oldDone, { ...oldBackground, outcome: 'completed' as const, result: 'Scan finished.' }] }
      : message), { status: 'streaming' });
    act(() => store.set(next));
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    const agent = subagentRows()[1];
    expect(agent.getAttribute('data-active')).toBeNull();
    // A row leads with what the agent was asked to do.
    expect(rowLabel(agent)).toBe('Scan the repo., completed: Scan finished.');
    expect(within(agent).getAllByRole('button')[0].getAttribute('aria-expanded')).toBe('true');
    expect(within(agent).getByTestId('subagent-result').textContent).toContain('Scan finished.');

    // The earlier turn's workflow run finishes while expanded.
    const workflowToggle = () => agentsToggle(screen.getByTestId('background-workflow-row'));
    fireEvent.click(workflowToggle());
    await act(async () => {});
    act(() => handlers[0].onRun(run({ status: 'completed', actions: [], result: 'All read.', revision: 2, nodes: [{ id: 'alpha', kind: 'step', title: 'alpha', status: 'completed', result: 'ALPHA' }] })));
    const workflow = screen.getByTestId('background-workflow-row');
    expect(workflow.getAttribute('data-active')).toBeNull();
    expect(within(workflow).getByTestId('workflow-result').textContent).toContain('All read.');
    // The chat card's word for it: Done, with a check.
    expect(within(workflow).getByTestId('background-workflow-status').textContent).toMatch(/^✓Done/);
    expect(workflow.getAttribute('aria-label')).toMatch(/, done$/);
    expect(workflowToggle().getAttribute('aria-expanded')).toBe('true');
    expect(within(workflow).getByTestId('background-workflow-agents')).toBeTruthy();
    // The finished agent stays too, though no longer expanded.
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-work-running').textContent).toBe('1 running');

    // Opening again applies the history rule: finished earlier-turn work is hidden.
    reopen({ nodeId: 'root' }, 2);
    expect(rowIds()).toEqual(['latest-running', 'latest-done']);
    expect(screen.queryByTestId('background-workflow-row')).toBeNull();
  });

  it('keeps finished earlier-turn work listed across a scope switch', () => {
    const { store, handlers } = setup({ nodeId: 'root' });
    // The earlier turn's background agent and workflow run finish while the drawer is open.
    const next = nodes();
    next.root = chat('root', 'Root chat', next.root.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [oldDone, { ...oldBackground, outcome: 'completed' as const, result: 'Scan finished.' }] }
      : message), { status: 'streaming' });
    act(() => store.set(next));
    act(() => handlers[0].onRun(run({ status: 'completed', actions: [], result: 'All read.', revision: 2 })));
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-workflow-row').textContent).toContain('All read.');

    chooseScope('Whole thread');
    const root = () => screen.getAllByTestId('background-work-group').find((group) => group.getAttribute('data-node-id') === 'root')!;
    expect(within(root()).getAllByTestId('background-subagent-row').map((row) => row.getAttribute('data-subagent-id')))
      .toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(within(root()).getByTestId('background-workflow-row').textContent).toContain('All read.');

    chooseScope('This conversation');
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-workflow-row').textContent).toContain('All read.');
  });

  it('shows a background agent a restart interrupted as stopped, with its error', () => {
    const { store } = setup({ nodeId: 'root' });
    const next = nodes();
    next.root = chat('root', 'Root chat', next.root.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [oldDone, { ...oldBackground, outcome: 'cancelled' as const, endedAt: 40_000, error: 'Interrupted: Michi restarted while this subagent was running\nexit code 143' }] }
      : message), { status: 'streaming' });
    act(() => store.set(next));
    const row = subagentRows().find((element) => element.getAttribute('data-subagent-id') === 'old-bg')!;
    expect(row.getAttribute('data-active')).toBeNull();
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-label')).toBe('Scan the repo., stopped: Interrupted: Michi restarted while this subagent was running');
    expect(within(row).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
    expect(toggle.textContent).not.toContain('exit code 143');
    expect(toggle.textContent).not.toContain('working');
    expect(toggle.textContent).not.toContain('in background');
    // Its recorded length, not a live clock.
    expect(toggle.textContent).toContain('39s');
    expect(screen.getByTestId('background-work-running').textContent).toBe('2 running');

    fireEvent.click(toggle);
    const detail = within(row).getByTestId('subagent-detail');
    expect(detail.textContent).toContain('Interrupted: Michi restarted while this subagent was running');
    expect(detail.textContent).not.toContain('Still running after this turn ended');
    // Its length is on the row only: the detail keeps no clock of its own.
    expect(detail.textContent).not.toContain('39s');
  });

  it('shows a background agent no live process tracks as stopped, after the running ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(601_000);
    const { handlers, reopen } = setup({ nodeId: 'root' });
    expect(rowIds()).toEqual(['old-bg', 'latest-running', 'latest-done']);
    expect(screen.getByTestId('background-work-running').textContent).toBe('3 running');
    // The feed tracks no background agent of this conversation: the
    // process that ran old-bg ended before it reported back.
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { child: ['child-agent'] } }));
    // Still listed (the drawer showed it), no longer in the running group.
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-work-running').textContent).toBe('2 running');
    const row = subagentRows()[1];
    expect(row.getAttribute('data-active')).toBeNull();
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-label')).toBe(`Scan the repo., stopped: ${SUBAGENT_UNTRACKED_ERROR}`);
    expect(within(row).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
    expect(toggle.textContent).not.toMatch(/in background|working|❯/);
    // No live clock: the 10m since it started is not shown, and nothing ticks.
    expect(toggle.textContent).not.toContain('10m');
    const text = toggle.textContent;
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(within(subagentRows()[1]).getByRole('button').textContent).toBe(text);

    fireEvent.click(toggle);
    const detail = within(subagentRows()[1]).getByTestId('subagent-detail');
    expect(detail.textContent).toContain(SUBAGENT_UNTRACKED_ERROR);
    expect(detail.textContent).not.toContain('Still running after this turn ended');

    // Opening again applies the history rule: earlier-turn work that stopped is hidden.
    reopen({ nodeId: 'root' }, 2);
    expect(rowIds()).toEqual(['latest-running', 'latest-done']);
  });

  it('writes a workflow\'s start and log times as chat does, whatever the browser\'s locale', () => {
    useZhCnDefaultLocale();
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 9, 18, 0));
      const at = new Date(2026, 10, 9, 15, 4, 7).getTime();
      const { unmount } = setup({ nodeId: 'root' }, [run({ startedAt: at, log: [{ at, text: 'Read beta.txt.', nodeId: 'beta' }] })]);
      const card = screen.getByTestId('background-workflow-row');
      expect(card.textContent).toContain('started 15:04');
      fireEvent.click(within(card).getByRole('button', { name: 'Log 1' }));
      expect(within(card).getByRole('list', { name: 'Workflow messages' }).textContent).toBe('15:04:07betaRead beta.txt.');
      unmount();
      setup({ nodeId: 'root' }, [run({ startedAt: new Date(2026, 10, 7, 15, 4).getTime() })]);
      expect(screen.getByTestId('background-workflow-row').textContent).toContain('started 11/7 15:04');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('times a background agent from its start on a live clock, not by its launch turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(601_000);
    setup({ nodeId: 'root' });
    const background = subagentRows()[0];
    // Launched at 1s; its launch turn lasted 12s.
    expect(background.textContent).toContain('10m');
    expect(background.textContent).not.toContain('12s');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(subagentRows()[0].textContent).toContain('10m 2s');
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    // One clock: the row's.
    expect(within(subagentRows()[0]).getByTestId('subagent-detail').textContent).not.toContain('10m');
  });

  it('presents a working entry the conversation no longer runs as ended', () => {
    const { store } = setup({ nodeId: 'root' });
    // The turn ended in an error before its roster was closed.
    act(() => store.set({ ...nodes(), root: { ...nodes().root, status: 'error' } }));
    const row = subagentRows().find((element) => element.getAttribute('data-subagent-id') === 'latest-running')!;
    expect(row.getAttribute('data-active')).toBeNull();
    // No now line, no clock, an ended label.
    expect(within(row).getByRole('button').textContent).toBe('Exploreended');
    fireEvent.click(within(row).getByRole('button'));
    expect(within(row).getByTestId('subagent-detail').textContent).not.toContain('now ❯');
    expect(screen.getByTestId('background-work-running').textContent).toBe('2 running');
  });

  it('a new open request resets the scope and expands its focus', () => {
    const { reopen } = setup({ nodeId: 'root' });
    chooseScope('Whole thread');
    reopen({ nodeId: 'child', focus: { kind: 'subagent', sessionId: 'child-agent' } }, 2);
    expect(scopeButton().textContent).toContain('This conversation');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(rowIds()).toEqual(['child-agent']);
    expect(within(subagentRows()[0]).getByTestId('subagent-detail')).toBeTruthy();
  });

  it('folds finished subagents behind a Finished band while others run', () => {
    setup({ nodeId: 'busy' }, []);
    expect(rowIds()).toEqual(['run-1']);
    expect(screen.getAllByTestId('background-subagent-card')).toHaveLength(1);
    expect(screen.getByTestId('background-subagent-band').getAttribute('aria-label')).toBe('Subagents, 1 running');
    const fold = screen.getByTestId('background-work-fold');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.getAttribute('aria-label')).toBe('3 finished subagents, 1 failed');
    expect(fold.textContent).toContain('Finished');
    expect(fold.textContent).toContain('3 · 1 failed');

    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(rowIds()).toEqual(['run-1', 'done-1', 'done-2', 'done-3']);
    fireEvent.click(fold);
    expect(rowIds()).toEqual(['run-1']);
  });

  it('closes the subagents band with the row it hides, and opens it again', () => {
    setup({ nodeId: 'busy', focus: { kind: 'subagent', sessionId: 'run-1' } }, []);
    const band = screen.getByTestId('background-subagent-band');
    expect(band.getAttribute('aria-expanded')).toBe('true');
    expect(within(subagentRows()[0]).getByTestId('subagent-detail')).toBeTruthy();
    fireEvent.click(band);
    expect(band.getAttribute('aria-expanded')).toBe('false');
    expect(rowIds()).toEqual([]);
    fireEvent.click(band);
    expect(rowIds()).toEqual(['run-1']);
    expect(screen.queryByTestId('subagent-detail')).toBeNull();
  });

  it('keeps an agent that finishes while open in view, and folds afresh on the next open', () => {
    const { store, reopen } = setup({ nodeId: 'busy' }, []);
    act(() => store.set({ ...nodes(), busy: busyChat({ status: 'terminated', outcome: 'completed', result: 'Ran.' }) }));
    // It finished while the user watched: still shown, not folded away.
    expect(rowIds()).toEqual(['run-1']);
    expect(rowLabel(subagentRows()[0])).toBe('Runner, completed: Ran.');
    expect(screen.getByTestId('background-work-fold').getAttribute('aria-label')).toBe('3 finished subagents, 1 failed');
    // Nothing runs on the next open: everything shows, unfolded.
    reopen({ nodeId: 'busy' }, 2);
    expect(rowIds()).toEqual(['run-1', 'done-1', 'done-2', 'done-3']);
    expect(screen.queryByTestId('background-work-fold')).toBeNull();
  });

  it('does not fold what was showing when new work starts', () => {
    const settled = busyChat({ status: 'terminated', outcome: 'completed' });
    const { store } = setup({ nodeId: 'busy' }, [], { ...nodes(), busy: settled });
    expect(rowIds()).toEqual(['run-1', 'done-1', 'done-2', 'done-3']);
    act(() => store.set({
      ...nodes(),
      busy: busyChat({ status: 'terminated', outcome: 'completed' }, [user('u2'), assistant('b2', { subagents: [subagent({ sessionId: 'fresh', agentName: 'Fresh' })] })]),
    }));
    expect(rowIds()).toEqual(['fresh', 'run-1', 'done-1', 'done-2', 'done-3']);
    expect(screen.queryByTestId('background-work-fold')).toBeNull();
  });

  it('opens the fold on a focused finished agent and keeps it open until closed', () => {
    setup({ nodeId: 'busy', focus: { kind: 'subagent', sessionId: 'done-2' } }, []);
    const fold = screen.getByTestId('background-work-fold');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(rowIds()).toEqual(['run-1', 'done-1', 'done-2', 'done-3']);
    const focused = () => subagentRows().find((row) => row.getAttribute('data-subagent-id') === 'done-2')!;
    expect(within(focused()).getByTestId('subagent-task').textContent).toBe('Try it.');

    // Collapsing the agent leaves the fold open.
    fireEvent.click(within(focused()).getByRole('button'));
    expect(screen.queryByTestId('subagent-detail')).toBeNull();
    expect(rowIds()).toEqual(['run-1', 'done-1', 'done-2', 'done-3']);

    // Closing the fold collapses the agent it hides.
    fireEvent.click(within(focused()).getByRole('button'));
    fireEvent.click(fold);
    expect(rowIds()).toEqual(['run-1']);
    fireEvent.click(fold);
    expect(screen.queryByTestId('subagent-detail')).toBeNull();
  });

  describe('finished workflows', () => {
    /** Three runs of the latest turn: wf_run running, wf_a and wf_b finished (wf_b failed). */
    const runs = (finished = ['wf_a', 'wf_b']) => [
      run({ id: 'wf_run', nativeId: 'wf_run', name: 'running', nodeId: 'busy', parentToolCallId: 'tool-run', startedAt: 10 }),
      ...finished.map((id, index) => run({ id, nativeId: id, name: id, nodeId: 'busy', parentToolCallId: `tool-${id}`, status: index === 1 ? 'failed' : 'completed', actions: [], startedAt: 20 + index })),
    ];
    const busyWithRuns = () => ({
      ...nodes(),
      busy: chat('busy', 'Busy chat', [user('u1'), assistant('b1', { toolCalls: ['tool-run', 'tool-wf_a', 'tool-wf_b'].map((id) => ({ id, title: 'Workflow', status: 'completed' as const })) })], { status: 'streaming' }),
    });
    const cardNames = () => screen.queryAllByTestId('background-workflow-row').map((card) => card.getAttribute('data-run-key'));
    const key = (id: string) => JSON.stringify(['local', id]);

    it('fold behind one line while another runs, and open and close on a click', () => {
      setup({ nodeId: 'busy' }, runs(), busyWithRuns());
      expect(cardNames()).toEqual([key('wf_run')]);
      const fold = screen.getByTestId('background-work-fold');
      expect(fold.getAttribute('aria-expanded')).toBe('false');
      expect(fold.getAttribute('aria-label')).toBe('2 finished workflows, 1 failed');
      fireEvent.click(fold);
      expect(fold.getAttribute('aria-expanded')).toBe('true');
      expect(cardNames()).toEqual([key('wf_run'), key('wf_a'), key('wf_b')]);
      fireEvent.click(fold);
      expect(cardNames()).toEqual([key('wf_run')]);
    });

    it('stay inline when only one finished', () => {
      setup({ nodeId: 'busy' }, runs(['wf_a']), busyWithRuns());
      expect(cardNames()).toEqual([key('wf_run'), key('wf_a')]);
      expect(screen.queryByTestId('background-work-fold')).toBeNull();
    });

    it('open the fold on a focused finished run and keep it open until closed, which collapses the run', () => {
      setup({ nodeId: 'busy', focus: { kind: 'workflow', runKey: key('wf_b') } }, runs(), busyWithRuns());
      const fold = screen.getByTestId('background-work-fold');
      expect(fold.getAttribute('aria-expanded')).toBe('true');
      const focused = () => screen.getAllByTestId('background-workflow-row').find((card) => card.getAttribute('data-run-key') === key('wf_b'))!;
      expect(agentsToggle(focused()).getAttribute('aria-expanded')).toBe('true');

      // Collapsing the run leaves the fold open.
      fireEvent.click(agentsToggle(focused()));
      expect(agentsToggle(focused()).getAttribute('aria-expanded')).toBe('false');
      expect(cardNames()).toEqual([key('wf_run'), key('wf_a'), key('wf_b')]);

      // Closing the fold collapses the run it hides.
      fireEvent.click(agentsToggle(focused()));
      fireEvent.click(fold);
      expect(cardNames()).toEqual([key('wf_run')]);
      fireEvent.click(fold);
      expect(agentsToggle(focused()).getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('says so when nothing runs', () => {
    setup({ nodeId: 'idle' }, []);
    expect(screen.getByText('Nothing is running in this conversation.')).toBeTruthy();
    expect(screen.queryByTestId('background-work-running')).toBeNull();
  });

  describe('a multi-model run', () => {
    const runKey = JSON.stringify(['local', 'wfr_1']);
    const branch = (key: string, status: 'waiting' | 'running'): MultiModelRunView['threads'][number] => ({
      key, runtimeId: 'codex', providerId: null, modelId: null, reasoning: null, runtimeLabel: `Codex ${key}`, modelLabel: 'GPT-6.1 Sol',
      context: 'fresh', promptPreview: 'Weigh it.', childNodeId: 'child', steps: [{ kind: 'answer', round: 0, status, startedAt: 50 }],
    });
    function planRun(patch: Partial<MultiModelRunView> = {}): WorkflowRunDtoV1 {
      return run({
        runtime: 'michi', parentToolCallId: null, name: 'Extraction timing', nodes: [], actions: [],
        approvals: [{ id: 'appr_1', nodeId: 't1@0', title: 'Approve Bash?', detail: 'rg -n x', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }], requestedAt: 60 }],
        multiModel: {
          version: 1, phase: 'running', title: 'Extraction timing', askPreview: 'Per turn or idle?', callerNodeId: 'root', callerMessageId: 'a1',
          callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus 5.5', permissionMode: 'ask', reviewRounds: 0,
          threads: [branch('t1', 'waiting'), branch('t2', 'running')], synthesis: { status: 'pending' }, startedAt: 50,
          ...patch,
        },
      });
    }

    it('is a multi-model card, opened on the row the card was clicked at, whose pane actions close the drawer', () => {
      project.actions = { revealNode: vi.fn(() => true), openPanesSideBySide: vi.fn() };
      const { onClose } = setup({ nodeId: 'root', focus: { kind: 'workflow', runKey, threadKey: 't2', step: 0 } }, [planRun()]);
      const card = screen.getByTestId('background-workflow-row');
      expect(card.textContent).toContain('Multi-model · 2 branches');
      expect(card.getAttribute('data-background-work-key')).toBe(JSON.stringify(['root', 'workflow', runKey]));
      expect(screen.getByTestId('background-work-waiting').textContent).toBe('1 needs you');
      const rows = within(card).getAllByTestId('multi-model-row');
      expect(rows.map((entry) => entry.querySelector('button')?.getAttribute('aria-expanded'))).toEqual(['false', 'true']);

      fireEvent.click(within(rows[1]).getByRole('button', { name: 'Open branch →' }));
      expect(project.actions.revealNode).toHaveBeenCalledWith('child', { messageId: undefined });
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(within(card).getByRole('button', { name: 'Side by side' }));
      expect(project.actions.openPanesSideBySide).toHaveBeenCalledWith('root', ['child', 'child']);
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('closes the Replace model picker on Escape without closing the drawer', async () => {
      const failed = planRun();
      failed.multiModel!.threads[1] = { ...failed.multiModel!.threads[1], steps: [{ kind: 'answer', round: 0, status: 'failed', startedAt: 50, endedAt: 90, error: 'Boom' }] };
      const { onClose } = setup({ nodeId: 'root', focus: { kind: 'workflow', runKey } }, [failed]);
      await act(async () => { fireEvent.click(within(screen.getByTestId('multi-model-failed')).getByRole('button', { name: 'Replace model' })); });
      const name = 'Replace Codex t2 · GPT-6.1 Sol · ready models only';
      expect(screen.getByRole('dialog', { name })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('opens the row a new open request names while the card stays mounted', () => {
      const { reopen } = setup({ nodeId: 'root', focus: { kind: 'workflow', runKey, threadKey: 't2', step: 0 } }, [planRun()]);
      const expandedRows = () => within(screen.getByTestId('background-workflow-row')).getAllByTestId('multi-model-row')
        .map((entry) => entry.querySelector('button')?.getAttribute('aria-expanded'));
      expect(expandedRows()).toEqual(['false', 'true']);
      reopen({ nodeId: 'root', focus: { kind: 'workflow', runKey, threadKey: 't1', step: 0 } }, 2);
      expect(expandedRows()).toEqual(['true', 'false']);
    });

    // Where the in-chat card is read-only, its drawer card is too: navigation and approvals, no plan or run controls.
    function expectReadOnly() {
      const card = screen.getByTestId('background-workflow-row');
      for (const name of ['Stop', 'Stop all', 'Retry', 'Replace model']) {
        expect(within(card).queryByRole('button', { name }), name).toBeNull();
      }
      expect(within(card).getByRole('button', { name: 'Allow once' })).toBeTruthy();
      expect(within(card).getByRole('button', { name: 'Open branch →' })).toBeTruthy();
      expect(within(card).getByRole('button', { name: 'Side by side' })).toBeTruthy();
    }

    it('is read-only for a Scheduled-only thread', () => {
      project.actions = { selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn(), openPanesSideBySide: vi.fn() };
      const scheduled = nodes();
      scheduled.root = { ...scheduled.root, scheduledOnlyJobId: 'job-1' };
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey, threadKey: 't2', step: 0 } }, [planRun()], scheduled);
      expectReadOnly();
    });

    it('is read-only for an archived thread', () => {
      project.actions = { selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn(), openPanesSideBySide: vi.fn() };
      Object.assign(project.current.trees[0], { archivedAt: 1 });
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey, threadKey: 't2', step: 0 } }, [planRun()]);
      expectReadOnly();
    });

    it('keeps the controls of a thread that is not read-only', () => {
      project.actions = { selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn(), openPanesSideBySide: vi.fn() };
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey, threadKey: 't2', step: 0 } }, [planRun()]);
      const card = screen.getByTestId('background-workflow-row');
      for (const name of ['Allow once', 'Stop', 'Stop all']) expect(within(card).getByRole('button', { name }), name).toBeTruthy();
    });

    it('does not list a plan waiting for Start', () => {
      setup({ nodeId: 'idle' }, [{ ...planRun({ phase: 'proposed', startedAt: undefined }), nodeId: 'idle', status: 'paused', approvals: [] }]);
      expect(screen.getByText('Nothing is running in this conversation.')).toBeTruthy();
    });
  });

  describe('a workflow card', () => {
    const MODEL = 'global.anthropic.claude-opus-5-5';
    const runKey = JSON.stringify(['local', 'wfr_1']);
    type Node = WorkflowRunDtoV1['nodes'][number];
    const agent = (id: string, title: string, phase: string, patch: Partial<Node> & Pick<Node, 'status'>): Node => ({ id, parentId: phase, kind: 'agent', title, model: MODEL, startedAt: 50, ...patch });
    function claudeRun(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
      return run({
        runtime: 'claude', name: 'claude-runtime-ultracode-feasibility', description: 'Investigate session-level Ultracode, then verify each slice',
        actions: ['stop'], usage: { totalTokens: 796_000, toolUses: 254 },
        nodes: [
          { id: 'phase:0', kind: 'phase', title: 'Investigate', status: 'running' },
          agent('agent:0', 'investigate:sdk-cli', 'phase:0', { status: 'running', currentTool: 'Bash cd /tmp && ls', prompt: 'Map the SDK.', usage: { totalTokens: 107_000 }, toolCount: 36 }),
          agent('agent:1', 'investigate:risks', 'phase:0', { status: 'failed', error: '429 rate_limit_error\nexit code 1', endedAt: 2_050 }),
          agent('agent:2', 'investigate:adapter', 'phase:0', { status: 'completed', result: 'One injection point.', endedAt: 3_050 }),
          { id: 'phase:1', kind: 'phase', title: 'Verify', status: 'queued' },
        ],
        ...patch,
      });
    }
    const card = () => screen.getByTestId('background-workflow-row');
    const leaf = (id: string) => within(card()).getAllByTestId('workflow-node').find((node) => node.getAttribute('data-node-id') === id)!;

    it('says what the run is, where it is and who works on it, the shared model once', () => {
      vi.useFakeTimers();
      vi.setSystemTime(601_000);
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey } }, [claudeRun()]);
      expect(within(card()).getByTestId('background-workflow-title').textContent).toBe('Claude runtime ultracode feasibility');
      expect(within(card()).getByTestId('background-workflow-title').getAttribute('title')).toBe('claude-runtime-ultracode-feasibility');
      expect(card().textContent).toContain('Investigate session-level Ultracode, then verify each slice');
      expect(within(card()).getAllByTestId('background-workflow-phase').map((phase) => [phase.textContent, phase.getAttribute('data-phase-state')]))
        .toEqual([['1Investigate1/3 · 10m 1s▾', 'running'], ['2Verifyqueued', 'queued']]);
      // A failure while the run goes on is said on the card, not only on its line.
      expect(card().textContent).toContain('× 1 agent failed');
      expect(card().textContent).toContain('risks · 429 rate_limit_error');
      expect(within(card()).getByRole('button', { name: 'Stop workflow claude-runtime-ultracode-feasibility' })).toBeTruthy();
      // Agents by phase, named without the phase they sit under.
      expect(within(card()).getAllByTestId('workflow-node').map((node) => node.querySelector('button')!.getAttribute('aria-label'))).toEqual([
        'sdk-cli, running: Bash cd /tmp && ls',
        'risks, failed: 429 rate_limit_error',
        'adapter, done: One injection point.',
      ]);
      // Every row's figure is its time, live while it runs; its tokens are in its detail.
      expect(leaf('agent:0').textContent).toContain('10m 1s');
      expect(leaf('agent:0').textContent).not.toContain('107k');
      // A failed agent opens on its error; the phase to come, with no agents yet, is its header alone.
      expect(within(leaf('agent:1')).getByTestId('workflow-node-detail').textContent).toContain('exit code 1');
      expect(within(card()).queryByRole('button', { name: /^Verify\b/ })).toBeNull();
      // Every agent runs one model: the footer says it, once.
      expect(card().textContent!.split('Opus 5.5')).toHaveLength(2);
      expect(card().textContent).not.toContain(MODEL);
      expect(card().textContent).toContain('796k tokens · 254 tools');
    });

    it('opens an agent in place, and folds a finished phase to its band, failures included', () => {
      const finished = claudeRun();
      finished.nodes = [
        { id: 'phase:0', kind: 'phase', title: 'Investigate', status: 'failed' },
        agent('agent:0', 'investigate:sdk-cli', 'phase:0', { status: 'completed', result: 'Settings work.', endedAt: 4_050 }),
        agent('agent:1', 'investigate:risks', 'phase:0', { status: 'failed', error: 'Boom.', endedAt: 2_050 }),
        { id: 'phase:1', kind: 'phase', title: 'Verify', status: 'running' },
        agent('agent:3', 'verify:sdk-cli', 'phase:1', { status: 'running', currentTool: 'Read probe.log', prompt: 'Verify the SDK claim.', startedAt: 4_050 }),
      ];
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey } }, [finished]);
      const fold = within(card()).getByRole('button', { name: 'Investigate, 1 failed · 4.0s' });
      expect(fold.getAttribute('aria-expanded')).toBe('false');
      expect(within(card()).getAllByTestId('workflow-node').map((node) => node.getAttribute('data-node-id'))).toEqual(['agent:3']);
      fireEvent.click(fold);
      expect(within(card()).getAllByTestId('workflow-node').map((node) => node.getAttribute('data-node-id'))).toEqual(['agent:0', 'agent:1', 'agent:3']);

      const verifier = within(leaf('agent:3')).getByRole('button');
      expect(verifier.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(verifier);
      const detail = within(leaf('agent:3')).getByTestId('workflow-node-detail');
      expect(detail.textContent).toContain('Verify the SDK claim.');
      expect(detail.textContent).toContain('Read probe.log');
    });

    it('keeps a JSON result off its row and shows it indented in the detail, cut short as Claude previews it', () => {
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey } }, [claudeRun({
        nodes: [
          { id: 'phase:0', kind: 'phase', title: 'Integrate', status: 'running' },
          agent('agent:0', 'integrate:backend', 'phase:0', { status: 'running', currentTool: 'Read a.ts' }),
          agent('agent:1', 'integrate:frontend', 'phase:0', { status: 'completed', result: '{"area":"frontend","changed":[{"path":"a.ts","why":"Item {1}, in …', endedAt: 2_050 }),
        ],
      })]);
      const row = within(leaf('agent:1')).getByRole('button');
      expect(row.getAttribute('aria-label')).toBe('frontend, done');
      expect(leaf('agent:1').textContent).not.toContain('{');
      fireEvent.click(row);
      expect(within(leaf('agent:1')).getByTestId('workflow-node-detail').querySelector('pre')?.textContent)
        .toBe('{\n  "area": "frontend",\n  "changed": [\n    {\n      "path": "a.ts",\n      "why": "Item {1}, in …');
    });

    it("gives a phase's one agent, named as the phase, its line alone", () => {
      setup({ nodeId: 'root', focus: { kind: 'workflow', runKey } }, [claudeRun({
        nodes: [
          { id: 'phase:0', kind: 'phase', title: 'Synthesize', status: 'running' },
          agent('agent:0', 'synthesize', 'phase:0', { status: 'running', currentTool: 'Bash sed -n 1p a.md' }),
        ],
      })]);
      expect(within(leaf('agent:0')).getByRole('button').getAttribute('aria-label')).toBe('synthesize, running: Bash sed -n 1p a.md');
      // The band says its name and time.
      expect(leaf('agent:0').textContent).toBe('Bash sed -n 1p a.md');
    });

    it('opens a closed card on the phase whose header was clicked, and closes it with its last open phase', () => {
      setup({ nodeId: 'root' }, [claudeRun({
        nodes: [
          { id: 'phase:0', kind: 'phase', title: 'Investigate', status: 'completed' },
          agent('agent:0', 'investigate:sdk-cli', 'phase:0', { status: 'completed', result: 'Settings work.', endedAt: 4_050 }),
          { id: 'phase:1', kind: 'phase', title: 'Verify', status: 'running' },
          agent('agent:3', 'verify:sdk-cli', 'phase:1', { status: 'running', currentTool: 'Read probe.log', startedAt: 4_050 }),
        ],
      })]);
      const investigate = () => within(card()).getByRole('button', { name: 'Investigate, done · 4.0s' });
      const verify = () => within(card()).getByRole('button', { name: /^Verify, 0\/1/ });
      expect([investigate(), verify()].map((phase) => phase.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
      expect(within(card()).queryAllByTestId('workflow-node')).toHaveLength(0);
      fireEvent.click(investigate());
      expect([investigate(), verify()].map((phase) => phase.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
      expect(within(card()).getAllByTestId('workflow-node').map((node) => node.getAttribute('data-node-id'))).toEqual(['agent:0']);
      fireEvent.click(verify());
      expect(within(card()).getAllByTestId('workflow-node').map((node) => node.getAttribute('data-node-id'))).toEqual(['agent:0', 'agent:3']);
      fireEvent.click(investigate());
      fireEvent.click(verify());
      expect([investigate(), verify()].map((phase) => phase.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
      expect(within(card()).queryAllByTestId('workflow-node')).toHaveLength(0);
    });

    it('opens the phase an agent failed in from the failure line', () => {
      const failing = claudeRun();
      failing.nodes = [
        { id: 'phase:0', kind: 'phase', title: 'Investigate', status: 'failed' },
        agent('agent:0', 'investigate:sdk-cli', 'phase:0', { status: 'completed', result: 'Settings work.', endedAt: 4_050 }),
        agent('agent:1', 'investigate:risks', 'phase:0', { status: 'failed', error: 'Boom.', endedAt: 2_050 }),
        { id: 'phase:1', kind: 'phase', title: 'Verify', status: 'running' },
        agent('agent:3', 'verify:sdk-cli', 'phase:1', { status: 'running', currentTool: 'Read probe.log', startedAt: 4_050 }),
      ];
      setup({ nodeId: 'root' }, [failing]);
      expect(within(card()).queryAllByTestId('workflow-node')).toHaveLength(0);
      fireEvent.click(within(card()).getByRole('button', { name: 'View' }));
      expect(within(card()).getByRole('button', { name: 'Investigate, 1 failed · 4.0s' }).getAttribute('aria-expanded')).toBe('true');
      expect(within(leaf('agent:1')).getByTestId('workflow-node-detail').textContent).toContain('Boom.');
    });

    it('leads a finished run with its result and keeps its inputs and log behind the footer', () => {
      // Launched by the latest reply, so it stays listed once finished.
      const latest = nodes();
      latest.root = chat('root', 'Root chat', latest.root.messages.map((message) => (message.id === 'a2'
        ? { ...message, toolCalls: [{ id: 'tool-wf2', title: 'Workflow', status: 'completed' }] }
        : message)), { status: 'streaming' });
      const { api } = setup({ nodeId: 'root' }, [run({
        parentToolCallId: 'tool-wf2', status: 'completed', actions: [], result: '**All read.**', definition: '{"files":["alpha","beta"]}', endedAt: 950,
        nodes: [{ id: 'alpha', kind: 'step', title: 'alpha', status: 'completed', result: 'ALPHA' }],
        log: [{ at: 60, text: 'alpha done', nodeId: 'alpha' }],
      })], latest);
      expect(within(card()).getByTestId('workflow-result').textContent).toContain('All read.');
      // Inline code takes the palette's foreground, not the typography plugin's near-black.
      expect(within(card()).getByTestId('workflow-result').querySelector<HTMLElement>('.prose')?.style.getPropertyValue('--tw-prose-code')).toBe('var(--term-fg)');
      expect(agentsToggle(card()).textContent).toContain('1 finished');
      expect(api.get).not.toHaveBeenCalled();
      fireEvent.click(within(card()).getByRole('button', { name: 'Inputs' }));
      expect(within(card()).getByTestId('workflow-definition').textContent).toBe('{"files":["alpha","beta"]}');
      // The bulk snapshot may trim them: the full run is fetched.
      expect(api.get).toHaveBeenCalledWith('local', 'wfr_1');
      fireEvent.click(within(card()).getByRole('button', { name: 'Log 1' }));
      expect(within(card()).queryByTestId('workflow-definition')).toBeNull();
      expect(within(card()).getByRole('list', { name: 'Workflow messages' }).textContent).toContain('alpha done');
    });

    it('closes the scope menu on Escape without closing the drawer', () => {
      const { onClose } = setup({ nodeId: 'root' });
      fireEvent.click(scopeButton());
      expect(screen.getByRole('menuitemradio', { name: 'This conversation' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('menuitemradio', { name: 'Whole thread' }).getAttribute('aria-checked')).toBe('false');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('on a phone', () => {
    const desktopWidth = window.innerWidth;
    beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); });
    afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth }); });

    it('gives each subagent row two lines: name and time, then what it does', () => {
      setup({ nodeId: 'root' });

      const running = subagentRows().find((row) => row.getAttribute('data-subagent-id') === 'latest-running')!;
      expect(running.getAttribute('data-stacked')).toBe('true');
      const [head, sub] = Array.from(running.querySelectorAll('[data-row-line]'));
      expect(head.textContent).toContain('Explore');
      expect(sub.textContent).toContain('Read src/auth.ts');

      // A workflow is the same card, full width.
      const workflow = screen.getByTestId('background-workflow-row');
      expect(within(workflow).getByTestId('background-workflow-title').textContent).toBe('Probe');
      expect(workflow.textContent).toContain('1/2 steps');

      // Still one button per item, expanding in place.
      fireEvent.click(within(running).getByRole('button', { expanded: false }));
      expect(within(running).getByTestId('subagent-detail')).toBeTruthy();
    });
  });
});
