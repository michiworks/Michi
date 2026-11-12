/**
 * The workflow-run and multi-model routers resolve a request's owner and
 * workspace the same way: both look runs up in one WorkflowRunHub by owner
 * (multi-model approvals go through /workflow-runs). This pins that both
 * routers agree, each with its own refusal bodies.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { MultiModelError } from '../src/agents/multiModelTool';
import { WorkflowRunHub } from '../src/services/workflowRunHub';
import type { WorkflowRunStore } from '../src/services/workflowRunsRepository';
import { setupWorkflowRunRoutes } from '../src/routes/workflowRuns';
import { setupMultiModelRunRoutes, type MultiModelRunRouteDeps } from '../src/routes/multiModelRuns';

/** alice owns ws-a; the local user owns ws-local. */
const WORKSPACES: Record<string, string> = { 'ws-a': 'alice', 'ws-local': LOCAL_AGENT_OWNER_ID };

function memoryStore(): WorkflowRunStore {
  const rows = new Map<string, { ownerUserId: string; run: WorkflowRunDtoV1 }>();
  return {
    upsert(ownerUserId, run) { rows.set(run.id, { ownerUserId, run }); },
    get(ownerUserId, id) { const row = rows.get(id); return row && row.ownerUserId === ownerUserId ? row.run : null; },
    list(ownerUserId, workspaceId) { return [...rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.run.workspaceId === workspaceId).map((row) => row.run); },
    listOpen() { return []; },
    workspaceOwnedBy(ownerUserId, workspaceId) { return WORKSPACES[workspaceId] === ownerUserId; },
    workspaceOfNode() { return null; },
  };
}

describe('workflow-run and multi-model routers resolve the same owner', () => {
  const hub = new WorkflowRunHub(memoryStore());
  const aliceRun = hub.update({ ownerUserId: 'alice', workspaceId: 'ws-a', nodeId: 'node-a' }, 'michi', 'mm-a', (run) => ({ ...run, name: 'alice' }))!;
  const localRun = hub.update({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-local', nodeId: 'node-l' }, 'michi', 'mm-l', (run) => ({ ...run, name: 'local' }))!;

  /** Looks the run up in the shared hub by owner, as the store's owner-scoped lookup does. */
  const lookup = async (owner: string, runId: string): Promise<WorkflowRunDtoV1> => {
    const run = hub.get(owner, runId);
    if (!run) throw new MultiModelError('not_found', 'not_found', 404);
    return run;
  };
  const unused = async (): Promise<never> => { throw new Error('not used'); };
  const orchestrator: MultiModelRunRouteDeps['orchestrator'] = {
    readyModelsFor: async () => ({ version: 1, runtimes: [] }),
    startRun: lookup,
    editPlan: unused, cancelProposal: unused, stopAll: unused, retryRun: unused,
    stopThread: unused, retryThread: unused, replaceThread: unused,
  };

  let server: Server;
  let base = '';
  const priorCloud = process.env.MICHI_CLOUD;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const user = req.header('x-user'); if (user) (req as unknown as { user: { id: string } }).user = { id: user }; next(); });
    app.use('/api', setupWorkflowRunRoutes({ hub, heartbeatMs: 60_000 }));
    app.use('/api', setupMultiModelRunRoutes({ orchestrator, hub }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => { if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud; });

  const call = async (method: string, path: string, user?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const runName = (response: { body: Record<string, unknown> }) => (response.body.run as WorkflowRunDtoV1 | undefined)?.name;

  it("reaches the same run through both routers for its owner", async () => {
    delete process.env.MICHI_CLOUD;
    const viaWorkflow = await call('GET', `/workflow-runs/${aliceRun.id}`, 'alice');
    const viaMultiModel = await call('POST', `/multi-model-runs/${aliceRun.id}/start`, 'alice');
    assert.deepEqual([viaWorkflow.status, runName(viaWorkflow)], [200, 'alice']);
    assert.deepEqual([viaMultiModel.status, runName(viaMultiModel)], [200, 'alice']);
    assert.equal((await call('GET', '/workflow-runs?workspaceId=ws-a', 'alice')).status, 200);
    assert.equal((await call('GET', '/multi-model/ready-models?workspaceId=ws-a', 'alice')).status, 200);
  });

  it('uses the local user on the desktop when the request has no user', async () => {
    delete process.env.MICHI_CLOUD;
    const viaWorkflow = await call('GET', `/workflow-runs/${localRun.id}`);
    const viaMultiModel = await call('POST', `/multi-model-runs/${localRun.id}/start`);
    assert.deepEqual([viaWorkflow.status, runName(viaWorkflow)], [200, 'local']);
    assert.deepEqual([viaMultiModel.status, runName(viaMultiModel)], [200, 'local']);
    assert.equal((await call('GET', '/workflow-runs?workspaceId=ws-local')).status, 200);
    assert.equal((await call('GET', '/multi-model/ready-models?workspaceId=ws-local')).status, 200);
  });

  it("gives another owner each router's existing refusal", async () => {
    delete process.env.MICHI_CLOUD;
    assert.deepEqual(await call('GET', `/workflow-runs/${aliceRun.id}`, 'bob'), { status: 404, body: { error: 'not_found' } });
    assert.deepEqual(await call('POST', `/multi-model-runs/${aliceRun.id}/start`, 'bob'),
      { status: 404, body: { error: 'not_found', code: 'not_found' } });
    assert.deepEqual(await call('GET', '/workflow-runs?workspaceId=ws-a', 'bob'), { status: 404, body: { error: 'not_found' } });
    assert.deepEqual(await call('GET', '/multi-model/ready-models?workspaceId=ws-a', 'bob'), { status: 404, body: { error: 'not_found' } });
    assert.deepEqual(await call('GET', '/workflow-runs', 'alice'), { status: 400, body: { error: 'workspaceId is required' } });
    assert.deepEqual(await call('GET', '/multi-model/ready-models?workspaceId=%20', 'alice'), { status: 400, body: { error: 'workspaceId is required' } });
  });

  it('answers 401 from both routers in cloud mode without a user', async () => {
    process.env.MICHI_CLOUD = '1';
    const unauthorized = { status: 401, body: { error: 'unauthorized' } };
    assert.deepEqual(await call('GET', `/workflow-runs/${localRun.id}`), unauthorized);
    assert.deepEqual(await call('POST', `/workflow-runs/${localRun.id}/actions`, undefined, { action: 'stop' }), unauthorized);
    assert.deepEqual(await call('POST', `/workflow-runs/${localRun.id}/approvals/a1`, undefined, { optionId: 'allow' }), unauthorized);
    assert.deepEqual(await call('GET', '/workflow-runs?workspaceId=ws-local'), unauthorized);
    assert.deepEqual(await call('POST', `/multi-model-runs/${localRun.id}/start`), unauthorized);
    assert.deepEqual(await call('GET', '/multi-model/ready-models?workspaceId=ws-local'), unauthorized);
    // A signed-in user still reaches their own run.
    assert.equal(runName(await call('POST', `/multi-model-runs/${aliceRun.id}/start`, 'alice')), 'alice');
    assert.equal(runName(await call('GET', `/workflow-runs/${aliceRun.id}`, 'alice')), 'alice');
  });
});
