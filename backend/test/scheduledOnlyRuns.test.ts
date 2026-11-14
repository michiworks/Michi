/**
 * Scheduled-only jobs: their runs' threads stay out of the user's
 * conversations (search, list_threads) unless an agent asks for them, the
 * scheduler keeps only the runs retention allows, and a run's thread can be
 * moved into its workspace.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULED_ONLY_RETENTION, type ScheduledJobRunEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, saveMessage, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { keywordSearch } from '../src/routes/search';
import { listThreads, searchMessages } from '../src/services/globalContext';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { keptRunIds } from '../src/services/scheduledJobs/scheduledOnly';
import {
  ScheduledJobNotFoundError,
  ScheduledJobScheduler,
  type ScheduledJobExecutor,
  type ScheduledRunHandle,
} from '../src/services/scheduledJobs/scheduler';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function seedChat(id: string, title: string, content: string, scheduledOnlyJobId: string | null = null): void {
  saveTree({ id: `t-${id}`, workspace_id: 'ws-a', root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: 'ws-a', tree_id: `t-${id}`, kind: 'chat', title, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  if (scheduledOnlyJobId) getDb().prepare('UPDATE nodes SET scheduled_only_job_id = ? WHERE id = ?').run(scheduledOnlyJobId, id);
  saveMessage({ id: `m-${id}`, node_id: id, role: 'user', content, seq: 1, created_at: 1 });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-scheduled-only-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  saveWorkspace({ id: 'ws-a', name: 'A', cwd: '/tmp/a', created_at: 1, updated_at: 1, settings: null });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('retention keeps the latest 5 runs, and up to 20 from the past 7 days', () => {
  const runs = (count: number, every: number, now: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `r${index}`, startedAt: now - index * every }));
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(keptRunIds(runs(30, HOUR, now), now).size, SCHEDULED_ONLY_RETENTION.maxRuns, 'hourly: the latest 20');
  assert.deepEqual([...keptRunIds(runs(10, DAY, now), now)].sort(), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'], 'daily: within 7 days');
  assert.deepEqual([...keptRunIds(runs(8, 7 * DAY, now), now)].sort(), ['r0', 'r1', 'r2', 'r3', 'r4'], 'weekly: at least 5');
  assert.equal(keptRunIds(runs(3, 30 * DAY, now), now + 365 * DAY).size, 3, 'a stopped job keeps its last runs');
});

describe('Scheduled-only threads and reads', () => {
  beforeEach(() => {
    seedChat('n-user', 'Heron rollout', 'heron rollout checklist');
    seedChat('n-run', 'Heron check', 'heron nightly check', 'job-hidden');
  });

  test('search and list_threads leave them out unless asked; the current thread is always listed', () => {
    assert.deepEqual(keywordSearch('heron', 'ws-a').map((row) => row.node_id), ['n-user']);
    assert.deepEqual(keywordSearch('heron', 'ws-a', 20, undefined, { includeScheduledRuns: true }).map((row) => row.node_id).sort(), ['n-run', 'n-user']);
    assert.doesNotMatch(searchMessages('ws-a', null, 'heron').text, /n-run/);
    assert.match(searchMessages('ws-a', null, 'heron', 'current', 10, { includeScheduledRuns: true }).text, /n-run/);

    const threads = (text: string) => (JSON.parse(text) as { threads: Array<{ id: string; scheduled_run?: true }> }).threads;
    assert.deepEqual(threads(listThreads('ws-a', null).text).map((thread) => thread.id), ['t-n-user']);
    const all = threads(listThreads('ws-a', null, undefined, undefined, { includeScheduledRuns: true }).text);
    assert.equal(all.find((thread) => thread.id === 't-n-run')?.scheduled_run, true);
    // The run itself sees its own thread.
    assert.ok(threads(listThreads('ws-a', null, undefined, 'n-run').text).some((thread) => thread.id === 't-n-run'));
  });

  test('graph snapshots cannot clear the mark, and a branch inherits it', () => {
    saveNode({ id: 'n-run', workspace_id: 'ws-a', tree_id: 't-n-run', kind: 'chat', title: 'Renamed', status: 'idle', minimized: 0,
      spawned_by_agent: 0, created_at: 1, scheduled_only_job_id: null });
    assert.equal(getNode('n-run')?.scheduled_only_job_id, 'job-hidden');
    saveNode({ id: 'n-branch', workspace_id: 'ws-a', tree_id: 't-n-run', parent_node_id: 'n-run', kind: 'chat', title: 'Branch',
      status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 2 });
    assert.equal(getNode('n-branch')?.scheduled_only_job_id, 'job-hidden');
    saveNode({ id: 'n-forged', workspace_id: 'ws-a', kind: 'chat', title: 'Forged', status: 'idle', minimized: 0,
      spawned_by_agent: 0, created_at: 3, scheduled_only_job_id: 'job-hidden' });
    assert.equal(getNode('n-forged')?.scheduled_only_job_id ?? null, null);
  });
});

/** Settles every run at once and creates its thread the way ChatScheduledJobExecutor does. */
class InstantExecutor implements ScheduledJobExecutor {
  private count = 0;
  constructor(private readonly clock: () => number) {}
  async start(job: ScheduledJobRecord, _run: ScheduledJobRunRecord): Promise<ScheduledRunHandle> {
    const reuse = job.sessionMode === 'persistent' && job.persistentNodeId && getNode(job.persistentNodeId) ? job.persistentNodeId : null;
    const nodeId = reuse ?? `node-${++this.count}`;
    const treeId = reuse ? getNode(reuse)!.tree_id! : `tree-${this.count}`;
    if (!reuse) {
      const createdAt = this.clock();
      getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(treeId, job.workspaceId, nodeId, createdAt, createdAt);
      getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, minimized, created_at, scheduled_only_job_id)
        VALUES (?, ?, ?, 'chat', 'idle', 0, ?, ?)`).run(nodeId, job.workspaceId, treeId, createdAt, job.visibility === 'scheduled' ? job.id : null);
    }
    return { nodeId, treeId, turnId: `turn-${nodeId}-${this.clock()}`, done: Promise.resolve({ status: 'succeeded', summary: 'ok', error: null }), cancel: () => {} };
  }
}

describe('Scheduled-only jobs in the scheduler', () => {
  let now: number;
  let scheduler: ScheduledJobScheduler;
  let published: ScheduledJobRunEvent[];

  const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const live = (jobId: string) => (getDb().prepare('SELECT id FROM nodes WHERE scheduled_only_job_id = ? AND purged_at IS NULL ORDER BY id')
    .all(jobId) as Array<{ id: string }>).map((row) => row.id);
  const runTimes = async (jobId: string, count: number, every: number) => {
    for (let index = 0; index < count; index += 1) {
      await scheduler.runNow(jobId);
      await settle();
      now += every;
    }
  };

  beforeEach(() => {
    now = Date.parse('2026-11-06T12:00:00Z');
    let ids = 0;
    published = [];
    const events = new ScheduledJobEventBus();
    events.subscribe({ send: (event) => published.push(event) });
    scheduler = new ScheduledJobScheduler({
      repository: new ScheduledJobsRepository(), executor: new InstantExecutor(() => now), events,
      workspaceExists: (id) => id === 'ws-a', runtimeExists: () => true, clock: () => now,
      instanceId: 'instance-a', createId: () => `job-${++ids}`, pollIntervalMs: 60_000,
    });
  });

  afterEach(async () => { await scheduler.stop(); });

  const base = { workspaceId: 'ws-a', name: 'Nightly check', prompt: 'Check the build.', schedule: { kind: 'every', everySeconds: 3600 } };

  test('keeps the threads of the runs retention allows and lists the rest without one', async () => {
    const job = scheduler.createJob({ ...base, visibility: 'scheduled', sessionMode: 'fresh' });
    assert.equal(job.visibility, 'scheduled');
    const visible = scheduler.createJob({ ...base, name: 'Visible' });
    assert.equal(visible.visibility, 'workspace');
    scheduler.deleteJob(visible.id);
    await runTimes(job.id, 23, HOUR);
    assert.equal(live(job.id).length, 20);
    const runs = scheduler.listRuns(job.id);
    assert.equal(runs.length, 23);
    assert.deepEqual(runs.slice(20).map((run) => run.nodeId), [null, null, null], 'the oldest runs stay in the history without a thread');
    assert.ok(runs.slice(0, 20).every((run) => run.scheduledOnly === true));
    assert.equal(published.filter((event) => event.phase === 'finished').at(-1)?.scheduledOnly, true);

    // Paused, a week later: the age limit applies without a new run, down to the latest 5.
    scheduler.updateJob(job.id, { enabled: false });
    now += 8 * DAY;
    scheduler.start();
    await scheduler.tick();
    assert.equal(live(job.id).length, SCHEDULED_ONLY_RETENTION.minRuns);
  });

  test('a moved thread stays and the job stops continuing it; deleting the job removes the rest', async () => {
    const job = scheduler.createJob({ ...base, visibility: 'scheduled', sessionMode: 'persistent' });
    await runTimes(job.id, 2, HOUR);
    const [latest] = scheduler.listRuns(job.id);
    assert.equal(scheduler.getJob(job.id).persistentNodeId, latest.nodeId);
    assert.equal(live(job.id).length, 1, 'both runs continued one thread');

    const moved = scheduler.moveRunToWorkspace(latest.id);
    assert.equal(moved.scheduledOnly, false);
    assert.equal(getNode(latest.nodeId!)?.scheduled_only_job_id ?? null, null);
    assert.equal(scheduler.getJob(job.id).persistentNodeId, null);
    assert.equal(scheduler.moveRunToWorkspace(latest.id).nodeId, latest.nodeId, 'moving again changes nothing');

    await runTimes(job.id, 1, HOUR);
    const [next] = scheduler.listRuns(job.id);
    assert.notEqual(next.nodeId, latest.nodeId);
    assert.equal(next.scheduledOnly, true);

    scheduler.deleteJob(job.id);
    assert.deepEqual(live(job.id), []);
    assert.ok(getNode(latest.nodeId!), 'the moved thread is the user’s');
    assert.throws(() => scheduler.moveRunToWorkspace(next.id), ScheduledJobNotFoundError);
  });

  test('changing where runs show starts a new ongoing thread', async () => {
    const job = scheduler.createJob({ ...base, sessionMode: 'persistent' });
    await runTimes(job.id, 1, HOUR);
    assert.ok(scheduler.getJob(job.id).persistentNodeId);
    assert.equal(scheduler.updateJob(job.id, { visibility: 'scheduled' }).persistentNodeId, null);
  });
});
