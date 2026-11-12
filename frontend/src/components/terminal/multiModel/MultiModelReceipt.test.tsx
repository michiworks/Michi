import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiModelRunView, WorkflowRunDtoV1 } from 'michi-shared';
import type { ToolCallState } from '../../../state/chatTypes';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../../state/workflowDomain';
import { onOpenBackgroundWork, type OpenBackgroundWorkDetail } from '../backgroundWork/backgroundWorkEvents';
import { MultiModelReceipt } from './MultiModelReceipt';

vi.mock('../../../state/chatStore', () => ({ useOptionalChatActions: () => null, useChatNode: () => undefined }));

const result = {
  status: 'proposed', runId: 'wfr_1', nativeId: 'mm_1',
  threads: [{ key: 't1', label: 'Codex · GPT-6.1 Sol', context: 'fork' }], reviewRounds: 1,
  next: 'The plan card is shown to the user. End your turn now with one short sentence.',
};

const view: MultiModelRunView = {
  version: 1, phase: 'running', title: 'Caching', askPreview: 'Ask', callerNodeId: 'caller', callerMessageId: 'm1',
  callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus 5.5', permissionMode: 'ask', reviewRounds: 0,
  startedAt: 1_000,
  threads: [{
    key: 't1', runtimeId: 'codex', providerId: null, modelId: 'sol', reasoning: null, runtimeLabel: 'Codex', modelLabel: 'GPT-6.1 Sol',
    context: 'fork', promptPreview: 'Why?', childNodeId: 'c1', steps: [{ kind: 'answer', round: 0, status: 'failed', error: 'boom' }],
  }],
  synthesis: { status: 'pending' },
};

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws', nodeId: 'caller', parentToolCallId: null,
    name: 'Caching', status: 'running', nodes: [], log: [], actions: [], startedAt: 1_000, updatedAt: 2_000, revision: 2,
    multiModel: view, ...patch,
  };
}

const mcp = (value: unknown) => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function tool(patch: Partial<ToolCallState> = {}): ToolCallState {
  return {
    id: 'call-1', title: 'mcp____michi_internal____propose_multi_model_plan', status: 'completed',
    inputJson: JSON.stringify({ title: 'Caching' }), output: mcp(result), ...patch,
  };
}

function setup(tools: ToolCallState[], opts: { runs?: WorkflowRunDtoV1[]; get?: WorkflowDomainApi['get']; readOnly?: boolean } = {}) {
  const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
  const api: WorkflowDomainApi = {
    act: vi.fn(), answer: vi.fn(),
    get: opts.get ?? vi.fn(async () => run()),
    subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
  };
  let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
  function Probe() { domain = useOptionalWorkflowDomain(); return null; }
  const ui = (next: ToolCallState[]) => (
    <WorkflowDomainProvider api={api}>
      <Probe />
      <MultiModelReceipt tools={next} readOnly={opts.readOnly} />
    </WorkflowDomainProvider>
  );
  const utils = render(ui(tools));
  if (opts.runs) {
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => { for (const value of opts.runs!) handlers[0].onRun(value); });
  }
  return { ...utils, api, push: (value: WorkflowRunDtoV1) => act(() => handlers[0].onRun(value)), setTools: (next: ToolCallState[]) => utils.rerender(ui(next)) };
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('MultiModelReceipt', () => {
  it.each([
    ['Claude (MCP)', tool()],
    ['Kiro', tool({ title: 'Completed: @michi/propose_multi_model_plan' })],
    ['Pi', tool({ title: 'propose_multi_model_plan', output: JSON.stringify(result) })],
    ['Crew', tool({ title: 'michi_call_tool', inputJson: JSON.stringify({ tool: 'propose_multi_model_plan', arguments: { title: 'Caching' } }) })],
    // ACP cut the input at 16 KB: the output still names the plan.
    ['Crew, input cut', tool({ title: 'michi_call_tool', inputJson: `{"tool":"propose_multi_model_plan","arguments":{"threads":[{"prompt":"${'x'.repeat(16_000)}` })],
  ])('renders the card of a %s proposal', (_name, call) => {
    setup([call], { runs: [run()] });
    expect(screen.getByTestId('multi-model-card').getAttribute('data-phase')).toBe('running');
  });

  it('renders nothing for a failed, refused or other call', () => {
    const refused = mcp({ status: 'error', code: 'refused', message: 'Not available inside a branch of a multi-model plan.' });
    setup([
      tool({ status: 'failed' }),
      tool({ id: 'c2', output: refused }),
      tool({ id: 'c3', title: 'create_scheduled_job' }),
    ], { runs: [run()] });
    expect(screen.queryByTestId('multi-model-card')).toBeNull();
  });

  it('fetches a run the feed has not brought after a delay, backs off on failures, then offers a Retry', async () => {
    const get = vi.fn(async (): Promise<WorkflowRunDtoV1> => { throw new Error('getWorkflowRun failed: 503'); });
    setup([tool()], { get });
    await act(async () => { vi.advanceTimersByTime(1_400); });
    expect(get).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('multi-model-card-error')).toBeNull();
    // Then 3s, 6s and 12s later.
    for (const [wait, calls] of [[2_900, 1], [200, 2], [6_000, 3], [12_000, 4]] as const) {
      await act(async () => { vi.advanceTimersByTime(wait); });
      expect(get).toHaveBeenCalledTimes(calls);
    }
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(get).toHaveBeenCalledTimes(4);
    const error = screen.getByTestId('multi-model-card-error');
    expect(error.textContent).toBe("Multi-model planCouldn't load itRetry");
    get.mockResolvedValueOnce(run());
    await act(async () => { fireEvent.click(within(error).getByRole('button', { name: 'Retry' })); });
    expect(get).toHaveBeenCalledTimes(5);
    expect(screen.queryByTestId('multi-model-card-error')).toBeNull();
    expect(screen.getByTestId('multi-model-card').getAttribute('data-phase')).toBe('running');
  });

  it('stops retrying once the feed brings the run', async () => {
    const get = vi.fn(async (): Promise<WorkflowRunDtoV1> => { throw new Error('offline'); });
    const { push } = setup([tool()], { get, runs: [] });
    await act(async () => { vi.advanceTimersByTime(1_600); });
    expect(get).toHaveBeenCalledTimes(1);
    push(run());
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('multi-model-card')).toBeTruthy();
  });

  // Every tool event replaces the reply's tool calls; the run's identity stays.
  it('keeps waiting out the delay through later tool calls of the same reply', async () => {
    const get = vi.fn(async () => run());
    const { setTools } = setup([tool()], { get });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    setTools([tool(), tool({ id: 'c2', title: 'create_scheduled_job', output: 'ok' })]);
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fetches a trimmed run whole, once per trimmed revision', async () => {
    const get = vi.fn(async () => run({ revision: 2 }));
    const { push } = setup([tool()], { runs: [run({ partial: true })], get });
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    push(run({ revision: 2, partial: true }));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    push(run({ revision: 3, partial: true }));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('opens the Background work drawer on a row\'s step', () => {
    const opened: OpenBackgroundWorkDetail[] = [];
    const stop = onOpenBackgroundWork((detail) => opened.push(detail));
    try {
      setup([tool()], { runs: [run()] });
      fireEvent.click(screen.getByTestId('mm-row'));
      expect(opened).toEqual([{ nodeId: 'caller', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']), threadKey: 't1', step: 0 } }]);
    } finally {
      stop();
    }
  });

  it('passes read-only to the card', () => {
    setup([tool()], { runs: [run()], readOnly: true });
    const card = screen.getByTestId('multi-model-card');
    expect(within(card).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(card).getByTestId('mm-row').textContent).toContain('boom');
  });

  it('offers the row controls when not read-only', () => {
    setup([tool()], { runs: [run()] });
    expect(within(screen.getByTestId('multi-model-card')).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
