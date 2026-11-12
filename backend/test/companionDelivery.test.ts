import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The single notification gate (delivery.ts CompanionNoticeGate, DESIGN
 * R2.7): nothing before the first welcome; enabled, paused, level, quiet
 * hours and workdays; only interrupting items, never digest, silent or a
 * demoted subtype; the already-handled check of Michi conversations; the
 * daily and half-hour caps; one notice per item version; the 30-second
 * batch; the one 30-minute reminder of a conversation waiting on the user;
 * where a notice opens (a lone item at its Today row, a lone conversation
 * itself, a batch on Today); items of a source turned off counting as gone;
 * Companion replies (which turns, the brief at level all, a check-in at level
 * important only about an interrupting item, never while the panel is
 * focused, a wake about items just notified, once per run, and never their
 * text: the titles of their run's items) and the "Worker finished" notice.
 * Temp MICHI_DATA_DIR per test; times are explicit.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompanionNotice } from 'michi-shared';
import { closeDb, initDb } from '../src/services/db';
import {
  CHAT_NOTICE_REPLAY_MAX,
  COMPANION_COALESCE_MS,
  CompanionEventBus,
  CompanionNoticeGate,
  companionBacklogBody,
  enqueueCompanionNotice,
  noticeExcerpt,
  replayCompanionNotices,
} from '../src/services/companion/delivery';
import {
  applyItemAction,
  clearCompanionWelcomeDone,
  demoteSubtype,
  getItem,
  insertNotice,
  markCompanionWelcomeDone,
  notifiedVersionOf,
  pendingNotices,
  resolveItems,
  upsertItem,
} from '../src/services/companion/repository';
import { patchCompanionSettings } from '../src/services/companion/settings';
import type { ItemDraft } from '../src/services/companion/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Thursday 2026-11-05, 12:00 local: a workday outside the default quiet hours. */
const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();

function draft(itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'pipeline', subtype: 'pipeline_blocked', itemKey, version: 'v1', bucket: 'needs_you', severity: 'now',
    title: `${itemKey} is blocked`, summary: 'Prod failed', target: { kind: 'url', url: 'https://builds.example.com/pipelines/P' },
    facts: {}, observedAt: T0, ...overrides,
  };
}

const michi = (nodeId: string, overrides: Partial<ItemDraft> = {}): ItemDraft => draft(`michi:node:${nodeId}`, {
  source: 'michi', subtype: 'michi_waiting', severity: 'digest', title: `Chat ${nodeId}`, summary: 'Asked: Ship it?',
  target: { kind: 'node', workspaceId: 'ws', nodeId }, ...overrides,
});

describe('Companion notice gate', () => {
  let tmpDir: string;
  let notices: CompanionNotice[];
  let focused: boolean;
  let visible: Set<string>;
  let viewed: Map<string, number>;
  let gate: CompanionNoticeGate;
  let bus: CompanionEventBus;
  let clockNow: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-delivery-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    notices = [];
    focused = false;
    visible = new Set();
    viewed = new Map();
    clockNow = T0;
    bus = new CompanionEventBus();
    bus.subscribe({ notifier: true, notice: (notice) => notices.push(notice) });
    gate = new CompanionNoticeGate({
      clock: { now: () => clockNow }, bus, isPanelFocused: () => focused,
      isPaneVisible: (nodeId) => visible.has(nodeId), nodeViewedAt: (nodeId) => viewed.get(nodeId) ?? null,
    });
    markCompanionWelcomeDone(T0 - DAY);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nothing goes out before the first welcome, and what came in then never bursts out after it', () => {
    clearCompanionWelcomeDone();
    const { item } = upsertItem(draft('pipeline:A'), T0);
    gate.processItems(T0);
    gate.processItems(T0 + COMPANION_COALESCE_MS);
    assert.equal(notices.length, 0);
    assert.equal(notifiedVersionOf(item.id), 'v1', 'held: counted as notified');
    markCompanionWelcomeDone(T0 + MINUTE);
    gate.processItems(T0 + 2 * MINUTE);
    gate.processItems(T0 + 3 * MINUTE);
    assert.equal(notices.length, 0);
  });

  test('an interrupting item goes out once per version, after the 30-second batch', () => {
    const { item } = upsertItem(draft('pipeline:A'), T0);
    assert.equal(gate.processItems(T0), null);
    assert.deepEqual(gate.pendingItemIds(), [item.id]);
    assert.equal(gate.processItems(T0 + COMPANION_COALESCE_MS - 1), null);
    const notice = gate.processItems(T0 + COMPANION_COALESCE_MS);
    assert.ok(notice);
    assert.deepEqual([notice.title, notice.body, notice.target, notice.itemIds],
      ['Michi', 'pipeline:A is blocked — Prod failed', { kind: 'companion', tab: 'today', itemId: item.id }, [item.id]],
      'a lone item that is no conversation opens Today at its row (A10), whatever its own link');
    assert.equal(notices.length, 1, 'published to the notifier');
    assert.equal(notifiedVersionOf(item.id), 'v1');
    gate.processItems(T0 + 2 * MINUTE);
    gate.processItems(T0 + 3 * MINUTE);
    assert.equal(notices.length, 1, 'never twice for one version');

    upsertItem(draft('pipeline:A', { version: 'v2' }), T0 + 40 * MINUTE);
    gate.processItems(T0 + 40 * MINUTE);
    gate.processItems(T0 + 41 * MINUTE);
    assert.equal(notices.length, 2, 'a new version is news again');
  });

  test('items due within 30 seconds go out as one notice', () => {
    const a = upsertItem(draft('pipeline:A'), T0).item;
    gate.processItems(T0);
    const b = upsertItem(draft('pipeline:B'), T0 + 10_000).item;
    gate.processItems(T0 + 10_000);
    const notice = gate.processItems(T0 + COMPANION_COALESCE_MS);
    assert.ok(notice);
    assert.equal(notices.length, 1);
    assert.equal(notice.body, '2 updates: pipeline:A is blocked · pipeline:B is blocked');
    assert.deepEqual(notice.itemIds.sort(), [a.id, b.id].sort());
    assert.deepEqual(notice.target, { kind: 'companion', tab: 'today' });
  });

  test('digest, silent and demoted items never notify; the demoted ones are held so undoing it sends nothing old', () => {
    const digest = upsertItem(draft('pipeline:D', { severity: 'digest' }), T0).item;
    const silent = upsertItem(draft('pipeline:S', { severity: 'silent' }), T0).item;
    demoteSubtype('cr_needs_attention', T0);
    const demoted = upsertItem(draft('cr:1:mine', { source: 'cr', subtype: 'cr_needs_attention' }), T0).item;
    assert.equal(gate.notify({ kind: 'item', itemId: digest.id }, T0), 'dropped');
    assert.equal(gate.notify({ kind: 'item', itemId: silent.id }, T0), 'dropped');
    assert.equal(gate.notify({ kind: 'item', itemId: demoted.id }, T0), 'held');
    gate.processItems(T0 + MINUTE);
    assert.equal(notices.length, 0);
    assert.equal(notifiedVersionOf(digest.id), null);
    assert.equal(notifiedVersionOf(demoted.id), 'v1');
  });

  test('off, paused, notifications off, quiet hours and off days hold notices; snoozed and dismissed items are not open', () => {
    const at = (hour: number, day = 5) => new Date(2026, 10, day, hour, 0, 0, 0).getTime();
    const quiet = upsertItem(draft('pipeline:Q'), at(21)).item;
    assert.equal(gate.notify({ kind: 'item', itemId: quiet.id }, at(21)), 'held', 'quiet hours: left for the brief');
    const weekend = upsertItem(draft('pipeline:W'), at(12, 7)).item;
    assert.equal(gate.notify({ kind: 'item', itemId: weekend.id }, at(12, 7)), 'held', 'Saturday is not a workday');
    patchCompanionSettings({ notifications: 'off' });
    const off = upsertItem(draft('pipeline:O'), T0).item;
    assert.equal(gate.notify({ kind: 'item', itemId: off.id }, T0), 'held');
    patchCompanionSettings({ notifications: 'important', paused: true });
    const paused = upsertItem(draft('pipeline:P'), T0).item;
    assert.equal(gate.notify({ kind: 'item', itemId: paused.id }, T0), 'held');
    patchCompanionSettings({ paused: false, enabled: false });
    const disabled = upsertItem(draft('pipeline:X'), T0).item;
    assert.equal(gate.notify({ kind: 'item', itemId: disabled.id }, T0), 'held');
    patchCompanionSettings({ enabled: true });

    const snoozed = upsertItem(draft('pipeline:Z'), T0).item;
    applyItemAction(snoozed.id, { action: 'snooze', until: T0 + HOUR }, T0);
    assert.equal(gate.notify({ kind: 'item', itemId: snoozed.id }, T0), 'dropped');
    assert.equal(notifiedVersionOf(snoozed.id), null, 'it notifies when the snooze runs out');
    const dismissed = upsertItem(draft('pipeline:Y'), T0).item;
    applyItemAction(dismissed.id, { action: 'dismiss' }, T0);
    assert.equal(gate.notify({ kind: 'item', itemId: dismissed.id }, T0), 'dropped');
    gate.flush(T0, { force: true });
    assert.equal(notices.length, 0);
  });

  test('at most two notices in any half hour and twelve a day; the rest are held for the brief', () => {
    const send = (key: string, at: number) => {
      const { item } = upsertItem(draft(key), at);
      gate.processItems(at);
      return { item, notice: gate.processItems(at + COMPANION_COALESCE_MS) };
    };
    assert.ok(send('pipeline:1', T0).notice);
    assert.ok(send('pipeline:2', T0 + MINUTE).notice);
    const third = send('pipeline:3', T0 + 2 * MINUTE);
    assert.equal(third.notice, null);
    assert.equal(notifiedVersionOf(third.item.id), 'v1', 'held, never sent later');
    assert.ok(send('pipeline:4', T0 + 31 * MINUTE).notice, 'the half hour moved on');
    assert.equal(notices.length, 3);

    for (let index = 0; index < 9; index++) insertNotice({ title: 'C', body: 'b', target: { kind: 'companion', tab: 'chat' }, itemIds: [], now: T0 + 3 * HOUR + index });
    assert.equal(send('pipeline:5', T0 + 5 * HOUR).notice, null, 'twelve today already');
  });

  test('a Michi conversation the user already handled is not notified: on screen, or viewed since it changed', () => {
    const escalate = (nodeId: string) => {
      const { item } = upsertItem(michi(nodeId, { severity: 'now' }), T0);
      return { item, result: gate.notify({ kind: 'item', itemId: item.id }, T0 + MINUTE) };
    };
    visible.add('n-visible');
    assert.equal(escalate('n-visible').result, 'held');
    viewed.set('n-viewed', T0 + 1);
    assert.equal(escalate('n-viewed').result, 'held');
    viewed.set('n-before', T0 - 1);
    assert.equal(escalate('n-before').result, 'queued');
    const notice = gate.flush(T0 + 2 * MINUTE);
    assert.ok(notice);
    assert.deepEqual(notice.target, { kind: 'node', workspaceId: 'ws', nodeId: 'n-before' }, 'one conversation: it opens');
  });

  test('a conversation unanswered for 30 minutes gets one reminder; a baseline or viewed one gets none', () => {
    const waiting = upsertItem(michi('n-1'), T0).item;
    upsertItem(michi('n-baseline'), T0, { baseline: true });
    const seen = upsertItem(michi('n-seen'), T0).item;
    viewed.set('n-seen', T0 + 5 * MINUTE);
    assert.equal(gate.processItems(T0 + 29 * MINUTE), null);
    assert.deepEqual(gate.pendingItemIds(), []);
    gate.processItems(T0 + 30 * MINUTE);
    assert.deepEqual(gate.pendingItemIds(), [waiting.id]);
    assert.equal(notifiedVersionOf(seen.id), 'v1:escalated', 'handled: held');
    const notice = gate.processItems(T0 + 30 * MINUTE + COMPANION_COALESCE_MS);
    assert.ok(notice);
    assert.equal(notice.body, 'Chat n-1 has been waiting 30 min — Asked: Ship it?');
    assert.deepEqual(notice.target, { kind: 'node', workspaceId: 'ws', nodeId: 'n-1' });
    assert.equal(notifiedVersionOf(waiting.id), 'v1:escalated');
    gate.processItems(T0 + 2 * HOUR);
    gate.processItems(T0 + 2 * HOUR + COMPANION_COALESCE_MS);
    assert.equal(notices.length, 1, 'once per version');

    upsertItem(michi('n-1', { version: 'v2' }), T0 + 3 * HOUR);
    gate.processItems(T0 + 3 * HOUR + 30 * MINUTE);
    assert.ok(gate.processItems(T0 + 3 * HOUR + 31 * MINUTE), 'a new wait gets its own reminder');
  });

  test('Companion replies: which turns notify, never while the panel is focused, once per run', () => {
    const spoke = (runId: string, runKind: Parameters<CompanionNoticeGate['companionSpoke']>[0]['runKind'], itemIds: string[] = []) => {
      const before = notices.length;
      gate.companionSpoke({ runId, runKind, itemIds });
      return notices.length - before;
    };
    const urgent = upsertItem(draft('cr:1:mine', { source: 'cr', subtype: 'cr_needs_attention' }), T0).item;
    assert.equal(spoke('r-1', 'heartbeat', [urgent.id]), 1);
    assert.deepEqual([notices[0]!.title, notices[0]!.body, notices[0]!.target, notices[0]!.itemIds],
      ['Michi', 'Michi: cr:1:mine is blocked', { kind: 'companion', tab: 'chat' }, []]);
    assert.equal(spoke('r-1', 'heartbeat'), 0, 'once per run: the runner and the coordinator may both report it');
    assert.equal(spoke('r-2', 'welcome'), 0, 'the welcome is what the user just asked for');
    assert.equal(spoke('r-3', 'catch_up'), 0);
    assert.equal(spoke('r-4', 'brief'), 0, 'the brief only at level all');
    patchCompanionSettings({ notifications: 'all' });
    clockNow = T0 + 40 * MINUTE;
    assert.equal(spoke('r-5', 'brief'), 1);
    focused = true;
    assert.equal(spoke('r-6', 'worker_report'), 0, 'the panel is focused: the user sees it');
    focused = false;
    clockNow = T0 + 80 * MINUTE;
    assert.equal(spoke('r-8', 'worker_report'), 1);
  });

  test('a check-in reply\'s notice never carries its text: its run\'s item titles, three and how many more, else "<name> has an update"', () => {
    patchCompanionSettings({ displayName: 'Nova', notifications: 'all' });
    const digest = upsertItem(draft('pipeline:D', { severity: 'digest' }), T0).item;
    const urgent = ['A', 'B', 'C', 'E', 'F'].map((key) => upsertItem(draft(`pipeline:${key}`, key === 'C' ? { title: `C ${'x'.repeat(100)}` } : {}), T0).item);
    const muted = upsertItem(draft('pipeline:M'), T0).item;
    applyItemAction(muted.id, { action: 'mute' }, T0);
    const email = upsertItem(draft('email:1', { source: 'email', subtype: 'email_unread', title: 'Re: salary review' }), T0).item;
    patchCompanionSettings({ sources: { email: { enabled: false } } });
    const reply = (runId: string, runKind: 'heartbeat' | 'wake' | 'brief' | 'worker_report', itemIds: string[], at: number) => {
      assert.equal(gate.notify({ kind: 'message', runId, runKind, itemIds }, at), 'sent', runId);
      return notices.at(-1)!;
    };

    const many = reply('r-many', 'heartbeat', [digest.id, muted.id, email.id, ...urgent.map((item) => item.id)], T0);
    assert.deepEqual([many.title, many.body, many.target, many.itemIds],
      ['Nova', `Nova: pipeline:A is blocked · pipeline:B is blocked · C ${'x'.repeat(57)}… +3`, { kind: 'companion', tab: 'chat' }, []],
      'items rated now first, each title clipped; never a muted item or one of a source turned off');
    assert.equal(reply('r-none', 'worker_report', [], T0 + 31 * MINUTE).body, 'Nova has an update');
    assert.equal(reply('r-hidden', 'brief', [muted.id, email.id], T0 + 62 * MINUTE).body, 'Nova has an update');
    gate.expectReply('r-started', [urgent[1]!.id]);
    assert.equal(reply('r-started', 'wake', [], T0 + 93 * MINUTE).body, 'Nova: pipeline:B is blocked', 'the items the run started with');
    assert.doesNotMatch(JSON.stringify(notices), /salary/);
  });

  test('at level important a heartbeat or wake reply notifies only when it is about an interrupting item; at all, every one does (B19)', () => {
    const reply = (runId: string, runKind: 'heartbeat' | 'wake', itemIds: string[]) => gate.notify({ kind: 'message', runId, runKind, itemIds }, clockNow);
    const waiting = upsertItem(michi('n-wait'), T0).item;
    const review = upsertItem(draft('cr:R:review', { source: 'cr', subtype: 'cr_review_requested', severity: 'digest' }), T0).item;
    assert.equal(reply('r-digest', 'heartbeat', [waiting.id, review.id]), 'dropped', 'digest items only: Today and the brief have them');
    assert.equal(reply('r-nothing', 'heartbeat', []), 'dropped', 'about no item at all (a goal)');
    demoteSubtype('pipeline_blocked', T0);
    const demoted = upsertItem(draft('pipeline:D'), T0).item;
    assert.equal(reply('r-demoted', 'wake', [demoted.id]), 'dropped', 'a subtype the user\'s feedback demoted is digest now');
    const gone = upsertItem(draft('cr:G:mine', { source: 'cr', subtype: 'cr_needs_attention' }), T0).item;
    resolveItems([gone.id], T0);
    assert.equal(reply('r-gone', 'wake', [gone.id]), 'dropped', 'no longer open');
    const urgent = upsertItem(draft('cr:U:mine', { source: 'cr', subtype: 'cr_needs_attention' }), T0).item;
    assert.equal(reply('r-urgent', 'heartbeat', [waiting.id, urgent.id]), 'sent', 'one item that interrupts is enough');
    patchCompanionSettings({ sources: { cr: { enabled: false } } });
    assert.equal(reply('r-hidden', 'wake', [urgent.id]), 'dropped', 'out of sight: its source is off');
    clockNow = T0 + 40 * MINUTE;
    patchCompanionSettings({ sources: { cr: { enabled: true } }, notifications: 'all' });
    assert.equal(reply('r-all', 'heartbeat', [waiting.id]), 'sent', 'at level all a check-in reply notifies as before');
    assert.equal(reply('r-all-none', 'heartbeat', []), 'sent');
    assert.deepEqual(notices.map((notice) => notice.target), [{ kind: 'companion', tab: 'chat' }, { kind: 'companion', tab: 'chat' }, { kind: 'companion', tab: 'chat' }]);
  });

  test('an item of a source the user turned off counts as gone: it leaves the batch unmarked and is not notified (B15)', () => {
    const email = upsertItem(draft('email:1', { source: 'email', subtype: 'email_unread', title: 'Email from Alice', summary: 'Salary review' }), T0).item;
    const conflict = upsertItem(draft('calendar:conflict:1', { source: 'calendar', subtype: 'calendar_conflict' }), T0).item;
    gate.processItems(T0);
    assert.deepEqual(gate.pendingItemIds().sort(), [email.id, conflict.id].sort());
    patchCompanionSettings({ sources: { email: { enabled: false }, calendar: { enabled: false } } });
    assert.equal(gate.flush(T0 + COMPANION_COALESCE_MS), null);
    assert.equal(notices.length, 0);
    assert.deepEqual([notifiedVersionOf(email.id), notifiedVersionOf(conflict.id)], [null, null], 'gone, not used up');
    assert.equal(gate.notify({ kind: 'item', itemId: email.id }, T0 + MINUTE), 'dropped');
    gate.processItems(T0 + 2 * MINUTE);
    assert.deepEqual(gate.pendingItemIds(), []);
    assert.equal(notifiedVersionOf(email.id), null);
    assert.deepEqual([getItem(email.id)!.status, getItem(conflict.id)!.status], ['new', 'new'], 'nor resolved: only out of sight');
  });

  test('a wake reply about items notified in the last ten minutes needs no notice of its own', () => {
    const { item } = upsertItem(draft('pipeline:A'), T0);
    gate.processItems(T0);
    gate.processItems(T0 + COMPANION_COALESCE_MS);
    assert.equal(notices.length, 1);
    const fresh = upsertItem(draft('pipeline:B', { severity: 'digest' }), T0).item;
    gate.expectReply('r-wake', [item.id]);
    assert.equal(gate.notify({ kind: 'message', runId: 'r-wake', runKind: 'wake', itemIds: [] }, T0 + 2 * MINUTE), 'dropped',
      'the item ids come from the turn it started with');
    assert.equal(gate.notify({ kind: 'message', runId: 'r-wake-2', runKind: 'wake', itemIds: [item.id, fresh.id] }, T0 + 3 * MINUTE), 'sent');
    assert.equal(gate.notify({ kind: 'message', runId: 'r-wake-3', runKind: 'wake', itemIds: [item.id] }, T0 + 15 * MINUTE), 'dropped',
      'two notices in this half hour already');
  });

  test('a delegated conversation that finished on a used-up budget: "Worker finished", unless it is on screen', () => {
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-w', title: 'Fix the flaky test' }, T0), 'sent');
    assert.deepEqual([notices[0]!.body, notices[0]!.target], ['Worker finished: Fix the flaky test', { kind: 'node', workspaceId: 'ws', nodeId: 'n-w' }]);
    visible.add('n-v');
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-v', title: 'Other' }, T0 + MINUTE), 'held');
  });

  test('a "Worker finished" notice the gate holds back says so (held), so the caller knows nothing went out', () => {
    const saturday = new Date(2026, 10, 7, 12, 0, 0, 0).getTime();
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-1', title: 'Weekend work' }, saturday), 'held', 'an off day');
    patchCompanionSettings({ notifications: 'off' });
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-2', title: 'Muted' }, T0), 'held', 'notifications off');
    patchCompanionSettings({ notifications: 'important' });
    for (let index = 0; index < 2; index++) insertNotice({ title: 'C', body: 'b', target: { kind: 'companion', tab: 'chat' }, itemIds: [], now: T0 + index });
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-3', title: 'Capped' }, T0 + MINUTE), 'held', 'two in this half hour');
    assert.equal(notices.length, 0);
  });

  describe('a reminder the user set (R2.9) that comes due in quiet hours or on an off day', () => {
    const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
    const reminder = (key: string, when: number) => upsertItem(draft(`reminder:${key}`, {
      source: 'system', subtype: 'reminder_due', version: `at:${when}`, title: 'Call home', summary: 'Your reminder for 21:00',
      target: { kind: 'companion', tab: 'today' }, observedAt: when,
    }), when).item;

    test('waits for the window instead of being held, and goes out once it opens', () => {
      const night = reminder('night', at(5, 21));
      assert.equal(gate.notify({ kind: 'item', itemId: night.id }, at(5, 21)), 'deferred');
      assert.equal(notifiedVersionOf(night.id), null, 'not counted as notified');
      gate.processItems(at(5, 21));
      gate.processItems(at(5, 21) + COMPANION_COALESCE_MS);
      gate.processItems(at(6, 7, 59));
      assert.equal(notices.length, 0, 'never in quiet hours');
      gate.processItems(at(6, 8, 0));
      const notice = gate.processItems(at(6, 8, 0) + COMPANION_COALESCE_MS);
      assert.ok(notice, 'the first ticks after 08:00 send it');
      assert.deepEqual([notice.body, notice.itemIds], ['Call home — Your reminder for 21:00', [night.id]]);
      assert.equal(notifiedVersionOf(night.id), night.version);
      gate.processItems(at(6, 9, 0));
      gate.processItems(at(6, 9, 1));
      assert.equal(notices.length, 1, 'once');
    });

    test('one already in the batch when quiet hours begin waits too; one due on Saturday goes out on Monday morning', () => {
      const late = reminder('late', at(6, 19, 59));
      gate.processItems(at(6, 19, 59));
      assert.deepEqual(gate.pendingItemIds(), [late.id], 'Friday 19:59: queued');
      assert.equal(gate.flush(at(6, 20, 1)), null, 'the batch flushes after 20:00');
      assert.equal(notifiedVersionOf(late.id), null, 'and does not use it up');
      const weekend = reminder('saturday', at(7, 10));
      gate.processItems(at(7, 10));
      gate.processItems(at(8, 12));
      assert.equal(notices.length, 0, 'not on the weekend');
      assert.equal(notifiedVersionOf(weekend.id), null);
      gate.processItems(at(9, 8, 0));
      const notice = gate.processItems(at(9, 8, 0) + COMPANION_COALESCE_MS);
      assert.ok(notice, 'Monday 08:00');
      assert.deepEqual(notice.itemIds.sort(), [weekend.id, late.id].sort(), 'both, as one notice');
    });

    test('off, paused, notifications off or before the welcome: held as any item, so nothing old bursts out later', () => {
      clearCompanionWelcomeDone();
      const early = reminder('early', at(5, 21));
      assert.equal(gate.notify({ kind: 'item', itemId: early.id }, at(5, 21)), 'held');
      markCompanionWelcomeDone(T0 - DAY);
      patchCompanionSettings({ notifications: 'off' });
      const muted = reminder('muted', at(5, 21, 5));
      assert.equal(gate.notify({ kind: 'item', itemId: muted.id }, at(5, 21, 5)), 'held');
      patchCompanionSettings({ notifications: 'important' });
      gate.processItems(at(6, 8, 0));
      gate.processItems(at(6, 8, 1));
      assert.equal(notices.length, 0);
      const pipeline = upsertItem(draft('pipeline:night'), at(5, 22)).item;
      assert.equal(gate.notify({ kind: 'item', itemId: pipeline.id }, at(5, 22)), 'held', 'an item the user did not set still waits for the brief');
    });
  });

  describe('a calendar conflict about to start (engine F2)', () => {
    const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
    /** The calendar source's two-hour version: needs you, now, with the overlap's times in its facts. */
    const conflict = (key: string, start: number, when: number) => upsertItem(draft(`calendar:conflict:${key}`, {
      source: 'calendar', subtype: 'calendar_conflict', version: `${start}+${start + 30 * MINUTE}:soon`,
      title: 'Calendar conflict at 09:30', summary: 'Standup overlaps Demo', target: null,
      facts: { overlapStart: start, overlapEnd: start + 30 * MINUTE, overlapMinutes: 30, untrustedText: true }, observedAt: when,
    }), when).item;

    test('due in the morning\'s quiet hours, it waits, goes out once at the first tick after 08:00, and goes stale when the overlap starts', () => {
      const start = at(6, 9, 30);
      const item = conflict('a', start, at(6, 7, 30));
      assert.equal(gate.notify({ kind: 'item', itemId: item.id }, at(6, 7, 30)), 'deferred');
      for (let tick = at(6, 7, 30); tick < at(6, 8, 0); tick += 5 * MINUTE) gate.processItems(tick);
      assert.equal(notices.length, 0, 'never in quiet hours');
      assert.equal(notifiedVersionOf(item.id), null, 'and not used up by them');
      gate.processItems(at(6, 8, 0));
      const notice = gate.processItems(at(6, 8, 0) + COMPANION_COALESCE_MS);
      assert.ok(notice, 'the first ticks after 08:00 send it');
      assert.deepEqual([notice.body, notice.itemIds, notice.expiresAt], ['Calendar conflict at 09:30 — Standup overlaps Demo', [item.id], start],
        'a meeting\'s notice is stale once the meeting starts (R2.7)');
      for (let tick = at(6, 8, 5); tick < at(6, 9, 20); tick += 5 * MINUTE) gate.processItems(tick);
      assert.equal(notices.length, 1, 'exactly one');
    });

    test('first seen after quiet hours, it goes out at once, also exactly once', () => {
      const item = conflict('b', at(6, 9, 30), at(6, 8, 10));
      gate.processItems(at(6, 8, 10));
      assert.ok(gate.processItems(at(6, 8, 10) + COMPANION_COALESCE_MS));
      gate.processItems(at(6, 8, 15));
      gate.processItems(at(6, 8, 20));
      assert.equal(notices.length, 1);
      assert.equal(notifiedVersionOf(item.id), item.version);
    });

    test('one whose overlap has started is held in quiet hours like any item', () => {
      const item = conflict('c', at(5, 21, 0), at(5, 21, 5));
      assert.equal(gate.notify({ kind: 'item', itemId: item.id }, at(5, 21, 5)), 'held');
      assert.equal(notifiedVersionOf(item.id), item.version);
    });
  });

  test('a conversation\'s chat notices never use up the Companion\'s caps (DESIGN-v2 §5.2)', () => {
    for (let index = 0; index < 12; index++) {
      enqueueCompanionNotice({ title: 'Fix the build', body: 'Needs your approval', target: { kind: 'node', workspaceId: 'ws', nodeId: 'n-9' }, itemIds: [], channel: 'chat' },
        T0 - 10 * MINUTE + index, { bus });
    }
    assert.equal(notices.length, 12);
    const { item } = upsertItem(draft('pipeline:A'), T0);
    gate.processItems(T0);
    const notice = gate.processItems(T0 + COMPANION_COALESCE_MS);
    assert.ok(notice, 'twelve chat notices today, two in this half hour, and the item still goes out');
    assert.deepEqual(notice.itemIds, [item.id]);
    assert.equal(notice.channel, undefined, 'the Companion\'s own notice says no channel');
  });

  test('a notifier that connects gets the Companion\'s backlog folded and the newest conversations\' notices one by one', () => {
    const a = upsertItem(draft('pipeline:A'), T0).item;
    const b = upsertItem(draft('pipeline:B'), T0).item;
    enqueueCompanionNotice({ title: 'Michi', body: 'A is blocked', target: { kind: 'companion', tab: 'today' }, itemIds: [a.id] }, T0, { bus });
    enqueueCompanionNotice({ title: 'Michi', body: 'B is blocked', target: { kind: 'companion', tab: 'today' }, itemIds: [b.id] }, T0 + 1, { bus });
    const chats = [0, 1, 2, 3].map((index) => enqueueCompanionNotice({
      title: `Chat ${index}`, body: 'Has a question: Ship it?', target: { kind: 'node', workspaceId: 'ws', nodeId: `n-${index}` }, itemIds: [], channel: 'chat',
    }, T0 + 2 + index, { bus })!);
    assert.deepEqual(chats.map((notice) => notice.channel), ['chat', 'chat', 'chat', 'chat'], 'published with its channel');
    const replay = replayCompanionNotices(T0 + MINUTE);
    assert.equal(replay.length, 1 + CHAT_NOTICE_REPLAY_MAX);
    assert.equal(replay[0]!.body, companionBacklogBody(2), 'only the Companion\'s own are folded');
    assert.equal(replay[0]!.channel, undefined);
    assert.deepEqual(replay.slice(1).map((notice) => [notice.id, notice.channel]), chats.slice(1).map((notice) => [notice.id, 'chat']),
      'the newest three, each as stored, channel included');
    assert.ok(!pendingNotices(T0 + MINUTE).some((notice) => notice.id === chats[0]!.id), 'the oldest counts as delivered');
  });

  test('a heartbeat reply only about items a notice just covered, or is about to, needs none of its own', () => {
    const { item } = upsertItem(draft('pipeline:A'), T0);
    gate.processItems(T0);
    gate.expectReply('r-heartbeat', [item.id]);
    assert.equal(gate.notify({ kind: 'message', runId: 'r-heartbeat', runKind: 'heartbeat', itemIds: [] }, T0 + 5_000), 'dropped',
      'the item waits in the batch: its own notice is coming');
    assert.ok(gate.processItems(T0 + COMPANION_COALESCE_MS));
    assert.equal(gate.notify({ kind: 'message', runId: 'r-heartbeat-2', runKind: 'heartbeat', itemIds: [item.id] }, T0 + 2 * MINUTE), 'dropped',
      'notified two minutes ago');
    const digest = upsertItem(draft('pipeline:D', { severity: 'digest' }), T0).item;
    assert.equal(gate.notify({ kind: 'message', runId: 'r-heartbeat-3', runKind: 'heartbeat', itemIds: [item.id, digest.id] }, T0 + 3 * MINUTE), 'sent',
      'one item no notice told the user about');
    assert.equal(notices.length, 2);
  });

  test('a conversation reply\'s notice text (chatNotices.ts) is its first paragraph, plain, without sentinels', () => {
    assert.equal(noticeExcerpt('## Heads up\n**Gamma** is `blocked`.\n\nSecond paragraph'), 'Heads up Gamma is blocked.');
    assert.equal(noticeExcerpt('[FOLLOW-UPS: a | b]'), '');
    assert.equal(noticeExcerpt(`${'x'.repeat(300)}`).length, 140);
    // A lead-in goes on into what it leads to, up to the limit (W4 failure 7: "Michi replied — It printed:").
    assert.equal(noticeExcerpt('It printed:\n\n```\nw4-no-window\n```\n\nAnything else?'), 'It printed: w4-no-window');
    assert.equal(noticeExcerpt('Done.\n\nMerged **CR-1** and started the deploy.\n\nNext: the pipeline.'), 'Done. Merged CR-1 and started the deploy.');
    assert.equal(noticeExcerpt('Here is what I found:\n\n- a\n\n- b'), 'Here is what I found: a', 'only while it still reads as a lead-in');
    const long = noticeExcerpt(`Results:\n\n${'word '.repeat(60)}\n\nMore after it.`);
    assert.ok(long.length <= 140, String(long.length));
    assert.match(long, /^Results: word word .*…$/);
    assert.equal(noticeExcerpt('All green.\n\nDetails follow.'), 'All green.', 'a sentence of its own stays alone');
    assert.equal(noticeExcerpt('部署已经完成，所有检查都通过了。\n\n细节如下。'), '部署已经完成，所有检查都通过了。', 'so does one written without spaces');
    assert.equal(noticeExcerpt('好的。\n\n已经合并了 CR-1。'), '好的。 已经合并了 CR-1。');
  });
});
