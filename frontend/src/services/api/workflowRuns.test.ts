import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId } from '../../config/backendIdentity';
import * as streamTransport from './streamTransport';
import { actOnWorkflowRun, answerWorkflowApproval, getWorkflowRun, subscribeWorkflowRuns } from './workflowRuns';

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
    name: 'probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
    ...patch,
  };
}

function sseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const body = frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe('subscribeWorkflowRuns', () => {
  it('hands runs and background-subagent updates to their callbacks', async () => {
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: true, nodes: { n1: ['bg-1', 'bg-1', 'bg-2'] } }, emittedAt: 1 } },
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run(), emittedAt: 2 } },
      { event: 'heartbeat', data: { version: 1, event: 'heartbeat', run: null, emittedAt: 3 } },
      // Malformed: neither callback hears of it.
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { nodes: {} }, emittedAt: 4 } },
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: false, nodes: { n1: [] } }, emittedAt: 5 } },
    ]));
    const onRun = vi.fn();
    const onBackgroundSubagents = vi.fn();
    const onDisconnect = vi.fn();
    subscribeWorkflowRuns('ws', { onRun, onBackgroundSubagents, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls.map(([value]) => (value as WorkflowRunDtoV1).id)).toEqual(['wfr_1']);
    expect(onBackgroundSubagents.mock.calls.map(([update]) => update)).toEqual([
      { snapshot: true, nodes: { n1: ['bg-1', 'bg-2'] } },
      { snapshot: false, nodes: { n1: [] } },
    ]);
    // The stream ended on its own: a disconnect without an error.
    expect(onDisconnect).toHaveBeenCalledWith(undefined);
  });

  it('asks for patches, merges each into the run the feed sent, and reads the run whole when one does not fit it', async () => {
    const node = { id: 'a', kind: 'agent' as const, title: 'alpha', status: 'running' as const, prompt: 'Map the auth flow.', currentTool: 'Read a.ts' };
    const patch = (value: unknown) => ({ event: 'workflow_run_patch', data: { version: 1, event: 'workflow_run_patch', run: null, patch: value, emittedAt: 2 } });
    const stream = vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run({ nodes: [node] }), emittedAt: 1 } },
      patch({ id: 'wfr_1', baseRevision: 1, revision: 2, set: { updatedAt: 2 }, nodes: [{ id: 'a', set: { currentTool: 'Edit a.ts' } }] }),
      // Against a revision this feed did not send: read whole.
      patch({ id: 'wfr_1', baseRevision: 7, revision: 8, set: { status: 'failed' } }),
    ]));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ run: run({ revision: 8, status: 'completed', actions: [], nodes: [{ ...node, status: 'completed', currentTool: undefined }] }) })));
    vi.stubGlobal('fetch', fetch);
    try {
      const onRun = vi.fn();
      subscribeWorkflowRuns('ws', { onRun });
      await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(3));
      expect(String(stream.mock.calls[0][0])).toContain('patches=1');
      const runs = onRun.mock.calls.map(([value]) => value as WorkflowRunDtoV1);
      expect(runs.map((value) => [value.revision, value.status, value.nodes[0].currentTool, value.nodes[0].prompt])).toEqual([
        [1, 'running', 'Read a.ts', 'Map the auth flow.'],
        [2, 'running', 'Edit a.ts', 'Map the auth flow.'],
        [8, 'completed', undefined, 'Map the auth flow.'],
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/workflow-runs\/wfr_1$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hands ended background subagents to their callback, validated', async () => {
    const ended = (backgroundSubagentsEnded: unknown) => ({
      event: 'background_subagents_ended',
      data: { version: 1, event: 'background_subagents_ended', run: null, backgroundSubagentsEnded, emittedAt: 1 },
    });
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      ended({ nodeId: 'n1', subagents: [{ sessionId: 'bg-1', outcome: 'cancelled', endedAt: 9, error: 'gone', status: 'working' }] }),
      // Malformed: no valid end, no node.
      ended({ nodeId: 'n1', subagents: [{ sessionId: 'bg-2' }] }),
      ended({ subagents: [{ sessionId: 'bg-3', outcome: 'cancelled' }] }),
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run(), emittedAt: 2 } },
    ]));
    const onRun = vi.fn();
    const onBackgroundSubagents = vi.fn();
    const onBackgroundSubagentsEnded = vi.fn();
    const onDisconnect = vi.fn();
    subscribeWorkflowRuns('ws', { onRun, onBackgroundSubagents, onBackgroundSubagentsEnded, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onBackgroundSubagentsEnded.mock.calls.map(([value]) => value)).toEqual([
      { nodeId: 'n1', subagents: [{ sessionId: 'bg-1', outcome: 'cancelled', endedAt: 9, error: 'gone' }] },
    ]);
    expect(onBackgroundSubagents).not.toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('ignores background-subagent updates when no callback wants them', async () => {
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: true, nodes: {} }, emittedAt: 1 } },
      { event: 'background_subagents_ended', data: { version: 1, event: 'background_subagents_ended', run: null, backgroundSubagentsEnded: { nodeId: 'n1', subagents: [{ sessionId: 'bg-1', outcome: 'cancelled' }] }, emittedAt: 1 } },
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run(), emittedAt: 2 } },
    ]));
    const onRun = vi.fn();
    const onDisconnect = vi.fn();
    subscribeWorkflowRuns('ws', { onRun, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(undefined);
  });

  it('drops a feed that hears nothing for three heartbeats', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(streamTransport, 'fetchStream').mockImplementation(async (_url, init) => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
      const onDisconnect = vi.fn();
      subscribeWorkflowRuns('ws', { onRun: vi.fn(), onDisconnect });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(onDisconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
      expect(onDisconnect.mock.calls[0][0]).toMatchObject({ message: expect.stringContaining('stalled') });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('workflow run requests on a remote connection', () => {
  const connectionId = 'remote-wf';
  const remote = (id: string) => backendEntityId(connectionId, id);
  const base = backendApiBase(connectionId);
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch(body: unknown) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('returns the run of a read, a control and an approval in renderer ids', async () => {
    stubFetch({ run: run({ workspaceId: 'p-1', nodeId: 'n-1' }) });
    const runs = await Promise.all([
      getWorkflowRun(connectionId, 'wfr_1'),
      actOnWorkflowRun(connectionId, 'wfr_1', 'stop'),
      answerWorkflowApproval(connectionId, 'wfr_1', 'ap-1', 'allow'),
    ]);
    for (const result of runs) expect(result).toMatchObject({ id: 'wfr_1', workspaceId: remote('p-1'), nodeId: remote('n-1') });
  });
});
