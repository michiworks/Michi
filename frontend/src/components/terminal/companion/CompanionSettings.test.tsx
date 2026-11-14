import React from 'react';
import type { CompanionSourceStatus } from 'michi-shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities, AgentModelInfo } from '../../../services/api/agentRuntime';
import { CompanionApiError } from '../../../services/api/companion';
import type { MetaAgentInfo } from '../../../services/api/metaAgent';
import { adoptCompanionSnapshot, getCompanionState, resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { resetMetaAgentStore } from '../../../state/metaAgent/useMetaAgent';
import { companionSnapshot } from '../../../test/companionFixtures';
import { SettingsOpenContext } from '../pages/settings/settingsPhone';
import { settingsSearchIndex } from '../rail/settingsSearch';
import { resetMetaAgentOverviewStore } from '../../../state/metaAgent/useMetaAgentOverview';
import CompanionSettings from './CompanionSettings';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  undoDemotion: vi.fn(),
  saveRules: vi.fn(),
  saveNotes: vi.fn(),
  updateGoal: vi.fn(),
  refresh: vi.fn(),
  memoryStatus: vi.fn(),
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
  undoCompanionDemotion: mocks.undoDemotion,
  saveCompanionRules: mocks.saveRules,
  saveCompanionNotes: mocks.saveNotes,
  updateCompanionGoal: mocks.updateGoal,
}));
vi.mock('../../../services/api/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/memories')>()),
  fetchMemoryExtractionStatus: mocks.memoryStatus,
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
  // Memory on, learning from conversations off: a new install (Q28).
  mocks.memoryStatus.mockResolvedValue({ enabled: true, paused: true, lastRunAt: null, lastError: null, todayTokens: 0, dailyTokenLimit: null });
});
const row = (label: string) => {
  const name = Array.from(document.querySelectorAll('.settings-row__label')).find((element) => element.textContent?.trim() === label);
  if (!name) throw new Error(`No row ${label}`);
  return name.closest('.settings-row') as HTMLElement;
};
afterEach(() => resetCompanionStoreForTests());

describe('Settings › <name>', () => {
  it('lists its sections in order, with no intro paragraphs, and never says Meta agent or Companion', async () => {
    render(<CompanionSettings />);
    await flush();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual(['Robin', 'Model', 'Watching', 'Updates', 'Instructions', 'Pages']);
    expect(document.querySelector('.settings-section__intro')).toBeNull();
    expect(document.body.textContent).not.toMatch(/meta agent/i);
    expect(document.body.textContent).not.toMatch(/\bCompanion\b/);
    expect((within(section('Robin')).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Robin');
    // Moved away (Q31): Activity and the followed conversations are in the panel's menu; New conversation and History were already there.
    for (const gone of ['Activity', 'Conversation', 'Pause', 'Your rules', 'Working notes', 'Goals', 'Pages upkeep', 'When Michi’s windows are closed']) {
      expect(screen.queryByRole('region', { name: gone }), gone).toBeNull();
    }
    // The Codex and Kiro trust note is in the built-in docs (permissions.md) now.
    expect(document.body.textContent).not.toContain('allowedTools');
  });

  it('shows every setting Settings search names on this page, by the same name', async () => {
    render(<CompanionSettings />);
    await flush();
    const shown = new Set(Array.from(document.querySelectorAll('.settings-row__label, .settings-section__title')).map((label) => label.textContent?.trim()));
    const missing = settingsSearchIndex('Robin').filter((entry) => entry.page === 'companion' && !shown.has(entry.label)).map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it('turns Robin on and off with one switch (Q30): no timed pause, and off leaves every setting shown and editable (Q33)', async () => {
    resetCompanionStoreForTests({ snapshot: named({ settings: { ...base.settings, paused: true } }) });
    mocks.patch.mockResolvedValueOnce(named({ settings: { ...base.settings, paused: false } }));
    render(<CompanionSettings />);
    const robin = section('Robin');
    const power = within(robin).getByRole('switch', { name: 'Robin' });
    expect(power.getAttribute('aria-checked')).toBe('false');
    expect(row('Robin').textContent).toContain('Off · settings apply when on');
    for (const gone of ['1 hour', 'Until tomorrow', 'Until I resume', 'Resume']) expect(screen.queryByRole('button', { name: gone }), gone).toBeNull();
    // Off: nothing is greyed out or folded away.
    expect(screen.getByRole('switch', { name: 'Michi conversations' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('switch', { name: 'Morning brief' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('heading', { name: 'Instructions' })).toBeTruthy();
    fireEvent.click(power);
    expect(mocks.patch).toHaveBeenLastCalledWith({ paused: false });
    await waitFor(() => expect(within(section('Robin')).getByRole('switch', { name: 'Robin' }).getAttribute('aria-checked')).toBe('true'));
    expect(row('Robin').textContent).not.toContain('Off ·');
    expect(getCompanionState().snapshot?.settings.paused).toBe(false);
    mocks.patch.mockResolvedValueOnce(named({ settings: { ...base.settings, paused: true } }));
    fireEvent.click(within(section('Robin')).getByRole('switch', { name: 'Robin' }));
    expect(mocks.patch).toHaveBeenLastCalledWith({ paused: true });
    expect(mocks.patch.mock.calls.some(([patch]) => 'pauseFor' in patch)).toBe(false);
  });

  it('says what it is doing beside its name only while it is on', () => {
    resetCompanionStoreForTests({ snapshot: named({ settings: { ...base.settings, paused: false } }) });
    const view = render(<CompanionSettings />);
    expect(section('Robin').querySelector('.settings-section__aside')?.textContent).toMatch(/^Watching · /);
    view.unmount();
    resetCompanionStoreForTests({ snapshot: named({ settings: { ...base.settings, paused: true } }) });
    render(<CompanionSettings />);
    expect(section('Robin').querySelector('.settings-section__aside')).toBeNull();
  });

  it('turns one source off; a source shows its state only when it is not working, and Options opens its settings in place', () => {
    const source = (kind: CompanionSourceStatus['kind'], state: CompanionSourceStatus['state'], detail: string | null = null): CompanionSourceStatus => ({
      kind, state, detail, lastPolledAt: Date.now() - 60_000, nextPollAt: null,
    });
    const sources = [source('michi', 'ok'), source('cr', 'ok'), source('pipeline', 'error', 'Auth expired — refresh your credentials'), source('email', 'disabled'), source('calendar', 'pending')];
    resetCompanionStoreForTests({ snapshot: named({ settings: { ...base.settings, sources: { ...base.settings.sources, pipeline: { ...base.settings.sources.pipeline, enabled: true } } }, status: { ...base.status, sources } }) });
    mocks.patch.mockResolvedValue(base);
    render(<CompanionSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Michi conversations' }));
    expect(mocks.patch).toHaveBeenLastCalledWith({ sources: { michi: { enabled: !base.settings.sources.michi.enabled } } });
  });

  it('chooses the morning brief’s days: Weekdays, Every day, or Custom with a button for each day', () => {
    mocks.patch.mockResolvedValue(base);
    render(<CompanionSettings />);
    const days = within(section('Updates')).getByRole('combobox', { name: 'Morning brief days' }) as HTMLSelectElement;
    expect(days.value).toBe('weekdays');
    expect(screen.queryByRole('group', { name: 'Morning brief days of the week' })).toBeNull();
    fireEvent.change(days, { target: { value: 'every' } });
    expect(mocks.patch).toHaveBeenLastCalledWith({ brief: { days: [0, 1, 2, 3, 4, 5, 6] } });
    fireEvent.change(days, { target: { value: 'custom' } });
    const week = screen.getByRole('group', { name: 'Morning brief days of the week' });
    expect(within(week).getAllByRole('button').filter((day) => day.getAttribute('aria-pressed') === 'true').map((day) => day.textContent))
      .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    fireEvent.click(within(week).getByRole('button', { name: 'Sat' }));
    expect(mocks.patch).toHaveBeenLastCalledWith({ brief: { days: [1, 2, 3, 4, 5, 6] } });
    for (const gone of ['Check-in interval', 'Check every (minutes)', 'Quiet hours', 'Workdays']) {
      expect(screen.queryByLabelText(gone), gone).toBeNull();
    }
  });

  it('keeps at least one morning brief day', () => {
    resetCompanionStoreForTests({ snapshot: named({ settings: { ...base.settings, brief: { ...base.settings.brief, days: [3] } } }) });
    render(<CompanionSettings />);
    expect((screen.getByRole('combobox', { name: 'Morning brief days' }) as HTMLSelectElement).value).toBe('custom');
    const wednesday = within(screen.getByRole('group', { name: 'Morning brief days of the week' })).getByRole('button', { name: 'Wed' }) as HTMLButtonElement;
    expect(wednesday.disabled).toBe(true);
    fireEvent.click(wednesday);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('says when a setting could not be saved', async () => {
    mocks.patch.mockRejectedValueOnce(new CompanionApiError(400, 'displayName must be at most 40 characters'));
    render(<CompanionSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Robin' }));
    expect((await screen.findByRole('alert')).textContent).toBe('displayName must be at most 40 characters');
  });

  it('shows what conversations run on with a link to Runtime & model, and Background work is Same as conversations or Custom', async () => {
    const open = vi.fn();
    render(<SettingsOpenContext.Provider value={open}><CompanionSettings /></SettingsOpenContext.Provider>);
    await flush();
    expect(row('Conversations').textContent).toContain('Claude · Opus 5.5');
    fireEvent.click(within(row('Conversations')).getByRole('button', { name: 'Runtime & model' }));
    expect(open).toHaveBeenLastCalledWith('runtime');
    const work = within(section('Model')).getByRole('combobox', { name: 'Background work' }) as HTMLSelectElement;
    expect(work.value).toBe('same');
    expect(Array.from(work.options).map((option) => option.textContent)).toEqual(['Same as conversations', 'Custom']);
    // Runtime, Model and Reasoning rows only under Custom.
    for (const gone of ['Background work runtime', 'Background work model', 'Background work reasoning']) {
      expect(within(section('Model')).queryByRole('combobox', { name: gone }), gone).toBeNull();
    }
  });

  it('previews the rules, notes and goals, and Edit opens each in place', async () => {
    resetCompanionStoreForTests({ snapshot: named({ rules: 'Skip merged CRs.\nNo email at night.', notes: '', goals: [] }) });
    mocks.saveRules.mockResolvedValueOnce('Skip pipelines.');
    render(<CompanionSettings />);
    expect(row('Your rules').querySelector('.settings-row__desc')?.textContent).toBe('Skip merged CRs.');
    expect(row('Working notes').querySelector('.settings-row__desc')?.textContent).toBe('None');
    expect(row('Goals').querySelector('.settings-row__desc')?.textContent).toBe('None');
    expect(screen.queryByRole('textbox', { name: 'Your rules' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit your rules' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your rules' }), { target: { value: 'Skip pipelines.' } });
    fireEvent.click(within(row('Your rules')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(getCompanionState().snapshot?.rules).toBe('Skip pipelines.'));
    expect(mocks.saveRules).toHaveBeenCalledWith('Skip pipelines.');
    fireEvent.click(screen.getByRole('button', { name: 'Done editing your rules' }));
    expect(screen.queryByRole('textbox', { name: 'Your rules' })).toBeNull();
  });

  it('keeps what the user is typing in the notes when a check-in saves its own, and says so', async () => {
    render(<CompanionSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit working notes' }));
    const notes = row('Working notes');
    const box = within(notes).getByRole('textbox', { name: 'Working notes' }) as HTMLTextAreaElement;
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
    expect(row('Working notes').querySelector('.settings-row__desc')?.textContent).toBe('Written by Robin · Tracking CR-9.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit working notes' }));
    const notes = row('Working notes');
    expect(within(notes).getByRole('note').textContent).toBe('Your conversation with Robin doesn’t read notes Robin wrote during a check-in until you keep or edit them.');
    fireEvent.click(within(notes).getByRole('button', { name: 'Keep' }));
    expect(mocks.saveNotes).toHaveBeenCalledWith('Tracking CR-9.');
    await waitFor(() => expect(within(row('Working notes')).queryByRole('note')).toBeNull());
    expect(getCompanionState().snapshot?.notesOrigin).toBe('user');
    expect(within(row('Working notes')).queryByRole('button', { name: 'Keep' })).toBeNull();
    expect(row('Working notes').querySelector('.settings-row__desc')?.textContent).toBe('Tracking CR-9.');
  });

  it('marks a goal a check-in wrote, and Keep saves it unchanged as the user’s', async () => {
    const goal = { id: 'g1', text: 'Ship v2', progress: null, progressAt: null, createdAt: 1, updatedAt: 1 };
    resetCompanionStoreForTests({ snapshot: named({ goals: [{ ...goal, textOrigin: 'checkin' }, { id: 'g2', text: 'Mine', progress: null, progressAt: null, createdAt: 1, updatedAt: 1 }] }) });
    mocks.updateGoal.mockResolvedValueOnce({ ...goal, textOrigin: 'user' });
    render(<CompanionSettings />);
    expect(row('Goals').querySelector('.settings-row__desc')?.textContent).toBe('2 goals');
    fireEvent.click(screen.getByRole('button', { name: 'Edit goals' }));
    const goals = row('Goals');
    expect(within(goals).getByText('Ship v2').closest('li')!.textContent).toContain('Written by Robin');
    expect(within(goals).getByText('Mine').closest('li')!.textContent).not.toContain('Written by');
    expect(within(goals).queryByRole('button', { name: 'Keep goal: Mine' })).toBeNull();
    fireEvent.click(within(goals).getByRole('button', { name: 'Keep goal: Ship v2' }));
    expect(mocks.updateGoal).toHaveBeenCalledWith('g1', 'Ship v2');
    await waitFor(() => expect(within(row('Goals')).queryByText(/Written by Robin/)).toBeNull());
  });

  it('shows Memory as Settings › Memory has it, learning from conversations off by default (Q28), with the way there', async () => {
    const open = vi.fn();
    render(<SettingsOpenContext.Provider value={open}><CompanionSettings /></SettingsOpenContext.Provider>);
    await waitFor(() => expect(row('Memory').textContent).toContain('Learn from conversations: Off'));
    fireEvent.click(within(row('Memory')).getByRole('button', { name: 'Settings › Memory' }));
    expect(open).toHaveBeenLastCalledWith('memory');
  });

  it('offers only the local source included in the public build', () => {
    render(<CompanionSettings />);
    expect(screen.queryByRole('textbox', { name: 'Pipelines to watch' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Email' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Michi conversations' })).toBeTruthy();
  });

  it('undoes a quieter type the user asked for, and shows no Quieter row without one', async () => {
    resetCompanionStoreForTests({ snapshot: named({ demotedSubtypes: ['email_unread'] }) });
    mocks.undoDemotion.mockResolvedValueOnce(undefined);
    render(<CompanionSettings />);
    const quieter = row('Quieter after your feedback');
    expect(within(quieter).getByText('Unread email')).toBeTruthy();
    fireEvent.click(within(quieter).getByRole('button', { name: 'Undo: Unread email' }));
    await waitFor(() => expect(screen.queryByText('Quieter after your feedback')).toBeNull());
    expect(mocks.undoDemotion).toHaveBeenCalledWith('email_unread');
  });

  it('has no notification level or windows-closed link of its own: Settings › Notifications has them', () => {
    render(<CompanionSettings />);
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Robin notifications' })).toBeNull();
    expect(screen.queryByText(/windows are closed/)).toBeNull();
  });

  it('still shows Background work and Pages on a backend without check-ins', async () => {
    resetCompanionStoreForTests({ availability: 'unavailable' });
    render(<CompanionSettings />);
    await flush();
    expect(screen.getByText('Michi’s check-ins aren’t available on this backend.')).toBeTruthy();
    expect(within(section('Model')).getByRole('combobox', { name: 'Background work' })).toBeTruthy();
    expect(within(section('Pages')).getByRole('switch', { name: 'Keep workspace homes up to date' })).toBeTruthy();
  });
});
