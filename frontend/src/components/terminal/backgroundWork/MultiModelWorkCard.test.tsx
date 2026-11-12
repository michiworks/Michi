import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useEffect } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { MultiModelRunView, MultiModelStepView, MultiModelThreadView, ReadyModelsDto, WorkflowRunDtoV1 } from 'michi-shared';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, workflowRunKey, type WorkflowDomainApi } from '../../../state/workflowDomain';
import { MultiModelWorkCard } from './MultiModelWorkCard';

const chat = vi.hoisted(() => ({
  actions: null as null | Record<string, ReturnType<typeof vi.fn>>,
  projects: null as null | { projects: unknown[]; activeProject: { id: string } },
}));

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../../state/chatStore')>('../../../state/chatStore');
  return { ...actual, useOptionalChatActions: () => chat.actions, useOptionalChatProjects: () => chat.projects };
});

const apiCalls = vi.hoisted(() => ({
  fetchReadyModels: vi.fn(),
  replaceMultiModelThread: vi.fn(),
  retryMultiModelRun: vi.fn(),
  retryMultiModelThread: vi.fn(),
  stopMultiModelRun: vi.fn(),
  stopMultiModelThread: vi.fn(),
}));
vi.mock('../../../services/api/multiModelRuns', () => apiCalls);

function step(patch: Partial<MultiModelStepView> & Pick<MultiModelStepView, 'status'>, round = 0): MultiModelStepView {
  return { kind: round === 0 ? 'answer' : 'review', round, ...patch };
}

function thread(key: string, runtimeId: string, runtimeLabel: string, modelLabel: string, steps: MultiModelStepView[]): MultiModelThreadView {
  return {
    key, runtimeId, providerId: null, modelId: `${runtimeId}-model`, reasoning: null, runtimeLabel, modelLabel,
    context: 'fork', promptPreview: 'Weigh the options.', childNodeId: `child-${key}`, steps,
  };
}

function view(patch: Partial<MultiModelRunView> = {}): MultiModelRunView {
  return {
    version: 1, phase: 'running', title: 'Memory extraction timing', askPreview: 'Per turn or batched when idle?',
    callerNodeId: 'caller', callerMessageId: 'a1', callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus 5.5',
    permissionMode: 'ask', reviewRounds: 1, startedAt: 1_000, totalTokens: 38_000,
    synthesis: { status: 'pending' },
    threads: [
      thread('t1', 'codex', 'Codex', 'GPT-6.1 Sol', [step({ status: 'waiting', turnId: 'x', startedAt: 1_000 }), step({ status: 'pending' }, 1)]),
      thread('t2', 'kiro', 'Kiro', 'Fable 5.1', [
        step({ status: 'running', startedAt: 1_000, now: 'Estimating credits', excerpt: 'At 1.2k tokens per turn' }),
        step({ status: 'pending' }, 1),
      ]),
      thread('t3', 'pi', 'Pi', 'Gemini 4 Argon', [
        step({ status: 'completed', startedAt: 1_000, endedAt: 49_000, summary: 'Batch when idle.', excerpt: 'Batching dedupes across turns.' }),
        step({ status: 'pending' }, 1),
      ]),
    ],
    ...patch,
  };
}

const APPROVAL = {
  id: 't1:x:7', nodeId: 't1@0', title: 'Approve Bash?', detail: 'rg -n "extraction" backend/src/services', requestedAt: 2_000,
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const }],
};

function run(multiModel: MultiModelRunView, patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  const status = multiModel.phase === 'running' ? 'running' : multiModel.phase === 'completed' ? 'completed' : multiModel.phase === 'failed' ? 'failed' : 'cancelled';
  return {
    version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws', nodeId: 'caller', parentToolCallId: null,
    name: multiModel.title, status, nodes: [], log: [], actions: [], startedAt: 1_000, updatedAt: 2_000, revision: 1,
    multiModel, ...patch,
  };
}

/** A run after Step 1: Codex reviews, Kiro failed and sat out the review, Pi revised. */
function reviewing(): MultiModelRunView {
  return view({
    threads: [
      thread('t1', 'codex', 'Codex', 'GPT-6.1 Sol', [
        step({ status: 'completed', summary: 'Queue every turn.', excerpt: 'Write a cursor per turn.' }),
        step({ status: 'running', startedAt: 1_000, now: 'Reading the other answers', excerpt: 'Gemini is right about duplicates' }, 1),
      ]),
      thread('t2', 'kiro', 'Kiro', 'Fable 5.1', [
        step({ status: 'failed', startedAt: 1_000, endedAt: 101_000, error: 'kiro-cli is not signed in' }),
        step({ status: 'skipped', error: 'Its answer failed' }, 1),
      ]),
      thread('t3', 'pi', 'Pi', 'Gemini 4 Argon', [
        step({ status: 'completed', summary: 'Batch when idle.' }),
        step({ status: 'completed', summary: 'Queue first, batch later.', excerpt: 'Accepting the queue.' }, 1),
      ]),
    ],
  });
}

function done(): MultiModelRunView {
  return {
    ...reviewing(),
    phase: 'completed',
    totalTokens: 186_000,
    synthesis: { status: 'completed', messageId: 'self-caller-mm-syn', summary: 'Queue after every turn, run in idle batches.' },
    threads: reviewing().threads.map((entry) => (entry.key === 't1'
      ? { ...entry, steps: [entry.steps[0], step({ status: 'completed', summary: 'Merged batches.', excerpt: 'Merge per node.' }, 1)] }
      : entry)),
  };
}

function Feed() {
  const subscribe = useOptionalWorkflowDomain()?.subscribeWorkspace;
  useEffect(() => subscribe?.('ws'), [subscribe]);
  return null;
}

const RUN_KEY = workflowRunKey({ backendConnectionId: 'local', id: 'wfr_1' });

function setup(value: WorkflowRunDtoV1, props: Partial<React.ComponentProps<typeof MultiModelWorkCard>> = {}) {
  let feed: Parameters<WorkflowDomainApi['subscribe']>[1] | undefined;
  const api: WorkflowDomainApi = {
    get: vi.fn(async () => value),
    act: vi.fn(),
    answer: vi.fn(async () => ({ ...value, approvals: [], revision: value.revision + 1 })),
    subscribe: vi.fn((_workspaceId, options) => { feed = options; options.onRun(value); return () => {}; }),
  };
  const onClose = vi.fn();
  const ui = (next: typeof props) => (
    <WorkflowDomainProvider api={api}>
      <Feed />
      <MultiModelWorkCard runKey={RUN_KEY} rowKey="row-key" expanded={false} onClose={onClose} {...next} />
    </WorkflowDomainProvider>
  );
  const result = render(ui(props));
  return { ...result, api, onClose, rerenderWith: (next: typeof props) => result.rerender(ui(next)), push: (next: WorkflowRunDtoV1) => act(() => feed!.onRun(next)) };
}

const row = (key: string, stepIndex: number) => {
  const element = document.querySelector<HTMLElement>(`[data-testid="multi-model-row"][data-thread-key="${key}"][data-step="${stepIndex}"]`);
  if (!element) throw new Error(`no row ${key}@${stepIndex}`);
  return element;
};
const rowButton = (key: string, stepIndex: number) => row(key, stepIndex).querySelector('button')!;

const scrollIntoView = vi.fn();
beforeEach(() => {
  chat.actions = { openPanesSideBySide: vi.fn(), revealNode: vi.fn(() => true) };
  chat.projects = { projects: [], activeProject: { id: 'ws' } };
  for (const call of Object.values(apiCalls)) call.mockReset();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('MultiModelWorkCard', () => {
  it('keeps the drawer row attributes and says what runs: approval, rows, Stop all, tokens, footer', async () => {
    const value = run(view(), { approvals: [APPROVAL] });
    const { api } = setup(value);
    const card = screen.getByTestId('background-workflow-row');
    expect(card.dataset.backgroundWorkKey).toBe('row-key');
    expect(card.dataset.runKey).toBe(RUN_KEY);
    expect(card.dataset.active).toBe('true');
    expect(card.textContent).toContain('Multi-model · 3 branches');
    expect(screen.getByTestId('background-workflow-status').textContent).toMatch(/^Running/);
    expect(screen.getByTestId('background-workflow-title').textContent).toBe('Memory extraction timing');
    expect(card.textContent).toContain('Per turn or batched when idle?');

    const approvals = screen.getByTestId('workflow-approvals');
    expect(approvals.textContent).toContain('Needs your approval');
    expect(approvals.textContent).toContain('Codex · GPT-6.1 Sol · Approve Bash?');
    expect(approvals.textContent).toContain('rg -n "extraction" backend/src/services');
    expect(row('t1', 0).textContent).toContain('Needs you');
    expect(row('t1', 0).textContent).toContain('Waiting for your approval, see above');
    expect(row('t2', 0).textContent).toContain('Answering');
    expect(row('t2', 0).textContent).toContain('Estimating credits');
    expect(row('t3', 0).textContent).toContain('Answered');
    expect(row('t3', 0).textContent).toContain('48s');
    expect(row('t3', 0).textContent).toContain('Batch when idle.');

    const steps = screen.getAllByTestId('multi-model-step');
    expect(steps.map((entry) => entry.dataset.stepState)).toEqual(['running', 'idle', 'idle']);
    expect(steps[0].textContent).toContain('Answer separately1/3 done');
    expect(steps[1].textContent).toContain('Review once');
    expect(steps[1].textContent).toContain('Each branch reads the other answers and may revise its conclusion');
    expect(steps[2].textContent).toContain('Written by this chat (Opus 5.5) after reading every answer');

    expect(screen.queryByTestId('multi-model-failed')).toBeNull();
    expect(screen.queryByTestId('multi-model-synthesis')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop all' })).toBeTruthy();
    expect(card.textContent).toContain('38k tokens');
    expect(card.textContent).toContain('Opus 5.5 started · 3 branches · Same permissions as this chat (Ask)');

    await act(async () => { fireEvent.click(within(approvals).getByRole('button', { name: 'Allow once' })); });
    expect(api.answer).toHaveBeenCalledWith('local', 'wfr_1', 't1:x:7', 'allow');
  });

  it('takes the drawer workflow card\'s corners, and its boxes follow them', () => {
    setup(run(view(), { approvals: [APPROVAL] }));
    const card = screen.getByTestId('background-workflow-row');
    expect(card.classList.contains('background-workflow-card')).toBe(true);
    expect(card.style.borderRadius).toBe('var(--term-composer-radius, 0px)');
    expect(screen.getByTestId('workflow-approvals').style.borderRadius).toBe('min(6px, var(--term-composer-radius, 0px))');
  });

  it('opens a running row on its live tail with the caret, and its controls', async () => {
    apiCalls.stopMultiModelThread.mockResolvedValue(run(view()));
    const { api, onClose } = setup(run(view()));
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(rowButton('t2', 0)); });
    expect(rowButton('t2', 0).getAttribute('aria-expanded')).toBe('true');
    // An open row loads the run's full copy (untrimmed excerpts), without expanding the drawer item.
    expect(api.get).toHaveBeenCalledWith('local', 'wfr_1');
    const detail = within(row('t2', 0)).getByTestId('multi-model-row-detail');
    expect(within(detail).getByTestId('multi-model-excerpt').textContent).toContain('At 1.2k tokens per turn');
    expect(within(detail).getByTestId('multi-model-live-caret')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Retry' })).toBeNull();

    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: 'Stop' })); });
    expect(apiCalls.stopMultiModelThread).toHaveBeenCalledWith('local', 'wfr_1', 't2');

    fireEvent.click(within(detail).getByRole('button', { name: 'Open branch →' }));
    expect(chat.actions!.revealNode).toHaveBeenCalledWith('child-t2', { messageId: undefined });
    expect(onClose).toHaveBeenCalledTimes(1);

    // A completed row shows its answer's start, without the caret.
    fireEvent.click(rowButton('t3', 0));
    const answered = within(row('t3', 0)).getByTestId('multi-model-row-detail');
    expect(within(answered).getByTestId('multi-model-excerpt').textContent).toBe('Batching dedupes across turns.');
    expect(within(answered).queryByTestId('multi-model-live-caret')).toBeNull();
    expect(within(answered).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('retries a branch that failed in the current step', async () => {
    apiCalls.retryMultiModelThread.mockResolvedValue(run(view()));
    const answering = view();
    answering.threads[1] = { ...answering.threads[1], steps: [step({ status: 'failed', startedAt: 1_000, endedAt: 101_000, error: 'kiro-cli is not signed in' }), step({ status: 'pending' }, 1)] };
    setup(run(answering));
    const failed = screen.getByTestId('multi-model-failed');
    expect(failed.textContent).toContain('× 1 branch failed');
    expect(failed.textContent).toContain('Kiro · Fable 5.1 · kiro-cli is not signed in');
    expect(row('t2', 0).textContent).toContain('1m 40s');
    await act(async () => { fireEvent.click(within(failed).getByRole('button', { name: 'Retry' })); });
    expect(apiCalls.retryMultiModelThread).toHaveBeenCalledWith('local', 'wfr_1', 't2');
  });

  it("waits with a branch's Retry and Replace model while a stopped run's turns settle, not while it runs", () => {
    const answering = view();
    answering.threads[1] = { ...answering.threads[1], steps: [step({ status: 'failed', startedAt: 1_000, endedAt: 101_000, error: 'kiro-cli is not signed in' }), step({ status: 'pending' }, 1)] };
    const disabled = () => ['Retry', 'Replace model'].map((name) => (within(screen.getByTestId('multi-model-failed')).getByRole('button', { name }) as HTMLButtonElement).disabled);
    const { push } = setup(run({ ...answering, phase: 'cancelled', settling: true }, { revision: 1 }));
    expect(disabled()).toEqual([true, true]);
    push(run({ ...answering, phase: 'running', settling: true }, { revision: 2 }));
    expect(disabled()).toEqual([false, false]);
  });

  it('sums up failures with Replace model, and lists skipped review rows', async () => {
    const dto: ReadyModelsDto = {
      version: 1,
      runtimes: [
        { runtimeId: 'kiro', label: 'Kiro', defaultModelId: 'kiro-model', defaultProviderId: null, models: [{ modelId: 'kiro-model', label: 'Fable 5.1' }, { modelId: 'kiro-2', label: 'Fable 6' }] },
        { runtimeId: 'codex', label: 'Codex', defaultModelId: 'codex-model', defaultProviderId: null, models: [{ modelId: 'codex-model', label: 'GPT-6.1 Sol' }] },
        { runtimeId: 'antigravity', label: 'Antigravity', defaultModelId: null, defaultProviderId: null, models: [] },
      ],
    };
    apiCalls.fetchReadyModels.mockResolvedValue(dto);
    apiCalls.replaceMultiModelThread.mockResolvedValue(run(reviewing()));
    setup(run(reviewing()));

    const failed = screen.getByTestId('multi-model-failed');
    expect(failed.textContent).toContain('× 1 branch failed');
    expect(within(failed).getByRole('button', { name: 'Replace model' })).toBeTruthy();
    // Its review was skipped, which does not count as a step that ran: the failed answer is retried.
    expect(within(failed).getByRole('button', { name: 'Retry' })).toBeTruthy();

    const steps = screen.getAllByTestId('multi-model-step');
    expect(steps.map((entry) => entry.dataset.stepState)).toEqual(['done', 'running', 'idle']);
    expect(steps[1].textContent).toContain('1/2 done');
    expect(row('t2', 1).textContent).toContain('Skipped');
    expect(row('t2', 1).textContent).toContain("Didn't take part: Its answer failed");
    expect(row('t2', 1).textContent).toContain('—');

    // A failed row opens on no excerpt, with its fixes.
    fireEvent.click(rowButton('t2', 0));
    const detail = within(row('t2', 0)).getByTestId('multi-model-row-detail');
    expect(within(detail).queryByTestId('multi-model-excerpt')).toBeNull();
    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: 'Replace model' })); });
    expect(apiCalls.fetchReadyModels).toHaveBeenCalledWith('local', 'ws', expect.any(AbortSignal));
    // WP4's picker, inline under the row's controls.
    const picker = within(detail).getByRole('dialog', { name: 'Replace Kiro · Fable 5.1 · ready models only' });
    expect(within(picker).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['Kiro', 'Codex', 'Antigravity']);
    const options = within(picker).getAllByRole('button');
    expect(options.map((option) => option.textContent)).toEqual([
      'KFable 5.1Current',
      'KFable 6Ready',
      'XGPT-6.1 SolIn the plan',
      'ADefault modelReady',
    ]);
    expect((options[2] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(options[1]); });
    expect(apiCalls.replaceMultiModelThread).toHaveBeenCalledWith('local', 'wfr_1', 't2', { runtimeId: 'kiro', providerId: null, modelId: 'kiro-2' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Keyboard paths, with no pointerdown outside to close the picker first.
  it('forgets a Replace picker its row hid, so Escape is the drawer\'s again', async () => {
    apiCalls.fetchReadyModels.mockResolvedValue({ version: 1, runtimes: [] } satisfies ReadyModelsDto);
    const onMenuOpenChange = vi.fn();
    setup(run(reviewing()), { onMenuOpenChange });
    fireEvent.click(rowButton('t2', 0));
    await act(async () => { fireEvent.click(within(row('t2', 0)).getByRole('button', { name: 'Replace model' })); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true);
    // Enter on the row's header collapses it.
    fireEvent.click(rowButton('t2', 0));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(rowButton('t2', 0));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('forgets a Replace picker under the failure line once that thread is retried', async () => {
    apiCalls.fetchReadyModels.mockResolvedValue({ version: 1, runtimes: [] } satisfies ReadyModelsDto);
    const retried = reviewing();
    retried.threads[1] = { ...retried.threads[1], steps: [step({ status: 'queued' }), step({ status: 'pending' }, 1)] };
    apiCalls.retryMultiModelThread.mockResolvedValue(run(retried, { revision: 2 }));
    const onMenuOpenChange = vi.fn();
    const { push } = setup(run(reviewing()), { onMenuOpenChange });
    const failed = screen.getByTestId('multi-model-failed');
    await act(async () => { fireEvent.click(within(failed).getByRole('button', { name: 'Replace model' })); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { fireEvent.click(within(failed).getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByTestId('multi-model-failed')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
    // It fails again: the line comes back without the picker.
    push(run(reviewing(), { revision: 3 }));
    expect(screen.getByTestId('multi-model-failed')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers a retry when the ready models fail to load, and shows what it loads', async () => {
    apiCalls.fetchReadyModels.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      version: 1,
      runtimes: [{ runtimeId: 'kiro', label: 'Kiro', defaultModelId: 'kiro-2', defaultProviderId: null, models: [{ modelId: 'kiro-2', label: 'Fable 6' }] }],
    } satisfies ReadyModelsDto);
    setup(run(reviewing()));
    await act(async () => { fireEvent.click(within(screen.getByTestId('multi-model-failed')).getByRole('button', { name: 'Replace model' })); });
    const picker = screen.getByRole('dialog', { name: 'Replace Kiro · Fable 5.1 · ready models only' });
    expect(picker.textContent).toContain("Couldn't load the ready models");
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: 'Retry' })); });
    expect(apiCalls.fetchReadyModels).toHaveBeenCalledTimes(2);
    const options = within(screen.getByRole('dialog', { name: 'Replace Kiro · Fable 5.1 · ready models only' })).getAllByRole('button');
    expect(options.map((option) => option.textContent)).toEqual(['KFable 6Ready']);
  });

  it('tells two review rounds apart before they start', () => {
    const twice = view({ reviewRounds: 2 });
    twice.threads = twice.threads.map((entry) => ({ ...entry, steps: [...entry.steps, step({ status: 'pending' }, 2)] }));
    setup(run(twice));
    const steps = screen.getAllByTestId('multi-model-step');
    expect(steps).toHaveLength(4);
    expect(steps[1].textContent).toContain('Reviewround 1 of 2');
    expect(steps[2].textContent).toContain('Reviewround 2 of 2');
  });

  it('shows the synthesis once done, with View in chat, Side by side and no Stop all', () => {
    const { onClose } = setup(run(done(), { endedAt: 402_000 }));
    expect(screen.getByTestId('background-workflow-status').textContent).toBe('Done6m 41s');
    const synthesis = screen.getByTestId('multi-model-synthesis');
    expect(synthesis.textContent).toContain('Synthesis · Opus 5.5');
    expect(synthesis.textContent).toContain('Queue after every turn, run in idle batches.');
    expect(screen.getAllByTestId('multi-model-step')[2].textContent).toContain('✓ Written to the chat');
    expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull();
    expect(screen.getByTestId('background-workflow-row').textContent).toContain('186k tokens');

    fireEvent.click(within(synthesis).getByRole('button', { name: 'View in chat ↗' }));
    expect(chat.actions!.revealNode).toHaveBeenLastCalledWith('caller', { messageId: 'self-caller-mm-syn' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(chat.actions!.openPanesSideBySide).toHaveBeenCalledWith('caller', ['child-t1', 'child-t2', 'child-t3']);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('expands and scrolls to the focused row on mount, and again for each open request', async () => {
    const nextFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    const { rerenderWith } = setup(run(reviewing()), { expanded: true, focus: { threadKey: 't1', step: 1, seq: 1 } });
    expect(rowButton('t1', 1).getAttribute('aria-expanded')).toBe('true');
    expect(rowButton('t1', 0).getAttribute('aria-expanded')).toBe('false');
    await nextFrame();
    expect(scrollIntoView.mock.contexts).toContain(rowButton('t1', 1));

    // The drawer is opened again on another row while the card stays mounted.
    rerenderWith({ expanded: true, focus: { threadKey: 't3', step: 1, seq: 2 } });
    expect(rowButton('t3', 1).getAttribute('aria-expanded')).toBe('true');
    expect(rowButton('t1', 1).getAttribute('aria-expanded')).toBe('false');
    await nextFrame();
    expect(scrollIntoView.mock.contexts).toContain(rowButton('t3', 1));
  });

  it('checks a multi-line command in the branch when the approval has only a title', () => {
    setup(run(view(), { approvals: [{ ...APPROVAL, title: 'cat <<EOF > notes.md\nhello\nEOF', detail: undefined }] }));
    const approval = screen.getByTestId('workflow-approval');
    expect(approval.textContent).toContain('Long request: check it in the branch');
    expect(within(approval).getByRole('button', { name: 'Allow once' }).className).not.toContain('is-warn');
  });

  it('checks a long request in the branch: Allow once is not the primary button', () => {
    const long = { ...APPROVAL, detail: 'x'.repeat(3999) };
    setup(run(view(), { approvals: [long] }));
    const approval = screen.getByTestId('workflow-approval');
    expect(approval.textContent).toContain('Long request: check it in the branch');
    expect(within(approval).getByRole('button', { name: 'Open branch' })).toBeTruthy();
    expect(within(approval).getByRole('button', { name: 'Allow once' }).className).not.toContain('is-warn');
    // The toggle is named by what it does; the request is its description.
    const code = within(approval).getByRole('button', { name: 'Show the full request' });
    expect(code.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(code.getAttribute('aria-describedby')!)?.textContent).toBe('x'.repeat(3999));
    fireEvent.click(code);
    expect(code.getAttribute('aria-expanded')).toBe('true');
    expect(code.getAttribute('aria-label')).toBe('Collapse the request');
  });

  it('renders a row excerpt as Markdown in a short box that fades out where it is clipped', () => {
    const markdown = view();
    markdown.threads[2] = {
      ...markdown.threads[2],
      steps: [step({ status: 'completed', summary: 'Batch when idle.', excerpt: '#### Where we agree\n\n- **Quick start** with `npm run dev`' }), step({ status: 'pending' }, 1)],
    };
    const heights = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(168);
    try {
      setup(run(markdown));
      fireEvent.click(rowButton('t3', 0));
      const excerpt = within(row('t3', 0)).getByTestId('multi-model-excerpt');
      expect(excerpt.textContent).not.toMatch(/####|\*\*|`/);
      expect(within(excerpt).getByRole('heading', { name: 'Where we agree' })).toBeTruthy();
      expect(excerpt.querySelector('strong')?.textContent).toBe('Quick start');
      expect(excerpt.querySelector('code')?.textContent).toBe('npm run dev');
      const body = within(excerpt).getByTestId('multi-model-excerpt-body');
      expect(body.style.maxHeight).toBe('168px');
      expect(body.dataset.clipped).toBe('true');
      expect(body.style.maskImage).toBe('linear-gradient(to bottom, #000 75%, transparent)');
    } finally {
      heights.mockRestore();
      client.mockRestore();
    }
  });

  it('keeps a live tail on its newest lines: a full tail starts at a line, and a short one is not faded', () => {
    const tail = view();
    const full = `${'x'.repeat(40)} cut mid-line\n## Second section\n${'y'.repeat(1_200)}`.slice(0, 1_200);
    tail.threads[1] = { ...tail.threads[1], steps: [step({ status: 'running', startedAt: 1_000, excerpt: full }), step({ status: 'pending' }, 1)] };
    setup(run(tail));
    fireEvent.click(rowButton('t2', 0));
    const excerpt = within(row('t2', 0)).getByTestId('multi-model-excerpt');
    expect(excerpt.textContent).not.toContain('cut mid-line');
    expect(within(excerpt).getByRole('heading', { name: 'Second section' })).toBeTruthy();
    expect(within(excerpt).getByTestId('multi-model-live-caret')).toBeTruthy();
    const body = within(excerpt).getByTestId('multi-model-excerpt-body');
    expect(body.style.justifyContent).toBe('flex-end');
    // jsdom lays nothing out: nothing overflows, so nothing fades.
    expect(body.dataset.clipped).toBeUndefined();
    expect(body.style.maskImage).toBe('');
  });

  it("shows a step's notice under its summary and keeps its status", () => {
    const noticed = view();
    noticed.threads[2] = {
      ...noticed.threads[2],
      steps: [step({ status: 'completed', startedAt: 1_000, endedAt: 49_000, summary: 'The command was denied.', notice: 'The approval waited 5 minutes, so Codex denied it.' }), step({ status: 'pending' }, 1)],
    };
    setup(run(noticed));
    const button = rowButton('t3', 0);
    const notice = within(button).getByTestId('multi-model-notice');
    expect(notice.textContent).toBe('The approval waited 5 minutes, so Codex denied it.');
    expect(notice.style.color).toBe('var(--term-select)');
    expect(row('t3', 0).dataset.status).toBe('completed');
    expect(button.textContent).toContain('Answered');
    expect(button.getAttribute('aria-label')).toBe('Pi · Gemini 4 Argon, Answered: The command was denied. The approval waited 5 minutes, so Codex denied it.');
    expect(within(rowButton('t1', 0)).queryByTestId('multi-model-notice')).toBeNull();
  });

  it('stops a queued row too', async () => {
    apiCalls.stopMultiModelThread.mockResolvedValue(run(view()));
    const queued = view();
    queued.threads[1] = { ...queued.threads[1], steps: [step({ status: 'queued' }), step({ status: 'pending' }, 1)] };
    setup(run(queued));
    fireEvent.click(rowButton('t2', 0));
    await act(async () => { fireEvent.click(within(row('t2', 0)).getByRole('button', { name: 'Stop' })); });
    expect(apiCalls.stopMultiModelThread).toHaveBeenCalledWith('local', 'wfr_1', 't2');
  });

  it('retries an interrupted run beside what it says, and holds it while turns settle', async () => {
    apiCalls.retryMultiModelRun.mockResolvedValue(run(view()));
    const detail = 'Interrupted: Michi restarted while this ran. Retry continues it.';
    const interrupted = { ...reviewing(), phase: 'interrupted' as const };
    interrupted.threads[0] = { ...interrupted.threads[0], steps: [interrupted.threads[0].steps[0], step({ status: 'interrupted', excerpt: undefined }, 1)] };
    const { push } = setup(run(interrupted, { statusDetail: detail }));
    const status = screen.getByTestId('multi-model-status');
    expect(status.textContent).toBe(`${detail}Retry`);
    // The failure line keeps the row's own fixes: run Retry is the status line's.
    expect(within(screen.getByTestId('multi-model-failed')).queryByRole('button', { name: 'Retry failed' })).toBeNull();
    await act(async () => { fireEvent.click(within(status).getByRole('button', { name: 'Retry' })); });
    expect(apiCalls.retryMultiModelRun).toHaveBeenCalledWith('local', 'wfr_1');
    push(run({ ...interrupted, settling: true }, { statusDetail: detail, revision: 5 }));
    expect((within(screen.getByTestId('multi-model-status')).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('retries a run stopped while it wrote the synthesis, and says the synthesis was stopped', async () => {
    apiCalls.retryMultiModelRun.mockResolvedValue(run(view()));
    const stopped = { ...done(), phase: 'cancelled' as const, synthesis: { status: 'cancelled' as const } };
    setup(run(stopped, { statusDetail: 'Synthesis stopped' }));
    expect(screen.queryByTestId('multi-model-synthesis')).toBeNull();
    const steps = screen.getAllByTestId('multi-model-step');
    expect(steps[2].dataset.stepState).toBe('stopped');
    expect(steps[2].textContent).toBe('■SynthesisStopped while writing the synthesis');
    await act(async () => { fireEvent.click(within(screen.getByTestId('multi-model-status')).getByRole('button', { name: 'Retry' })); });
    expect(apiCalls.retryMultiModelRun).toHaveBeenCalledWith('local', 'wfr_1');
  });

  it('retries every failed branch of a finished run from the failure line', async () => {
    apiCalls.retryMultiModelRun.mockResolvedValue(run(done()));
    const twoFailed = done();
    twoFailed.threads[0] = { ...twoFailed.threads[0], steps: [step({ status: 'failed', error: 'quota' }), step({ status: 'skipped' }, 1)] };
    setup(run(twoFailed, { endedAt: 402_000 }));
    const failed = screen.getByTestId('multi-model-failed');
    expect(failed.textContent).toBe('× 2 branches failedCodex, KiroRetry failed');
    await act(async () => { fireEvent.click(within(failed).getByRole('button', { name: 'Retry failed' })); });
    expect(apiCalls.retryMultiModelRun).toHaveBeenCalledWith('local', 'wfr_1');
    expect(apiCalls.retryMultiModelThread).not.toHaveBeenCalled();
    expect(screen.queryByTestId('multi-model-status')).toBeNull();
  });

  it('keeps the synthesis in view through late work, then says what the addendum added', async () => {
    const lateRow = (status: 'running' | 'completed') => ({
      ...reviewing().threads[1], late: true as const,
      steps: [step({ status, startedAt: 500_000, summary: 'Late answer.' }), step({ status: 'skipped', error: 'Replaced after this round started' }, 1)],
    });
    const lateWork = { ...done(), phase: 'running' as const };
    lateWork.threads = lateWork.threads.map((entry) => (entry.key === 't2' ? lateRow('running') : entry));
    const { push, onClose } = setup(run(lateWork));
    expect(screen.getByTestId('background-workflow-status').textContent).toMatch(/^Adding 1 late answer/);
    expect(screen.getByTestId('multi-model-synthesis').textContent).toContain('Queue after every turn, run in idle batches.');
    expect(within(screen.getByTestId('multi-model-synthesis')).getByRole('button', { name: 'View in chat ↗' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop all' })).toBeTruthy();

    const added = { ...done(), lastMessageId: 'self-caller-mm-add', synthesis: { ...done().synthesis, addenda: 1, lastAddendumStatus: 'completed' as const } };
    added.threads = added.threads.map((entry) => (entry.key === 't2' ? lateRow('completed') : entry));
    push(run(added, { revision: 4, endedAt: 600_000 }));
    const addendum = screen.getByTestId('multi-model-addendum');
    expect(addendum.textContent).toBe('✓ Added 1 late answer to the synthesisView ↗');
    fireEvent.click(within(addendum).getByRole('button', { name: 'View ↗' }));
    expect(chat.actions!.revealNode).toHaveBeenLastCalledWith('caller', { messageId: 'self-caller-mm-add' });
    expect(onClose).toHaveBeenCalledTimes(1);

    push(run({ ...added, synthesis: { ...added.synthesis, lastAddendumStatus: 'failed' } }, { revision: 5, statusDetail: "Couldn't add the late answers: boom" }));
    apiCalls.retryMultiModelRun.mockResolvedValue(run(added));
    const failedAddendum = screen.getByTestId('multi-model-addendum');
    expect(failedAddendum.textContent).toBe("Couldn't add 1 late answerRetry");
    await act(async () => { fireEvent.click(within(failedAddendum).getByRole('button', { name: 'Retry' })); });
    expect(apiCalls.retryMultiModelRun).toHaveBeenCalledWith('local', 'wfr_1');
  });

  it("labels a review row's text when it is the branch's earlier answer", () => {
    // Codex's review has streamed nothing yet: its row shows its answer, and says so.
    const pending = reviewing();
    pending.threads[0] = { ...pending.threads[0], steps: [step({ status: 'completed', excerpt: 'Write a cursor per turn.' }), step({ status: 'running', startedAt: 1_000 }, 1)] };
    setup(run(pending));
    fireEvent.click(rowButton('t1', 1));
    const detail = within(row('t1', 1)).getByTestId('multi-model-row-detail');
    expect(within(detail).getByTestId('multi-model-excerpt-from').textContent).toBe('Its answer from step 1');
    expect(within(detail).getByTestId('multi-model-excerpt').textContent).toContain('Write a cursor per turn.');
    expect(within(detail).queryByTestId('multi-model-live-caret')).toBeNull();
    // Pi's revision is its own text: no label.
    fireEvent.click(rowButton('t3', 1));
    expect(within(within(row('t3', 1)).getByTestId('multi-model-row-detail')).queryByTestId('multi-model-excerpt-from')).toBeNull();
  });

  it('hides pane controls outside ChatProvider', () => {
    chat.actions = null;
    chat.projects = null;
    setup(run(done()));
    fireEvent.click(rowButton('t1', 0));
    expect(screen.queryByRole('button', { name: 'Open branch →' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Side by side' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View in chat ↗' })).toBeNull();
  });
});
