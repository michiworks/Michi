// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, CONVERSATION_UPDATES_LIMITS, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { updateAgentConfig } from '../src/services/agentConfig';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { ensureSpacesHomePageId } from '../src/services/pages/homePages';
import { maintenanceHasWork } from '../src/services/metaAgent/maintenanceCoordinator';
import {
  changedSummaryHomes, homeSummaryDue, homeSummaryPrompt, SUMMARY_QUIET_MS, SUMMARY_SPACING_MS, type HomeSummaryInput, type HomeSummaryWorkspace,
} from '../src/services/metaAgent/globalSummary';
import type { HomeState } from '../src/services/metaAgent/firstRunStore';
import { seedWatch } from './helpers/pagesWatches';
import { CONSOLIDATION_LIMITS } from '../src/services/memory/consolidationPolicy';
import { recordTypedText, releaseTypedText } from '../src/services/memory/typedText';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobScheduler, type ScheduledRunOutcome } from '../src/services/scheduledJobs/scheduler';
import { turnBackgroundWorkOn } from './helpers/backgroundWork';

// The 2026-11-09 cadence of the Meta agent's automatic work: the Spaces Home summary at most hourly
// and once the homes are quiet, rereading only changed homes; incremental Pages batches on memory
// consolidation's idle/backlog/age triggers, 30 minutes apart per owner unless a full batch waits.
// Manual starts never wait.

const OWNER = 'local-user';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.parse('2026-11-11T09:00:00Z');

describe('the Spaces Home summary cadence', () => {
  const state = (patch: Partial<HomeState> = {}): HomeState => ({
    ownerUserId: OWNER, requestedAt: T - 30 * HOUR, summaryFingerprint: 'before', summarizedAt: T,
    summaryFailedFingerprint: null, summaryFailures: 0, summaryFailedAt: null, cardsJson: null, cardsFingerprint: null,
    cardsRendered: null, haltedReason: null, haltedAt: null, updatedAt: T, ...patch,
  });
  const input = (patch: Partial<HomeSummaryInput> = {}): HomeSummaryInput => ({
    fingerprint: 'after', ready: true, workspaces: [], lastWriteAt: T + 5 * MINUTE, firstRunEndedAt: T - 24 * HOUR, manualRunAt: null, ...patch,
  });

  test('automatic: an hour after the last summary at the earliest, once the homes were quiet for ten minutes', () => {
    assert.equal(homeSummaryDue(state(), input(), T + SUMMARY_SPACING_MS - 1), false, 'within the hour');
    const write = T + SUMMARY_SPACING_MS - 5 * MINUTE;
    assert.equal(homeSummaryDue(state(), input({ lastWriteAt: write }), T + SUMMARY_SPACING_MS), false, 'a home was written five minutes ago');
    assert.equal(homeSummaryDue(state(), input({ lastWriteAt: write }), write + SUMMARY_QUIET_MS), true);
    assert.equal(homeSummaryDue(state(), input({ fingerprint: 'before' }), T + 2 * SUMMARY_SPACING_MS), false, 'nothing changed');
    assert.equal(homeSummaryDue(state(), input({ ready: false }), T + 2 * SUMMARY_SPACING_MS), false, 'first reads still running');
    assert.equal(homeSummaryDue(state({ haltedReason: 'check failed' }), input(), T + 2 * SUMMARY_SPACING_MS), false, 'stopped');
    // Homes written every few minutes hold it at most two hours past its hour, as the oldest waiting turn holds a batch.
    const ceiling = T + SUMMARY_SPACING_MS + CONSOLIDATION_LIMITS.oldestWaitingMs;
    assert.equal(homeSummaryDue(state(), input({ lastWriteAt: ceiling - MINUTE }), ceiling - 1), false);
    assert.equal(homeSummaryDue(state(), input({ lastWriteAt: ceiling - MINUTE }), ceiling), true, 'steady writes');
  });

  test('Run now and Retry skip the cadence; a failed summary retries on its own backoff', () => {
    assert.equal(homeSummaryDue(state(), input(), T + MINUTE, true), true, 'manual');
    const failed = state({ summaryFailedFingerprint: 'after', summaryFailures: 1, summaryFailedAt: T + MINUTE });
    assert.equal(homeSummaryDue(failed, input(), T + 3 * MINUTE, true), false, 'a manual start waits out the failure backoff as before');
    assert.equal(homeSummaryDue(failed, input(), T + 6 * MINUTE), true, 'the retry is not held for the hour');
    assert.equal(homeSummaryDue(failed, input({ fingerprint: 'newer' }), T + 6 * MINUTE), false, 'new input after a failure follows the cadence');
  });

  test('homes changed after a person started maintenance (Update, Run now) are summarised at once, until a summary is tried', () => {
    assert.equal(homeSummaryDue(state(), input({ manualRunAt: T + MINUTE }), T + 6 * MINUTE), true, 'the round\'s batch rewrote a home');
    assert.equal(homeSummaryDue(state(), input({ manualRunAt: T - MINUTE }), T + 6 * MINUTE), false, 'the last summary came after that start');
    const failed = state({ summaryFailedFingerprint: 'earlier', summaryFailures: 1, summaryFailedAt: T + 2 * MINUTE });
    assert.equal(homeSummaryDue(failed, input({ manualRunAt: T + MINUTE }), T + 6 * MINUTE), false, 'a summary after it failed: newer input follows the cadence');
  });

  test('a summary that takes in a first-time generation runs at once: the first run\'s wrap-up, a retried or new workspace', () => {
    assert.equal(homeSummaryDue(state({ summarizedAt: null, summaryFingerprint: null }), input({ lastWriteAt: T }), T), true, 'the first summary');
    assert.equal(homeSummaryDue(state(), input({ firstRunEndedAt: T + 2 * MINUTE, lastWriteAt: T + 2 * MINUTE }), T + 3 * MINUTE), true,
      'a first read that ended after the last summary');
    // The summary that took in that first read failed: what changes next waits like any other input, not for every change at once.
    const failed = state({ summarizedAt: null, summaryFingerprint: null, summaryFailedFingerprint: 'earlier', summaryFailures: 1, summaryFailedAt: T + 2 * MINUTE });
    assert.equal(homeSummaryDue(failed, input({ firstRunEndedAt: T + MINUTE, lastWriteAt: T + 3 * MINUTE }), T + 4 * MINUTE), false);
    assert.equal(homeSummaryDue(failed, input({ firstRunEndedAt: T + 3 * MINUTE, lastWriteAt: T + 3 * MINUTE }), T + 4 * MINUTE), true,
      'a first read that ended after the failure');
  });
});

let dir: string;
let previous: string | undefined;
let now: number;
let seq: number;
let calls: string[];
let finishers: Array<(outcome: ScheduledRunOutcome) => void>;
let scheduler: ScheduledJobScheduler;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  previous = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-cadence-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb(); initDb();
  // Michi (Pages upkeep with it) is off until the user turns it on.
  turnBackgroundWorkOn();
  now = T; seq = 0; calls = []; finishers = [];
  mock.method(Date, 'now', () => now);
  updateAgentConfig({ runtime: 'pi' });
  scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), events: new ScheduledJobEventBus(),
    workspaceExists: () => true, runtimeExists: () => true, clock: () => now, createId: () => `job-${++seq}`,
    pollIntervalMs: 600_000, maxConcurrentRuns: 4,
    executor: { start: async (job) => {
      calls.push(job.workspaceId);
      const nodeId = `exec-${++seq}`;
      getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?,?,'chat','idle',?)").run(nodeId, job.workspaceId, now);
      const done = new Promise<ScheduledRunOutcome>((resolve) => { finishers.push(resolve); });
      return { nodeId, treeId: null, turnId: null, done, cancel: () => finishers.at(-1)?.({ status: 'cancelled', summary: null, error: null }) };
    } },
  });
});

afterEach(async () => {
  for (const finish of finishers) finish({ status: 'cancelled', summary: null, error: null });
  await flush(); await scheduler.stop(); await flush();
  mock.restoreAll();
  closeDb();
  if (previous === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

function enroll(id: string): string {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, id.toUpperCase(), OWNER, ++seq, now);
  return new PageMaintenanceConfigService(scheduler, () => now).enable({ workspaceId: id, ownerUserId: OWNER }).job.id;
}

/** A conversation turn of the workspace that finishes now. */
function complete(workspaceId: string): void {
  const nodeId = `node-${++seq}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?,?,'chat','idle',?)").run(nodeId, workspaceId, now);
  const turn = createDurableTurn({ turnId: `turn-${seq}`, assistantId: `answer-${seq}`, nodeId, workspaceId, displayUserText: 'Ship it', startedAt: now });
  beginTurn(turn);
  const chunk = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'Shipped.' } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(chunk, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
}

/** A person types into a chat now; its turn keeps running until `stop` is called. */
function typing(): { stop: () => void } {
  const id = `typed-${++seq}`;
  recordTypedText(`node-${id}`, `turn-${id}`, 'Still working on it');
  return { stop: () => releaseTypedText(`node-${id}`, `turn-${id}`) };
}

function plan(workspaceId: string, jobId: string, createdAt: number, extra: { reconsiderOf?: string; scope?: string; state?: string } = {}): string {
  const id = `plan-${++seq}`;
  getDb().prepare(`INSERT INTO page_maintenance_plans(id,workspace_id,owner_user_id,job_id,run_id,config_revision,generation,scope_space_id,
    reconsider_of_plan_id,after_seq,through_seq,state,created_at,updated_at) VALUES(?,?,?,?,NULL,1,?,?,?,0,0,?,?,?)`)
    .run(id, workspaceId, OWNER, jobId, seq, extra.scope ?? null, extra.reconsiderOf ?? null, extra.state ?? 'terminal', createdAt, createdAt);
  return id;
}

describe('incremental Pages batches', () => {
  test('wait for an idle user, eight waiting turns or a turn two hours old; a manual start never waits', () => {
    enroll('a');
    complete('a');
    const chat = typing();
    assert.equal(maintenanceHasWork('a', OWNER, now, true), false, 'a turn the user typed into is running');
    assert.equal(maintenanceHasWork('a', OWNER, now), true, 'Run now');
    chat.stop();
    now += CONSOLIDATION_LIMITS.idleMs - 1;
    assert.equal(maintenanceHasWork('a', OWNER, now, true), false, 'idle for less than ten minutes');
    now += 1;
    assert.equal(maintenanceHasWork('a', OWNER, now, true), true, 'idle for ten minutes');

    const busy = typing();
    for (let i = 1; i < CONSOLIDATION_LIMITS.waitingTrigger; i += 1) complete('a');
    assert.equal(maintenanceHasWork('a', OWNER, now, true), true, 'eight turns wait');
    busy.stop();

    enroll('b');
    complete('b');
    now += CONSOLIDATION_LIMITS.oldestWaitingMs - 1;
    const later = typing();
    assert.equal(maintenanceHasWork('b', OWNER, now, true), false);
    now += 1;
    assert.equal(maintenanceHasWork('b', OWNER, now, true), true, 'the oldest turn waited two hours');
    later.stop();
  });

  test('two batches of an owner start at least thirty minutes apart, across workspaces; reconsider and catch-up plans do not count', () => {
    const a = enroll('a');
    enroll('b');
    complete('b');
    const first = plan('a', a, now);
    assert.equal(maintenanceHasWork('b', OWNER, now + CONSOLIDATION_LIMITS.spacingMs - 1, true), false, 'a batch of a started within the half hour');
    assert.equal(maintenanceHasWork('b', OWNER, now + CONSOLIDATION_LIMITS.spacingMs - 1), true, 'Run now');
    now += CONSOLIDATION_LIMITS.spacingMs;
    assert.equal(maintenanceHasWork('b', OWNER, now, true), true);
    plan('a', a, now, { reconsiderOf: first });
    plan('a', a, now, { scope: 'page-x' });
    assert.equal(maintenanceHasWork('b', OWNER, now, true), true, 'a reconsideration or a catch-up is no new batch');
  });

  test('a full batch does not wait for the spacing: waiting would not make it any larger', () => {
    const a = enroll('a');
    enroll('b');
    plan('a', a, now);
    for (let i = 1; i < CONVERSATION_UPDATES_LIMITS.defaultLimit; i += 1) complete('b');
    assert.equal(maintenanceHasWork('b', OWNER, now, true), false, 'a batch of a started just now');
    complete('b');
    assert.equal(maintenanceHasWork('b', OWNER, now, true), true, 'a whole batch waits');
  });

  test('never held: an unfinished plan or a due watch', () => {
    const a = enroll('a');
    enroll('b');
    complete('a');
    complete('b');
    plan('a', a, now, { state: 'routing' });
    const chat = typing();
    assert.equal(maintenanceHasWork('a', OWNER, now, true), true, 'an unfinished plan resumes');
    assert.equal(maintenanceHasWork('b', OWNER, now, true), false);
    seedWatch({ workspaceId: 'b', ownerUserId: OWNER, title: 'Tickets', instructions: 'Check open tickets', intervalMinutes: 30, now });
    assert.equal(maintenanceHasWork('b', OWNER, now, true), true, 'a due watch');
    chat.stop();
  });

  test('a Run now that found no free slot starts once one frees up, still manual, past the waits', async () => {
    const a = enroll('a');
    const b = enroll('b');
    enroll('c');
    complete('a'); complete('b'); complete('c');
    const chat = typing();
    scheduler.start();
    assert.ok('run' in scheduler.startNow(a));
    const refused = scheduler.startNow(b);
    assert.ok('refused' in refused && refused.refused === 'capacity', 'one maintenance execution at a time');
    finishers[0]!({ status: 'succeeded', summary: null, error: null });
    await flush(); now += 1_000; await scheduler.tick(); await flush();
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(scheduler.listRuns(b)[0]!.trigger, 'manual');
    finishers[1]!({ status: 'succeeded', summary: null, error: null });
    await flush(); now += 61_000; await scheduler.tick(); await flush();
    // These runs decided no source, so a's plan is unfinished: resuming it waits for nothing. c, which
    // nobody started, waits: the user is active and a batch just started.
    assert.deepEqual(calls, ['a', 'b', 'a']);
    assert.equal(scheduler.listRuns(a)[0]!.trigger, 'scheduled');
    chat.stop();
  });
});

describe('rereading only changed homes', () => {
  const home = (workspaceId: string, fingerprint: string): HomeSummaryWorkspace => ({
    workspaceId, workspaceName: `Workspace ${workspaceId}`, homePageId: null, state: 'done', error: null, fingerprint,
  });
  const summaryInput = (fingerprint: string, workspaces: HomeSummaryWorkspace[]): HomeSummaryInput => ({
    fingerprint, ready: true, workspaces, lastWriteAt: null, firstRunEndedAt: null, manualRunAt: null,
  });
  const homeState = (summaryFingerprint: string | null): HomeState => ({
    ownerUserId: OWNER, requestedAt: T, summaryFingerprint, summarizedAt: summaryFingerprint ? T : null, summaryFailedFingerprint: null,
    summaryFailures: 0, summaryFailedAt: null, cardsJson: null, cardsFingerprint: null, cardsRendered: null, haltedReason: null, haltedAt: null, updatedAt: T,
  });

  test('a summary reads the homes whose fingerprint changed since the last successful one; without its record, or with a home gone, every home', () => {
    const one = summaryInput('F1', [home('ws-a', 'a1'), home('ws-b', 'b1')]);
    assert.equal(changedSummaryHomes(OWNER, homeState(null), one), null, 'no summary yet');
    const two = summaryInput('F2', [home('ws-a', 'a2'), home('ws-b', 'b1'), home('ws-c', 'c1')]);
    assert.deepEqual([...changedSummaryHomes(OWNER, homeState('F1'), two)!], ['ws-a', 'ws-c'], 'a changed home and a new one');
    // A failed F2 leaves F1 the last successful summary: a later plan still compares with it.
    const three = summaryInput('F3', [home('ws-a', 'a2'), home('ws-b', 'b2'), home('ws-c', 'c1')]);
    assert.deepEqual([...changedSummaryHomes(OWNER, homeState('F1'), three)!], ['ws-a', 'ws-b', 'ws-c']);
    assert.deepEqual([...changedSummaryHomes(OWNER, homeState('F3'), summaryInput('F4', [home('ws-a', 'a3'), home('ws-b', 'b2'), home('ws-c', 'c1')]))!], ['ws-a']);
    assert.equal(changedSummaryHomes(OWNER, homeState('F4'), summaryInput('F5', [home('ws-a', 'a3'), home('ws-b', 'b2')])), null,
      'ws-c was archived, deleted or hidden: no remaining home changed, but the Spaces Home still describes it');
    assert.equal(changedSummaryHomes(OWNER, homeState('F2'), summaryInput('F6', [home('ws-a', 'a3')])), null, 'F2 never succeeded and is gone');

    const spacesHomePageId = ensureSpacesHomePageId(OWNER, now);
    const prompt = homeSummaryPrompt({ runId: 'run-1', spacesHomePageId, ownerUserId: OWNER, workspaces: two.workspaces, changed: new Set(['ws-a']) });
    assert.match(prompt, /^- Workspace ws-a \(ws-a\) \(changed\)$/m);
    assert.match(prompt, /^- Workspace ws-b \(ws-b\)$/m);
    assert.match(prompt, /^1\. Read the workspace homes marked \(changed\) .*keep what the Spaces Home says about them/m);
    const failed = homeSummaryPrompt({ runId: 'run-1', spacesHomePageId, ownerUserId: OWNER, changed: new Set(['ws-a']),
      workspaces: [{ ...home('ws-a', 'a2'), state: 'failed', error: 'Quota exhausted' }] });
    assert.match(failed, /^- Workspace ws-a \(ws-a\) \(changed\): first-time generation failed: Quota exhausted$/m);
    assert.match(homeSummaryPrompt({ runId: 'run-1', spacesHomePageId, ownerUserId: OWNER, workspaces: two.workspaces }),
      /^1\. Read every workspace home with maintenance_read_workspace_home/m);

    // The chat Home's greeting and cards are no longer the summary's (D13).
    assert.doesNotMatch(homeSummaryPrompt({ runId: 'run-1', spacesHomePageId, ownerUserId: OWNER, workspaces: two.workspaces }), /greeting|cards/);
  });
});
