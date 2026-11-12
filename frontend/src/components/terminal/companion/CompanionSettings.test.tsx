import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionDelegationDto, CompanionRunDto } from 'michi-shared';
import type { AgentCapabilities, AgentModelInfo } from '../../../services/api/agentRuntime';
import { AssistantApiError } from '../../../services/api/assistant';
import { CompanionApiError } from '../../../services/api/companion';
import type { MetaAgentInfo } from '../../../services/api/metaAgent';
import { adoptCompanionSnapshot, getCompanionState, resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { resetMetaAgentStore } from '../../../state/metaAgent/useMetaAgent';
import { companionSnapshot } from '../../../test/companionFixtures';
import { SettingsLayoutContext, SettingsOpenContext } from '../pages/settings/settingsPhone';
import { WINDOWS_CLOSED_TITLE } from '../pages/settings/residencyCopy';
import { settingsSearchIndex } from '../rail/settingsSearch';
import { resetMetaAgentOverviewStore } from '../../../state/metaAgent/useMetaAgentOverview';
import CompanionSettings from './CompanionSettings';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  reset: vi.fn(),
  undoDemotion: vi.fn(),
  saveRules: vi.fn(),
  saveNotes: vi.fn(),
  updateGoal: vi.fn(),
  undoRun: vi.fn(),
  stopAutoSend: vi.fn(),
  confirm: vi.fn(),
  openPanel: vi.fn(),
  refresh: vi.fn(),
  fetchMetaAgent: vi.fn(),
  fetchOverview: vi.fn(),
  fetchAgentStatus: vi.fn(),
}));
const catalog = vi.hoisted(() => ({
  value: {
    models: [] as AgentModelInfo[], providers: [], capabilities: null as AgentCapabilities | null,
    loading: false, waiting: false, error: null as string | null, retry: () => {},
  },
}));
vi.mock('../../../services/api/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/companion')>()),
  patchCompanionSettings: mocks.patch,
  resetCompanionConversation: mocks.reset,
  undoCompanionDemotion: mocks.undoDemotion,
  saveCompanionRules: mocks.saveRules,
  saveCompanionNotes: mocks.saveNotes,
  updateCompanionGoal: mocks.updateGoal,
  undoCompanionRun: mocks.undoRun,
  stopCompanionDelegationAutoSend: mocks.stopAutoSend,
}));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../../../state/companion/companionPanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionPanel')>()),
  openCompanionPanel: mocks.openPanel,
}));
vi.mock('../../../state/companion/companionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionStore')>()),
  scheduleCompanionRefresh: mocks.refresh,
}));
vi.mock('../../../services/api/metaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/metaAgent')>()),
  fetchMetaAgent: mocks.fetchMetaAgent,
}));
vi.mock('../../../services/api/metaAgentOverview', () => ({ fetchMetaAgentOverview: mocks.fetchOverview, setMetaAgentPaused: vi.fn() }));
vi.mock('../../../services/api/agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/agentRuntime')>()),
  fetchAgentStatus: mocks.fetchAgentStatus,
}));
vi.mock('../../../hooks/useRuntimeCatalog', () => ({ useRuntimeCatalog: () => catalog.value }));

const CAPS: AgentCapabilities = {
  modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false, warmSessions: false,
  saveContext: false, spawnBranches: false, nativeResume: false,
};
const MODELS: AgentModelInfo[] = [
  { id: 'claude-opus-5.5', label: 'Opus 5.5', supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
];
const META_INFO: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const OVERVIEW = {
  state: 'running', runtime: META_INFO.resolved, today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
  cursors: [], recentRuns: [],
};

/** The snapshot of an agent the user named Robin, on Claude with Opus. */
function named(overrides: Parameters<typeof companionSnapshot>[0] = {}) {
  const base = companionSnapshot(overrides);
  const runs = { runtimeId: 'claude' as const, providerId: null, modelId: 'claude-opus-5.5', reasoning: null };
  return {
    ...base,
    settings: { ...base.settings, displayName: 'Robin', ...overrides.settings },
    conversation: base.conversation && {
      ...base.conversation,
      assistant: { nodeId: 'companion-node', workspaceId: 'ws-assistant', treeId: 'tree-c', settings: runs, conversation: runs, supportedRuntimes: ['claude' as const] },
    },
  };
}
const base = named();
const section = (name: string) => screen.getByRole('region', { name });
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

function run(id: string, patch: Partial<CompanionRunDto> = {}): CompanionRunDto {
  return { id, kind: 'heartbeat', trigger: 'interval', outcome: 'spoke', detail: null, startedAt: Date.UTC(2026, 10, 5, 9, 12), finishedAt: null, ...patch };
}
function delegation(id: string, patch: Partial<CompanionDelegationDto> = {}): CompanionDelegationDto {
  return {
    id, workspaceId: 'ws-1', nodeId: `n-${id}`, title: `Worker ${id}`, state: 'following', origin: 'start_conversation', autoSend: false,
    createdAt: 1, lastSentAt: null, lastReportedAt: null, closedAt: null, closedReason: null, ...patch,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  resetCompanionStoreForTests({ snapshot: base });
  resetMetaAgentStore();
  resetMetaAgentOverviewStore();
  mocks.fetchMetaAgent.mockResolvedValue(META_INFO);
  mocks.fetchOverview.mockResolvedValue(OVERVIEW);
  mocks.fetchAgentStatus.mockResolvedValue({
    runtime: 'claude', model: 'claude-opus-5.5', reasoning: 'xhigh', availableRuntimes: [{ id: 'claude', label: 'Claude', available: true }],
  });
  catalog.value = { ...catalog.value, models: MODELS, capabilities: CAPS };
});
afterEach(() => resetCompanionStoreForTests());

describe('Settings › <name>', () => {
  it('lists its parts in the design’s order, says what the agent may do on its own, and never says Meta agent or Companion', async () => {
    render(<CompanionSettings />);
    await flush();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual([
      'Name', 'Model', 'Watching', 'Check-ins', 'Notifications', 'Your rules', 'Notes', 'Goals', 'Pages upkeep', 'Activity', 'Conversation', WINDOWS_CLOSED_TITLE,
    ]);
    // Q1: a check-in may send a follow-up straight to a conversation it started that runs in Ask, so the intro doesn't say it never sends.
    expect(document.body.textContent).toContain('Robin answers you here with your runtime’s tools and permissions. On its own it only reads your sources and tidies your pages, tasks, goals and Today. It never runs commands or edits files, and whatever would act outside Michi waits for your OK: it suggests follow-ups to the conversations it started for you to apply, and sends one directly only to a conversation that runs in Ask, whose tools still ask you first. Check-in transcripts aren’t kept.');
    expect(document.body.textContent).not.toContain('sends anything');
    expect(document.body.textContent).not.toMatch(/meta agent/i);
    expect(document.body.textContent).not.toMatch(/\bCompanion\b/);
    expect((within(section('Name')).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Robin');
    // Pages upkeep is the whole of what Settings › Meta agent was.
    const upkeep = section('Pages upkeep');
    expect(within(upkeep).getByRole('radio', { name: /Follow global settings/ })).toBeTruthy();
    expect(within(upkeep).getByRole('switch', { name: 'Write workspace homes' })).toBeTruthy();
  });

  it('shows every setting Settings search names on this page, by the same name', async () => {
    render(<CompanionSettings />);
    await flush();
    const shown = new Set(Array.from(document.querySelectorAll('.settings-row__label, .settings-section__title, .meta-set__row-k, .meta-set__radio-t'))
      .map((label) => label.textContent?.trim()));
    const missing = settingsSearchIndex('Robin').filter((entry) => entry.page === 'companion' && !shown.has(entry.label)).map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it('saves a change and shows what the backend answered; the master switch only watches and checks in', async () => {
    mocks.patch.mockResolvedValueOnce(named({ settings: { ...base.settings, paused: true } }));
    render(<CompanionSettings />);
    const watching = section('Watching');
    expect(within(watching).getByRole('switch', { name: 'Watch and check in' }).closest('.settings-row')!.textContent)
      .toContain('Off: Robin doesn’t check your sources, check in or notify you. You can still talk to it.');
    fireEvent.click(within(watching).getByRole('switch', { name: 'Pause' }));
    expect(mocks.patch).toHaveBeenCalledWith({ paused: true });
    await waitFor(() => expect(within(watching).getByRole('switch', { name: 'Pause' }).getAttribute('aria-checked')).toBe('true'));
    expect(getCompanionState().snapshot?.settings.paused).toBe(true);
    expect(within(section('Name')).getByText('Paused')).toBeTruthy();
  });

  it('turns one source off, adds a workday, and keeps numbers in range', () => {
    mocks.patch.mockResolvedValue(base);
    render(<CompanionSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Michi conversations' }));
    expect(mocks.patch).toHaveBeenLastCalledWith({ sources: { michi: { enabled: !base.settings.sources.michi.enabled } } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Workdays' })).getByRole('button', { name: 'Sat' }));
    expect(mocks.patch).toHaveBeenLastCalledWith({ workdays: [...base.settings.workdays, 6].sort((a, b) => a - b) });

  });

  it('says when a setting could not be saved', async () => {
    mocks.patch.mockRejectedValueOnce(new CompanionApiError(400, 'quietHours.start must be HH:MM'));
    render(<CompanionSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Pause' }));
    expect((await screen.findByRole('alert')).textContent).toBe('quietHours.start must be HH:MM');
  });

  it('runs on the conversation’s runtime and model, and saves the reasoning check-ins and new conversations use', async () => {
    mocks.patch.mockResolvedValue(base);
    render(<CompanionSettings />);
    await flush();
    const model = section('Model');
    expect(model.textContent).toContain('Claude · Opus 5.5 — same as your conversation');
    const reasoning = within(model).getByRole('combobox', { name: 'Reasoning' }) as HTMLSelectElement;
    // The global level is xhigh: by default the agent runs at the lower of it and high.
    expect([...reasoning.options].map((option) => option.textContent)).toEqual(['Default (High)', 'Low', 'Medium', 'High', 'Extra high']);
    expect(reasoning.value).toBe('');
    expect(model.textContent).toContain('Used by check-ins and new conversations; the composer can change it for one conversation. Check-ins stop after 3 minutes, so xhigh and max can cut them short.');
    expect(model.textContent).toContain('On Codex in Trust or YOLO, once Robin reads check-in material, the rest of that turn’s tools don’t ask first. '
      + 'On Kiro, tools your own Kiro agent already allows (its allowedTools) run without asking, even then. '
      + 'Robin’s own tools that start other work or reach outside Michi still ask first.');
    expect(model.textContent).not.toContain('In YOLO');
    fireEvent.change(reasoning, { target: { value: 'medium' } });
    expect(mocks.patch).toHaveBeenLastCalledWith({ reasoning: 'medium' });
    act(() => adoptCompanionSnapshot(named({ settings: { ...base.settings, reasoning: 'medium' } })));
    expect((within(section('Model')).getByRole('combobox', { name: 'Reasoning' }) as HTMLSelectElement).value).toBe('medium');
    fireEvent.change(within(section('Model')).getByRole('combobox', { name: 'Reasoning' }), { target: { value: '' } });
    expect(mocks.patch).toHaveBeenLastCalledWith({ reasoning: null });
  });

  it('labels the default as the model’s own when the runtime has no global level, as the backend sends none (D10)', async () => {
    mocks.fetchAgentStatus.mockResolvedValue({
      runtime: 'claude', model: 'claude-opus-5.5', availableRuntimes: [{ id: 'claude', label: 'Claude', available: true }],
    });
    render(<CompanionSettings />);
    await flush();
    const reasoning = within(section('Model')).getByRole('combobox', { name: 'Reasoning' }) as HTMLSelectElement;
    expect(reasoning.options[0]!.textContent).toBe('Default (model default)');
  });

  it('keeps a stored level the model does not offer visible, and says Default plainly when it can’t tell', async () => {
    mocks.fetchAgentStatus.mockRejectedValue(new Error('offline'));
    catalog.value = { ...catalog.value, models: [], capabilities: null };
    resetCompanionStoreForTests({ snapshot: named({ settings: { ...base.settings, reasoning: 'max' } }) });
    render(<CompanionSettings />);
    await flush();
    const reasoning = within(section('Model')).getByRole('combobox', { name: 'Reasoning' }) as HTMLSelectElement;
    expect([...reasoning.options].map((option) => option.textContent)).toEqual(['Default', 'Max (this model doesn’t offer it)']);
    expect(reasoning.value).toBe('max');
  });

  it('saves the user’s rules', async () => {
    mocks.saveRules.mockResolvedValueOnce('Skip merged CRs.');
    render(<CompanionSettings />);
    const rules = section('Your rules');
    fireEvent.change(within(rules).getByRole('textbox', { name: 'Your rules' }), { target: { value: 'Skip merged CRs.' } });
    fireEvent.click(within(rules).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(getCompanionState().snapshot?.rules).toBe('Skip merged CRs.'));
    expect(mocks.saveRules).toHaveBeenCalledWith('Skip merged CRs.');
  });

  it('keeps what the user is typing in the notes when a check-in saves its own, and says so', async () => {
    render(<CompanionSettings />);
    const notes = section('Notes');
    const box = within(notes).getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Ignore the Foo pipeline.' } });
    act(() => adoptCompanionSnapshot(named({ notes: 'Tracking CR-123 and CR-456.', notesRevision: 4 })));
    expect(box.value).toBe('Ignore the Foo pipeline.');
    expect(within(notes).getByRole('status').textContent).toContain('Robin updated these notes while you were editing');
    fireEvent.click(within(notes).getByRole('button', { name: 'Discard' }));
    expect(box.value).toBe('Tracking CR-123 and CR-456.');
    expect(within(notes).queryByRole('status')).toBeNull();
  });

  it('says when a check-in wrote the notes, and Keep saves them unchanged so the conversation reads them again', async () => {
    resetCompanionStoreForTests({ snapshot: named({ notes: 'Tracking CR-9.', notesOrigin: 'checkin' }) });
    mocks.saveNotes.mockResolvedValueOnce({ notes: 'Tracking CR-9.', notesRevision: 3 });
    render(<CompanionSettings />);
    const notes = section('Notes');
    expect(within(notes).getByRole('note').textContent).toBe('Written by Robin during a check-in. Your conversation with Robin doesn’t read them until you keep or edit them.');
    fireEvent.click(within(notes).getByRole('button', { name: 'Keep' }));
    expect(mocks.saveNotes).toHaveBeenCalledWith('Tracking CR-9.');
    await waitFor(() => expect(within(section('Notes')).queryByRole('note')).toBeNull());
    expect(getCompanionState().snapshot?.notesOrigin).toBe('user');
    expect(within(section('Notes')).queryByRole('button', { name: 'Keep' })).toBeNull();
  });

  it('marks a goal a check-in wrote, and Keep saves it unchanged as the user’s', async () => {
    const goal = { id: 'g1', text: 'Ship v2', progress: null, progressAt: null, createdAt: 1, updatedAt: 1 };
    resetCompanionStoreForTests({ snapshot: named({ goals: [{ ...goal, textOrigin: 'checkin' }, { id: 'g2', text: 'Mine', progress: null, progressAt: null, createdAt: 1, updatedAt: 1 }] }) });
    mocks.updateGoal.mockResolvedValueOnce({ ...goal, textOrigin: 'user' });
    render(<CompanionSettings />);
    const goals = section('Goals');
    expect(within(goals).getByText('Ship v2').closest('li')!.textContent).toContain('Written by Robin');
    expect(within(goals).getByText('Mine').closest('li')!.textContent).not.toContain('Written by');
    expect(within(goals).queryByRole('button', { name: 'Keep goal: Mine' })).toBeNull();
    fireEvent.click(within(goals).getByRole('button', { name: 'Keep goal: Ship v2' }));
    expect(mocks.updateGoal).toHaveBeenCalledWith('g1', 'Ship v2');
    await waitFor(() => expect(within(section('Goals')).queryByText(/Written by Robin/)).toBeNull());
  });

  it('offers only the local source included in the public build', () => {
    render(<CompanionSettings />);
    expect(screen.queryByRole('textbox', { name: 'Pipelines to watch' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Email' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Michi conversations' })).toBeTruthy();
  });

  it('undoes a quieter type the user asked for', async () => {
    resetCompanionStoreForTests({ snapshot: named({ demotedSubtypes: ['email_unread'] }) });
    mocks.undoDemotion.mockResolvedValueOnce(undefined);
    render(<CompanionSettings />);
    const quieter = section('Quieter after your feedback');
    expect(within(quieter).getByText('Unread email')).toBeTruthy();
    fireEvent.click(within(quieter).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Quieter after your feedback' })).toBeNull());
    expect(mocks.undoDemotion).toHaveBeenCalledWith('email_unread');
  });

  it('lists what each check-in did and changed, with Undo all, and links a post to the chat', async () => {
    resetCompanionStoreForTests({ snapshot: named({ activity: [
      run('r1', { postedMessageId: 'cmp-post-r1', changes: [
        { kind: 'page', id: 'p1', title: 'Tasks', applied: 3, proposed: 0 },
        { kind: 'item', id: 'i1', applied: 1, proposed: 0, action: 'snooze', reason: 'Later' },
        { kind: 'goal', id: 'g1', applied: 1, proposed: 0, action: 'reword' },
      ] }),
      run('r2', { changes: [{ kind: 'database', id: 'd1', applied: 2, proposed: 1 }], undoneAt: 5 }),
      run('r3', { outcome: 'superseded', detail: '412 characters' }),
      run('r4', { outcome: 'quiet' }),
      // D21: follow-ups it sent itself, which Undo all cannot take back.
      run('r5', { kind: 'worker_report', changes: [
        { kind: 'send', id: 'n-w1', title: 'Fix CI', applied: 1, proposed: 0 },
        { kind: 'send', id: 'n-w1', title: 'Fix CI', applied: 1, proposed: 0 },
        { kind: 'send', id: 'n-w2', applied: 1, proposed: 0 },
      ] }),
      run('r6', { changes: [
        { kind: 'goal', id: 'g2', applied: 1, proposed: 0, action: 'add' },
        { kind: 'send', id: 'n-w1', title: 'Fix CI', applied: 1, proposed: 0 },
      ] }),
    ] }) });
    mocks.undoRun.mockResolvedValueOnce({ reverted: ['c1', 'c2'], conflicts: [{ changeId: 'c3', message: 'Someone edited “Risks” since.' }] });
    render(<CompanionSettings />);
    const rows = within(section('Activity')).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Check-in · posted · Changed 3 blocks on “Tasks”, snoozed 1 item and reworded 1 goal');
    expect(rows[1]!.textContent).toContain('Changed 2 rows on a database and suggested 1 change on a database · Undone');
    expect(within(rows[1]!).queryByRole('button', { name: 'Undo all' })).toBeNull();
    expect(rows[2]!.textContent).toContain('Check-in · not posted: you wrote first · 412 characters');
    expect(rows[3]!.textContent).toContain('Check-in · nothing to say');
    expect(within(rows[3]!).queryByRole('button')).toBeNull();
    expect(rows[4]!.textContent).toContain('Sent 2 follow-ups to “Fix CI” and sent 1 follow-up to a conversation');
    expect(within(rows[4]!).queryByRole('button', { name: 'Undo all' })).toBeNull();
    expect(rows[5]!.textContent).toContain('Added 1 goal and sent 1 follow-up to “Fix CI”');
    expect(within(rows[5]!).getByRole('button', { name: 'Undo all' })).toBeTruthy();

    // §2.7: View in chat goes to the post itself.
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'View in chat' }));
    expect(mocks.openPanel).toHaveBeenCalledWith({ focusMessageId: 'cmp-post-r1' });
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Undo all' }));
    expect(mocks.undoRun).toHaveBeenCalledWith('r1');
    expect((await within(rows[0]!).findByRole('status')).textContent).toContain('Undid 2 changes; 1 change changed since: Someone edited “Risks” since.');
  });

  it('lists the conversations it follows; Ask before sending can only be turned back on', async () => {
    resetCompanionStoreForTests({ snapshot: named({ delegations: [
      delegation('a', { autoSend: true }), delegation('b'), delegation('c', { state: 'closed', closedReason: 'took_over' }),
    ] }) });
    mocks.stopAutoSend.mockResolvedValueOnce(delegation('a', { autoSend: false }));
    render(<CompanionSettings />);
    const follows = within(section('Activity')).getByRole('group', { name: 'Conversations Robin follows' });
    expect(within(follows).queryByText('Worker c')).toBeNull();
    const asked = within(follows).getByRole('switch', { name: 'Ask before sending to Worker b' });
    expect(asked.getAttribute('aria-checked')).toBe('true');
    expect(asked).toHaveProperty('disabled', true);
    const unasked = within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' });
    expect(unasked.getAttribute('aria-checked')).toBe('false');
    expect(unasked.closest('.settings-row')!.textContent).toContain('Follow-ups you ask Robin for go here without asking you first.');
    // The switch is about the user's own follow-ups; check-ins may still send to a conversation that runs in Ask (Q1).
    const checkins = 'Check-ins only suggest a follow-up for you to apply, unless this conversation runs in Ask: then Robin may send it directly, and the conversation’s tools still ask you first.';
    expect(unasked.closest('.settings-row')!.textContent).toContain(checkins);
    expect(asked.closest('.settings-row')!.textContent).toContain('When you ask Robin for a follow-up here, it shows you the text before sending.');
    expect(asked.closest('.settings-row')!.textContent).toContain(checkins);
    expect(asked.closest('.settings-row')!.textContent).not.toContain('asks you before each follow-up it sends');
    fireEvent.click(unasked);
    expect(mocks.stopAutoSend).toHaveBeenCalledWith('a');
    await waitFor(() => expect(within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' }).getAttribute('aria-checked')).toBe('true'));
    expect(within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' })).toHaveProperty('disabled', true);
    expect(getCompanionState().snapshot?.delegations?.find((entry) => entry.id === 'a')?.autoSend).toBe(false);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('shows what the server answered when Ask before sending did not take, and reads again', async () => {
    resetCompanionStoreForTests({ snapshot: named({ delegations: [delegation('a', { autoSend: true })] }) });
    mocks.stopAutoSend.mockResolvedValueOnce(delegation('a', { autoSend: true }));
    render(<CompanionSettings />);
    const follows = within(section('Activity')).getByRole('group', { name: 'Conversations Robin follows' });
    fireEvent.click(within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' }));
    expect((await within(follows).findByRole('alert')).textContent).toBe('Robin still sends here without asking. Try again.');
    const row = within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row).toHaveProperty('disabled', false);
    expect(getCompanionState().snapshot?.delegations?.[0]?.autoSend).toBe(true);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('starts a new conversation only after asking, and says when the agent is busy', async () => {
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mocks.reset.mockRejectedValueOnce(new AssistantApiError(409, 'The assistant is still answering'));
    const fresh = named({ conversation: { ...base.conversation!, nodeId: 'v-2' } });
    mocks.reset.mockResolvedValueOnce(fresh);
    render(<CompanionSettings />);
    const conversation = section('Conversation');
    fireEvent.click(within(conversation).getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.reset).not.toHaveBeenCalled();
    fireEvent.click(within(conversation).getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(conversation.textContent).toContain('Robin is answering right now. Try again when it’s done.'));
    expect(mocks.reset).toHaveBeenLastCalledWith('companion-node');
    fireEvent.click(within(conversation).getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(getCompanionState().snapshot?.conversation?.nodeId).toBe('v-2'));
    // §1.5 item 9: History opens the panel's History itself.
    fireEvent.click(within(section('Conversation')).getByRole('button', { name: 'Open History' }));
    expect(mocks.openPanel).toHaveBeenCalledWith({ history: true });
  });

  it('links to the chat notifications and to when Michi’s windows are closed', () => {
    const open = vi.fn();
    render(<SettingsOpenContext.Provider value={open}><CompanionSettings /></SettingsOpenContext.Provider>);
    const notifications = section('Notifications');
    expect(notifications.textContent).toContain('Only what Robin sends on its own: the check-ins it posts, the morning brief and Today’s items.');
    fireEvent.click(within(notifications).getByRole('button', { name: 'Settings › Notifications' }));
    expect(open).toHaveBeenLastCalledWith('notifications', 'Notifications');
    fireEvent.click(within(section(WINDOWS_CLOSED_TITLE)).getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenLastCalledWith('notifications', WINDOWS_CLOSED_TITLE);
  });

  it('leaves the windows-closed link out on a phone, which has no such section', () => {
    render(<SettingsLayoutContext.Provider value="phone"><CompanionSettings /></SettingsLayoutContext.Provider>);
    expect(screen.queryByRole('region', { name: WINDOWS_CLOSED_TITLE })).toBeNull();
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeTruthy();
  });

  it('still shows Pages upkeep on a backend without check-ins', async () => {
    resetCompanionStoreForTests({ availability: 'unavailable' });
    render(<CompanionSettings />);
    await flush();
    expect(screen.getByText('Michi’s check-ins aren’t available on this backend.')).toBeTruthy();
    expect(within(section('Pages upkeep')).getByRole('radio', { name: /Follow global settings/ })).toBeTruthy();
  });
});
