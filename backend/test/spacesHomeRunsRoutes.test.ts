// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupSpacesHomeRunRoutes } from '../src/routes/spacesHomeRuns';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler } from '../src/services/scheduledJobs/scheduler';
import { getMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { pauseMichi, resumeMichi } from '../src/services/michiPause';
import { turnBackgroundWorkOn } from './helpers/backgroundWork';

let dataDir: string;
let previousDataDir: string | undefined;
let server: Server | undefined;
let baseUrl = '';
let sched: ScheduledJobScheduler;
let jobSeq = 0;

async function listen(scheduler: ScheduledJobScheduler | null, visitMayStart?: () => boolean): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', setupSpacesHomeRunRoutes({ scheduler, clock: () => 5_000, ...(visitMayStart ? { visitMayStart } : {}) }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
}

beforeEach(() => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-spaces-home-runs-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  initDb();
  turnBackgroundWorkOn();
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,1,1)').run('ws-a', 'Workspace A');
  sched = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(),
    executor: { start: async () => { throw new Error('no model in route tests'); } },
    events: new ScheduledJobEventBus(), workspaceExists: () => true, runtimeExists: () => true,
    clock: () => 5_000, instanceId: 'routes', createId: () => `job-${++jobSeq}` });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  await sched.stop();
  closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (pathname: string, body?: unknown) => fetch(`${baseUrl}${pathname}`, { method: 'POST',
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

test('opening Spaces starts the first run once and later calls change nothing', async () => {
  await listen(sched);
  const before = await (await fetch(`${baseUrl}/spaces-home/first-run`)).json() as { requestedAt: number | null };
  assert.equal(before.requestedAt, null);
  const first = await post('/spaces-home/first-run');
  assert.equal(first.status, 200);
  const status = await first.json() as { requestedAt: number; workspaces: Array<{ workspaceId: string; firstRun: { state: string; total: number } | null }> };
  assert.equal(status.requestedAt, 5_000);
  assert.deepEqual(status.workspaces.map((home) => [home.workspaceId, home.firstRun?.state, home.firstRun?.total]), [['ws-a', 'done', 0]]);
  const jobId = getMaintenanceConfig('ws-a', 'local-user')?.jobId;
  assert.ok(jobId, 'the workspace is enrolled in managed maintenance');
  const again = await (await post('/spaces-home/first-run', {})).json() as typeof status;
  assert.deepEqual(again, status);
  assert.equal(sched.listJobs().length, 0, 'maintenance is not an ordinary scheduled job');
  assert.equal(sched.getJob(jobId).nextRunAt, null);
  assert.equal(new ScheduledJobsRepository().listMaintenanceExecutions().length, 1);
});

test('while Get started decides it, opening Spaces starts no first run; one already asked for is woken', async () => {
  let mayStart = false;
  await listen(sched, () => mayStart);
  const waiting = await post('/spaces-home/first-run');
  assert.equal(waiting.status, 200);
  assert.equal(((await waiting.json()) as { requestedAt: number | null }).requestedAt, null);
  assert.equal(getMaintenanceConfig('ws-a', 'local-user'), null, 'nothing is enrolled');
  mayStart = true;
  const started = await (await post('/spaces-home/first-run')).json() as { requestedAt: number | null };
  assert.equal(started.requestedAt, 5_000);
  mayStart = false;
  assert.deepEqual(await (await post('/spaces-home/first-run')).json(), started, 'a run asked for is woken whatever the card says');
});

test('while Michi is paused (off until turned on), opening Spaces enrolls and queues nothing', async () => {
  pauseMichi('local-user', null);
  await listen(sched);
  const status = await (await post('/spaces-home/first-run')).json() as { requestedAt: number | null; workspaces: Array<{ firstRun: unknown }> };
  assert.equal(status.requestedAt, null);
  assert.deepEqual(status.workspaces.map((home) => home.firstRun), [null]);
  assert.equal(getMaintenanceConfig('ws-a', 'local-user'), null);
  resumeMichi('local-user');
  assert.equal((await (await post('/spaces-home/first-run')).json() as { requestedAt: number | null }).requestedAt, 5_000, 'resumed, the next visit starts it');
});

test('retry validates its body and the routes need the scheduler', async () => {
  await listen(sched);
  assert.equal((await post('/spaces-home/first-run/retry', { workspaceId: 7 })).status, 400);
  assert.equal((await post('/spaces-home/first-run/retry', { other: true })).status, 400);
  assert.equal((await post('/spaces-home/first-run/retry', { workspaceId: 'ws-a' })).status, 200);
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await listen(null);
  const refused = await post('/spaces-home/first-run');
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: { message: string } }).error.message, /scheduled jobs/);
});
