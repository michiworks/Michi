import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MetaAgentGuardStatus } from 'michi-shared';
import type { MetaAgentInfo } from '../../../../services/api/metaAgent';
import type { AgentCapabilities, AgentModelInfo } from '../../../../services/api/agentRuntime';
import { MetaAgentApiError } from '../../../../services/api/metaAgent';
import { resetMetaAgentStore } from '../../../../state/metaAgent/useMetaAgent';
import { resetMetaAgentOverviewStore } from '../../../../state/metaAgent/useMetaAgentOverview';
import { BackgroundWorkSettings, PagesUpkeepSettings } from './MetaAgentSettings';

const api = vi.hoisted(() => ({
  fetchMetaAgent: vi.fn(),
  updateMetaAgentSettings: vi.fn(),
  retryMetaAgentGuard: vi.fn(),
  fetchAgentStatus: vi.fn(),
  fetchOverview: vi.fn(),
  setPaused: vi.fn(),
  runUpdate: vi.fn(),
}));
const catalog = vi.hoisted(() => ({
  value: {
    models: [] as AgentModelInfo[],
    providers: [],
    capabilities: null as AgentCapabilities | null,
    loading: false,
    waiting: false,
    error: null as string | null,
    retry: vi.fn(),
  },
  calls: [] as Array<{ runtime?: string | null; connectionId?: string }>,
}));

vi.mock('../../../../services/api/metaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/metaAgent')>()),
  fetchMetaAgent: api.fetchMetaAgent,
  updateMetaAgentSettings: api.updateMetaAgentSettings,
  retryMetaAgentGuard: api.retryMetaAgentGuard,
}));
vi.mock('../../../../services/api/agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/agentRuntime')>()),
  fetchAgentStatus: api.fetchAgentStatus,
}));
vi.mock('../../../../services/api/metaAgentOverview', () => ({
  fetchMetaAgentOverview: api.fetchOverview,
  setMetaAgentPaused: api.setPaused,
}));
vi.mock('../../../../services/api/pageMaintenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/pageMaintenance')>()),
  runMetaAgentRoundNow: api.runUpdate,
}));
vi.mock('../../../../hooks/useRuntimeCatalog', () => ({
  useRuntimeCatalog: (opts: { runtime?: string | null }) => {
    catalog.calls.push(opts);
    return catalog.value;
  },
}));

const CAPS: AgentCapabilities = {
  modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
  saveContext: false, spawnBranches: false, nativeResume: false,
};
const MODELS: AgentModelInfo[] = [
  { id: 'gpt-5.5-codex', label: 'GPT 5.5 Codex', supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
  { id: 'gpt-mini', label: 'GPT mini', supportsReasoning: false },
];
const AGENT_STATUS = {
  runtime: 'claude', model: 'claude-opus-5.5', reasoning: 'high',
  availableRuntimes: ['claude', 'pi', 'codex', 'kiro', 'crew'].map((id) => ({ id, label: id, available: true })),
};

const FOLLOW: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const CUSTOM_CODEX: MetaAgentInfo = {
  settings: { runtimeId: 'codex', providerId: null, modelId: 'gpt-5.5-codex', reasoning: 'high' },
  resolved: { runtimeId: 'codex', providerId: null, modelId: 'gpt-5.5-codex', reasoning: 'high', followsGlobal: false },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const followOn = (runtimeId: string, modelId: string | null = null): MetaAgentInfo => ({
  ...FOLLOW, resolved: { runtimeId, providerId: null, modelId, reasoning: null, followsGlobal: true },
});
const failed = (overrides: Partial<MetaAgentGuardStatus> = {}): MetaAgentGuardStatus => ({
  state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['execute_bash', 'fs_write'],
  detail: 'Kiro published 2 tools outside the allow-list', checkedAt: Date.UTC(2026, 9, 23, 9, 41), ...overrides,
});

const overview = (state: 'running' | 'paused' | 'error') => ({
  state, runtime: FOLLOW.resolved, today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
  cursors: [], recentRuns: [],
});

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

/** Settings › <name>: Background work under Model, and the Pages upkeep section; `only` renders one of them. */
async function mount(info: MetaAgentInfo | Error = FOLLOW, only?: 'runtime' | 'pages') {
  if (info instanceof Error) api.fetchMetaAgent.mockRejectedValue(info);
  else api.fetchMetaAgent.mockResolvedValue(info);
  render(<>{only !== 'pages' && <BackgroundWorkSettings />}{only !== 'runtime' && <PagesUpkeepSettings />}</>);
  await flush();
}

const choice = () => screen.getByRole('combobox', { name: 'Background work' }) as HTMLSelectElement;
const chooseCustom = () => fireEvent.change(choice(), { target: { value: 'custom' } });
const runtimeChoice = () => screen.getByRole('combobox', { name: 'Background work runtime' }) as HTMLSelectElement;
const lastPatch = () => api.updateMetaAgentSettings.mock.calls.at(-1)?.[0];
/** A row by its name, as Settings shows it. */
const row = (label: string) => {
  const name = Array.from(document.querySelectorAll('.settings-row__label')).find((element) => element.textContent?.trim() === label);
  if (!name) throw new Error(`No row ${label}`);
  return name.closest('.settings-row') as HTMLElement;
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  resetMetaAgentStore();
  resetMetaAgentOverviewStore();
  api.fetchOverview.mockResolvedValue(overview('running'));
  catalog.calls = [];
  catalog.value = { ...catalog.value, models: MODELS, capabilities: CAPS, loading: false, error: null, retry: vi.fn() };
  api.fetchAgentStatus.mockResolvedValue(AGENT_STATUS);
});
afterEach(() => cleanup());

describe('Settings › <name> › Model › Background work', () => {
  it('is Same as conversations by default: one row, no runtime, model or reasoning of its own', async () => {
    await mount(FOLLOW, 'runtime');
    expect(choice().value).toBe('same');
    expect(Array.from(choice().options).map((option) => option.textContent)).toEqual(['Same as conversations', 'Custom']);
    expect(screen.queryByRole('combobox', { name: 'Background work runtime' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Background work model' })).toBeNull();
    // No "Saved" tick and no descriptions under the choices.
    expect(document.body.textContent).not.toMatch(/Saved|Same as your chats|follow it from their next run/);
  });

  it('pins what it runs on now when Custom is chosen, then offers the supported available runtimes as rows', async () => {
    await mount();
    api.updateMetaAgentSettings.mockResolvedValue({
      ...FOLLOW, settings: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high' },
      resolved: { ...FOLLOW.resolved, followsGlobal: false },
    });
    chooseCustom();
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high' });
    expect(Array.from(runtimeChoice().options).map((option) => option.textContent)).toEqual(['Claude', 'Codex', 'Pi', 'Kiro']);
    expect(runtimeChoice().value).toBe('claude');
    for (const label of ['Runtime', 'Model']) expect(row(label)).toBeTruthy();
  });

  it('switches the custom runtime with the new runtime’s defaults', async () => {
    await mount(CUSTOM_CODEX);
    api.updateMetaAgentSettings.mockResolvedValue({
      ...CUSTOM_CODEX, settings: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null },
      resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: false },
    });
    fireEvent.change(runtimeChoice(), { target: { value: 'kiro' } });
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null });
    expect(runtimeChoice().value).toBe('kiro');
  });

  it('says what each “Default” stands for', async () => {
    await mount({
      ...CUSTOM_CODEX,
      settings: { runtimeId: 'codex', providerId: null, modelId: null, reasoning: null },
      resolved: { runtimeId: 'codex', providerId: null, modelId: 'gpt-5.5-codex', reasoning: 'high', followsGlobal: false },
    });
    const first = (name: string) => (screen.getByRole('combobox', { name }) as HTMLSelectElement).options[0]!.textContent;
    expect(first('Background work model')).toBe('Default (GPT 5.5 Codex)');
    expect(first('Background work reasoning')).toBe('Default (High)');
    cleanup();

    // A value picked by hand needs no explanation.
    await mount(CUSTOM_CODEX);
    expect(first('Background work model')).toBe('Default');
    expect(first('Background work reasoning')).toBe('Default');
  });

  it('explains when the runtime it follows cannot run it, and switches to the first runtime that can', async () => {
    const reason = 'The Meta agent does not run on Kiro Crew yet. Choose another runtime for it in Settings › Meta agent.';
    await mount({ ...followOn('crew'), availability: { available: false, reason } }, 'runtime');
    const notice = within(row('Background work')).getByRole('status');
    expect(notice.textContent).toContain(reason);
    api.updateMetaAgentSettings.mockResolvedValue({
      ...CUSTOM_CODEX, settings: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null },
      resolved: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: false },
    });
    fireEvent.click(within(notice).getByRole('button', { name: 'Use a custom runtime' }));
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: 'claude', providerId: null, modelId: null, reasoning: null });
    expect(within(row('Background work')).queryByRole('status')).toBeNull();
  });

  it('hides unavailable runtime choices while retaining diagnostics for an unavailable saved selection', async () => {
    api.fetchAgentStatus.mockResolvedValue({
      ...AGENT_STATUS,
      availableRuntimes: AGENT_STATUS.availableRuntimes.map((runtime) => runtime.id === 'claude'
        ? { ...runtime, available: false, unavailableReason: 'claude binary not found. Install with: npm install -g @anthropic-ai/claude-code.' }
        : runtime.id === 'kiro' ? { ...runtime, available: false, unavailableReason: 'kiro-cli not found' } : runtime),
    });
    await mount({ ...CUSTOM_CODEX, settings: { ...CUSTOM_CODEX.settings, runtimeId: 'claude' } });
    // The saved choice stays listed so the select shows it; the others that can't run are left out.
    expect(Array.from(runtimeChoice().options).map((option) => option.textContent)).toEqual(['Claude', 'Codex', 'Pi']);
    expect(within(row('Runtime')).getByText('Claude isn’t installed on this computer.')).toBeTruthy();
    expect(screen.queryByText('Kiro isn’t installed on this computer.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to install' }));
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code', { selector: 'code' })).toBeTruthy();
    // No Pi explanation; with nothing unavailable to explain, no note under Runtime.
    expect(screen.queryByText(/Pi runs inside Michi/)).toBeNull();
    cleanup();
    await mount(CUSTOM_CODEX);
    expect(row('Runtime').querySelector('.settings-row__note')).toBeNull();
  });

  it('sends nulls for every field when going back to the conversations’ settings', async () => {
    await mount(CUSTOM_CODEX);
    api.updateMetaAgentSettings.mockResolvedValue(FOLLOW);
    expect(choice().value).toBe('custom');
    fireEvent.change(choice(), { target: { value: 'same' } });
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: null, providerId: null, modelId: null, reasoning: null });
    expect(choice().value).toBe('same');
  });

  it('saves the custom model and reasoning through the runtime catalog', async () => {
    await mount(CUSTOM_CODEX);
    expect(catalog.calls.at(-1)).toMatchObject({ runtime: 'codex', connectionId: 'local' });
    api.updateMetaAgentSettings.mockResolvedValue(CUSTOM_CODEX);
    fireEvent.change(screen.getByRole('combobox', { name: 'Background work model' }), { target: { value: '' } });
    await flush();
    expect(lastPatch()).toEqual({ modelId: null });
    fireEvent.change(screen.getByRole('combobox', { name: 'Background work reasoning' }), { target: { value: 'low' } });
    await flush();
    expect(lastPatch()).toEqual({ reasoning: 'low' });
    // A model without reasoning drops the explicit level.
    fireEvent.change(screen.getByRole('combobox', { name: 'Background work model' }), { target: { value: 'gpt-mini' } });
    await flush();
    expect(lastPatch()).toEqual({ modelId: 'gpt-mini', reasoning: null });
  });

  it('shows a save failure and keeps the stored choice', async () => {
    await mount(FOLLOW, 'runtime');
    api.updateMetaAgentSettings.mockRejectedValue(new MetaAgentApiError(400, 'Unknown runtime'));
    chooseCustom();
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Unknown runtime');
    expect(choice().value).toBe('same');
  });
});

describe('Settings › <name> › Pages upkeep guard failure', () => {
  it('shows a red box with the extra tools, and Retry clears the failed check', async () => {
    await mount({ ...followOn('kiro'), guard: { maintenance: failed(), chat: null } });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Michi stopped: Kiro started with extra tools');
    expect(within(alert).getAllByText(/^(execute_bash|fs_write)$/).map((node) => node.tagName)).toEqual(['CODE', 'CODE']);

    api.retryMetaAgentGuard.mockResolvedValue(followOn('kiro'));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.retryMetaAgentGuard).toHaveBeenCalledWith('maintenance');
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Michi stopped/)).toBeNull();
  });

  it('retries both checks when both failed, and keeps the box when the retry fails', async () => {
    const both = { ...followOn('kiro'), guard: { maintenance: failed(), chat: failed({ toolset: 'chat' }) } };
    await mount(both);
    api.retryMetaAgentGuard.mockRejectedValue(new MetaAgentApiError(500, 'Database is locked'));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.retryMetaAgentGuard).toHaveBeenCalledWith(undefined);
    expect(screen.getByText(/Michi stopped/)).toBeTruthy();
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false);
  });

  it('opens the details and moves to the runtime choice', async () => {
    await mount({ ...followOn('kiro'), guard: { maintenance: failed(), chat: failed({ toolset: 'chat', unexpectedTools: ['fs_write'], detail: undefined }) } });
    const alert = screen.getByRole('alert');
    expect(within(alert).getAllByText(/^(execute_bash|fs_write)$/)).toHaveLength(2);
    expect(within(alert).queryByText('Pages upkeep')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Details' }));
    expect(within(alert).getByText('Pages upkeep')).toBeTruthy();
    expect(within(alert).getByText('Check-ins')).toBeTruthy();
    expect(alert.textContent).toContain('Kiro published 2 tools outside the allow-list');
    expect(alert.textContent).toMatch(/Kiro · checked [A-Z][a-z]{2} \d{1,2}, \d{2}:41/);

    fireEvent.click(within(alert).getByRole('button', { name: 'Change runtime' }));
    expect(document.activeElement).toBe(choice());
  });

  it('has no red box while every check passed', async () => {
    await mount({ ...followOn('kiro'), guard: { maintenance: { ...failed(), state: 'ok', unexpectedTools: [] }, chat: null } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Settings › <name> › Pages upkeep stopped by errors', () => {
  const AUTH = 'Claude authentication failed. Refresh the CLI credentials and retry; the original session is retained.';
  const stopped = (reason: 'other' | 'runtime-unsupported' | 'signed-out', message: string, detail?: string) => ({
    ...overview('error'), error: message, stopped: { reason, message, ...(detail ? { detail } : {}), workspaceIds: ['w1'] },
  });

  it('a sign-in stop says it tries again on its own', async () => {
    api.fetchOverview.mockResolvedValue(stopped('signed-out', 'Claude\'s credentials were rejected', AUTH));
    await mount();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Claude\'s credentials were rejected. It tries again every hour, or press Retry once sign-in works.');
    expect(alert.textContent).toContain(AUTH);
    expect(alert.textContent).not.toContain('until it runs again');
  });

  it('says why it stopped, which is what raised the Settings dot, and Retry resumes and runs a round', async () => {
    api.fetchOverview.mockResolvedValue(stopped('other', AUTH));
    await mount();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Pages upkeep stopped');
    expect(alert.textContent).toContain(AUTH);

    api.setPaused.mockResolvedValue(overview('running'));
    api.fetchOverview.mockResolvedValue(overview('running'));
    api.runUpdate.mockResolvedValue({ workspaces: [] });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.setPaused).toHaveBeenCalledWith(false);
    expect(api.runUpdate).toHaveBeenCalledWith('local');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains a runtime the overview says cannot run it, without a Retry', async () => {
    api.fetchOverview.mockResolvedValue(stopped('runtime-unsupported', 'Codex is not installed on this computer'));
    await mount();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Pages upkeep isn’t running');
    expect(alert.textContent).toContain('Codex is not installed on this computer.');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Change runtime' }));
    expect(document.activeElement).toBe(choice());
  });

  it('leaves a failed tool check to its own red box', async () => {
    api.fetchOverview.mockResolvedValue({ ...stopped('other', AUTH), stopped: { reason: 'restriction-check', message: 'Its tool check failed', workspaceIds: [] } });
    await mount({ ...followOn('kiro'), guard: { maintenance: failed(), chat: null } });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('Kiro started with extra tools');
  });
});

describe('Settings › <name> › Pages', () => {
  it('is three rows with their defaults; no Reading or Writing heads, Never read or Blocks you edited, no pause switch or usage', async () => {
    await mount({ ...FOLLOW, usageToday: { checks: 342, modelCalls: 9, tokens: 41_200 } }, 'pages');
    expect(Array.from(document.querySelectorAll('.settings-row__label')).map((label) => label.textContent))
      .toEqual(['Keep workspace homes up to date', 'Keep the Pages Home up to date', 'First read']);
    expect(screen.queryByRole('switch', { name: 'Background updates' }), 'turning Michi off stops it').toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    const range = screen.getByRole('combobox', { name: 'First read' }) as HTMLSelectElement;
    expect(range.disabled).toBe(false);
    expect(range.value).toBe('30');
    expect([...range.options].map((option) => option.textContent)).toEqual(['7 days', '30 days', '90 days']);
    for (const name of ['Keep workspace homes up to date', 'Keep the Pages Home up to date']) {
      const control = screen.getByRole('switch', { name });
      expect(control.getAttribute('aria-checked'), `${name} is on by default`).toBe('true');
      expect(control).toHaveProperty('disabled', false);
    }
    expect(document.body.textContent).not.toMatch(/\bOn\b|\bOff\b|Never read|Blocks you edited|Always on/);
  });

  it('says what First read never reads behind its “?”, with the agent’s name', async () => {
    const { resetCompanionStoreForTests } = await import('../../../../state/companion/companionStore');
    const { companionSnapshot } = await import('../../../../test/companionFixtures');
    const snapshot = companionSnapshot();
    resetCompanionStoreForTests({ snapshot: { ...snapshot, settings: { ...snapshot.settings, displayName: 'Robin' } } });
    try {
      await mount(FOLLOW, 'pages');
      fireEvent.click(within(row('First read')).getByRole('button', { name: 'More about this setting' }));
      expect(row('First read').textContent).toContain('It never reads scheduled-job output, your conversation with Robin, or archived and deleted conversations.');
      expect(document.body.textContent).not.toMatch(/meta agent/i);
    } finally {
      resetCompanionStoreForTests();
    }
  });

  it('saves the write switches and the first-read range', async () => {
    await mount(FOLLOW, 'pages');
    api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, writeWorkspaceHomes: false } });
    fireEvent.click(screen.getByRole('switch', { name: 'Keep workspace homes up to date' }));
    await flush();
    expect(lastPatch()).toEqual({ writeWorkspaceHomes: false });
    expect(screen.getByRole('switch', { name: 'Keep workspace homes up to date' }).getAttribute('aria-checked')).toBe('false');

    api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, writeWorkspaceHomes: false, maintainSpacesHome: false } });
    fireEvent.click(screen.getByRole('switch', { name: 'Keep the Pages Home up to date' }));
    await flush();
    expect(lastPatch()).toEqual({ maintainSpacesHome: false });
    expect(screen.getByRole('switch', { name: 'Keep the Pages Home up to date' }).getAttribute('aria-checked')).toBe('false');

    api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, firstRunDays: 7 } });
    fireEvent.change(screen.getByRole('combobox', { name: 'First read' }), { target: { value: '7' } });
    await flush();
    expect(lastPatch()).toEqual({ firstRunDays: 7 });
    expect((screen.getByRole('combobox', { name: 'First read' }) as HTMLSelectElement).value).toBe('7');
  });

  it('shows a failed save under the row', async () => {
    await mount(FOLLOW, 'pages');
    api.updateMetaAgentSettings.mockRejectedValue(new MetaAgentApiError(400, 'firstRunDays must be 7, 30 or 90'));
    fireEvent.change(screen.getByRole('combobox', { name: 'First read' }), { target: { value: '7' } });
    await flush();
    expect(within(row('First read')).getByRole('alert').textContent).toBe('firstRunDays must be 7, 30 or 90');
  });

  it('keeps the Pages settings when Background work goes back to the conversations’ settings', async () => {
    await mount({ ...CUSTOM_CODEX, settings: { ...CUSTOM_CODEX.settings, writeWorkspaceHomes: false, firstRunDays: 90 } });
    api.updateMetaAgentSettings.mockResolvedValue(FOLLOW);
    fireEvent.change(choice(), { target: { value: 'same' } });
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: null, providerId: null, modelId: null, reasoning: null });
  });
});

describe('Settings › <name> › Pages upkeep without a backend', () => {
  it('shows a quiet notice on 404', async () => {
    await mount(new MetaAgentApiError(404, 'Not found'), 'runtime');
    expect(screen.getByRole('status').textContent).toContain('does not run Pages upkeep yet');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports other failures with a retry', async () => {
    await mount(new MetaAgentApiError(500, 'Database is locked'), 'runtime');
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load Pages upkeep: Database is locked.');
    api.fetchMetaAgent.mockReset();
    api.fetchMetaAgent.mockResolvedValue(FOLLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(choice()).toBeTruthy();
  });
});
