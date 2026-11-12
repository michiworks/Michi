import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The Companion's engine, its model turns (coordinator.ts, DESIGN §6 with
 * R2.3, R2.6-R2.9): nothing before the first welcome, and the welcome looks
 * first (at most its wait, longer for a source on its first look; not again
 * at a source just checked) and then is the first turn; a composing beacon
 * never stops the welcome, and one that did not speak is asked for again on
 * the next open of the Companion (at most three tries, never once the user
 * wrote); quiet hours, workdays and away mode; the wake's minute of batching
 * and ten-minute spacing, with no heartbeat meanwhile; the heartbeat's
 * material rules (digest alone waits for the brief) and its skip without a
 * model, and its reply's notice at level important; no turn hearing of a
 * source the user turned off; the brief once a workday with Michi's fallback,
 * by the rule status.nextBriefAt follows; the budget tiers;
 * preemption by a composing beacon; "working" as the Companion's own work;
 * worker reports and closing delegations (on the real Michi source), and a
 * "Worker finished" notice the gate holds back; the user's rules failing
 * closed; the turn guard; the run row first with turn id cmp-<runId>; the
 * reply's notice. Fake sources, runner and clock; no timers (autoTick
 * false); temp MICHI_DATA_DIR per test.
 */

import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  companionPostId,
  type CompanionBucket, type CompanionItemSubtype, type CompanionNotice, type CompanionPresenceInput, type CompanionSeverity, type CompanionSourceKind,
} from 'michi-shared';
import type { CompanionCheckinCleanupResult } from '../src/services/companion/cleanup';
import { closeDb, getDb, initDb } from '../src/services/db';
import { startCompanion, type CompanionCoordinator, type CompanionCoordinatorDeps } from '../src/services/companion/coordinator';
import { CompanionEventBus } from '../src/services/companion/delivery';
import {
  addGoal,
  briefForDate,
  clearCompanionWelcomeDone,
  createReminder,
  decideCard,
  finishRun,
  getBriefCurate,
  getCompanionMetaNumber,
  getDelegation,
  getItem,
  getItemByKey,
  getReminder,
  getRun,
  insertBrief,
  insertCard,
  isCompanionWelcomeDone,
  latestEventSeq,
  listRuns,
  markCompanionWelcomeDone,
  markDelegationSent,
  recordCompanionView,
  recordDelegation,
  recordRun,
  setBriefCurate,
  setCompanionMeta,
  setCompanionMetaNumber,
  startRun,
} from '../src/services/companion/repository';
import { patchCompanionSettings } from '../src/services/companion/settings';
import { createMichiSource } from '../src/services/companion/sources/michi';
import type {
  CompanionDraftInput,
  CompanionMessageNotifier,
  CompanionPollContext,
  CompanionSource,
  CompanionTurnOutcome,
  CompanionTurnRequest,
  CompanionTurnRunner,
  ItemDraft,
  SourcePollResult,
} from '../src/services/companion/types';
import { seedConversation } from './helpers/homeConversations';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Thursday 2026-11-05, 12:00 local: a workday outside the default quiet hours. */
const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const localAt = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

const SUBTYPE: Record<string, CompanionItemSubtype> = { cr: 'cr_needs_attention', email: 'email_unread', pipeline: 'pipeline_blocked' };
interface FakeObject { version: string; subtype?: CompanionItemSubtype; bucket?: CompanionBucket; severity?: CompanionSeverity; title?: string }

class FakeSource implements CompanionSource {
  readonly polls: number[] = [];
  readonly objects = new Map<string, FakeObject>();
  hang: Promise<void> | null = null;

  constructor(readonly kind: CompanionSourceKind, private readonly interval: number) {}

  intervalMs(): number {
    return this.interval;
  }

  async poll(ctx: CompanionPollContext): Promise<SourcePollResult> {
    this.polls.push(ctx.now);
    if (this.hang) await this.hang;
    const observations = [...this.objects].map(([objectKey, object]) => ({ source: this.kind, objectKey, fingerprint: object.version, state: { ...object }, observedAt: ctx.now }));
    observations.push({ source: this.kind, objectKey: `${this.kind}:*list`, fingerprint: String(this.objects.size), state: { kind: 'list' } as never, observedAt: ctx.now });
    return { source: this.kind, ok: true, complete: true, observations, detail: `${this.objects.size} seen` };
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

class FakeRunner implements CompanionTurnRunner {
  readonly requests: CompanionTurnRequest[] = [];
  idle = true;
  preempts = 0;
  /** The coordinator's notice gate, which the real runner hands each post to (posts.ts). */
  notifier: CompanionMessageNotifier | null = null;
  respond: (request: CompanionTurnRequest) => CompanionTurnOutcome | Promise<CompanionTurnOutcome> = (request) => ({ outcome: 'quiet' });
  private readonly held: Array<(outcome: CompanionTurnOutcome) => void> = [];

  isIdle(): boolean {
    return this.idle;
  }

  run(request: CompanionTurnRequest): Promise<CompanionTurnOutcome> {
    this.requests.push(request);
    return Promise.resolve().then(() => this.respond(request)).then((outcome) => {
      // A reply is posted into V, and the post goes to the gate, as posts.ts does it.
      if (outcome.outcome === 'spoke' && outcome.messageText) {
        const itemIds = [...new Set(request.material.changes.filter((event) => event.kind !== 'baseline').map((event) => event.itemId))];
        this.notifier?.companionSpoke({ runId: request.runId, runKind: request.kind, itemIds });
      }
      return outcome;
    });
  }

  /** From now on a turn runs until release() or a preempt ends it. */
  hold(): void {
    this.respond = () => new Promise<CompanionTurnOutcome>((resolve) => this.held.push(resolve));
  }

  release(outcome: CompanionTurnOutcome): void {
    this.held.shift()?.(outcome);
  }

  async preempt(): Promise<void> {
    this.preempts += 1;
    this.release({ outcome: 'preempted', detail: 'The user started typing' });
  }
}

const kinds = (runner: FakeRunner) => runner.requests.map((request) => request.kind);
const HERE: CompanionPresenceInput = { active: true, companionFocused: false, lastInputAt: null, composing: false };
const SPOKE = (request: CompanionTurnRequest): CompanionTurnOutcome => ({ outcome: 'spoke', messageText: 'Hi! What should I call myself?' });

describe('Companion engine: model turns', () => {
  // What these tests await is bounded by unref'd timers, so nothing else
  // would keep the event loop alive and node:test would cancel the file.
  let keepAlive: ReturnType<typeof setInterval>;
  before(() => { keepAlive = setInterval(() => {}, 2 ** 30); });
  after(() => clearInterval(keepAlive));

  let tmpDir: string;
  let now: number;
  let cr: FakeSource;
  let email: FakeSource;
  let runner: FakeRunner;
  let notices: CompanionNotice[];
  let bus: CompanionEventBus;
  let started: CompanionCoordinator[];
  let coordinator: CompanionCoordinator;

  function engine(deps: Partial<CompanionCoordinatorDeps> = {}): CompanionCoordinator {
    const made = startCompanion({
      clock: { now: () => now }, sources: [cr, email], michiSource: null, auth: null, autoTick: false, events: bus,
      turnRunner: (notifier) => { runner.notifier = notifier; return runner; },
      isPaneVisible: () => false, nodeViewedAt: () => null, conversationNodeId: () => null, welcomePollWaitMs: 50, welcomeFirstLookWaitMs: 1_000, ...deps,
    });
    started.push(made);
    return made;
  }

  /** The Companion's own conversation, for the tests that read its messages; returns its node id. */
  function companionConversation(): string {
    getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws-companion','Companion',NULL,1,1)").run();
    seedConversation({ nodeId: 'n-companion', workspaceId: 'ws-companion', title: 'Companion' });
    return 'n-companion';
  }

  /** The user writes to the Companion. */
  function userWrites(nodeId: string, at: number): void {
    getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES (?,?,'user','hello?',?,?)").run(`u-${at}`, nodeId, at, at);
  }

  /** A tick at `time`, with the user around (no away mode) unless `away`. */
  async function at(time: number, options: { away?: boolean; target?: CompanionCoordinator } = {}): Promise<void> {
    const target = options.target ?? coordinator;
    now = time;
    if (!options.away) await target.service.onPresence(HERE);
    await target.tick();
    await target.idle();
  }

  function welcomed(when: number): void {
    markCompanionWelcomeDone(when);
    for (const key of ['companion:wake_cursor', 'companion:heartbeat_cursor', 'companion:brief_cursor'] as const) setCompanionMetaNumber(key, latestEventSeq());
    setCompanionMetaNumber('companion:last_heartbeat_at', when);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-turns-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    now = T0;
    cr = new FakeSource('cr', 5 * MINUTE);
    email = new FakeSource('email', 5 * MINUTE);
    runner = new FakeRunner();
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

  test('nothing speaks or notifies before the first welcome; the welcome looks first and is the first turn', async () => {
    patchCompanionSettings({ brief: { enabled: false } });
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0);
    cr.objects.set('cr:B:mine', { version: 'v1' });
    for (const minutes of [5, 6, 7, 65, 125]) await at(T0 + minutes * MINUTE);
    assert.deepEqual([runner.requests.length, notices.length], [0, 0]);

    const polls = cr.polls.length;
    // Three minutes after the last scheduled look: a look that recent the welcome would not repeat (H#4).
    now = T0 + 128 * MINUTE;
    runner.respond = SPOKE;
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true });
    await coordinator.idle();
    assert.equal(cr.polls.length, polls + 1, 'it looked first');
    assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['welcome', 'first-open']]);
    const [welcome] = runner.requests;
    assert.deepEqual(welcome!.material.open.map((item) => item.itemKey).sort(), ['cr:A:mine', 'cr:B:mine']);
    assert.deepEqual([welcome!.material.changes, welcome!.material.displayName, welcome!.material.rules, welcome!.material.lastLookAt], [[], 'Michi', '', null]);
    const run = getRun(welcome!.runId)!;
    assert.deepEqual([run.kind, run.outcome, run.turnId], ['welcome', 'spoke', `cmp-${welcome!.runId}`]);
    assert.equal(isCompanionWelcomeDone(), true);
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: false }, 'once');

    await at(T0 + 130 * MINUTE);
    await at(T0 + 140 * MINUTE);
    assert.deepEqual(kinds(runner), ['welcome'], 'what was there at the welcome is no wake');
    assert.equal(notices.length, 0, 'and never bursts out as notices');
  });

  test('a welcome that never got going is asked again; one waits at most its wait for a slow source', async () => {
    runner.respond = () => ({ outcome: 'error', detail: 'no runtime' });
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true });
    await coordinator.idle();
    assert.equal(isCompanionWelcomeDone(), false);
    runner.respond = (request) => ({ outcome: 'spoke', messageText: 'Hi! What should I call myself?' });
    let release!: () => void;
    email.hang = new Promise<void>((resolve) => { release = resolve; });
    now = T0 + 3 * MINUTE;
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: false }, 'the Chat tab asking again does not skip the wait after a failure');
    now = T0 + 11 * MINUTE;
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true }, 'not held up by the hanging source');
    assert.deepEqual([cr.polls.length, email.polls.length], [2, 2], 'it looked again: the last look was eleven minutes ago');
    await Promise.resolve();
    assert.equal(isCompanionWelcomeDone(), true);
    release();
    await coordinator.idle();
    assert.deepEqual(kinds(runner), ['welcome', 'welcome']);
    assert.equal(notices.length, 0, 'a welcome reply never notifies');
  });

  test('the user clicking into the composer neither holds back nor stops the welcome: they are about to read it (B22)', async () => {
    const composing: CompanionPresenceInput = { active: true, companionFocused: true, lastInputAt: now, composing: true };
    await coordinator.service.onPresence(composing);
    runner.hold();
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true }, 'the cursor already in the composer');
    await coordinator.service.onPresence(composing);
    now += MINUTE;
    await coordinator.service.onPresence({ ...composing, lastInputAt: now - MINUTE });
    assert.equal(runner.preempts, 0, 'focus and its keepalive left it running');
    runner.release(SPOKE(runner.requests[0]!));
    await coordinator.idle();
    assert.equal(getRun(runner.requests[0]!.runId)!.outcome, 'spoke');
    assert.equal(isCompanionWelcomeDone(), true);
  });

  test('a welcome that began but did not speak is asked for again the next time the user opens the Companion (B1)', async () => {
    const nodeId = companionConversation();
    const welcoming = engine({ conversationNodeId: () => nodeId });
    // Stopped once it began: a check-in posts nothing it did not finish, so V shows nothing of it.
    runner.respond = (request) => ({ outcome: 'preempted', detail: 'Stopped before it finished', turnId: `cmp-${request.runId}` });
    assert.deepEqual(await welcoming.service.requestWelcome(), { started: true });
    await welcoming.idle();
    assert.equal(isCompanionWelcomeDone(), false, 'it was not the welcome');
    assert.deepEqual(await welcoming.service.requestWelcome(), { started: false }, 'not right away: a stopped welcome waits its retry wait');
    now = T0 + 3 * MINUTE;
    assert.deepEqual(await welcoming.service.requestWelcome(), { started: true }, 'asked again after the wait, it starts');
    await welcoming.idle();
    assert.equal(kinds(runner).length, 2);

    await at(T0 + 5 * MINUTE, { target: welcoming });
    assert.equal(kinds(runner).length, 2, 'not again before the user opens the Companion');
    recordCompanionView(T0 + 5 * MINUTE);
    runner.respond = SPOKE;
    await at(T0 + 6 * MINUTE, { target: welcoming });
    assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['welcome', 'first-open'], ['welcome', 'first-open'], ['welcome', 'retry']]);
    assert.equal(isCompanionWelcomeDone(), true);
    recordCompanionView(T0 + 20 * MINUTE);
    await at(T0 + 21 * MINUTE, { target: welcoming });
    assert.equal(kinds(runner).length, 3, 'once it spoke, never again');
  });

  test('a welcome a restart cut short is asked for again; one the user answered by writing is not (B1)', async () => {
    const nodeId = companionConversation();
    // The previous process began the welcome (its done mark and run) and stopped in the middle of it.
    markCompanionWelcomeDone(T0 - 10 * MINUTE);
    const cut = startRun({ kind: 'welcome', trigger: 'first-open', startedAt: T0 - 10 * MINUTE, turnId: 'cmp-cut' });
    const restarted = engine({ conversationNodeId: () => nodeId, turnActive: () => false });
    await at(T0, { target: restarted });
    assert.equal(getRun(cut.id)!.outcome, 'error');
    assert.equal(isCompanionWelcomeDone(), false);
    runner.respond = SPOKE;
    recordCompanionView(T0 + 30_000);
    await at(T0 + MINUTE, { target: restarted });
    assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['welcome', 'retry']]);
    assert.equal(isCompanionWelcomeDone(), true);
  });

  test('a welcome that did not speak and then the user wrote: they have met it, and no welcome follows', async () => {
    const nodeId = companionConversation();
    const welcoming = engine({ conversationNodeId: () => nodeId });
    runner.respond = (request) => ({ outcome: 'error', detail: 'The runtime reported an error' });
    await welcoming.service.requestWelcome();
    await welcoming.idle();
    assert.equal(isCompanionWelcomeDone(), false);
    userWrites(nodeId, T0 + MINUTE);
    await at(T0 + 2 * MINUTE, { target: welcoming });
    assert.equal(isCompanionWelcomeDone(), true, 'their own message is the meeting');
    recordCompanionView(T0 + 15 * MINUTE);
    await at(T0 + 16 * MINUTE, { target: welcoming });
    assert.deepEqual(await welcoming.service.requestWelcome(), { started: false });
    assert.deepEqual(kinds(runner), ['welcome']);
  });

  test('three welcomes that never spoke: the Companion goes on without one rather than stay silent', async () => {
    const nodeId = companionConversation();
    const welcoming = engine({ conversationNodeId: () => nodeId });
    runner.respond = (request) => ({ outcome: 'error', detail: 'The runtime reported an error' });
    await welcoming.service.requestWelcome();
    await welcoming.idle();
    for (const minutes of [11, 22]) {
      recordCompanionView(T0 + minutes * MINUTE);
      await at(T0 + minutes * MINUTE + 30_000, { target: welcoming });
    }
    assert.deepEqual(kinds(runner), ['welcome', 'welcome', 'welcome'], 'ten minutes after each failure, on the next open');
    assert.equal(isCompanionWelcomeDone(), true, 'the third did not speak either: done anyway');
    recordCompanionView(T0 + 40 * MINUTE);
    await at(T0 + 41 * MINUTE, { target: welcoming });
    assert.deepEqual(kinds(runner), ['welcome', 'welcome', 'welcome']);
  });

  test('the welcome waits for a source still on its first look, at most its wait, so it names what that source finds (B23)', async () => {
    const looking = engine({ welcomePollWaitMs: 20, welcomeFirstLookWaitMs: 2_000 });
    runner.respond = SPOKE;
    cr.objects.set('cr:A:mine', { version: 'v1', title: 'CR-A needs attention' });
    let release!: () => void;
    cr.hang = new Promise<void>((resolve) => { release = resolve; });
    const asked = looking.service.requestWelcome();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runner.requests.length, 0, 'longer than the wait for a source that had its first look');
    assert.equal(looking.service.status!().working, true, 'the Companion shows it is busy while it looks');
    release();
    assert.deepEqual(await asked, { started: true });
    await looking.idle();
    assert.deepEqual(runner.requests[0]!.material.open.map((item) => item.itemKey), ['cr:A:mine'], 'the welcome sees the CRs');
    assert.equal(getItemByKey('cr:A:mine')!.status, 'seen', 'the first look: what is there is not news');
    await at(T0 + 5 * MINUTE, { target: looking });
    await at(T0 + 7 * MINUTE, { target: looking });
    assert.deepEqual([kinds(runner), notices.length], [['welcome'], 0], 'no wake or notice brings it up again as new');

    const pipeline = new FakeSource('pipeline', 10 * MINUTE);
    pipeline.hang = new Promise<void>(() => {});
    const bounded = engine({ sources: [cr, email, pipeline], welcomePollWaitMs: 20, welcomeFirstLookWaitMs: 80 });
    clearCompanionWelcomeDone();
    const startedAt = Date.now();
    assert.deepEqual(await bounded.service.requestWelcome(), { started: true }, 'a first look that never ends holds it up at most its wait');
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(pipeline.polls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const last = runner.requests.at(-1)!;
    assert.equal(last.kind, 'welcome');
    assert.deepEqual(last.material.firstLook, [{ source: 'pipeline', state: 'running', detail: null }],
      'the welcome is told the pipelines are still on their first look, so it does not read their silence as nothing there');
    assert.deepEqual(runner.requests[0]!.material.firstLook, [], 'nothing unread when every first look landed');
  });

  test('"working" is the Companion\'s own work, never the user\'s own reply in its conversation (B4)', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: false } });
    let busy = false;
    const watched = engine({ conversationBusy: () => busy, conversationNodeId: () => 'n-companion' });
    await at(T0, { target: watched });
    welcomed(T0);
    busy = true;
    await at(T0 + MINUTE, { target: watched });
    assert.equal(watched.service.isBusy(), true, 'the user\'s turn: no hidden turn starts');
    assert.equal(watched.service.status!().working, false, 'but nothing of the Companion\'s runs, so no "Working…" to go stale');
    busy = false;
    runner.hold();
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 5 * MINUTE, { target: watched });
    now = T0 + 6 * MINUTE;
    await watched.service.onPresence(HERE);
    await watched.tick();
    assert.deepEqual([kinds(runner), watched.service.status!().working], [['wake'], true], 'a hidden turn is');
    runner.release({ outcome: 'quiet' });
    await watched.idle();
    assert.equal(watched.service.status!().working, false);
  });

  test('no heartbeat while a wake is batching: one turn and one notice for one interrupting item (B5)', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: true, intervalMinutes: 30 } });
    await at(T0);
    welcomed(T0);
    runner.respond = (request) => ({ outcome: 'spoke', messageText: `${request.kind}: CR-N needs you.` });
    cr.objects.set('cr:N:mine', { version: 'v1', title: 'CR-N needs attention' });
    // First seen on the very tick the heartbeat comes due.
    for (const time of [T0 + 30 * MINUTE, T0 + 30 * MINUTE + 30_000, T0 + 31 * MINUTE, T0 + 31 * MINUTE + 30_000]) await at(time);
    assert.deepEqual(kinds(runner), ['wake'], 'the wake has it; the heartbeat after it finds nothing new');
    assert.deepEqual(notices.map((notice) => notice.body), ['CR-N needs attention'], 'the item\'s own notice only');

    // The next item arrives while the ten minutes between wakes hold the wake back, and the heartbeat comes due then.
    setCompanionMetaNumber('companion:last_heartbeat_at', T0 + 7 * MINUTE);
    cr.objects.set('cr:M:mine', { version: 'v1', title: 'CR-M needs attention' });
    for (const minutes of [35, 36, 38, 40, 41, 42]) await at(T0 + minutes * MINUTE);
    assert.deepEqual(kinds(runner), ['wake', 'wake'], 'no heartbeat takes the item the wake is waiting for');
    assert.deepEqual(runner.requests[1]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:M:mine')!.id]);
    assert.equal(listRuns(50).find((run) => run.kind === 'heartbeat')?.outcome, 'skipped', 'and the heartbeat after it finds nothing new');
  });

  test('a wake waits a minute to batch interrupting items and keeps ten minutes between wakes', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: false } });
    await at(T0);
    welcomed(T0);
    runner.respond = (request) => ({ outcome: 'spoke', messageText: 'CR-N needs you.' });
    cr.objects.set('cr:N:mine', { version: 'v1', title: 'CR-N needs attention' });
    email.objects.set('email:1', { version: 'v1', bucket: 'update', severity: 'digest' });
    await at(T0 + 5 * MINUTE);
    await at(T0 + 5 * MINUTE + 30_000);
    assert.equal(runner.requests.length, 0, 'batching');
    assert.equal(notices.length, 1, 'the item\'s own notice');
    await at(T0 + 6 * MINUTE);
    assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['wake', 'now-items']]);
    assert.deepEqual(runner.requests[0]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:N:mine')!.id], 'interrupting items only');
    assert.equal(notices.length, 1, 'the wake\'s reply is about what was just notified');
    assert.equal(getCompanionMetaNumber('companion:last_wake_at'), T0 + 6 * MINUTE);

    cr.objects.set('cr:M:mine', { version: 'v1' });
    await at(T0 + 10 * MINUTE);
    await at(T0 + 11 * MINUTE);
    await at(T0 + 15 * MINUTE);
    assert.deepEqual(kinds(runner), ['wake'], 'ten minutes between wakes');
    await at(T0 + 16 * MINUTE);
    assert.deepEqual(kinds(runner), ['wake', 'wake']);
    assert.deepEqual(runner.requests[1]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:M:mine')!.id]);
  });

  test('quiet hours, off days and away mode hold heartbeat and wake; what came in then is no wake later', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: true, intervalMinutes: 30 } });
    await at(T0);
    welcomed(T0);
    // Quiet hours (20:00-08:00).
    cr.objects.set('cr:Q:mine', { version: 'v1' });
    await at(localAt(5, 21, 0));
    await at(localAt(5, 21, 5));
    await at(localAt(5, 23, 0));
    assert.equal(runner.requests.length, 0);
    // The next morning: no wake for the night's item; the heartbeat brings it up instead.
    await at(localAt(6, 8, 0));
    await at(localAt(6, 8, 2));
    assert.deepEqual(kinds(runner), ['heartbeat']);
    assert.deepEqual(runner.requests[0]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:Q:mine')!.id]);

    // Saturday is not a workday.
    cr.objects.set('cr:S:mine', { version: 'v1' });
    await at(localAt(7, 12, 0));
    await at(localAt(7, 12, 2));
    await at(localAt(7, 14, 0));
    assert.deepEqual(kinds(runner), ['heartbeat']);
  });

  test('away mode: two hours without an active beacon, then polls only; back, the heartbeat catches up', async () => {
    patchCompanionSettings({ brief: { enabled: false } });
    await at(T0);
    welcomed(T0);
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 2 * HOUR + 5 * MINUTE, { away: true });
    await at(T0 + 2 * HOUR + 7 * MINUTE, { away: true });
    await at(T0 + 3 * HOUR, { away: true });
    assert.equal(runner.requests.length, 0, 'away: no wake, no heartbeat');
    assert.ok(cr.polls.length >= 2, 'polling goes on');
    await at(T0 + 3 * HOUR + MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat'], 'back: no stale wake, the heartbeat has it');
  });

  test('heartbeat: digest-only changes skip it without a model; needs-you changes, goals and card results are material (B19)', async () => {
    patchCompanionSettings({ brief: { enabled: false } });
    const B = localAt(5, 8, 0);
    await at(B);
    welcomed(B);
    email.objects.set('email:1', { version: 'v1', bucket: 'update', severity: 'digest' });
    await at(B + 5 * MINUTE);
    await at(B + 60 * MINUTE);
    assert.equal(runner.requests.length, 0);
    const skipped = listRuns(50).find((run) => run.kind === 'heartbeat')!;
    assert.deepEqual([skipped.outcome, skipped.detail], ['skipped', 'no new material']);
    assert.equal(getCompanionMetaNumber('companion:last_heartbeat_at'), B + 60 * MINUTE);

    cr.objects.set('cr:R:review', { version: 'v1', subtype: 'cr_review_requested', bucket: 'needs_you', severity: 'digest' });
    await at(B + 65 * MINUTE);
    await at(B + 100 * MINUTE);
    assert.equal(runner.requests.length, 0, 'not before the interval');
    await at(B + 120 * MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat']);
    assert.deepEqual(runner.requests[0]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:R:review')!.id]);
    await at(B + 180 * MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat'], 'the cursor moved past it');

    cr.objects.set('cr:R:review', { version: 'v2', subtype: 'cr_review_stale', bucket: 'stalled', severity: 'digest' });
    await at(B + 185 * MINUTE);
    await at(B + 240 * MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat'], 'an item entering stalled alone is digest: it waits for the brief');
    const digestOnly = listRuns(50).find((run) => run.kind === 'heartbeat')!;
    assert.deepEqual([digestOnly.outcome, digestOnly.detail], ['skipped', 'only digest changes: they wait for the brief']);
    assert.equal(getCompanionMetaNumber('companion:heartbeat_cursor'), latestEventSeq(), 'the heartbeat moved past it');

    addGoal('Ship the Companion', B);
    await at(B + 300 * MINUTE);
    assert.equal(runner.requests.length, 1, 'goals: only four hours after the last heartbeat that ran');
    await at(B + 360 * MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat', 'heartbeat']);
    assert.deepEqual(runner.requests[1]!.material.changes, []);
    assert.deepEqual(runner.requests[1]!.material.goals.map((goal) => goal.text), ['Ship the Companion']);

    // A card the user decided that the Companion has not heard of yet is worth a look of its own.
    const card = insertCard({ kind: 'goal.add', payload: { text: 'Keep CRs moving' }, summary: 'Add a goal: "Keep CRs moving"', reason: null, now: B + 380 * MINUTE });
    decideCard(card.id, 'dismissed', B + 390 * MINUTE);
    await at(B + 420 * MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat', 'heartbeat', 'heartbeat']);
    assert.deepEqual(runner.requests[2]!.material.cardResults.map((result) => [result.id, result.status]), [[card.id, 'dismissed']]);
    await at(B + 480 * MINUTE);
    assert.equal(runner.requests.length, 3, 'once it was told');
  });

  test('the brief: once a workday at its time, heartbeats only after it, Michi\'s fallback when the Companion\'s fails', async () => {
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(localAt(5, 7, 0));
    welcomed(localAt(4, 8, 0));
    cr.objects.set('cr:B:mine', { version: 'v1' });
    setBriefCurate('more on CRs');
    runner.respond = (request) => {
      if (request.kind !== 'brief') return { outcome: 'quiet' };
      insertBrief({ date: '2026-11-05', headline: '2 CRs need you', cards: [], closing: "That's all for today.", origin: 'llm', now });
      return { outcome: 'spoke', messageText: 'Your brief is ready.' };
    };
    await at(localAt(5, 8, 30));
    await at(localAt(5, 8, 59));
    assert.equal(runner.requests.filter((request) => request.kind !== 'wake').length, 0, 'no heartbeat before the day\'s brief');
    await at(localAt(5, 9, 0));
    const brief = runner.requests.find((request) => request.kind === 'brief')!;
    assert.equal(brief.trigger, 'schedule');
    assert.equal(brief.material.briefCurate, 'more on CRs');
    assert.equal(briefForDate('2026-11-05')!.origin, 'llm');
    assert.equal(getBriefCurate(), '', 'the focus was for this brief');
    await at(localAt(5, 9, 30));
    assert.equal(runner.requests.filter((request) => request.kind === 'brief').length, 1, 'once a day');
    assert.equal(notices.some((notice) => notice.body === 'Your brief is ready.'), false, 'a brief reply notifies at level all only');

    runner.respond = (request) => ({ outcome: 'quiet' });
    await at(localAt(6, 9, 0));
    const friday = briefForDate('2026-11-06')!;
    assert.deepEqual([friday.origin, friday.headline, friday.closing], ['fallback', '2 things need you today', "That's all for today."], 'it published nothing');
    assert.equal(friday.cards.length, 2);

    await at(localAt(7, 9, 0));
    assert.equal(briefForDate('2026-11-07'), null, 'no brief on Saturday');

    runner.respond = () => ({ outcome: 'error', detail: 'timed out' });
    await at(localAt(9, 9, 0));
    assert.equal(briefForDate('2026-11-09')!.origin, 'fallback', 'the turn failed');
  });

  test('the day the Companion is first met after the brief\'s time has no brief: the welcome was that day\'s look', async () => {
    welcomed(localAt(5, 10, 0));
    await at(localAt(5, 11, 0));
    await at(localAt(5, 15, 0));
    assert.equal(kinds(runner).includes('brief'), false);
    await at(localAt(6, 9, 0));
    assert.equal(kinds(runner).includes('brief'), true, 'the next workday has one');
  });

  test('a brief that comes due while the user is away waits for their return', async () => {
    welcomed(localAt(4, 8, 0));
    const later = engine();
    now = localAt(6, 6, 0);
    await later.service.onPresence(HERE);
    await at(localAt(6, 9, 0), { away: true, target: later });
    await at(localAt(6, 9, 30), { away: true, target: later });
    assert.equal(kinds(runner).includes('brief'), false, 'away since 06:00');
    await at(localAt(6, 9, 31), { target: later });
    assert.deepEqual(kinds(runner), ['brief']);
  });

  test('budget tiers: with the day\'s budget used, no wake, a skipped heartbeat, the fallback brief; the welcome still runs', async () => {
    patchCompanionSettings({ dailyTurnBudget: 1 });
    await at(T0);
    welcomed(localAt(4, 8, 0));
    recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - MINUTE, outcome: 'spoke', finishedAt: T0 - MINUTE + 1 });
    recordRun({ kind: 'worker_report', trigger: 'delegation', startedAt: T0 - MINUTE, outcome: 'spoke', finishedAt: T0 - MINUTE + 1 });
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 5 * MINUTE);
    await at(T0 + 7 * MINUTE);
    assert.equal(runner.requests.length, 0);
    assert.equal(briefForDate('2026-11-05')!.origin, 'fallback');
    const briefRun = listRuns(50).find((run) => run.kind === 'brief')!;
    assert.deepEqual([briefRun.outcome, briefRun.detail], ['skipped', 'Daily turn budget used: Michi wrote the brief']);
    cr.objects.set('cr:B:mine', { version: 'v1' });
    await at(T0 + 10 * MINUTE);
    await at(T0 + 2 * HOUR);
    assert.equal(listRuns(50).find((run) => run.kind === 'heartbeat' && run.outcome === 'skipped')?.detail, 'Daily turn budget used');
    assert.equal(runner.requests.length, 0);

    const fresh = engine();
    clearCompanionWelcomeDone();
    assert.deepEqual(await fresh.service.requestWelcome(), { started: true }, 'the welcome is exempt');
    await fresh.idle();
    assert.deepEqual(kinds(runner), ['welcome']);
  });

  test('a composing beacon preempts the running hidden turn; its material waits for the next turn', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: false } });
    await at(T0);
    welcomed(T0);
    runner.hold();
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 5 * MINUTE);
    now = T0 + 6 * MINUTE;
    await coordinator.service.onPresence(HERE);
    await coordinator.tick();
    assert.deepEqual(kinds(runner), ['wake']);
    assert.equal(coordinator.service.isBusy(), true);
    const cursor = getCompanionMetaNumber('companion:wake_cursor');
    await coordinator.service.onPresence({ active: true, companionFocused: true, lastInputAt: now, composing: true });
    await coordinator.idle();
    assert.equal(runner.preempts, 1);
    assert.equal(getRun(runner.requests[0]!.runId)!.outcome, 'preempted');
    assert.equal(getCompanionMetaNumber('companion:wake_cursor'), cursor, 'the material is kept');
    assert.equal(coordinator.service.isBusy(), false);

    runner.respond = (request) => ({ outcome: 'quiet' });
    now = T0 + 9 * MINUTE;
    await coordinator.service.onPresence({ active: true, companionFocused: true, lastInputAt: now - 10_000, composing: false });
    await coordinator.tick();
    await coordinator.idle();
    assert.deepEqual(kinds(runner), ['wake'], 'typing in the Companion panel a moment ago: it waits');
    await at(T0 + 10 * MINUTE);
    assert.deepEqual(kinds(runner), ['wake', 'wake']);
    assert.deepEqual(runner.requests[1]!.material.changes.map((event) => event.itemId), runner.requests[0]!.material.changes.map((event) => event.itemId));
  });

  test('no hidden turn starts while the conversation is busy; a turn that never ends is stopped by the guard', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: false } });
    let busy = true;
    const guarded = engine({ turnGuardMs: 20, conversationBusy: () => busy, conversationNodeId: () => 'n-companion' });
    await at(T0, { target: guarded });
    welcomed(T0);
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 5 * MINUTE, { target: guarded });
    await at(T0 + 7 * MINUTE, { target: guarded });
    assert.equal(runner.requests.length, 0, 'the conversation is busy');
    busy = false;
    runner.idle = false;
    await at(T0 + 8 * MINUTE, { target: guarded });
    assert.equal(runner.requests.length, 0, 'the runner is not idle');
    runner.idle = true;
    runner.hold();
    now = T0 + 9 * MINUTE;
    await guarded.service.onPresence(HERE);
    await guarded.tick();
    assert.equal(guarded.service.isBusy(), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runner.preempts, 1, 'the guard stopped it');
    const run = getRun(runner.requests[0]!.runId)!;
    assert.deepEqual([run.outcome, run.detail], ['error', 'The turn did not end in time; Michi stopped it']);
    assert.equal(guarded.service.isBusy(), false);
  });

  test('unreadable rules stop every model turn (fail closed), with an error run', async () => {
    patchCompanionSettings({ brief: { enabled: false } });
    await at(T0);
    welcomed(T0);
    setCompanionMeta('companion:rules', 'x'.repeat(2001));
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 5 * MINUTE);
    await at(T0 + 7 * MINUTE);
    assert.equal(runner.requests.length, 0);
    const error = listRuns(50).find((run) => run.kind === 'wake')!;
    assert.deepEqual([error.outcome, error.detail], ['error', 'Your rules could not be read; the Companion stays quiet until they can']);
  });

  test('a reply notifies through the gate (heartbeat); a heartbeat after a wake does not bring the wake\'s items up again', async () => {
    // At level all: at important a heartbeat about digest items alone stays in the chat (B19, the next test).
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: true, intervalMinutes: 30 }, notifications: 'all' });
    await at(T0);
    welcomed(T0);
    runner.respond = (request) => ({ outcome: 'spoke', messageText: `${request.kind} says hi` });
    cr.objects.set('cr:A:mine', { version: 'v1' });
    await at(T0 + 5 * MINUTE);
    await at(T0 + 6 * MINUTE);
    assert.deepEqual(kinds(runner), ['wake']);
    cr.objects.set('cr:B:mine', { version: 'v1', severity: 'digest' });
    await at(T0 + 10 * MINUTE);
    await at(T0 + 31 * MINUTE);
    assert.deepEqual(kinds(runner), ['wake', 'heartbeat']);
    assert.deepEqual(runner.requests[1]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:B:mine')!.id]);
    // D6: a check-in reply's notice names the items its run was about, never what the model wrote.
    assert.ok(notices.some((notice) => notice.body === `Michi: ${getItemByKey('cr:B:mine')!.title}` && notice.target.kind === 'companion'));
  });

  test('at level important a heartbeat about digest items alone stays in the chat; one about an interrupting item notifies (B19)', async () => {
    patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: true, intervalMinutes: 30 } });
    await at(T0);
    welcomed(T0);
    runner.respond = (request) => ({ outcome: 'spoke', messageText: `${request.kind} says hi` });
    cr.objects.set('cr:R:review', { version: 'v1', subtype: 'cr_review_requested', severity: 'digest' });
    await at(T0 + 5 * MINUTE);
    await at(T0 + 30 * MINUTE);
    assert.deepEqual(kinds(runner), ['heartbeat'], 'a review request is heartbeat material (R2.8)');
    assert.equal(notices.length, 0, 'but its reply is no notice: "Important" is only what needs the user now');

    // An interrupting item that came in while no wake could run (quiet hours) reaches the next morning's heartbeat.
    cr.objects.set('cr:Q:mine', { version: 'v1', title: 'CR-Q needs attention' });
    await at(localAt(5, 21, 0));
    await at(localAt(6, 8, 0));
    assert.deepEqual(kinds(runner), ['heartbeat', 'heartbeat']);
    assert.deepEqual(runner.requests[1]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:Q:mine')!.id]);
    assert.deepEqual(notices.map((notice) => notice.body), ['Michi: CR-Q needs attention'], 'about an item that interrupts: it notifies, naming it (D6)');
  });

  test('turning email and calendar off takes their items and events out of every turn\'s material, without resolving them (B15)', async () => {
    const calendar = new FakeSource('calendar', 5 * MINUTE);
    const watching = engine({ sources: [cr, email, calendar] });
    patchCompanionSettings({ heartbeat: { enabled: true, intervalMinutes: 30 } });
    await at(T0, { target: watching });
    welcomed(T0);
    cr.objects.set('cr:R:review', { version: 'v1', subtype: 'cr_review_requested', severity: 'digest' });
    email.objects.set('email:alice', { version: 'v1', title: 'Email from Alice', severity: 'now' });
    calendar.objects.set('calendar:conflict', { version: 'v1', subtype: 'calendar_conflict', title: 'Calendar conflict at 16:30', severity: 'digest' });
    await at(T0 + 5 * MINUTE, { target: watching });
    const alice = getItemByKey('email:alice')!;
    const conflict = getItemByKey('calendar:conflict')!;
    const watch = createReminder({ text: 'Answer Alice', itemId: alice.id, until: 'read' }, T0 + 5 * MINUTE);
    patchCompanionSettings({ sources: { email: { enabled: false }, calendar: { enabled: false } } });

    const offSources = (request: CompanionTurnRequest) => [
      ...request.material.changes.map((event) => getItem(event.itemId)?.source),
      ...request.material.open.map((item) => item.source),
    ].filter((source) => source === 'email' || source === 'calendar');
    await at(T0 + 7 * MINUTE, { target: watching });
    assert.deepEqual(kinds(runner), [], 'no wake for the email: it is out of sight');
    assert.equal(notices.length, 0, 'and its notice, already waiting in the batch, never goes out');
    await at(T0 + 30 * MINUTE, { target: watching });
    assert.deepEqual(kinds(runner), ['heartbeat'], 'the review request still is material');
    assert.deepEqual(offSources(runner.requests[0]!), [], 'the heartbeat hears nothing of email or calendar');
    assert.deepEqual(runner.requests[0]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:R:review')!.id]);

    await at(localAt(6, 9, 0), { target: watching });
    const brief = runner.requests.find((request) => request.kind === 'brief')!;
    assert.ok(brief, 'Friday\'s brief');
    assert.deepEqual(offSources(brief), [], 'nor does the brief, whose changes go back to the welcome');
    assert.ok(brief.material.changes.some((event) => event.itemId === getItemByKey('cr:R:review')!.id));
    assert.deepEqual([getItem(alice.id)!.status, getItem(conflict.id)!.status], ['new', 'new'], 'out of sight, not resolved');
    assert.equal(getReminder(watch.id)!.status, 'active', 'so no watch fires for them');
    assert.equal(notices.length, 0);
  });

  test('the engine writes the brief exactly when status.nextBriefAt says it is due: one rule for both (B24)', async () => {
    patchCompanionSettings({ heartbeat: { enabled: false } });
    runner.respond = (request) => ({ outcome: 'quiet' });
    const briefs = () => runner.requests.filter((request) => request.kind === 'brief').length;
    const agrees = async (time: number) => {
      now = time;
      const next = coordinator.service.status!().nextBriefAt;
      const before = briefs();
      await at(time);
      const wrote = briefs() > before;
      assert.equal(wrote, next !== null && next <= time, `${new Date(time).toString()}: nextBriefAt ${next === null ? 'none' : new Date(next).toString()}`);
      return wrote;
    };
    assert.equal(await agrees(localAt(5, 8, 30)), false, 'not met yet');
    welcomed(localAt(5, 9, 15));
    assert.equal(await agrees(localAt(5, 10, 0)), false, 'met after 09:00: the welcome was today\'s look');
    assert.equal(await agrees(localAt(6, 8, 30)), false);
    assert.equal(await agrees(localAt(6, 9, 0)), true, 'Friday 09:00');
    assert.equal(await agrees(localAt(6, 11, 0)), false, 'one a day');
    assert.equal(await agrees(localAt(7, 10, 0)), false, 'Saturday is no workday');
    patchCompanionSettings({ workdays: [1, 2, 3, 4, 5, 6] });
    assert.equal(await agrees(localAt(7, 10, 30)), true, 'unless the user works Saturdays');
    patchCompanionSettings({ brief: { enabled: false } });
    assert.equal(await agrees(localAt(9, 9, 30)), false, 'the brief turned off');
    patchCompanionSettings({ brief: { enabled: true } });
    assert.equal(await agrees(localAt(9, 9, 45)), true);
  });

  test('the welcome does not look again at a source the schedule just checked, unless its first look is still open (H#4)', async () => {
    await at(T0);
    const looked = () => [cr.polls.length, email.polls.length];
    assert.deepEqual(looked(), [1, 1]);
    runner.respond = SPOKE;
    now = T0 + MINUTE;
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true });
    await coordinator.idle();
    assert.deepEqual(looked(), [1, 1], 'both looked, ok and complete, a minute ago');
    assert.deepEqual(runner.requests[0]!.material.open, [], 'the welcome had what they found');

    // What the CRs look at grew (A5): their first look is open again, and the welcome waits for it.
    clearCompanionWelcomeDone();
    patchCompanionSettings({ sources: { cr: { includeReviews: false } } }, T0 + MINUTE);
    patchCompanionSettings({ sources: { cr: { includeReviews: true } } }, T0 + MINUTE);
    now = T0 + 90_000;
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true });
    await coordinator.idle();
    assert.deepEqual(looked(), [2, 1]);

    clearCompanionWelcomeDone();
    now = T0 + 4 * MINUTE;
    assert.deepEqual(await coordinator.service.requestWelcome(), { started: true });
    await coordinator.idle();
    assert.deepEqual(looked(), [3, 2], 'checked longer than two minutes ago: looked again');
    assert.match(listRuns(50).find((run) => run.kind === 'poll' && run.trigger === 'email')!.detail ?? '', /^First look/);
  });

  describe('worker reports (the real Michi source)', () => {
    let michiEngine: CompanionCoordinator;

    beforeEach(() => {
      getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws','sample-project',NULL,1,1)").run();
      patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: false } });
      michiEngine = engine({ michiSource: createMichiSource({ live: () => null }), sources: [] });
    });

    const worker = (nodeId: string, turn: { status: 'active' | 'completed' | 'error'; reply?: string; startedAt?: number }, extra: { userMessageAt?: number } = {}) => {
      seedConversation({ nodeId, workspaceId: 'ws', title: `Worker ${nodeId}`, userMessageAt: extra.userMessageAt, turns: [{ startedAt: T0 - HOUR, ...turn }] });
      return recordDelegation({ workspaceId: 'ws', nodeId, title: `Worker ${nodeId}`, now: T0 - 2 * HOUR, origin: 'start_conversation' });
    };
    /** The worker answered a follow-up the agent sent (`cms-` turn, its user message marked companionSend). */
    const answeredFollowUp = (nodeId: string, at: number, reply: string) => {
      const db = getDb();
      db.prepare('INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES (?,?,?,?,?,?,?)')
        .run(`${nodeId}-f-u`, nodeId, 'user', 'Follow-up', 90, at, JSON.stringify({ companionSend: { runId: 'cmr-1', via: 'user' } }));
      db.prepare('INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata) VALUES (?,?,?,?,?,?,?)').run(`${nodeId}-f-a`, nodeId, 'assistant', reply, 91, at + 1, null);
      db.prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,started_at,completed_at,updated_at)
        VALUES (?,?,?,?,'completed',?,?,?)`).run(`cms-${nodeId}`, nodeId, `${nodeId}-f-u`, `${nodeId}-f-a`, at, at + 10, at + 10);
      db.prepare('UPDATE companion_delegations SET last_sent_at = ? WHERE node_id = ?').run(at, nodeId);
    };

    test('a finished worker the user has not seen is reported once and stays followed; the others close as DESIGN-v2 §4 says', async () => {
      welcomed(T0 - DAY);
      worker('w-done', { status: 'completed', reply: 'Fixed the flaky test; the PR is up.' });
      worker('w-taken', { status: 'completed', reply: 'Done' }, { userMessageAt: T0 - 30 * MINUTE });
      worker('w-seen', { status: 'completed', reply: 'Done' });
      getDb().prepare('UPDATE nodes SET viewed_at = ? WHERE id = ?').run(T0 - MINUTE, 'w-seen');
      worker('w-busy', { status: 'active' });
      worker('w-failed', { status: 'error' });

      await at(T0, { target: michiEngine });
      assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['worker_report', 'delegation']]);
      const reports = runner.requests[0]!.material.reports;
      assert.deepEqual(reports.map((report) => [report.delegation.nodeId, report.messageId, report.status]).sort(), [
        ['w-done', 'w-done-t0-a', 'completed'],
        ['w-failed', 'w-failed-t0-a', 'failed'],
      ]);
      assert.equal(reports.find((report) => report.delegation.nodeId === 'w-done')!.excerpt, 'Fixed the flaky test; the PR is up.');
      for (const nodeId of ['w-done', 'w-failed']) {
        const delegation = getDelegation(nodeId)!;
        assert.deepEqual([delegation.state, delegation.closedAt], ['following', null], `${nodeId}: reported, and still followed`);
        assert.equal(delegation.lastReportedMessageId, `${nodeId}-t0-a`);
      }
      assert.deepEqual([getDelegation('w-taken')!.state, getDelegation('w-taken')!.closedReason], ['closed', 'took_over'], 'the user wrote in it');
      assert.equal(getDelegation('w-seen')!.state, 'following', 'the user read the reply: nothing to report, still followed');
      assert.equal(getDelegation('w-seen')!.lastReportedMessageId, 'w-seen-t0-a');
      assert.equal(getDelegation('w-busy')!.closedAt, null, 'still working');
      await at(T0 + MINUTE, { target: michiEngine });
      assert.equal(runner.requests.length, 1, 'once');
      await at(T0 + 23 * HOUR, { target: michiEngine });
      assert.deepEqual([getDelegation('w-busy')!.state, getDelegation('w-busy')!.closedReason], ['closed', 'idle'], 'a day with nothing sent or reported');
      assert.equal(getDelegation('w-done')!.state, 'following', 'reported 23 hours ago: not idle yet');
      await at(T0 + 24 * HOUR + MINUTE, { target: michiEngine });
      assert.equal(getDelegation('w-done')!.closedReason, 'idle');
    });

    test('a follow-up\'s answer is reported like the first reply; the agent\'s follow-up is never the user taking over; three days close it', async () => {
      welcomed(T0 - DAY);
      worker('w-1', { status: 'completed', reply: 'First pass done.' });
      await at(T0, { target: michiEngine });
      assert.deepEqual(runner.requests.map((request) => request.material.reports.map((report) => report.messageId)), [['w-1-t0-a']]);
      answeredFollowUp('w-1', T0 + HOUR, 'Changelog updated too.');
      await at(T0 + HOUR + MINUTE, { target: michiEngine });
      assert.equal(runner.requests.length, 2, 'the answer to the follow-up is reported');
      assert.deepEqual(runner.requests[1]!.material.reports.map((report) => [report.messageId, report.excerpt]), [['w-1-f-a', 'Changelog updated too.']]);
      assert.equal(getDelegation('w-1')!.state, 'following', 'its own follow-up never counts as the user writing');
      // The follow-up an hour later restarted the idle clock: still followed a day after the start, closed three days after it.
      await at(T0 + 23 * HOUR, { target: michiEngine });
      assert.equal(getDelegation('w-1')!.state, 'following');
      getDb().prepare('UPDATE companion_delegations SET last_sent_at = ?, last_reported_at = ? WHERE node_id = ?').run(T0 + 2 * DAY, T0 + 2 * DAY, 'w-1');
      await at(T0 + 3 * DAY, { target: michiEngine });
      assert.deepEqual([getDelegation('w-1')!.state, getDelegation('w-1')!.closedReason], ['closed', 'age']);
    });

    test('a worker that went or was stopped closes as gone; one from before v2 is never followed', async () => {
      welcomed(T0 - DAY);
      worker('w-gone', { status: 'completed', reply: 'Done' });
      getDb().prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run(T0 - MINUTE, 'w-gone');
      worker('w-stopped', { status: 'completed', reply: 'Done' });
      getDb().prepare("UPDATE turns SET status = 'cancelled' WHERE node_id = ?").run('w-stopped');
      seedConversation({ nodeId: 'w-mvp', workspaceId: 'ws', title: 'Worker w-mvp', turns: [{ status: 'completed', reply: 'Done', startedAt: T0 - HOUR }] });
      getDb().prepare(`INSERT INTO companion_delegations (id, owner_user_id, workspace_id, node_id, title, created_at) VALUES ('cmd-mvp', 'local-user', 'ws', 'w-mvp', 'Worker w-mvp', ?)`).run(T0 - 2 * HOUR);
      await at(T0, { target: michiEngine });
      assert.equal(runner.requests.length, 0, 'nothing to report');
      for (const nodeId of ['w-gone', 'w-stopped']) assert.deepEqual([getDelegation(nodeId)!.state, getDelegation(nodeId)!.closedReason], ['closed', 'gone'], nodeId);
      assert.deepEqual([getDelegation('w-mvp')!.state, getDelegation('w-mvp')!.lastReportedMessageId], ['closed', null], 'the MVP\'s delegation stays closed and unreported');
    });

    test('with the budget used up, a finished worker becomes a "Worker finished" notice instead', async () => {
      patchCompanionSettings({ dailyTurnBudget: 0 });
      welcomed(T0 - DAY);
      worker('w-1', { status: 'completed', reply: 'All done.' });
      await at(T0, { target: michiEngine });
      assert.equal(runner.requests.length, 0);
      assert.ok(notices.some((notice) => notice.body === 'Worker finished: Worker w-1'));
      assert.equal(getDelegation('w-1')!.state, 'following', 'reported by its notice, and still followed');
      assert.equal(getDelegation('w-1')!.lastReportedMessageId, 'w-1-t0-a', 'the notice reported it');
      assert.equal(listRuns(50).find((run) => run.kind === 'worker_report')!.outcome, 'skipped');
    });

    test('a "Worker finished" notice the gate holds back (an off day) leaves the reply to Today and the brief (B6), and the agent keeps following (D18)', async () => {
      patchCompanionSettings({ dailyTurnBudget: 0 });
      const saturday = localAt(7, 12, 0);
      welcomed(saturday - DAY);
      seedConversation({ nodeId: 'w-sat', workspaceId: 'ws', title: 'Worker w-sat', turns: [{ status: 'completed', reply: 'All done.', startedAt: saturday - HOUR }] });
      recordDelegation({ workspaceId: 'ws', nodeId: 'w-sat', title: 'Worker w-sat', now: saturday - 2 * HOUR, origin: 'start_conversation' });
      await at(saturday, { target: michiEngine });
      assert.equal(notices.length, 0, 'no notice on an off day');
      const delegation = getDelegation('w-sat')!;
      assert.deepEqual([delegation.state, delegation.closedAt, delegation.closedReason], ['following', null, null], 'still followed, never closed for this');
      assert.equal(delegation.lastReportedMessageId, null, 'nothing reported it');
      assert.equal(delegation.leftToTodayMessageId, 'w-sat-t0-a', 'its reply is Today\'s');
      assert.match(listRuns(50).find((run) => run.kind === 'worker_report')!.detail ?? '', /one left to Today and the brief$/);
      await at(saturday + MINUTE, { target: michiEngine });
      const done = getItemByKey('michi:node:w-sat');
      assert.ok(done, 'the next look at Michi shows the finished conversation');
      assert.deepEqual([done.subtype, done.status], ['michi_done', 'new']);
      await at(saturday + 5 * MINUTE, { target: michiEngine });
      assert.equal(listRuns(50).filter((run) => run.kind === 'worker_report').length, 1, 'once: the reply left to Today is not reported again');
      assert.equal(getDelegation('w-sat')!.state, 'following');
      // A follow-up the agent sends hands the conversation back to it: its answer is reported, not left to Today.
      patchCompanionSettings({ dailyTurnBudget: 5 });
      markDelegationSent(delegation.id, saturday + 10 * MINUTE);
      assert.equal(getDelegation('w-sat')!.leftToTodayMessageId, null);
      answeredFollowUp('w-sat', saturday + 10 * MINUTE, 'Changelog updated.');
      await at(saturday + 12 * MINUTE, { target: michiEngine });
      const reports = runner.requests.filter((request) => request.kind === 'worker_report');
      assert.deepEqual(reports.map((request) => request.material.reports.map((report) => report.messageId)), [['w-sat-f-a']]);
    });
  });
  describe('v2: superseded check-ins, the first look and what a stopped Michi left (DESIGN-v2 §3.3, §3.7, §3.8)', () => {
    test('a wake the user\'s message superseded ran: its items are covered; a preempted one comes back with them', async () => {
      patchCompanionSettings({ brief: { enabled: false }, heartbeat: { enabled: false } });
      await at(T0);
      welcomed(T0);
      runner.respond = (request) => ({ outcome: 'superseded', detail: 'Your message came first', turnId: `cmp-${request.runId}` });
      cr.objects.set('cr:A:mine', { version: 'v1' });
      await at(T0 + 5 * MINUTE);
      await at(T0 + 6 * MINUTE);
      assert.deepEqual(kinds(runner), ['wake']);
      assert.equal(getRun(runner.requests[0]!.runId)!.outcome, 'superseded', 'recorded as such');
      await at(T0 + 20 * MINUTE);
      await at(T0 + 21 * MINUTE);
      assert.deepEqual(kinds(runner), ['wake'], 'the user is in the conversation now: the same item is not brought up again');

      runner.respond = (request) => ({ outcome: 'preempted', detail: 'The user started typing', turnId: `cmp-${request.runId}` });
      cr.objects.set('cr:B:mine', { version: 'v1' });
      await at(T0 + 30 * MINUTE);
      await at(T0 + 31 * MINUTE);
      runner.respond = (request) => ({ outcome: 'quiet', turnId: `cmp-${request.runId}` });
      await at(T0 + 45 * MINUTE);
      await at(T0 + 46 * MINUTE);
      assert.deepEqual(kinds(runner), ['wake', 'wake', 'wake'], 'control: a preempted wake comes back');
      assert.deepEqual(runner.requests[2]!.material.changes.map((event) => event.itemId), [getItemByKey('cr:B:mine')!.id]);
    });

    test('a welcome the user\'s message superseded is done without a hello', async () => {
      runner.respond = (request) => ({ outcome: 'superseded', detail: 'Your message came first', turnId: `cmp-${request.runId}` });
      assert.deepEqual(await coordinator.service.requestWelcome(), { started: true });
      await coordinator.idle();
      assert.equal(isCompanionWelcomeDone(), true);
      recordCompanionView(T0 + 15 * MINUTE);
      await at(T0 + 16 * MINUTE);
      assert.deepEqual(kinds(runner), ['welcome'], 'never asked again');
    });

    test('while the first run narrates into V the welcome waits: status.firstLook, then the tick starts it', async () => {
      let narrating = true;
      const waiting = engine({ firstRunPending: () => narrating });
      runner.respond = SPOKE;
      assert.deepEqual(await waiting.service.requestWelcome(), { started: false });
      const status = waiting.service.status!();
      assert.deepEqual([status.firstLook, status.working], [true, true], '"Taking a first look…"');
      await at(T0 + MINUTE, { target: waiting });
      assert.deepEqual(kinds(runner), [], 'not while the first run still narrates');
      narrating = false;
      await at(T0 + 2 * MINUTE, { target: waiting });
      assert.deepEqual(runner.requests.map((request) => [request.kind, request.trigger]), [['welcome', 'first-open']]);
      assert.equal(isCompanionWelcomeDone(), true);
      assert.equal(waiting.service.status!().firstLook, undefined);
    });

    test('a queued welcome the user answered by writing in V never runs', async () => {
      const nodeId = companionConversation();
      const waiting = engine({ firstRunPending: () => true, conversationNodeId: () => nodeId });
      assert.deepEqual(await waiting.service.requestWelcome(), { started: false });
      userWrites(nodeId, T0 + MINUTE);
      await at(T0 + 2 * MINUTE, { target: waiting });
      assert.deepEqual(kinds(runner), []);
      assert.equal(isCompanionWelcomeDone(), true, 'they have met');
      assert.equal(waiting.service.status!().firstLook, undefined, 'no first look left to wait for');
    });

    test('the first tick cleans up the check-ins a stopped Michi left before failing what is still running; a running turn is left alone until it ends', async () => {
      markCompanionWelcomeDone(T0 - 10 * MINUTE);
      const welcome = startRun({ kind: 'welcome', trigger: 'first-open', startedAt: T0 - 10 * MINUTE, turnId: 'cmp-welcome' });
      const alive = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - MINUTE, turnId: 'cmp-alive' });
      const other = startRun({ kind: 'wake', trigger: 'now-items', startedAt: T0 - 5 * MINUTE, turnId: 'cmp-other' });
      let running = true;
      const calls: Array<{ skipped: string[]; stillRunning: string[] }> = [];
      const settle: Array<CompanionCheckinCleanupResult['settled']> = [
        [{ runId: welcome.id, kind: 'welcome', outcome: 'spoke', postedMessageId: companionPostId(welcome.id) }],
        [{ runId: alive.id, kind: 'heartbeat', outcome: 'superseded', postedMessageId: null }],
      ];
      const restarted = engine({
        turnActive: (turnId) => running && turnId === 'cmp-alive',
        cleanUpCheckins: async (skip) => {
          calls.push({
            skipped: [welcome.id, alive.id, other.id].filter(skip),
            stillRunning: listRuns(10).filter((run) => run.outcome === 'running').map((run) => run.id).sort(),
          });
          const settled = settle.shift() ?? [];
          for (const run of settled) finishRun(run.runId, { outcome: run.outcome, finishedAt: now, detail: 'Settled by cleanup' });
          return { settled, purged: settled.length, discarded: settled.length, pending: 0, kept: 0 };
        },
      });
      await at(T0, { target: restarted });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.skipped, [alive.id], 'a check-in whose turn still runs is not cleaned up under it');
      assert.deepEqual(calls[0]!.stillRunning, [welcome.id, alive.id, other.id].sort(), 'before anything else is failed');
      assert.deepEqual([getRun(welcome.id)!.outcome, getRun(welcome.id)!.detail], ['spoke', 'Settled by cleanup'], 'what cleanup recorded stands');
      assert.equal(getRun(other.id)!.outcome, 'error', 'the rest is failed as interrupted');
      assert.equal(getRun(alive.id)!.outcome, 'running');
      assert.equal(isCompanionWelcomeDone(), true, 'cleanup posted the welcome: it met the user');

      running = false;
      await at(T0 + MINUTE, { target: restarted });
      assert.equal(calls.length, 2, 'once the turn ended, cleanup takes it over');
      assert.deepEqual(calls[1]!.skipped, []);
      assert.deepEqual([getRun(alive.id)!.outcome, getRun(alive.id)!.detail], ['superseded', 'Settled by cleanup'], 'not failed again over it');
    });

    test('runs this process starts while the first cleanup still runs are its own: never failed as interrupted (G1a-review #4)', async () => {
      const left = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - 10 * MINUTE, turnId: 'cmp-left' });
      let release!: () => void;
      const cleaning = new Promise<void>((resolve) => { release = resolve; });
      let entered = false;
      const restarted = engine({
        cleanUpCheckins: async () => {
          entered = true;
          await cleaning;
          return { settled: [], purged: 0, discarded: 0, pending: 0, kept: 0 };
        },
      });
      runner.hold();
      now = T0;
      await restarted.service.onPresence(HERE);
      const ticking = restarted.tick();
      for (let i = 0; i < 20 && !entered; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(entered, true, 'the first tick is cleaning up');
      // The panel opens meanwhile: the welcome looks at every source (poll runs), then starts its check-in.
      assert.deepEqual(await restarted.service.requestWelcome(), { started: true });
      const ownRuns = listRuns(20).filter((run) => run.id !== left.id);
      assert.ok(ownRuns.some((run) => run.kind === 'welcome' && run.outcome === 'running'), JSON.stringify(ownRuns));
      assert.ok(ownRuns.some((run) => run.kind === 'poll'));
      release();
      await ticking;
      assert.deepEqual([getRun(left.id)!.outcome, getRun(left.id)!.detail], ['error', 'Interrupted: Michi stopped while it ran'], 'what a stopped Michi left still fails');
      for (const run of ownRuns) {
        assert.notEqual(getRun(run.id)!.detail, 'Interrupted: Michi stopped while it ran', `${run.kind} ${run.id}`);
      }
      const welcome = ownRuns.find((run) => run.kind === 'welcome')!;
      assert.equal(getRun(welcome.id)!.outcome, 'running', 'the welcome this process runs is still running');
      runner.release({ outcome: 'spoke', messageText: 'Hi! What should I call myself?' });
      await restarted.idle();
      assert.equal(getRun(welcome.id)!.outcome, 'spoke', 'and ends as it really ended');
    });

    test('a welcome cleanup ended without a word is asked for again; one the user superseded is done without a hello', async () => {
      const cut = startRun({ kind: 'welcome', trigger: 'first-open', startedAt: T0 - 10 * MINUTE, turnId: 'cmp-cut' });
      markCompanionWelcomeDone(T0 - 10 * MINUTE);
      const first = engine({
        cleanUpCheckins: async () => {
          finishRun(cut.id, { outcome: 'error', finishedAt: now, detail: 'Interrupted: Michi stopped while it ran' });
          return { settled: [{ runId: cut.id, kind: 'welcome', outcome: 'error', postedMessageId: null }], purged: 1, discarded: 1, pending: 0, kept: 0 };
        },
      });
      await at(T0, { target: first });
      assert.equal(isCompanionWelcomeDone(), false, 'it did not speak: asked for again');

      const superseded = startRun({ kind: 'welcome', trigger: 'retry', startedAt: T0 + MINUTE, turnId: 'cmp-superseded' });
      markCompanionWelcomeDone(T0 + MINUTE);
      const second = engine({
        cleanUpCheckins: async () => {
          finishRun(superseded.id, { outcome: 'superseded', finishedAt: now });
          return { settled: [{ runId: superseded.id, kind: 'welcome', outcome: 'superseded', postedMessageId: null }], purged: 1, discarded: 1, pending: 0, kept: 0 };
        },
      });
      await at(T0 + 2 * MINUTE, { target: second });
      assert.equal(isCompanionWelcomeDone(), true);
    });
  });
});
