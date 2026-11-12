import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MultiModelRunView,
  MultiModelStepStatus,
  MultiModelStepView,
  MultiModelThreadView,
  ReadyModelsDto,
  WorkflowApprovalDto,
  WorkflowRunDtoV1,
} from 'michi-shared';
import { WorkflowDomainProvider, type WorkflowDomainApi } from '../../../state/workflowDomain';
import { backendApiBase } from '../../../config/backendConnections';
import { MultiModelRunCard } from './MultiModelRunCard';

const chat = vi.hoisted(() => ({
  actions: null as null | { openPanesSideBySide: ReturnType<typeof vi.fn> },
  nodes: {} as Record<string, { projectId: string; permissionMode?: 'ask' | 'trust' | 'yolo'; permissionApproveForMe?: boolean }>,
}));
vi.mock('../../../state/chatStore', () => ({
  useOptionalChatActions: () => chat.actions,
  useChatNode: (nodeId: string) => chat.nodes[nodeId],
}));
/** Settings › Permissions on the local backend. */
const prefs = vi.hoisted(() => ({ globalPermissions: false, permissionMode: 'ask' as 'ask' | 'trust' | 'yolo', permissionApproveForMe: false }));
vi.mock('../../../state/prefs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../state/prefs')>(),
  usePrefs: () => ({ prefs, setPermissionSettings: vi.fn() }),
}));

const NOW = Date.parse('2026-11-08T11:42:00');
const identity = { backendConnectionId: 'local', id: 'wfr_1' };

function steps(statuses: MultiModelStepStatus[], patch: Array<Partial<MultiModelStepView>> = []): MultiModelStepView[] {
  return statuses.map((status, round) => ({ kind: round === 0 ? 'answer' : 'review', round, status, ...patch[round] }));
}

function thread(key: string, runtimeId: string, runtimeLabel: string, modelLabel: string, patch: Partial<MultiModelThreadView> = {}): MultiModelThreadView {
  return {
    key, runtimeId, providerId: null, modelId: modelLabel.toLowerCase(), reasoning: null, runtimeLabel, modelLabel,
    context: 'fork', promptPreview: `Prompt for ${runtimeLabel}`, childNodeId: null, steps: [], ...patch,
  };
}

const sol = (patch: Partial<MultiModelThreadView> = {}) => thread('t1', 'codex', 'Codex', 'GPT-6.1 Sol', { modelId: 'sol', ...patch });
const fable = (patch: Partial<MultiModelThreadView> = {}) => thread('t2', 'kiro', 'Kiro', 'Fable 5.1', { modelId: 'fable', ...patch });
const argon = (patch: Partial<MultiModelThreadView> = {}) => thread('t3', 'pi', 'Pi', 'Gemini 4 Argon', { providerId: 'google', modelId: 'argon', context: 'fresh', ...patch });

function view(patch: Partial<MultiModelRunView> = {}): MultiModelRunView {
  return {
    version: 1, phase: 'proposed', title: 'Memory extraction timing', askPreview: 'Per turn or idle batch?',
    callerNodeId: 'caller', callerMessageId: 'msg-1', callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code',
    callerModelLabel: 'Opus 5.5', permissionMode: 'ask', reviewRounds: 1,
    threads: [sol(), fable(), argon()], synthesis: { status: 'pending' }, ...patch,
  };
}

function run(multiModel: MultiModelRunView, patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws', nodeId: 'caller', parentToolCallId: null,
    name: multiModel.title, status: multiModel.phase === 'proposed' ? 'paused' : 'running', nodes: [], log: [], actions: [],
    startedAt: NOW - 72_000, updatedAt: NOW, revision: 3, multiModel, ...patch,
  };
}

const running = (patch: Partial<MultiModelRunView> = {}) => view({
  phase: 'running', startedAt: NOW - 72_000,
  threads: [
    sol({ childNodeId: 'c1', steps: steps(['waiting', 'pending'], [{ startedAt: NOW - 72_000 }]) }),
    fable({ childNodeId: 'c2', steps: steps(['running', 'pending'], [{ startedAt: NOW - 72_000, now: 'Streaming · estimating credits' }]) }),
    argon({ childNodeId: 'c3', steps: steps(['completed', 'pending'], [{ startedAt: NOW - 72_000, endedAt: NOW - 24_000, summary: 'Idle batching: dedupe and save tokens.' }]) }),
  ],
  ...patch,
});

const approval = (patch: Partial<WorkflowApprovalDto> = {}): WorkflowApprovalDto => ({
  id: 't1:turn:7', nodeId: 't1@0', title: 'Approve Bash?', detail: 'rg -n "extraction" backend/src/services',
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  requestedAt: NOW, ...patch,
});

const READY: ReadyModelsDto = {
  version: 1,
  runtimes: [
    { runtimeId: 'codex', label: 'Codex', defaultModelId: 'sol', defaultProviderId: null, models: [{ modelId: 'sol', label: 'GPT-6.1 Sol' }, { modelId: 'astra', label: 'GPT-6 Astra' }] },
    { runtimeId: 'kiro', label: 'Kiro', defaultModelId: 'fable', defaultProviderId: null, models: [{ modelId: 'fable', label: 'Fable 5.1' }, { modelId: 'kopus', label: 'Opus 5.5' }] },
    { runtimeId: 'pi', label: 'Pi', defaultModelId: null, defaultProviderId: 'google', models: [], providers: [{ providerId: 'google', label: 'Google', models: [{ modelId: 'argon', label: 'Gemini 4 Argon' }] }] },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
function api(): WorkflowDomainApi {
  return {
    get: vi.fn(), act: vi.fn(), subscribe: vi.fn(() => () => {}),
    answer: vi.fn(async () => run(running())),
  };
}

function renderCard(value: WorkflowRunDtoV1, props: Partial<React.ComponentProps<typeof MultiModelRunCard>> = {}, domainApi = api()) {
  const utils = render(
    <WorkflowDomainProvider api={domainApi}>
      <MultiModelRunCard run={value} identity={identity} {...props} />
    </WorkflowDomainProvider>,
  );
  return { ...utils, api: domainApi, card: screen.getByTestId('multi-model-card') };
}

const base = `${backendApiBase('local')}/multi-model-runs/wfr_1`;
const calls = () => fetchMock.mock.calls.map(([url, init]) => [url as string, (init as RequestInit | undefined)?.method ?? 'GET', (init as RequestInit | undefined)?.body]);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  chat.actions = { openPanesSideBySide: vi.fn() };
  chat.nodes = {};
  Object.assign(prefs, { globalPermissions: false, permissionMode: 'ask', permissionApproveForMe: false });
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/ready-models') ? READY : { run: run(view()) })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MultiModelRunCard: the plan', () => {
  it('lists each row with its model, Fork/Fresh tag and a prompt that opens on click', () => {
    const { card } = renderCard(run(view()));
    expect(card.textContent).toContain('Multi-model plan');
    expect(card.textContent).toContain('Needs you');
    expect(card.textContent).toContain('3 branches start together');
    const rows = within(card).getAllByTestId('mm-plan-row');
    expect(rows.map((row) => row.querySelector('.who')?.textContent)).toEqual(['Codex · GPT-6.1 Sol', 'Kiro · Fable 5.1', 'Pi · Gemini 4 Argon']);
    expect(within(rows[0]).getByRole('button', { name: 'Fork' }).getAttribute('title')).toBe("Fork: inherits this conversation's history");
    expect(within(rows[2]).getByRole('button', { name: 'Fresh' }).getAttribute('title')).toBe('Fresh: only the prompt the agent wrote');
    const prompt = within(rows[0]).getByRole('button', { name: 'Prompt for Codex' });
    expect(prompt.getAttribute('title')).toBe('Click to show all');
    fireEvent.click(prompt);
    expect(prompt.className).toContain('open');
    expect(prompt.getAttribute('title')).toBe('Click to collapse');
    expect(card.textContent).toContain('Review once');
    expect(card.textContent).toContain('Written by this chat (Opus 5.5) after reading every answer');
    expect(card.textContent).toContain('Same permissions as this chat (Ask) · Asks you before leaving the plan');
  });

  it('shows the chat\'s current permission mode while proposed', () => {
    chat.nodes.caller = { projectId: 'ws', permissionMode: 'ask', permissionApproveForMe: true };
    const { card } = renderCard(run(view({ permissionMode: 'yolo' })));
    expect(card.querySelector('.meta2')?.textContent).toBe('Same permissions as this chat (Ask · Approve for me) · Asks you before leaving the plan');
  });

  it.each([
    [{ permissionMode: 'trust' as const }, 'Trust'],
    [{ permissionMode: 'yolo' as const }, 'YOLO'],
    [{ permissionMode: 'ask' as const, permissionApproveForMe: true }, 'Ask · Approve for me'],
  ])('says the global permission %o every branch inherits, not the chat\'s own', (global, text) => {
    Object.assign(prefs, { globalPermissions: true, ...global });
    chat.nodes.caller = { projectId: 'ws', permissionMode: 'ask' };
    const { card } = renderCard(run(view({ permissionMode: 'ask' })));
    expect(card.querySelector('.meta2')?.textContent).toBe(`Same permissions as this chat (${text}) · Asks you before leaving the plan`);
  });

  it('removes a row through the plan edit, and a removed row offers Undo', async () => {
    const { card } = renderCard(run(view()));
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Kiro · Fable 5.1' }));
    await waitFor(() => expect(calls()).toEqual([[`${base}/plan`, 'PATCH', JSON.stringify({ op: 'remove', key: 't2' })]]));
  });

  it('strikes a removed row with Undo and counts only live rows on Start', async () => {
    const { card } = renderCard(run(view({ threads: [sol(), fable({ removed: true }), argon()] })));
    const removed = within(card).getAllByTestId('mm-plan-row')[1];
    expect(removed.className).toContain('removed');
    expect(within(removed).queryByRole('button', { name: 'Fork' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Start 2 branches' })).toBeTruthy();
    fireEvent.click(within(removed).getByRole('button', { name: 'Undo removing Kiro · Fable 5.1' }));
    await waitFor(() => expect(calls()[0]).toEqual([`${base}/plan`, 'PATCH', JSON.stringify({ op: 'restore', key: 't2' })]));
  });

  it('disables Start without a live row and Add model at five live rows', () => {
    const { card, unmount } = renderCard(run(view({ threads: [sol({ removed: true })] })));
    const start = within(card).getByRole('button', { name: 'Start 0 branches' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe('Add a model first');
    unmount();
    const five = ['t1', 't2', 't3', 't4', 't5'].map((key, i) => thread(key, 'codex', 'Codex', `Model ${i}`));
    const full = renderCard(run(view({ threads: five })));
    expect((within(full.card).getByRole('button', { name: '＋ Add model' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('replaces a model from the ready list, where another row\'s model is not offered', async () => {
    const { card } = renderCard(run(view()));
    fireEvent.click(within(card).getByRole('button', { name: 'Replace Kiro · Fable 5.1' }));
    const picker = await within(card).findByRole('dialog', { name: 'Replace Kiro · Fable 5.1 · ready models only' });
    await waitFor(() => expect(within(picker).getByRole('button', { name: /GPT-6\.1 Sol/ })).toBeTruthy());
    const solOption = within(picker).getByRole('button', { name: /GPT-6\.1 Sol/ }) as HTMLButtonElement;
    expect(solOption.textContent).toContain('In the plan');
    expect(solOption.disabled).toBe(true);
    expect(within(picker).getByRole('button', { name: /Fable 5\.1/ }).textContent).toContain('Current');
    expect(within(picker).getByRole('group', { name: 'Pi · Google' })).toBeTruthy();
    fireEvent.click(within(picker).getByRole('button', { name: /Opus 5\.5/ }));
    await waitFor(() => expect(calls().at(-1)).toEqual([
      `${base}/plan`, 'PATCH', JSON.stringify({ op: 'replace', key: 't2', pick: { runtimeId: 'kiro', providerId: null, modelId: 'kopus' } }),
    ]));
    expect(calls()[0][0]).toBe(`${backendApiBase('local')}/multi-model/ready-models?workspaceId=ws`);
    expect(within(card).queryByRole('dialog')).toBeNull();
  });

  it('adds a model, and Start and Cancel post to the run', async () => {
    const { card } = renderCard(run(view()));
    fireEvent.click(within(card).getByRole('button', { name: '＋ Add model' }));
    const picker = await within(card).findByRole('dialog', { name: 'Add a model · ready models only' });
    await waitFor(() => expect(within(picker).getByRole('button', { name: /GPT-6 Astra/ })).toBeTruthy());
    fireEvent.click(within(picker).getByRole('button', { name: /GPT-6 Astra/ }));
    await waitFor(() => expect(calls().at(-1)?.[2]).toBe(JSON.stringify({ op: 'add', pick: { runtimeId: 'codex', providerId: null, modelId: 'astra' } })));
    fireEvent.click(within(card).getByRole('button', { name: 'Start 3 branches' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/start`, 'POST']));
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/cancel`, 'POST']));
  });

  it('gives the focus back to the row after a pick, and Escape back to the toggle; Escape in another pane stays there', async () => {
    const elsewhere = document.body.appendChild(document.createElement('textarea'));
    try {
      const { card } = renderCard(run(view()));
      const toggle = within(card).getByRole('button', { name: 'Replace Kiro · Fable 5.1' });
      toggle.focus();
      fireEvent.click(toggle);
      const picker = await within(card).findByRole('dialog');
      await waitFor(() => expect(picker.contains(document.activeElement)).toBe(true));
      elsewhere.focus();
      fireEvent.keyDown(elsewhere, { key: 'Escape' });
      expect(within(card).getByRole('dialog')).toBe(picker);
      within(picker).getByRole('button', { name: /Fable 5\.1/ }).focus();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(within(card).queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(toggle);
      // A pick disables ⇄ while the edit is sent: the focus stays in the row.
      fireEvent.click(toggle);
      const reopened = await within(card).findByRole('dialog');
      await waitFor(() => expect(reopened.contains(document.activeElement)).toBe(true));
      fireEvent.click(within(reopened).getByRole('button', { name: /Opus 5\.5/ }));
      expect(within(card).queryByRole('dialog')).toBeNull();
      expect(within(card).getAllByTestId('mm-plan-row')[1].contains(document.activeElement)).toBe(true);
    } finally {
      elsewhere.remove();
    }
  });

  it('keeps rows looking the same under a hover (touch) and explains Fork on a tap', () => {
    const { card } = renderCard(run(view()));
    const row = within(card).getAllByTestId('mm-plan-row')[0];
    const before = row.outerHTML;
    fireEvent.mouseEnter(row);
    fireEvent.mouseOver(row);
    expect(row.outerHTML).toBe(before);
    fireEvent.click(within(row).getByRole('button', { name: 'Fork' }));
    expect(row.textContent).toContain("Fork: inherits this conversation's history");
  });

  it('read-only: no controls', () => {
    const { card } = renderCard(run(view()), { readOnly: true });
    for (const name of [/^Start/, /^Replace/, /^Remove/, 'Cancel', '＋ Add model']) {
      expect(within(card).queryByRole('button', { name })).toBeNull();
    }
    expect(within(card).getAllByTestId('mm-plan-row')).toHaveLength(3);
  });
});

describe('MultiModelRunCard: progress', () => {
  it('opens only the current step, ticks the chip and lists each row\'s state', () => {
    const onOpenDrawer = vi.fn();
    const { card } = renderCard(run(running(), { approvals: [approval()] }), { onOpenDrawer });
    expect(screen.getByTestId('mm-started').textContent).toBe('Started the plan · 3 branches · 11:40');
    expect(screen.getByTestId('mm-chip').textContent).toBe('Running1m 12s');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId('mm-chip').textContent).toBe('Running1m 13s');
    // Running breathes like every running dot, and stops with it under reduced motion.
    expect(screen.getByTestId('mm-chip').querySelector('.dot')?.classList.contains('term-dot-i--run')).toBe(true);
    expect([...card.querySelectorAll('.step > .n')].map((n) => `${n.className}:${n.textContent}`)).toEqual(['n run:1', 'n idle:2', 'n idle:3']);
    const rows = within(card).getAllByTestId('mm-row');
    // The head line is the row's drawer button; the line and the controls sit outside it.
    expect(rows.map((row) => row.querySelector('button.r1')?.getAttribute('aria-label'))).toEqual(['Codex · GPT-6.1 Sol, Needs you', 'Kiro · Fable 5.1, Answering', 'Pi · Gemini 4 Argon, Answered']);
    expect(rows.map((row) => [row.getAttribute('role'), row.querySelector('button.r1 button, button.r1 [role="button"]')])).toEqual([[null, null], [null, null], [null, null]]);
    fireEvent.click(rows[0].querySelector('button.r1')!);
    expect(onOpenDrawer).toHaveBeenLastCalledWith({ threadKey: 't1', step: 0 });
    expect(rows[1].textContent).toContain('❯ Streaming · estimating credits');
    expect(rows[2].textContent).toContain('Idle batching: dedupe and save tokens.');
    expect(rows[2].querySelector('.t')?.textContent).toBe('48s');
    // The review has not started: the rows that will review it.
    expect(card.textContent).toContain('Each branch reads the other answers and may revise its conclusion');
    expect(card.querySelector('.foot2')?.textContent).toBe('Same permissions as this chat (Ask) · 3 branchesStop all Side by side');
  });

  it('opens the drawer on a row, or on the run from the card\'s background', () => {
    const onOpenDrawer = vi.fn();
    const { card } = renderCard(run(running()), { onOpenDrawer });
    fireEvent.click(within(card).getAllByTestId('mm-row')[1]);
    expect(onOpenDrawer).toHaveBeenLastCalledWith({ threadKey: 't2', step: 0 });
    fireEvent.click(card.querySelector('.title')!);
    expect(onOpenDrawer).toHaveBeenLastCalledWith();
    fireEvent.click(within(card).getByRole('button', { name: /Side by side/ }));
    expect(onOpenDrawer).toHaveBeenCalledTimes(2);
  });

  // MessageBlock's TAP_CONTROL: a tap whose hover revealed the message's
  // actions would be dropped by WebKit, so the drawer opened on the second tap.
  it('marks the card a tap target, so a tap anywhere on it opens the drawer, not the message actions', () => {
    const onOpenDrawer = vi.fn();
    const { card, unmount } = renderCard(run(view({
      phase: 'running', startedAt: NOW - 200_000,
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'running'], [{ summary: 'Enqueue each turn.' }, { now: 'Reading Pi' }]) }),
        argon({ childNodeId: 'c3', steps: steps(['completed', 'completed'], [{ summary: 'Batch when idle.' }, { summary: 'Accepts the queue.' }]) }),
      ],
    })), { onOpenDrawer });
    expect(card.getAttribute('data-tap-target')).toBe('true');
    // The workflow card's shell: its press tint and hover lift.
    expect(card.className).toContain('workflow-run-card--opens');
    const summary = card.querySelector('.steps > .step .sd')!;
    const rowLine = within(card).getAllByTestId('mm-row')[0].querySelector('.line')!;
    for (const target of [summary, rowLine, card.querySelector('.title')!]) {
      expect(target.closest('[data-tap-target]')).toBe(card);
    }
    fireEvent.click(summary);
    expect(onOpenDrawer).toHaveBeenLastCalledWith();
    fireEvent.click(rowLine);
    expect(onOpenDrawer).toHaveBeenLastCalledWith({ threadKey: 't1', step: 1 });
    unmount();
    // Nothing to open: a tap on the text reveals the actions as on any message.
    const inert = renderCard(run(running())).card;
    expect(inert.hasAttribute('data-tap-target')).toBe(false);
    expect(inert.className).not.toContain('workflow-run-card--opens');
  });

  it('does not open the drawer when a click ends a text selection on a row or the card', () => {
    const onOpenDrawer = vi.fn();
    const { card } = renderCard(run(view({
      phase: 'running', startedAt: NOW - 200_000,
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'running'], [{ summary: 'Enqueue each turn.' }, { now: 'Reading Pi' }]) }),
        argon({ childNodeId: 'c3', steps: steps(['completed', 'completed'], [{ summary: 'Batch when idle.' }, { summary: 'Accepts the queue.' }]) }),
      ],
    })), { onOpenDrawer });
    const rowLine = within(card).getAllByTestId('mm-row')[0].querySelector('.line')!;
    for (const target of [rowLine, card.querySelector('.title')!]) {
      window.getSelection()!.selectAllChildren(target);
      try {
        fireEvent.click(target);
      } finally {
        window.getSelection()!.removeAllRanges();
      }
    }
    expect(onOpenDrawer).not.toHaveBeenCalled();
    fireEvent.click(rowLine);
    expect(onOpenDrawer).toHaveBeenLastCalledWith({ threadKey: 't1', step: 1 });
  });

  it('collapses a done step to its summary and expands it on a click', () => {
    const { card } = renderCard(run(view({
      phase: 'running', startedAt: NOW - 200_000,
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'running'], [{ summary: 'Enqueue each turn.' }, { now: 'Reading Pi' }]) }),
        fable({ childNodeId: 'c2', steps: steps(['failed', 'skipped'], [{ error: 'kiro-cli is not signed in' }, { error: 'Failed in step 1' }]) }),
        argon({ childNodeId: 'c3', steps: steps(['completed', 'completed'], [{ summary: 'Batch when idle.' }, { summary: 'Accepts the queue.' }]) }),
      ],
    })));
    const [answer, review] = [...card.querySelectorAll('.steps > .step')];
    expect(answer.querySelector('.sd')?.textContent).toBe('3 branches · 2 answered · Kiro failed');
    expect(answer.querySelector('.c-fail')?.textContent).toBe('Kiro failed');
    expect(within(review as HTMLElement).getByRole('button', { name: /Review once/ }).textContent).toContain('1/2 done');
    expect(within(review as HTMLElement).getAllByTestId('mm-row')).toHaveLength(3);
    // The skipped row says why, and offers what its failed answer offers.
    const skipped = within(review as HTMLElement).getAllByTestId('mm-row')[1];
    expect(skipped.querySelector('.line')?.textContent).toBe("Didn't take part: Failed in step 1 · Retry · Replace model");
    fireEvent.click(within(answer as HTMLElement).getByRole('button', { name: /Answer separately/ }));
    expect(within(answer as HTMLElement).getAllByTestId('mm-row')).toHaveLength(3);
    expect(within(answer as HTMLElement).getAllByTestId('mm-row')[1].querySelector('.line.err')?.textContent).toBe('kiro-cli is not signed in · Retry · Replace model');
  });

  it('retries a failed answer whose review was skipped, from the answer step a done run opens', async () => {
    const { card } = renderCard(run(view({
      phase: 'completed', startedAt: NOW - 200_000,
      synthesis: { status: 'completed' },
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'skipped'], [{ summary: 'Enqueue each turn.' }, { error: 'Only one answer, nothing to review' }]) }),
        fable({ childNodeId: 'c2', steps: steps(['failed', 'skipped'], [{ error: 'session expired' }, { error: 'Failed in step 1' }]) }),
      ],
    })));
    const [answer] = [...card.querySelectorAll('.steps > .step')];
    const [answered, failed] = within(answer as HTMLElement).getAllByTestId('mm-row');
    expect(within(answered).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(failed.querySelector('.line.err')?.textContent).toBe('session expired · Retry · Replace model');
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/threads/t2/retry`, 'POST']));
  });

  it('offers Retry · Replace model on a failed row and retries it', async () => {
    const { card } = renderCard(run(view({
      phase: 'running', startedAt: NOW - 90_000,
      threads: [sol({ steps: steps(['running', 'pending']) }), fable({ steps: steps(['failed', 'pending'], [{ error: 'session expired' }]) })],
    })));
    const row = within(card).getAllByTestId('mm-row')[1];
    expect(row.querySelector('.line.err')?.textContent).toBe('session expired · Retry · Replace model');
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/threads/t2/retry`, 'POST']));
  });

  it('answers a row\'s approval through the run; it attaches to its own row only', async () => {
    const domainApi = api();
    const { card } = renderCard(run(running(), { approvals: [approval()] }), {}, domainApi);
    const rows = within(card).getAllByTestId('mm-row');
    expect(within(rows[1]).queryByTestId('mm-approval')).toBeNull();
    const line = within(rows[0]).getByRole('group', { name: 'Approval needed: Approve Bash?' });
    expect(line.querySelector('.ak')?.textContent).toBe('Run');
    expect(within(line).getByRole('button', { name: 'Allow once' }).className).toBe('qbtn warn');
    fireEvent.click(within(line).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(domainApi.answer).toHaveBeenCalledWith('local', 'wfr_1', 't1:turn:7', 'allow'));
  });

  it('shows the title of an approval without detail (Kiro, Pi), in mono after its kind word', () => {
    const waiting = running({
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['waiting', 'pending'], [{ startedAt: NOW - 72_000 }]) }),
        fable({ childNodeId: 'c2', steps: steps(['waiting', 'pending'], [{ startedAt: NOW - 72_000 }]) }),
        argon({ childNodeId: 'c3', steps: steps(['waiting', 'pending'], [{ startedAt: NOW - 72_000 }]) }),
      ],
    });
    const approvals = [
      approval({ id: 't1:turn:1', nodeId: 't1@0', title: '@michi/set_branch_overview', detail: undefined }),
      approval({ id: 't2:turn:2', nodeId: 't2@0', title: 'wc -l README.md', detail: undefined }),
      approval({ id: 't3:turn:3', nodeId: 't3@0', title: 'Run: wc -l README.md', detail: undefined }),
    ];
    const { card } = renderCard(run(waiting, { approvals }));
    const lines = within(card).getAllByTestId('mm-approval');
    expect(lines.map((line) => [line.querySelector('.ak')?.textContent, line.querySelector('code')?.textContent])).toEqual([
      ['Allow', '@michi/set_branch_overview'],
      ['Run', 'wc -l README.md'],
      ['Run', 'wc -l README.md'],
    ]);
    expect(within(lines[2]).getByRole('button', { name: 'Allow once' }).className).toBe('qbtn warn');
    expect(lines[2].getAttribute('aria-label')).toBe('Approval needed: Run: wc -l README.md');
  });

  it("shows a step's notice under its summary and keeps its status", () => {
    const noticed = running({
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'pending'], [{ startedAt: NOW - 72_000, endedAt: NOW - 1_000, summary: 'The command was denied.', notice: 'The approval waited 5 minutes, so Codex denied it.' }]) }),
        fable({ childNodeId: 'c2', steps: steps(['running', 'pending'], [{ startedAt: NOW - 72_000 }]) }),
      ],
    });
    const { card } = renderCard(run(noticed));
    const [first, second] = within(card).getAllByTestId('mm-row');
    const lines = Array.from(first.querySelectorAll('.line')).map((line) => [line.className, line.textContent]);
    expect(lines).toEqual([['line', 'The command was denied.'], ['line notice', 'The approval waited 5 minutes, so Codex denied it.']]);
    expect(first.querySelector('.st')?.textContent).toContain('Answered');
    expect(second.querySelector('.line.notice')).toBeNull();
  });

  it('a clamped request expands, points to the branch and keeps Allow once secondary', () => {
    const detail = 'x'.repeat(3_999);
    const { card } = renderCard(run(running(), { approvals: [approval({ title: 'Approve Write?', detail })] }));
    const line = within(card).getByRole('group', { name: 'Approval needed: Approve Write?' });
    expect(line.querySelector('.ak')?.textContent).toBe('Edit');
    expect(within(line).getByRole('button', { name: 'Allow once' }).className).toBe('qbtn');
    expect(line.textContent).toContain('Long request: check it in the branch');
    const code = within(line).getByRole('button', { name: detail });
    fireEvent.click(code);
    expect(code.className).toBe('open');
    fireEvent.click(within(line).getByRole('button', { name: 'Open branch' }));
    expect(chat.actions!.openPanesSideBySide).toHaveBeenCalledWith('caller', ['c1'], { focusNodeId: 'c1' });
  });

  it('opens the chat and its branches side by side', () => {
    const { card } = renderCard(run(running()));
    fireEvent.click(within(card).getByRole('button', { name: /Side by side/ }));
    expect(chat.actions!.openPanesSideBySide).toHaveBeenCalledWith('caller', ['c1', 'c2', 'c3']);
  });

  it('renders outside a chat provider, without Side by side or Open branch', () => {
    chat.actions = null;
    const { card } = renderCard(run(running(), { approvals: [approval()] }));
    expect(within(card).getAllByTestId('mm-row')).toHaveLength(3);
    expect(within(card).queryByRole('button', { name: /Side by side/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Open branch' })).toBeNull();
  });

  // A Scheduled-only transcript (TPane readOnly): its approvals stay answerable, as a workflow's do.
  it('read-only: rows, Side by side and the approvals, no run controls', () => {
    const { card } = renderCard(run(view({
      phase: 'interrupted', startedAt: NOW - 90_000,
      threads: [sol({ childNodeId: 'c1', steps: steps(['waiting', 'pending']) }), fable({ childNodeId: 'c2', steps: steps(['failed', 'pending'], [{ error: 'boom' }]) })],
    }), { statusDetail: 'Interrupted: Michi restarted while this ran. Retry continues it.', approvals: [approval()] }), { readOnly: true });
    for (const name of ['Retry', 'Replace model', 'Stop']) {
      expect(within(card).queryByRole('button', { name })).toBeNull();
    }
    for (const name of ['Allow once', 'Deny', /Side by side/]) {
      expect(within(card).getByRole('button', { name })).toBeTruthy();
    }
    expect(within(card).getAllByTestId('mm-row')).toHaveLength(2);
  });
});

describe('MultiModelRunCard: controls', () => {
  it('stops every branch from the card while it runs', async () => {
    const { card } = renderCard(run(running()));
    fireEvent.click(within(card).getByRole('button', { name: 'Stop all' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/stop`, 'POST']));
  });

  it('holds a row\'s Retry and Replace model while a stopped run settles, and offers neither after its only answer', () => {
    // A running run is always settling and takes them; a stopped one refuses them until its turns end.
    const { card } = renderCard(run(view({
      phase: 'cancelled', startedAt: NOW - 90_000, settling: true,
      threads: [
        sol({ steps: steps(['completed', 'skipped'], [{ summary: 'A' }, { error: 'Only one answer, nothing to review' }]) }),
        fable({ steps: steps(['failed', 'skipped'], [{ error: 'session expired' }, { error: 'Failed in step 1' }]) }),
      ],
    })));
    fireEvent.click(within(card).getByRole('button', { name: /Review once/ }));
    const row = (key: string, step: number) => card.querySelector(`[data-testid="mm-row"][data-key="${key}"][data-step="${step}"]`) as HTMLElement;
    // Its review was skipped, but it answered: nothing to replace.
    expect(within(row('t1', 1)).queryByRole('button', { name: 'Replace model' })).toBeNull();
    for (const step of [0, 1]) {
      expect((within(row('t2', step)).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
      expect((within(row('t2', step)).getByRole('button', { name: 'Replace model' }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('a finished run with a failed branch retries all failed branches through the run', async () => {
    const { card } = renderCard(run(view({
      phase: 'completed', startedAt: NOW - 60_000, reviewRounds: 0,
      threads: [sol({ steps: steps(['completed'], [{ summary: 'A' }]) }), fable({ steps: steps(['failed'], [{ error: 'boom' }]) })],
      synthesis: { status: 'completed', messageId: 'self-caller-syn' },
    }), { status: 'completed', endedAt: NOW }));
    fireEvent.click(within(card.querySelector('.status') as HTMLElement).getByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/retry`, 'POST']));
  });
});

describe('MultiModelRunCard: ended runs', () => {
  it('a completed run opens its last answered step and points to the synthesis below', () => {
    const scrolls: unknown[] = [];
    const record = (event: Event) => scrolls.push((event as CustomEvent).detail);
    window.addEventListener('michi:scroll-to-message', record);
    try {
      const onOpenDrawer = vi.fn();
      const { card } = renderCard(run(view({
        phase: 'completed', startedAt: NOW - 401_000,
        threads: [
          sol({ steps: steps(['completed', 'completed'], [{ summary: 'A' }, { summary: 'A2' }]) }),
          argon({ steps: steps(['completed', 'completed'], [{ summary: 'B' }, { summary: 'B2' }]) }),
        ],
        synthesis: { status: 'completed', messageId: 'self-caller-syn' },
      }), { status: 'completed', endedAt: NOW }), { onOpenDrawer });
      expect(screen.getByTestId('mm-chip').textContent).toBe('Done6m 41s');
      const [answer, review, synthesis] = [...card.querySelectorAll('.steps > .step')];
      expect(answer.querySelector('.list2')).toBeNull();
      expect(review.querySelector('.list2')).not.toBeNull();
      expect(synthesis.textContent).toContain('✓ Written below ↓');
      expect([...card.querySelectorAll('.step > .n')].map((n) => n.textContent)).toEqual(['✓', '✓', '✓']);
      // It scrolls the chat to the synthesis, and does not open the drawer.
      fireEvent.click(within(synthesis as HTMLElement).getByRole('button', { name: 'Written below ↓' }));
      expect(scrolls).toEqual([{ nodeId: 'caller', messageId: 'self-caller-syn' }]);
      expect(onOpenDrawer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('michi:scroll-to-message', record);
    }
  });

  it('a stopped run marks the step it stopped in neutrally and says the synthesis was not written', () => {
    const { card } = renderCard(run(view({
      phase: 'cancelled', startedAt: NOW - 60_000,
      threads: [sol({ steps: steps(['cancelled', 'pending']) }), fable({ steps: steps(['stopped', 'pending']) })],
    }), { status: 'cancelled', statusDetail: 'Stopped' }));
    expect([...card.querySelectorAll('.step > .n')].map((n) => `${n.className}:${n.textContent}`)).toEqual(['n stop:■', 'n idle:2', 'n idle:3']);
    const synthesis = [...card.querySelectorAll('.steps > .step')].at(-1) as HTMLElement;
    expect(synthesis.textContent).toBe('3SynthesisNot written: the run was stopped');
    expect(card.querySelector('.status')?.textContent).toBe('StoppedRetry');
  });

  it('shows late work as late work, then the addendum it wrote', () => {
    const late = (status: MultiModelStepStatus) => fable({ late: true, childNodeId: 'c2b', steps: steps([status], [{ startedAt: NOW - 12_000, summary: 'Late.' }]) });
    const written = { status: 'completed' as const, messageId: 'self-caller-syn', startedAt: NOW - 100_000, endedAt: NOW - 80_000 };
    const started = { startedAt: NOW - 400_000, reviewRounds: 0 as const };
    const { card, rerender } = renderCard(run(view({
      ...started, phase: 'running', synthesis: written,
      threads: [sol({ steps: steps(['completed'], [{ summary: 'A' }]) }), late('running')],
    })));
    expect(screen.getByTestId('mm-chip').textContent).toBe('Adding 1 late answer12s');
    const synthesis = () => [...screen.getByTestId('multi-model-card').querySelectorAll('.steps > .step')].at(-1) as HTMLElement;
    expect(synthesis().textContent).toContain('✓ Written below ↓');
    expect(card.querySelector('.status')).toBeNull();
    const after = (lastAddendumStatus: 'completed' | 'failed', statusDetail?: string) => rerender(
      <WorkflowDomainProvider api={api()}>
        <MultiModelRunCard identity={identity} run={run(view({
          ...started, phase: 'completed', lastMessageId: 'self-caller-add',
          synthesis: { ...written, addenda: 1, lastAddendumStatus },
          threads: [sol({ steps: steps(['completed'], [{ summary: 'A' }]) }), late('completed')],
        }), { status: 'completed', endedAt: NOW, statusDetail })} />
      </WorkflowDomainProvider>,
    );
    after('completed');
    expect(screen.getByTestId('mm-chip').textContent).toBe('Done5m 20s');
    expect(screen.getByTestId('mm-addendum').textContent).toBe('Added 1 late answer to the synthesis');
    const scrolls: unknown[] = [];
    const record = (event: Event) => scrolls.push((event as CustomEvent).detail);
    window.addEventListener('michi:scroll-to-message', record);
    fireEvent.click(within(synthesis()).getByRole('button', { name: 'Written below ↓' }));
    window.removeEventListener('michi:scroll-to-message', record);
    expect(scrolls).toEqual([{ nodeId: 'caller', messageId: 'self-caller-add' }]);
    after('failed', "Couldn't add the late answers: boom");
    expect(screen.getByTestId('mm-addendum').textContent).toBe("Couldn't add 1 late answer · Retry");
    // Its Retry sits there, not again under the title.
    expect(screen.getByTestId('multi-model-card').querySelector('.status')?.textContent).toBe("Couldn't add the late answers: boom");
  });

  it('a run whose reviews were all skipped opens the answer step', () => {
    const { card } = renderCard(run(view({
      phase: 'completed', startedAt: NOW - 60_000,
      threads: [
        sol({ steps: steps(['completed', 'skipped'], [{ summary: 'A' }, { error: 'Only one answer, nothing to review' }]) }),
        fable({ steps: steps(['failed', 'skipped'], [{ error: 'x' }, { error: 'Only one answer, nothing to review' }]) }),
      ],
      synthesis: { status: 'completed' },
    }), { status: 'completed', endedAt: NOW }));
    const [answer, review] = [...card.querySelectorAll('.steps > .step')];
    expect(answer.querySelector('.list2')).not.toBeNull();
    expect(review.querySelector('.sd')?.textContent).toBe('Skipped · only one answer');
    // No branch took part: nothing to count ("0/0 done").
    expect(review.querySelector('.sh .sub')?.textContent).toBe('Skipped');
  });

  it('an interrupted run says why and retries; Retry waits while turns settle', async () => {
    const detail = 'Interrupted: Michi restarted while this ran. Retry continues it.';
    const interrupted = view({ phase: 'interrupted', startedAt: NOW - 60_000, threads: [sol({ steps: steps(['interrupted', 'pending']) })] });
    const { card, rerender } = renderCard(run(interrupted, { status: 'cancelled', statusDetail: detail }));
    expect(screen.getByTestId('mm-chip').textContent).toBe('Interrupted');
    expect(card.querySelector('.status')?.textContent).toBe(`${detail}Retry`);
    fireEvent.click(within(card.querySelector('.status') as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls().at(-1)?.slice(0, 2)).toEqual([`${base}/retry`, 'POST']));
    rerender(
      <WorkflowDomainProvider api={api()}>
        <MultiModelRunCard run={run({ ...interrupted, settling: true }, { status: 'cancelled', statusDetail: detail })} identity={identity} />
      </WorkflowDomainProvider>,
    );
    expect((within(screen.getByTestId('multi-model-card').querySelector('.status') as HTMLElement).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a row's Retry and Replace model wait while a stopped run's turns settle, not while it runs", () => {
    const rows = [sol({ childNodeId: 'c1', steps: steps(['failed'], [{ error: 'boom' }]) }), fable({ childNodeId: 'c2', steps: steps(['running']) })];
    const disabled = () => {
      const row = screen.getAllByTestId('mm-row').find((element) => element.dataset.key === 't1') as HTMLElement;
      return ['Retry', 'Replace model'].map((name) => (within(row).getByRole('button', { name }) as HTMLButtonElement).disabled);
    };
    const { rerender } = renderCard(run(view({ phase: 'cancelled', startedAt: NOW - 60_000, reviewRounds: 0, settling: true, threads: rows }), { status: 'cancelled' }));
    expect(disabled()).toEqual([true, true]);
    rerender(
      <WorkflowDomainProvider api={api()}>
        <MultiModelRunCard run={run(view({ phase: 'running', startedAt: NOW - 60_000, reviewRounds: 0, settling: true, threads: rows }))} identity={identity} />
      </WorkflowDomainProvider>,
    );
    expect(disabled()).toEqual([false, false]);
  });

  it('a deleted branch offers only Replace model on its stopped review', () => {
    renderCard(run(view({
      phase: 'running', startedAt: NOW - 60_000,
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'running']) }),
        fable({ childNodeId: 'c2', branchGone: true, steps: steps(['completed', 'stopped'], [{}, { error: 'Branch was deleted' }]) }),
      ],
    })));
    const row = screen.getAllByTestId('mm-row').find((element) => element.dataset.key === 't2' && element.dataset.step === '1') as HTMLElement;
    expect(row.querySelector('.line')?.textContent).toBe('Branch was deleted · Replace model');
  });

  it("counts a review's branches as the drawer does while a deleted branch's review stopped before the round", () => {
    const { card } = renderCard(run(view({
      phase: 'running', startedAt: NOW - 60_000,
      threads: [
        sol({ childNodeId: 'c1', steps: steps(['completed', 'pending']) }),
        fable({ childNodeId: 'c2', steps: steps(['running', 'pending']) }),
        argon({ childNodeId: 'c3', branchGone: true, steps: steps(['completed', 'stopped'], [{}, { error: 'Branch was deleted' }]) }),
      ],
    })));
    const review = [...card.querySelectorAll('.steps > .step')][1] as HTMLElement;
    expect(within(review).getByRole('button', { name: /Review once/ }).querySelector('.sub')?.textContent).toBe('0/1 done');
  });

  it('a failed synthesis offers a run Retry in its step', () => {
    const { card } = renderCard(run(view({
      phase: 'failed', startedAt: NOW - 60_000, reviewRounds: 0,
      threads: [sol({ steps: steps(['completed'], [{ summary: 'A' }]) })], synthesis: { status: 'failed', error: 'boom' },
    }), { status: 'failed', statusDetail: 'The synthesis failed' }));
    const synthesis = [...card.querySelectorAll('.steps > .step')].at(-1) as HTMLElement;
    expect(synthesis.textContent).toContain("Couldn't write the synthesis");
    expect(within(synthesis).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByTestId('mm-chip').textContent).toBe('Failed');
  });

  it('a cancelled proposal is one line', () => {
    const { card } = renderCard(run(view({ phase: 'cancelled' }), { status: 'cancelled', statusDetail: 'Replaced by a newer plan' }));
    expect(card.textContent).toBe('Multi-model planMemory extraction timingReplaced by a newer plan');
  });
});
