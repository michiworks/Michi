import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentOverview, ScheduledJobBlockedExecution, ScheduledJobDto, ScheduledJobRunDto } from 'michi-shared';
import type { Project } from '../../../state/chatTypes';
import TerminalScheduled from './Scheduled';
import { openScheduledHome, requestScheduledJobDetail, requestScheduledRun } from '../scheduled/scheduledNav';
import { getCompanionPanelState, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { companionScheduleWorkspace, resetCompanionScreenForTests } from '../../../state/companion/companionScreen';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  jobs: [] as ScheduledJobDto[],
  runs: [] as ScheduledJobRunDto[],
  serviceMode: false,
  blockedExecutions: [] as ScheduledJobBlockedExecution[],
  confirmStopped: vi.fn(),
  defaults: vi.fn(async () => ({ sessionMode: 'persistent' })),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runNow: vi.fn(),
  cancel: vi.fn(),
  listRuns: vi.fn(),
  preview: vi.fn(),
  applyCommands: vi.fn(),
  reveal: vi.fn(),
  getRun: vi.fn(),
  move: vi.fn(),
  refreshWorkspace: vi.fn(),
  confirm: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
}));

const meta = vi.hoisted(() => ({ load: { kind: 'unavailable' } as unknown, nav: vi.fn() }));
vi.mock('../../../state/metaAgent/useMetaAgentOverview', () => ({
  useMetaAgentOverview: () => meta.load,
}));
vi.mock('../../../state/appEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/appEvents')>()),
  navPageEvent: { dispatch: (...args: unknown[]) => meta.nav(...args) },
}));
vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => ({ projects: state.projects, activeProject: state.projects[0] ?? null, hydrated: true }),
  useChatActions: () => ({ revealBackendNode: (...args: unknown[]) => state.reveal(...args) }),
  useChatNode: (nodeId: string) => (nodeId ? { nodeId, projectId: 'ws-1' } : undefined),
}));
vi.mock('../../../services/api/scheduledJobs', () => ({
  getScheduledJobSettings: () => state.defaults(),
  listScheduledJobs: (...args: unknown[]) => state.list(...args),
  createScheduledJob: (...args: unknown[]) => state.create(...args),
  updateScheduledJob: (...args: unknown[]) => state.update(...args),
  deleteScheduledJob: (...args: unknown[]) => state.remove(...args),
  runScheduledJobNow: (...args: unknown[]) => state.runNow(...args),
  cancelScheduledJobRun: (...args: unknown[]) => state.cancel(...args),
  confirmScheduledExecutionStopped: (...args: unknown[]) => state.confirmStopped(...args),
  listScheduledJobRuns: (...args: unknown[]) => state.listRuns(...args),
  previewScheduledJobSchedule: (...args: unknown[]) => state.preview(...args),
  getScheduledJobRun: (...args: unknown[]) => state.getRun(...args),
  moveScheduledRunToWorkspace: (...args: unknown[]) => state.move(...args),
}));
/** The run viewer shows the thread as a read-only pane (TPane has its own tests). */
vi.mock('../TPane', () => ({
  default: ({ nodeId, readOnly }: { nodeId: string; readOnly?: boolean }) => <div data-testid="run-thread" data-node={nodeId} data-readonly={String(!!readOnly)} />,
}));
vi.mock('../../../state/prefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/prefs')>()),
  usePrefs: () => ({ prefs: { singlePaneContentWidth: 676 } }),
}));
vi.mock('../../../state/useEmbeddedChatNode', () => ({
  useEmbeddedChatNode: () => ({ state: 'ready', retry: () => {}, refreshWorkspace: (...args: unknown[]) => state.refreshWorkspace(...args) }),
}));
vi.mock('../../../services/api/persistence', () => ({
  applyWorkspaceCommands: (...args: unknown[]) => state.applyCommands(...args),
}));
vi.mock('../agents/useRuntimeFieldCatalog', () => ({
  useRuntimeFieldCatalog: () => ({
    runtimes: [{ id: 'kiro', label: 'Kiro', available: true }, { id: 'pi', label: 'Pi', available: true }],
    providersFor: {}, modelsFor: {}, request: () => {},
  }),
}));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmDialog: (...args: unknown[]) => state.confirm(...args) }));
vi.mock('sonner', () => ({ toast: Object.assign((...args: unknown[]) => state.notice(...args), {
  success: (...args: unknown[]) => state.success(...args), error: (...args: unknown[]) => state.error(...args),
}) }));
// "Create with agent" opens the agent's one conversation (Q14): it never starts a new one.
const assistantApi = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock('../../../services/api/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/assistant')>()),
  resetAssistant: (...args: unknown[]) => assistantApi.reset(...args),
}));

const now = Date.now();

function project(id: string, name: string): Project {
  return { id, name, chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, cwd: `/tmp/${name}` };
}

function job(overrides: Partial<ScheduledJobDto> = {}): ScheduledJobDto {
  return {
    id: 'job-1', workspaceId: 'ws-1', name: 'Morning digest', prompt: 'Summarize overnight changes',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: null },
    runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
    sessionMode: 'fresh', notify: true, enabled: true, autoPaused: false, timeoutSeconds: 1800,
    nextRunAt: now + 3 * 3_600_000, lastRunAt: now - 3_600_000, lastStatus: 'succeeded', lastError: null,
    consecutiveFailures: 0, activeRunId: null, persistentNodeId: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  openScheduledHome();
  vi.clearAllMocks();
  state.projects = [project('ws-1', 'michi'), project('ws-2', 'research')];
  state.jobs = [job(), job({ id: 'job-2', workspaceId: 'ws-2', name: 'Paper watch', enabled: false, nextRunAt: null, lastStatus: null, lastRunAt: null })];
  state.runs = [{
    id: 'run-1', jobId: 'job-1', workspaceId: 'ws-1', nodeId: 'n-1', treeId: 't-1', trigger: 'scheduled',
    status: 'succeeded', scheduledFor: now - 3_600_000, startedAt: now - 3_600_000, finishedAt: now - 3_590_000,
    summary: 'Nothing unusual overnight.', error: null,
  }];
  state.serviceMode = false;
  state.blockedExecutions = [];
  state.confirmStopped.mockReset();
  state.list.mockImplementation(async () => ({ jobs: state.jobs, scheduler: { active: true, serviceMode: state.serviceMode, timezone: 'UTC', blockedExecutions: state.blockedExecutions } }));
  state.listRuns.mockImplementation(async () => state.runs);
  state.preview.mockResolvedValue({ valid: true, nextRuns: [now + 86_400_000] });
  state.confirm.mockResolvedValue(true);
  state.reveal.mockResolvedValue(true);
  meta.load = { kind: 'unavailable' };
  meta.nav.mockReset();
  resetCompanionPanelForTests();
  resetCompanionStoreForTests();
  resetCompanionScreenForTests();
  assistantApi.reset.mockReset();
});

function metaOverview(overrides: Partial<MetaAgentOverview> = {}): MetaAgentOverview {
  return {
    state: 'running',
    runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
    today: { checks: 342, checksTruncated: false, modelCalls: 9, writes: 14, pendingProposals: 3 },
    cursors: [],
    recentRuns: [],
    managedJobIds: ['m-1', 'm-2'],
    ...overrides,
  };
}

describe('Scheduled page: Pages upkeep is not listed (Q8)', () => {
  beforeEach(() => {
    state.jobs = [
      ...state.jobs,
      job({ id: 'm-1', workspaceId: 'ws-1', name: 'Maintain Pages · michi', schedule: { kind: 'every', everySeconds: 60 } }),
      job({ id: 'm-2', workspaceId: 'ws-2', name: 'Maintain Pages · research', schedule: { kind: 'every', everySeconds: 60 } }),
    ];
    meta.load = { kind: 'ready', overview: metaOverview(), at: now };
  });

  it('lists only the user’s jobs: no upkeep row, and an older backend’s managed jobs stay out', async () => {
    render(<TerminalScheduled />);
    expect(await screen.findByText('Morning digest')).toBeTruthy();
    expect(screen.queryByText('Maintain Pages · michi')).toBeNull();
    expect(screen.queryByRole('region', { name: 'System task' })).toBeNull();
    expect(screen.queryByText(/Pages upkeep/)).toBeNull();
    expect(screen.getByLabelText('2 jobs')).toBeTruthy();
  });

  it('sends an older notification for a maintenance job to Pages', async () => {
    render(<TerminalScheduled />);
    expect(await screen.findByText('Morning digest')).toBeTruthy();
    act(() => requestScheduledJobDetail('m-1'));
    await waitFor(() => expect(meta.nav).toHaveBeenCalledWith({ page: 'spaces' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Scheduled page', () => {
  it('shows global recovery for a deleted job and keeps it visible while searching', async () => {
    state.blockedExecutions = [{ runId: 'old-run', jobId: 'deleted-job', workspaceId: 'ws-1', reason: 'unconfirmed_executor', since: now - 60_000 }];
    render(<TerminalScheduled />);
    const banner = await screen.findByRole('alert', { name: 'Scheduled runs need attention' });
    expect(within(banner).getByText('Previous scheduled job')).toBeTruthy();
    expect(within(banner).getByText(/All new scheduled runs are paused/)).toBeTruthy();
    expect(within(banner).queryByText('unconfirmed_executor')).toBeNull();
    expect((screen.getByRole('button', { name: 'Run Morning digest now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Run Morning digest now' }));
    expect(state.runNow).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matching job' } });
    expect(screen.getByRole('heading', { name: 'No matching jobs' })).toBeTruthy();
    expect(screen.getByRole('alert', { name: 'Scheduled runs need attention' })).toBe(banner);
  });

  it('requires confirmation, preserves a live-process error, and refreshes after retry succeeds', async () => {
    state.jobs = [];
    state.blockedExecutions = [{ runId: 'old-run', jobId: 'deleted-job', workspaceId: 'ws-1', reason: 'unconfirmed_executor', since: now - 60_000 }];
    state.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
    state.confirmStopped.mockRejectedValueOnce(new Error('The previous Michi process may still start or run this execution. Stop that process and its agent before confirming.'))
      .mockImplementationOnce(async () => { state.blockedExecutions = []; return { released: true }; });
    render(<TerminalScheduled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm stopped: Previous scheduled job' }));
    await waitFor(() => expect(state.confirm).toHaveBeenCalledOnce());
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Confirm the previous execution has stopped?',
      message: expect.stringContaining('A stop request alone does not confirm they have ended.'),
      confirmLabel: 'Both have stopped',
    }));
    expect(state.confirmStopped).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    const retry = await screen.findByRole('button', { name: 'Retry confirming stopped: Previous scheduled job' });
    expect(screen.getByText(/The previous Michi process may still start or run/)).toBeTruthy();
    expect(state.confirmStopped).toHaveBeenCalledWith('old-run');
    expect(screen.getByRole('alert', { name: 'Scheduled runs need attention' })).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('alert', { name: 'Scheduled runs need attention' })).toBeNull());
    expect(state.confirmStopped).toHaveBeenCalledTimes(2);
    expect(state.list).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: 'No scheduled jobs' })).toBeTruthy();
  });

  it('lists jobs grouped by workspace with schedule, next run and last result', async () => {
    render(<TerminalScheduled />);
    expect(await screen.findByText('Morning digest')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /michi/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /research/ })).toBeTruthy();
    expect(screen.getAllByText('Weekdays at 09:00')).toHaveLength(2);
    expect(screen.getByText('Next in 3 h')).toBeTruthy();
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('Never run')).toBeTruthy();
    expect(screen.getByText('Runs while the Michi server is running')).toBeTruthy();
  });

  it('shows an active run in the last-run column instead of the previous result', async () => {
    state.jobs = [
      job({ lastStatus: null, lastRunAt: null, activeRunId: 'run-9' }),
      job({ id: 'job-2', workspaceId: 'ws-2', name: 'Paper watch', lastStatus: 'failed', lastRunAt: now, activeRunId: 'run-10' }),
    ];
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    expect(screen.getAllByText('Running')).toHaveLength(2);
    expect(screen.queryByText('Never run')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop Morning digest' })).toBeTruthy();
  });

  it('says a job in an archived workspace does not run, in the row and its details', async () => {
    state.projects = [{ ...project('ws-1', 'michi'), archivedAt: 5 }, { ...project('ws-2', 'research'), archivedAt: 5 }];
    render(<TerminalScheduled />);
    expect(await screen.findByText('Workspace archived')).toBeTruthy();
    expect(screen.queryByText(/^Next /)).toBeNull();
    expect(screen.getByText('Paused'), 'a paused job there still reads as paused').toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Morning digest' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Workspace archived')).toBeTruthy();
  });

  it('shows an overdue next run as due', async () => {
    state.jobs = [job({ nextRunAt: now - 120_000 })];
    render(<TerminalScheduled />);
    expect(await screen.findByText('Due now')).toBeTruthy();
    expect(screen.queryByText(/^Next /)).toBeNull();
  });

  it('shows the empty state with a create action', async () => {
    state.jobs = [];
    render(<TerminalScheduled />);
    expect(await screen.findByText('No scheduled jobs')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /New job/ })).toHaveLength(2);
  });

  it('offers Create with agent where New job is, telling the panel the workspace New job preselects', async () => {
    state.projects = [{ ...project('ws-assistant', 'Michi assistant'), system: 'assistant' }, ...state.projects];
    const { unmount } = render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    expect(screen.getByRole('button', { name: /Create with agent/ })).toBeTruthy();
    // No Meta agent window of its own (DESIGN-v2 §1.4).
    expect(document.querySelector('.meta-chat-panel')).toBeNull();
    expect(companionScheduleWorkspace()).toBe('ws-1');
    unmount();
    // Leaving Scheduled: its messages no longer carry a schedule.
    expect(companionScheduleWorkspace()).toBeUndefined();

    // No local workspace to schedule in: neither New job nor the agent.
    state.projects = [{ ...project('ws-assistant', 'Michi assistant'), system: 'assistant' }];
    state.jobs = [];
    render(<TerminalScheduled />);
    expect(await screen.findByText('No scheduled jobs')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create with agent/ })).toBeNull();
    expect(companionScheduleWorkspace()).toBeNull();
  });

  it('opens the agent’s one conversation on Chat for Create with agent, never a new one (Q14)', async () => {
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: /Create with agent/ }));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
    fireEvent.click(screen.getByRole('button', { name: /Create with agent/ }));
    expect(assistantApi.reset).not.toHaveBeenCalled();
    expect(state.notice).not.toHaveBeenCalled();
  });

  it('has no Create with agent where this backend has no assistant', async () => {
    resetCompanionStoreForTests({ assistant: { status: 'unsupported', info: null, error: null } });
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    expect(screen.queryByRole('button', { name: /Create with agent/ })).toBeNull();
    expect(screen.getByRole('button', { name: /New job/ })).toBeTruthy();
  });

  it('runs, pauses and filters jobs from the row', async () => {
    state.runNow.mockResolvedValue(state.runs[0]);
    state.update.mockImplementation(async (_id: string, patch: Partial<ScheduledJobDto>) => job({ ...patch }));
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');

    fireEvent.click(screen.getByRole('button', { name: 'Run Morning digest now' }));
    await waitFor(() => expect(state.runNow).toHaveBeenCalledWith('job-1'));
    expect(state.success).toHaveBeenCalledWith('Started “Morning digest”');

    fireEvent.click(screen.getByRole('switch', { name: 'Pause Morning digest' }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith('job-1', { enabled: false }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scheduled jobs' }), { target: { value: 'paper' } });
    expect(screen.queryByRole('button', { name: 'Open Morning digest' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Paper watch' })).toBeTruthy();
    // The page has no mark rule of its own: the highlight brings its theme tint.
    expect(screen.getByText('Paper', { selector: 'mark' }).className).toBe('search-mark');
  });

  it('creates a job from the editor', async () => {
    state.create.mockImplementation(async (input: Record<string, unknown>) => job({ id: 'job-3', ...input } as Partial<ScheduledJobDto>));
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: /New job/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Nightly CI' } });
    fireEvent.change(within(dialog).getByLabelText('Prompt'), { target: { value: 'Check the CI dashboard' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Interval' }));
    fireEvent.change(within(dialog).getByLabelText('Interval'), { target: { value: '2' } });
    expect(within(dialog).getByRole('radio', { name: /One ongoing thread/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0]).toMatchObject({
      name: 'Nightly CI', prompt: 'Check the CI dashboard', workspaceId: 'ws-1',
      schedule: { kind: 'every', everySeconds: 7200 }, sessionMode: 'persistent', permissionMode: 'trust', visibility: 'workspace',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('uses the saved default when opening a new job', async () => {
    state.defaults.mockResolvedValueOnce({ sessionMode: 'fresh' });
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: /New job/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /New thread each run/ }).getAttribute('aria-checked')).toBe('true');
  });

  it("never offers the assistant's hidden workspace, even when it is the active one", async () => {
    state.projects = [{ ...project('ws-assistant', 'Michi assistant'), system: 'assistant' }, ...state.projects];
    state.create.mockImplementation(async (input: Record<string, unknown>) => job({ id: 'job-5', ...input } as Partial<ScheduledJobDto>));
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: /New job/ }));
    const dialog = await screen.findByRole('dialog');
    const workspaces = within(dialog).getByLabelText('Workspace') as HTMLSelectElement;
    expect([...workspaces.options].map((option) => option.value)).toEqual(['ws-1', 'ws-2']);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Elsewhere' } });
    fireEvent.change(within(dialog).getByLabelText('Prompt'), { target: { value: 'Say hi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1' });
  });

  it('stores a thread-less workspace before retrying a rejected create', async () => {
    state.create
      .mockRejectedValueOnce(new Error('Workspace not found'))
      .mockImplementationOnce(async (input: Record<string, unknown>) => job({ id: 'job-4', ...input } as Partial<ScheduledJobDto>));
    state.applyCommands.mockResolvedValue(undefined);
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: /New job/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.change(within(dialog).getByLabelText('Prompt'), { target: { value: 'Say hi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create job' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));
    expect(state.applyCommands).toHaveBeenCalledWith('ws-1', expect.any(String), [
      expect.objectContaining({ type: 'workspace.upsert', payload: expect.objectContaining({ id: 'ws-1', name: 'michi' }) }),
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the editor open and shows validation errors', async () => {
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: /New job/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create job' }));
    expect(await within(dialog).findByText('Give the job a name')).toBeTruthy();
    expect(within(dialog).getByText('Write the prompt to run')).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('opens a run thread from the job details', async () => {
    render(<TerminalScheduled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Morning digest' }));
    const dialog = await screen.findByRole('dialog');
    const run = await within(dialog).findByRole('button', { name: /Succeeded run from .*open thread/ });
    expect(within(dialog).getByText('Nothing unusual overnight.')).toBeTruthy();
    fireEvent.click(run);
    await waitFor(() => expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1'));
  });

  it('opens a Scheduled-only run here as its conversation, read-only, and moves it to the workspace', async () => {
    state.jobs = [job({ visibility: 'scheduled' })];
    state.runs = state.runs.map((run) => ({ ...run, scheduledOnly: true }));
    state.getRun.mockImplementation(async () => state.runs[0]);
    state.move.mockImplementation(async () => ({ ...state.runs[0], scheduledOnly: false }));
    state.refreshWorkspace.mockResolvedValue(true);
    render(<TerminalScheduled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Morning digest' }));
    const detail = await screen.findByRole('dialog');
    expect(within(detail).getByText('Only in Scheduled')).toBeTruthy();
    fireEvent.click(await within(detail).findByRole('button', { name: /Succeeded run from .*open run/ }));

    const thread = await screen.findByTestId('run-thread');
    expect(thread.dataset.node).toBe('n-1');
    expect(thread.dataset.readonly).toBe('true');
    // A page in place of the list, not a dialog over it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('region', { name: 'Morning digest run' })).toBeTruthy();
    expect(state.reveal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Move to workspace/ }));
    await waitFor(() => expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1'));
    expect(state.move).toHaveBeenCalledWith('run-1');
    expect(state.refreshWorkspace).toHaveBeenCalledWith('n-1');
  });

  it('goes from a run to its job’s runs', async () => {
    state.jobs = [job({ visibility: 'scheduled' })];
    state.getRun.mockImplementation(async () => ({ ...state.runs[0], scheduledOnly: true }));
    act(() => requestScheduledRun('job-1', 'run-1'));
    render(<TerminalScheduled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Morning digest details and runs' }));
    const dialog = await screen.findByRole('dialog', { name: 'Scheduled job' });
    expect(within(dialog).getByRole('heading', { name: 'Morning digest' })).toBeTruthy();
    expect(screen.queryByTestId('run-thread')).toBeNull();
  });

  it('opens job details requested from a notification before the page mounted', async () => {
    act(() => requestScheduledJobDetail('job-2'));
    render(<TerminalScheduled />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Paper watch' })).toBeTruthy();
  });

  it('deletes a job after confirmation', async () => {
    state.remove.mockImplementation(async (id: string) => { state.jobs = state.jobs.filter((candidate) => candidate.id !== id); });
    render(<TerminalScheduled />);
    await screen.findByText('Morning digest');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Morning digest' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('job-1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Morning digest' })).toBeNull());
  });

  it('opens a row\'s menu as the phone\'s lifted menu from its ⋯ and from a long press', async () => {
    const desktopWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      render(<TerminalScheduled />);
      await screen.findByText('Morning digest');
      const row = screen.getByRole('button', { name: 'Open Morning digest' }).closest<HTMLElement>('.sched-row')!;
      expect(row.hasAttribute('data-context-target')).toBe(true);
      fireEvent.contextMenu(row);
      expect(document.querySelector('[data-phone-menu]')).not.toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
      await waitFor(() => expect(document.querySelector('[data-phone-menu]')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Paper watch' }));
      expect(document.querySelector('[data-phone-menu]')).not.toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Resume' })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
    }
  });

  it('reports background mode from the scheduler', async () => {
    state.serviceMode = true;
    render(<TerminalScheduled />);
    expect(await screen.findByText('Runs in the background, even when Michi is closed')).toBeTruthy();
  });
});
