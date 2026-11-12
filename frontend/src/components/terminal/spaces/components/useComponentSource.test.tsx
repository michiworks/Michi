import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPageComponent } from '../../../../services/api/pageComponents';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { useComponentSource } from './useComponentSource';

vi.mock('../../../../services/api/pageComponents', () => ({ readPageComponent: vi.fn() }));

const answer = (code = 'root.textContent = "a"', version = 1) => ({
  component: { id: 'component-1', enabled: true, name: 'Widget' } as never,
  version: { code, version, source: { kind: 'user' } } as never,
});
const events = { pageId: 'page-1' };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useComponentSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readPageComponent).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('queues one re-read for events during a read', async () => {
    let finish!: (value: ReturnType<typeof answer>) => void;
    vi.mocked(readPageComponent).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(readPageComponent).mockResolvedValue(answer());
    renderHook(() => useComponentSource({ componentId: 'component-1', workspaceId: 'w1', connectionId: 'local', events, fallbackError: 'x' }));
    act(() => {
      notifyPageChanged({ backendConnectionId: 'local', workspaceId: 'w1', pageId: 'page-1' });
      notifyPageChanged({ backendConnectionId: 'local', workspaceId: 'w1', pageId: 'page-1' });
    });
    finish(answer());
    await flush();
    await flush();
    expect(readPageComponent).toHaveBeenCalledTimes(2);
  });

  it('keeps the same source object for an unchanged version and code', async () => {
    vi.mocked(readPageComponent).mockResolvedValue(answer());
    const { result } = renderHook(() => useComponentSource({ componentId: 'component-1', workspaceId: 'w1', connectionId: 'local', events, fallbackError: 'x' }));
    await flush();
    const first = result.current.source;
    expect(first?.code).toBe('root.textContent = "a"');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
    expect(result.current.source).toBe(first);
  });

  it('stops reading after a missing version, calling onMissing before the source clears', async () => {
    vi.mocked(readPageComponent).mockResolvedValueOnce(answer());
    vi.mocked(readPageComponent).mockRejectedValue(Object.assign(new Error('gone'), { status: 404, code: 'not_found' }));
    const seen: Array<string | undefined> = [];
    const { result } = renderHook(() => {
      const loaded = useComponentSource({
        componentId: 'component-1', workspaceId: 'w1', connectionId: 'local', events, fallbackError: 'x',
        onMissing: () => seen.push(loaded.source?.code),
      });
      return loaded;
    });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.source).toBeNull();
    expect(result.current.error).toBe('gone');
    expect(seen).toEqual(['root.textContent = "a"']);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(readPageComponent).toHaveBeenCalledTimes(2);
  });

  it('reads nothing without a component', async () => {
    const { result } = renderHook(() => useComponentSource({ componentId: '', workspaceId: 'w1', connectionId: 'local', events, fallbackError: 'x' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readPageComponent).not.toHaveBeenCalled();
    expect(result.current).toEqual({ source: null, error: null });
  });
});
