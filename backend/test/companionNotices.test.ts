import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * What Michi hands the attention service (notices.ts CompanionNotices, DESIGN
 * P4): nothing before the first welcome or while paused; only interrupting items, never digest, silent or a
 * demoted subtype; the already-handled check of Michi conversations; one
 * Needs you per item version, at once and whatever the hour (no quiet hours,
 * workdays, caps or batch, Q7); the one 30-minute reminder of a conversation
 * waiting on the user; where a record opens (an item at its Today row, a
 * conversation itself); items of a source turned off counting as gone; records
 * whose item no longer holds resolving; Michi's posts (which turns, never
 * while the panel is focused, a check-in about items just notified, once per
 * run, and never their text) and a finished delegation. No level of Michi's
 * own: the user's one level (Settings › Notifications) is applied where the
 * records are shown. Temp MICHI_DATA_DIR per test; times are explicit.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { CompanionNotices } from '../src/services/companion/notices';
import {
  applyItemAction,
  clearCompanionWelcomeDone,
  demoteSubtype,
  getItem,
  markCompanionWelcomeDone,
  notifiedVersionOf,
  resolveItems,
  upsertItem,
} from '../src/services/companion/repository';
import { patchCompanionSettings } from '../src/services/companion/settings';
import type { ItemDraft } from '../src/services/companion/types';
import { captureCompanionAttention, type CapturedCompanionNotice, type CompanionAttentionCapture } from './helpers/companionAttention';
import { turnCompanionOn } from './helpers/backgroundWork';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Thursday 2026-11-05, 12:00 local. */
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

describe("Michi's notices", () => {
  let tmpDir: string;
  let capture: CompanionAttentionCapture;
  let notices: CapturedCompanionNotice[];
  let focused: boolean;
  let visible: Set<string>;
  let viewed: Map<string, number>;
  let gate: CompanionNotices;
  let clockNow: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-notices-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    // Michi is off until the user turns it on: these notices are of a Michi that runs.
    turnCompanionOn();
    capture = captureCompanionAttention();
    notices = capture.notices;
    focused = false;
    visible = new Set();
    viewed = new Map();
    clockNow = T0;
    gate = new CompanionNotices({
      clock: { now: () => clockNow }, isPanelFocused: () => focused,
      isPaneVisible: (nodeId) => visible.has(nodeId), nodeViewedAt: (nodeId) => viewed.get(nodeId) ?? null,
    });
    markCompanionWelcomeDone(T0 - DAY);
  });

  afterEach(() => {
    capture.restore();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nothing goes out before the first welcome, and what came in then never bursts out after it', () => {
    clearCompanionWelcomeDone();
    const { item } = upsertItem(draft('pipeline:A'), T0);
    assert.equal(gate.processItems(T0), 0);
    assert.equal(notices.length, 0);
    assert.equal(notifiedVersionOf(item.id), 'v1', 'held: counted as notified');
    markCompanionWelcomeDone(T0 + MINUTE);
    gate.processItems(T0 + 2 * MINUTE);
    assert.equal(notices.length, 0);
  });

  test('an interrupting item is a Needs you at once, once per version, opening at its Today row', () => {
    const { item } = upsertItem(draft('pipeline:A'), T0);
    assert.equal(gate.processItems(T0), 1);
    const [notice] = notices;
    assert.deepEqual([notice!.key, notice!.fact, notice!.kind, notice!.reason, notice!.title, notice!.body, notice!.target],
      [`agent:item:${item.id}`, 'item:v1', 'needs_input', 'needs_you', 'Michi', 'pipeline:A is blocked — Prod failed',
        { kind: 'companion', tab: 'today', itemId: item.id }],
      'an item that is no conversation opens Today at its row (A10), whatever its own link');
    assert.equal(notice!.isCurrent?.(), true);
    assert.equal(notifiedVersionOf(item.id), 'v1');
    gate.processItems(T0 + MINUTE);
    assert.equal(notices.length, 1, 'once per version');
    upsertItem(draft('pipeline:A', { version: 'v2', summary: 'Still failing' }), T0 + 2 * MINUTE);
    gate.processItems(T0 + 2 * MINUTE);
    assert.deepEqual(notices.map((each) => each.fact), ['item:v1', 'item:v2']);
  });

  test('at night and on a Saturday too: no quiet hours, no workdays, no caps (Q7)', () => {
    const at = (hour: number, day = 5) => new Date(2026, 10, day, hour, 0, 0, 0).getTime();
    upsertItem(draft('pipeline:Q'), at(23));
    gate.processItems(at(23));
    upsertItem(draft('pipeline:W'), at(12, 7));
    gate.processItems(at(12, 7));
    for (let index = 0; index < 14; index++) upsertItem(draft(`pipeline:${index}`), at(13, 7) + index);
    gate.processItems(at(13, 7) + 20);
    assert.equal(notices.length, 16);
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

  test('paused holds them; snoozed and dismissed items are not open', () => {
    patchCompanionSettings({ paused: true });
    const paused = upsertItem(draft('pipeline:P'), T0).item;
    assert.equal(gate.notify({ kind: 'item', itemId: paused.id }, T0), 'held');
    patchCompanionSettings({ paused: false });
    const snoozed = upsertItem(draft('pipeline:Z'), T0).item;
    applyItemAction(snoozed.id, { action: 'snooze', until: T0 + HOUR }, T0);
    assert.equal(gate.notify({ kind: 'item', itemId: snoozed.id }, T0), 'dropped');
    assert.equal(notifiedVersionOf(snoozed.id), null, 'it notifies when the snooze runs out');
    const dismissed = upsertItem(draft('pipeline:Y'), T0).item;
    applyItemAction(dismissed.id, { action: 'dismiss' }, T0);
    assert.equal(gate.notify({ kind: 'item', itemId: dismissed.id }, T0), 'dropped');
    assert.equal(notices.length, 0);
  });

  test('a record goes once its item is resolved, dismissed, out of sight or changed; it is no longer current when decided then', () => {
    const a = upsertItem(draft('pipeline:A'), T0).item;
    const b = upsertItem(draft('pipeline:B'), T0).item;
    const c = upsertItem(draft('email:1', { source: 'email', subtype: 'email_unread' }), T0).item;
    const d = upsertItem(draft('pipeline:D'), T0).item;
    gate.processItems(T0);
    assert.equal(capture.active.size, 4);
    resolveItems([a.id], T0 + MINUTE);
    applyItemAction(b.id, { action: 'dismiss' }, T0 + MINUTE);
    patchCompanionSettings({ sources: { email: { enabled: false } } });
    upsertItem(draft('pipeline:D', { version: 'v2', severity: 'digest' }), T0 + MINUTE);
    assert.equal(notices.find((notice) => notice.key === `agent:item:${a.id}`)!.isCurrent?.(), false);
    gate.processItems(T0 + 2 * MINUTE);
    assert.deepEqual(capture.resolved.sort(), [a.id, b.id, c.id, d.id].map((id) => `agent:item:${id}`).sort());
    assert.equal(capture.active.size, 0);
    assert.equal(notices.length, 4, 'a digest version says nothing new');
  });

  test('a Michi conversation the user already handled is not notified: on screen, or viewed since it changed', () => {
    const escalate = (nodeId: string) => {
      const { item } = upsertItem(michi(nodeId, { severity: 'now' }), T0);
      return gate.notify({ kind: 'item', itemId: item.id }, T0 + MINUTE);
    };
    visible.add('n-visible');
    assert.equal(escalate('n-visible'), 'held');
    viewed.set('n-viewed', T0 + 1);
    assert.equal(escalate('n-viewed'), 'held');
    viewed.set('n-before', T0 - 1);
    assert.equal(escalate('n-before'), 'sent');
    assert.deepEqual(notices.map((notice) => notice.target), [{ kind: 'node', workspaceId: 'ws', nodeId: 'n-before' }], 'a conversation opens itself');
    visible.add('n-before');
    assert.equal(notices[0]!.isCurrent?.(), false, 'on screen by the time it is decided: handled');
  });

  test('a conversation unanswered for 30 minutes gets one reminder; a baseline or viewed one gets none', () => {
    const waiting = upsertItem(michi('n-1'), T0).item;
    upsertItem(michi('n-baseline'), T0, { baseline: true });
    const seen = upsertItem(michi('n-seen'), T0).item;
    viewed.set('n-seen', T0 + 5 * MINUTE);
    assert.equal(gate.processItems(T0 + 29 * MINUTE), 0);
    assert.equal(gate.processItems(T0 + 30 * MINUTE), 1);
    assert.equal(notifiedVersionOf(seen.id), 'v1:escalated', 'handled: held');
    assert.deepEqual([notices[0]!.body, notices[0]!.target, notices[0]!.fact],
      ['Chat n-1 has been waiting 30 min — Asked: Ship it?', { kind: 'node', workspaceId: 'ws', nodeId: 'n-1' }, 'item:v1:escalated']);
    assert.equal(notifiedVersionOf(waiting.id), 'v1:escalated');
    gate.processItems(T0 + 2 * HOUR);
    assert.equal(notices.length, 1, 'once per version');
    assert.equal(capture.active.has(`agent:item:${waiting.id}`), true, 'the reminder holds while the conversation still waits');
    upsertItem(michi('n-1', { version: 'v2' }), T0 + 3 * HOUR);
    assert.equal(gate.processItems(T0 + 3 * HOUR + 31 * MINUTE), 1, 'a new wait gets its own reminder');
  });

  test('Michi\'s posts: which turns notify, never while the panel is focused, once per run', () => {
    const spoke = (runId: string, runKind: Parameters<CompanionNotices['companionSpoke']>[0]['runKind'], itemIds: string[] = []) => {
      const before = notices.length;
      gate.companionSpoke({ runId, runKind, itemIds });
      return notices.length - before;
    };
    const urgent = upsertItem(draft('cr:1:mine', { source: 'cr', subtype: 'cr_needs_attention' }), T0).item;
    assert.equal(spoke('r-1', 'heartbeat', [urgent.id]), 1);
    assert.deepEqual([notices[0]!.key, notices[0]!.fact, notices[0]!.kind, notices[0]!.reason, notices[0]!.title, notices[0]!.body, notices[0]!.target],
      ['agent:chat', 'post:r-1', 'finished', 'update', 'Michi', 'Michi: cr:1:mine is blocked', { kind: 'companion', tab: 'chat' }]);
    assert.equal(spoke('r-1', 'heartbeat'), 0, 'once per run: the runner and the coordinator may both report it');
    assert.equal(spoke('r-2', 'welcome'), 0, 'the welcome is what the user just asked for');
    assert.equal(spoke('r-3', 'catch_up'), 0);
    assert.equal(spoke('r-5', 'brief'), 1, 'the brief is an update: the user\'s level All shows it');
    focused = true;
    assert.equal(spoke('r-6', 'worker_report'), 0, 'the panel is focused: the user sees it');
    focused = false;
    assert.equal(spoke('r-8', 'worker_report'), 1);
    patchCompanionSettings({ paused: true });
    assert.equal(spoke('r-9', 'worker_report'), 0, 'paused');
  });

  test('a post\'s notice never carries its text: its run\'s item titles, three and how many more, else "<name> has an update"', () => {
    patchCompanionSettings({ displayName: 'Nova' });
    const digest = upsertItem(draft('pipeline:D', { severity: 'digest' }), T0).item;
    const urgent = ['A', 'B', 'C', 'E', 'F'].map((key) => upsertItem(draft(`pipeline:${key}`, key === 'C' ? { title: `C ${'x'.repeat(100)}` } : {}), T0).item);
    const muted = upsertItem(draft('pipeline:M'), T0).item;
    applyItemAction(muted.id, { action: 'mute' }, T0);
    const email = upsertItem(draft('email:1', { source: 'email', subtype: 'email_unread', title: 'Re: salary review' }), T0).item;
    patchCompanionSettings({ sources: { email: { enabled: false } } });
    const reply = (runId: string, runKind: 'heartbeat' | 'wake' | 'brief' | 'worker_report', itemIds: string[]) => {
      assert.equal(gate.notify({ kind: 'message', runId, runKind, itemIds }, T0), 'sent', runId);
      return notices.at(-1)!;
    };
    const many = reply('r-many', 'heartbeat', [digest.id, muted.id, email.id, ...urgent.map((item) => item.id)]);
    assert.deepEqual([many.title, many.body], ['Nova', `Nova: pipeline:A is blocked · pipeline:B is blocked · C ${'x'.repeat(57)}… +3`],
      'items rated now first, each title clipped; never a muted item or one of a source turned off');
    assert.equal(reply('r-none', 'worker_report', []).body, 'Nova has an update');
    assert.equal(reply('r-hidden', 'brief', [muted.id, email.id]).body, 'Nova has an update');
    gate.expectReply('r-started', [urgent[1]!.id]);
    assert.equal(reply('r-started', 'wake', []).body, 'Nova: pipeline:B is blocked', 'the items the run started with');
    assert.doesNotMatch(JSON.stringify(notices), /salary/);
  });

  test('every check-in reply is an update, about digest items or none at all: the user\'s level decides where it shows', () => {
    const reply = (runId: string, runKind: 'heartbeat' | 'wake', itemIds: string[]) => gate.notify({ kind: 'message', runId, runKind, itemIds }, clockNow);
    const waiting = upsertItem(michi('n-wait'), T0).item;
    const review = upsertItem(draft('cr:R:review', { source: 'cr', subtype: 'cr_review_requested', severity: 'digest' }), T0).item;
    assert.equal(reply('r-digest', 'wake', [waiting.id, review.id]), 'sent');
    assert.equal(reply('r-nothing', 'wake', []), 'sent', 'about no item at all (a goal)');
    assert.deepEqual(notices.map((notice) => [notice.kind, notice.reason]), [['finished', 'update'], ['finished', 'update']],
      'shown at All, never at "Only when something needs me" (attentionLevelAllows)');
  });

  test('an item of a source the user turned off counts as gone: not notified, not used up (B15)', () => {
    const email = upsertItem(draft('email:1', { source: 'email', subtype: 'email_unread', title: 'Email from Alice', summary: 'Salary review' }), T0).item;
    patchCompanionSettings({ sources: { email: { enabled: false } } });
    assert.equal(gate.notify({ kind: 'item', itemId: email.id }, T0 + MINUTE), 'dropped');
    gate.processItems(T0 + 2 * MINUTE);
    assert.equal(notices.length, 0);
    assert.equal(notifiedVersionOf(email.id), null);
    assert.equal(getItem(email.id)!.status, 'new', 'nor resolved: only out of sight');
  });

  test('a check-in about items notified in the last ten minutes says nothing of its own', () => {
    const { item } = upsertItem(draft('pipeline:A'), T0);
    gate.processItems(T0);
    assert.equal(notices.length, 1);
    const fresh = upsertItem(draft('pipeline:B', { severity: 'digest' }), T0).item;
    gate.expectReply('r-wake', [item.id]);
    assert.equal(gate.notify({ kind: 'message', runId: 'r-wake', runKind: 'wake', itemIds: [] }, T0 + 2 * MINUTE), 'dropped',
      'the item ids come from the turn it started with');
    assert.equal(gate.notify({ kind: 'message', runId: 'r-wake-2', runKind: 'wake', itemIds: [item.id, fresh.id] }, T0 + 3 * MINUTE), 'sent');
    assert.equal(gate.notify({ kind: 'message', runId: 'r-wake-3', runKind: 'wake', itemIds: [item.id] }, T0 + 15 * MINUTE), 'sent',
      'ten minutes on, it may say so again');
  });

  test('a delegated conversation that finished: "<title> finished", opening it, unless it is on screen or Michi is paused', () => {
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-w', title: 'Fix the flaky test' }, T0), 'sent');
    assert.deepEqual([notices[0]!.key, notices[0]!.reason, notices[0]!.body, notices[0]!.target],
      ['agent:node:n-w', 'update', 'Fix the flaky test finished', { kind: 'node', workspaceId: 'ws', nodeId: 'n-w' }]);
    visible.add('n-v');
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-v', title: 'Other' }, T0 + MINUTE), 'held');
    patchCompanionSettings({ paused: true });
    assert.equal(gate.notify({ kind: 'worker_finished', workspaceId: 'ws', nodeId: 'n-2', title: 'Paused' }, T0), 'held', 'Michi paused');
    assert.equal(notices.length, 1);
  });

  test('without an attention service nothing is proposed, and item versions are still marked', () => {
    capture.restore();
    const { item } = upsertItem(draft('pipeline:A'), T0);
    assert.equal(gate.processItems(T0), 1);
    assert.equal(notices.length, 0);
    assert.equal(notifiedVersionOf(item.id), 'v1');
  });
});
