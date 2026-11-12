import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCatalogResponse, SkillSummary } from 'michi-shared';
import { fetchSkillCatalog, notifySkillsChanged, SkillsApiError } from '../services/api/skills';
import {
  invalidateSkillCatalog, loadSkillCatalog, readSkillCatalog, rememberRuntimeLabels, resetSkillCatalogs, runtimeLabel, settleSkillCatalog,
  useSkillCatalog,
} from './skillCatalog';

vi.mock('../services/api/skills', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api/skills')>(),
  fetchSkillCatalog: vi.fn(),
}));

const fetchCatalog = vi.mocked(fetchSkillCatalog);

const review: SkillSummary = {
  id: 'library:review', name: 'review', description: 'Review a change', origin: 'library',
  userInvocable: true, modelInvocable: true, enabled: true,
};
const status = { name: 'status', description: 'Show status' };
const answer = (skills: SkillSummary[], extra: Partial<SkillCatalogResponse> = {}): SkillCatalogResponse =>
  ({ skills, errors: [], libraryAvailable: true, runtimes: [{ id: 'claude', label: 'Claude Code', available: true }], commands: [status], ...extra });

beforeEach(() => {
  fetchCatalog.mockReset().mockResolvedValue(answer([review]));
});

afterEach(() => {
  resetSkillCatalogs();
  vi.restoreAllMocks();
});

describe('skill catalog', () => {
  it('asks once per workspace and runtime, keeps a complete answer until something changes, and learns the runtime label', async () => {
    expect(readSkillCatalog('ws-1', 'claude')).toEqual({ skills: [], commands: [] });
    await Promise.all([loadSkillCatalog('ws-1', 'claude'), loadSkillCatalog('ws-1', 'claude')]);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', runtimeId: 'claude' }));
    expect(readSkillCatalog('ws-1', 'claude')).toEqual({ skills: [review], commands: [status] });
    expect(readSkillCatalog('ws-1', 'kiro')).toEqual({ skills: [], commands: [] });
    expect(runtimeLabel('ws-1', 'claude')).toBe('Claude Code');
    // Until its backend names it, a runtime goes by its registered short name; an unknown one by its id.
    expect(runtimeLabel('ws-1', 'codex')).toBe('Codex');
    expect(runtimeLabel('ws-1', 'mystery')).toBe('mystery');

    await loadSkillCatalog('ws-1', 'claude');
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    for (const change of [() => notifySkillsChanged(), () => window.dispatchEvent(new Event('focus'))]) {
      act(change);
      await loadSkillCatalog('ws-1', 'claude');
    }
    expect(fetchCatalog).toHaveBeenCalledTimes(3);
  });

  it('asks again after a failed listing or request, not after a partial one, and turns skills off where the backend has none', async () => {
    fetchCatalog.mockResolvedValueOnce(answer([review], { errors: [{ runtimeId: 'claude', message: 'Claude could not list its skills', failed: true }] }));
    await loadSkillCatalog('ws-1', 'claude');
    expect(readSkillCatalog('ws-1', 'claude')?.skills).toEqual([review]);
    fetchCatalog.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await loadSkillCatalog('ws-1', 'claude');
    // The answer shown stays while the next request fails.
    expect(readSkillCatalog('ws-1', 'claude')?.skills).toEqual([review]);
    fetchCatalog.mockResolvedValueOnce(answer([review], { errors: [{ runtimeId: 'claude', message: 'big/SKILL.md: larger than 262144 bytes' }] }));
    await loadSkillCatalog('ws-1', 'claude');
    await loadSkillCatalog('ws-1', 'claude');
    expect(fetchCatalog).toHaveBeenCalledTimes(3);

    fetchCatalog.mockRejectedValueOnce(new SkillsApiError(404, 'Skills are not available', { code: 'skills_unavailable' }));
    await loadSkillCatalog('ws-cloud', 'claude');
    expect(readSkillCatalog('ws-cloud', 'claude')).toBeUndefined();
    await loadSkillCatalog('ws-cloud', 'claude');
    expect(fetchCatalog).toHaveBeenCalledTimes(4);
  });

  it('shows an answer whose runtime is still listing, and asks again shortly after, a bounded number of times', async () => {
    vi.useFakeTimers();
    try {
      const deploy: SkillSummary = { ...review, id: 'runtime:kiro:user:deploy', name: 'deploy', origin: 'runtime', runtimeId: 'kiro' };
      fetchCatalog.mockResolvedValueOnce(answer([review], { pending: ['kiro'] })).mockResolvedValueOnce(answer([review, deploy]));
      await act(async () => { await loadSkillCatalog('ws-1', 'kiro'); });
      expect(readSkillCatalog('ws-1', 'kiro')?.skills).toEqual([review]);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(readSkillCatalog('ws-1', 'kiro')?.skills).toEqual([review, deploy]);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);

      fetchCatalog.mockResolvedValue(answer([review], { pending: ['claude'] }));
      await act(async () => { await loadSkillCatalog('ws-1', 'claude'); await vi.advanceTimersByTimeAsync(60_000); });
      expect(fetchCatalog).toHaveBeenCalledTimes(2 + 1 + 6);
      // The menu opening still asks.
      await act(async () => { await loadSkillCatalog('ws-1', 'claude'); });
      expect(fetchCatalog).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops offering a skill the backend refused to run at once, and asks again', async () => {
    const plan: SkillSummary = { ...review, id: 'library:plan', name: 'plan' };
    fetchCatalog.mockResolvedValueOnce(answer([review, plan]));
    await loadSkillCatalog('ws-1', 'kiro');
    let respond!: (value: SkillCatalogResponse) => void;
    fetchCatalog.mockReturnValueOnce(new Promise<SkillCatalogResponse>((resolve) => { respond = resolve; }));

    invalidateSkillCatalog('ws-1', 'kiro', 'library:review');
    expect(readSkillCatalog('ws-1', 'kiro')?.skills).toEqual([plan]);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    // A load meanwhile waits on the request already out.
    const waiting = loadSkillCatalog('ws-1', 'kiro');
    await act(async () => { respond(answer([plan, { ...review, id: 'library:review-pr', name: 'review-pr' }])); await waiting; });
    expect(readSkillCatalog('ws-1', 'kiro')?.skills.map((skill) => skill.id)).toEqual(['library:plan', 'library:review-pr']);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it('asks when the pane gets focus, not on mount, and again at once when a skill changes while it has focus', async () => {
    const { result, rerender } = renderHook(({ focused }) => useSkillCatalog('ws-1', 'kiro', focused), { initialProps: { focused: false } });
    expect(result.current.catalog).toEqual({ skills: [], commands: [] });
    expect(fetchCatalog).not.toHaveBeenCalled();
    rerender({ focused: true });
    await waitFor(() => expect(result.current.catalog?.skills).toEqual([review]));

    const renamed = { ...review, id: 'library:review-pr', name: 'review-pr' };
    fetchCatalog.mockResolvedValueOnce(answer([renamed]));
    act(() => { notifySkillsChanged(); });
    await waitFor(() => expect(result.current.catalog?.skills).toEqual([renamed]));
    // Opening the menu with a current answer asks nothing.
    act(() => { result.current.load(); });
    expect(fetchCatalog).toHaveBeenCalledTimes(2);

    rerender({ focused: false });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    // Unfocused, it is only stale: the menu opening asks again.
    await act(async () => { result.current.load(); });
    expect(fetchCatalog).toHaveBeenCalledTimes(3);
  });

  it('asks again in the background once the answer is 30 s old, showing it meanwhile', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { result, rerender } = renderHook(({ focused }) => useSkillCatalog('ws-1', 'kiro', focused), { initialProps: { focused: true } });
    await act(async () => { await loadSkillCatalog('ws-1', 'kiro'); });
    now.mockReturnValue(1_029_000);
    act(() => { result.current.load(); });
    expect(fetchCatalog).toHaveBeenCalledTimes(1);

    const plan: SkillSummary = { ...review, id: 'library:plan', name: 'plan' };
    let respond!: (value: SkillCatalogResponse) => void;
    fetchCatalog.mockReturnValueOnce(new Promise<SkillCatalogResponse>((resolve) => { respond = resolve; }));
    now.mockReturnValue(1_030_000);
    act(() => { result.current.load(); });
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    expect(result.current.catalog?.skills).toEqual([review]);
    await act(async () => { respond(answer([review, plan])); });
    expect(result.current.catalog?.skills).toEqual([review, plan]);

    now.mockReturnValue(1_060_000);
    rerender({ focused: false });
    rerender({ focused: true });
    expect(fetchCatalog).toHaveBeenCalledTimes(3);
  });

  it('lets a typed name wait a bounded time for what the catalog lacks, and not once it has it', async () => {
    vi.useFakeTimers();
    try {
      let respond!: (value: SkillCatalogResponse) => void;
      fetchCatalog.mockReturnValueOnce(new Promise<SkillCatalogResponse>((resolve) => { respond = resolve; }));
      const first = settleSkillCatalog('ws-1', 'claude', 2500, 'answer');
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      await act(async () => { respond(answer([review], { pending: ['claude'] })); await first; });
      expect(readSkillCatalog('ws-1', 'claude')?.skills).toEqual([review]);
      // Library skills and commands are in; the runtime's own skills are not yet.
      expect(settleSkillCatalog('ws-1', 'claude', 2500, 'answer')).toBeNull();
      fetchCatalog.mockResolvedValueOnce(answer([review]));
      await act(async () => { await settleSkillCatalog('ws-1', 'claude', 2500, 'skills'); });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
      expect(settleSkillCatalog('ws-1', 'claude', 2500, 'skills')).toBeNull();

      fetchCatalog.mockReturnValueOnce(new Promise<SkillCatalogResponse>(() => {}));
      const settled = vi.fn();
      void settleSkillCatalog('ws-1', 'kiro', 2500, 'answer')?.then(settled);
      await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
      expect(settled).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(settled).toHaveBeenCalled();
      // The request stays out, and a later send waits for it again.
      expect(settleSkillCatalog('ws-1', 'kiro', 2500, 'skills')).not.toBeNull();
      expect(fetchCatalog).toHaveBeenCalledTimes(3);

      // After a failed listing a send does not ask again itself.
      fetchCatalog.mockResolvedValueOnce(answer([review], { errors: [{ runtimeId: 'codex', message: 'timed out', failed: true }] }));
      await act(async () => { await loadSkillCatalog('ws-1', 'codex'); });
      expect(settleSkillCatalog('ws-1', 'codex', 2500, 'skills')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no catalog for a pane without a workspace, and names a runtime by the label its backend gave', () => {
    const { result } = renderHook(() => useSkillCatalog(undefined, 'claude', true));
    expect(result.current.catalog).toBeUndefined();
    expect(fetchCatalog).not.toHaveBeenCalled();
    rememberRuntimeLabels('local', [{ id: 'pi', label: 'Pi' }]);
    expect(runtimeLabel(undefined, 'pi')).toBe('Pi');
  });
});
