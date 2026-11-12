import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as streamTransport from '../services/api/streamTransport';

const api = vi.hoisted(() => ({
  artifactWatchStreamUrl: vi.fn((workspaceId: string) => `/api/workspaces/${workspaceId}/watch/stream`),
  postArtifactWatchPaths: vi.fn(async () => {}),
}));
vi.mock('../services/api', () => api);
import { useArtifactWatch } from './useArtifactWatch';

function sseResponse(body: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('useArtifactWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', class {});
    api.postArtifactWatchPaths.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('declares the paths on every open, reports changes, and reconnects 3 s after the feed ends', async () => {
    const fetchStream = vi.spyOn(streamTransport, 'fetchStream')
      .mockResolvedValueOnce(sseResponse(
        'event: artifact_changed\ndata: {"filePath":".contexts/a.md"}\n\n'
        + 'event: artifact_removed\ndata: {"filePath":".contexts/b.md"}\n\n',
      ))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockReturnValue(new Promise(() => {}));
    const onChanged = vi.fn();
    const onRemoved = vi.fn();
    const { unmount } = renderHook(() => useArtifactWatch({
      workspaceId: 'ws', enabled: true, paths: ['.contexts/a.md'], onChanged, onRemoved,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    expect(fetchStream.mock.calls[0][0]).toBe('/api/workspaces/ws/watch/stream');
    expect(onChanged).toHaveBeenCalledWith('.contexts/a.md');
    expect(onRemoved).toHaveBeenCalledWith('.contexts/b.md');
    // The paths effect plus the open.
    expect(api.postArtifactWatchPaths).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStream).toHaveBeenCalledTimes(2);
    // A refused answer opens nothing and retries the same way.
    expect(api.postArtifactWatchPaths).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchStream).toHaveBeenCalledTimes(3);
    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStream).toHaveBeenCalledTimes(3);
  });
});
