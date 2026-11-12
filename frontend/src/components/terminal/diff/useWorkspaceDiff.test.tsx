import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpResponseError } from '../../../services/api/httpError';
import { useWorkspaceDiff } from './useWorkspaceDiff';

const { fetchDiff } = vi.hoisted(() => ({ fetchDiff: vi.fn() }));
vi.mock('../../../services/api/artifacts', () => ({ fetchWorkspaceDiff: fetchDiff }));

afterEach(() => { fetchDiff.mockReset(); });

describe('useWorkspaceDiff', () => {
  it('is empty without a path and loads one', async () => {
    fetchDiff.mockResolvedValue({ diff: '+a', truncated: true });
    const { result, rerender } = renderHook(({ path }) => useWorkspaceDiff('ws', path), { initialProps: { path: null as string | null } });
    expect(result.current).toEqual({ phase: 'empty' });
    expect(fetchDiff).not.toHaveBeenCalled();
    rerender({ path: 'a.ts' });
    expect(result.current).toEqual({ phase: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ phase: 'loaded', diff: '+a', truncated: true }));
    expect(fetchDiff).toHaveBeenCalledWith('ws', 'a.ts', expect.any(AbortSignal));
  });

  it('keeps the status of a failed request', async () => {
    fetchDiff.mockRejectedValue(new HttpResponseError('Diff request failed (404)', 404));
    const { result } = renderHook(() => useWorkspaceDiff('ws', 'a.ts'));
    await waitFor(() => expect(result.current).toMatchObject({ phase: 'error', status: 404 }));
  });

  it('reports an AbortError it did not cause, as when a remote connection changes mid-read', async () => {
    const error = new DOMException('Remote connection changed while reading data', 'AbortError');
    fetchDiff.mockRejectedValue(error);
    const { result } = renderHook(() => useWorkspaceDiff('ws', 'a.ts'));
    await waitFor(() => expect(result.current).toEqual({ phase: 'error', status: null, error }));
  });

  it('drops the answer for a path it has moved on from', async () => {
    let finish: (value: unknown) => void = () => {};
    fetchDiff.mockImplementationOnce((_ws: string, _path: string, signal: AbortSignal) => new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    fetchDiff.mockResolvedValueOnce({ diff: '+b', truncated: false });
    const { result, rerender } = renderHook(({ path }) => useWorkspaceDiff('ws', path), { initialProps: { path: 'a.ts' } });
    rerender({ path: 'b.ts' });
    finish({ diff: '+a', truncated: false });
    await waitFor(() => expect(result.current).toEqual({ phase: 'loaded', diff: '+b', truncated: false }));
  });
});
