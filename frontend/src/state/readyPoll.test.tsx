/**
 * /api/ready cold-start polling — verifies the chatStore boot effect
 * loads /agent/status immediately for composer chrome, tracks /api/ready
 * separately for warm failures, and keeps reload events on the status path.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

vi.mock('../services/api', async () => {
  const fetchAgentStatus = vi.fn();
  return {
  __esModule: true,
  ensureSession: vi.fn().mockResolvedValue('test-session'),
  fetchAgentStatus,
  // The boot read: a local window never waits on the remote first-paint barrier.
  fetchAgentStatusAfterFirstPaint: (...args: unknown[]) => fetchAgentStatus(...args),
  fetchReady: vi.fn(),
  listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
  listAgentModels: vi.fn().mockResolvedValue({ models: [], sanitizedModel: null }),
  setChatMode: vi.fn(),
  respondToPermission: vi.fn(),
  cancelPermission: vi.fn(),
  warmCwd: vi.fn(),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: vi.fn().mockResolvedValue(undefined),
  // workspacePersistence dependencies — return empty so hydration finishes quickly.
  fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
  fetchTreeMessages: vi.fn().mockResolvedValue([]),
  fetchWorkspaces: vi.fn().mockResolvedValue([]),
  fetchWorkspace: vi.fn().mockResolvedValue(null),
  syncWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  deleteWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  fetchPrefs: vi.fn().mockResolvedValue(null),
  savePrefs: vi.fn().mockResolvedValue(undefined),
  listBackendConnections: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import * as api from '../services/api';
import { ChatProvider, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';

// Stub matchMedia — jsdom lacks it and some hooks probe for it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function Probe() {
  const { agentStatus, agentStatusUnreachable, warmFailedError } = useChatStore();
  return (
    <div>
      <span data-testid="status">{agentStatus ? 'ready' : 'null'}</span>
      <span data-testid="runtime">{agentStatus?.runtime ?? ''}</span>
      <span data-testid="unreachable">{String(agentStatusUnreachable)}</span>
      <span data-testid="error">{warmFailedError ?? ''}</span>
    </div>
  );
}

function WarmProjectProbe() {
  const { createProject } = useChatStore();
  const created = React.useRef(false);
  React.useEffect(() => {
    if (created.current) return;
    created.current = true;
    void createProject('Warm target', '/tmp');
  }, [createProject]);
  return null;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

const STATUS_FIXTURE = {
  runtime: 'kiro',
  label: 'Kiro',
  capabilities: {
    modes: false,
    permissions: false,
    models: false,
    providerModels: false,
    reasoning: false,
    supportedReasoningLevels: [],
    apiKeys: false,
    warmSessions: false,
    saveContext: false,
    spawnBranches: false,
    nativeResume: false,
  },
  availableRuntimes: [],
  provider: '',
  providers: undefined,
  model: null,
  modelByRuntime: {},
  reasoning: 'medium' as const,
  reasoningByRuntime: {},
  hasRequiredKey: true,
};

describe('chatStore boot ready polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.fetchAgentStatus as any).mockResolvedValue(STATUS_FIXTURE);
    (api.listAgentModels as any).mockResolvedValue({ models: [], sanitizedModel: null });
    (api.listAgentModes as any).mockReset().mockResolvedValue({ availableModes: [], defaultModeId: null });
  });

  test('loads agent status without waiting for ready or the model catalog', async () => {
    let resolveReady: (v: { status: 'ready' | 'pending'; error: null }) => void = () => {};
    (api.fetchReady as any).mockImplementation(
      () => new Promise((r) => { resolveReady = r as any; }),
    );
    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      capabilities: { ...STATUS_FIXTURE.capabilities, models: true },
    });
    (api.listAgentModels as any).mockImplementation(
      () => new Promise(() => {}),
    );

    const { getByTestId } = render(
      wrapper({ children: <Probe /> }),
    );

    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('ready'));

    await act(async () => {
      resolveReady({ status: 'ready', error: null });
    });
  });

  test('failed ready surfaces error without blocking status', async () => {
    (api.fetchReady as any).mockResolvedValue({
      status: 'failed',
      error: 'kiro-cli ENOENT',
    });

    const { getByTestId } = render(
      wrapper({ children: <Probe /> }),
    );
    await waitFor(() =>
      expect(getByTestId('error').textContent).toBe('kiro-cli ENOENT'),
    );
    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('ready'));
  });

  test('flags the backend unreachable when the bounded retry runs out, and clears it on the next status', async () => {
    vi.useFakeTimers();
    try {
      (api.fetchReady as any).mockResolvedValue({ status: 'pending', error: null });
      (api.fetchAgentStatus as any).mockRejectedValue(new TypeError('Failed to fetch'));
      const { getByTestId } = render(wrapper({ children: <Probe /> }));

      // A backend that answers within the 30s retry is not an outage.
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
      expect(getByTestId('unreachable').textContent).toBe('false');
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(getByTestId('unreachable').textContent).toBe('true');

      (api.fetchAgentStatus as any).mockResolvedValue(STATUS_FIXTURE);
      await act(async () => {
        window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getByTestId('unreachable').textContent).toBe('false');
      expect(getByTestId('status').textContent).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the newer status when an older read resolves after a reload', async () => {
    let resolveInitial: (value: unknown) => void = () => {};
    let resolveReload: (value: unknown) => void = () => {};
    (api.fetchReady as any).mockResolvedValue({ status: 'pending', error: null });
    (api.fetchAgentStatus as any)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReload = resolve; }));
    const { getByTestId } = render(wrapper({ children: <Probe /> }));
    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalledTimes(1));

    await act(async () => { window.dispatchEvent(new CustomEvent('michi:reload-agent-status')); });
    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalledTimes(2));
    await act(async () => { resolveReload({ ...STATUS_FIXTURE, runtime: 'pi' }); });
    expect(getByTestId('runtime').textContent).toBe('pi');

    await act(async () => { resolveInitial({ ...STATUS_FIXTURE, runtime: 'claude' }); });
    expect(getByTestId('runtime').textContent).toBe('pi');
  });

  // Regression: on desktop cold start the first /api/modes fetch can be refused
  // before the backend is listening. The /agent picker must still populate once
  // the backend answers — not stay stuck on "Loading…" forever (Kiro-CLI agents
  // vanishing from the picker). The modes fetch is retried alongside status.
  test('recovers available modes after a cold-start fetch failure', async () => {
    const modes = [{ id: 'gpu-dev', name: 'gpu-dev' }];
    vi.mocked(api.fetchAgentStatus).mockResolvedValue({ ...STATUS_FIXTURE, model: undefined, capabilities: { ...STATUS_FIXTURE.capabilities, modes: true } });
    (api.listAgentModes as any)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ availableModes: modes, defaultModeId: 'gpu-dev' });
    (api.fetchReady as any).mockResolvedValue({ status: 'pending', error: null });

    function ModesProbe() {
      const { availableModes } = useChatStore();
      return <span data-testid="modes">{availableModes.map((m) => m.id).join(',')}</span>;
    }

    const { getByTestId } = render(wrapper({ children: <ModesProbe /> }));

    // /api/ready never reports `ready`, so recovery comes from the retry loop,
    // not the watchReady backstop.
    await waitFor(() => expect(getByTestId('modes').textContent).toBe('gpu-dev'));
  });

  test('re-warms the same cwd when runtime or model changes', async () => {
    (api.fetchReady as any).mockResolvedValue({ status: 'ready', error: null });
    (api.warmCwd as any).mockResolvedValue(undefined);
    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'kiro',
      model: 'claude-opus-4.8',
    });

    render(wrapper({ children: <WarmProjectProbe /> }));
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(1));
    expect(api.warmCwd).toHaveBeenLastCalledWith('/tmp', undefined, expect.any(AbortSignal));

    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'gemini',
      model: 'gemini-2.5-pro',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(2));

    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'gemini',
      model: 'gemini-2.5-flash',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(3));

    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'kiro',
      model: 'claude-opus-4.8',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(4));
  });
});
