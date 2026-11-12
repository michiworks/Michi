import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId } from '../../config/backendIdentity';
import {
  cancelMultiModelRun,
  editMultiModelPlan,
  fetchReadyModels,
  replaceMultiModelThread,
  retryMultiModelRun,
  retryMultiModelThread,
  startMultiModelRun,
  stopMultiModelRun,
  stopMultiModelThread,
} from './multiModelRuns';

afterEach(() => { vi.unstubAllGlobals(); });

const run: WorkflowRunDtoV1 = {
  version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
  name: 'Caches', status: 'paused', nodes: [], log: [], actions: [], startedAt: 1, updatedAt: 1, revision: 1,
};

function stubFetch(body: unknown, status = 200) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('multi-model run API', () => {
  it('sends each command to its route and returns the run', async () => {
    const fetch = stubFetch({ run });
    const base = `${backendApiBase('local')}/multi-model-runs/wfr%2F1`;
    const pick = { runtimeId: 'pi', providerId: 'openai', modelId: null };
    const calls: Array<[Promise<WorkflowRunDtoV1>, string, string, unknown]> = [
      [editMultiModelPlan('local', 'wfr/1', { op: 'remove', key: 't1' }), '/plan', 'PATCH', { op: 'remove', key: 't1' }],
      [startMultiModelRun('local', 'wfr/1'), '/start', 'POST', undefined],
      [cancelMultiModelRun('local', 'wfr/1'), '/cancel', 'POST', undefined],
      [stopMultiModelRun('local', 'wfr/1'), '/stop', 'POST', undefined],
      [retryMultiModelRun('local', 'wfr/1'), '/retry', 'POST', undefined],
      [stopMultiModelThread('local', 'wfr/1', 't1'), '/threads/t1/stop', 'POST', undefined],
      [retryMultiModelThread('local', 'wfr/1', 'a1'), '/threads/a1/retry', 'POST', undefined],
      [replaceMultiModelThread('local', 'wfr/1', 't2', pick), '/threads/t2/replace', 'POST', { pick }],
    ];
    for (const [index, [promise, path, method, body]] of calls.entries()) {
      await expect(promise).resolves.toMatchObject({ id: 'wfr_1', runtime: 'michi' });
      const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
      expect([url, init.method]).toEqual([`${base}${path}`, method]);
      expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
    }
  });

  it('fetches and validates the ready models of a workspace', async () => {
    const fetch = stubFetch({ version: 1, runtimes: [{ runtimeId: 'codex', label: 'Codex', defaultModelId: 'gpt', defaultProviderId: null, models: [] }] });
    await expect(fetchReadyModels('local', 'ws 1')).resolves.toEqual({
      version: 1, runtimes: [{ runtimeId: 'codex', label: 'Codex', defaultModelId: 'gpt', defaultProviderId: null, models: [] }],
    });
    expect(fetch.mock.calls[0][0]).toBe(`${backendApiBase('local')}/multi-model/ready-models?workspaceId=ws+1`);
    stubFetch({ version: 2 });
    await expect(fetchReadyModels('local', 'ws')).rejects.toThrow('fetchReadyModels returned a malformed list');
  });

  it('surfaces the server\'s message, status and code, and rejects a malformed run', async () => {
    stubFetch({ error: 'Still stopping the branches. Try again in a moment.', code: 'thread_busy' }, 409);
    await expect(retryMultiModelRun('local', 'wfr_1')).rejects.toMatchObject({
      message: 'Still stopping the branches. Try again in a moment.', status: 409, code: 'thread_busy',
    });
    stubFetch({}, 502);
    await expect(startMultiModelRun('local', 'wfr_1')).rejects.toThrow('startMultiModelRun failed: 502');
    stubFetch({ run: { id: 'x' } });
    await expect(startMultiModelRun('local', 'wfr_1')).rejects.toThrow('startMultiModelRun returned a malformed run');
  });
});

describe('multi-model run API on a remote connection', () => {
  const connectionId = 'remote-mm';
  const remote = (id: string) => backendEntityId(connectionId, id);

  it('asks for the ready models of the workspace by its server id', async () => {
    const fetch = stubFetch({ version: 1, runtimes: [] });
    await fetchReadyModels(connectionId, remote('p-1'));
    expect(fetch.mock.calls[0][0]).toBe(`${backendApiBase(connectionId)}/multi-model/ready-models?workspaceId=p-1`);
  });

  it('answers every command with the run in renderer ids', async () => {
    const multiModel = {
      version: 1, phase: 'running', callerNodeId: 'n-caller', synthesis: { status: 'pending' },
      threads: [{ key: 't1', runtimeId: 'codex', childNodeId: 'n-branch' }],
    };
    stubFetch({ run: { ...run, workspaceId: 'p-1', nodeId: 'n-caller', multiModel } });
    const pick = { runtimeId: 'codex', providerId: null, modelId: null };
    const runs = await Promise.all([
      editMultiModelPlan(connectionId, 'wfr_1', { op: 'add', pick }),
      startMultiModelRun(connectionId, 'wfr_1'),
      cancelMultiModelRun(connectionId, 'wfr_1'),
      stopMultiModelRun(connectionId, 'wfr_1'),
      retryMultiModelRun(connectionId, 'wfr_1'),
      stopMultiModelThread(connectionId, 'wfr_1', 't1'),
      retryMultiModelThread(connectionId, 'wfr_1', 't1'),
      replaceMultiModelThread(connectionId, 'wfr_1', 't1', pick),
    ]);
    for (const result of runs) {
      expect(result).toMatchObject({ id: 'wfr_1', workspaceId: remote('p-1'), nodeId: remote('n-caller') });
      expect(result.multiModel?.callerNodeId).toBe(remote('n-caller'));
      expect(result.multiModel?.threads.map((thread) => thread.childNodeId)).toEqual([remote('n-branch')]);
    }
  });
});
