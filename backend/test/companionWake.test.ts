import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * Who listens, and waking the quit app (DESIGN-v2 §5.1, §5.2): the
 * Companion's bus counts windows (`/companion/events`) and the notifier
 * (Electron main's feed) and how long each has been gone, boot counting as
 * just seen; a notice the outbox stores wakes the app once no notifier has
 * been connected for 30 seconds, and only one that went out (never one the
 * gate held, nor the fold a connecting notifier gets); and the backend's one
 * launcher serves the scheduler and the Companion alike: one wake a minute
 * between them, the service's data and config directories passed on with
 * `open --env`, and the scheduler's grace now 30 seconds too. Fake clocks,
 * a fake launcher or a fake `open`; temp MICHI_DATA_DIR per test.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  COMPANION_COALESCE_MS,
  CompanionEventBus,
  CompanionNoticeGate,
  enqueueCompanionNotice,
  replayCompanionNotices,
  type CompanionNoticeDraft,
} from '../src/services/companion/delivery';
import { markCompanionWelcomeDone, upsertItem } from '../src/services/companion/repository';
import { BACKGROUND_LAUNCH_ARG, NOTIFIER_GRACE_MS, createDesktopAppLauncher, type AppLauncher } from '../src/services/scheduledJobs/appLauncher';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import {
  ScheduledJobScheduler,
  type ScheduledJobExecutor,
  type ScheduledRunHandle,
  type ScheduledRunHooks,
  type ScheduledRunOutcome,
} from '../src/services/scheduledJobs/scheduler';
import type { ItemDraft } from '../src/services/companion/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Thursday 2026-11-05, 12:00 local: a workday outside the default quiet hours. */
const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const NOTICE: CompanionNoticeDraft = { title: 'Michi', body: 'MyService is blocked', target: { kind: 'companion', tab: 'today' }, itemIds: [] };

let tmpDir: string;

function openDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-wake-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  initDb(); enableSyntheticCompanionSources();
}

function dropDb(): void {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('the Companion bus counts its windows and its notifier', () => {
  test('how many windows are open, whether the notifier is, and how long each has been gone; boot counts as just seen', () => {
    let now = T0;
    const bus = new CompanionEventBus({ current: () => 0, bump: () => 1 }, { clock: () => now });
    assert.deepEqual([bus.windowCount(), bus.hasNotifier(), bus.windowAbsentForMs(), bus.notifierAbsentForMs()], [0, false, 0, 0],
      'a window or notifier reconnecting after a restart is not gone yet');
    now += 4_000;
    assert.equal(bus.windowAbsentForMs(), 4_000);
    const closeA = bus.subscribe({ client: 'window' });
    const closeB = bus.subscribe({ client: 'window' });
    bus.subscribe({ changed: () => {} });
    assert.deepEqual([bus.windowCount(), bus.hasNotifier(), bus.windowAbsentForMs()], [2, false, 0], 'an in-process listener is neither');
    closeA();
    now += 10_000;
    assert.equal(bus.windowAbsentForMs(), 0, 'one is still open');
    closeB();
    now += 6_000;
    assert.equal(bus.windowAbsentForMs(), 6_000, 'counted from when the last one went');
    closeB();
    assert.equal(bus.windowAbsentForMs(), 6_000, 'closing twice changes nothing');
    const offNotifier = bus.subscribe({ client: 'notifier' });
    assert.deepEqual([bus.hasNotifier(), bus.windowCount(), bus.notifierAbsentForMs()], [true, 0, 0], 'the notifier is no window');
    offNotifier();
    now += 31_000;
    assert.equal(bus.notifierAbsentForMs(), 31_000);
    bus.subscribe({ notifier: true });
    assert.equal(bus.hasNotifier(), true, 'the flag from before v2 still means the notifier');
  });
});

describe('a notice the outbox stores wakes the quit app (DESIGN-v2 §5.1)', () => {
  let now: number;
  let wakes: number;
  let bus: CompanionEventBus;
  let timers: Array<{ at: number; callback: () => void; cancelled: boolean }>;
  const setTimer = (callback: () => void, delayMs: number) => {
    const timer = { at: now + delayMs, callback, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const armed = () => timers.filter((timer) => !timer.cancelled).length;
  /** The fake clock moves on; the timers that came due run, in order. */
  const elapse = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      now = Math.max(now, due.at);
      due.callback();
    }
    now = until;
  };

  beforeEach(() => {
    openDb();
    now = T0;
    wakes = 0;
    timers = [];
    bus = new CompanionEventBus(undefined, { clock: () => now });
    bus.configureWake({ launcher: { wake: () => { wakes += 1; return true; } }, setTimer });
  });

  afterEach(dropDb);

  test('only once no notifier has been connected for 30 seconds, and never without a launcher', () => {
    now += NOTIFIER_GRACE_MS - 1;
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(wakes, 0, 'a notifier that is only reconnecting after a restart');
    now += 1;
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(wakes, 1);
    const offNotifier = bus.subscribe({ client: 'notifier', notice: () => {} });
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(wakes, 1, 'a connected notifier shows it itself');
    offNotifier();
    now += NOTIFIER_GRACE_MS - 1;
    enqueueCompanionNotice({ ...NOTICE, channel: 'chat' }, now, { bus });
    assert.equal(wakes, 1, 'the grace starts again when the notifier leaves');
    now += 1;
    enqueueCompanionNotice({ ...NOTICE, channel: 'chat' }, now, { bus });
    assert.equal(wakes, 2, 'a conversation\'s notice wakes it too');
    bus.subscribe({ client: 'window' });
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(wakes, 3, 'a window is no notifier: in a browser nothing shows OS notices');
    bus.configureWake(null);
    now += HOUR;
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(wakes, 3, 'a backend that may not wake the app never does');
  });

  test('a notice stored within the grace wakes it once the grace is up, if no notifier came back and it still waits (H-review #2)', () => {
    // The user quits Michi (⌘Q) while V works: the notifier goes; ten seconds later V asks for approval.
    now += 5 * MINUTE;
    const quit = bus.subscribe({ client: 'notifier', notice: () => {} });
    quit();
    elapse(10_000);
    const approval = enqueueCompanionNotice({ ...NOTICE, title: 'Robin: needs your approval', channel: 'chat' }, now, { bus });
    assert.ok(approval);
    assert.equal(wakes, 0, 'the notifier may only be reconnecting');
    enqueueCompanionNotice({ ...NOTICE, channel: 'chat' }, now, { bus });
    assert.equal(armed(), 1, 'one look again, however many notices');
    elapse(NOTIFIER_GRACE_MS - 10_000 - 1);
    assert.equal(wakes, 0);
    elapse(1);
    assert.equal(wakes, 1, 'the grace is up and nobody came back: the app is woken for the notices that wait');
    assert.equal(armed(), 0);

    // A notifier that comes back within the grace shows them itself: nothing wakes.
    const back = bus.subscribe({ client: 'notifier', notice: () => {} });
    back();
    elapse(1_000);
    enqueueCompanionNotice(NOTICE, now, { bus });
    bus.subscribe({ client: 'notifier', notice: () => {} });
    elapse(NOTIFIER_GRACE_MS);
    assert.equal(wakes, 1, 'it came back');
  });

  test('the look again wakes nothing once no notice waits, nor once waking was turned off; boot is a grace too', () => {
    let waiting = true;
    bus.configureWake({ launcher: { wake: () => { wakes += 1; return true; } }, setTimer, hasPendingNotice: () => waiting });
    // The first 30 s after the service boots count as a notifier just seen.
    elapse(5_000);
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(wakes, 0);
    waiting = false;
    elapse(NOTIFIER_GRACE_MS);
    assert.equal(wakes, 0, 'shown meanwhile (or expired): nothing to wake for');
    waiting = true;
    const quit = bus.subscribe({ client: 'notifier', notice: () => {} });
    quit();
    enqueueCompanionNotice(NOTICE, now, { bus });
    assert.equal(armed(), 1);
    bus.configureWake(null);
    assert.equal(armed(), 0, 'the backend is shutting down');
    elapse(NOTIFIER_GRACE_MS);
    assert.equal(wakes, 0);
  });

  test('what the gate holds back never wakes it, nor the fold a connecting notifier gets; what it sends does', () => {
    markCompanionWelcomeDone(T0 - HOUR);
    const gate = new CompanionNoticeGate({ clock: { now: () => now }, bus, isPaneVisible: () => false, nodeViewedAt: () => null });
    const draft = (itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft => ({
      source: 'pipeline', subtype: 'pipeline_blocked', itemKey, version: 'v1', bucket: 'needs_you', severity: 'now',
      title: `${itemKey} is blocked`, summary: null, target: null, facts: {}, observedAt: now, ...overrides,
    });
    now = T0 + NOTIFIER_GRACE_MS;
    const quiet = new Date(2026, 10, 5, 22, 0, 0, 0).getTime();
    const night = upsertItem(draft('pipeline:night'), quiet).item;
    assert.equal(gate.notify({ kind: 'item', itemId: night.id }, quiet), 'held');
    const digest = upsertItem(draft('pipeline:digest', { severity: 'digest' }), now).item;
    assert.equal(gate.notify({ kind: 'item', itemId: digest.id }, now), 'dropped');
    assert.equal(wakes, 0);
    upsertItem(draft('pipeline:A'), now);
    gate.processItems(now);
    assert.ok(gate.processItems(now + COMPANION_COALESCE_MS));
    assert.equal(wakes, 1, 'the notice the gate sent');
    enqueueCompanionNotice(NOTICE, now + COMPANION_COALESCE_MS + 1, { bus });
    assert.equal(wakes, 2);
    const replay = replayCompanionNotices(now + MINUTE);
    assert.equal(replay.length, 1, 'the backlog folds');
    assert.equal(wakes, 2, 'the fold is for a notifier that is there already');
  });
});

// ── The scheduler shares the launcher ──────────────────────────────────────

class FakeExecutor implements ScheduledJobExecutor {
  readonly started: Array<{ hooks: ScheduledRunHooks; resolve(outcome: ScheduledRunOutcome): void }> = [];

  async start(job: ScheduledJobRecord, _run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    let resolve!: (outcome: ScheduledRunOutcome) => void;
    const done = new Promise<ScheduledRunOutcome>((settle) => { resolve = settle; });
    this.started.push({ hooks, resolve });
    const index = this.started.length;
    getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)')
      .run(`tree-${index}`, job.workspaceId, `node-${index}`);
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, minimized, created_at) VALUES (?, ?, ?, 'chat', 'idle', 0, 1)`)
      .run(`node-${index}`, job.workspaceId, `tree-${index}`);
    return { nodeId: `node-${index}`, treeId: `tree-${index}`, turnId: `turn-${index}`, done, cancel: () => resolve({ status: 'cancelled', summary: null, error: null }) };
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('one launcher for the scheduler and the Companion (DESIGN-v2 §5.1)', () => {
  let now: number;
  let nextId: number;
  let executor: FakeExecutor;
  let schedulers: ScheduledJobScheduler[];

  beforeEach(() => {
    openDb();
    now = T0;
    nextId = 0;
    executor = new FakeExecutor();
    schedulers = [];
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-a', 'ws-a', 1, 1)").run();
  });

  afterEach(async () => {
    for (const scheduler of schedulers) await scheduler.stop();
    dropDb();
  });

  function makeScheduler(launcher: AppLauncher, events: ScheduledJobEventBus): ScheduledJobScheduler {
    // No notifierGraceMs: the default is what is under test.
    const scheduler = new ScheduledJobScheduler({
      repository: new ScheduledJobsRepository(), executor, events, launcher,
      workspaceExists: (id) => id === 'ws-a', runtimeExists: () => true,
      clock: () => now, instanceId: 'instance-a', createId: () => `job-${++nextId}`, pollIntervalMs: 60_000, cancelGraceMs: 10,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  async function needsApproval(scheduler: ScheduledJobScheduler): Promise<void> {
    const job = scheduler.createJob({ workspaceId: 'ws-a', name: `Job ${nextId + 1}`, prompt: 'Check the build.', schedule: { kind: 'every', everySeconds: 3600 }, notify: false });
    await scheduler.runNow(job.id);
    await settle();
    executor.started.at(-1)!.hooks.onAttention('approval');
  }

  test('a Companion notice and a scheduled run asking for approval share one wake a minute, with the service\'s directories', async () => {
    const opens: string[][] = [];
    const launcher = createDesktopAppLauncher({
      bundlePath: '/Applications/Michi.app', enabled: true, platform: 'darwin', clock: () => now, exists: () => true,
      env: { MICHI_DATA_DIR: '/Users/me/.michi data', MICHI_CONFIG_DIR: '/Users/me/.michi-config', HOME: '/Users/me', MICHI_CLOUD: '' },
      exec: (file, args, callback) => { opens.push([file, ...args]); callback(null); },
    });
    const companionBus = new CompanionEventBus(undefined, { clock: () => now });
    companionBus.configureWake({ launcher });
    const scheduler = makeScheduler(launcher, new ScheduledJobEventBus(() => now));
    now = T0 + NOTIFIER_GRACE_MS;
    enqueueCompanionNotice(NOTICE, now, { bus: companionBus });
    assert.deepEqual(opens, [['/usr/bin/open', '-g', '-j', '--env', 'MICHI_DATA_DIR=/Users/me/.michi data', '--env', 'MICHI_CONFIG_DIR=/Users/me/.michi-config',
      '/Applications/Michi.app', '--args', BACKGROUND_LAUNCH_ARG]], 'only the two directories are passed on, each as one argument');
    now += 20_000;
    await needsApproval(scheduler);
    assert.equal(opens.length, 1, 'the scheduler is held to the same minute');
    now += MINUTE;
    await needsApproval(scheduler);
    assert.equal(opens.length, 2, 'a minute later it may');
    now += 10_000;
    enqueueCompanionNotice(NOTICE, now, { bus: companionBus });
    assert.equal(opens.length, 2, 'and then the Companion waits for the minute in turn');
  });

  test('the scheduler waits 30 seconds after its notifier was last seen, as the Companion does', async () => {
    let wakes = 0;
    const scheduler = makeScheduler({ wake: () => { wakes += 1; return true; } }, new ScheduledJobEventBus(() => now));
    now = T0 + 20_000;
    await needsApproval(scheduler);
    assert.equal(wakes, 0, 'twenty seconds: a feed still reconnecting (the old grace was 10 s)');
    now = T0 + NOTIFIER_GRACE_MS;
    await needsApproval(scheduler);
    assert.equal(wakes, 1);
  });

  test('without directories to pass on, open gets none; a value it cannot carry is left out', () => {
    const opens: string[][] = [];
    const launcher = (env: Record<string, string | undefined>) => createDesktopAppLauncher({
      bundlePath: '/Applications/Michi.app', enabled: true, platform: 'darwin', clock: () => now, exists: () => true, env,
      exec: (file, args, callback) => { opens.push([file, ...args]); callback(null); },
    });
    launcher({}).wake();
    launcher({ MICHI_DATA_DIR: '/a\nb', MICHI_CONFIG_DIR: '' }).wake();
    assert.deepEqual(opens, [
      ['/usr/bin/open', '-g', '-j', '/Applications/Michi.app', '--args', BACKGROUND_LAUNCH_ARG],
      ['/usr/bin/open', '-g', '-j', '/Applications/Michi.app', '--args', BACKGROUND_LAUNCH_ARG],
    ]);
  });
});
