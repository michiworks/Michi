// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../services/api';

const store = vi.hoisted(() => ({
  agentStatus: null as AgentStatus | null,
  agentStatusUnreachable: false,
  activeProject: null as { id: string; backendConnectionId?: string } | null,
  refreshAgentStatus: vi.fn(),
}));

vi.mock('../state/chatStore', () => ({
  useChatProjects: () => store,
}));

vi.mock('../services/api', () => ({
  saveAgentOptions: vi.fn(),
  saveProviderKey: vi.fn(),
  verifyProviderKey: vi.fn(),
}));

vi.mock('../state/prefs', () => ({
  usePrefs: () => ({
    prefs: { onboardingCompletedAt: '2026-01-01T00:00:00.000Z' },
  }),
}));

import ApiKeyGate from './ApiKeyGate';

const deepseek = {
  id: 'deepseek',
  label: 'DeepSeek',
  keyLabel: 'DeepSeek API key',
  envVars: ['DEEPSEEK_API_KEY'],
  defaultModel: 'deepseek-v4-flash',
  supportsReasoning: true,
  hasKey: true,
};

const cerebras = {
  id: 'cerebras',
  label: 'Cerebras',
  keyLabel: 'Cerebras API key',
  envVars: ['CEREBRAS_API_KEY'],
  defaultModel: 'gpt-oss-120b',
  supportsReasoning: true,
  hasKey: false,
};

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    runtime: 'pi',
    label: 'Pi',
    capabilities: {
      modes: false,
      models: false,
      nativeResume: false,
      supportedReasoningLevels: [],
      permissions: false,
      providerModels: true,
      reasoning: true,
      apiKeys: true,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
    },
    availableRuntimes: [{ id: 'pi', label: 'Pi', available: true, requiresApiKey: true }],
    provider: 'deepseek',
    providers: [deepseek, cerebras],
    model: 'deepseek-v4-flash',
    hasRequiredKey: true,
    ...overrides,
  };
}

const cerebrasWithoutKey = () => status({ provider: 'cerebras', model: cerebras.defaultModel, hasRequiredKey: false });

describe('ApiKeyGate', () => {
  let view: ReturnType<typeof render>;
  const setStore = (next: Partial<typeof store>) => {
    Object.assign(store, next);
    view.rerender(<ApiKeyGate />);
  };
  const reload = (detail?: { silent: boolean }) => act(async () => {
    window.dispatchEvent(new CustomEvent('michi:reload-agent-status', { detail }));
  });

  beforeEach(() => {
    store.agentStatus = status();
    store.agentStatusUnreachable = false;
    store.activeProject = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('opens on a non-silent reload even when another provider already has a key', async () => {
    view = render(<ApiKeyGate />);
    expect(screen.queryByText('Add a provider key')).toBeNull();

    await reload();
    // Logged-in / BYOK: any saved key keeps hasRequiredKey true.
    setStore({ agentStatus: status({ provider: 'cerebras', model: 'gpt-oss-120b', hasRequiredKey: true }) });

    expect(await screen.findByText('Add a provider key')).toBeTruthy();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('cerebras');
  });

  it('stays closed on a silent reload even when the new provider has no key', async () => {
    view = render(<ApiKeyGate />);

    await reload({ silent: true });
    setStore({ agentStatus: cerebrasWithoutKey() });

    expect(screen.queryByText('Add a provider key')).toBeNull();
  });

  it('does not reopen a dismissed window from the status of the runtime the user left', async () => {
    store.agentStatus = cerebrasWithoutKey();
    view = render(<ApiKeyGate />);
    expect(await screen.findByText('Add a provider key')).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: 'Cancel' }).click(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Switching to Claude: the gate must wait for Claude's status.
    await reload();
    view.rerender(<ApiKeyGate />);
    expect(screen.queryByRole('dialog')).toBeNull();

    setStore({
      agentStatus: status({
        runtime: 'claude',
        label: 'Claude',
        capabilities: { ...status().capabilities, apiKeys: false },
        providers: [],
      }),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reopens a dismissed window with the status a non-silent reload brings back', async () => {
    store.agentStatus = cerebrasWithoutKey();
    view = render(<ApiKeyGate />);
    await act(async () => { (await screen.findByRole('button', { name: 'Cancel' })).click(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await reload();
    setStore({ agentStatus: cerebrasWithoutKey() });

    expect(await screen.findByText('Add a provider key')).toBeTruthy();
  });

  it("re-evaluates from the backend of the workspace that becomes active", async () => {
    view = render(<ApiKeyGate />);
    expect(screen.queryByRole('dialog')).toBeNull();

    // The store drops the old backend's status, then loads the new one's.
    setStore({ agentStatus: null });
    setStore({ agentStatus: cerebrasWithoutKey() });
    expect(await screen.findByText('Add a provider key')).toBeTruthy();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('cerebras');

    setStore({ agentStatus: null });
    setStore({ agentStatus: status() });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows no unreachable notice while the store is still trying the backend', async () => {
    vi.useFakeTimers();
    store.agentStatus = null;
    view = render(<ApiKeyGate />);

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.queryByText('Backend not reachable')).toBeNull();

    setStore({ agentStatus: status() });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows the store's unreachable notice, and Retry asks the store to load again", async () => {
    store.agentStatus = null;
    store.agentStatusUnreachable = true;
    view = render(<ApiKeyGate />);

    expect(await screen.findByText('Backend not reachable')).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: 'Retry' }).click(); });
    expect(store.refreshAgentStatus).toHaveBeenCalledOnce();

    setStore({ agentStatusUnreachable: false, agentStatus: status() });
    await waitFor(() => expect(screen.queryByText('Backend not reachable')).toBeNull());
  });

  it("does not block the app on a remote backend's outage", () => {
    store.agentStatus = null;
    store.agentStatusUnreachable = true;
    store.activeProject = { id: 'remote:remote-a:p1', backendConnectionId: 'remote-a' };
    view = render(<ApiKeyGate />);

    expect(screen.queryByText('Backend not reachable')).toBeNull();
  });
});
