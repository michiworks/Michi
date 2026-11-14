import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentOverview } from 'michi-shared';

const api = vi.hoisted(() => ({ overview: vi.fn(), paused: vi.fn(), guardFailed: false, schedulerOff: false }));
vi.mock('../../services/api/metaAgentOverview', () => ({ fetchMetaAgentOverview: () => api.overview(), setMetaAgentPaused: (paused: boolean) => api.paused(paused) }));
vi.mock('./useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useMetaAgent')>()),
  useMetaAgentGuardFailed: () => api.guardFailed,
  useMetaAgentSnapshot: () => ({ status: 'ready', error: null, info: {
    settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
    resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
    availability: { available: true, reason: null },
    guard: { maintenance: api.guardFailed ? { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['fs_write'], checkedAt: 1 } : null, chat: null },
  } }),
}));
vi.mock('./spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: null, error: null, unreachable: false, schedulerOff: api.schedulerOff, justFinished: false }),
}));

import { HttpResponseError } from '../../services/api/httpError';
import {
  META_AGENT_PAGE_POLL_MS, pauseMetaAgentMaintenance, resetMetaAgentOverviewStore, useMetaAgentOverview, useMetaAgentSettingsAlert,
} from './useMetaAgentOverview';

const overview = (patch: Partial<MetaAgentOverview>) => ({ state: 'running', cursors: [], recentRuns: [], stopped: null, ...patch }) as unknown as MetaAgentOverview;

function Probe() { return <span data-testid="alert">{String(useMetaAgentSettingsAlert())}</span>; }

async function alertFor(value: MetaAgentOverview, guardFailed = false): Promise<string | null> {
  api.overview.mockResolvedValue(value);
  api.guardFailed = guardFailed;
  const view = render(<Probe />);
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  const text = screen.getByTestId('alert').textContent;
  view.unmount();
  return text;
}

beforeEach(() => { resetMetaAgentOverviewStore(); api.overview.mockReset(); api.paused.mockReset(); });
afterEach(() => { document.body.innerHTML = ''; });

describe('useMetaAgentSettingsAlert (the rail Settings dot)', () => {
  it('lights for a stopped Meta agent and for a failed restriction check, not while it runs or is paused', async () => {
    expect(await alertFor(overview({ state: 'error', stopped: { reason: 'signed-out', message: 'Kiro is not signed in', workspaceIds: [] } }))).toBe('true');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'running' }), true)).toBe('true');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'paused' }))).toBe('false');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'running' }))).toBe('false');
  });

  it('lights for a runtime the Meta agent cannot run on, not when scheduled jobs are off, which Settings cannot change', async () => {
    expect(await alertFor(overview({ state: 'error', stopped: { reason: 'runtime-unsupported', message: 'The Meta agent does not run on Kiro Crew yet.', workspaceIds: [] } }))).toBe('true');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'running', notRunning: { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' } }))).toBe('false');
    resetMetaAgentOverviewStore();
    api.schedulerOff = true;
    expect(await alertFor(overview({ state: 'running' }))).toBe('false');
    api.schedulerOff = false;
  });
});

describe('one overview for every reader', () => {
  it('a pause from Settings or Scheduled clears the rail dot at once', async () => {
    const stopped = overview({ state: 'error', stopped: { reason: 'signed-out', message: 'Kiro is not signed in', workspaceIds: [] } });
    api.overview.mockResolvedValue(stopped);
    render(<Probe />);
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(screen.getByTestId('alert').textContent).toBe('true');
    api.paused.mockResolvedValue(overview({ state: 'paused', stopped: null }));
    await act(async () => { await pauseMetaAgentMaintenance(true); });
    expect(api.paused).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('alert').textContent).toBe('false');
  });
});

describe('reads and polls', () => {
  function Reader({ pollMs }: { pollMs?: number }) {
    const load = useMetaAgentOverview(pollMs);
    return <span data-testid="load">{'message' in load ? `${load.kind}:${load.message}` : load.kind}</span>;
  }
  const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });

  afterEach(() => { vi.useRealTimers(); });

  it('the rail, the Spaces Home and the Scheduled row mounted together read once', async () => {
    api.overview.mockResolvedValue(overview({ state: 'running' }));
    render(<><Probe /><Reader /><Reader pollMs={META_AGENT_PAGE_POLL_MS} /></>);
    await settle();
    expect(api.overview).toHaveBeenCalledTimes(1);
  });

  it('polls every minute for the rail alone, every 15 s while a Meta agent page is open, and every minute again after it closes', async () => {
    vi.useFakeTimers();
    api.overview.mockResolvedValue(overview({ state: 'running' }));
    render(<Reader />);
    await settle();
    api.overview.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(api.overview).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.overview).toHaveBeenCalledTimes(1);

    const page = render(<Reader pollMs={META_AGENT_PAGE_POLL_MS} />);
    await settle();
    api.overview.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(api.overview).toHaveBeenCalledTimes(3);

    page.unmount();
    api.overview.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(api.overview).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.overview).toHaveBeenCalledTimes(1);
  });

  it('reads again when the window regains focus, except where the backend has no overview', async () => {
    api.overview.mockResolvedValue(overview({ state: 'running' }));
    render(<Reader />);
    await settle();
    api.overview.mockClear();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(api.overview).toHaveBeenCalledTimes(1);

    resetMetaAgentOverviewStore();
    api.overview.mockReset().mockRejectedValue(new HttpResponseError('Not found', 404));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(screen.getByTestId('load').textContent).toBe('unavailable');
    api.overview.mockClear();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(api.overview).not.toHaveBeenCalled();
  });

  it('stops reading once the backend refuses, and shows its reason in place of the last answer', async () => {
    vi.useFakeTimers();
    const reason = 'The Meta agent requires local or authenticated remote access';
    api.overview.mockResolvedValueOnce(overview({ state: 'running' })).mockRejectedValue(new HttpResponseError(reason, 403));
    render(<Reader pollMs={META_AGENT_PAGE_POLL_MS} />);
    await settle();
    expect(screen.getByTestId('load').textContent).toBe('ready');
    await act(async () => { await vi.advanceTimersByTimeAsync(META_AGENT_PAGE_POLL_MS); });
    expect(screen.getByTestId('load').textContent).toBe(`refused:${reason}`);
    api.overview.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * META_AGENT_PAGE_POLL_MS); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(api.overview).not.toHaveBeenCalled();
  });

  it('treats only a missing route or a foreign answer as unavailable, and keeps the last answer when a read fails', async () => {
    api.overview.mockResolvedValue({ hello: 'world' });
    const first = render(<Reader />);
    await settle();
    expect(screen.getByTestId('load').textContent).toBe('unavailable');
    first.unmount();

    resetMetaAgentOverviewStore();
    api.overview.mockReset().mockResolvedValueOnce(overview({ state: 'running' })).mockRejectedValue(new Error('offline'));
    render(<Reader />);
    await settle();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(screen.getByTestId('load').textContent).toBe('ready');
  });
});
