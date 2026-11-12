import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { ScheduledJobsRepository, type SchedulerLease } from '../src/services/scheduledJobs/repository';
import { forEachFenceBreak } from './helpers/unattendedRunFence';

const NOW = 1_000;
let dir: string;
let repo: ScheduledJobsRepository;
let lease: SchedulerLease;
let runSeq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-conversation-progress-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES('w','W','alice',1,1)").run();
  getDb().prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,permission_mode,session_mode,notify,enabled,auto_paused,consecutive_failures,timeout_seconds,created_at,updated_at,conversation_cursor)
    VALUES('job','alice','w','Consumer','prompt','{"kind":"every","everySeconds":3600}','trust','fresh',0,1,0,0,1800,1,1,0)`).run();
  repo = new ScheduledJobsRepository();
  lease = repo.acquireLease('worker', NOW, 60_000)!;
});
afterEach(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

function claim(): string {
  const runId = `run-${++runSeq}`;
  const claimed = repo.claimRun({ jobId: 'job', runId, trigger: 'manual', now: NOW, lease, maxConcurrentRuns: 1, processExitStopsExecution: true, requireDue: false });
  assert.ok(claimed.run, claimed.reason);
  return runId;
}

function finish(runId: string, progress: { after: number; nextAfter: number; maintenanceConfigRevision?: number }) {
  repo.finishRun(runId, lease, { status: 'succeeded', finishedAt: NOW + 1, summary: null, error: null, notify: false,
    conversationProgress: { ...progress, workspaceId: 'w', claimedBy: 'worker', maintenancePlanId: null, maintenanceOwnerUserId: 'alice' } });
  return { status: repo.getRun(runId)!.status, cursor: repo.getJob('job')!.record.conversationCursor };
}

test('a run moves the conversation cursor only while it is still this scheduler lease\'s', () => {
  const runId = claim();
  forEachFenceBreak(runId, NOW + 1, (name) => {
    const result = finish(runId, { after: 0, nextAfter: 3 });
    assert.notEqual(result.status, 'succeeded', name);
    assert.equal(result.cursor, 0, name);
  });
  assert.deepEqual(finish(runId, { after: 0, nextAfter: 3 }), { status: 'succeeded', cursor: 3 });
});

test('an empty Pages maintenance batch succeeds only while the run is still this scheduler lease\'s', () => {
  const config = createMaintenanceConfig({ workspaceId: 'w', ownerUserId: 'alice', jobId: 'job', now: NOW, enabled: true });
  const runId = claim();
  forEachFenceBreak(runId, NOW + 1, (name) =>
    assert.notEqual(finish(runId, { after: 0, nextAfter: 0, maintenanceConfigRevision: config.revision }).status, 'succeeded', name));
  assert.equal(finish(runId, { after: 0, nextAfter: 0, maintenanceConfigRevision: config.revision }).status, 'succeeded');
});
