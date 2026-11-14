import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The Companion's storage: the item version rules of DESIGN §3.1 with R2.4
 * (created, same version, new version per status, muted, resolved and
 * reopened as it was, the two-poll resolution, snooze expiry, user actions
 * and a thumbs-down's effects), the event log cursor, runs and today's
 * budgeted turns, goals, cards (TTL, one decision, Apply / Dismiss through
 * cards.ts), briefs, the notice outbox (expiry, item validity, the backlog
 * fold) and its bus, delegations, the brief's focus, meta helpers, the
 * revision and the snapshot DTO. Polls and baselines: companionPolls.test.ts;
 * notes, rules, reminders, demotions, views and retention:
 * companionUserState.test.ts. Temp MICHI_DATA_DIR per test; times are
 * explicit.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_LIMITS,
  checkinNodeId,
  companionPostId,
  isOpenCompanionItem,
  type CompanionChangedEvent,
  type CompanionItemStatus,
  type MichiAssistantInfo,
} from 'michi-shared';
import { closeDb, getDb, initDb, runInTransaction } from '../src/services/db';
import { CompanionError } from '../src/services/companion/errors';
import {
  COMPANION_CARD_TTL_MS,
  COMPANION_OWNER,
  addGoal,
  editGoal,
  applyItemAction,
  briefForDate,
  bumpRevision,
  checkinRunSends,
  closeDelegation,
  companionTransaction,
  countOpenItems,
  countDeliveredSends,
  countPendingCards,
  countTurnsSince,
  currentRevision,
  decideCard,
  defaultCompanionStatus,
  deleteCompanionMeta,
  expireCards,
  failAppliedCard,
  failInterruptedRuns,
  finishRun,
  getBrief,
  getBriefCurate,
  getCard,
  getCompanionMeta,
  getCompanionMetaNumber,
  getDelegation,
  getFollowedDelegation,
  getGoal,
  getItem,
  getItemByKey,
  getRun,
  insertBrief,
  insertCard,
  isSubtypeDemoted,
  latestEventSeq,
  latestFinishedRun,
  leaveDelegationReplyToToday,
  listDelegationsSince,
  listEventsAfter,
  listGoals,
  listUntoldPosts,
  markPostsTold,
  listItemEvents,
  listOpenDelegations,
  listOpenItems,
  listPendingCards,
  listRunningRuns,
  listRuns,
  listUnnotifiedNowItems,
  listUnreportedCards,
  markCardsReported,
  markDelegationReported,
  markDelegationSent,
  markCompanionWelcomeDone,
  markItemsNotified,
  markItemsSeen,
  markRunDiscarded,
  notifiedVersionOf,
  parseCompanionTarget,
  pruneRuns,
  recordCheckinSend,
  recordDelegation,
  recordGoalProgress,
  recordRun,
  recordRunChange,
  recordRunPost,
  removeGoal,
  resolveItems,
  resolveMissing,
  setBriefCardFeedback,
  setBriefCurate,
  setCompanionMeta,
  setCompanionMetaNumber,
  setDelegationAutoSend,
  setNotesByUser,
  startSendRun,
  stopDelegationAutoSend,
  setRunCheckinNode,
  setRunTurnId,
  snapshotDto,
  setCompanionHeadline,
  companionHeadline,
  startRun,
  updateGoal,
  upsertItem,
  wakeSnoozedItems,
} from '../src/services/companion/repository';
import { applyCompanionCard, dismissCompanionCard, proposeCompanionCard } from '../src/services/companion/cards';
import { CompanionEventBus, encodeCompanionChangedEvent } from '../src/services/companion/delivery';
import { getCompanionSettings, patchCompanionSettings } from '../src/services/companion/settings';
import { localDayStart } from '../src/services/companion/clock';
import type { ItemDraft } from '../src/services/companion/types';
import { seedConversation } from './helpers/homeConversations';
import { turnCompanionOn } from './helpers/backgroundWork';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function draft(overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr',
    subtype: 'cr_needs_attention',
    itemKey: 'cr:CR-1:mine',
    version: 'v1',
    bucket: 'needs_you',
    severity: 'now',
    title: 'CR-1 needs attention',
    summary: '2 unresolved comments on revision 3',
    target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: { cr: 'CR-1', unresolved: 2, revision: 3 },
    observedAt: T0,
    ...overrides,
  };
}

const ASSISTANT: MichiAssistantInfo = {
  nodeId: 'n-companion', workspaceId: 'p-assistant-1', treeId: 't-companion',
  settings: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null },
  conversation: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null },
  conversationFollowsGlobal: true, supportedRuntimes: ['claude'], runtimeSwitches: [],
};

const eventKinds = (itemId: string) => listItemEvents(itemId, 50).reverse().map((event) => event.kind);
const companionError = (status: number, code: string) => (error: unknown) => {
  assert.ok(error instanceof CompanionError, String(error));
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
};

/** Two successful, complete polls in a row that do not report the object: it resolves (R2.4). */
function resolveByAbsence(source: ItemDraft['source'], present: string[], now: number): string[] {
  assert.deepEqual(resolveMissing(source, present, now), [], 'one absence only counts');
  return resolveMissing(source, present, now + 1);
}

/** An item brought to `status` by the user's own actions (or the source, for resolved). */
function itemIn(status: CompanionItemStatus, key: string): string {
  const { item } = upsertItem(draft({ itemKey: key }), T0);
  switch (status) {
    case 'new': break;
    case 'seen': markItemsSeen([item.id], T0 + 1); break;
    case 'snoozed': applyItemAction(item.id, { action: 'snooze', until: T0 + HOUR }, T0 + 1); break;
    case 'dismissed': applyItemAction(item.id, { action: 'dismiss' }, T0 + 1); break;
    case 'muted': applyItemAction(item.id, { action: 'mute' }, T0 + 1); break;
    case 'resolved': resolveItems([item.id], T0 + 1); break;
  }
  assert.equal(getItem(item.id)!.status, status);
  return item.id;
}

describe('Companion repository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-repository-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    turnCompanionOn();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the migration creates every Companion table, owned by the local agent owner', () => {
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    assert.deepEqual(tables, ['companion_briefs', 'companion_cards', 'companion_checkin_jobs', 'companion_checkin_shadow', 'companion_delegations',
      'companion_events', 'companion_goals', 'companion_items', 'companion_notices', 'companion_reminders', 'companion_run_changes', 'companion_runs', 'companion_snapshots']);
    assert.ok(getDb().prepare("SELECT 1 FROM schema_migrations WHERE version = '0081_companion'").get());
    assert.ok(getDb().prepare("SELECT 1 FROM schema_migrations WHERE version = '0082_companion_v2'").get(), 'v2 is purely additive (DESIGN-v2 §7)');
    assert.equal(COMPANION_OWNER, 'local-user');
    for (const table of tables) {
      const owner = (getDb().prepare(`SELECT dflt_value FROM pragma_table_info('${table}') WHERE name = 'owner_user_id'`).get() as { dflt_value: string }).dflt_value;
      assert.equal(owner, "'local-user'", table);
    }
    const { item } = upsertItem(draft(), T0);
    assert.equal((getDb().prepare('SELECT owner_user_id FROM companion_items WHERE id = ?').get(item.id) as { owner_user_id: string }).owner_user_id, 'local-user');
    const columns = (table: string) => (getDb().prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(columns('companion_items').includes('prior_status'));
    assert.ok(columns('companion_snapshots').includes('missing_count'));
    assert.ok(columns('companion_notices').includes('expires_at'));
    assert.ok(columns('companion_runs').includes('message_id'));
  });

  describe('items (DESIGN §3.1, R2.4)', () => {
    test('a new object is inserted as new, first seen, changed and observed now, and logged created', () => {
      const result = upsertItem(draft(), T0);
      assert.equal(result.change, 'created');
      const item = result.item;
      assert.match(item.id, /^cmi-/);
      assert.equal(item.status, 'new');
      assert.deepEqual([item.firstSeenAt, item.changedAt, item.observedAt, item.createdAt, item.updatedAt], [T0, T0, T0, T0, T0]);
      assert.deepEqual(item.target, { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' });
      assert.deepEqual(item.facts, { cr: 'CR-1', unresolved: 2, revision: 3 });
      assert.deepEqual([item.snoozedUntil, item.feedback, item.feedbackReason, item.resolvedAt], [null, null, null, null]);
      assert.equal(result.event?.kind, 'created');
      assert.equal(result.event?.severity, 'now');
      assert.equal(result.event?.version, 'v1');
      assert.equal(result.event?.summary, 'CR-1 needs attention · 2 unresolved comments on revision 3');
      assert.deepEqual(eventKinds(item.id), ['created']);
      assert.deepEqual(getItemByKey('cr:CR-1:mine'), item);
      assert.equal(notifiedVersionOf(item.id), null);
    });

    test('the same version only refreshes what is shown: no event, the status and changed time stay', () => {
      const { item } = upsertItem(draft(), T0);
      markItemsSeen([item.id], T0 + 1);
      const quiet = upsertItem(draft({ observedAt: T0 + 5 * MINUTE }), T0 + 5 * MINUTE);
      assert.equal(quiet.change, 'unchanged');
      assert.equal(quiet.event, null);
      assert.equal(quiet.item.observedAt, T0 + 5 * MINUTE);
      assert.equal(quiet.item.updatedAt, T0 + 1, 'only observed_at moved');
      const shown = upsertItem(draft({ title: 'CR-1 needs attention (blocked 5h)', facts: { cr: 'CR-1', unresolved: 2, revision: 3, ageHours: 5 },
        bucket: 'stalled', severity: 'digest', subtype: 'cr_stale', observedAt: T0 + 10 * MINUTE }), T0 + 10 * MINUTE);
      assert.equal(shown.change, 'refreshed');
      assert.equal(shown.event, null);
      assert.equal(shown.item.status, 'seen', 'the user saw this version');
      assert.equal(shown.item.changedAt, T0, 'not a meaningful change');
      assert.equal(shown.item.title, 'CR-1 needs attention (blocked 5h)');
      assert.equal(shown.item.facts.ageHours, 5);
      assert.deepEqual([shown.item.bucket, shown.item.severity, shown.item.subtype], ['stalled', 'digest', 'cr_stale']);
      assert.equal(shown.item.updatedAt, T0 + 10 * MINUTE);
      assert.deepEqual(eventKinds(item.id), ['created']);
    });

    test('a new version brings new, seen, snoozed and dismissed items back to new and logs changed', () => {
      for (const status of ['new', 'seen', 'snoozed', 'dismissed'] as const) {
        const id = itemIn(status, `cr:${status}:mine`);
        const result = upsertItem(draft({ itemKey: `cr:${status}:mine`, version: 'v2', summary: 'Changes requested', observedAt: T0 + HOUR }), T0 + HOUR);
        assert.equal(result.change, 'changed', status);
        assert.equal(result.item.status, 'new', status);
        assert.equal(result.item.snoozedUntil, null, status);
        assert.equal(result.item.version, 'v2');
        assert.equal(result.item.changedAt, T0 + HOUR);
        assert.equal(result.item.firstSeenAt, T0, 'first seen stays');
        assert.equal(result.item.summary, 'Changes requested');
        assert.equal(result.event?.kind, 'changed');
        assert.deepEqual(eventKinds(id), ['created', 'changed'], status);
      }
    });

    test('a muted item stays muted through new versions and logs nothing', () => {
      const id = itemIn('muted', 'cr:muted:mine');
      const result = upsertItem(draft({ itemKey: 'cr:muted:mine', version: 'v2', title: 'Changed title', observedAt: T0 + HOUR }), T0 + HOUR);
      assert.equal(result.change, 'changed');
      assert.equal(result.event, null);
      assert.equal(result.item.status, 'muted');
      assert.equal(result.item.version, 'v2');
      assert.equal(result.item.title, 'Changed title');
      assert.deepEqual(eventKinds(id), ['created']);
      assert.deepEqual(resolveByAbsence('cr', [], T0 + 2 * HOUR), [], 'absences leave muted items alone');
      assert.equal(getItem(id)!.status, 'muted');
    });

    test('a resolved item observed again reopens as it was before it resolved, without an event (R2.4)', () => {
      const cases: Array<[CompanionItemStatus, CompanionItemStatus]> = [['new', 'new'], ['seen', 'seen'], ['dismissed', 'dismissed']];
      for (const [before, after] of cases) {
        const id = itemIn(before, `cr:${before}-back:mine`);
        assert.deepEqual(resolveItems([id], T0 + 2), [id]);
        const resolved = getItem(id)!;
        assert.deepEqual([resolved.status, resolved.resolvedAt], ['resolved', T0 + 2], before);
        const back = upsertItem(draft({ itemKey: `cr:${before}-back:mine`, observedAt: T0 + HOUR }), T0 + HOUR);
        assert.equal(back.change, 'reopened', before);
        assert.equal(back.event, null, `${before}: the same version logs nothing`);
        assert.equal(back.item.status, after, before);
        assert.equal(back.item.resolvedAt, null);
        assert.equal(back.item.changedAt, T0, 'not a meaningful change');
        assert.deepEqual(eventKinds(id), ['created', 'resolved'], before);
      }
      // A snooze still running when it comes back keeps running; one that ran out does not.
      const running = itemIn('snoozed', 'cr:snoozed-back:mine');
      resolveItems([running], T0 + 2);
      const stillSnoozed = upsertItem(draft({ itemKey: 'cr:snoozed-back:mine' }), T0 + 30 * MINUTE).item;
      assert.deepEqual([stillSnoozed.status, stillSnoozed.snoozedUntil], ['snoozed', T0 + HOUR]);
      const lapsed = itemIn('snoozed', 'cr:lapsed-back:mine');
      resolveItems([lapsed], T0 + 2);
      const woken = upsertItem(draft({ itemKey: 'cr:lapsed-back:mine' }), T0 + 2 * HOUR).item;
      assert.deepEqual([woken.status, woken.snoozedUntil], ['new', null]);
    });

    test('a resolved item with a new version is new again and logs reopened', () => {
      const id = itemIn('seen', 'cr:changed-back:mine');
      resolveItems([id], T0 + 2);
      const result = upsertItem(draft({ itemKey: 'cr:changed-back:mine', version: 'v2', observedAt: T0 + 2 * HOUR }), T0 + 2 * HOUR);
      assert.equal(result.change, 'reopened');
      assert.equal(result.item.status, 'new', 'the user has not seen this version');
      assert.equal(result.item.resolvedAt, null);
      assert.equal(result.item.changedAt, T0 + 2 * HOUR);
      assert.equal(result.event?.kind, 'reopened');
      assert.deepEqual(eventKinds(id), ['created', 'resolved', 'reopened']);
    });

    test('an item resolves only after two complete polls in a row left it out; being seen starts the count over', () => {
      const kept = itemIn('new', 'cr:kept:mine');
      const gone = itemIn('seen', 'cr:gone:mine');
      const goneSnoozed = itemIn('snoozed', 'cr:gone-snoozed:mine');
      const goneDismissed = itemIn('dismissed', 'cr:gone-dismissed:mine');
      const goneMuted = itemIn('muted', 'cr:gone-muted:mine');
      const already = itemIn('resolved', 'cr:already:mine');
      const flicker = itemIn('new', 'cr:flicker:mine');
      const pipeline = upsertItem(draft({ source: 'pipeline', subtype: 'pipeline_blocked', itemKey: 'pipeline:MyService',
        target: { kind: 'url', url: 'https://builds.example.com/pipelines/MyService' } }), T0).item.id;

      assert.deepEqual(resolveMissing('cr', ['cr:kept:mine'], T0 + HOUR), [], 'the first absence only counts');
      assert.equal(getItem(gone)!.status, 'seen');
      assert.deepEqual(resolveMissing('cr', ['cr:kept:mine', 'cr:flicker:mine'], T0 + HOUR + 1).sort(), [gone, goneSnoozed, goneDismissed].sort(),
        'the second absence in a row resolves; flicker is back, so its count starts over');
      for (const id of [gone, goneSnoozed, goneDismissed]) {
        const item = getItem(id)!;
        assert.deepEqual([item.status, item.resolvedAt], ['resolved', T0 + HOUR + 1], id);
        assert.equal(eventKinds(id).at(-1), 'resolved');
      }
      assert.equal(getItem(goneSnoozed)!.snoozedUntil, T0 + HOUR, 'the snooze is kept for a reopening');
      assert.equal(getItem(kept)!.status, 'new');
      assert.equal(getItem(flicker)!.status, 'new');
      assert.deepEqual(resolveMissing('cr', ['cr:kept:mine'], T0 + 2 * HOUR), [], 'flicker\'s count started over: one absence');
      assert.deepEqual(resolveMissing('cr', ['cr:kept:mine'], T0 + 2 * HOUR + 1), [flicker]);
      assert.equal(getItem(goneMuted)!.status, 'muted');
      assert.equal(getItem(already)!.resolvedAt, T0 + 1, 'an already resolved item is not resolved again');
      assert.equal(getItem(pipeline)!.status, 'new', 'other sources are untouched');
      assert.deepEqual(resolveByAbsence('cr', ['cr:kept:mine'], T0 + 3 * HOUR), [], 'idempotent');
    });

    test('a windowed poll counts only the absences its rule names', () => {
      const old = itemIn('new', 'cr:old:mine');
      const recent = itemIn('new', 'cr:recent:mine');
      const rule = { counts: (key: string) => key === 'cr:recent:mine' };
      assert.deepEqual(resolveMissing('cr', [], T0 + HOUR, rule), []);
      assert.deepEqual(resolveMissing('cr', [], T0 + HOUR + 1, rule), [recent]);
      assert.equal(getItem(old)!.status, 'new', 'outside the window: not counted');
    });

    test('resolveItems resolves the named items at once; muted and resolved ones are left alone', () => {
      const open = itemIn('new', 'cr:open:mine');
      const muted = itemIn('muted', 'cr:m:mine');
      assert.deepEqual(resolveItems([open, muted, 'cmi-missing'], T0 + HOUR), [open]);
      assert.deepEqual(resolveItems([open], T0 + 2 * HOUR), []);
      assert.deepEqual(resolveItems([], T0), []);
    });

    test('a snooze hides the item until its time; the tick then wakes it as new', () => {
      const { item } = upsertItem(draft(), T0);
      const snoozed = applyItemAction(item.id, { action: 'snooze', until: T0 + HOUR }, T0 + MINUTE);
      assert.equal(snoozed.status, 'snoozed');
      assert.equal(snoozed.snoozedUntil, T0 + HOUR);
      assert.equal(isOpenCompanionItem(snoozed, T0 + 30 * MINUTE), false);
      assert.deepEqual(listOpenItems(T0 + 30 * MINUTE).map((i) => i.id), []);
      assert.deepEqual(listOpenItems(T0 + HOUR).map((i) => i.id), [item.id], 'a run-out snooze reads as open before the tick');
      assert.deepEqual(wakeSnoozedItems(T0 + 30 * MINUTE), []);
      assert.deepEqual(wakeSnoozedItems(T0 + HOUR), [item.id]);
      const woken = getItem(item.id)!;
      assert.equal(woken.status, 'new');
      assert.equal(woken.snoozedUntil, null);
      assert.deepEqual(eventKinds(item.id), ['created'], 'waking is not an object change');
    });

    test('user actions: seen only from new, dismiss / mute / restore, snooze limits, feedback', () => {
      const a = upsertItem(draft({ itemKey: 'cr:a:mine' }), T0).item.id;
      const b = upsertItem(draft({ itemKey: 'cr:b:mine' }), T0).item.id;
      applyItemAction(b, { action: 'dismiss' }, T0 + 1);
      assert.deepEqual(markItemsSeen([a, b, 'cmi-missing'], T0 + 2), [a], 'only new items become seen');
      assert.deepEqual(markItemsSeen([a], T0 + 3), []);
      assert.equal(getItem(b)!.status, 'dismissed');
      assert.deepEqual(markItemsSeen([], T0), []);

      assert.equal(applyItemAction(a, { action: 'seen' }, T0 + 4).status, 'seen', 'seen on a seen item is a no-op');
      assert.equal(applyItemAction(b, { action: 'restore' }, T0 + 5).status, 'seen');
      assert.equal(applyItemAction(b, { action: 'mute' }, T0 + 6).status, 'muted');
      assert.equal(applyItemAction(b, { action: 'dismiss' }, T0 + 7).status, 'muted', 'dismissing a muted item does not unmute it');
      assert.equal(applyItemAction(b, { action: 'snooze', until: T0 + HOUR }, T0 + 8).status, 'muted');
      assert.equal(applyItemAction(b, { action: 'restore' }, T0 + 9).status, 'seen');
      assert.equal(applyItemAction(b, { action: 'restore' }, T0 + 10).status, 'seen', 'restoring an open item is a no-op');
      const resolved = itemIn('resolved', 'cr:r:mine');
      assert.equal(applyItemAction(resolved, { action: 'dismiss' }, T0 + 11).status, 'resolved');
      assert.equal(applyItemAction(resolved, { action: 'mute' }, T0 + 12).status, 'muted', 'a resolved object can be muted for good');

      assert.throws(() => applyItemAction(a, { action: 'snooze', until: T0 }, T0 + 20), companionError(400, 'invalid_request'));
      assert.throws(() => applyItemAction(a, { action: 'snooze', until: T0 + 31 * 24 * HOUR }, T0), companionError(400, 'invalid_request'));
      assert.throws(() => applyItemAction(a, { action: 'snooze', until: 1.5 } as never, 0), companionError(400, 'invalid_request'));

      const down = applyItemAction(a, { action: 'feedback', feedback: 'down', reason: 'too_noisy' }, T0 + 30);
      assert.deepEqual([down.feedback, down.feedbackReason, down.status], ['down', 'too_noisy', 'seen'], 'one too_noisy leaves the status alone');
      assert.equal(isSubtypeDemoted('cr_needs_attention'), false, 'one object is not enough to demote its kind');
      const up = applyItemAction(a, { action: 'feedback', feedback: 'up' }, T0 + 31);
      assert.deepEqual([up.feedback, up.feedbackReason], ['up', null]);
      const cleared = applyItemAction(a, { action: 'feedback', feedback: null }, T0 + 32);
      assert.deepEqual([cleared.feedback, cleared.feedbackReason], [null, null]);
      assert.throws(() => applyItemAction(a, { action: 'feedback', feedback: 'up', reason: 'too_late' }, T0), companionError(400, 'invalid_request'));
      assert.throws(() => applyItemAction(a, { action: 'feedback', feedback: 'down', reason: 'meh' as never }, T0), companionError(400, 'invalid_request'));
      assert.throws(() => applyItemAction(a, { action: 'explode' } as never, T0), companionError(400, 'invalid_request'));
      assert.throws(() => applyItemAction('cmi-missing', { action: 'seen' }, T0), companionError(404, 'not_found'));

      const v2 = upsertItem(draft({ itemKey: 'cr:a:mine', version: 'v2' }), T0 + HOUR).item;
      assert.equal(v2.feedback, null, 'the cleared feedback stays cleared');
    });

    test('a thumbs-down has its effect: already handled dismisses, not relevant mutes, too noisy twice demotes the kind (R2.7)', () => {
      const handled = itemIn('new', 'cr:handled:mine');
      const handledItem = applyItemAction(handled, { action: 'feedback', feedback: 'down', reason: 'already_handled' }, T0 + 10);
      assert.deepEqual([handledItem.status, handledItem.feedbackReason], ['dismissed', 'already_handled']);
      assert.equal(upsertItem(draft({ itemKey: 'cr:handled:mine', version: 'v2' }), T0 + HOUR).item.status, 'new', 'only this version was handled');

      const irrelevant = itemIn('seen', 'cr:irrelevant:mine');
      assert.equal(applyItemAction(irrelevant, { action: 'feedback', feedback: 'down', reason: 'not_relevant' }, T0 + 10).status, 'muted');
      assert.equal(applyItemAction(irrelevant, { action: 'restore' }, T0 + 11).status, 'seen', 'restore undoes it');

      const early = itemIn('new', 'cr:early:mine');
      assert.equal(applyItemAction(early, { action: 'feedback', feedback: 'down', reason: 'too_early' }, T0 + 10).status, 'new', 'too early only records');

      const noisyA = itemIn('new', 'cr:noisy-a:mine');
      const noisyB = itemIn('new', 'cr:noisy-b:mine');
      const pipeline = upsertItem(draft({ source: 'pipeline', subtype: 'pipeline_blocked', itemKey: 'pipeline:P' }), T0).item.id;
      applyItemAction(noisyA, { action: 'feedback', feedback: 'down', reason: 'too_noisy' }, T0 + 10);
      applyItemAction(pipeline, { action: 'feedback', feedback: 'down', reason: 'too_noisy' }, T0 + 10);
      assert.equal(isSubtypeDemoted('cr_needs_attention'), false);
      assert.equal(applyItemAction(noisyB, { action: 'feedback', feedback: 'down', reason: 'too_noisy' }, T0 + 11).status, 'new');
      assert.equal(isSubtypeDemoted('cr_needs_attention'), true, 'a second object of the kind demotes it');
      assert.equal(isSubtypeDemoted('pipeline_blocked'), false, 'other kinds keep their own count');
    });

    test('malformed drafts throw instead of being stored; display text and facts are bounded', () => {
      for (const bad of [
        { source: 'slack' }, { subtype: 'cr_exploded' }, { bucket: 'urgent' }, { severity: 'loud' },
        { itemKey: '' }, { version: '' }, { title: '  ' },
        { target: { kind: 'url', url: 'javascript:alert(1)' } }, { target: { kind: 'node', workspaceId: '', nodeId: 'n' } }, { target: { kind: 'page' } },
        { observedAt: Number.NaN },
      ] as Array<Partial<ItemDraft>>) {
        assert.throws(() => upsertItem(draft({ itemKey: 'cr:bad:mine', ...bad }), T0), Error, JSON.stringify(bad));
      }
      assert.equal(getItemByKey('cr:bad:mine'), null);
      const long = upsertItem(draft({
        itemKey: 'cr:long:mine',
        title: `Title\nwith  ${'x'.repeat(300)}`,
        summary: '   ',
        facts: { ok: 'yes', nested: { no: true } as never, list: [1] as never, inf: Infinity, n: 4, b: false, nil: null, text: 'y'.repeat(600) },
        target: null,
      }), T0).item;
      assert.ok(long.title.length <= 200 && long.title.startsWith('Title with x') && long.title.endsWith('…'));
      assert.equal(long.summary, null, 'a blank summary is none');
      assert.equal(long.target, null);
      assert.deepEqual(Object.keys(long.facts).sort(), ['b', 'n', 'nil', 'ok', 'text']);
      assert.equal((long.facts.text as string).length, 500);
      assert.deepEqual(upsertItem(draft({ itemKey: 'cr:node:mine', target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-1' } }), T0).item.target,
        { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-1' });
      assert.deepEqual(upsertItem(draft({ itemKey: 'system:source:cr', source: 'system', subtype: 'system_source_error', target: { kind: 'settings' } }), T0).item.target,
        { kind: 'settings' });
      assert.equal(upsertItem(draft({ itemKey: 'cr:draft:mine', subtype: 'cr_unpublished', bucket: 'stalled', severity: 'digest' }), T0).item.subtype, 'cr_unpublished');
      assert.equal(upsertItem(draft({ itemKey: 'reminder:r-1', subtype: 'reminder_due' }), T0).item.subtype, 'reminder_due');
    });

    test('an item key cannot move to another source', () => {
      upsertItem(draft(), T0);
      assert.throws(() => upsertItem(draft({ source: 'email', subtype: 'email_unread', version: 'v2' }), T0), /belongs to source cr/);
    });

    test('a Today target keeps the item it points at; a bad itemId, or one on the Chat tab, is dropped and the rest kept (A10)', () => {
      const today = (itemId: unknown) => ({ kind: 'companion', tab: 'today', itemId });
      assert.deepEqual(parseCompanionTarget(today('cmi-0f8e7d6c-1234-4abc-9def-001122334455')),
        { kind: 'companion', tab: 'today', itemId: 'cmi-0f8e7d6c-1234-4abc-9def-001122334455' });
      assert.deepEqual(parseCompanionTarget(today(`c${'x'.repeat(159)}`)), today(`c${'x'.repeat(159)}`), '160 characters is the longest id');
      for (const bad of ['', `c${'x'.repeat(160)}`, '../settings', 'cmi 1', 'cmi-1<script>', '-cmi', 'cmi-é', 42, null, { id: 'cmi-1' }]) {
        assert.deepEqual(parseCompanionTarget(today(bad)), { kind: 'companion', tab: 'today' }, JSON.stringify(bad));
      }
      assert.deepEqual(parseCompanionTarget({ kind: 'companion', tab: 'today' }), { kind: 'companion', tab: 'today' });
      assert.deepEqual(parseCompanionTarget({ kind: 'companion', tab: 'chat', itemId: 'cmi-1' }), { kind: 'companion', tab: 'chat' }, 'Today only');
      assert.equal(parseCompanionTarget({ kind: 'companion', tab: 'feed', itemId: 'cmi-1' }), null);

      // Stored and read back with the item.
      const pointing = upsertItem(draft({ itemKey: 'reminder:r-1', source: 'system', subtype: 'reminder_due', target: { kind: 'companion', tab: 'today', itemId: 'cmi-1' } }), T0).item;
      assert.deepEqual(getItem(pointing.id)!.target, { kind: 'companion', tab: 'today', itemId: 'cmi-1' });
    });

    test('the open list, its filters and the badge counts', () => {
      const first = upsertItem(draft({ itemKey: 'cr:1:mine' }), T0).item.id;
      const second = upsertItem(draft({ itemKey: 'pipeline:P', source: 'pipeline', subtype: 'pipeline_recovered', bucket: 'update', severity: 'digest' }), T0 + MINUTE).item.id;
      const third = upsertItem(draft({ itemKey: 'cr:3:mine', bucket: 'stalled', subtype: 'cr_stale', severity: 'digest' }), T0 + 2 * MINUTE).item.id;
      itemIn('dismissed', 'cr:d:mine');
      itemIn('muted', 'cr:m:mine');
      itemIn('resolved', 'cr:r:mine');
      markItemsSeen([third], T0 + 3 * MINUTE);
      const now = T0 + 10 * MINUTE;
      assert.deepEqual(listOpenItems(now).map((i) => i.id), [third, second, first], 'newest change first');
      assert.deepEqual(listOpenItems(now, { source: 'pipeline' }).map((i) => i.id), [second]);
      assert.deepEqual(listOpenItems(now, { bucket: 'needs_you' }).map((i) => i.id), [first]);
      assert.deepEqual(listOpenItems(now, { limit: 1 }).map((i) => i.id), [third]);
      assert.deepEqual(countOpenItems(now), { needsYou: 1, newItems: 2 });
    });

    test('notification bookkeeping: open now-items whose version was not notified yet', () => {
      const now = upsertItem(draft({ itemKey: 'cr:now:mine' }), T0).item;
      upsertItem(draft({ itemKey: 'cr:digest:mine', severity: 'digest' }), T0);
      itemIn('muted', 'cr:muted:mine');
      assert.deepEqual(listUnnotifiedNowItems(T0).map((i) => i.id), [now.id]);
      markItemsNotified([now]);
      assert.equal(notifiedVersionOf(now.id), 'v1');
      assert.deepEqual(listUnnotifiedNowItems(T0), []);
      upsertItem(draft({ itemKey: 'cr:now:mine', version: 'v2' }), T0 + MINUTE);
      assert.deepEqual(listUnnotifiedNowItems(T0 + MINUTE).map((i) => i.id), [now.id], 'a new version is due again');
      markItemsNotified([{ id: now.id, version: 'v2:escalated' }]);
      assert.equal(notifiedVersionOf(now.id), 'v2:escalated', 'the policy may keep its own suffix');
    });

    test('item writes compose with a caller\'s transaction and roll back with it', () => {
      assert.throws(() => runInTransaction(() => {
        companionTransaction(() => upsertItem(draft(), T0));
        assert.ok(getItemByKey('cr:CR-1:mine'));
        throw new Error('caller failed');
      }), /caller failed/);
      assert.equal(getItemByKey('cr:CR-1:mine'), null);
      assert.equal(latestEventSeq(), 0);
    });
  });

  test('events are read by seq cursor, oldest first', () => {
    assert.equal(latestEventSeq(), 0);
    const a = upsertItem(draft({ itemKey: 'cr:a:mine' }), T0);
    const b = upsertItem(draft({ itemKey: 'cr:b:mine', severity: 'digest' }), T0 + 1);
    upsertItem(draft({ itemKey: 'cr:a:mine', version: 'v2' }), T0 + 2);
    resolveByAbsence('cr', ['cr:a:mine'], T0 + 3);
    const all = listEventsAfter(0);
    assert.deepEqual(all.map((e) => [e.itemId, e.kind]), [[a.item.id, 'created'], [b.item.id, 'created'], [a.item.id, 'changed'], [b.item.id, 'resolved']]);
    assert.ok(all.every((event, i) => i === 0 || event.seq > all[i - 1].seq));
    assert.equal(latestEventSeq(), all.at(-1)!.seq);
    const cursor = all[1].seq;
    assert.deepEqual(listEventsAfter(cursor).map((e) => e.kind), ['changed', 'resolved']);
    assert.deepEqual(listEventsAfter(cursor, 1).map((e) => e.kind), ['changed']);
    assert.deepEqual(listEventsAfter(latestEventSeq()), []);
    assert.equal(all[3].severity, 'digest');
    assert.deepEqual(listItemEvents(a.item.id).map((e) => e.kind), ['changed', 'created'], 'one item\'s events, newest first');
  });

  test('runs: start, finish once, one-shot records, the Activity order and today\'s budgeted turns', () => {
    const dayStart = localDayStart(T0);
    const yesterday = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: dayStart - HOUR, outcome: 'spoke', finishedAt: dayStart - HOUR + 1 });
    const poll = startRun({ kind: 'poll', trigger: 'cr', startedAt: T0 });
    assert.equal(poll.outcome, 'running');
    assert.match(poll.id, /^cmr-/);
    const done = finishRun(poll.id, { outcome: 'ok', finishedAt: T0 + 1000, detail: '3 items' });
    assert.deepEqual([done?.outcome, done?.finishedAt, done?.detail], ['ok', T0 + 1000, '3 items']);
    assert.equal(finishRun(poll.id, { outcome: 'error', finishedAt: T0 + 2000 }), null, 'a run finishes once');
    assert.equal(finishRun('cmr-missing', { outcome: 'ok', finishedAt: T0 }), null);
    assert.throws(() => finishRun(poll.id, { outcome: 'running' as never, finishedAt: T0 }));
    const turn = startRun({ kind: 'wake', trigger: 'now-items', startedAt: T0 + 2000 });
    assert.equal(setRunTurnId(turn.id, `cmp-${turn.id}`), true);
    // A check-in whose native record is still to be discarded (DESIGN-v2 §3.7).
    setRunCheckinNode(turn.id, checkinNodeId(turn.id));
    finishRun(turn.id, { outcome: 'quiet', finishedAt: T0 + 3000, messageId: 'm-quiet' });
    assert.deepEqual([getRun(turn.id)?.turnId, getRun(turn.id)?.messageId], [`cmp-${turn.id}`, 'm-quiet']);
    assert.equal(setRunTurnId(turn.id, 'cmp-late'), false, 'only a running run takes its turn id');
    recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 + 4000, outcome: 'skipped', finishedAt: T0 + 4000, detail: 'no new material' });
    recordRun({ kind: 'welcome', trigger: 'first-open', startedAt: T0 + 4500, outcome: 'spoke', finishedAt: T0 + 4600, turnId: 'cmp-w', messageId: 'm-welcome' });
    recordRun({ kind: 'worker_report', trigger: 'delegation', startedAt: T0 + 4700, outcome: 'preempted', finishedAt: T0 + 4800 });
    const failed = startRun({ kind: 'brief', trigger: 'schedule', startedAt: T0 + 5000 });
    const reattached = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 + 5100, turnId: 'cmp-live' });

    assert.equal(countTurnsSince(dayStart), 3, 'today: the wake, the running brief and heartbeat; polls, skipped runs, welcome and worker reports do not count');
    assert.equal(countTurnsSince(dayStart - 2 * HOUR), 4);
    assert.equal(countTurnsSince(dayStart, ['welcome', 'worker_report']), 2, 'the exempt kinds, counted on request');
    assert.equal(countTurnsSince(dayStart, []), 0);
    assert.deepEqual(listRuns().map((run) => run.kind), ['heartbeat', 'brief', 'worker_report', 'welcome', 'heartbeat', 'wake', 'poll', 'heartbeat']);
    assert.deepEqual(listRuns(2).map((run) => run.kind), ['heartbeat', 'brief']);
    assert.equal(latestFinishedRun('poll')?.finishedAt, T0 + 1000);
    assert.equal(latestFinishedRun('poll', 'email'), null);
    assert.equal(latestFinishedRun('worker_report')?.outcome, 'preempted');
    assert.deepEqual(listRunningRuns().map((run) => run.id), [failed.id, reattached.id]);

    assert.equal(failInterruptedRuns(T0 + 6000, { except: [reattached.id] }), 1, 'a run left running by a stopped process ends as an error, unless re-attached');
    assert.deepEqual([getRun(failed.id)?.outcome, getRun(failed.id)?.finishedAt], ['error', T0 + 6000]);
    assert.equal(getRun(reattached.id)?.outcome, 'running');
    assert.equal(failInterruptedRuns(T0 + 7000), 1);
    const holding = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - 2 * HOUR });
    assert.equal(pruneRuns(2), 5, 'the newest two stay, and neither the running run nor the check-in still to be discarded counts');
    assert.deepEqual(listRuns(10).map((run) => run.id).includes(yesterday.id), false);
    assert.equal(getRun(turn.id)?.checkinNodeId, checkinNodeId(turn.id), 'a check-in whose native record may still be on disk is never cut: boot cleanup retries from it');
    assert.equal(getRun(holding.id)?.outcome, 'running');
    assert.deepEqual(listRuns(10).map((run) => run.id).sort(), [failed.id, reattached.id, turn.id, holding.id].sort());
    markRunDiscarded(turn.id, T0 + 8000);
    assert.equal(pruneRuns(2), 1, 'once its record is gone it is an ordinary run');
    assert.equal(getRun(turn.id), null);
    assert.throws(() => startRun({ kind: 'nap' as never, trigger: 'x', startedAt: T0 }));
    assert.throws(() => startRun({ kind: 'poll', trigger: '  ', startedAt: T0 }));
    assert.equal(startRun({ kind: 'poll', trigger: 'x'.repeat(200), startedAt: T0 }).trigger.length, 80);
  });

  test('goals: ordered, at most 10, text and progress limits, soft removal', () => {
    const first = addGoal('  Ship the\nCompanion MVP ', T0);
    assert.equal(first.text, 'Ship the Companion MVP');
    assert.match(first.id, /^cmg-/);
    const second = addGoal('Keep CRs moving', T0 + 1);
    assert.deepEqual(listGoals().map((goal) => goal.id), [first.id, second.id]);
    const progressed = recordGoalProgress(first.id, '3 of 5 waves done', T0 + 2);
    assert.deepEqual([progressed.progress, progressed.progressAt, progressed.updatedAt], ['3 of 5 waves done', T0 + 2, T0 + 2]);
    const renamed = updateGoal(first.id, { text: 'Ship the Companion' }, T0 + 3);
    assert.deepEqual([renamed.text, renamed.progress], ['Ship the Companion', '3 of 5 waves done'], 'progress stays when only the text changes');
    assert.equal(updateGoal(first.id, { progress: null }, T0 + 4).progress, null);
    assert.throws(() => recordGoalProgress(first.id, 'x'.repeat(201), T0), companionError(400, 'invalid_request'));
    assert.throws(() => addGoal('', T0), companionError(400, 'invalid_request'));
    assert.throws(() => addGoal('x'.repeat(501), T0), companionError(400, 'invalid_request'));
    assert.throws(() => addGoal(7, T0), companionError(400, 'invalid_request'));
    assert.equal(addGoal('x'.repeat(500), T0).text.length, 500);
    removeGoal(second.id, T0 + 5);
    assert.equal(getGoal(second.id), null);
    assert.equal((getDb().prepare('SELECT removed_at FROM companion_goals WHERE id = ?').get(second.id) as { removed_at: number }).removed_at, T0 + 5, 'kept, marked removed');
    assert.throws(() => removeGoal(second.id, T0), companionError(404, 'not_found'));
    assert.throws(() => updateGoal(second.id, { text: 'x' }, T0), companionError(404, 'not_found'));
    for (let i = listGoals().length; i < 10; i++) addGoal(`Goal ${i}`, T0 + 10 + i);
    assert.equal(listGoals().length, 10);
    assert.throws(() => addGoal('One too many', T0 + 100), companionError(409, 'limit_reached'));
    assert.equal(listGoals().at(-1)?.text, 'Goal 9', 'new goals go last');
  });

  describe('cards', () => {
    test('storage: TTL, pending list and count, one decision, expiry, reporting', () => {
      const card = insertCard({ kind: 'goal.add', payload: { text: 'A' }, summary: 'Add a goal: "A"', reason: 'You keep mentioning it', now: T0 });
      assert.match(card.id, /^cmc-/);
      assert.deepEqual([card.status, card.expiresAt, card.decidedAt, card.reportedAt], ['pending', T0 + COMPANION_CARD_TTL_MS, null, null]);
      const second = insertCard({ kind: 'goal.add', payload: { text: 'B' }, summary: 'Add a goal: "B"', reason: null, now: T0 + 1, ttlMs: HOUR });
      assert.deepEqual(listPendingCards(T0 + 2).map((c) => c.id), [card.id, second.id]);
      assert.equal(countPendingCards(T0 + 2), 2);
      assert.deepEqual(listPendingCards(T0 + HOUR + 1).map((c) => c.id), [card.id], 'a card past its TTL is no longer pending');
      assert.equal(countPendingCards(T0 + HOUR + 1), 1);
      assert.deepEqual(expireCards(T0 + HOUR + 1), [second.id]);
      assert.equal(getCard(second.id)?.status, 'expired');
      const dismissed = decideCard(card.id, 'dismissed', T0 + 5);
      assert.deepEqual([dismissed?.status, dismissed?.decidedAt], ['dismissed', T0 + 5]);
      assert.equal(decideCard(card.id, 'applied', T0 + 6), null, 'one decision wins');
      assert.equal(decideCard('cmc-missing', 'applied', T0), null);
      assert.deepEqual(listUnreportedCards().map((c) => c.id), [card.id, second.id], 'decision order');
      assert.equal(markCardsReported([card.id, second.id], T0 + 7), 2);
      assert.equal(markCardsReported([card.id], T0 + 8), 0, 'reported once');
      assert.deepEqual(listUnreportedCards(), []);
      assert.equal(getCard(card.id)?.reportedAt, T0 + 7);
      const failed = insertCard({ kind: 'goal.remove', payload: {}, summary: 's', reason: null, now: T0 });
      assert.equal(decideCard(failed.id, 'failed', T0 + 1, 'That goal\nno longer exists')?.error, 'That goal no longer exists');
      const late = insertCard({ kind: 'conversation.start', payload: {}, summary: 's', reason: null, now: T0 });
      assert.equal(failAppliedCard(late.id, T0 + 1, 'x'), null, 'only an applied card can fail after the fact');
      decideCard(late.id, 'applied', T0 + 1);
      assert.deepEqual([failAppliedCard(late.id, T0 + 2, 'The workspace\nis archived')?.status, getCard(late.id)?.error], ['failed', 'The workspace is archived']);
    });

    test('proposals are validated and summarized by Michi, at most 8 pending', () => {
      const goal = proposeCompanionCard({ kind: 'goal.add', payload: { text: ' Learn the\nCR backlog ' }, reason: '  The user said so ' }, T0);
      assert.deepEqual([goal.kind, goal.payload, goal.summary, goal.reason], ['goal.add', { text: 'Learn the CR backlog' }, 'Add a goal: "Learn the CR backlog"', 'The user said so']);
      const existing = addGoal('Old goal', T0);
      assert.equal(proposeCompanionCard({ kind: 'goal.update', payload: { goalId: existing.id, text: 'New goal' } }, T0).summary, 'Change the goal "Old goal" to "New goal"');
      assert.equal(proposeCompanionCard({ kind: 'goal.remove', payload: { goalId: existing.id } }, T0).summary, 'Remove the goal "Old goal"');
      assert.equal(proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Second goal' } }, T0).summary, 'Add a goal: "Second goal"');
      assert.equal(proposeCompanionCard({ kind: 'source.update', payload: { source: 'email', enabled: false } }, T0).summary, 'Stop watching email');
      assert.equal(proposeCompanionCard({ kind: 'pipeline.watch', payload: { add: ['MyService'], remove: ['Old'] } }, T0).summary,
        'Watch the pipeline MyService; Stop watching Old');
      assert.equal(proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Third goal' } }, T0).summary, 'Add a goal: "Third goal"');
      assert.equal(proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Fourth goal' } }, T0).summary, 'Add a goal: "Fourth goal"');
      assert.equal(countPendingCards(T0), 8);
      assert.throws(() => proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Ninth' } }, T0), companionError(409, 'limit_reached'));

      for (const decided of listPendingCards(T0)) dismissCompanionCard(decided.id, T0 + 1);
      for (const [proposal, status, code] of [
        [{ kind: 'goal.delete', payload: {} }, 400, 'invalid_request'],
        [{ kind: 'goal.add', payload: { text: 'x', extra: 1 } }, 400, 'invalid_request'],
        [{ kind: 'goal.add', payload: {} }, 400, 'invalid_request'],
        [{ kind: 'goal.add', payload: 'x' }, 400, 'invalid_request'],
        [{ kind: 'goal.update', payload: { goalId: 'cmg-missing', text: 'x' } }, 404, 'not_found'],
        // Gone in P3: there is no heartbeat, and no quiet hours.
        [{ kind: 'checkins.update', payload: { brief: { enabled: false } } }, 400, 'invalid_request'],
        [{ kind: 'quiet_hours.update', payload: { enabled: false } }, 400, 'invalid_request'],
        [{ kind: 'source.update', payload: { source: 'system', enabled: true } }, 400, 'invalid_request'],
        [{ kind: 'source.update', payload: { source: 'email', enabled: 'no' } }, 400, 'invalid_request'],
        [{ kind: 'pipeline.watch', payload: {} }, 400, 'invalid_request'],
        [{ kind: 'pipeline.watch', payload: { add: ['bad name'] } }, 400, 'invalid_request'],
        [{ kind: 'pipeline.watch', payload: { add: Array.from({ length: 26 }, (_, i) => `P${i}`) } }, 400, 'invalid_request'],
        [{ kind: 'goal.add', payload: { text: 'x' }, reason: 'r'.repeat(501) }, 400, 'invalid_request'],
        [{ kind: 'goal.add', payload: { text: 'x' }, reason: 5 }, 400, 'invalid_request'],
      ] as const) {
        assert.throws(() => proposeCompanionCard(proposal, T0 + 2), companionError(status, code), JSON.stringify(proposal));
      }
      for (let i = listGoals().length; i < 10; i++) addGoal(`Goal ${i}`, T0);
      assert.throws(() => proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Eleventh' } }, T0 + 3), companionError(409, 'limit_reached'));
    });

    test('Apply makes the change and marks the card applied; a change that no longer holds fails with its reason', async () => {
      const add = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Ship it' } }, T0);
      const applied = await applyCompanionCard(add.id, T0 + 1);
      assert.deepEqual([applied.outcome, applied.card.status, applied.card.decidedAt, applied.changed], ['applied', 'applied', T0 + 1, ['goals']]);
      assert.deepEqual(listGoals().map((goal) => goal.text), ['Ship it']);
      assert.equal((await applyCompanionCard(add.id, T0 + 2)).outcome, 'not_pending');
      assert.equal(listGoals().length, 1, 'a second Apply changes nothing');

      const source = proposeCompanionCard({ kind: 'source.update', payload: { source: 'calendar', enabled: false } }, T0);
      assert.deepEqual((await applyCompanionCard(source.id, T0 + 1)).changed, ['settings']);
      assert.equal(getCompanionSettings().sources.calendar.enabled, false);
      patchCompanionSettings({ sources: { pipeline: { watch: ['Keep', 'Drop'] } } });
      await applyCompanionCard(proposeCompanionCard({ kind: 'pipeline.watch', payload: { add: ['New', 'Keep'], remove: ['Drop'] } }, T0).id, T0 + 1);
      assert.deepEqual(getCompanionSettings().sources.pipeline.watch, ['Keep', 'New']);

      // The goal went before the user pressed Apply.
      const goal = listGoals()[0];
      const remove = proposeCompanionCard({ kind: 'goal.remove', payload: { goalId: goal.id } }, T0);
      removeGoal(goal.id, T0 + 1);
      const failed = await applyCompanionCard(remove.id, T0 + 2);
      assert.deepEqual([failed.outcome, failed.card.status, failed.card.error, failed.changed], ['failed', 'failed', 'That goal no longer exists', []]);
      // The watch list filled up in the meantime: nothing of the card is applied.
      patchCompanionSettings({ sources: { pipeline: { watch: Array.from({ length: 24 }, (_, i) => `P${i}`) } } });
      const full = proposeCompanionCard({ kind: 'pipeline.watch', payload: { add: ['X'] } }, T0);
      patchCompanionSettings({ sources: { pipeline: { watch: Array.from({ length: 25 }, (_, i) => `P${i}`) } } });
      const overflow = await applyCompanionCard(full.id, T0 + 1);
      assert.equal(overflow.outcome, 'failed');
      assert.match(overflow.card.error ?? '', /at most 25/);
      assert.equal(getCompanionSettings().sources.pipeline.watch.length, 25);
      await assert.rejects(applyCompanionCard('cmc-missing', T0), companionError(404, 'not_found'));
    });

    test('Dismiss decides without a change; a card past its TTL expires instead', async () => {
      const card = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Maybe' } }, T0);
      const dismissed = dismissCompanionCard(card.id, T0 + 1);
      assert.deepEqual([dismissed.outcome, dismissed.card.status], ['dismissed', 'dismissed']);
      assert.deepEqual(listGoals(), []);
      assert.equal(dismissCompanionCard(card.id, T0 + 2).outcome, 'not_pending');
      const late = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Too late' } }, T0);
      const expired = await applyCompanionCard(late.id, T0 + COMPANION_CARD_TTL_MS);
      assert.deepEqual([expired.outcome, expired.card.status], ['expired', 'expired']);
      assert.deepEqual(listGoals(), []);
      const lateDismiss = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Gone' } }, T0);
      assert.equal(dismissCompanionCard(lateDismiss.id, T0 + COMPANION_CARD_TTL_MS + 1).outcome, 'expired');
    });
  });

  test('briefs: one per date and origin, the Companion\'s preferred, card feedback, validation', () => {
    const cards = [
      { title: '2 CRs need you', body: 'CR-1 has changes requested.', itemIds: ['cmi-1', 'cmi-1'], action: { label: 'Ask', prompt: 'Tell me about CR-1' } },
      { title: 'Pipeline blocked', body: 'MyService is blocked in Gamma.', itemIds: [], action: null },
    ];
    const fallback = insertBrief({ date: '2026-11-05', headline: '2 things need you today', cards, closing: "That's all for today.", origin: 'fallback', now: T0 })!;
    assert.match(fallback.id, /^cmb-/);
    assert.deepEqual(fallback.cards[0].itemIds, ['cmi-1'], 'item ids de-duplicated');
    assert.equal(briefForDate('2026-11-05')?.id, fallback.id);
    assert.equal(insertBrief({ date: '2026-11-05', headline: 'again', cards: [], closing: 'x', origin: 'fallback', now: T0 }), null, 'one per date and origin');
    const llm = insertBrief({ date: '2026-11-05', headline: 'Your day', cards: cards.slice(1), closing: "That's all for today.", origin: 'llm', now: T0 + 1 })!;
    assert.equal(briefForDate('2026-11-05')?.id, llm.id, 'the Companion\'s own brief wins');
    assert.equal(insertBrief({ date: '2026-11-05', headline: 'second', cards: [], closing: 'x', origin: 'llm', now: T0 }), null, 'one llm brief a day');
    assert.equal(briefForDate('2026-11-06'), null);

    assert.deepEqual(setBriefCardFeedback(fallback.id, 1, 'down').cardFeedback, { 1: 'down' });
    assert.deepEqual(setBriefCardFeedback(fallback.id, 0, 'up').cardFeedback, { 0: 'up', 1: 'down' });
    assert.deepEqual(setBriefCardFeedback(fallback.id, 1, null).cardFeedback, { 0: 'up' });
    assert.deepEqual(getBrief(fallback.id)?.cardFeedback, { 0: 'up' });
    assert.throws(() => setBriefCardFeedback(fallback.id, 2, 'up'), companionError(400, 'invalid_request'));
    assert.throws(() => setBriefCardFeedback(fallback.id, -1, 'up'), companionError(400, 'invalid_request'));
    assert.throws(() => setBriefCardFeedback('cmb-missing', 0, 'up'), companionError(404, 'not_found'));

    for (const bad of [
      { date: '11/05/2026' }, { origin: 'human' }, { headline: '' }, { closing: 'x'.repeat(201) },
      { cards: Array.from({ length: 8 }, () => cards[1]) }, { cards: [{ ...cards[1], title: '' }] },
      { cards: [{ ...cards[1], itemIds: Array.from({ length: 11 }, (_, i) => `cmi-${i}`) }] },
      { cards: [{ ...cards[1], action: { label: 'x'.repeat(41), prompt: 'p' } }] },
    ]) {
      assert.throws(() => insertBrief({ date: '2026-11-07', headline: 'h', cards, closing: 'c', origin: 'fallback', now: T0, ...bad } as never),
        companionError(400, 'invalid_request'), JSON.stringify(bad).slice(0, 80));
    }
  });

  describe('the bus', () => {
    test('emitChanged bumps the stored revision and reaches every subscriber, whatever one of them does', () => {
      const bus = new CompanionEventBus();
      const seen: CompanionChangedEvent[] = [];
      bus.subscribe({ changed: () => { throw new Error('broken stream'); } });
      const off = bus.subscribe({ changed: (event) => seen.push(event) });
      assert.equal(bus.currentRevision(), 0);
      const first = bus.emitChanged('items');
      const second = bus.emitChanged('notes');
      assert.deepEqual(seen, [{ type: 'companion_changed', revision: 1, reason: 'items' }, { type: 'companion_changed', revision: 2, reason: 'notes' }]);
      assert.deepEqual([first.revision, second.revision, currentRevision()], [1, 2, 2]);
      off();
      bus.emitChanged('goals');
      assert.equal(seen.length, 2);
      assert.equal(encodeCompanionChangedEvent(first), `event: companion_changed\ndata: ${JSON.stringify(first)}\n\n`);
      // The revision survives a restart, so it never goes back.
      closeDb();
      initDb(); enableSyntheticCompanionSources();
      assert.equal(currentRevision(), 3);
      assert.equal(bumpRevision(), 4);
    });
  });

  test('check-in records: posts the next user turn is told of, Today and goal changes with their rules, goal text origin (DESIGN-v2 §2.7, §3.5)', () => {
    const item = upsertItem(draft(), T0).item;
    const older = recordRun({ kind: 'wake', trigger: 'now-items', startedAt: T0, outcome: 'quiet', finishedAt: T0 + 1 });
    const newer = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 + 10, outcome: 'spoke', finishedAt: T0 + 11 });
    recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 + 20, outcome: 'quiet', finishedAt: T0 + 21 });
    const snooze = { kind: 'item' as const, id: item.id, applied: 1, proposed: 0, action: 'snooze' as const, reason: 'Waits on its author' };
    recordRunPost(older.id, { messageId: companionPostId(older.id), at: T0 + 1, changes: [snooze] });
    recordRunPost(newer.id, { messageId: companionPostId(newer.id), at: T0 + 11, changes: [] });
    assert.deepEqual(listUntoldPosts(), [
      { runId: newer.id, messageId: companionPostId(newer.id), kind: 'heartbeat', postedAt: T0 + 11, changes: [] },
      { runId: older.id, messageId: companionPostId(older.id), kind: 'wake', postedAt: T0 + 1, changes: [{ kind: 'item', id: item.id, applied: 1, proposed: 0, action: 'snooze' }] },
    ], 'newest first, a run that posted nothing is not there, and no check-in reason (§2.8 T1)');
    assert.deepEqual(listUntoldPosts(1).map((post) => post.runId), [newer.id]);
    assert.equal(markPostsTold([companionPostId(newer.id)], T0 + 30), 1, 'by its post id');
    assert.equal(markPostsTold([older.id, 'cmr-missing'], T0 + 31), 1, 'or its run id');
    assert.equal(markPostsTold([older.id], T0 + 32), 0, 'once');
    assert.deepEqual(listUntoldPosts(), []);

    const run = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 });
    const change = (input: Partial<Parameters<typeof recordRunChange>[0]>) => recordRunChange({
      runId: run.id, targetKind: 'item', targetId: item.id, action: 'dismiss', before: null, after: null, reason: 'Merged', now: T0, ...input,
    });
    assert.throws(() => change({ reason: null }), companionError(400, 'invalid_request'), 'a Today change needs its reason (§2.6.5)');
    assert.throws(() => change({ reason: '  ' }), companionError(400, 'invalid_request'));
    assert.throws(() => change({ action: 'add' }), companionError(400, 'invalid_request'), 'items are snoozed, dismissed or restored');
    assert.throws(() => change({ targetKind: 'goal', action: 'snooze', reason: null }), companionError(400, 'invalid_request'), 'goals are added, reworded or removed');
    assert.throws(() => change({ targetKind: 'page' as never }), companionError(400, 'invalid_request'), 'pages are page_changes\' (W1-C)');
    const long = change({ reason: `Done ${'x'.repeat(COMPANION_LIMITS.maxChangeReasonChars + 50)}` });
    const stored = getDb().prepare('SELECT reason FROM companion_run_changes WHERE id = ?').get(long) as { reason: string };
    assert.ok(Array.from(stored.reason).length <= COMPANION_LIMITS.maxChangeReasonChars, 'clipped');

    const goal = editGoal({ action: 'add', text: 'Review CR-2', origin: 'checkin' }, T0);
    assert.equal(goal.textOrigin, 'checkin');
    recordRunChange({ runId: run.id, targetKind: 'goal', targetId: goal.id, action: 'add', before: null, after: { text: 'Review CR-2', textOrigin: 'checkin' }, reason: null, now: T0 + 1 });
    assert.equal(updateGoal(goal.id, { progress: 'Half way' }, T0 + 2).textOrigin, 'checkin', 'progress alone keeps who wrote the text');
    assert.equal(updateGoal(goal.id, { text: 'Review CR-2 today' }, T0 + 3).textOrigin, 'user', 'the user\'s words now');
    assert.equal(editGoal({ action: 'reword', id: goal.id, text: 'Review CR-2 by noon', origin: 'checkin' }, T0 + 4).textOrigin, 'checkin');
    assert.equal(editGoal({ action: 'remove', id: goal.id, origin: 'checkin' }, T0 + 5).id, goal.id);
    assert.equal(listGoals().some((entry) => entry.id === goal.id), false);
    assert.throws(() => editGoal({ action: 'reword', text: 'x', origin: 'checkin' }, T0), companionError(400, 'invalid_request'));
    assert.throws(() => editGoal({ action: 'add', text: 'x', origin: 'model' as never }, T0), companionError(400, 'invalid_request'));
    assert.equal(addGoal('Mine', T0).textOrigin, 'user');
  });

  test('delegations are recorded once per conversation, reported and closed', () => {
    const first = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix the\npipeline', now: T0 });
    assert.match(first.id, /^cmd-/);
    assert.equal(first.title, 'Fix the pipeline');
    assert.deepEqual(recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Other', now: T0 + 1 }), first, 'the first record is kept');
    recordDelegation({ workspaceId: 'ws-2', nodeId: 'n-2', title: '', now: T0 + 2 });
    assert.equal(getDelegation('n-2')?.title, 'Conversation');
    assert.deepEqual(listOpenDelegations().map((d) => d.nodeId), ['n-1', 'n-2']);
    assert.equal(markDelegationReported('n-1', 'm-9', T0 + 3), true);
    assert.deepEqual([getDelegation('n-1')?.lastReportedMessageId, getDelegation('n-1')?.lastReportedAt], ['m-9', T0 + 3]);
    assert.equal(closeDelegation('n-1', T0 + 4), true);
    assert.equal(closeDelegation('n-1', T0 + 5), false);
    assert.deepEqual(listOpenDelegations().map((d) => d.nodeId), ['n-2']);
    assert.equal(markDelegationReported('n-missing', 'm', T0), false);
    assert.throws(() => recordDelegation({ workspaceId: '', nodeId: 'n-3', title: 't', now: T0 }));
  });

  test('v2 delegations are followed from the start, record how they began and why they closed; a v1 row stays closed (DESIGN-v2 §4)', () => {
    const started = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix it', now: T0, origin: 'start_conversation' });
    assert.deepEqual([started.state, started.origin, started.autoSend, started.lastSentAt, started.closedReason], ['following', 'start_conversation', false, null, null]);
    // An applied card starts its conversation through start_conversation, then names itself the origin.
    assert.equal(recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix it', now: T0 + 1, origin: 'card' }).origin, 'card');
    assert.equal(recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix it', now: T0 + 2 }).origin, 'card', 'no origin changes nothing');
    assert.equal(setDelegationAutoSend(started.id, 'trust'), true);
    assert.equal(markDelegationSent(started.id, T0 + 3), true);
    assert.deepEqual([getDelegation('n-1')?.autoSend, getDelegation('n-1')?.autoSendChoice, getDelegation('n-1')?.lastSentAt], [true, 'trust', T0 + 3]);
    // D22: the choice it was given under is kept, 1 + its rank; anything else read back fails toward Ask.
    assert.equal(getDb().prepare('SELECT auto_send FROM companion_delegations WHERE id = ?').get(started.id)!.auto_send, 3);
    assert.throws(() => setDelegationAutoSend(started.id, 'everything' as never), /unknown permission choice/);
    assert.equal(getFollowedDelegation('n-1')?.id, started.id);
    assert.equal(closeDelegation('n-1', T0 + 4, 'took_over'), true);
    assert.deepEqual([getDelegation('n-1')?.state, getDelegation('n-1')?.closedReason, getDelegation('n-1')?.closedAt], ['closed', 'took_over', T0 + 4]);
    assert.equal(getFollowedDelegation('n-1'), null);
    assert.equal(setDelegationAutoSend(started.id, 'ask'), false, 'a closed delegation takes no "stop asking"');
    assert.equal(recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Again', now: T0 + 5, origin: 'start_conversation' }).state, 'closed', 'a closed one is never reopened');

    getDb().prepare(`INSERT INTO companion_delegations (id, owner_user_id, workspace_id, node_id, title, created_at)
      VALUES ('cmd-v1', 'local-user', 'ws-1', 'n-v1', 'From the MVP', ?)`).run(T0);
    assert.deepEqual([getDelegation('n-v1')?.state, getDelegation('n-v1')?.closedAt], ['closed', null], 'the MVP never closed it; 0082 did');
    assert.equal(getFollowedDelegation('n-v1'), null);
    assert.deepEqual(listOpenDelegations(), [], 'no worker report follows it');
    assert.equal(closeDelegation('n-v1', T0), false);
  });

  test('a reply a held-back notice left to Today (D18): still followed, out of the Michi source\'s delegations, until a report or a follow-up', () => {
    const left = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix it', now: T0, origin: 'card' });
    recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-2', title: 'Other', now: T0 + 1, origin: 'card' });
    assert.equal(leaveDelegationReplyToToday('n-1', 'm-1'), true);
    assert.deepEqual([getDelegation('n-1')?.state, getDelegation('n-1')?.leftToTodayMessageId, getDelegation('n-1')?.lastReportedMessageId], ['following', 'm-1', null]);
    assert.deepEqual(listOpenDelegations().map((d) => [d.nodeId, d.leftToTodayMessageId]), [['n-1', 'm-1'], ['n-2', null]]);
    assert.deepEqual(listDelegationsSince(T0 - 1).map((d) => d.nodeId), ['n-2'], 'its reply is Today\'s');
    // A follow-up hands the conversation back to the worker reports; so does a report.
    markDelegationSent(left.id, T0 + 5);
    assert.equal(getDelegation('n-1')?.leftToTodayMessageId, null);
    assert.deepEqual(listDelegationsSince(T0 - 1).map((d) => d.nodeId), ['n-1', 'n-2']);
    leaveDelegationReplyToToday('n-1', 'm-2');
    markDelegationReported('n-1', 'm-3', T0 + 6);
    assert.equal(getDelegation('n-1')?.leftToTodayMessageId, null);
    closeDelegation('n-2', T0 + 7, 'idle');
    assert.equal(leaveDelegationReplyToToday('n-2', 'm-4'), false, 'only a followed one');
    assert.equal(leaveDelegationReplyToToday('n-missing', 'm-5'), false);
  });

  test('a check-in\'s own follow-up is kept on its run for its receipt (D21): once per conversation, only sends read back', () => {
    const run = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 });
    recordCheckinSend(run.id, { nodeId: 'n-1', title: 'Fix\nthe test' });
    recordCheckinSend(run.id, { nodeId: 'n-1', title: 'Fix the test' });
    assert.deepEqual(checkinRunSends(run.id), [{ kind: 'send', id: 'n-1', title: 'Fix the test', applied: 1, proposed: 0 }]);
    assert.deepEqual(getRun(run.id)!.changes, [{ kind: 'send', id: 'n-1', title: 'Fix the test', applied: 1, proposed: 0 }], 'Activity sees it before the post');
    recordRunPost(run.id, { messageId: 'cmp-post-x', at: T0 + 1, changes: [{ kind: 'page', id: 'pg-1', applied: 1, proposed: 0 }, ...checkinRunSends(run.id)] });
    assert.deepEqual(checkinRunSends(run.id).map((change) => change.id), ['n-1'], 'the post\'s record keeps it');
    assert.deepEqual(checkinRunSends('cmr-missing'), []);
    assert.throws(() => recordCheckinSend('cmr-missing', { nodeId: 'n-1', title: 't' }), /no run/);
  });

  test('a follow-up is a send run of its delegation; only delivered ones count toward the day (DESIGN-v2 §4)', () => {
    const delegation = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix it', now: T0, origin: 'card' });
    const sent = startSendRun({ delegationId: delegation.id, via: 'user', detail: 'To "Fix it" via user · 12 characters', startedAt: T0 });
    assert.deepEqual([sent.kind, sent.trigger, sent.outcome, sent.turnId], ['send', 'user', 'running', null]);
    assert.equal(getDb().prepare('SELECT delegation_id FROM companion_runs WHERE id = ?').get(sent.id)!.delegation_id, delegation.id);
    finishRun(sent.id, { outcome: 'ok', finishedAt: T0, turnId: `cms-${sent.id}` });
    const failedSend = startSendRun({ delegationId: delegation.id, via: 'card', detail: 'x', startedAt: T0 + 1 });
    finishRun(failedSend.id, { outcome: 'error', finishedAt: T0 + 1 });
    assert.equal(countDeliveredSends(delegation.id, T0), 1);
    assert.equal(countDeliveredSends(delegation.id, T0 + 1), 0);
    assert.equal(countTurnsSince(0), 0, 'outside the turn budget');
  });

  test('the brief\'s focus and the meta helpers', () => {
    assert.equal(setBriefCurate(' More on\nreviews '), 'More on reviews');
    assert.equal(getBriefCurate(), 'More on reviews');
    assert.throws(() => setBriefCurate('x'.repeat(501)), companionError(400, 'invalid_request'));
    assert.equal(setBriefCurate(''), '');
    assert.equal(getBriefCurate(), '');

    assert.equal(getCompanionMetaNumber('companion:heartbeat_cursor'), null);
    setCompanionMetaNumber('companion:heartbeat_cursor', 42);
    assert.equal(getCompanionMetaNumber('companion:heartbeat_cursor'), 42);
    setCompanionMeta('companion:catch_up', JSON.stringify({ line: 'x' }));
    assert.equal(getCompanionMetaNumber('companion:catch_up'), null, 'not a number');
    assert.deepEqual(JSON.parse(getCompanionMeta('companion:catch_up')!), { line: 'x' });
    deleteCompanionMeta('companion:catch_up');
    assert.equal(getCompanionMeta('companion:catch_up'), null);
    assert.throws(() => setCompanionMetaNumber('companion:last_wake_at', 1.5));
  });

  describe('snapshot', () => {
    test('Michi\'s latest line (Q45): none until a check-in writes one, then the newest; a malformed stored one reads as none', () => {
      const conversation = { workspaceId: ASSISTANT.workspaceId, nodeId: ASSISTANT.nodeId, assistant: ASSISTANT };
      assert.equal(snapshotDto({ now: T0, conversation }).headline, null);
      const revision = snapshotDto({ now: T0, conversation }).revision;
      setCompanionHeadline({ text: 'Watching the release pipeline', at: T0, kind: 'heartbeat' });
      setCompanionHeadline({ text: 'CR-1 is ready for your review', at: T0 + MINUTE, kind: 'wake' });
      const snapshot = snapshotDto({ now: T0 + MINUTE, conversation });
      assert.deepEqual(snapshot.headline, { text: 'CR-1 is ready for your review', at: T0 + MINUTE, kind: 'wake' });
      assert.ok(snapshot.revision > revision);
      for (const bad of ['not json', JSON.stringify({ text: '', at: 1, kind: 'wake' }), JSON.stringify({ text: 'x', at: 1, kind: 'poll' })]) {
        setCompanionMeta('companion:headline', bad);
        assert.equal(companionHeadline(), null, bad);
      }
    });

    test('assembles the window: open items, counts, today\'s brief, pending cards, goals, notes, rules, reminders, activity, revision', () => {
      const conversation = { workspaceId: ASSISTANT.workspaceId, nodeId: ASSISTANT.nodeId, assistant: ASSISTANT };
      const empty = snapshotDto({ now: T0, conversation });
      assert.deepEqual(empty.settings, getCompanionSettings());
      assert.deepEqual([empty.items, empty.cards, empty.goals, empty.activity, empty.brief, empty.catchUp, empty.notes, empty.revision],
        [[], [], [], [], null, null, '', 0]);
      assert.deepEqual([empty.notesRevision, empty.rules, empty.reminders, empty.demotedSubtypes], [0, '', [], []]);
      assert.equal('quietMessageIds' in empty, false, 'retired in v2: nothing in the conversation is hidden');
      assert.deepEqual(empty.counts, { needsYou: 0, newItems: 0, unreadMessages: 0 });
      assert.deepEqual(empty.conversation, conversation);
      assert.deepEqual([empty.welcome, empty.delegations, empty.notesOrigin, empty.checkinChanges],
        [{ wanted: true }, [], 'user', []], 'v2 fields: not met yet, following nothing, nothing changed');

      const item = upsertItem(draft(), T0).item;
      itemIn('dismissed', 'cr:d:mine');
      const card = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Goal' } }, T0);
      proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Old card' } }, T0 - COMPANION_CARD_TTL_MS);
      const goal = addGoal('Ship', T0);
      setNotesByUser('Watch CR-1');
      insertBrief({ date: '2026-11-05', headline: 'Today', cards: [], closing: 'Done.', origin: 'fallback', now: T0 });
      insertBrief({ date: '2026-11-04', headline: 'Yesterday', cards: [], closing: 'Done.', origin: 'llm', now: T0 - 24 * HOUR });
      for (let i = 0; i < 25; i++) recordRun({ kind: 'poll', trigger: 'michi', startedAt: T0 + i, outcome: 'ok', finishedAt: T0 + i });
      const spoke = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 + 30, outcome: 'spoke', finishedAt: T0 + 31 });
      // What the unread badge counts: messages the check-ins posted (DESIGN-v2 §3.8), not runs that spoke.
      recordRunPost(spoke.id, { messageId: companionPostId(spoke.id), at: T0 + 31, changes: [] });
      const change = recordRunChange({ runId: spoke.id, targetKind: 'item', targetId: item.id, action: 'snooze',
        before: { status: 'new', snoozedUntil: null }, after: { status: 'snoozed', snoozedUntil: T0 + HOUR }, reason: 'CR-1 waits on its author', now: T0 + 31 });
      recordRun({ kind: 'wake', trigger: 'now-items', startedAt: T0 + 32, outcome: 'spoke', finishedAt: T0 + 33 });
      bumpRevision();
      const catchUp = { awaySince: T0 - HOUR, returnedAt: T0, changedItemIds: [item.id], line: '1 needs you.' };

      const full = snapshotDto({ now: T0 + MINUTE, conversation: null, catchUp });
      assert.deepEqual(full.items.map((i) => i.id), [item.id]);
      assert.deepEqual(full.counts, { needsYou: 1, newItems: 1, unreadMessages: 1 });
      assert.deepEqual(full.cards.map((c) => c.id), [card.id], 'only cards still waiting on the user');
      assert.equal('reportedAt' in full.cards[0], false, 'the DTO has no internal fields');
      assert.deepEqual(full.goals.map((g) => g.id), [goal.id]);
      assert.deepEqual([full.notes, full.notesRevision], ['Watch CR-1', 1]);
      getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,'Michi assistant',NULL,1,1)").run(ASSISTANT.workspaceId);
      seedConversation({ nodeId: ASSISTANT.nodeId, workspaceId: ASSISTANT.workspaceId, title: 'Companion' });
      getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('m-quiet',?,'assistant','Let me check CR-1 first.',1,?)").run(ASSISTANT.nodeId, T0);
      assert.equal('quietMessageIds' in snapshotDto({ now: T0 + MINUTE, conversation }), false, 'nothing in the conversation is hidden any more');
      assert.equal(full.brief?.headline, 'Today');
      assert.equal(full.activity.length, 20);
      assert.equal(full.activity[0].kind, 'wake', 'newest run first');
      assert.equal(full.activity.find((run) => run.id === spoke.id)?.postedMessageId, companionPostId(spoke.id), 'Activity links a run to its post');
      assert.equal('postedMessageId' in full.activity[0], false, 'a run that posted nothing has no link');
      assert.equal('turnId' in full.activity[0], false);
      assert.equal('messageId' in full.activity[0], false);
      assert.deepEqual(full.catchUp, catchUp);
      assert.equal(full.conversation, null);
      assert.equal(full.revision, 1);
      assert.equal(full.status.lastCheckAt, T0 + 24);
      assert.deepEqual(full.checkinChanges, [{ id: change, runId: spoke.id, targetKind: 'item', targetId: item.id, action: 'snooze',
        reason: 'CR-1 waits on its author', title: item.title, at: T0 + 31, undoneAt: null,
        // The test recorded the snooze without snoozing the item: it is still new, so the change does not stand.
        standing: false, snoozedUntil: T0 + HOUR }], 'what check-ins changed, with the title to show');
    });

    test('welcome: wanted until it is done or the user wrote since the v2 merge (DESIGN-v2 §3.8)', () => {
      getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,'Michi assistant',NULL,1,1)").run(ASSISTANT.workspaceId);
      seedConversation({ nodeId: ASSISTANT.nodeId, workspaceId: ASSISTANT.workspaceId, title: 'Michi' });
      const conversation = { workspaceId: ASSISTANT.workspaceId, nodeId: ASSISTANT.nodeId, assistant: ASSISTANT };
      const welcome = () => snapshotDto({ now: T0, conversation }).welcome;
      getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('m-before',?,'user','From the MVP',1,?)").run(ASSISTANT.nodeId, T0 - HOUR);
      getDb().prepare("INSERT INTO meta(key,value) VALUES ('assistant:v2_merged_at', ?)").run(String(T0 - MINUTE));
      assert.deepEqual(welcome(), { wanted: true }, 'what the user wrote before the merge does not count');
      getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('m-said',?,'assistant','A post',2,?)").run(ASSISTANT.nodeId, T0);
      assert.equal(welcome()?.wanted, true, 'the agent\'s own messages do not count');
      getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('m-hi',?,'user','Hi',3,?)").run(ASSISTANT.nodeId, T0);
      assert.deepEqual(welcome(), { wanted: false }, 'they have met');
      assert.deepEqual(snapshotDto({ now: T0, conversation: null }).welcome, { wanted: true }, 'no conversation, nothing written in it');

      markCompanionWelcomeDone(T0);
      assert.deepEqual(snapshotDto({ now: T0, conversation: null }).welcome, { wanted: false }, 'done');
    });

    test('followed delegations are listed newest first; "Ask before sending" turns auto-send off (DESIGN-v2 §4)', () => {
      // A delegation the MVP left: 0082's default makes it closed, though the MVP never closed it.
      getDb().prepare(`INSERT INTO companion_delegations (id, owner_user_id, workspace_id, node_id, title, created_at)
        VALUES ('cmd-v1', 'local-user', 'ws-1', 'n-v1', 'From the MVP', ?)`).run(T0 - 1);
      assert.deepEqual(snapshotDto({ now: T0, conversation: null }).delegations, [], 'v1 delegations are closed until a v2 hand-off follows them');
      const older = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-1', title: 'Fix the pipeline', now: T0 });
      const newer = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-2', title: 'Review CR-2', now: T0 + 1 });
      recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-3', title: 'Closed', now: T0 + 2 });
      closeDelegation('n-3', T0 + 3, 'idle');
      getDb().prepare("UPDATE companion_delegations SET origin = 'start_conversation', auto_send = 1 WHERE id IN (?, ?)").run(older.id, newer.id);
      const listed = snapshotDto({ now: T0, conversation: null }).delegations!;
      assert.deepEqual(listed.map((d) => [d.id, d.state, d.autoSend, d.origin]), [[newer.id, 'following', true, 'start_conversation'], [older.id, 'following', true, 'start_conversation']]);
      assert.equal('ownerUserId' in listed[0], false);
      assert.equal(stopDelegationAutoSend(older.id)?.autoSend, false);
      assert.equal(stopDelegationAutoSend(older.id)?.autoSend, false, 'twice is harmless');
      assert.deepEqual(snapshotDto({ now: T0, conversation: null }).delegations!.map((d) => d.autoSend), [true, false]);
      assert.equal(stopDelegationAutoSend('cmd-missing'), null);
    });

    test('the default status follows the settings, today\'s runs and the brief time', () => {
      const noon = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
      const settings = getCompanionSettings();
      const status = defaultCompanionStatus({ settings, now: noon, working: false });
      assert.equal(status.state, 'ok');
      assert.deepEqual(status.sources.map((s) => [s.kind, s.state]), COMPANION_CONFIGURABLE_SOURCES.map((kind) => [kind, 'pending']));
      assert.deepEqual(status.auth, { valid: null, expiresAt: null, checkedAt: null });
      assert.deepEqual([status.lastCheckAt, status.nextCheckAt, status.nextHeartbeatAt, status.turnsToday, status.working], [null, null, null, 0, false]);
      // The engine's rule (briefSchedule.ts, B24): no brief before the first welcome, and a welcome after 09:00 is that day's look.
      assert.equal(status.nextBriefAt, new Date(2026, 10, 6, 9, 0, 0, 0).getTime(), 'not met yet at noon: the first brief is Friday\'s');
      markCompanionWelcomeDone(new Date(2026, 10, 5, 10, 30).getTime());
      assert.equal(defaultCompanionStatus({ settings, now: noon, working: false }).nextBriefAt, new Date(2026, 10, 6, 9, 0, 0, 0).getTime(), 'met at 10:30: none today');
      markCompanionWelcomeDone(new Date(2026, 10, 4, 10, 30).getTime());
      assert.equal(defaultCompanionStatus({ settings, now: noon, working: false }).nextBriefAt, new Date(2026, 10, 5, 9, 0, 0, 0).getTime(), 'met yesterday: today\'s is due, not written yet');
      insertBrief({ date: '2026-11-05', headline: 'Today', cards: [], closing: 'Done.', origin: 'fallback', now: noon });
      setCompanionMetaNumber('companion:last_heartbeat_at', noon - 10 * MINUTE);
      recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: noon - 10 * MINUTE, outcome: 'spoke', finishedAt: noon - 9 * MINUTE });
      recordRun({ kind: 'welcome', trigger: 'first-open', startedAt: noon - 8 * MINUTE, outcome: 'spoke', finishedAt: noon - 7 * MINUTE });
      const later = defaultCompanionStatus({ settings, now: noon, working: true,
        sources: { cr: { state: 'ok', lastPolledAt: noon - MINUTE, nextPollAt: noon + 4 * MINUTE }, email: { nextPollAt: noon + MINUTE } } });
      assert.equal(later.nextBriefAt, new Date(2026, 10, 6, 9, 0, 0, 0).getTime(), 'tomorrow once today has one');
      const friday = new Date(2026, 10, 6, 12, 0, 0, 0).getTime();
      insertBrief({ date: '2026-11-06', headline: 'Friday', cards: [], closing: 'Done.', origin: 'fallback', now: friday });
      assert.equal(defaultCompanionStatus({ settings, now: friday, working: false }).nextBriefAt, new Date(2026, 10, 9, 9, 0, 0, 0).getTime(), 'Monday after Friday\'s');
      assert.equal(defaultCompanionStatus({ settings, now: new Date(2026, 10, 7, 8, 0).getTime(), working: false }).nextBriefAt,
        new Date(2026, 10, 9, 9, 0, 0, 0).getTime(), 'none on Saturday');
      assert.equal(later.nextHeartbeatAt, null, 'there is no heartbeat (D3)');
      assert.equal(later.turnsToday, 1, 'the welcome does not count against the budget');
      assert.equal(later.working, true);
      assert.equal(later.nextCheckAt, noon + MINUTE);
      assert.deepEqual(later.sources.find((s) => s.kind === 'cr'), { kind: 'cr', state: 'ok', lastPolledAt: noon - MINUTE, nextPollAt: noon + 4 * MINUTE, detail: null });

      // "checked Nm ago" (W4 failure 3): a quiet poll records no run, so the engine's last good poll of a source counts too;
      // the latest of them and of the recorded polls, never a failed or switched-off source's.
      assert.equal(later.lastCheckAt, noon - MINUTE, 'the CR source\'s good poll, no poll run recorded');
      recordRun({ kind: 'poll', trigger: 'michi', startedAt: noon - 30 * MINUTE, outcome: 'ok', finishedAt: noon - 29 * MINUTE });
      const polled = (sources: Parameters<typeof defaultCompanionStatus>[0]['sources']) => defaultCompanionStatus({ settings, now: noon, working: false, sources }).lastCheckAt;
      assert.equal(polled({}), noon - 29 * MINUTE, 'no live engine: the recorded poll');
      assert.equal(polled({ michi: { state: 'ok', lastPolledAt: noon - 20_000 }, cr: { state: 'ok', lastPolledAt: noon - 5 * MINUTE } }), noon - 20_000, 'the newest good poll');
      assert.equal(polled({ michi: { state: 'error', lastPolledAt: noon - 10_000 }, email: { state: 'disabled', lastPolledAt: noon - 5_000 } }), noon - 29 * MINUTE,
        'a failed or switched-off source\'s poll is no check');

      const degraded = defaultCompanionStatus({ settings, now: noon, working: false, sources: { email: { state: 'unavailable', detail: 'Auth session expired - refresh your credentials' } } });
      assert.equal(degraded.state, 'degraded');
      assert.equal(defaultCompanionStatus({ settings, now: noon, working: false, auth: { valid: false, expiresAt: noon - 1, checkedAt: noon } }).state, 'degraded');
      assert.equal(defaultCompanionStatus({ settings, now: new Date(2026, 10, 5, 22, 0).getTime(), working: false }).state, 'ok', 'no quiet hours (D5)');

      const off = patchCompanionSettings({ sources: { email: { enabled: false } }, paused: true });
      const paused = defaultCompanionStatus({ settings: off, now: noon, working: false, sources: { cr: { nextPollAt: noon + 1 } } });
      assert.equal(paused.state, 'paused');
      assert.equal(paused.sources.find((s) => s.kind === 'email')?.state, 'disabled');
      assert.deepEqual([paused.nextCheckAt, paused.nextHeartbeatAt, paused.nextBriefAt], [null, null, null], 'nothing is scheduled while paused');
      assert.equal(defaultCompanionStatus({ settings: { ...off, enabled: false }, now: noon, working: false }).state, 'paused',
        'the old off switch is Pause Michi: there is no "off" of its own');

      // B2: with every source behind the Auth check off, a stale "expired" is nobody's business.
      const expired = { valid: false, expiresAt: noon - 1, checkedAt: noon };
      const michiOnly = patchCompanionSettings({ paused: false, sources: { cr: { enabled: false }, pipeline: { enabled: false }, calendar: { enabled: false } } });
      const unwatched = defaultCompanionStatus({ settings: michiOnly, now: noon, working: false, auth: expired });
      assert.deepEqual(unwatched.auth, { valid: null, expiresAt: null, checkedAt: null });
      assert.equal(unwatched.state, 'ok', 'not degraded by a session nothing uses');
      const withCr = patchCompanionSettings({ sources: { cr: { enabled: true } } });
      assert.deepEqual(defaultCompanionStatus({ settings: withCr, now: noon, working: false, auth: expired }).auth, expired);
    });
  });
});
