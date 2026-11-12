import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { MetaAgentInfo } from '../../services/api/metaAgent';
import { MetaAgentApiError } from '../../services/api/metaAgent';
import { resetAttentionForTests, setAttentionPreferences } from '../../services/attention/policy';
import {
  readMetaAgent,
  refreshMetaAgent,
  resetMetaAgentStore,
  saveMetaAgentSettings,
  useMetaAgentApprovalReview,
  useMetaAgentGuardFailed,
} from './useMetaAgent';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));
const api = vi.hoisted(() => ({ fetchMetaAgent: vi.fn(), updateMetaAgentSettings: vi.fn() }));
vi.mock('../../services/api/metaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/metaAgent')>()),
  ...api,
}));

const OK: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const FAILED: MetaAgentInfo = {
  ...OK,
  guard: {
    maintenance: null,
    chat: { state: 'failed', runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['fs_write'], checkedAt: 1 },
  },
};

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  api.fetchMetaAgent.mockReset();
  api.updateMetaAgentSettings.mockReset();
  resetMetaAgentStore();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useMetaAgentGuardFailed (Settings red dot)', () => {
  it('is on only while a restriction check failed', async () => {
    api.fetchMetaAgent.mockResolvedValue(FAILED);
    const { result } = renderHook(() => useMetaAgentGuardFailed());
    expect(result.current).toBe(false);
    await flush();
    expect(result.current).toBe(true);

    api.fetchMetaAgent.mockResolvedValue(OK);
    await act(() => refreshMetaAgent());
    expect(result.current).toBe(false);
  });

  it('shares one read and one poll between callers, and polls every minute while visible', async () => {
    vi.useFakeTimers();
    api.fetchMetaAgent.mockResolvedValue(OK);
    const first = renderHook(() => useMetaAgentGuardFailed());
    renderHook(() => useMetaAgentGuardFailed());
    await flush();
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(1);

    api.fetchMetaAgent.mockResolvedValue(FAILED);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(2);
    expect(first.result.current).toBe(true);
  });

  it('stays off and stops polling when the backend has no Meta agent', async () => {
    vi.useFakeTimers();
    api.fetchMetaAgent.mockRejectedValue(new MetaAgentApiError(404, 'Not found'));
    const { result } = renderHook(() => useMetaAgentGuardFailed());
    await flush();
    expect(readMetaAgent().status).toBe('unavailable');
    await act(async () => { vi.advanceTimersByTime(180_000); });
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });
});

describe('Meta agent store', () => {
  it('keeps a saved answer over a read that started before the save', async () => {
    let answerRead: (info: MetaAgentInfo) => void = () => {};
    api.fetchMetaAgent.mockReturnValue(new Promise<MetaAgentInfo>((resolve) => { answerRead = resolve; }));
    const pending = refreshMetaAgent();
    const saved = { ...OK, settings: { ...OK.settings, runtimeId: 'pi' } };
    api.updateMetaAgentSettings.mockResolvedValue(saved);
    await saveMetaAgentSettings({ runtimeId: 'pi' });
    answerRead(OK);
    await pending;
    expect(readMetaAgent().info).toBe(saved);
  });

  it('keeps the last answer when a later read fails', async () => {
    api.fetchMetaAgent.mockResolvedValue(FAILED);
    await refreshMetaAgent();
    api.fetchMetaAgent.mockRejectedValue(new Error('offline'));
    await refreshMetaAgent();
    expect(readMetaAgent()).toMatchObject({ status: 'ready', info: FAILED, error: 'offline' });
  });
});

describe('the tool approval notice', () => {
  const request = (id: string, tool = 'send') => ({ id, server: 'mail', tool, description: '', state: 'pending' as const, requestedAt: 1, updatedAt: 1 });
  const read = async (...approvals: Array<ReturnType<typeof request>>) => {
    api.fetchMetaAgent.mockResolvedValue({ ...OK, toolApprovals: approvals });
    await refreshMetaAgent();
  };
  beforeEach(() => { vi.mocked(toast).mockClear(); vi.mocked(toast.dismiss).mockClear(); });

  it('says nothing for what already waited at the first read, so a reload does not announce it again', async () => {
    await read(request('old'));
    await read(request('old'));
    expect(toast).not.toHaveBeenCalled();
  });

  it('gathers new requests into one notice with Review, once each while polls keep them waiting', async () => {
    const review = vi.fn();
    const { unmount } = renderHook(() => useMetaAgentApprovalReview(review));
    await read();
    await read(request('a'));
    await read(request('a'));
    await read(request('a'), request('b', 'reply'));
    expect(vi.mocked(toast).mock.calls.map(([title, options]) => [title, (options as { id?: string })?.id])).toEqual([
      ['Pages upkeep needs approval for mail / send', 'meta-agent:approvals'],
      ['Pages upkeep needs approval for 2 tools', 'meta-agent:approvals'],
    ]);
    // It points at the page the approvals are on now: Settings › <name> › Pages upkeep (there is no Settings › Meta agent).
    expect(vi.mocked(toast).mock.calls[0][1]).toEqual(expect.objectContaining({
      description: 'Review them in Settings › Michi › Pages upkeep › Tool approvals. Other permitted tools can still be used.',
    }));
    (vi.mocked(toast).mock.calls[1][1] as unknown as { action: { onClick: () => void } }).action.onClick();
    expect(review).toHaveBeenCalledOnce();
    expect(readMetaAgent().info?.toolApprovals?.[0].state).toBe('pending');
    unmount();
  });

  it('withdraws the notice once nothing waits', async () => {
    await read();
    await read(request('a'));
    expect(toast.dismiss).not.toHaveBeenCalled();
    await read();
    expect(toast.dismiss).toHaveBeenCalledWith('meta-agent:approvals');
  });

  it('shows nothing while notifications are off', async () => {
    setAttentionPreferences({ level: 'off', sounds: true });
    try {
      await read();
      await read(request('quiet'));
      expect(toast).not.toHaveBeenCalled();
    } finally { resetAttentionForTests(); }
  });
});
