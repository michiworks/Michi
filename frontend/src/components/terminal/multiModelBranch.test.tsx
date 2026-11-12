/**
 * A multi-model branch reaches its run: Open plan opens the caller's drawer
 * on the branch's row, and a failed step retries through the run's row (the
 * orchestrator follows only its own turns).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import type { MultiModelRunView, MultiModelStepView, MultiModelThreadView, WorkflowRunDtoV1 } from 'michi-shared';
import { WorkflowDomainProvider, type WorkflowDomainApi } from '../../state/workflowDomain';
import type { ChatMessage } from '../../state/chatTypes';
import { OPEN_BACKGROUND_WORK_EVENT, type OpenBackgroundWorkDetail } from './backgroundWork/backgroundWorkEvents';
import { branchRow, failedPlanStep, rowFocusStep, useMultiModelBranch, type MultiModelBranchControls } from './multiModelBranch';

const apiCalls = vi.hoisted(() => ({ retryMultiModelThread: vi.fn() }));
vi.mock('../../services/api/multiModelRuns', () => apiCalls);

const step = (status: MultiModelStepView['status'], round = 0): MultiModelStepView => ({ kind: round === 0 ? 'answer' : 'review', round, status });

function thread(key: string, childNodeId: string | null, steps: MultiModelStepView[], patch: Partial<MultiModelThreadView> = {}): MultiModelThreadView {
  return {
    key, runtimeId: 'codex', providerId: null, modelId: null, reasoning: null, runtimeLabel: 'Codex', modelLabel: 'GPT-6.1 Sol',
    context: 'fork', promptPreview: 'Weigh it.', childNodeId, steps, ...patch,
  };
}

function view(threads: MultiModelThreadView[]): MultiModelRunView {
  return {
    version: 1, phase: 'running', title: 'Timing', askPreview: 'When?', callerNodeId: 'caller', callerMessageId: 'a1',
    callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus', permissionMode: 'ask', reviewRounds: 2,
    startedAt: 1, synthesis: { status: 'pending' }, threads,
  };
}

function run(threads: MultiModelThreadView[], revision = 1): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws', nodeId: 'caller', parentToolCallId: null,
    name: 'Timing', status: 'running', nodes: [], log: [], actions: [], startedAt: 1, updatedAt: 2, revision, multiModel: view(threads),
  };
}

const RUN_KEY = JSON.stringify(['local', 'wfr_1']);

const FAILED = [thread('t1', 'other', [step('completed'), step('completed', 1), step('pending', 2)]), thread('t2', 'branch', [step('completed'), step('failed', 1), step('pending', 2)])];

let latest: MultiModelBranchControls | null = null;
function Probe({ runId = 'wfr_1' }: { runId?: string }) {
  latest = useMultiModelBranch({ nodeId: 'branch', workspaceId: 'ws', runId, parentNodeId: 'parent' });
  return null;
}

function setup(get: WorkflowDomainApi['get']) {
  const api: WorkflowDomainApi = { get: vi.fn(get), act: vi.fn(), answer: vi.fn(), subscribe: vi.fn(() => () => {}) };
  render(<WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>);
  return api;
}

let detach: (() => void) | undefined;
function opened(): OpenBackgroundWorkDetail[] {
  const details: OpenBackgroundWorkDetail[] = [];
  const listener = (event: Event) => details.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  detach = () => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  return details;
}

beforeEach(() => {
  latest = null;
  apiCalls.retryMultiModelThread.mockReset();
});
afterEach(() => {
  detach?.();
  detach = undefined;
});

describe('multi-model branch helpers', () => {
  it('finds the branch\'s row, also one it answered in before Replace model', () => {
    const value = view([thread('t1', 'new', [], { previousChildNodeIds: ['old'] }), thread('t2', 'b', [])]);
    expect(branchRow(value, 'b')).toEqual({ thread: value.threads[1], current: true });
    expect(branchRow(value, 'old')).toEqual({ thread: value.threads[0], current: false });
    expect(branchRow(value, 'none')).toBeUndefined();
  });

  it('focuses the latest step that ran', () => {
    expect(rowFocusStep(thread('t', 'b', [step('completed'), step('failed', 1), step('pending', 2)]))).toBe(1);
    expect(rowFocusStep(thread('t', 'b', [step('failed'), step('skipped', 1)]))).toBe(0);
    expect(rowFocusStep(thread('t', 'b', []))).toBe(0);
  });

  it('names the failed turn\'s plan step, not a failed turn of the user\'s own', () => {
    const plan = { runId: 'wfr_1', step: 'review' as const, round: 1, rounds: 2 };
    const prompt: ChatMessage = { id: 'u', role: 'user', text: 'Review', toolCalls: [], threadMessage: { fromNodeId: 'caller', plan } };
    const reply: ChatMessage = { id: 'a', role: 'assistant', text: '', toolCalls: [] };
    expect(failedPlanStep({ status: 'error', messages: [prompt, reply] })).toBe(plan);
    expect(failedPlanStep({ status: 'idle', messages: [prompt, reply] })).toBeUndefined();
    const own: ChatMessage = { id: 'u2', role: 'user', text: 'And now?', toolCalls: [] };
    expect(failedPlanStep({ status: 'error', messages: [prompt, reply, own, reply] })).toBeUndefined();
  });
});

describe('useMultiModelBranch', () => {
  it('fetches a run the store lacks, then retries the branch\'s row through it', async () => {
    const api = setup(async () => run(FAILED));
    await waitFor(() => expect(latest?.retry).toBeDefined());
    expect(api.get).toHaveBeenCalledExactlyOnceWith('local', 'wfr_1');
    let answer!: (value: WorkflowRunDtoV1) => void;
    apiCalls.retryMultiModelThread.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    act(() => latest!.retry!());
    expect(apiCalls.retryMultiModelThread).toHaveBeenCalledExactlyOnceWith('local', 'wfr_1', 't2');
    expect(latest!.busy).toBe(true);
    // A second click while the command is in flight sends nothing.
    act(() => latest!.retry!());
    expect(apiCalls.retryMultiModelThread).toHaveBeenCalledTimes(1);
    await act(async () => answer(run([FAILED[0], thread('t2', 'branch', [step('completed'), step('queued', 1), step('pending', 2)])], 2)));
    expect(latest!.retry).toBeUndefined();
    expect(latest!.retrying).toBe(true);
    expect(latest!.busy).toBe(false);
  });

  it('says why the run refused a Retry made here', async () => {
    setup(async () => run(FAILED));
    await waitFor(() => expect(latest?.retry).toBeDefined());
    apiCalls.retryMultiModelThread.mockRejectedValue(new Error('The run is settling'));
    await act(async () => latest!.retry!());
    expect(latest!.error).toBe('The run is settling');
    expect(latest!.retry).toBeDefined();
  });

  it('opens the caller\'s drawer on the branch\'s row and latest step', async () => {
    setup(async () => run(FAILED));
    await waitFor(() => expect(latest?.retry).toBeDefined());
    const details = opened();
    act(() => latest!.openPlan());
    expect(details).toEqual([{ nodeId: 'caller', focus: { kind: 'workflow', runKey: RUN_KEY, threadKey: 't2', step: 1 } }]);
  });

  it('without the run, opens the parent\'s drawer on the run and offers no Retry', async () => {
    const api = setup(async () => { throw new Error('offline'); });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(latest!.retry).toBeUndefined();
    expect(latest!.retrying).toBe(false);
    const details = opened();
    act(() => latest!.openPlan());
    expect(details).toEqual([{ nodeId: 'parent', focus: { kind: 'workflow', runKey: RUN_KEY } }]);
  });

  it('is null for a conversation no plan made', () => {
    render(<Probe runId="" />);
    expect(latest).toBeNull();
  });
});
