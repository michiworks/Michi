import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import type { AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { metaAgentOverview, setMetaAgentPaused } from '../src/services/metaAgent/overview';
import { runMetaAgentRoundNow } from '../src/services/metaAgent/runNow';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMaintenanceConfig, getMaintenancePlan, listMaintenanceBacklog, markMaintenanceSourceAttention } from '../src/services/pages/maintenanceRepository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import type { ScheduledJobRecord, ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunHooks, type ScheduledRunOutcome } from '../src/services/scheduledJobs/scheduler';

const OWNER = 'local-user';

function fakeRuntime(id: string): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
  };
}
registerRuntime(fakeRuntime('pi'));

let tmpDir: string;
let now: number;
let nextId = 0;

interface StartedRun { hooks: ScheduledRunHooks; resolve(outcome?: ScheduledRunOutcome): void }

class Executor implements ScheduledJobExecutor {
  started: StartedRun[] = [];
  async start(job: ScheduledJobRecord, _run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const index = this.started.length + 1;
    const nodeId = `maintenance-node-${index}`;
    const treeId = `maintenance-tree-${index}`;
    getDb().prepare('INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES(?,?,?,?,?)').run(treeId, job.workspaceId, nodeId, now, now);
    getDb().prepare(`INSERT INTO nodes(id,workspace_id,tree_id,kind,status,minimized,created_at) VALUES(?,?,?,'chat','idle',0,?)`).run(nodeId, job.workspaceId, treeId, now);
    let settle!: (outcome?: ScheduledRunOutcome) => void;
    const done = new Promise<ScheduledRunOutcome>((resolve) => {
      settle = (outcome = { status: 'succeeded', summary: 'done', error: null }) => resolve(outcome);
    });
    this.started.push({ hooks, resolve: settle });
    return { nodeId, treeId, turnId: `maintenance-turn-${index}`, done, cancel: () => settle() };
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('condition did not become true');
}

function completeSource(turnId: string, scheduledOnlyJobId: string | null = null): void {
  const nodeId = `source-node-${turnId}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,scheduled_only_job_id,created_at) VALUES(?, 'ws', 'chat', 'idle', ?, ?)").run(nodeId, scheduledOnlyJobId, now);
  let turn = createDurableTurn({ turnId, assistantId: `assistant-${turnId}`, nodeId, workspaceId: 'ws', displayUserText: 'Plan the rollout', startedAt: now });
  beginTurn(turn);
  turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'Rollout plan' } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-retry-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  now = Date.parse('2026-10-23T02:00:00Z');
  mock.method(Date, 'now', () => now);
  nextId = 0;
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('ws', 'Workspace', now, now);
});

afterEach(() => {
  mock.restoreAll();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Retry queues a batch held for attention again, and the next run resumes that batch', async () => {
  const executor = new Executor();
  const scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: (runtimeId) => runtimeId === 'pi',
    clock: () => now, instanceId: 'attention-test-worker', createId: () => `job-${++nextId}`, pollIntervalMs: 60_000 });
  const job = scheduler.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain relevant spaces',
    schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh', conversationUpdates: true, notify: false });
  createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: OWNER, jobId: job.id, now, enabled: true });
  updateMetaAgentSettings({ runtimeId: 'pi' });
  getDb().prepare('UPDATE scheduled_jobs SET conversation_cursor=0 WHERE id=?').run(job.id);
  getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=0 WHERE job_id=?').run(job.id);
  completeSource('turn-a');

  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  markMaintenanceSourceAttention({ planId, ownerUserId: OWNER, sourceTurnId: 'turn-a', reason: 'contentTooLarge: the turn is over 2 MB', now });
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  assert.equal(getMaintenancePlan(planId, OWNER)!.state, 'attention');
  assert.equal(listMaintenanceBacklog('ws', OWNER).attentionSources, 1);

  now += 60_000;
  setMetaAgentPaused({ scheduler, ownerUserId: OWNER, paused: false, clock: () => now });
  const plan = getMaintenancePlan(planId, OWNER)!;
  assert.equal(plan.state, 'processing');
  assert.deepEqual(plan.sources.map((source) => source.state), ['routing']);
  assert.equal(listMaintenanceBacklog('ws', OWNER).attentionSources, 0);
  assert.equal(metaAgentOverview({ ownerUserId: OWNER, now }).cursors[0].problem?.reason === 'needs-attention', false);

  // Retry then runs one round through Update's path, which sees the queued batch as work.
  const round = runMetaAgentRoundNow({ scheduler, ownerUserId: OWNER });
  assert.equal(round.workspaces[0].outcome, 'started');
  await until(() => executor.started[1]?.hooks.maintenanceContext !== undefined);
  assert.equal(executor.started[1].hooks.maintenanceContext!.planId, planId, 'the held batch, not a new plan over the same turns');
  executor.started[1].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
});

function maintenanceScheduler(executor: Executor) {
  const scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: (runtimeId) => runtimeId === 'pi',
    clock: () => now, instanceId: 'attention-test-worker', createId: () => `job-${++nextId}`, pollIntervalMs: 60_000 });
  const job = scheduler.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain relevant spaces',
    schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh', conversationUpdates: true, notify: false });
  createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: OWNER, jobId: job.id, now, enabled: true });
  updateMetaAgentSettings({ runtimeId: 'pi' });
  getDb().prepare('UPDATE scheduled_jobs SET conversation_cursor=0 WHERE id=?').run(job.id);
  getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=0 WHERE job_id=?').run(job.id);
  return { scheduler, job };
}

const completionCursor = () => (getDb().prepare('SELECT completion_cursor FROM page_maintenance_configs').get() as { completion_cursor: number }).completion_cursor;

/** A job whose runs show only in Scheduled; disabled so this scheduler never starts it. */
function scheduledOnlyJob(): string {
  getDb().prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,permission_mode,session_mode,notify,enabled,auto_paused,consecutive_failures,timeout_seconds,created_at,updated_at)
    VALUES('report-job',?,'ws','Report','prompt','{"kind":"every","everySeconds":3600}','trust','fresh',0,0,0,0,1800,?,?)`).run(OWNER, now, now);
  return 'report-job';
}

test('a reply into a Scheduled-only run thread is not maintenance work: the run succeeds and the cursor moves past it', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  completeSource('turn-hidden', scheduledOnlyJob());
  await scheduler.runNow(job.id);
  await until(() => scheduler.getJob(job.id).activeRunId === null);

  assert.equal(executor.started.length, 0);
  assert.equal(scheduler.getJob(job.id).lastStatus, 'succeeded');
  assert.equal(completionCursor(), 1);
  assert.equal(listMaintenanceBacklog('ws', OWNER).plans.length, 0);
});

test('a pending batch skips a source whose thread shows only in Scheduled, and the cursor moves on', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  completeSource('turn-a');
  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  // Stands for a batch frozen before maintenance left these threads out.
  getDb().prepare('UPDATE nodes SET scheduled_only_job_id=? WHERE id=?').run(scheduledOnlyJob(), 'source-node-turn-a');

  now += 60_000;
  await scheduler.runNow(job.id);
  await until(() => scheduler.getJob(job.id).activeRunId === null);

  assert.equal(executor.started.length, 1, 'no session opens for a batch with nothing left to read');
  const plan = getMaintenancePlan(planId, OWNER)!;
  assert.equal(plan.state, 'terminal');
  assert.deepEqual(plan.sources.map((source) => [source.state, source.terminalReason]), [['skipped', 'Skipped: the conversation shows only in Scheduled']]);
  assert.equal(completionCursor(), plan.through);
  assert.equal(scheduler.getJob(job.id).lastStatus, 'succeeded');
});

test('Retry completes a held batch whose conversation was deleted: the source is skipped and the cursor moves on', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  completeSource('turn-a');
  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  markMaintenanceSourceAttention({ planId, ownerUserId: OWNER, sourceTurnId: 'turn-a', reason: 'A frozen source message is no longer readable', now });
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  getDb().prepare('UPDATE nodes SET deleted_at=? WHERE id=?').run(now, 'source-node-turn-a');

  now += 60_000;
  setMetaAgentPaused({ scheduler, ownerUserId: OWNER, paused: false, clock: () => now });
  assert.equal(runMetaAgentRoundNow({ scheduler, ownerUserId: OWNER }).workspaces[0].outcome, 'started');
  await until(() => scheduler.getJob(job.id).activeRunId === null);

  assert.equal(executor.started.length, 1, 'no session opens for a batch with nothing left to read');
  const plan = getMaintenancePlan(planId, OWNER)!;
  assert.equal(plan.state, 'terminal');
  assert.deepEqual(plan.sources.map((source) => [source.state, source.terminalReason]), [['skipped', 'Skipped: the conversation was deleted']]);
  assert.equal(completionCursor(), plan.through);
  assert.ok(plan.through > 0);
  assert.equal(scheduler.getJob(job.id).lastStatus, 'succeeded');
  assert.equal(listMaintenanceBacklog('ws', OWNER).plans.length, 0);
});

test('a pending batch reads only what is left: purged and archived sources are skipped, a live one is kept', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  for (const turnId of ['turn-a', 'turn-b', 'turn-c']) completeSource(turnId);
  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  assert.equal(getMaintenancePlan(planId, OWNER)!.state, 'routing', 'the run left every source undecided');
  getDb().prepare('DELETE FROM messages WHERE node_id=?').run('source-node-turn-a');
  getDb().prepare('UPDATE nodes SET purged_at=? WHERE id=?').run(now, 'source-node-turn-a');
  getDb().prepare("UPDATE nodes SET status='archived' WHERE id=?").run('source-node-turn-b');

  now += 60_000;
  await scheduler.runNow(job.id);
  await until(() => executor.started[1]?.hooks.maintenanceContext !== undefined);
  const context = executor.started[1].hooks.maintenanceContext!;
  assert.equal(context.planId, planId);
  assert.deepEqual(context.sources.map((source) => source.sourceTurnId), ['turn-c']);
  assert.deepEqual(getMaintenancePlan(planId, OWNER)!.sources.map((source) => [source.sourceTurnId, source.state, source.terminalReason]), [
    ['turn-a', 'skipped', 'Skipped: the conversation was deleted'],
    ['turn-b', 'skipped', 'Skipped: the conversation was archived'],
    ['turn-c', 'routing', null],
  ]);
  executor.started[1].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  assert.equal(completionCursor(), 0, 'the live source still holds the cursor until it is decided');
});

const SIGN_IN_STOP = 'Claude authentication failed. Refresh the CLI credentials and retry; the original session is retained.. Paused after 5 failed runs in a row.';

/** The job as the scheduler leaves it after five failed runs in a row. */
function stopAfterFailures(jobId: string, error: string): void {
  getDb().prepare(`UPDATE scheduled_jobs SET auto_paused=1,consecutive_failures=5,last_status='failed',last_error=?,last_run_at=?,updated_at=? WHERE id=?`)
    .run(error, now, now, jobId);
}

test('a sign-in stop is tried again after an hour: a success clears it, a failure stops it again for another hour', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  completeSource('turn-a');
  stopAfterFailures(job.id, SIGN_IN_STOP);
  scheduler.start();
  try {
    await scheduler.tick();
    assert.equal(executor.started.length, 0, 'held for the first hour');
    assert.equal(metaAgentOverview({ ownerUserId: OWNER, now }).stopped?.reason, 'signed-out');

    now += 60 * 60_000;
    await scheduler.tick();
    await until(() => executor.started.length === 1);
    assert.equal(scheduler.getJob(job.id).autoPaused, false, 'the retry runs unpaused');
    executor.started[0].resolve({ status: 'failed', summary: null, error: 'Claude authentication failed. Refresh the CLI credentials and retry; the original session is retained.' });
    await until(() => scheduler.getJob(job.id).activeRunId === null);
    const again = scheduler.getJob(job.id);
    assert.equal(again.autoPaused, true, 'one more failure stops it again');
    assert.match(again.lastError ?? '', /Paused after 6 failed runs in a row/);

    now += 30 * 60_000;
    await scheduler.tick();
    assert.equal(executor.started.length, 1, 'the next try waits an hour from that failure');

    // The fake executor decides no source, so let the held batch have nothing
    // left to read: the retry then succeeds without opening a session.
    getDb().prepare('UPDATE nodes SET deleted_at=? WHERE id=?').run(now, 'source-node-turn-a');
    now += 30 * 60_000;
    await scheduler.tick();
    await until(() => scheduler.getJob(job.id).lastStatus === 'succeeded');
    assert.equal(executor.started.length, 1);
    const recovered = scheduler.getJob(job.id);
    assert.deepEqual([recovered.autoPaused, recovered.consecutiveFailures, recovered.lastStatus], [false, 0, 'succeeded']);
    assert.equal(metaAgentOverview({ ownerUserId: OWNER, now }).stopped, null);
  } finally {
    await scheduler.stop();
  }
});

test('any other stop holds until Retry', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  completeSource('turn-a');
  stopAfterFailures(job.id, 'The model call failed: Claude\'s structured answer timed out after 180000 ms. Paused after 5 failed runs in a row.');
  scheduler.start();
  try {
    now += 3 * 60 * 60_000;
    await scheduler.tick();
    await flush();
    assert.equal(executor.started.length, 0);
    assert.equal(scheduler.getJob(job.id).autoPaused, true);
  } finally {
    await scheduler.stop();
  }
});
