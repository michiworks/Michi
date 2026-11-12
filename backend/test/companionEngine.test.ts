import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The Companion's engine (coordinator.ts, DESIGN §6 with R2.3-R2.5, R2.9,
 * R2.10, R2.14), its deterministic half: polling cadence (a run row per
 * outside poll, of the quiet scheduled ones only each source's latest; one
 * MCP server's sources in turn, different servers at once; the intervals each
 * source asks for), backoff and the system_source_error item, the Auth gate
 * with the system_auth item, the baseline poll, the two-poll resolution and
 * reopening, item notices out of the gate (a calendar conflict once, two
 * hours ahead), Check now (also while paused), the scheduler lease, the daily
 * retention pass (tool outputs in the Companion's conversations too) and its
 * run log cap, runs a restart left behind (and ones whose chat turn never
 * ends), conversation.start cards it left starting, reminders and watches
 * (one due in quiet hours notifies once they end), the live status and the
 * "Since you left" the service hands the snapshot.
 * Model turns: companionEngineTurns.test.ts. Fake sources, Auth and clock;
 * no timers (autoTick false); temp MICHI_DATA_DIR per test.
 */

import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkinNodeId, type CompanionBucket, type CompanionItemSubtype, type CompanionNotice, type CompanionSeverity, type CompanionSourceKind } from 'michi-shared';
import { assistantPurposeKey } from '../src/assistant/identity';
import { closeDb, getDb, initDb } from '../src/services/db';
import { COMPANION_ABANDONED_START_ERROR } from '../src/services/companion/cards';
import { COMPANION_RUN_LOG_CAP, runDailyCleanup } from '../src/services/companion/cleanup';
import { startCompanion, type CompanionCoordinator, type CompanionCoordinatorDeps } from '../src/services/companion/coordinator';
import { CompanionEventBus } from '../src/services/companion/delivery';
import { CompanionError } from '../src/services/companion/errors';
import {
  COMPANION_OWNER,
  COMPANION_PURGED_TOOL_OUTPUT,
  createReminder,
  decideCard,
  defaultCompanionStatus,
  getCard,
  getCompanionMetaNumber,
  getItem,
  getItemByKey,
  getReminder,
  getRun,
  insertCard,
  insertNotice,
  latestEventSeq,
  listItemEvents,
  listRuns,
  listUnreportedCards,
  markCompanionWelcomeDone,
  pendingNotices,
  recordCompanionView,
  recordRun,
  setCompanionMetaNumber,
  setRunCheckinNode,
  startRun,
  upsertItem,
} from '../src/services/companion/repository';
import { getCompanionSettings, patchCompanionSettings } from '../src/services/companion/settings';
import { AUTH_EXPIRED_DETAIL } from '../src/services/companion/sources/common';
import type { CompanionAuthStatus } from '../src/services/companion/sources/auth';
import type { CompanionPollContext, CompanionSource, CompanionDraftInput, ItemDraft, SourcePollResult } from '../src/services/companion/types';
import { seedConversation } from './helpers/homeConversations';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Thursday 2026-11-05, 12:00 local: a workday outside the default quiet hours, after the brief's time. */
const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const localAt = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

const SUBTYPE: Record<string, CompanionItemSubtype> = {
  cr: 'cr_needs_attention', pipeline: 'pipeline_blocked', email: 'email_unread', calendar: 'calendar_conflict', michi: 'michi_waiting',
};

interface FakeObject { version: string; subtype?: CompanionItemSubtype; bucket?: CompanionBucket; severity?: CompanionSeverity; title?: string }

/** A source that observes what the test puts in `objects` (plus its list object) and drafts one item each. */
class FakeSource implements CompanionSource {
  readonly polls: number[] = [];
  readonly objects = new Map<string, FakeObject>();
  fail: string | null = null;
  complete = true;
  hang: Promise<void> | null = null;

  constructor(readonly kind: CompanionSourceKind, private readonly interval: number) {}

  intervalMs(): number {
    return this.interval;
  }

  async poll(ctx: CompanionPollContext): Promise<SourcePollResult> {
    this.polls.push(ctx.now);
    if (this.hang) await this.hang;
    if (this.fail) return { source: this.kind, ok: false, complete: false, observations: [], error: this.fail, detail: `failed: ${this.fail}` };
    const observations = [...this.objects].map(([objectKey, object]) => ({
      source: this.kind, objectKey, fingerprint: object.version, state: { ...object }, observedAt: ctx.now,
    }));
    observations.push({ source: this.kind, objectKey: `${this.kind}:*list`, fingerprint: String(this.objects.size), state: { kind: 'list' } as never, observedAt: ctx.now });
    return { source: this.kind, ok: true, complete: this.complete, observations, detail: `${this.objects.size} seen` };
  }

  draft(input: CompanionDraftInput): ItemDraft[] {
    return input.observations.filter((observation) => observation.state.kind !== 'list').map((observation) => {
      const object = observation.state as unknown as FakeObject;
      return {
        source: this.kind, subtype: object.subtype ?? SUBTYPE[this.kind]!, itemKey: observation.objectKey, version: object.version,
        bucket: object.bucket ?? 'needs_you', severity: object.severity ?? 'now', title: object.title ?? `${observation.objectKey} changed`,
        summary: null, target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' }, facts: {}, observedAt: input.now,
      };
    });
  }
}

class FakeAuth {
  checks = 0;
  status: CompanionAuthStatus = { valid: true, expiresAt: T0 + DAY, checkedAt: T0 };
  async check(): Promise<CompanionAuthStatus> {
    this.checks += 1;
    return { ...this.status };
  }
  last(): CompanionAuthStatus {
    return { ...this.status };
  }
}

const runsOf = (trigger: string) => listRuns(500).filter((run) => run.kind === 'poll' && run.trigger === trigger).reverse();

/** The Companion's conversation as assistant/store keeps it (in the assistant's workspace, its purpose recorded in meta); returns its node id. */
function companionConversation(nodeId = 'n-companion'): string {
  getDb().prepare(`INSERT OR IGNORE INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at)
    VALUES ('ws-companion','Michi assistant',NULL,'{"system":"assistant"}',1,1)`).run();
  seedConversation({ nodeId, workspaceId: 'ws-companion', title: 'Companion' });
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(nodeId), 'companion');
  return nodeId;
}

let messageSeq = 100;
/** An assistant message of that conversation, as chatHub stores a hidden turn's. */
function companionMessage(nodeId: string, id: string, content: string, at: number, toolCalls: unknown[] | null = null): void {
  getDb().prepare("INSERT INTO messages(id,node_id,role,content,tool_calls,seq,created_at) VALUES (?,?,'assistant',?,?,?,?)")
    .run(id, nodeId, content, toolCalls ? JSON.stringify(toolCalls) : null, messageSeq++, at);
}

describe('Companion engine: polls, notices and the lease', () => {
  // The coordinator's timers are unref'd in production; a ref'd interval keeps
  // node:test from seeing the event loop drain while a test awaits them.
  let keepAlive: ReturnType<typeof setInterval>;
  before(() => { keepAlive = setInterval(() => {}, 2 ** 30); });
  after(() => clearInterval(keepAlive));
  let tmpDir: string;
  let now: number;
  let cr: FakeSource;
  let pipeline: FakeSource;
  let auth: FakeAuth;
  let notices: CompanionNotice[];
  let bus: CompanionEventBus;
  let started: CompanionCoordinator[];
  let coordinator: CompanionCoordinator;

  function engine(deps: Partial<CompanionCoordinatorDeps> = {}): CompanionCoordinator {
    const made = startCompanion({
      clock: { now: () => now }, sources: [cr, pipeline], michiSource: null, auth, turnRunner: null, autoTick: false, events: bus,
      isPaneVisible: () => false, nodeViewedAt: () => null, conversationNodeId: () => null, ...deps,
    });
    started.push(made);
    return made;
  }

  async function at(time: number, target = coordinator): Promise<void> {
    now = time;
    await target.tick();
    await target.idle();
  }

  /** The welcome as the coordinator records it: cursors from here on. */
  function welcomed(when: number): void {
    markCompanionWelcomeDone(when);
    for (const key of ['companion:wake_cursor', 'companion:heartbeat_cursor', 'companion:brief_cursor'] as const) setCompanionMetaNumber(key, latestEventSeq());
    setCompanionMetaNumber('companion:last_heartbeat_at', when);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-engine-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    now = T0;
    cr = new FakeSource('cr', 5 * MINUTE);
    pipeline = new FakeSource('pipeline', 10 * MINUTE);
    auth = new FakeAuth();
    notices = [];
    bus = new CompanionEventBus();
    bus.subscribe({ notifier: true, notice: (notice) => notices.push(notice) });
    started = [];
    coordinator = engine();
  });

  afterEach(async () => {
    for (const made of started) await made.stop();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('each source polls at its own interval, a run row per outside poll (of the quiet ones only the latest)', async () => {
    await at(T0);
    await at(T0 + 4 * MINUTE);
    await at(T0 + 5 * MINUTE);
    await at(T0 + 10 * MINUTE);
    assert.deepEqual(cr.polls, [T0, T0 + 5 * MINUTE, T0 + 10 * MINUTE]);
    assert.deepEqual(pipeline.polls, [T0, T0 + 10 * MINUTE]);
    assert.deepEqual(runsOf('cr').map((run) => [run.outcome, run.startedAt]), [['ok', T0], ['ok', T0 + 10 * MINUTE]], 'the baseline, and the latest look that changed nothing');
    assert.match(runsOf('cr')[0]!.detail ?? '', /first poll/);
    const status = coordinator.service.status!();
    const crStatus = status.sources.find((source) => source.kind === 'cr')!;
    assert.deepEqual([crStatus.state, crStatus.lastPolledAt, crStatus.nextPollAt], ['ok', T0 + 10 * MINUTE, T0 + 15 * MINUTE]);
    assert.equal(status.sources.find((source) => source.kind === 'email')!.state, 'unavailable', 'no module for it in this engine');
    assert.equal(status.sources.find((source) => source.kind === 'michi')!.state, 'unavailable');
  });

  test('a failing source backs off (doubling, at most an hour), raises system_source_error after three, and recovers', async () => {
    await at(T0);
    cr.fail = 'timeout';
    const times = [T0 + 5, T0 + 14, T0 + 15, T0 + 34, T0 + 35, T0 + 74, T0 + 75, T0 + 134, T0 + 135].map((minutes) => T0 + (minutes - T0) * MINUTE);
    for (const time of times) await at(time);
    assert.deepEqual(cr.polls.map((time) => (time - T0) / MINUTE), [0, 5, 15, 35, 75, 135], '×2, ×4, ×8, then the one-hour cap');
    const trouble = getItemByKey('system:source:cr');
    assert.ok(trouble);
    assert.deepEqual([trouble.subtype, trouble.bucket, trouble.severity, trouble.status, trouble.title],
      ['system_source_error', 'fyi', 'silent', 'new', "Couldn't check your CRs"]);
    const status = coordinator.service.status!();
    assert.deepEqual([status.state, status.sources.find((source) => source.kind === 'cr')!.state], ['degraded', 'error']);
    assert.equal(status.sources.find((source) => source.kind === 'cr')!.detail, 'failed: timeout');

    cr.fail = null;
    await at(T0 + 195 * MINUTE);
    assert.equal(getItem(trouble.id)!.status, 'resolved');
    assert.equal(coordinator.service.status!().sources.find((source) => source.kind === 'cr')!.state, 'ok');
    await at(T0 + 200 * MINUTE);
    assert.equal(cr.polls.length, 8, 'back to its interval');
  });

  test('an expired Auth session skips the outside sources and raises system_auth until it is valid again', async () => {
    auth.status = { valid: false, expiresAt: T0 - HOUR, checkedAt: T0 };
    await at(T0);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [0, 0]);
    const item = getItemByKey('system:auth');
    assert.ok(item);
    assert.deepEqual([item.subtype, item.bucket, item.severity, item.version, item.status], ['system_auth', 'needs_you', 'now', `expired:${T0 - HOUR}`, 'new']);
    const status = coordinator.service.status!();
    assert.deepEqual([status.state, status.auth.valid, status.sources.find((source) => source.kind === 'cr')!.detail],
      ['degraded', false, AUTH_EXPIRED_DETAIL]);
    await at(T0 + 30_000);
    assert.equal(cr.polls.length, 0, 'it looks again a minute later');
    auth.status = { valid: true, expiresAt: T0 + 10 * HOUR, checkedAt: T0 + MINUTE };
    await at(T0 + MINUTE);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [1, 1]);
    assert.equal(getItem(item.id)!.status, 'resolved');

    // A poll that itself finds the session gone (the source's own Auth check) is no failure of the source.
    cr.fail = 'auth_expired';
    await at(T0 + 6 * MINUTE);
    assert.equal(getItemByKey('system:source:cr'), null);
    await at(T0 + 7 * MINUTE);
    assert.equal(cr.polls.length, 3, 'retried a minute later, no backoff');
  });

  test('the first poll is a baseline: no news, no notice; what comes after is news and gets one', async () => {
    welcomed(T0 - DAY);
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0);
    const baseline = getItemByKey('cr:A:mine')!;
    assert.equal(baseline.status, 'seen');
    assert.deepEqual(listItemEvents(baseline.id).map((event) => event.kind), ['baseline']);
    await at(T0 + 30_000);
    await at(T0 + MINUTE);
    assert.equal(notices.length, 0);

    cr.objects.set('cr:B:mine', { version: 'v1', title: 'CR-B needs attention' });
    await at(T0 + 5 * MINUTE);
    assert.equal(getItemByKey('cr:B:mine')!.status, 'new');
    assert.equal(notices.length, 0, 'batched for 30 seconds');
    await at(T0 + 5 * MINUTE + 30_000);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.body, 'CR-B needs attention');
  });

  test('two ok and complete polls without an object resolve it; one that comes back reopens as it was', async () => {
    cr.objects.set('cr:A:mine', { version: 'v1' });
    cr.objects.set('cr:B:mine', { version: 'v1' });
    await at(T0);
    const a = getItemByKey('cr:A:mine')!;
    cr.objects.delete('cr:A:mine');
    cr.complete = false;
    await at(T0 + 5 * MINUTE);
    await at(T0 + 10 * MINUTE);
    assert.equal(getItem(a.id)!.status, 'seen', 'incomplete polls count no absence');
    cr.complete = true;
    await at(T0 + 15 * MINUTE);
    assert.equal(getItem(a.id)!.status, 'seen', 'one absence');
    cr.fail = 'parse_error';
    await at(T0 + 20 * MINUTE);
    cr.fail = null;
    await at(T0 + 30 * MINUTE);
    assert.equal(getItem(a.id)!.status, 'resolved', 'the failed poll in between neither counts nor resets');
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 35 * MINUTE);
    assert.equal(getItem(a.id)!.status, 'seen', 'back as it was, no event');
    cr.objects.delete('cr:A:mine');
    await at(T0 + 40 * MINUTE);
    await at(T0 + 45 * MINUTE);
    cr.objects.set('cr:A:mine', { version: 'v2' });
    await at(T0 + 50 * MINUTE);
    assert.equal(getItem(a.id)!.status, 'new');
    assert.equal(listItemEvents(a.id)[0]!.kind, 'reopened');
  });

  test('Check now polls at once, even while paused; nothing else runs while paused', async () => {
    await at(T0);
    coordinator.service.checkNow(['cr']);
    await at(T0 + MINUTE);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [2, 1]);
    assert.match(runsOf('cr')[1]!.detail ?? '', /^Check now/);
    patchCompanionSettings({ paused: true });
    await at(T0 + 20 * MINUTE);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [2, 1], 'paused: no scheduled polls');
    welcomed(T0);
    cr.objects.set('cr:P:mine', { version: 'v1' });
    coordinator.service.checkNow();
    await at(T0 + 21 * MINUTE);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [3, 2]);
    assert.equal(coordinator.service.status!().state, 'paused');
    assert.equal(getItemByKey('cr:P:mine')!.status, 'new');
    await at(T0 + 22 * MINUTE);
    patchCompanionSettings({ paused: false });
    await at(T0 + 23 * MINUTE);
    await at(T0 + 24 * MINUTE);
    assert.equal(notices.length, 0, 'what came in while paused was held, and resuming sends nothing old');
    patchCompanionSettings({ enabled: false });
    await at(T0 + 60 * MINUTE);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [3, 2], 'off: nothing');
  });

  test('a process without the scheduler lease does nothing and refuses Check now (409 not_owner)', async () => {
    let leased = false;
    const other = engine({ isLeaseHolder: () => leased });
    await at(T0, other);
    assert.deepEqual([cr.polls.length, pipeline.polls.length], [0, 0]);
    assert.throws(() => other.service.checkNow(), (error: unknown) => error instanceof CompanionError && error.status === 409 && error.code === 'not_owner');
    assert.deepEqual(await other.service.requestWelcome(), { started: false });
    assert.equal(other.service.status!().sources.find((source) => source.kind === 'cr')!.detail, 'Another Michi process on this computer runs the Companion');
    leased = true;
    await at(T0 + MINUTE, other);
    assert.equal(cr.polls.length, 1);
  });

  test('a poll that never answers times out and counts as a failure', async () => {
    let release!: () => void;
    cr.hang = new Promise<void>((resolve) => { release = resolve; });
    const quick = engine({ pollTimeoutMs: 20 });
    await at(T0, quick);
    assert.equal(runsOf('cr').at(-1)!.outcome, 'error');
    assert.match(runsOf('cr').at(-1)!.detail ?? '', /took too long/);
    release();
  });

  test('stopping ends a poll that is still out at once and stores nothing from it', async () => {
    let release!: () => void;
    cr.hang = new Promise<void>((resolve) => { release = resolve; });
    cr.objects.set('cr:1', { version: 'v1' });
    const tick = coordinator.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cr.polls.length, 1, 'the poll is out');
    const stopAt = Date.now();
    await coordinator.stop();
    await tick;
    assert.ok(Date.now() - stopAt < 1_000, 'stop did not wait out the source');
    const run = runsOf('cr').at(-1)!;
    assert.deepEqual([run.outcome, run.detail], ['skipped', 'Michi stopped before the check finished']);
    assert.equal(pipeline.polls.length, 0, 'nothing polls after it');
    assert.equal(getItemByKey('cr:1'), null);
    release();
  });

  test('the daily retention pass runs once per local day, in the lease holder, even with the Companion off', async () => {
    patchCompanionSettings({ enabled: false });
    insertNotice({ title: 'C', body: 'old', target: { kind: 'companion', tab: 'chat' }, itemIds: [], now: T0 - 10 * DAY, expiresAt: T0 - 9 * DAY });
    const nodeId = companionConversation();
    companionMessage(nodeId, 'm-read', 'You have mail.', T0 - 8 * DAY, [{ id: 'c-1', title: 'companion_email_search', status: 'completed', output: 'Email from Alice — Re: salary' }]);
    await at(T0);
    assert.equal(getCompanionMetaNumber('companion:last_purge_at'), T0);
    const toolCalls = (getDb().prepare("SELECT tool_calls FROM messages WHERE id = 'm-read'").get() as { tool_calls: string }).tool_calls;
    assert.deepEqual(JSON.parse(toolCalls), [{ id: 'c-1', title: 'companion_email_search', status: 'completed', output: COMPANION_PURGED_TOOL_OUTPUT }],
      'what its tools read a week ago is gone from Michi\'s own copy too (B18)');
    await at(T0 + HOUR);
    assert.equal(getCompanionMetaNumber('companion:last_purge_at'), T0, 'once a day');
    await at(T0 + DAY);
    assert.equal(getCompanionMetaNumber('companion:last_purge_at'), T0 + DAY);
    assert.equal(pendingNotices(T0 + DAY).length, 0);
  });

  test('turns a previous process left running end as errors; one whose chat turn still runs is waited for', async () => {
    const dead = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - HOUR, turnId: 'cmp-dead' });
    const alive = startRun({ kind: 'wake', trigger: 'now-items', startedAt: T0 - MINUTE, turnId: 'cmp-alive' });
    const poll = startRun({ kind: 'poll', trigger: 'cr', startedAt: T0 - MINUTE });
    let running = true;
    const restarted = engine({ turnActive: (turnId) => running && turnId === 'cmp-alive' });
    await at(T0, restarted);
    assert.equal(getRun(dead.id)!.outcome, 'error');
    assert.equal(getRun(poll.id)!.outcome, 'error');
    assert.equal(getRun(alive.id)!.outcome, 'running');
    assert.equal(restarted.service.isBusy(), true, 'its turn still runs');
    running = false;
    await at(T0 + MINUTE, restarted);
    assert.equal(getRun(alive.id)!.outcome, 'error');
    assert.equal(restarted.service.isBusy(), false);
  });

  test('a turn whose chat turn never ends (its process died mid-turn) is given up once no turn could run so long (B10)', async () => {
    const stuck = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - MINUTE, turnId: 'cmp-stuck' });
    // The durable turn row stays active for good: the backend that ran it is gone, and only its own restart repairs it.
    const restarted = engine({ turnActive: () => true });
    await at(T0, restarted);
    assert.equal(getRun(stuck.id)!.outcome, 'running', 'as far as anyone can tell, its turn still runs');
    assert.deepEqual([restarted.service.isBusy(), restarted.service.status!().working], [true, true]);
    await at(T0 + 4 * MINUTE, restarted);
    assert.equal(getRun(stuck.id)!.outcome, 'running', 'a hidden turn may still run this long');
    await at(T0 + 6 * MINUTE, restarted);
    const run = getRun(stuck.id)!;
    assert.deepEqual([run.outcome, run.detail], ['error', 'Michi restarted while this turn ran; it never finished']);
    assert.deepEqual([restarted.service.isBusy(), restarted.service.status!().working], [false, false], 'the Companion is free again');
  });

  test('the run log cap never drops a check-in whose native record is still to be discarded (DESIGN-v2 §3.7)', async () => {
    const pending = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - 20 * DAY, outcome: 'preempted', finishedAt: T0 - 20 * DAY + 1 });
    setRunCheckinNode(pending.id, checkinNodeId(pending.id));
    const quiet = recordRun({ kind: 'wake', trigger: 'now-items', startedAt: T0 - 20 * DAY + 2, outcome: 'quiet', finishedAt: T0 - 20 * DAY + 3, messageId: 'm-quiet' });
    recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - 20 * DAY + 4, outcome: 'spoke', finishedAt: T0 - 20 * DAY + 5, messageId: 'm-spoke' });
    // About two weeks of outside polls, a row each: more than the cap.
    const insert = getDb().prepare(`INSERT INTO companion_runs (id, owner_user_id, kind, trigger, outcome, started_at, finished_at)
      VALUES (?, ?, 'poll', 'cr', 'ok', ?, ?)`);
    getDb().exec('BEGIN');
    for (let index = 0; index <= COMPANION_RUN_LOG_CAP; index++) insert.run(`cmr-poll-${index}`, COMPANION_OWNER, T0 - 14 * DAY + index * MINUTE, T0 - 14 * DAY + index * MINUTE + 1);
    getDb().exec('COMMIT');
    const cleaned = runDailyCleanup(T0);
    assert.ok(cleaned, 'the daily pass ran');
    assert.equal(cleaned.prunedRuns, 3, 'the cap is the repository\'s one rule (pruneRuns)');
    assert.equal(getRun(pending.id)?.checkinNodeId, checkinNodeId(pending.id), 'kept: boot cleanup still has to discard its record');
    assert.equal(getRun(quiet.id), null, 'a quiet run hides nothing any more, so it is cut like any other');
    const kept = getDb().prepare('SELECT COUNT(*) AS n FROM companion_runs WHERE id <> ?').get(pending.id) as { n: number };
    assert.equal(kept.n, COMPANION_RUN_LOG_CAP, 'the rest of the log is cut to the cap, oldest first');
    assert.equal(getDb().prepare("SELECT 1 FROM companion_runs WHERE message_id = 'm-spoke'").get(), undefined);
  });

  test('a reminder that comes due in quiet hours is notified once they end (B9)', async () => {
    welcomed(T0 - DAY);
    const night = createReminder({ text: 'Call home', at: localAt(5, 21, 0) }, T0);
    await at(localAt(5, 21, 0));
    await at(localAt(5, 21, 1));
    await at(localAt(6, 7, 59));
    const due = getItemByKey(`reminder:${night.id}`)!;
    assert.deepEqual([due.status, notices.length], ['new', 0], 'due, and quiet');
    await at(localAt(6, 8, 0));
    await at(localAt(6, 8, 1));
    assert.deepEqual(notices.map((notice) => [notice.body, notice.itemIds]), [[`Call home — ${due.summary}`, [due.id]]]);
  });

  test('reminders fire on time, daily ones once a workday after their time, watches when their item gets there', async () => {
    welcomed(T0 - DAY);
    const once = createReminder({ text: 'Check the deploy', at: T0 + HOUR }, T0);
    const daily = createReminder({ text: 'Stand-up notes', dailyAt: '10:00' }, T0);
    const crItem = upsertItem({
      source: 'cr', subtype: 'cr_needs_attention', itemKey: 'cr:W:mine', version: 'v1', bucket: 'needs_you', severity: 'now',
      title: 'CR-W needs attention', summary: null, target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-W' }, facts: {}, observedAt: T0,
    }, T0).item;
    const watch = createReminder({ text: 'Merge CR-W', itemId: crItem.id, until: 'approved' }, T0);

    await at(T0 + 30 * MINUTE);
    assert.equal(getItemByKey(`reminder:${once.id}`), null);
    assert.equal(getItemByKey(`reminder:${daily.id}`), null, 'made after today\'s 10:00: first fires tomorrow');
    await at(T0 + HOUR);
    const due = getItemByKey(`reminder:${once.id}`)!;
    assert.deepEqual([due.subtype, due.bucket, due.severity, due.title, due.status], ['reminder_due', 'needs_you', 'now', 'Check the deploy', 'new']);
    assert.equal(getReminder(once.id)!.status, 'fired');
    await at(T0 + HOUR + 30_000);
    assert.ok(notices.some((notice) => notice.itemIds.includes(due.id)), 'through the gate like any item');

    upsertItem({
      source: 'cr', subtype: 'cr_approved', itemKey: 'cr:W:mine', version: 'v2', bucket: 'update', severity: 'now',
      title: 'CR-W is approved', summary: null, target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-W' }, facts: {}, observedAt: T0 + 2 * HOUR,
    }, T0 + 2 * HOUR);
    await at(T0 + 2 * HOUR);
    const watched = getItemByKey(`reminder:${watch.id}`)!;
    assert.equal(watched.summary, 'Approved: CR-W is approved');
    assert.equal(getReminder(watch.id)!.status, 'fired');
    assert.deepEqual(watched.target, { kind: 'url', url: 'https://reviews.example.com/reviews/CR-W' });

    await at(localAt(6, 9, 59));
    assert.equal(getItemByKey(`reminder:${daily.id}`), null);
    await at(localAt(6, 10, 0));
    const standUp = getItemByKey(`reminder:${daily.id}`)!;
    assert.equal(standUp.version, 'daily:2026-11-06');
    assert.equal(getReminder(daily.id)!.status, 'active', 'a daily reminder stays');
    await at(localAt(6, 15, 0));
    assert.equal(getItemByKey(`reminder:${daily.id}`)!.version, 'daily:2026-11-06', 'once a day');
    await at(localAt(7, 10, 30));
    assert.equal(getItemByKey(`reminder:${daily.id}`)!.version, 'daily:2026-11-06', 'not on Saturday');
    await at(localAt(9, 10, 30));
    assert.equal(getItemByKey(`reminder:${daily.id}`)!.version, 'daily:2026-11-09');
  });

  test('the service hands the snapshot the latest "Since you left"', async () => {
    recordCompanionView(T0 - 2 * HOUR);
    const view = recordCompanionView(T0);
    assert.ok(view.catchUp);
    now = T0 + 5 * MINUTE;
    assert.deepEqual(coordinator.service.catchUp!(), view.catchUp);
    assert.equal(await coordinator.service.onPresence({ active: true, companionFocused: false, lastInputAt: null, composing: false }), undefined,
      'a beacon answers nothing: "Since you left" comes from the view');
  });

  test('sources on different MCP servers poll at the same time, those sharing one in turn; the tick (and Check now) waits for all (H#2)', async () => {
    const email = new FakeSource('email', 5 * MINUTE);
    const calendar = new FakeSource('calendar', 15 * MINUTE);
    const releases = new Map<FakeSource, () => void>();
    for (const source of [cr, pipeline, email, calendar]) source.hang = new Promise<void>((resolve) => { releases.set(source, resolve); });
    const parallel = engine({ sources: [cr, pipeline, email, calendar] });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
    const started = () => [cr, pipeline, email, calendar].map((source) => source.polls.length);
    let ticked = false;
    const tick = parallel.tick().then(() => { ticked = true; });
    await settle();
    assert.deepEqual(started(), [1, 0, 1, 0], 'CR (code source) and email (Outlook) at once; pipeline and calendar wait for their server');
    releases.get(email)!();
    await settle();
    assert.deepEqual(started(), [1, 0, 1, 1], 'calendar after email, while CR still runs');
    releases.get(cr)!();
    await settle();
    assert.deepEqual(started(), [1, 1, 1, 1]);
    assert.equal(ticked, false, 'the tick waits for every poll');
    releases.get(calendar)!();
    releases.get(pipeline)!();
    await tick;
    assert.deepEqual(['cr', 'pipeline', 'email', 'calendar'].map((kind) => runsOf(kind).length), [1, 1, 1, 1]);

    // Check now answers once its polls ran (companion_check_now): the next tick polls every forced source, then resolves.
    for (const source of [cr, pipeline, email, calendar]) source.hang = null;
    now = T0 + MINUTE;
    parallel.service.checkNow();
    await parallel.tick();
    assert.deepEqual(started(), [2, 2, 2, 2]);
    assert.ok(['cr', 'pipeline', 'email', 'calendar'].every((kind) => /^Check now/.test(runsOf(kind).at(-1)!.detail ?? '')));
  });

  test('of the scheduled looks that changed nothing only each source\'s latest keeps its row; failures, changes, baselines and Check now stay (H#5)', async () => {
    await at(T0);
    for (const minutes of [5, 10, 15]) await at(T0 + minutes * MINUTE);
    assert.deepEqual(runsOf('cr').map((run) => run.startedAt), [T0, T0 + 15 * MINUTE], 'the baseline and the latest quiet look');
    assert.deepEqual(runsOf('pipeline').map((run) => run.startedAt), [T0, T0 + 10 * MINUTE]);
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 20 * MINUTE);
    await at(T0 + 25 * MINUTE);
    cr.fail = 'timeout';
    await at(T0 + 30 * MINUTE);
    cr.fail = null;
    coordinator.service.checkNow(['cr']);
    await at(T0 + 31 * MINUTE);
    await at(T0 + 36 * MINUTE);
    assert.deepEqual(runsOf('cr').map((run) => [(run.startedAt - T0) / MINUTE, run.outcome]), [[0, 'ok'], [20, 'ok'], [30, 'error'], [31, 'ok'], [36, 'ok']],
      'the change, the failure and Check now stay; of the quiet looks only the latest');
    assert.match(runsOf('cr')[3]!.detail ?? '', /^Check now/);
    assert.deepEqual(runsOf('pipeline').map((run) => (run.startedAt - T0) / MINUTE), [0, 30]);
    assert.equal(coordinator.service.status!().lastCheckAt, T0 + 36 * MINUTE, 'the last check is still known');
    assert.equal(defaultCompanionStatus({ settings: getCompanionSettings(), now: T0 + 37 * MINUTE, working: false }).lastCheckAt, T0 + 36 * MINUTE,
      'so is it without a live engine');

    // A restart picks up where the last process left off: its latest quiet look goes when the next one comes.
    const restarted = engine();
    await at(T0 + 46 * MINUTE, restarted);
    assert.deepEqual(runsOf('cr').map((run) => (run.startedAt - T0) / MINUTE), [0, 20, 30, 31, 46]);
    assert.deepEqual(runsOf('pipeline').map((run) => (run.startedAt - T0) / MINUTE), [0, 46]);
  });

  test('the first tick ends a conversation.start card a stopped Michi left starting, so the Companion hears of it (B7)', async () => {
    const card = insertCard({ kind: 'conversation.start', payload: { workspaceId: 'ws', title: 'Fix the flaky test', text: 'Look at it' }, summary: 'Start a conversation', reason: null, now: T0 - HOUR });
    decideCard(card.id, 'applied', T0 - HOUR);
    // What cards.ts holds a starting card with: applied, out of [CARD RESULTS] until its conversation started or failed.
    getDb().prepare('UPDATE companion_cards SET reported_at = -1 WHERE id = ?').run(card.id);
    assert.deepEqual(listUnreportedCards(), []);
    const changes: string[] = [];
    bus.subscribe({ changed: (event) => changes.push(event.reason) });
    await at(T0);
    const settled = getCard(card.id)!;
    assert.deepEqual([settled.status, settled.error], ['failed', COMPANION_ABANDONED_START_ERROR]);
    assert.deepEqual(listUnreportedCards().map((unreported) => unreported.id), [card.id], 'its next turn is told it failed');
    assert.ok(changes.includes('cards'), 'the panel shows the failed card');
  });

});
