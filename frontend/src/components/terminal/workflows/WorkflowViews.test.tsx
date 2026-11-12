import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { MultiModelRunView, WorkflowRunDtoV1 } from 'michi-shared';
import { MessageWorkflowRuns } from './MessageWorkflowRuns';
import { WorkflowRunCard } from './WorkflowRunCard';
import { WorkflowRunDetail, WorkflowRunPane } from './WorkflowRunPane';
import { RUN_NOUN, runNounTitle, workflowNodeRows, workflowNow } from './workflowPresentation';
import {
  WorkflowDomainProvider,
  initialWorkflowDomainState,
  selectLiveBackgroundSubagents,
  useBackgroundSubagentLiveness,
  useActiveWorkflowCounts,
  useOpenWorkflowNodeIds,
  useOptionalWorkflowDomain,
  useRefetchPartialWorkflowRun,
  useRunningClaudeWorkflow,
  useWaitingWorkflowNodeIds,
  useWorkflowRun,
  useWorkflowPlacementsForNode,
  useWorkflowRunDetail,
  useWorkflowRunsForNodes,
  workflowDomainReducer,
  workflowFeedKey,
  workflowRunKey,
  type NodeBackgroundSubagentLiveness,
  type WorkflowDomainAction,
  type WorkflowDomainApi,
} from '../../../state/workflowDomain';
import { isPaneItem, workflowRunPaneId } from '../../../state/paneItems';

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1,
    id: 'wfr_1',
    runtime: 'kiro',
    nativeId: 'wf_9defadbd8f7c427d',
    workspaceId: 'ws',
    nodeId: 'node-1',
    parentToolCallId: 'toolu_1',
    name: 'readonly-observability-probe',
    status: 'running',
    nodes: [
      { id: 'read-both', kind: 'parallel', title: 'read-both', status: 'running' },
      { id: 'read-alpha', parentId: 'read-both', kind: 'step', title: 'read-alpha', status: 'running', agentName: 'wf-planner', currentTool: 'Read File', toolCount: 1 },
      { id: 'read-beta', parentId: 'read-both', kind: 'step', title: 'read-beta', status: 'completed', result: '**BETA_MARKER**=B', prompt: 'Read beta.txt' },
      { id: 'combine', kind: 'step', title: 'combine', status: 'queued' },
    ],
    log: [{ at: 1_000, text: 'Read beta.txt successfully.', nodeId: 'read-beta', severity: 'success' }],
    actions: ['pause', 'stop'],
    startedAt: 1_000,
    updatedAt: 2_000,
    revision: 4,
    ...patch,
  };
}

describe('workflow presentation', () => {
  it('orders nodes as a tree and names what runs now', () => {
    expect(workflowNodeRows(run().nodes).map(({ node, depth }) => [node.id, depth])).toEqual([
      ['read-both', 0], ['read-alpha', 1], ['read-beta', 1], ['combine', 0],
    ]);
    expect(workflowNow(run())).toEqual({ step: 'read-alpha', detail: 'Read File' });
    expect(workflowNow(run({ status: 'paused', statusDetail: 'Waiting for approval' }))).toEqual({ detail: 'Waiting for approval' });
    expect(workflowNow(run({ status: 'completed' }))).toBeUndefined();
  });
});

describe('WorkflowRunCard', () => {
  it('shows status, progress and what runs now, without run controls', () => {
    const onOpen = vi.fn();
    const { getByTestId, getByRole, queryByRole } = render(<WorkflowRunCard run={run()} onOpen={onOpen} />);
    const card = getByTestId('workflow-run-card');
    expect(card.textContent).toContain('readonly-observability-probe');
    expect(card.textContent).toContain('Running');
    expect(card.textContent).toContain('Kiro CLI');
    expect(card.textContent).toContain('1/3 steps');
    expect(getByTestId('workflow-now').textContent).toBe('❯read-alphaRead File');
    expect(queryByRole('button', { name: /^(Stop|Pause) workflow/ })).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Open workflow readonly-observability-probe' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the run from anywhere on the card except its controls and approvals', () => {
    const onOpen = vi.fn();
    const onAnswer = vi.fn();
    const pending = run({
      approvals: [{
        id: 'kiro-s-1', nodeId: 'read-alpha', title: 'Approve Write File?', detail: '{"path":"out.txt"}', requestedAt: 1,
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      }],
    });
    const { getByTestId, getByRole } = render(<WorkflowRunCard run={pending} onOpen={onOpen} onAnswer={onAnswer} />);
    expect(getByTestId('workflow-run-card').getAttribute('aria-label')).toBe('Workflow readonly-observability-probe, needs approval');
    expect(getByTestId('workflow-run-card').textContent).toContain('Needs you');
    fireEvent.click(getByRole('button', { name: 'Allow once' }));
    fireEvent.click(getByRole('group', { name: 'Approval needed: Approve Write File?' }));
    expect(onAnswer).toHaveBeenCalledWith('kiro-s-1', 'allow');
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('workflow-now'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open the run when a click ends a text selection inside the card', () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<WorkflowRunCard run={run()} onOpen={onOpen} />);
    const now = getByTestId('workflow-now');
    window.getSelection()!.selectAllChildren(now);
    try {
      fireEvent.click(now);
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      window.getSelection()!.removeAllRanges();
    }
    fireEvent.click(now);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

});

describe('MessageWorkflowRuns', () => {
  function renderMessage() {
    const onOpen = vi.fn();
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    function Message() {
      domain = useOptionalWorkflowDomain();
      const placements = useWorkflowPlacementsForNode('node-1');
      return placements.length > 0 ? <MessageWorkflowRuns runs={placements} onOpen={onOpen} /> : null;
    }
    const view = render(<WorkflowDomainProvider api={api}><Message /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    const feed = (patch: Partial<WorkflowRunDtoV1>) => act(() => handlers[0].onRun(run(patch)));
    return { ...view, feed, onOpen };
  }
  const ended = (status: 'completed' | 'failed' | 'cancelled') => ({ status, actions: [], endedAt: 61_000, revision: 9 });

  it('folds finished runs into one line of counts once two have finished, above the live cards', async () => {
    const { feed, getByRole, getAllByTestId, queryAllByTestId } = renderMessage();
    feed({ id: 'wfr_a', name: 'alpha', startedAt: 1_000, ...ended('completed') });
    feed({ id: 'wfr_b', name: 'beta', startedAt: 2_000 });
    feed({ id: 'wfr_c', name: 'gamma', startedAt: 3_000 });
    // One finished run keeps its card.
    expect(getAllByTestId('workflow-run-card')).toHaveLength(3);

    feed({ id: 'wfr_b', name: 'beta', startedAt: 2_000, ...ended('completed') });
    await waitFor(() => expect(getAllByTestId('workflow-run-card')).toHaveLength(1));
    expect(getAllByTestId('workflow-run-card')[0].textContent).toContain('gamma');
    const fold = getByRole('button', { name: 'Workflows: 2 done' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.compareDocumentPosition(getAllByTestId('workflow-run-card')[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    feed({ id: 'wfr_c', name: 'gamma', startedAt: 3_000, ...ended('failed'), statusDetail: 'Agent crashed' });
    await waitFor(() => expect(queryAllByTestId('workflow-run-card')).toHaveLength(0));
    expect(getByRole('button', { name: 'Workflows: 2 done, 1 failed' })).toBeTruthy();
  });

  it('lists the folded runs one line each, and a line opens its run', () => {
    const { feed, getByRole, onOpen } = renderMessage();
    feed({ id: 'wfr_a', name: 'alpha', startedAt: 1_000, ...ended('completed') });
    feed({ id: 'wfr_b', name: 'beta', startedAt: 2_000, ...ended('cancelled') });
    const fold = getByRole('button', { name: 'Workflows: 1 done, 1 stopped' });
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const lines = within(getByRole('list')).getAllByRole('button');
    expect(lines.map((line) => line.getAttribute('aria-label'))).toEqual(['Open workflow alpha, completed', 'Open workflow beta, stopped']);
    expect(lines[0].textContent).toBe('alphaDone1m›');
    fireEvent.click(lines[1]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'wfr_b' }), 'beta');
  });
});

describe('WorkflowActions', () => {
  it('marks the action in flight and hides controls the run no longer accepts', () => {
    const { getByRole, rerender, queryByRole } = render(<WorkflowRunDetail run={run()} now={5_000} controls pending="pause" onAction={() => {}} />);
    expect((getByRole('button', { name: /Pause workflow/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByRole('button', { name: /Pause workflow/ }).textContent).toBe('Pause…');
    rerender(<WorkflowRunDetail run={run({ status: 'completed', actions: [] })} now={5_000} controls onAction={() => {}} />);
    expect(queryByRole('button', { name: /Stop workflow/ })).toBeNull();
  });
});

describe('workflow approvals', () => {
  it('lists pending approvals with their step and answers them', () => {
    const onAnswer = vi.fn();
    const pending = run({
      approvals: [{
        id: 'kiro-s-1', nodeId: 'read-alpha', title: 'Approve Write File?', detail: '{"path":"out.txt"}', requestedAt: 1,
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      }],
    });
    const { getByRole, rerender, queryByTestId } = render(<WorkflowRunCard run={pending} onAnswer={onAnswer} />);
    const group = getByRole('group', { name: 'Approval needed: Approve Write File?' });
    expect(group.textContent).toContain('read-alpha');
    expect(group.textContent).toContain('out.txt');
    fireEvent.click(within(group).getByRole('button', { name: 'Allow once' }));
    expect(onAnswer).toHaveBeenCalledWith('kiro-s-1', 'allow');
    rerender(<WorkflowRunCard run={pending} pending="answer" onAnswer={onAnswer} />);
    expect((within(getByRole('group')).getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<WorkflowRunCard run={run()} onAnswer={onAnswer} />);
    expect(queryByTestId('workflow-approvals')).toBeNull();
  });

  it('shows a request it cannot answer without its buttons, as Background work does', () => {
    const pending = run({
      approvals: [{
        id: 'kiro-s-1', title: 'Approve Write File?', detail: '{"path":"out.txt"}', requestedAt: 1, scope: 'session',
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      }],
    });
    const { getByRole, queryByRole } = render(<WorkflowRunCard run={pending} />);
    const group = getByRole('group', { name: 'Approval needed: Approve Write File?' });
    expect(group.textContent).toContain('out.txt');
    expect(within(group).getByText('from this chat').getAttribute('title')).toMatch(/^The runtime does not say which agent asked/);
    expect(queryByRole('button', { name: 'Allow once' })).toBeNull();
  });
});

describe('WorkflowRunPane', () => {
  it('writes its start and log times as chat does', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 9, 18, 0));
      const at = new Date(2026, 10, 9, 15, 4, 7).getTime();
      const { getByRole, getByText } = render(<WorkflowRunPane run={run({ startedAt: new Date(2026, 10, 7, 15, 4).getTime(), log: [{ at, text: 'Read beta.txt.' }] })} onClose={() => {}} />);
      expect(getByRole('list', { name: 'Workflow messages' }).textContent).toBe('15:04:07Read beta.txt.');
      expect(getByText(/^started /).textContent).toBe('started 11/7 15:04');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the node tree with task, now and result, the step log and the report', () => {
    const { getAllByTestId, getByText, getByTestId } = render(
      <WorkflowRunPane run={run({ result: 'ALPHA | BETA', definition: '{"alpha_path":"a"}' })} onClose={() => {}} onAction={() => {}} />,
    );
    const nodes = getAllByTestId('workflow-node');
    expect(nodes.map((node) => [node.getAttribute('data-node-id'), node.getAttribute('data-node-status')])).toEqual([
      ['read-both', 'running'], ['read-alpha', 'running'], ['read-beta', 'completed'], ['combine', 'queued'],
    ]);
    expect(nodes[1].textContent).toContain('now ❯ Read File');
    fireEvent.click(within(nodes[2]).getByRole('button', { name: 'Show read-beta details' }));
    const detail = within(nodes[2]).getByTestId('workflow-node-detail');
    expect(detail.textContent).toContain('Read beta.txt');
    expect(detail.querySelector('strong')?.textContent).toBe('BETA_MARKER');
    expect(getByText('Read beta.txt successfully.')).toBeTruthy();
    expect(getByTestId('workflow-result').textContent).toContain('ALPHA | BETA');
    fireEvent.click(getByText('show'));
    expect(getByTestId('workflow-definition').textContent).toContain('alpha_path');
  });

  it('names a node\'s model as the composer does', () => {
    const claude = run({ runtime: 'claude', nodes: [{ id: 'a', kind: 'agent', title: 'review', status: 'running', model: 'global.anthropic.claude-opus-5-5' }] });
    const { getByTestId } = render(<WorkflowRunPane run={claude} onClose={() => {}} onAction={() => {}} />);
    expect(getByTestId('workflow-node').textContent).toContain('Opus 5.5');
    expect(getByTestId('workflow-node').textContent).not.toContain('anthropic');
  });

  it('opens a failed node\'s error by default', () => {
    const failed = run({ status: 'failed', actions: ['retry'], statusDetail: 'Step combine failed', nodes: [{ id: 'combine', kind: 'step', title: 'combine', status: 'failed', error: 'boom' }] });
    const { getByTestId, getByText } = render(<WorkflowRunPane run={failed} onClose={() => {}} onAction={() => {}} />);
    expect(getByTestId('workflow-node-detail').textContent).toContain('boom');
    expect(getByText('Step combine failed')).toBeTruthy();
    expect(getByText('Retry')).toBeTruthy();
  });
});

describe('WorkflowRunDetail', () => {
  it('puts status, runtime and controls first when shown outside the pane', () => {
    const onAction = vi.fn();
    const { getByTestId, getByRole, queryByRole, rerender } = render(<WorkflowRunDetail run={run()} now={5_000} controls onAction={onAction} />);
    const detail = getByTestId('workflow-run-detail');
    expect(detail.textContent).toContain('running · 4s');
    expect(detail.textContent).toContain('Kiro CLI');
    fireEvent.click(getByRole('button', { name: 'Pause workflow readonly-observability-probe' }));
    expect(onAction).toHaveBeenCalledWith('pause');
    rerender(<WorkflowRunDetail run={run()} now={5_000} onAction={onAction} />);
    expect(queryByRole('button', { name: /Pause workflow/ })).toBeNull();
  });
});

describe('workflow domain', () => {
  it('keeps the highest revision whatever order snapshots arrive in', () => {
    const newer = { backendConnectionId: 'local', value: run({ revision: 5, name: 'new' }) };
    const older = { backendConnectionId: 'local', value: run({ revision: 3, name: 'old' }) };
    let state = workflowDomainReducer(initialWorkflowDomainState, { type: 'upsert', resources: [newer] });
    const afterNewer = state;
    state = workflowDomainReducer(state, { type: 'upsert', resources: [older] });
    expect(state).toBe(afterNewer);
    expect(Object.values(state.runs)[0].value.name).toBe('new');
  });

  it('lets a full copy replace a trimmed snapshot copy of the same revision, never the reverse', () => {
    const trimmed = { backendConnectionId: 'local', value: run({ revision: 5, partial: true, nodes: [] }) };
    const full = { backendConnectionId: 'local', value: run({ revision: 5 }) };
    let state = workflowDomainReducer(initialWorkflowDomainState, { type: 'upsert', resources: [trimmed] });
    state = workflowDomainReducer(state, { type: 'upsert', resources: [full] });
    expect(Object.values(state.runs)[0].value.partial).toBeUndefined();
    const afterFull = state;
    state = workflowDomainReducer(state, { type: 'upsert', resources: [trimmed] });
    expect(state).toBe(afterFull);
  });

  it('shares one subscription per workspace and reconnects after a disconnect', async () => {
    vi.useFakeTimers();
    try {
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const unsubscribe = vi.fn();
      const api: WorkflowDomainApi = {
        get: vi.fn(),
        act: vi.fn(),
        answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return unsubscribe; }),
      };
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
      let releaseA!: () => void;
      let releaseB!: () => void;
      act(() => { releaseA = domain!.subscribeWorkspace('ws'); releaseB = domain!.subscribeWorkspace('ws'); });
      expect(api.subscribe).toHaveBeenCalledTimes(1);
      // Finished: an open run would hold the feed itself (see below).
      act(() => handlers[0].onRun(run({ status: 'completed', actions: [] })));
      expect(Object.keys(domain!.store.getState().runs)).toHaveLength(1);
      act(() => handlers[0].onDisconnect?.(new Error('gone')));
      await act(async () => { vi.advanceTimersByTime(1_250); });
      expect(api.subscribe).toHaveBeenCalledTimes(2);
      act(() => releaseA());
      expect(unsubscribe).not.toHaveBeenCalled();
      act(() => releaseB());
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a workspace feed live while one of its runs is open, after the last view of it leaves', async () => {
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const unsubscribe = vi.fn();
    const api: WorkflowDomainApi = {
      act: vi.fn(), answer: vi.fn(),
      get: vi.fn(async () => run({ id: 'wfr_2', workspaceId: 'ws-2', nodeId: 'node-2', revision: 1 })),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return unsubscribe; }),
    };
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    function Probe() { domain = useOptionalWorkflowDomain(); return null; }
    const { unmount } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    let release!: () => void;
    act(() => { release = domain!.subscribeWorkspace('ws'); });
    await act(async () => { handlers[0].onRun(run()); });
    // Another workspace becomes active: the open run keeps this feed.
    act(() => release());
    expect(unsubscribe).not.toHaveBeenCalled();
    // It ends on that feed, and nothing holds the feed any more.
    await act(async () => { handlers[0].onRun(run({ revision: 5, status: 'completed', actions: [] })); });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledTimes(1);

    // An open run known only from a fetch (a workflow pane) is kept live too.
    await act(async () => { await domain!.load({ backendConnectionId: 'local', id: 'wfr_2' }); });
    expect(api.subscribe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.subscribe).mock.calls[1][0]).toBe('ws-2');
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('lists the chat nodes with an open run, as a new set only when one starts or ends', () => {
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    let renders = 0;
    function Probe() {
      renders += 1;
      domain = useOptionalWorkflowDomain();
      const ids = useOpenWorkflowNodeIds();
      return <span data-testid="open">{[...ids].sort().join(',') || 'none'}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    expect(getByTestId('open').textContent).toBe('none');
    act(() => handlers[0].onRun(run()));
    act(() => handlers[0].onRun(run({ id: 'wfr_2', nodeId: 'node-2', status: 'paused' })));
    act(() => handlers[0].onRun(run({ id: 'wfr_3', nodeId: 'node-3', status: 'completed', actions: [] })));
    act(() => handlers[0].onRun(run({ id: 'wfr_4', nodeId: null })));
    expect(getByTestId('open').textContent).toBe('node-1,node-2');
    // Progress on an open run does not re-render the reader.
    const before = renders;
    act(() => handlers[0].onRun(run({ revision: 5, updatedAt: 3_000 })));
    expect(renders).toBe(before);
    act(() => handlers[0].onRun(run({ revision: 6, status: 'failed', actions: [] })));
    expect(getByTestId('open').textContent).toBe('node-2');
  });

  it('records a refused action as an error on the run', async () => {
    const api: WorkflowDomainApi = {
      get: vi.fn(), subscribe: vi.fn(() => () => {}), answer: vi.fn(),
      act: vi.fn(async () => { throw new Error('Cannot stop this workflow now'); }),
    };
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    function Probe() { domain = useOptionalWorkflowDomain(); return null; }
    render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    await act(async () => { await domain!.act({ backendConnectionId: 'local', id: 'wfr_1' }, 'stop'); });
    expect(Object.values(domain!.store.getState().errors)).toEqual(['Cannot stop this workflow now']);
    expect(Object.values(domain!.store.getState().pending)).toEqual([undefined]);
  });

  it('stops reconnecting when the workspace is not ours', async () => {
    vi.useFakeTimers();
    try {
      const { SseHttpError } = await import('../../../services/api/sseParser');
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
      act(() => { domain!.subscribeWorkspace('ws'); });
      act(() => handlers[0].onDisconnect?.(new SseHttpError(403)));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(api.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects at once when its remote backend is ready again, not for another one', async () => {
    vi.useFakeTimers();
    try {
      const { BACKEND_CONNECTION_READY } = await import('../../../config/backendConnectionState');
      const ready = (connectionId: string) => window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId } }));
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
      let release!: () => void;
      act(() => { release = domain!.subscribeWorkspace('remote:mac:ws'); });
      act(() => handlers[0].onDisconnect?.(new Error('gone')));
      act(() => ready('other'));
      expect(api.subscribe).toHaveBeenCalledTimes(1);
      act(() => ready('mac'));
      expect(api.subscribe).toHaveBeenCalledTimes(2);
      act(() => release());
      act(() => ready('mac'));
      expect(api.subscribe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps backing off when the feed fails right after it opens', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
      act(() => { domain!.subscribeWorkspace('ws'); });
      for (const delay of [1_000, 2_000, 4_000]) {
        const last = handlers[handlers.length - 1];
        act(() => last.onOpen?.());
        act(() => last.onDisconnect?.(new Error('dropped after headers')));
        const before = handlers.length;
        await act(async () => { vi.advanceTimersByTime(delay - 1); });
        expect(handlers).toHaveLength(before);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(handlers).toHaveLength(before + 1);
      }
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps retrying a workspace the backend has not saved yet', async () => {
    vi.useFakeTimers();
    try {
      const { SseHttpError } = await import('../../../services/api/sseParser');
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
      act(() => { domain!.subscribeWorkspace('ws-new'); });
      // A new workspace answers 404 until its first structural flush.
      act(() => handlers[0].onDisconnect?.(new SseHttpError(404)));
      await act(async () => { vi.advanceTimersByTime(1_250); });
      expect(api.subscribe).toHaveBeenCalledTimes(2);
      act(() => handlers[1].onOpen?.());
      act(() => handlers[1].onRun(run({ workspaceId: 'ws-new' })));
      expect(Object.keys(domain!.store.getState().runs)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-renders a message list only when a run is added, not on progress', () => {
    let renders = 0;
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    function List() {
      renders += 1;
      domain = useOptionalWorkflowDomain();
      const placements = useWorkflowPlacementsForNode('node-1');
      return <span data-testid="count">{placements.length}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><List /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    const before = renders;
    act(() => handlers[0].onRun(run({ revision: 5 })));
    expect(getByTestId('count').textContent).toBe('1');
    const afterAdd = renders;
    expect(afterAdd).toBe(before + 1);
    act(() => handlers[0].onRun(run({ revision: 6, nodes: [] })));
    act(() => handlers[0].onRun(run({ revision: 7, status: 'completed', actions: [] })));
    expect(renders).toBe(afterAdd);
    act(() => handlers[0].onRun(run({ id: 'wfr_other', nodeId: 'node-2', revision: 1 })));
    expect(renders).toBe(afterAdd);
  });

  it('lists the runs of a set of chats and keeps identity for unrelated runs', () => {
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    const nodeIds = ['node-1', 'node-2'];
    const seen: unknown[] = [];
    function Probe() {
      domain = useOptionalWorkflowDomain();
      const runs = useWorkflowRunsForNodes(nodeIds);
      seen.push(runs);
      return <span data-testid="runs">{runs.map((resource) => resource.value.id).join(',')}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onRun(run({ id: 'late', startedAt: 5 })));
    act(() => handlers[0].onRun(run({ id: 'early', nodeId: 'node-2', startedAt: 2 })));
    expect(getByTestId('runs').textContent).toBe('early,late');
    const count = seen.length;
    act(() => handlers[0].onRun(run({ id: 'elsewhere', nodeId: 'node-9' })));
    expect(seen.length).toBe(count);
    act(() => handlers[0].onRun(run({ id: 'late', startedAt: 5, revision: 9 })));
    expect(seen.length).toBe(count + 1);
  });

  it('fetches a run shown in full once, and again for a trimmed revision', async () => {
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      act: vi.fn(), answer: vi.fn(),
      get: vi.fn(async () => run({ revision: 4 })),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    function Probe() {
      domain = useOptionalWorkflowDomain();
      // A fresh identity object every render must not refetch.
      const { resource } = useWorkflowRunDetail({ backendConnectionId: 'local', id: 'wfr_1' });
      return <span data-testid="partial">{String(resource?.value.partial ?? false)}</span>;
    }
    const { getByTestId, rerender } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    await act(async () => {});
    expect(api.get).toHaveBeenCalledTimes(1);
    rerender(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    expect(api.get).toHaveBeenCalledTimes(1);
    act(() => { domain!.subscribeWorkspace('ws'); });
    await act(async () => { handlers[0].onRun(run({ revision: 6, partial: true, nodes: [] })); });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(getByTestId('partial').textContent).toBe('true');
  });

  it('tells a chat whether a Claude workflow still runs in it', () => {
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    function Probe() {
      domain = useOptionalWorkflowDomain();
      return <span data-testid="running">{String(useRunningClaudeWorkflow('node-1'))}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onRun(run({ runtime: 'kiro' })));
    expect(getByTestId('running').textContent).toBe('false');
    act(() => handlers[0].onRun(run({ id: 'wfr_claude', runtime: 'claude', nodeId: 'node-2' })));
    expect(getByTestId('running').textContent).toBe('false');
    act(() => handlers[0].onRun(run({ id: 'wfr_claude_here', runtime: 'claude', revision: 1 })));
    expect(getByTestId('running').textContent).toBe('true');
    act(() => handlers[0].onRun(run({ id: 'wfr_claude_here', runtime: 'claude', revision: 2, status: 'completed', actions: [] })));
    expect(getByTestId('running').textContent).toBe('false');
  });

});

function multiModelView(phase: MultiModelRunView['phase']): MultiModelRunView {
  return {
    version: 1, phase, title: 'Caches', askPreview: 'Ask Codex too', callerNodeId: 'node-1', callerMessageId: 'm-1',
    callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus', permissionMode: 'ask', reviewRounds: 0,
    threads: [], synthesis: { status: 'pending' },
  };
}

function michiRun(phase: MultiModelRunView['phase'], patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return run({
    id: 'wfr_mm', runtime: 'michi', nativeId: 'mm_1', parentToolCallId: null, nodes: [], log: [], actions: [],
    status: phase === 'proposed' ? 'paused' : phase === 'running' ? 'running' : 'completed',
    multiModel: multiModelView(phase), ...patch,
  });
}

describe('workflow domain: multi-model runs', () => {
  function feed() {
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    return { api, handlers };
  }

  it('names a michi run\'s members branches', () => {
    expect(RUN_NOUN).toEqual({ claude: 'agents', kiro: 'steps', michi: 'branches' });
    expect(['claude', 'kiro', 'michi'].map((runtime) => runNounTitle(runtime as WorkflowRunDtoV1['runtime']))).toEqual(['Agents', 'Steps', 'Branches']);
  });

  it('does not count a proposed plan as running work until it starts', () => {
    const { api, handlers } = feed();
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const nodeIds = ['node-1'];
    function Probe() {
      domain = useOptionalWorkflowDomain();
      const counts = useActiveWorkflowCounts(nodeIds);
      const open = useOpenWorkflowNodeIds();
      return <span data-testid="state">{`${counts.join(',')}|${[...open].join(',') || 'none'}`}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onRun(michiRun('proposed', { revision: 1 })));
    expect(getByTestId('state').textContent).toBe('0|none');
    act(() => handlers[0].onRun(michiRun('running', { revision: 2 })));
    expect(getByTestId('state').textContent).toBe('1|node-1');
  });

  it('leaves michi runs to their receipt instead of placing them under the message', () => {
    const { api, handlers } = feed();
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    function List() {
      domain = useOptionalWorkflowDomain();
      return <span data-testid="ids">{useWorkflowPlacementsForNode('node-1').map((p) => p.identity.id).join(',')}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><List /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onRun(michiRun('running')));
    act(() => handlers[0].onRun(run({ id: 'wfr_kiro' })));
    expect(getByTestId('ids').textContent).toBe('wfr_kiro');
  });

  it('lists the chats whose active run waits on an approval, as a stable set', () => {
    const { api, handlers } = feed();
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const seen: Array<ReadonlySet<string>> = [];
    function Probe() {
      domain = useOptionalWorkflowDomain();
      const ids = useWaitingWorkflowNodeIds();
      seen.push(ids);
      return <span data-testid="waiting">{[...ids].sort().join(',') || 'none'}</span>;
    }
    const approval = { id: 't1:turn:1', nodeId: 't1@0', title: 'Approve Bash?', options: [{ optionId: 'allow', name: 'Allow once' }], requestedAt: 1 };
    const { getByTestId } = render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onRun(michiRun('running', { revision: 1 })));
    act(() => handlers[0].onRun(run({ id: 'wfr_done', nodeId: 'node-3', status: 'completed', actions: [], approvals: [approval] })));
    expect(getByTestId('waiting').textContent).toBe('none');
    act(() => handlers[0].onRun(michiRun('running', { revision: 2, approvals: [approval] })));
    act(() => handlers[0].onRun(run({ id: 'wfr_kiro', nodeId: 'node-2', status: 'paused', approvals: [approval] })));
    expect(getByTestId('waiting').textContent).toBe('node-1,node-2');
    const before = seen[seen.length - 1];
    act(() => handlers[0].onRun(michiRun('running', { revision: 3, approvals: [approval], updatedAt: 9_000 })));
    expect(seen[seen.length - 1]).toBe(before);
    act(() => handlers[0].onRun(michiRun('running', { revision: 4 })));
    expect(getByTestId('waiting').textContent).toBe('node-2');
  });

  it('performs a command with its own pending kind and stores the run it answers with', async () => {
    const { api } = feed();
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    function Probe() { domain = useOptionalWorkflowDomain(); return null; }
    render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
    const identity = { backendConnectionId: 'local', id: 'wfr_mm' };
    let finish!: (value: WorkflowRunDtoV1) => void;
    let done!: Promise<void>;
    act(() => { done = domain!.perform(identity, 'start', () => new Promise((resolve) => { finish = resolve; })); });
    expect(Object.values(domain!.store.getState().pending)).toEqual(['start']);
    await act(async () => { finish(michiRun('running', { revision: 3 })); await done; });
    expect(Object.values(domain!.store.getState().pending)).toEqual([undefined]);
    expect(Object.values(domain!.store.getState().runs).map((r) => r.value.multiModel?.phase)).toEqual(['running']);
    await act(async () => { await domain!.perform(identity, 'thread', async () => { throw new Error('Still stopping the branches.'); }); });
    expect(Object.values(domain!.store.getState().errors)).toEqual(['Still stopping the branches.']);
  });

  it('refetches a trimmed run once per revision, without a fetch on mount', async () => {
    const { handlers } = feed();
    const api: WorkflowDomainApi = {
      act: vi.fn(), answer: vi.fn(),
      get: vi.fn(async () => michiRun('running', { revision: 6 })),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const identity = { backendConnectionId: 'local', id: 'wfr_mm' };
    function Card() {
      domain = useOptionalWorkflowDomain();
      const { resource } = useWorkflowRun(workflowRunKey(identity));
      useRefetchPartialWorkflowRun(identity, resource);
      return null;
    }
    render(<WorkflowDomainProvider api={api}><Card /></WorkflowDomainProvider>);
    await act(async () => {});
    expect(api.get).not.toHaveBeenCalled();
    act(() => { domain!.subscribeWorkspace('ws'); });
    await act(async () => { handlers[0].onRun(michiRun('running', { revision: 5 })); });
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => { handlers[0].onRun(michiRun('running', { revision: 6, partial: true })); });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => { handlers[0].onRun(michiRun('running', { revision: 6, partial: true })); });
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe('workflow domain: live background subagents', () => {
  const feed = workflowFeedKey('ws');
  const update = (snapshot: boolean, nodes: Record<string, string[]>): WorkflowDomainAction =>
    ({ type: 'backgroundSubagents', feedKey: feed, update: { snapshot, nodes } });
  const stale = (at: number): WorkflowDomainAction => ({ type: 'backgroundSubagentsStale', feedKey: feed, at });
  /** Current ids sorted; a stale feed's last word as `{ stale, ids }`. */
  const ids = (live: NodeBackgroundSubagentLiveness) => {
    if (!live) return live;
    return 'staleSince' in live ? { stale: live.staleSince, ids: [...live.ids].sort() } : [...live].sort();
  };
  /** A stale view's set, to compare identities. */
  const staleIds = (live: NodeBackgroundSubagentLiveness) => (live && 'staleSince' in live ? live.ids : undefined);

  it('takes a snapshot whole and applies deltas per node', () => {
    // Nothing known before the feed's snapshot.
    expect(selectLiveBackgroundSubagents(initialWorkflowDomainState, 'ws', 'n1')).toBeUndefined();
    let state = workflowDomainReducer(initialWorkflowDomainState, update(true, { n1: ['a', 'b'], n2: [] }));
    expect(ids(selectLiveBackgroundSubagents(state, 'ws', 'n1'))).toEqual(['a', 'b']);
    // Omitted, or listed empty: known to have none.
    const none = selectLiveBackgroundSubagents(state, 'ws', 'n2');
    expect(ids(none)).toEqual([]);
    expect(selectLiveBackgroundSubagents(state, 'ws', 'n3')).toBe(none);
    expect(Object.isFrozen(none)).toBe(true);
    // Another workspace's feed is still unknown.
    expect(selectLiveBackgroundSubagents(state, 'ws-other', 'n1')).toBeUndefined();

    state = workflowDomainReducer(state, update(false, { n2: ['c'] }));
    expect(ids(selectLiveBackgroundSubagents(state, 'ws', 'n2'))).toEqual(['c']);
    expect(ids(selectLiveBackgroundSubagents(state, 'ws', 'n1'))).toEqual(['a', 'b']);
    state = workflowDomainReducer(state, update(false, { n1: [] }));
    expect(selectLiveBackgroundSubagents(state, 'ws', 'n1')).toBe(none);
    expect(state.backgroundSubagents[feed].nodes.has('n1')).toBe(false);

    // A later snapshot replaces the feed: nodes it omits have none.
    state = workflowDomainReducer(state, update(true, { n1: ['d'] }));
    expect(ids(selectLiveBackgroundSubagents(state, 'ws', 'n1'))).toEqual(['d']);
    expect(selectLiveBackgroundSubagents(state, 'ws', 'n2')).toBe(none);
  });

  it('keeps every object when an update changes nothing', () => {
    const state = workflowDomainReducer(initialWorkflowDomainState, update(true, { n1: ['a', 'b'], n2: ['c'] }));
    const n1 = selectLiveBackgroundSubagents(state, 'ws', 'n1');
    // The same ids in another order, a repeated delta, removing a node without any.
    expect(workflowDomainReducer(state, update(true, { n2: ['c'], n1: ['b', 'a'], n3: [] }))).toBe(state);
    expect(workflowDomainReducer(state, update(false, { n1: ['b', 'a'] }))).toBe(state);
    expect(workflowDomainReducer(state, update(false, { n3: [] }))).toBe(state);
    expect(workflowDomainReducer(state, update(false, {}))).toBe(state);
    // A changed node gets a new set; the others keep theirs.
    const next = workflowDomainReducer(state, update(false, { n2: ['c', 'e'] }));
    expect(selectLiveBackgroundSubagents(next, 'ws', 'n1')).toBe(n1);
    expect(ids(selectLiveBackgroundSubagents(next, 'ws', 'n2'))).toEqual(['c', 'e']);
    // A snapshot that changes one node keeps the other's set too.
    const resnapshot = workflowDomainReducer(next, update(true, { n1: ['a', 'b'] }));
    expect(selectLiveBackgroundSubagents(resnapshot, 'ws', 'n1')).toBe(n1);
    expect(resnapshot.runs).toBe(state.runs);
  });

  it('drops a delta that arrives before its feed\'s snapshot, and forgets the feed when unknown', () => {
    expect(workflowDomainReducer(initialWorkflowDomainState, update(false, { n1: ['a'] }))).toBe(initialWorkflowDomainState);
    // An empty snapshot still makes the feed known.
    const known = workflowDomainReducer(initialWorkflowDomainState, update(true, {}));
    expect(ids(selectLiveBackgroundSubagents(known, 'ws', 'n1'))).toEqual([]);
    const unknown = workflowDomainReducer(known, { type: 'backgroundSubagentsUnknown', feedKey: feed });
    expect(selectLiveBackgroundSubagents(unknown, 'ws', 'n1')).toBeUndefined();
    expect(workflowDomainReducer(unknown, { type: 'backgroundSubagentsUnknown', feedKey: feed })).toBe(unknown);
    // A stale feed is forgotten the same way.
    const forgotten = workflowDomainReducer(workflowDomainReducer(known, stale(5_000)), { type: 'backgroundSubagentsUnknown', feedKey: feed });
    expect(selectLiveBackgroundSubagents(forgotten, 'ws', 'n1')).toBeUndefined();
    // An unknown feed has no last word to keep.
    expect(workflowDomainReducer(initialWorkflowDomainState, stale(5_000))).toBe(initialWorkflowDomainState);
  });

  it('keeps a disconnected feed\'s sets, stale, until a snapshot makes it current again', () => {
    const state = workflowDomainReducer(initialWorkflowDomainState, update(true, { n1: ['a'], n2: ['b'] }));
    const nodes = state.backgroundSubagents[feed].nodes;
    const n1 = selectLiveBackgroundSubagents(state, 'ws', 'n1') as ReadonlySet<string>;
    const none = selectLiveBackgroundSubagents(state, 'ws', 'n3') as ReadonlySet<string>;

    const marked = workflowDomainReducer(state, stale(5_000));
    expect(marked.runs).toBe(state.runs);
    // Only the feed object is new: the map and its sets stay.
    expect(marked.backgroundSubagents[feed]).toEqual({ nodes, staleSince: 5_000 });
    expect(marked.backgroundSubagents[feed].nodes).toBe(nodes);
    const n1Stale = selectLiveBackgroundSubagents(marked, 'ws', 'n1');
    expect(ids(n1Stale)).toEqual({ stale: 5_000, ids: ['a'] });
    expect(staleIds(n1Stale)).toBe(n1);
    expect(Object.isFrozen(n1Stale)).toBe(true);
    // The same view on every lookup while nothing changes; nodes without any share one.
    expect(selectLiveBackgroundSubagents(marked, 'ws', 'n1')).toBe(n1Stale);
    const noneStale = selectLiveBackgroundSubagents(marked, 'ws', 'n3');
    expect(staleIds(noneStale)).toBe(none);
    expect(selectLiveBackgroundSubagents(marked, 'ws', 'n4')).toBe(noneStale);
    // A failed reconnect knows no more than the first disconnect: its time stands.
    expect(workflowDomainReducer(marked, stale(9_000))).toBe(marked);

    // A delta (none comes before a reconnect's snapshot) updates the nodes it
    // names and leaves the feed stale; one that changes nothing changes nothing.
    expect(workflowDomainReducer(marked, update(false, { n1: ['a'] }))).toBe(marked);
    const delta = workflowDomainReducer(marked, update(false, { n2: [] }));
    expect(delta.backgroundSubagents[feed].staleSince).toBe(5_000);
    expect(ids(selectLiveBackgroundSubagents(delta, 'ws', 'n2'))).toEqual({ stale: 5_000, ids: [] });
    expect(staleIds(selectLiveBackgroundSubagents(delta, 'ws', 'n1'))).toBe(n1);

    // The reconnect's snapshot: current again, unchanged sets and map kept.
    const reconnected = workflowDomainReducer(marked, update(true, { n1: ['a'], n2: ['b'] }));
    expect(reconnected.backgroundSubagents[feed].staleSince).toBeUndefined();
    expect(reconnected.backgroundSubagents[feed].nodes).toBe(nodes);
    expect(selectLiveBackgroundSubagents(reconnected, 'ws', 'n1')).toBe(n1);
    expect(workflowDomainReducer(reconnected, update(true, { n2: ['b'], n1: ['a'] }))).toBe(reconnected);
    // One that changed during the outage: the changed node only gets a new set.
    const changed = workflowDomainReducer(delta, update(true, { n1: ['a', 'c'], n2: ['b'] }));
    expect(changed.backgroundSubagents[feed].staleSince).toBeUndefined();
    expect(ids(selectLiveBackgroundSubagents(changed, 'ws', 'n1'))).toEqual(['a', 'c']);
    expect(ids(selectLiveBackgroundSubagents(changed, 'ws', 'n2'))).toEqual(['b']);
  });

  it('keeps liveness per subscription: known from its snapshot, stale while it reconnects, unknown once the last subscriber leaves', async () => {
    vi.useFakeTimers();
    try {
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      let clock = 5_000;
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      const now = () => clock;
      render(<WorkflowDomainProvider api={api} now={now}><Probe /></WorkflowDomainProvider>);
      const live = () => ids(selectLiveBackgroundSubagents(domain!.store.getState(), 'ws', 'n1'));
      const notified = vi.fn();
      domain!.store.subscribe(notified);

      let releaseA!: () => void;
      let releaseB!: () => void;
      act(() => { releaseA = domain!.subscribeWorkspace('ws'); releaseB = domain!.subscribeWorkspace('ws'); });
      expect(live()).toBeUndefined();
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['a'] } }));
      expect(live()).toEqual(['a']);
      expect(notified).toHaveBeenCalledTimes(1);
      // A no-op update does not wake listeners.
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: false, nodes: { n1: ['a'] } }));
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['a'] } }));
      expect(notified).toHaveBeenCalledTimes(1);

      // Disconnected: the last word stays, stale since now, until the reconnect's snapshot.
      act(() => handlers[0].onDisconnect?.(new Error('gone')));
      expect(live()).toEqual({ stale: 5_000, ids: ['a'] });
      expect(notified).toHaveBeenCalledTimes(2);
      await act(async () => { vi.advanceTimersByTime(1_250); });
      expect(handlers).toHaveLength(2);
      // The reconnect fails too: still stale since the first disconnect, and nobody is woken.
      clock = 6_000;
      act(() => handlers[1].onDisconnect?.(new Error('still gone')));
      expect(live()).toEqual({ stale: 5_000, ids: ['a'] });
      expect(notified).toHaveBeenCalledTimes(2);
      await act(async () => { vi.advanceTimersByTime(2_500); });
      expect(handlers).toHaveLength(3);
      act(() => handlers[2].onOpen?.());
      expect(live()).toEqual({ stale: 5_000, ids: ['a'] });
      act(() => handlers[2].onBackgroundSubagents?.({ snapshot: true, nodes: {} }));
      expect(live()).toEqual([]);

      // One subscriber leaves: still known. The last one leaves: unknown,
      // and late updates from the stopped feed are ignored.
      act(() => releaseA());
      expect(live()).toEqual([]);
      act(() => releaseB());
      expect(live()).toBeUndefined();
      act(() => handlers[2].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['late'] } }));
      expect(live()).toBeUndefined();

      // Released while stale: unknown too, and the stopped feed's disconnect changes nothing.
      let release!: () => void;
      act(() => { release = domain!.subscribeWorkspace('ws'); });
      act(() => handlers[3].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['b'] } }));
      act(() => handlers[3].onDisconnect?.(new Error('gone')));
      expect(live()).toEqual({ stale: 6_000, ids: ['b'] });
      act(() => release());
      expect(live()).toBeUndefined();
      act(() => handlers[3].onDisconnect?.(new Error('gone')));
      expect(live()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the feed\'s liveness when the backend refuses it, since no reconnect follows', async () => {
    vi.useFakeTimers();
    try {
      const { SseHttpError } = await import('../../../services/api/sseParser');
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() { domain = useOptionalWorkflowDomain(); return null; }
      render(<WorkflowDomainProvider api={api} now={() => 5_000}><Probe /></WorkflowDomainProvider>);
      act(() => { domain!.subscribeWorkspace('ws'); });
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['a'] } }));
      act(() => handlers[0].onDisconnect?.(new SseHttpError(403)));
      expect(selectLiveBackgroundSubagents(domain!.store.getState(), 'ws', 'n1')).toBeUndefined();
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(api.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-renders a liveness reader on liveness changes only, not on run progress', () => {
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    let renders = 0;
    function Probe() {
      renders += 1;
      domain = useOptionalWorkflowDomain();
      const liveness = useBackgroundSubagentLiveness();
      const live = liveness('ws', 'n1');
      const text = (set: ReadonlySet<string>) => [...set].join(',') || 'none';
      return <span data-testid="live">{!live ? 'unknown' : 'staleSince' in live ? `stale ${text(live.ids)}` : text(live)}</span>;
    }
    const { getByTestId } = render(<WorkflowDomainProvider api={api} now={() => 5_000}><Probe /></WorkflowDomainProvider>);
    act(() => { domain!.subscribeWorkspace('ws'); });
    expect(getByTestId('live').textContent).toBe('unknown');
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['a'] } }));
    expect(getByTestId('live').textContent).toBe('a');
    const before = renders;
    act(() => handlers[0].onRun(run({ revision: 5 })));
    act(() => handlers[0].onRun(run({ revision: 6, status: 'completed', actions: [] })));
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: false, nodes: { n1: ['a'] } }));
    expect(renders).toBe(before);
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: false, nodes: { n1: [] } }));
    expect(getByTestId('live').textContent).toBe('none');

    // A disconnect re-renders once; run pushes while stale do not.
    act(() => handlers[0].onDisconnect?.(new Error('gone')));
    expect(getByTestId('live').textContent).toBe('stale none');
    const stale = renders;
    act(() => handlers[0].onRun(run({ revision: 7, status: 'completed', actions: [] })));
    expect(renders).toBe(stale);
  });

  it('hands ended background subagents to its handler with their workspace, and leaves workflow state alone', () => {
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    function Probe() { domain = useOptionalWorkflowDomain(); return null; }
    const first = vi.fn();
    const second = vi.fn();
    const ended = { nodeId: 'n1', subagents: [{ sessionId: 'a', outcome: 'cancelled' as const, endedAt: 3, error: 'gone' }] };
    const { rerender } = render(<WorkflowDomainProvider api={api} onBackgroundSubagentsEnded={first}><Probe /></WorkflowDomainProvider>);
    let release: () => void = () => {};
    act(() => { release = domain!.subscribeWorkspace('ws'); });
    const before = domain!.store.getState();
    act(() => handlers[0].onBackgroundSubagentsEnded?.(ended));
    expect(first).toHaveBeenCalledWith({ ...ended, backendConnectionId: 'local', workspaceId: 'ws' });
    expect(domain!.store.getState()).toBe(before);

    // A new handler takes over without a new subscription.
    rerender(<WorkflowDomainProvider api={api} onBackgroundSubagentsEnded={second}><Probe /></WorkflowDomainProvider>);
    act(() => handlers[0].onBackgroundSubagentsEnded?.(ended));
    expect(second).toHaveBeenCalledTimes(1);
    expect(api.subscribe).toHaveBeenCalledTimes(1);

    // A handler that throws does not break the feed; a released feed hands over nothing.
    second.mockImplementationOnce(() => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => act(() => handlers[0].onBackgroundSubagentsEnded?.(ended))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    act(() => release());
    act(() => handlers[0].onBackgroundSubagentsEnded?.(ended));
    expect(second).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

describe('workflow-run pane items', () => {
  it('validates restored workflow panes', () => {
    const item = {
      id: workflowRunPaneId('local', 'wfr_1'), kind: 'workflow-run', projectId: 'ws', treeId: null, title: 'probe', createdAt: 1,
      backendConnectionId: 'local', runId: 'wfr_1',
    };
    expect(isPaneItem(item)).toBe(true);
    expect(isPaneItem({ ...item, runId: 7 })).toBe(false);
    expect(item.id).toBe('pane:workflow-run:local:wfr_1');
  });
});
