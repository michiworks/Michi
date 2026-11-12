import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { MultiModelError } from '../src/agents/multiModelTool';
import { setupMultiModelRunRoutes, type MultiModelRunRouteDeps } from '../src/routes/multiModelRuns';

const RUN = { id: 'wfr_1', runtime: 'michi' } as WorkflowRunDtoV1;

describe('multi-model run routes', () => {
  const calls: unknown[][] = [];
  let server: Server;
  let base = '';

  /** alice owns wfr_1; every other owner gets 404, as the store's owner-scoped lookup gives. */
  const owned = (owner: string, runId: string) => {
    if (owner !== 'alice' || runId !== 'wfr_1') throw new MultiModelError('not_found', 'not_found', 404);
  };
  const orchestrator: MultiModelRunRouteDeps['orchestrator'] = {
    readyModelsFor: async (owner, workspaceId) => { calls.push(['ready', owner, workspaceId]); return { version: 1, runtimes: [] }; },
    editPlan: async (owner, runId, edit) => { owned(owner, runId); calls.push(['edit', edit]); return RUN; },
    startRun: async (owner, runId) => {
      owned(owner, runId);
      throw new MultiModelError('already_running', 'Another multi-model run is already running in this chat', 409);
    },
    cancelProposal: async (owner, runId) => { owned(owner, runId); calls.push(['cancel']); return RUN; },
    stopAll: async (owner, runId) => { owned(owner, runId); throw new Error('boom'); },
    retryRun: async (owner, runId) => { owned(owner, runId); throw new MultiModelError('thread_busy', 'Still stopping', 409); },
    stopThread: async (owner, runId, key) => { owned(owner, runId); calls.push(['stopThread', key]); return RUN; },
    retryThread: async (owner, runId, key) => { owned(owner, runId); calls.push(['retryThread', key]); return RUN; },
    replaceThread: async (owner, runId, key, pick) => { owned(owner, runId); calls.push(['replace', key, pick]); return RUN; },
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { user: { id: unknown } }).user = { id: req.headers['x-user'] }; next(); });
    app.use('/api', setupMultiModelRunRoutes({ orchestrator, hub: { workspaceOwnedBy: (owner, workspaceId) => owner === 'alice' && workspaceId === 'ws-a' } }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const request = async (method: string, path: string, body?: unknown, user = 'alice') => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-user': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  test('ready models need a workspace the caller owns', async () => {
    assert.equal((await request('GET', '/multi-model/ready-models')).status, 400);
    assert.equal((await request('GET', '/multi-model/ready-models?workspaceId=ws-a', undefined, 'bob')).status, 404);
    const ok = await request('GET', '/multi-model/ready-models?workspaceId=ws-a');
    assert.deepEqual([ok.status, ok.body], [200, { version: 1, runtimes: [] }]);
    assert.deepEqual(calls.at(-1), ['ready', 'alice', 'ws-a']);
  });

  test('plan edits are parsed with the shared parser', async () => {
    assert.equal((await request('PATCH', '/multi-model-runs/wfr_1/plan', { op: 'explode', key: 't1' })).status, 400);
    const ok = await request('PATCH', '/multi-model-runs/wfr_1/plan', { op: 'remove', key: 't1' });
    assert.deepEqual([ok.status, ok.body], [200, { run: RUN }]);
    assert.deepEqual(calls.at(-1), ['edit', { op: 'remove', key: 't1' }]);
  });

  test('errors map to their status and code; unknown errors to 502', async () => {
    assert.deepEqual(await request('POST', '/multi-model-runs/wfr_1/start'),
      { status: 409, body: { error: 'Another multi-model run is already running in this chat', code: 'already_running' } });
    assert.deepEqual(await request('POST', '/multi-model-runs/wfr_1/retry'), { status: 409, body: { error: 'Still stopping', code: 'thread_busy' } });
    assert.deepEqual(await request('POST', '/multi-model-runs/wfr_1/stop'), { status: 502, body: { error: 'boom' } });
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/cancel')).status, 200);
  });

  test("another owner's run is 404", async () => {
    for (const path of ['/start', '/cancel', '/stop', '/retry', '/threads/t1/stop', '/threads/t1/retry']) {
      assert.equal((await request('POST', `/multi-model-runs/wfr_1${path}`, undefined, 'bob')).status, 404, path);
    }
    assert.equal((await request('PATCH', '/multi-model-runs/wfr_1/plan', { op: 'remove', key: 't1' }, 'bob')).status, 404);
  });

  test('thread keys and picks are validated', async () => {
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/threads/x1/stop')).status, 400);
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/threads/t0/retry')).status, 400);
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/threads/t100/retry')).status, 400);
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/threads/a1/replace', { pick: {} })).status, 400);
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/threads/t2/stop')).status, 200);
    assert.equal((await request('POST', '/multi-model-runs/wfr_1/threads/a12/retry')).status, 200);
    const replaced = await request('POST', '/multi-model-runs/wfr_1/threads/a1/replace', { pick: { runtimeId: 'codex', modelId: 'gpt' } });
    assert.equal(replaced.status, 200);
    assert.deepEqual(calls.slice(-3), [['stopThread', 't2'], ['retryThread', 'a12'], ['replace', 'a1', { runtimeId: 'codex', modelId: 'gpt' }]]);
  });
});
