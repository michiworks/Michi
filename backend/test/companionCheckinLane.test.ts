import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * P6a, the scheduler's check-in lane (unification D11, design §5 P6): its
 * execution identity, which nothing but the lane starts and which takes no
 * maintenance slot and none of maxConcurrentRuns; the engine switch; the
 * shadow, which looks with the coordinator's planner on its own state and
 * cursors, changes none of the coordinator's decisions and agrees with them;
 * and the read-only reconciliation the local report prints. Fake clocks, a
 * fake runner and sources; temp MICHI_DATA_DIR per test.
 */

import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompanionItemSubtype, CompanionPresenceInput, CompanionSourceKind } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { checkinEngine } from '../src/services/companion/checkinEngine';
import { createCheckinLane, laneOutcome } from '../src/services/companion/checkinLane';
import { CHECKIN_IDENTITY, checkinIdentityJobId, isCheckinIdentityJob, sweepCheckinIdentity } from '../src/services/companion/checkinIdentity';
import { reconcileCheckinShadow, recordCheckinShadowStart } from '../src/services/companion/checkinShadow';
import { startCompanion, type CompanionCoordinator, type CompanionCoordinatorDeps } from '../src/services/companion/coordinator';
import { CompanionEventBus } from '../src/services/companion/delivery';
import { patchCompanionSettings } from '../src/services/companion/settings';
import {
  briefForDate, getCompanionMetaNumber, insertBrief, latestEventSeq, markCompanionWelcomeDone, recordDelegation, recordRun, setCompanionMetaNumber,
} from '../src/services/companion/repository';
import type { CompanionMichiSource, CompanionWorkerState } from '../src/services/companion/sources/michi';
import type {
  CompanionDraftInput, CompanionPollContext, CompanionSource, CompanionTurnOutcome, CompanionTurnRequest, CompanionTurnRunner, ItemDraft, SourcePollResult,
} from '../src/services/companion/types';
import { maintenanceExecutionHasWork, maintenanceHasWork } from '../src/services/metaAgent/maintenanceCoordinator';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord, type SchedulerLease } from '../src/services/scheduledJobs/repository';
import { JobValidationError } from '../src/services/scheduledJobs/validation';
import { ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunOutcome } from '../src/services/scheduledJobs/scheduler';
import { turnCompanionOn } from './helpers/backgroundWork';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Thursday 2026-11-05 and the days around it, local time. */
const localAt = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second, 0).getTime();

let tmpDir: string;
function openDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-checkin-lane-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  initDb(); enableSyntheticCompanionSources();
  // Michi is off until the user turns it on (Resume); the lane and its shadow are of a Michi that runs.
  turnCompanionOn();
}
function dropDb(): void {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── The scheduler side ──────────────────────────────────────────────────────

class HeldExecutor implements ScheduledJobExecutor {
  processExitStopsExecution = true;
  readonly started: ScheduledJobRunRecord[] = [];
  private readonly finishers: Array<(outcome: ScheduledRunOutcome) => void> = [];
  async start(job: ScheduledJobRecord, run: ScheduledJobRunRecord): Promise<ScheduledRunHandle> {
    this.started.push(run);
    const nodeId = `node-${run.id}`;
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES (?, ?, 'chat', 'idle', 1)`).run(nodeId, job.workspaceId);
    const done = new Promise<ScheduledRunOutcome>((resolve) => this.finishers.push(resolve));
    return { nodeId, treeId: null, turnId: `turn-${run.id}`, done, cancel: () => {} };
  }
  finishAll(): void {
    for (const finish of this.finishers.splice(0)) finish({ status: 'succeeded', summary: null, error: null });
  }
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done)); };

describe('the check-in lane in the scheduler', () => {
  let now: number;
  let executor: HeldExecutor;
  let repo: ScheduledJobsRepository;
  let schedulers: ScheduledJobScheduler[];
  let seq: number;
  const fields = { workspaceId: 'w', name: 'Task', prompt: 'Do work', schedule: { kind: 'every', everySeconds: 60 } };

  beforeEach(() => {
    openDb();
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w', 'W', 1, 1)").run();
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('assistant', 'Michi', 1, 1)").run();
    now = Date.parse('2026-11-05T12:00:00Z');
    seq = 0;
    executor = new HeldExecutor();
    repo = new ScheduledJobsRepository();
    schedulers = [];
  });

  afterEach(async () => {
    executor.finishAll();
    await flush();
    for (const scheduler of schedulers) await scheduler.stop();
    await flush();
    dropDb();
  });

  function scheduler(maxConcurrentRuns = 2, tick?: (scheduler: ScheduledJobScheduler, now: number) => void) {
    const checkinLane = tick ? { tick, run: async () => ({ status: 'succeeded' as const, summary: null, error: null }) } : undefined;
    const made = new ScheduledJobScheduler({
      repository: repo, executor, events: new ScheduledJobEventBus(), clock: () => now, instanceId: 'a', workspaceExists: () => true,
      runtimeExists: () => true, leaseTtlMs: 90_000, pollIntervalMs: 60_000, cancelGraceMs: 5, maxConcurrentRuns, createId: () => `job-${++seq}`,
      ...(checkinLane ? { checkinLane } : {}),
    });
    schedulers.push(made);
    return made;
  }
  const lease = () => getDb().prepare('SELECT holder, generation FROM scheduler_lease WHERE id = 1').get() as unknown as SchedulerLease;
  let probes = 0;
  const claim = (jobId: string, maxConcurrentRuns = 2) => repo.claimRun({
    jobId, runId: `probe-${++probes}`, trigger: 'scheduled', now, lease: lease(), maxConcurrentRuns, processExitStopsExecution: false, nextRunAt: null, requireDue: false,
  });
  /** A claim a replaced backend left behind, unconfirmed. */
  function orphanClaim(jobId: string, workspaceId: string): void {
    const runId = `orphan-${jobId}`;
    getDb().prepare(`INSERT INTO scheduled_job_runs (id, job_id, workspace_id, trigger, status, started_at, claimed_by)
      VALUES (?, ?, ?, 'scheduled', 'running', ?, 'old-backend')`).run(runId, jobId, workspaceId, now);
    getDb().prepare(`INSERT INTO scheduler_execution_claims (run_id, job_id, holder, generation, process_id, acquired_at, workspace_id, process_exit_safe)
      VALUES (?, ?, 'old-backend', 1, NULL, ?, ?, 0)`).run(runId, jobId, now, workspaceId);
  }

  test('each tick keeps one identity in the assistant\'s workspace: made once, again when its job went, none before the workspace', async () => {
    let workspace: string | null = null;
    const a = scheduler(2, (made, at) => sweepCheckinIdentity(made, at, workspace));
    a.start();
    await a.tick();
    assert.equal(checkinIdentityJobId('local-user'), null, 'no assistant workspace yet');
    workspace = 'assistant';
    await a.tick();
    await a.tick();
    const id = checkinIdentityJobId('local-user')!;
    const job = repo.getJob(id)!.record;
    assert.deepEqual([job.executionKind, job.workspaceId, job.name, job.timeoutSeconds, job.notify, job.enabled],
      ['maintenance', 'assistant', CHECKIN_IDENTITY.name, CHECKIN_IDENTITY.timeoutSeconds, false, true]);
    assert.equal(repo.listMaintenanceExecutions().filter((record) => isCheckinIdentityJob(record.id)).length, 1, 'once');

    a.deleteJob(id);
    await a.tick();
    const again = checkinIdentityJobId('local-user')!;
    assert.notEqual(again, id);
    assert.equal(isCheckinIdentityJob(again), true);
    assert.equal(executor.started.length, 0, 'P6a starts no check-in run');
  });

  test('the maintenance coordinator finds no work for it, and a person cannot start it', async () => {
    const a = scheduler();
    sweepCheckinIdentity(a, now, 'assistant');
    const id = checkinIdentityJobId('local-user')!;
    assert.equal(maintenanceExecutionHasWork(repo.getJob(id)!.record, now, true), false);
    a.start();
    await a.tick();
    assert.equal(executor.started.length, 0);
    await assert.rejects(a.runNow(id), /starts its check-ins itself/);
  });

  test('admission: two claims at the cap and the maintenance slot taken, a check-in is still admitted, and holds none of them', async () => {
    const a = scheduler();
    a.start();
    await a.tick();
    sweepCheckinIdentity(a, now, 'assistant');
    const checkin = checkinIdentityJobId('local-user')!;
    const [one, two, three] = [1, 2, 3].map(() => a.createJob({ ...fields, enabled: false }));
    const pages = a.createMaintenanceExecution({ workspaceId: 'w', name: 'Space maintenance', prompt: 'Maintain', schedule: { kind: 'every', everySeconds: 60 } }, 'local-user');
    assert.ok(claim(one!.id).run);
    assert.ok(claim(pages.id).run);
    assert.equal(claim(two!.id).reason, 'capacity', 'at the cap of two');
    assert.ok(claim(checkin).run, 'the check-in is admitted all the same');
    assert.equal(claim(checkin).reason, 'job_running', 'one at a time');

    getDb().prepare('DELETE FROM scheduler_execution_claims WHERE job_id = ?').run(one!.id);
    assert.ok(claim(three!.id).run, 'the check-in\'s claim takes none of the cap');
  });

  test('an unconfirmed claim holds back only its own side', async () => {
    const a = scheduler();
    a.start();
    await a.tick();
    sweepCheckinIdentity(a, now, 'assistant');
    const checkin = checkinIdentityJobId('local-user')!;
    const pages = a.createMaintenanceExecution({ workspaceId: 'w', name: 'Space maintenance', prompt: 'Maintain', schedule: { kind: 'every', everySeconds: 60 } }, 'local-user');
    const job = a.createJob({ ...fields, enabled: false });

    orphanClaim(pages.id, 'w');
    assert.equal(claim(job.id).reason, 'unresolved_execution', 'control: it holds back the user\'s jobs');
    assert.ok(claim(checkin).run, 'an unconfirmed Pages claim does not hold back a check-in');

    getDb().prepare('DELETE FROM scheduler_execution_claims').run();
    getDb().prepare("DELETE FROM scheduled_job_runs WHERE status = 'running'").run();
    orphanClaim(checkin, 'assistant');
    assert.equal(claim(checkin).reason, 'unresolved_execution', 'until the scheduler releases it');
    assert.ok(claim(job.id).run, 'a dead process\'s check-in claim holds back no other job');
  });

  test('the engine switch: the coordinator by default, the stored key, the environment over both', () => {
    assert.equal(checkinEngine({}), 'coordinator');
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('companion:engine', 'scheduler')").run();
    assert.equal(checkinEngine({}), 'scheduler');
    assert.equal(checkinEngine({ MICHI_CHECKIN_ENGINE: 'coordinator' }), 'coordinator', 'the environment wins');
    assert.equal(checkinEngine({ MICHI_CHECKIN_ENGINE: 'nonsense' }), 'scheduler', 'an unknown value is no choice');
  });

  test('rollback: code from before P6 finds no work for the identity and cannot start it in its hidden workspace', async () => {
    const a = new ScheduledJobScheduler({
      repository: repo, executor, events: new ScheduledJobEventBus(), clock: () => now, instanceId: 'a',
      // As in server.ts: the assistant's hidden workspace is no place a job may run.
      workspaceExists: (id) => id !== 'assistant', maintenanceWorkspaceExists: (id) => id === 'assistant',
      runtimeExists: () => true, leaseTtlMs: 90_000, pollIntervalMs: 60_000, cancelGraceMs: 5, createId: () => `job-${++seq}`,
    });
    schedulers.push(a);
    sweepCheckinIdentity(a, now, 'assistant');
    const id = checkinIdentityJobId('local-user')!;
    assert.equal(maintenanceHasWork('assistant', 'local-user', now, true), false, 'the Pages check, all older code has, finds nothing');
    assert.throws(() => a.startNow(id), JobValidationError, 'refused before any check-in rule: the workspace does not exist to it');
  });
});

// ── The shadow beside the coordinator ───────────────────────────────────────

interface FakeObject { version: string; subtype?: CompanionItemSubtype }

class FakeSource implements CompanionSource {
  readonly objects = new Map<string, FakeObject>();
  constructor(readonly kind: CompanionSourceKind) {}
  intervalMs(): number {
    return 5 * MINUTE;
  }
  async poll(ctx: CompanionPollContext): Promise<SourcePollResult> {
    const observations = [...this.objects].map(([objectKey, object]) => ({ source: this.kind, objectKey, fingerprint: object.version, state: { ...object }, observedAt: ctx.now }));
    return { source: this.kind, ok: true, complete: true, observations, detail: `${this.objects.size} seen` };
  }
  draft(input: CompanionDraftInput): ItemDraft[] {
    return input.observations.map((observation) => ({
      source: this.kind, subtype: (observation.state as unknown as FakeObject).subtype ?? 'cr_needs_attention', itemKey: observation.objectKey,
      version: observation.fingerprint, bucket: 'needs_you', severity: 'now', title: `${observation.objectKey} changed`, summary: null,
      target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' }, facts: {}, observedAt: input.now,
    }));
  }
}

/** Michi's own source, for worker reports only. */
class FakeMichi implements CompanionMichiSource {
  readonly kind = 'michi' as const;
  readonly workers = new Map<string, CompanionWorkerState>();
  intervalMs(): number {
    return 5 * MINUTE;
  }
  async poll(): Promise<SourcePollResult> {
    return { source: 'michi', ok: true, complete: true, observations: [], detail: '0 seen' };
  }
  draft(): ItemDraft[] {
    return [];
  }
  focusSnapshot() {
    return [];
  }
  workerStates(nodeIds: readonly string[]): Map<string, CompanionWorkerState> {
    return new Map(nodeIds.flatMap((id) => (this.workers.has(id) ? [[id, this.workers.get(id)!] as const] : [])));
  }
}

class FakeRunner implements CompanionTurnRunner {
  readonly requests: CompanionTurnRequest[] = [];
  respond: (request: CompanionTurnRequest) => CompanionTurnOutcome = () => ({ outcome: 'quiet' });
  isIdle(): boolean {
    return true;
  }
  async run(request: CompanionTurnRequest): Promise<CompanionTurnOutcome> {
    this.requests.push(request);
    return this.respond(request);
  }
  async preempt(): Promise<void> {}
}

const HERE: CompanionPresenceInput = { active: true, companionFocused: false, lastInputAt: null, composing: false };
const TICK = 30 * SECOND;

/** What the coordinator decided: its turns and what they moved. */
interface Decisions {
  turns: Array<[string, string, number]>;
  runs: Array<[string, number, string]>;
  meta: Array<number | null>;
  briefs: Array<string | null>;
  delegations: Array<Record<string, unknown>>;
}

/** What the shadow must leave as it was. */
function sharedState(): string {
  const rows = (sql: string) => getDb().prepare(sql).all();
  return JSON.stringify([
    rows("SELECT key, value FROM meta WHERE key LIKE 'companion:%' ORDER BY key"),
    rows('SELECT * FROM companion_delegations ORDER BY id'),
    rows('SELECT * FROM companion_briefs ORDER BY date'),
    rows('SELECT * FROM companion_runs ORDER BY id'),
    rows('SELECT * FROM companion_cards ORDER BY id'),
    rows('SELECT * FROM companion_items ORDER BY id'),
  ]);
}

describe('the shadow beside the coordinator (P6a)', () => {
  // The coordinator's waits are bounded by unref'd timers; keep the loop alive.
  let keepAlive: ReturnType<typeof setInterval>;
  before(() => { keepAlive = setInterval(() => {}, 2 ** 30); });
  after(() => clearInterval(keepAlive));

  beforeEach(openDb);
  afterEach(dropDb);

  /**
   * Thursday morning to noon on 30 s ticks: two wakes ten minutes apart (the
   * second failing once), the brief, a worker's report, and two hours away
   * with an item that comes in meanwhile, then one after the return. With the
   * shadow, the lane looks 15 s after each coordinator tick, as the scheduler's
   * own timer would, and each look must leave the shared state as it was.
   */
  async function scenario(withShadow: boolean): Promise<{ decisions: Decisions; coordinator: CompanionCoordinator; lane: Array<[string, number]> }> {
    let now = localAt(5, 8, 40);
    const cr = new FakeSource('cr');
    const michi = new FakeMichi();
    const runner = new FakeRunner();
    let wakes = 0;
    runner.respond = (request) => {
      if (request.kind === 'brief') {
        insertBrief({ date: '2026-11-05', headline: 'Two CRs need you', cards: [], closing: "That's all for today.", origin: 'llm', now });
      }
      if (request.kind === 'wake' && ++wakes === 2) return { outcome: 'error', detail: 'timed out' };
      return { outcome: 'spoke', messageText: 'Noted.' };
    };
    const coordinator = startCompanion({
      clock: { now: () => now }, sources: [cr], michiSource: michi, auth: null, autoTick: false, events: new CompanionEventBus(),
      turnRunner: () => runner, isPaneVisible: () => false, nodeViewedAt: () => null, conversationNodeId: () => null,
    });
    markCompanionWelcomeDone(localAt(4, 8, 0));
    for (const key of ['companion:wake_cursor', 'companion:brief_cursor'] as const) setCompanionMetaNumber(key, latestEventSeq());
    recordDelegation({ workspaceId: 'w', nodeId: 'n-worker', title: 'Fix the build', now: localAt(5, 8, 0) });
    const worker = (state: Partial<CompanionWorkerState>) => michi.workers.set('n-worker', {
      nodeId: 'n-worker', exists: true, workspaceName: 'W', title: 'Fix the build', turnStatus: 'active', stopReason: null, error: null,
      messageId: null, endedAt: null, reply: '', viewedAt: null, userTookOver: false, ...state,
    } as CompanionWorkerState);
    worker({});
    // A second worker's conversation goes between a coordinator tick and the lane's look: only the coordinator closes it.
    recordDelegation({ workspaceId: 'w', nodeId: 'n-gone', title: 'Draft the doc', now: localAt(5, 8, 0) });
    michi.workers.set('n-gone', { ...michi.workers.get('n-worker')!, nodeId: 'n-gone', title: 'Draft the doc' });
    const betweenTicks: Array<[number, () => void]> = [[localAt(5, 9, 30), () => michi.workers.set('n-gone', { ...michi.workers.get('n-gone')!, exists: false })]];

    const lane: Array<[string, number]> = [];
    const awayFrom = localAt(5, 9, 40);
    const backAt = localAt(5, 11, 50);
    const events: Array<[number, () => void]> = [
      [localAt(5, 8, 45), () => cr.objects.set('cr:N', { version: 'v1' })],
      [localAt(5, 8, 50), () => cr.objects.set('cr:M', { version: 'v1' })],
      [localAt(5, 9, 10), () => worker({ turnStatus: 'completed', messageId: 'm-1', endedAt: localAt(5, 9, 10), reply: 'Fixed.' })],
      // Away from 11:40 (two hours without the user); polled at 11:45, while away.
      [localAt(5, 11, 41), () => cr.objects.set('cr:Q', { version: 'v1' })],
      [localAt(5, 11, 55), () => cr.objects.set('cr:R', { version: 'v1' })],
    ];
    try {
      for (let at = localAt(5, 8, 40); at <= localAt(5, 12, 0); at += TICK) {
        now = at;
        for (const [when, change] of events) if (when === at) change();
        if (at < awayFrom || at >= backAt) await coordinator.service.onPresence(HERE);
        await coordinator.tick();
        await coordinator.idle();
        for (const [when, change] of betweenTicks) if (when === at) change();
        if (withShadow) {
          now = at + 15 * SECOND;
          const before = sharedState();
          const kind = coordinator.lookAsLane(now);
          assert.equal(sharedState(), before, `the shadow's look at ${new Date(now).toTimeString().slice(0, 8)} changed nothing shared`);
          if (kind) lane.push([kind, now]);
        }
      }
    } finally {
      await coordinator.stop();
    }
    const decisions: Decisions = {
      turns: runner.requests.map((request) => [request.kind, request.trigger, getDb().prepare('SELECT started_at AS at FROM companion_runs WHERE id = ?').get(request.runId)!.at as number]),
      runs: (getDb().prepare("SELECT kind, started_at AS at, outcome FROM companion_runs WHERE kind != 'poll' ORDER BY started_at, rowid").all() as Array<{ kind: string; at: number; outcome: string }>)
        .map((run) => [run.kind, run.at, run.outcome]),
      meta: (['companion:wake_cursor', 'companion:brief_cursor', 'companion:last_wake_at'] as const).map((key) => getCompanionMetaNumber(key)),
      briefs: [briefForDate('2026-11-05')?.origin ?? null],
      delegations: (getDb().prepare('SELECT node_id AS nodeId, state, closed_reason AS closedReason FROM companion_delegations ORDER BY node_id').all() as Array<Record<string, unknown>>)
        .map((row) => ({ ...row })),
    };
    return { decisions, coordinator, lane };
  }

  test('its looks change none of the coordinator\'s decisions, and it would have started the same check-ins within a tick', async () => {
    const without = (await scenario(false)).decisions;
    dropDb();
    openDb();
    const { decisions, lane } = await scenario(true);
    assert.deepEqual(decisions, without, 'the same turns, at the same times, moving the same cursors');
    assert.deepEqual(without.turns.map(([kind]) => kind),
      ['heartbeat', 'wake', 'wake', 'brief', 'wake', 'worker_report', 'heartbeat', 'heartbeat', 'heartbeat', 'wake'],
      'control: the scenario has every kind, a failed wake retried, no wake for what came in while away, and a heartbeat every hour, away too');

    const shadow = reconcileCheckinShadow(getDb(), localAt(5, 0), localAt(6, 0));
    assert.deepEqual([shadow.shadowOnly, shadow.coordinatorOnly], [[], []], JSON.stringify({ lane, turns: without.turns }));
    assert.equal(shadow.matched, without.turns.length);
    assert.deepEqual(shadow.days.map((day) => [day.date, day.counts]), [['2026-11-05', {
      worker_report: { shadow: 1, coordinator: 1 }, wake: { shadow: 4, coordinator: 4 }, brief: { shadow: 1, coordinator: 1 },
      heartbeat: { shadow: 4, coordinator: 4 },
    }]]);
    for (const [kind, at] of lane) {
      const twin = without.turns.find(([other, , started]) => other === kind && at >= started && at - started <= TICK);
      assert.ok(twin, `${kind} at ${new Date(at).toTimeString().slice(0, 8)} is within a tick after the coordinator's`);
    }
  });

  test('a check-in the coordinator starts before the lane\'s first look is still the shadow\'s: it read its cursors first', async () => {
    // The brief is due at the coordinator's very first tick, ahead of the scheduler's first look.
    let now = localAt(5, 9, 0);
    const runner = new FakeRunner();
    runner.respond = (request) => {
      if (request.kind === 'brief') insertBrief({ date: '2026-11-05', headline: 'Two CRs need you', cards: [], closing: "That's all for today.", origin: 'llm', now });
      return { outcome: 'spoke', messageText: 'Noted.' };
    };
    const coordinator = startCompanion({
      clock: { now: () => now }, sources: [new FakeSource('cr')], michiSource: null, auth: null, autoTick: false, events: new CompanionEventBus(),
      turnRunner: () => runner, isPaneVisible: () => false, nodeViewedAt: () => null, conversationNodeId: () => null,
    });
    markCompanionWelcomeDone(localAt(4, 8, 0));
    try {
      await coordinator.service.onPresence(HERE);
      await coordinator.tick();
      await coordinator.idle();
      assert.deepEqual(runner.requests.map((request) => request.kind), ['brief'], 'the coordinator\'s first tick ran it');
      now = localAt(5, 9, 0, 15);
      assert.equal(coordinator.lookAsLane(now), 'brief', 'and the lane would have started it too');
      const report = reconcileCheckinShadow(getDb(), localAt(5, 0), localAt(6, 0));
      assert.deepEqual([report.matched, report.shadowOnly, report.coordinatorOnly], [1, [], []]);
    } finally {
      await coordinator.stop();
    }
  });

  test('nothing to shadow before the first welcome, while paused, or before the coordinator has started up', async () => {
    let now = localAt(5, 9, 0);
    const cr = new FakeSource('cr');
    const coordinator = startCompanion({
      clock: { now: () => now }, sources: [cr], michiSource: null, auth: null, autoTick: false, events: new CompanionEventBus(),
      turnRunner: () => new FakeRunner(), isPaneVisible: () => false, nodeViewedAt: () => null, conversationNodeId: () => null,
    });
    try {
      assert.equal(coordinator.lookAsLane(now), null, 'not started up');
      await coordinator.tick();
      await coordinator.idle();
      cr.objects.set('cr:N', { version: 'v1' });
      for (let i = 0; i < 6; i += 1) {
        now += TICK;
        await coordinator.tick();
        await coordinator.idle();
        assert.equal(coordinator.lookAsLane(now), null, 'no welcome yet');
      }
      assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM companion_checkin_shadow').get() as { n: number }).n, 0);
    } finally {
      await coordinator.stop();
    }
  });
});

describe('the reconciliation report', () => {
  beforeEach(openDb);
  afterEach(dropDb);

  test('pairs starts of a kind within the tolerance, by day, with each day\'s first brief; kind and time only', () => {
    const day = localAt(5, 0);
    const run = (kind: 'wake' | 'brief' | 'worker_report', at: number, turn = true) => {
      const record = recordRun({ kind, trigger: 'schedule', startedAt: at, outcome: 'spoke', finishedAt: at + MINUTE });
      if (turn) getDb().prepare('UPDATE companion_runs SET turn_id = ? WHERE id = ?').run(`cmp-${record.id}`, record.id);
    };
    run('brief', localAt(5, 9, 0));
    recordCheckinShadowStart('brief', localAt(5, 9, 0, 20));
    run('wake', localAt(5, 10, 0));
    recordCheckinShadowStart('wake', localAt(5, 10, 1, 30), getDb());
    run('wake', localAt(5, 11, 0), false);
    recordCheckinShadowStart('worker_report', localAt(5, 12, 0));
    run('wake', localAt(6, 8, 0));
    recordCheckinShadowStart('wake', localAt(6, 7, 59, 30));
    const report = reconcileCheckinShadow(getDb(), day, localAt(7, 0));
    assert.equal(report.matched, 2, 'the brief 20 s apart and the next day\'s wake 30 s early');
    assert.deepEqual(report.shadowOnly, [{ kind: 'wake', at: localAt(5, 10, 1, 30) }, { kind: 'worker_report', at: localAt(5, 12, 0) }], '90 s apart is not the same');
    assert.deepEqual(report.coordinatorOnly, [{ kind: 'wake', at: localAt(5, 10, 0) }], 'a run with no turn never started a check-in');
    assert.deepEqual(report.days.map((entry) => [entry.date, entry.counts.wake, entry.brief]), [
      ['2026-11-05', { shadow: 1, coordinator: 1 }, { shadow: localAt(5, 9, 0, 20), coordinator: localAt(5, 9, 0) }],
      ['2026-11-06', { shadow: 1, coordinator: 1 }, { shadow: null, coordinator: null }],
    ]);
    const columns = (getDb().prepare("SELECT name FROM pragma_table_info('companion_checkin_shadow')").all() as Array<{ name: string }>).map((row) => row.name);
    assert.deepEqual(columns, ['id', 'owner_user_id', 'kind', 'planned_at'], 'no title, no text');
  });

  test('shadow rows older than 30 days go as new ones come', () => {
    recordCheckinShadowStart('wake', localAt(1, 9, 0) - 40 * 24 * HOUR);
    recordCheckinShadowStart('wake', localAt(5, 9, 0));
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM companion_checkin_shadow').get() as { n: number }).n, 1);
  });
});

// ── P6b: the lane runs the check-ins ────────────────────────────────────────

/** A runner whose turns run until released, or until a preempt ends them (after `preemptLagMs`). */
class HeldRunner implements CompanionTurnRunner {
  readonly requests: CompanionTurnRequest[] = [];
  preempts = 0;
  hold = false;
  preemptLagMs = 0;
  private readonly held: Array<(outcome: CompanionTurnOutcome) => void> = [];
  isIdle(): boolean {
    return true;
  }
  run(request: CompanionTurnRequest): Promise<CompanionTurnOutcome> {
    this.requests.push(request);
    if (!this.hold) return Promise.resolve({ outcome: 'spoke', messageText: 'Noted.' });
    return new Promise((resolve) => this.held.push(resolve));
  }
  release(outcome: CompanionTurnOutcome): void {
    this.held.shift()?.(outcome);
  }
  async preempt(): Promise<void> {
    this.preempts += 1;
    if (this.preemptLagMs > 0) await new Promise((resolve) => setTimeout(resolve, this.preemptLagMs));
    this.release({ outcome: 'preempted', detail: 'The user started typing' });
  }
}

describe('the lane runs the check-ins (P6b, companion:engine = scheduler)', () => {
  let keepAlive: ReturnType<typeof setInterval>;
  before(() => { keepAlive = setInterval(() => {}, 2 ** 30); });
  after(() => clearInterval(keepAlive));

  let now: number;
  let seq: number;
  let cr: FakeSource;
  let runner: HeldRunner;
  let repo: ScheduledJobsRepository;
  let scheduler: ScheduledJobScheduler;
  let coordinator: CompanionCoordinator;
  let started: Array<{ stop(): Promise<void> }>;

  /** A scheduler and a coordinator on one clock, wired as boot.ts and server.ts wire them. */
  function engines(options: { cleanUpCheckins?: CompanionCoordinatorDeps['cleanUpCheckins'] } = {}): void {
    let lane: ReturnType<typeof createCheckinLane> | null = null;
    scheduler = new ScheduledJobScheduler({
      repository: repo, executor: new HeldExecutor(), events: new ScheduledJobEventBus(), clock: () => now, instanceId: `backend-${started.length}`,
      workspaceExists: (id) => id !== 'assistant', maintenanceWorkspaceExists: (id) => id === 'assistant', runtimeExists: () => true,
      // An hour: these tests tick minutes apart, where the real scheduler renews its lease every 30 s.
      leaseTtlMs: HOUR, pollIntervalMs: 60_000, cancelGraceMs: 5, maxConcurrentRuns: 2, createId: () => `job-${++seq}`,
      checkinLane: {
        tick: (made, at) => lane?.tick(made, at),
        run: (input) => lane!.run(input),
      },
    });
    coordinator = startCompanion({
      clock: { now: () => now }, sources: [cr], michiSource: null, auth: null, autoTick: false, events: new CompanionEventBus(),
      turnRunner: () => runner, isPaneVisible: () => false, nodeViewedAt: () => null, conversationNodeId: () => null,
      isLeaseHolder: () => scheduler.status().active,
      ...(options.cleanUpCheckins ? { cleanUpCheckins: options.cleanUpCheckins } : {}),
    });
    lane = createCheckinLane(coordinator, { workspaceId: () => 'assistant' });
    started.push(scheduler, coordinator);
  }

  /** A scheduler tick at `time`, the user around; everything it started settles. */
  async function schedulerTick(time: number, presence: CompanionPresenceInput | null = HERE): Promise<void> {
    now = time;
    if (presence) await coordinator.service.onPresence(presence);
    await scheduler.tick();
    await coordinator.idle();
    await flush();
  }

  const identity = () => checkinIdentityJobId('local-user')!;
  const laneRuns = () => (getDb().prepare('SELECT status, summary, error FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at, rowid').all(identity()) as Array<Record<string, unknown>>)
    .map((row) => ({ ...row }));
  const companionRuns = () => (getDb().prepare("SELECT kind, outcome FROM companion_runs WHERE kind != 'poll' ORDER BY started_at, rowid").all() as Array<Record<string, unknown>>)
    .map((row) => [row.kind, row.outcome]);
  const claims = () => (getDb().prepare('SELECT COUNT(*) AS n FROM scheduler_execution_claims').get() as { n: number }).n;
  const job = () => repo.getJob(identity())!.record;

  beforeEach(() => {
    openDb();
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('assistant', 'Michi', 1, 1)").run();
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('companion:engine', 'scheduler')").run();
    now = localAt(5, 12, 0);
    seq = 0;
    cr = new FakeSource('cr');
    runner = new HeldRunner();
    repo = new ScheduledJobsRepository();
    started = [];
    markCompanionWelcomeDone(localAt(4, 8, 0));
    for (const key of ['companion:wake_cursor', 'companion:brief_cursor'] as const) setCompanionMetaNumber(key, latestEventSeq());
    // Wakes only: the brief has its own test above, and its default time is long past at noon.
    patchCompanionSettings({ brief: { enabled: false } });
    // The hourly heartbeat: its last at noon, so due at 13:00, after the wake tests below (its own test is last).
    setCompanionMetaNumber('companion:last_heartbeat_at', now);
  });

  afterEach(async () => {
    runner.hold = false;
    for (let i = 0; i < 4; i += 1) runner.release({ outcome: 'quiet' });
    for (const made of started.reverse()) await made.stop();
    await flush();
    dropDb();
  });

  /**
   * An interrupting item, polled by the scheduler's tick at `at`. The lane
   * looks before that poll lands (it never waits on it), so the wake's minute
   * of batching starts at the next tick: the wake is due at the returned time.
   */
  async function wakeDue(key: string, at: number): Promise<number> {
    cr.objects.set(key, { version: 'v1' });
    await schedulerTick(at);
    await schedulerTick(at + 30 * SECOND);
    await schedulerTick(at + 60 * SECOND);
    return at + 90 * SECOND;
  }

  test('the coordinator\'s own tick starts no check-in; the scheduler\'s tick polls, and its identity\'s run starts and ends the wake', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    assert.ok(identity(), 'the identity is made on the first tick');
    cr.objects.set('cr:N', { version: 'v1' });
    for (const at of [localAt(5, 12, 5), localAt(5, 12, 6), localAt(5, 12, 7)]) {
      now = at;
      await coordinator.service.onPresence(HERE);
      await coordinator.tick();
      await coordinator.idle();
    }
    assert.ok(getDb().prepare("SELECT 1 FROM companion_items WHERE item_key = 'cr:N'").get(), 'the coordinator\'s tick polled');
    assert.equal(runner.requests.length, 0, 'but started nothing: on the coordinator\'s engine the wake would have started at 12:06');

    await schedulerTick(localAt(5, 12, 7, 30));
    assert.equal(runner.requests.length, 0, 'the lane\'s minute of batching starts at its first look');
    await schedulerTick(localAt(5, 12, 8, 30));
    assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['wake', 'now-items']]);
    assert.deepEqual(laneRuns(), [{ status: 'succeeded', summary: 'wake: spoke', error: null }], 'kind and outcome, never the text');
    assert.deepEqual(companionRuns(), [['wake', 'spoke']]);
    assert.equal(claims(), 0, 'its claim went with it');

    cr.objects.set('cr:M', { version: 'v1' });
    await schedulerTick(localAt(5, 12, 10));
    assert.ok(getDb().prepare("SELECT 1 FROM companion_items WHERE item_key = 'cr:M'").get(), 'the scheduler\'s tick ran the deterministic step: it polled');
    await schedulerTick(localAt(5, 12, 11));
    assert.equal(laneRuns().length, 1, 'ten minutes between wakes: no work, no run');
  });

  test('the scheduler\'s tick starts polls and never waits on them', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => { release = resolve; });
    const poll = cr.poll.bind(cr);
    cr.poll = async (ctx) => { await hanging; return poll(ctx); };
    now = localAt(5, 12, 6);
    await scheduler.tick();
    assert.ok(true, 'the tick resolved while the poll hangs');
    release();
    await coordinator.idle();
  });

  test('typing in V preempts the lane\'s check-in through cancelActiveRun: a cancelled run, no failure, the wake back two minutes later', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    runner.hold = true;
    now = await wakeDue('cr:N', localAt(5, 12, 5));
    await scheduler.tick();
    await flush();
    assert.deepEqual(runner.requests.map((request) => request.kind), ['wake'], 'it runs, held');
    assert.equal(claims(), 1);

    const cancelActiveRun = scheduler.cancelActiveRun.bind(scheduler);
    const cancelled: string[] = [];
    scheduler.cancelActiveRun = (jobId) => { cancelled.push(jobId); return cancelActiveRun(jobId); };
    await coordinator.service.onPresence({ ...HERE, composing: true });
    assert.deepEqual(cancelled, [identity()], 'through the scheduler');
    await coordinator.idle();
    await flush();
    assert.equal(runner.preempts, 1);
    assert.deepEqual(laneRuns(), [{ status: 'cancelled', summary: 'wake: preempted', error: null }], 'no error: the user went first');
    assert.deepEqual(companionRuns(), [['wake', 'preempted']]);
    assert.deepEqual([job().consecutiveFailures, job().autoPaused], [0, false], 'not a failure');
    assert.equal(claims(), 0);

    runner.hold = false;
    await schedulerTick(localAt(5, 12, 7, 30));
    assert.equal(runner.requests.length, 1, 'the preempted wake waits two minutes');
    await schedulerTick(localAt(5, 12, 8, 30));
    assert.deepEqual(companionRuns(), [['wake', 'preempted'], ['wake', 'spoke']]);
  });

  test('the identity\'s time limit stops a check-in as timed out, and failures never pause the lane', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    getDb().prepare('UPDATE scheduled_jobs SET timeout_seconds = 1, consecutive_failures = ? WHERE id = ?').run(10, identity());
    runner.hold = true;
    runner.preemptLagMs = 20;
    now = await wakeDue('cr:N', localAt(5, 12, 5));
    await scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await coordinator.idle();
    await flush();
    assert.equal(runner.preempts, 1, 'the limit preempted the turn');
    assert.deepEqual(laneRuns().map((run) => [run.status, run.error]), [['timed_out', 'Timed out after 0 min']]);
    assert.equal(job().autoPaused, false, 'past the threshold, and still not paused');
    assert.equal(claims(), 0);
    assert.equal(CHECKIN_IDENTITY.timeoutSeconds, 240, 'the identity\'s own limit');
  });

  test('a lost lease stops the check-in; the coordinator stops starting them', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    runner.hold = true;
    now = await wakeDue('cr:N', localAt(5, 12, 5));
    await scheduler.tick();
    await flush();
    assert.equal(runner.requests.length, 1);
    getDb().prepare("UPDATE scheduler_lease SET holder = 'elsewhere', expires_at = ? WHERE id = 1").run(now + HOUR);
    await scheduler.tick();
    await coordinator.idle();
    await flush();
    assert.equal(runner.preempts, 1);
    assert.deepEqual(companionRuns(), [['wake', 'preempted']]);
    assert.equal(laneRuns()[0]!.status, 'interrupted');
    assert.equal(coordinator.laneHasWork(now), false, 'not without the lease');
  });

  test('after a restart: S is cleaned up first, then the check-in claim the stopped Michi left is released at once', async () => {
    // What a stopped backend left: its identity, a check-in run with its claim, and the Companion's run of it.
    engines();
    scheduler.start();
    await schedulerTick(now);
    const jobId = identity();
    await scheduler.stop();
    await coordinator.stop();
    getDb().prepare(`INSERT INTO scheduled_job_runs (id, job_id, workspace_id, trigger, status, started_at, claimed_by)
      VALUES ('run-old', ?, 'assistant', 'scheduled', 'running', ?, 'old-backend')`).run(jobId, now);
    getDb().prepare(`INSERT INTO scheduler_execution_claims (run_id, job_id, holder, generation, process_id, acquired_at, workspace_id, process_exit_safe)
      VALUES ('run-old', ?, 'old-backend', 1, NULL, ?, 'assistant', 0)`).run(jobId, now);
    getDb().prepare("UPDATE scheduler_lease SET expires_at = ? WHERE id = 1").run(now - 1);

    let cleaned!: () => void;
    const cleanup = new Promise<void>((resolve) => { cleaned = resolve; });
    engines({ cleanUpCheckins: async () => { await cleanup; return { settled: [], purged: 0, discarded: 0, pending: 0, kept: 0 }; } });
    scheduler.start();
    now = localAt(5, 12, 1);
    await coordinator.service.onPresence(HERE);
    try {
      await scheduler.tick();
      await flush();
      await scheduler.tick();
      await flush();
      assert.equal(claims(), 1, 'held while the check-ins it left are still being cleaned up');
      assert.equal(coordinator.laneSettled(), false);
      assert.deepEqual(scheduler.status().blockedExecutions, [], 'never on the Scheduled page: nothing there for the user to confirm');
    } finally {
      cleaned();
    }
    await coordinator.idle();
    await schedulerTick(localAt(5, 12, 2));
    assert.equal(claims(), 0, 'released at once, not after its time limit and ten minutes');
    const old = getDb().prepare("SELECT status FROM scheduled_job_runs WHERE id = 'run-old'").get() as { status: string };
    assert.equal(old.status, 'interrupted');

    // This backend first polled at 12:01; its next poll is due five minutes later.
    await schedulerTick(await wakeDue('cr:N', localAt(5, 12, 6)));
    assert.deepEqual(runner.requests.map((request) => request.kind), ['wake'], 'the next check-in starts');
  });

  test('switched back to the coordinator: its own tick starts the check-in, the lane starts none', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    getDb().prepare("UPDATE meta SET value = 'coordinator' WHERE key = 'companion:engine'").run();
    cr.objects.set('cr:N', { version: 'v1' });
    for (const at of [localAt(5, 12, 5), localAt(5, 12, 5, 30), localAt(5, 12, 6)]) {
      await schedulerTick(at);
      assert.equal(runner.requests.length, 0, 'the scheduler\'s tick only shadows now; it does not poll');
      await coordinator.tick();
      await coordinator.idle();
    }
    assert.deepEqual(runner.requests.map((request) => request.kind), ['wake'], 'the coordinator\'s tick polled and started it');
    assert.deepEqual(laneRuns(), [], 'no run of the identity');
  });

  test('the work heartbeat runs through the lane too: an hour after the last, quiet when nothing_to_do', async () => {
    engines();
    scheduler.start();
    await schedulerTick(now);
    await schedulerTick(localAt(5, 12, 59, 30));
    assert.equal(runner.requests.length, 0, 'not before its hour');
    runner.hold = true;
    now = localAt(5, 13, 0);
    await coordinator.service.onPresence(HERE);
    await scheduler.tick();
    await flush();
    assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['heartbeat', 'schedule']]);
    runner.release({ outcome: 'quiet' });
    await coordinator.idle();
    await flush();
    assert.deepEqual(laneRuns(), [{ status: 'succeeded', summary: 'heartbeat: quiet', error: null }]);
    assert.equal(getCompanionMetaNumber('companion:last_heartbeat_at'), localAt(5, 13, 0));
  });

  test('the scheduler\'s record of each outcome', () => {
    assert.deepEqual(laneOutcome({ kind: null, outcome: null, detail: null }), { status: 'succeeded', summary: 'Nothing to check in about', error: null });
    assert.deepEqual(laneOutcome({ kind: 'brief', outcome: 'quiet', detail: null }), { status: 'succeeded', summary: 'brief: quiet', error: null });
    assert.deepEqual(laneOutcome({ kind: 'wake', outcome: 'superseded', detail: null }), { status: 'cancelled', summary: 'wake: superseded', error: null });
    assert.deepEqual(laneOutcome({ kind: 'worker_report', outcome: 'error', detail: 'timed out' }), { status: 'failed', summary: 'worker_report: error', error: 'timed out' });
  });
});
