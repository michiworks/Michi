import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The Companion state the user owns or reads (DESIGN R2.8-R2.10, R2.12):
 * notes with their revision (the user's edit always wins; the Companion's
 * write must name the revision it read), the user's rules and their
 * fail-closed read, reminders and watches, subtype demotions, viewing (unread
 * posts, the "Since you left" catch-up), ratings (conv-1: one version's,
 * too_noisy counted from the last undo), and the privacy retention pass
 * (tool outputs kept in the Companion's conversations included, V's current
 * and archived ones too). Temp MICHI_DATA_DIR per test.
 */

// Must stay first: the assistant store loads agentConfig, which resolves config.json as it loads.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_LIMITS, checkinNodeId, companionPostId } from 'michi-shared';
import { assistantPurposeKey, assistantPurposeOf } from '../src/assistant/identity';
import { ensureAssistant, resetAssistant } from '../src/assistant/store';
import { closeDb, getDb, initDb } from '../src/services/db';
import { CompanionError } from '../src/services/companion/errors';
import {
  COMPANION_PURGED_TOOL_OUTPUT,
  ackNotice,
  applyItemAction,
  buildCatchUp,
  cancelReminder,
  clearSubtypeDemotion,
  countOpenReminders,
  countUnreadMessages,
  createReminder,
  decideCard,
  demoteSubtype,
  getBrief,
  getCard,
  getCompanionMeta,
  getCompanionNotesState,
  getCompanionRules,
  getItem,
  getReminder,
  getRun,
  getSnapshots,
  insertBrief,
  insertCard,
  insertNotice,
  isSubtypeDemoted,
  latestCatchUp,
  listDemotedSubtypes,
  listItemEvents,
  listOpenItems,
  listReminders,
  listUnescalatedItems,
  listUnnotifiedNowItems,
  markReminderFired,
  pendingNotices,
  purgeCompanionToolOutputs,
  purgeExpired,
  putSnapshots,
  readCompanionRules,
  recordCompanionView,
  recordRun,
  recordRunChange,
  recordRunPost,
  reminderDto,
  resolveItems,
  setCompanionMeta,
  setCompanionNotesOrigin,
  setCompanionRules,
  setNotesByCompanion,
  setNotesByUser,
  setReminderStatus,
  setRunCheckinNode,
  snapshotDto,
  startRun,
  upsertItem,
} from '../src/services/companion/repository';
import { fireDueReminders, watchReached } from '../src/services/companion/remindersEngine';
import { patchCompanionSettings } from '../src/services/companion/settings';
import { localDateKey } from '../src/services/companion/clock';
import type { ItemDraft } from '../src/services/companion/types';
import { seedConversation } from './helpers/homeConversations';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function draft(itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr',
    subtype: 'cr_needs_attention',
    itemKey,
    version: 'v1',
    bucket: 'needs_you',
    severity: 'now',
    title: `${itemKey} needs attention`,
    summary: 'A private summary',
    target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: { subject: 'private' },
    observedAt: T0,
    ...overrides,
  };
}

const companionError = (status: number, code: string, message?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof CompanionError, String(error));
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  return true;
};

/** A conversation of the assistant's workspace recorded 'companion' in meta, as the MVP's was (and each check-in node is); returns its node id. */
function conversation(nodeId: string): string {
  seedConversation({ nodeId, workspaceId: ensureAssistant().workspaceId, title: 'Companion' });
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(nodeId), 'companion');
  return nodeId;
}

describe('Companion user state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-user-state-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('notes (R2.9)', () => {
    test('every write bumps the revision; the user\'s edit wins whatever revision it is at', () => {
      assert.deepEqual(getCompanionNotesState(), { notes: '', notesRevision: 0, origin: 'user' });
      assert.deepEqual(setNotesByUser('  Line one\r\nLine two  '), { notes: 'Line one\nLine two', notesRevision: 1, origin: 'user' }, 'line breaks kept, CRLF folded, trimmed');
      assert.deepEqual(setNotesByCompanion('Companion notes', 1), { notes: 'Companion notes', notesRevision: 2, origin: 'checkin' });
      assert.deepEqual(setNotesByUser('Mine again'), { notes: 'Mine again', notesRevision: 3, origin: 'user' });
      assert.deepEqual(setNotesByUser(''), { notes: '', notesRevision: 4, origin: 'user' }, 'empty clears them, and still counts as a write');
      assert.equal(getCompanionMeta('companion:notes'), null);
      assert.equal(setNotesByUser('x'.repeat(COMPANION_LIMITS.maxNotesChars)).notes.length, COMPANION_LIMITS.maxNotesChars);
    });

    test('the Companion cannot overwrite notes that changed since it read them', () => {
      setNotesByUser('The user\'s notes');
      assert.throws(() => setNotesByCompanion('My stale notes', 0), companionError(409, 'notes_conflict', /notes changed; read them again/));
      assert.deepEqual(getCompanionNotesState(), { notes: 'The user\'s notes', notesRevision: 1, origin: 'user' }, 'nothing written');
      for (const bad of ['1', -1, 1.5, null, undefined]) {
        assert.throws(() => setNotesByCompanion('x', bad), companionError(400, 'invalid_request'), String(bad));
      }
      assert.throws(() => setNotesByUser('x'.repeat(COMPANION_LIMITS.maxNotesChars + 1)), companionError(400, 'invalid_request'));
      assert.throws(() => setNotesByUser(5), companionError(400, 'invalid_request'));
      assert.throws(() => setNotesByCompanion('x'.repeat(COMPANION_LIMITS.maxNotesChars + 1), 1), companionError(400, 'invalid_request'));
      assert.equal(getCompanionNotesState().notesRevision, 1, 'refused writes do not count');
    });

    test('who wrote them: a check-in\'s write is `checkin` unless its turn says otherwise; only the user\'s edit makes them `user` again (DESIGN-v2 §2.8 T1)', () => {
      setNotesByUser('Mine');
      assert.equal(setNotesByCompanion('From a check-in', 1).origin, 'checkin', 'absent, the safe side: kept out of the conversation context');
      assert.equal(setNotesByCompanion('From a clean user turn', 2, 'user').origin, 'user');
      assert.throws(() => setNotesByCompanion('x', 3, 'model' as never), companionError(400, 'invalid_request'));
      assert.equal(getCompanionNotesState().notesRevision, 3, 'an unknown origin writes nothing');
      setCompanionNotesOrigin('checkin');
      assert.deepEqual(getCompanionNotesState(), { notes: 'From a clean user turn', notesRevision: 3, origin: 'checkin' }, 'the v2 migration marks the MVP\'s notes without touching them');
      assert.equal(snapshotDto({ now: T0, conversation: null }).notesOrigin, 'checkin');
      assert.equal(setNotesByUser('Mine again').origin, 'user');
      setCompanionMeta('companion:notes_origin', 'garbage');
      assert.equal(getCompanionNotesState().origin, 'checkin', 'an unreadable origin is not trusted as the user\'s');
    });
  });

  describe('rules (R2.9)', () => {
    test('kept as the user wrote them, at most 2000 characters; empty clears them', () => {
      assert.deepEqual(readCompanionRules(), { ok: true, rules: '' });
      assert.equal(setCompanionRules('  Never ping me before 10:00\r\nNo email at weekends '), 'Never ping me before 10:00\nNo email at weekends');
      assert.deepEqual(readCompanionRules(), { ok: true, rules: 'Never ping me before 10:00\nNo email at weekends' });
      assert.equal(getCompanionRules(), 'Never ping me before 10:00\nNo email at weekends');
      assert.equal(snapshotDto({ now: T0, conversation: null }).rules, 'Never ping me before 10:00\nNo email at weekends');
      assert.throws(() => setCompanionRules('x'.repeat(COMPANION_LIMITS.maxRulesChars + 1)), companionError(400, 'invalid_request'));
      assert.throws(() => setCompanionRules(['no']), companionError(400, 'invalid_request'));
      assert.equal(getCompanionRules(), 'Never ping me before 10:00\nNo email at weekends', 'a refused write changes nothing');
      assert.equal(setCompanionRules(''), '');
      assert.equal(getCompanionMeta('companion:rules'), null);
    });

    test('a read that fails says so (fail closed), and the snapshot shows no rules rather than broken ones', () => {
      setCompanionMeta('companion:rules', 'x'.repeat(COMPANION_LIMITS.maxRulesChars + 1));
      const tooLong = readCompanionRules();
      assert.equal(tooLong.ok, false);
      assert.match(!tooLong.ok ? tooLong.error : '', /longer than rules can be/);
      assert.equal(getCompanionRules(), '');
      assert.equal(snapshotDto({ now: T0, conversation: null }).rules, '');

      setCompanionRules('Be brief');
      const db = getDb();
      const prepare = db.prepare;
      db.prepare = (() => { throw new Error('database disk image is malformed'); }) as typeof db.prepare;
      try {
        assert.deepEqual(readCompanionRules(), { ok: false, error: 'database disk image is malformed' });
        assert.equal(getCompanionRules(), '');
      } finally {
        db.prepare = prepare;
      }
      assert.deepEqual(readCompanionRules(), { ok: true, rules: 'Be brief' });
    });
  });

  describe('reminders and watches (R2.9)', () => {
    test('a one-off, a daily and a watch; listed oldest first; the DTO has no internal fields', () => {
      const cr = upsertItem(draft('cr:CR-1:mine'), T0).item;
      const once = createReminder({ text: ' Call\nthe vet ', at: T0 + HOUR }, T0);
      assert.match(once.id, /^cmrm-/);
      assert.deepEqual([once.kind, once.text, once.at, once.dailyAt, once.itemId, once.until, once.status, once.createdAt, once.firedAt, once.lastFiredDate],
        ['time', 'Call the vet', T0 + HOUR, null, null, null, 'active', T0, null, null]);
      const daily = createReminder({ text: 'Stand up', dailyAt: '09:30', itemId: null }, T0 + 1);
      assert.deepEqual([daily.kind, daily.at, daily.dailyAt], ['time', null, '09:30']);
      const about = createReminder({ text: 'Look at CR-1 again', at: T0 + 2 * HOUR, itemId: cr.id }, T0 + 2);
      assert.equal(about.itemId, cr.id, 'a time reminder may name an item');
      const watch = createReminder({ text: 'When CR-1 is approved', itemId: cr.id, until: 'approved' }, T0 + 3);
      assert.deepEqual([watch.kind, watch.at, watch.dailyAt, watch.itemId, watch.until], ['watch', null, null, cr.id, 'approved']);
      assert.deepEqual(listReminders().map((reminder) => reminder.id), [once.id, daily.id, about.id, watch.id]);
      assert.equal(countOpenReminders(), 4);
      assert.equal('lastFiredDate' in reminderDto(once), false);
      assert.deepEqual(snapshotDto({ now: T0 + 4, conversation: null }).reminders, listReminders().map(reminderDto));
    });

    test('what a reminder or watch must be: words, exactly one time, a reachable state, an existing item', () => {
      const cr = upsertItem(draft('cr:CR-1:mine'), T0).item;
      const pipeline = upsertItem(draft('pipeline:P', { source: 'pipeline', subtype: 'pipeline_blocked' }), T0).item;
      const meeting = upsertItem(draft('calendar:standup', { source: 'calendar', subtype: 'meeting_soon' }), T0).item;
      const cases: Array<[Record<string, unknown>, number, string, RegExp]> = [
        [{ text: '', at: T0 + HOUR }, 400, 'invalid_request', /cannot be empty/],
        [{ text: 7, at: T0 + HOUR }, 400, 'invalid_request', /is text/],
        [{ text: 'x'.repeat(501), at: T0 + HOUR }, 400, 'invalid_request', /at most 500/],
        [{ text: 'x' }, 400, 'invalid_request', /either at/],
        [{ text: 'x', at: T0 + HOUR, dailyAt: '09:00' }, 400, 'invalid_request', /either at/],
        [{ text: 'x', at: T0 }, 400, 'invalid_request', /future time/],
        [{ text: 'x', at: T0 + 0.5 }, 400, 'invalid_request', /future time/],
        [{ text: 'x', at: T0 + 367 * DAY }, 400, 'invalid_request', /a year ahead/],
        [{ text: 'x', dailyAt: '9:00' }, 400, 'invalid_request', /HH:MM/],
        [{ text: 'x', dailyAt: '24:00' }, 400, 'invalid_request', /HH:MM/],
        [{ text: 'x', until: 'approved' }, 400, 'invalid_request', /needs the itemId/],
        [{ text: 'x', itemId: cr.id, until: 'shipped' }, 400, 'invalid_request', /until must be one of/],
        [{ text: 'x', itemId: cr.id, until: 'approved', at: T0 + HOUR }, 400, 'invalid_request', /no time/],
        [{ text: 'x', itemId: pipeline.id, until: 'approved' }, 400, 'invalid_request', /pipeline item can be watched until: recovered/],
        [{ text: 'x', itemId: meeting.id, until: 'read' }, 400, 'invalid_request', /calendar item cannot be watched/],
        [{ text: 'x', itemId: 'cmi-missing', at: T0 + HOUR }, 404, 'not_found', /does not exist/],
        [{ text: 'x', itemId: 42, at: T0 + HOUR }, 400, 'invalid_request', /Companion item id/],
      ];
      for (const [input, status, code, message] of cases) {
        assert.throws(() => createReminder(input, T0), companionError(status, code, message), JSON.stringify(input));
      }
      assert.equal(countOpenReminders(), 0);
      assert.equal(createReminder({ text: 'x', itemId: pipeline.id, until: 'recovered' }, T0).until, 'recovered');
      assert.equal(createReminder({ text: 'x', at: T0 + 366 * DAY }, T0).at, T0 + 366 * DAY, 'a year ahead is fine');
    });

    test('pause, resume and cancel; a closed reminder cannot be reopened; at most 20 open at once', () => {
      const once = createReminder({ text: 'Once', at: T0 + HOUR }, T0);
      assert.equal(setReminderStatus(once.id, 'paused').status, 'paused');
      assert.deepEqual(listReminders(['paused']).map((reminder) => reminder.id), [once.id]);
      assert.equal(setReminderStatus(once.id, 'active').status, 'active');
      assert.throws(() => setReminderStatus(once.id, 'fired' as never), companionError(400, 'invalid_request'));
      assert.throws(() => setReminderStatus('cmrm-missing', 'paused'), companionError(404, 'not_found'));
      assert.equal(cancelReminder(once.id).status, 'cancelled');
      assert.equal(cancelReminder(once.id).status, 'cancelled', 'idempotent');
      assert.throws(() => setReminderStatus(once.id, 'active'), companionError(409, 'reminder_closed', /already cancelled/));
      assert.throws(() => cancelReminder('cmrm-missing'), companionError(404, 'not_found'));
      assert.deepEqual(listReminders(), []);
      assert.deepEqual(listReminders(['cancelled']).map((reminder) => reminder.id), [once.id]);
      assert.deepEqual(listReminders([]), []);

      const open = Array.from({ length: COMPANION_LIMITS.maxReminders }, (_, i) => createReminder({ text: `R${i}`, at: T0 + HOUR + i }, T0 + i));
      assert.throws(() => createReminder({ text: 'One too many', at: T0 + HOUR }, T0), companionError(409, 'limit_reached', /at most 20/));
      setReminderStatus(open[0].id, 'paused');
      assert.throws(() => createReminder({ text: 'Paused ones count', at: T0 + HOUR }, T0), companionError(409, 'limit_reached'));
      cancelReminder(open[0].id);
      assert.equal(createReminder({ text: 'A slot is free', at: T0 + HOUR }, T0).status, 'active');
    });

    test('firing: a one-off reminder and a watch end fired; a daily one stays active and records the day', () => {
      const cr = upsertItem(draft('cr:CR-1:mine'), T0).item;
      const once = createReminder({ text: 'Once', at: T0 + HOUR }, T0);
      const daily = createReminder({ text: 'Daily', dailyAt: '09:00' }, T0 + 1);
      const watch = createReminder({ text: 'Watch', itemId: cr.id, until: 'merged' }, T0 + 2);
      const paused = createReminder({ text: 'Paused', at: T0 + HOUR }, T0 + 3);
      setReminderStatus(paused.id, 'paused');

      assert.deepEqual([markReminderFired(once.id, T0 + HOUR)?.status, getReminder(once.id)?.firedAt], ['fired', T0 + HOUR]);
      assert.equal(markReminderFired(once.id, T0 + HOUR + 1), null, 'fires once');
      const firedDaily = markReminderFired(daily.id, T0 + 2 * HOUR)!;
      assert.deepEqual([firedDaily.status, firedDaily.firedAt, firedDaily.lastFiredDate], ['active', T0 + 2 * HOUR, localDateKey(T0)]);
      assert.equal(markReminderFired(daily.id, T0 + DAY)?.lastFiredDate, localDateKey(T0 + DAY));
      assert.equal(markReminderFired(watch.id, T0 + 3 * HOUR)?.status, 'fired');
      assert.equal(markReminderFired(paused.id, T0 + HOUR), null, 'a paused reminder does not fire');
      assert.equal(markReminderFired('cmrm-missing', T0), null);
      assert.throws(() => setReminderStatus(once.id, 'paused'), companionError(409, 'reminder_closed', /already fired/));
      assert.deepEqual(listReminders().map((reminder) => reminder.id), [daily.id, paused.id]);
    });
  });

  test('demotions: a subtype is demoted once, listed in subtype order and undone by Settings', () => {
    assert.deepEqual(listDemotedSubtypes(), []);
    assert.equal(demoteSubtype('pipeline_blocked', T0), true);
    assert.equal(demoteSubtype('pipeline_blocked', T0 + 1), false, 'already demoted');
    assert.equal(demoteSubtype('cr_needs_attention', T0), true);
    assert.equal(isSubtypeDemoted('pipeline_blocked'), true);
    assert.deepEqual(listDemotedSubtypes(), ['cr_needs_attention', 'pipeline_blocked']);
    assert.deepEqual(snapshotDto({ now: T0, conversation: null }).demotedSubtypes, ['cr_needs_attention', 'pipeline_blocked']);
    assert.equal(clearSubtypeDemotion('pipeline_blocked'), true);
    assert.equal(clearSubtypeDemotion('pipeline_blocked'), false);
    assert.deepEqual(listDemotedSubtypes(), ['cr_needs_attention']);
    assert.throws(() => demoteSubtype('cr_exploded' as never, T0), companionError(400, 'invalid_request'));
    assert.throws(() => clearSubtypeDemotion('cr_exploded' as never), companionError(400, 'invalid_request'));
  });

  describe('ratings (conv-1)', () => {
    const noisy = (key: string, at: number) => applyItemAction(upsertItem(draft(key), T0).item.id, { action: 'feedback', feedback: 'down', reason: 'too_noisy' }, at);

    test('a rating is for the version it was given on: a new version shows none, and the old one is still counted', () => {
      const item = upsertItem(draft('cr:rated:mine'), T0).item;
      assert.equal(applyItemAction(item.id, { action: 'feedback', feedback: 'up' }, T0 + 1).feedback, 'up');
      assert.equal(upsertItem(draft('cr:rated:mine'), T0 + 2).item.feedback, 'up', 'the same version keeps it');
      const v2 = upsertItem(draft('cr:rated:mine', { version: 'v2' }), T0 + 3).item;
      assert.deepEqual([v2.feedback, v2.feedbackReason], [null, null], 'v2 was never rated');
      assert.equal(getDb().prepare('SELECT feedback_version FROM companion_items WHERE id = ?').get(item.id)!.feedback_version, 'v1');
      const rated = applyItemAction(item.id, { action: 'feedback', feedback: 'down', reason: 'too_early' }, T0 + 4);
      assert.deepEqual([rated.feedback, rated.feedbackReason], ['down', 'too_early'], 'rating v2 is shown on v2');
      assert.equal(getItem(item.id)!.feedback, 'down');
    });

    test('too noisy demotes on the second object; after the user undoes it, the count starts again from the undo', () => {
      noisy('cr:a:mine', T0 + 1);
      noisy('cr:b:mine', T0 + 2);
      assert.equal(isSubtypeDemoted('cr_needs_attention'), true);
      assert.equal(clearSubtypeDemotion('cr_needs_attention', T0 + 10), true);
      assert.equal(getCompanionMeta('companion:noisy_reset:cr_needs_attention'), String(T0 + 10));
      noisy('cr:c:mine', T0 + 11);
      assert.equal(isSubtypeDemoted('cr_needs_attention'), false, 'the two ratings before the undo no longer count');
      noisy('cr:d:mine', T0 + 12);
      assert.equal(isSubtypeDemoted('cr_needs_attention'), true, 'two new ones demote it again');
      assert.equal(clearSubtypeDemotion('cr_needs_attention', T0 + 20), true);
      assert.equal(clearSubtypeDemotion('cr_needs_attention', T0 + 30), false, 'nothing to undo: the reset stays where it was');
      assert.equal(getCompanionMeta('companion:noisy_reset:cr_needs_attention'), String(T0 + 20));
    });
  });

  describe('viewing (R2.8, R2.12)', () => {
    test('messages the check-ins posted after the user last looked are unread; runs that posted nothing and polls never are', () => {
      const post = (kind: 'heartbeat' | 'brief' | 'welcome' | 'wake', at: number, outcome: 'spoke' | 'quiet' = 'spoke') => {
        const run = recordRun({ kind, trigger: 'schedule', startedAt: at - 1000, outcome, finishedAt: at });
        if (outcome === 'spoke') recordRunPost(run.id, { messageId: companionPostId(run.id), at, changes: [] });
        return run;
      };
      assert.equal(countUnreadMessages(), 0);
      post('heartbeat', T0 - 2 * HOUR);
      post('wake', T0 - 2 * HOUR, 'quiet');
      recordRun({ kind: 'brief', trigger: 'schedule', startedAt: T0 - 2 * HOUR, outcome: 'spoke', finishedAt: T0 - 2 * HOUR + 1000 });
      recordRun({ kind: 'poll', trigger: 'cr', startedAt: T0 - 2 * HOUR, outcome: 'ok', finishedAt: T0 - 2 * HOUR + 1000 });
      assert.equal(countUnreadMessages(), 1, 'never viewed: every post is unread; a run that spoke but posted nothing is not');
      const first = recordCompanionView(T0 - HOUR);
      assert.deepEqual(first, { previousViewedAt: null, catchUp: null, hadUnread: true }, 'the first look has nothing to catch up on');
      assert.equal(countUnreadMessages(), 0);
      post('brief', T0 - 29 * MINUTE);
      post('welcome', T0 - 19 * MINUTE);
      assert.equal(countUnreadMessages(), 2);
      assert.equal(snapshotDto({ now: T0, conversation: null }).counts.unreadMessages, 2);
      const again = recordCompanionView(T0 - 10 * MINUTE);
      assert.deepEqual(again, {
        previousViewedAt: T0 - HOUR,
        catchUp: { awaySince: T0 - HOUR, returnedAt: T0 - 10 * MINUTE, changedItemIds: [], line: 'Nothing new since 11:00.' },
        hadUnread: true,
      }, 'away 50 minutes, and nothing changed in the feed');
      assert.equal(recordCompanionView(T0 - 5 * MINUTE).hadUnread, false);
    });

    test('back after half an hour or more: "Since you left" lists what was created, changed or reopened and is still open', () => {
      const before = upsertItem(draft('cr:before:mine'), T0 - 3 * HOUR).item;
      const changed = upsertItem(draft('cr:changed:mine'), T0 - 3 * HOUR).item;
      const reopened = upsertItem(draft('cr:reopened:mine'), T0 - 3 * HOUR).item;
      resolveItems([reopened.id], T0 - 2 * HOUR);
      recordCompanionView(T0 - HOUR);

      upsertItem(draft('cr:baseline:mine'), T0 - 50 * MINUTE, { baseline: true });
      const update = upsertItem(draft('pipeline:P', { source: 'pipeline', subtype: 'pipeline_recovered', bucket: 'update', severity: 'digest' }), T0 - 45 * MINUTE).item;
      const needs = upsertItem(draft('cr:needs:mine'), T0 - 40 * MINUTE).item;
      const dismissed = upsertItem(draft('cr:dismissed:mine'), T0 - 35 * MINUTE).item;
      applyItemAction(dismissed.id, { action: 'dismiss' }, T0 - 34 * MINUTE);
      upsertItem(draft('cr:changed:mine', { version: 'v2' }), T0 - 30 * MINUTE);
      upsertItem(draft('cr:reopened:mine', { version: 'v2' }), T0 - 25 * MINUTE);

      const view = recordCompanionView(T0);
      assert.equal(view.previousViewedAt, T0 - HOUR);
      assert.deepEqual(view.catchUp, {
        awaySince: T0 - HOUR,
        returnedAt: T0,
        changedItemIds: [reopened.id, changed.id, needs.id, update.id],
        line: '4 updates, 3 need you.',
      }, 'newest change first; not the item from before, the baseline sighting or the dismissed one');
      assert.equal(view.catchUp?.changedItemIds.includes(before.id), false);
      assert.deepEqual(latestCatchUp(T0 + 10 * MINUTE), view.catchUp, 'kept for the snapshot');
      assert.deepEqual(snapshotDto({ now: T0 + 10 * MINUTE, conversation: null }).catchUp, view.catchUp);
      assert.equal(latestCatchUp(T0 + 30 * MINUTE), null, 'for half an hour');
      assert.equal(latestCatchUp(T0 - 1), null);

      const soon = recordCompanionView(T0 + 20 * MINUTE);
      assert.equal(soon.catchUp, null, 'away 20 minutes: no catch-up');
      assert.deepEqual(latestCatchUp(T0 + 25 * MINUTE), view.catchUp, 'the stored one is not replaced');
      setCompanionMeta('companion:catch_up', '{broken');
      assert.equal(latestCatchUp(T0 + 25 * MINUTE), null);
    });

    test('the catch-up line counts updates and what needs the user', () => {
      const at = (minutes: number) => T0 + minutes * MINUTE;
      upsertItem(draft('cr:a:mine'), at(1));
      upsertItem(draft('cr:b:mine'), at(2));
      upsertItem(draft('pipeline:c', { source: 'pipeline', subtype: 'pipeline_recovered', bucket: 'update', severity: 'digest' }), at(3));
      upsertItem(draft('pipeline:d', { source: 'pipeline', subtype: 'pipeline_recovered', bucket: 'update', severity: 'digest' }), at(4));
      const line = (from: number, to: number) => buildCatchUp(at(from), at(to)).line;
      assert.equal(line(0, 1), '1 thing needs you.');
      assert.equal(line(0, 2), '2 things need you.');
      assert.equal(line(2, 3), '1 update.');
      assert.equal(line(2, 4), '2 updates.');
      assert.equal(line(1, 3), '2 updates, 1 needs you.');
      assert.equal(line(0, 4), '4 updates, 2 need you.');
      assert.equal(line(5, 6), 'Nothing new since 12:05.');
      assert.deepEqual(buildCatchUp(at(5), at(6)).changedItemIds, []);
    });
  });

  test('purgeExpired keeps only what retention allows (R2.10), and a second pass finds nothing', () => {
    const ago = (days: number, extra = 0) => T0 - days * DAY + extra;
    const email = (key: string, at: number) => upsertItem(draft(key, { source: 'email', subtype: 'email_unread', title: 'Re: salary review' }), at).item;
    const emailOld = email('email:old', ago(10));
    resolveItems([emailOld.id], ago(8));
    const emailRecent = email('email:recent', ago(10));
    resolveItems([emailRecent.id], ago(6));
    const emailOpen = email('email:open', ago(20));
    const meeting = upsertItem(draft('calendar:1on1', { source: 'calendar', subtype: 'meeting_soon', title: '1:1 about leaving' }), ago(9)).item;
    applyItemAction(meeting.id, { action: 'dismiss' }, ago(8));
    const crOld = upsertItem(draft('cr:old:mine'), ago(40)).item;
    resolveItems([crOld.id], ago(35));

    const ackedOld = insertNotice({ title: 'Companion', body: 'Old', target: { kind: 'settings' }, itemIds: [], now: ago(9) });
    ackNotice(ackedOld.id, ago(8));
    insertNotice({ title: 'Companion', body: 'Expired', target: { kind: 'settings' }, itemIds: [], now: ago(8) });
    const ackedRecent = insertNotice({ title: 'Companion', body: 'Recent', target: { kind: 'settings' }, itemIds: [], now: ago(2) });
    ackNotice(ackedRecent.id, ago(2));
    const pending = insertNotice({ title: 'Companion', body: 'Pending', target: { kind: 'settings' }, itemIds: [], now: T0 - HOUR });

    const oldPoll = recordRun({ kind: 'poll', trigger: 'cr', startedAt: ago(40), outcome: 'ok', finishedAt: ago(40, 1) });
    // A check-in whose native record is still to be discarded (DESIGN-v2 §3.7).
    const oldPending = recordRun({ kind: 'wake', trigger: 'now-items', startedAt: ago(40), outcome: 'quiet', finishedAt: ago(40, 1), detail: 'about CR-9' });
    setRunCheckinNode(oldPending.id, checkinNodeId(oldPending.id));
    const oldQuiet = recordRun({ kind: 'wake', trigger: 'now-items', startedAt: ago(40), outcome: 'quiet', finishedAt: ago(40, 1), messageId: 'm-old' });
    const oldPreempted = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: ago(31), outcome: 'preempted', finishedAt: ago(31, 1), messageId: 'm-cut' });
    const oldChange = recordRunChange({ runId: oldPending.id, targetKind: 'item', targetId: emailOpen.id, action: 'snooze',
      before: { status: 'new', snoozedUntil: null }, after: { status: 'snoozed', snoozedUntil: ago(39) }, reason: 'Waiting on the salary review', now: ago(40) });
    recordRunChange({ runId: oldQuiet.id, targetKind: 'item', targetId: emailOpen.id, action: 'snooze',
      before: null, after: null, reason: 'Gone with its run', now: ago(40) });
    const oldRunning = startRun({ kind: 'brief', trigger: 'schedule', startedAt: ago(40) });
    const recentPoll = recordRun({ kind: 'poll', trigger: 'cr', startedAt: ago(1), outcome: 'ok', finishedAt: ago(1, 1) });

    const oldCard = insertCard({ kind: 'goal.add', payload: { text: 'x' }, summary: 'Add a goal: "x"', reason: null, now: ago(40) });
    decideCard(oldCard.id, 'dismissed', ago(39));
    const oldPendingCard = insertCard({ kind: 'goal.add', payload: { text: 'y' }, summary: 'Add a goal: "y"', reason: null, now: ago(40) });
    const recentCard = insertCard({ kind: 'goal.add', payload: { text: 'z' }, summary: 'Add a goal: "z"', reason: null, now: ago(1) });
    decideCard(recentCard.id, 'applied', ago(1));

    const oldBrief = insertBrief({ date: '2026-09-30', headline: 'Old', cards: [], closing: 'Done.', origin: 'fallback', now: ago(36) })!;
    const recentBrief = insertBrief({ date: '2026-11-04', headline: 'Recent', cards: [], closing: 'Done.', origin: 'fallback', now: ago(1) })!;

    const oldFired = createReminder({ text: 'Old one-off', at: ago(39) }, ago(40));
    markReminderFired(oldFired.id, ago(39));
    const oldCancelled = cancelReminder(createReminder({ text: 'Old cancelled', at: ago(39) }, ago(40)).id);
    const oldDaily = createReminder({ text: 'Daily', dailyAt: '09:00' }, ago(40));
    const recentFired = createReminder({ text: 'Recent one-off', at: ago(1) }, ago(2));
    markReminderFired(recentFired.id, ago(1));

    const result = purgeExpired(T0);
    assert.deepEqual(result, { items: 2, events: 5, notices: 2, runs: 3, cards: 1, briefs: 1, reminders: 2, snapshots: 0 });

    // Email and calendar items closed a week ago keep only their key and version.
    for (const [item, title] of [[emailOld, 'Email thread'], [meeting, 'Calendar event']] as const) {
      const purged = getItem(item.id)!;
      assert.deepEqual([purged.title, purged.summary, purged.facts, purged.target, purged.itemKey, purged.version], [title, null, {}, null, item.itemKey, 'v1']);
      assert.ok(listItemEvents(item.id).every((event) => event.summary === null), title);
    }
    for (const kept of [emailRecent, emailOpen]) {
      assert.equal(getItem(kept.id)!.title, 'Re: salary review');
      assert.ok(listItemEvents(kept.id).some((event) => event.summary !== null));
    }
    assert.equal(getItem(crOld.id)!.title, 'cr:old:mine needs attention', 'other sources keep their text');
    assert.ok(listItemEvents(crOld.id).every((event) => event.summary === null), 'but events older than 30 days lose their summary');

    assert.deepEqual(pendingNotices(T0).map((notice) => notice.id), [pending.id]);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM companion_notices').get()!.n, 2, 'the recently acknowledged one stays a while');
    assert.equal(ackNotice(ackedOld.id, T0), 'missing');
    assert.equal(ackNotice(ackedRecent.id, T0), 'already');

    assert.equal(getRun(oldPoll.id), null);
    assert.equal(getRun(oldQuiet.id), null, 'no message is hidden any more, so naming one keeps nothing (v2 retired quietMessageIds)');
    assert.equal(getRun(oldPreempted.id), null);
    assert.deepEqual([getRun(oldPending.id)?.checkinNodeId, getRun(oldPending.id)?.detail], [checkinNodeId(oldPending.id), null],
      'a check-in still to be discarded keeps its row for boot cleanup, not its words');
    assert.equal(getRun(oldRunning.id)?.outcome, 'running');
    assert.ok(getRun(recentPoll.id));
    const changes = getDb().prepare('SELECT id, reason FROM companion_run_changes ORDER BY id').all().map((row) => ({ ...row }));
    assert.deepEqual(changes, [{ id: oldChange, reason: null }], 'a change keeps its undo state without its reason; a deleted run\'s changes go with it');

    assert.equal(getCard(oldCard.id), null);
    assert.equal(getCard(oldPendingCard.id)?.status, 'pending');
    assert.ok(getCard(recentCard.id));
    assert.equal(getBrief(oldBrief.id), null);
    assert.ok(getBrief(recentBrief.id));
    assert.equal(getReminder(oldFired.id), null);
    assert.equal(getReminder(oldCancelled.id), null);
    assert.equal(getReminder(oldDaily.id)?.status, 'active');
    assert.ok(getReminder(recentFired.id));

    assert.deepEqual(purgeExpired(T0), { items: 0, events: 0, notices: 0, runs: 0, cards: 0, briefs: 0, reminders: 0, snapshots: 0 });
    // An email that comes back gets its words back with it.
    assert.equal(upsertItem(draft('email:old', { source: 'email', subtype: 'email_unread', title: 'Re: salary review' }), T0).item.title, 'Re: salary review');
  });

  test('what the Companion\'s tools read goes from its conversations\' messages after privacyTtlDays, V\'s current and archived included; the rest of each message stays (B18)', () => {
    const ago = (days: number) => T0 - days * DAY;
    const before = ensureAssistant().nodeId;
    const current = resetAssistant().info.nodeId;
    assert.notEqual(current, before, 'New conversation archived the first V');
    assert.deepEqual([assistantPurposeOf(before), assistantPurposeOf(current)], ['main', 'main']);
    const mvp = conversation('n-companion-mvp');
    getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws-work','Work',NULL,1,1)").run();
    seedConversation({ nodeId: 'n-work', workspaceId: 'ws-work', title: 'Work' });
    const calls = [
      { id: 'c-1', title: 'companion_email_search', status: 'completed', inputJson: '{"query":"salary"}', output: 'Email from Alice — Re: salary review — the preview', startedAt: 1, endedAt: 2 },
      { id: 'c-2', title: 'companion_items', status: 'completed' },
      { id: 'c-3', title: 'companion_cr_detail', status: 'failed', output: '' },
    ];
    let seq = 10;
    const message = (id: string, nodeId: string, createdAt: number, toolCalls: unknown) => {
      getDb().prepare("INSERT INTO messages(id,node_id,role,content,tool_calls,seq,created_at) VALUES (?,?,'assistant','CR-1 needs you.',?,?,?)")
        .run(id, nodeId, toolCalls === null ? null : JSON.stringify(toolCalls), seq++, createdAt);
    };
    message('m-old', current, ago(8), calls);
    message('m-recent', current, ago(6), calls);
    message('m-before-reset', before, ago(20), calls);
    message('m-mvp', mvp, ago(30), calls);
    message('m-work', 'n-work', ago(30), calls);
    message('m-none', current, ago(30), null);
    message('m-odd', current, ago(30), { output: 'not a list' });
    const row = (id: string) => getDb().prepare('SELECT content, tool_calls FROM messages WHERE id = ?').get(id) as { content: string; tool_calls: string | null };
    const outputs = (id: string) => (JSON.parse(row(id).tool_calls!) as Array<{ output?: string }>).map((call) => call.output);

    assert.equal(purgeCompanionToolOutputs(T0), 3);
    for (const id of ['m-old', 'm-before-reset', 'm-mvp']) {
      assert.deepEqual(outputs(id), [COMPANION_PURGED_TOOL_OUTPUT, undefined, ''], id);
      const [first] = JSON.parse(row(id).tool_calls!) as Array<Record<string, unknown>>;
      assert.deepEqual(first, { ...calls[0], output: COMPANION_PURGED_TOOL_OUTPUT }, 'the call itself stays: tool, status, input, times');
      assert.equal(row(id).content, 'CR-1 needs you.', 'and so does the reply');
    }
    assert.deepEqual(outputs('m-recent'), [calls[0]!.output, undefined, ''], 'younger than privacyTtlDays');
    assert.deepEqual(outputs('m-work'), [calls[0]!.output, undefined, ''], 'not a Companion conversation');
    assert.equal(row('m-none').tool_calls, null);
    assert.equal(row('m-odd').tool_calls, JSON.stringify({ output: 'not a list' }), 'what it cannot read it leaves alone');
    assert.equal(purgeCompanionToolOutputs(T0), 0, 'a second pass finds nothing');
    assert.equal(purgeCompanionToolOutputs(T0 + 2 * DAY), 1, 'two days on, the next message is old enough');
  });

  describe('what nobody looks at any more (A3)', () => {
    const ago = (days: number) => T0 - days * DAY;
    const emailDraft = (key: string, title: string, observedAt: number) =>
      draft(key, { source: 'email', subtype: 'email_unread', bucket: 'update', severity: 'digest', title, summary: 'Re: salary review — the preview text', observedAt });

    test('a muted email not seen for a week loses its words but stays muted; the words come back with it', () => {
      const muted = upsertItem(emailDraft('email:muted', 'Email from Alice Private', ago(9)), ago(9)).item;
      applyItemAction(muted.id, { action: 'feedback', feedback: 'down', reason: 'not_relevant' }, ago(9));
      const stillThere = upsertItem(emailDraft('email:muted-recent', 'Email from Bob', ago(2)), ago(2)).item;
      applyItemAction(stillThere.id, { action: 'mute' }, ago(2));
      assert.equal(getItem(muted.id)!.status, 'muted');

      assert.equal(purgeExpired(T0).items, 1);
      const scrubbed = getItem(muted.id)!;
      assert.deepEqual([scrubbed.title, scrubbed.summary, scrubbed.facts, scrubbed.target], ['Email thread', null, {}, null]);
      assert.deepEqual([scrubbed.status, scrubbed.version, scrubbed.itemKey, scrubbed.feedbackReason], ['muted', 'v1', 'email:muted', 'not_relevant'], 'the mute holds');
      assert.ok(listItemEvents(muted.id).every((event) => event.summary === null));
      assert.equal(getItem(stillThere.id)!.title, 'Email from Bob', 'still seen two days ago: kept');
      assert.equal(purgeExpired(T0).items, 0);

      const back = upsertItem(emailDraft('email:muted', 'Email from Alice Private', T0), T0).item;
      assert.deepEqual([back.title, back.status], ['Email from Alice Private', 'muted']);
    });

    test('email and calendar turned off: their items leave the feed, the counts and the material at once; their words and snapshots go a week after the last look', () => {
      const email = upsertItem(emailDraft('email:thread', 'Email from Alice', ago(9)), ago(9)).item;
      const conflict = upsertItem(draft('conflict:a:b', { source: 'calendar', subtype: 'calendar_conflict', bucket: 'needs_you', severity: 'digest', title: 'Calendar conflict at 14:00', observedAt: ago(9) }), ago(9)).item;
      const trouble = upsertItem(draft('system:source:email', { source: 'system', subtype: 'system_source_error', bucket: 'fyi', severity: 'silent', title: 'Email checks keep failing' }), T0).item;
      const cr = upsertItem(draft('cr:CR-1:mine'), T0).item;
      const snapshot = (source: 'email' | 'calendar' | 'cr', objectKey: string, lastSeenAt: number) => ({
        source, objectKey, fingerprint: 'f', state: { topic: 'Re: salary review', sender: 'Alice Private' }, firstSeenAt: lastSeenAt, fingerprintSince: lastSeenAt, lastSeenAt,
      });
      putSnapshots([snapshot('email', 'email:thread', ago(9)), snapshot('email', 'email:inbox', ago(9)), snapshot('calendar', 'conflict:a:b', ago(9)), snapshot('cr', 'cr:CR-1:mine', ago(9))]);
      const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id).sort();
      assert.deepEqual(ids(listOpenItems(T0)), ids([email, conflict, trouble, cr]));

      patchCompanionSettings({ sources: { email: { enabled: false }, calendar: { enabled: false } } });
      assert.deepEqual(ids(listOpenItems(T0)), [cr.id], 'out of sight at once, the trouble item too');
      const shown = snapshotDto({ now: T0, conversation: null });
      assert.deepEqual(ids(shown.items), [cr.id]);
      assert.deepEqual(shown.counts, { needsYou: 1, newItems: 1, unreadMessages: 0 });
      assert.equal(getItem(email.id)!.status, 'new', 'kept as it was, not resolved: no events, no watches firing');

      const purged = purgeExpired(T0);
      assert.deepEqual([purged.items, purged.snapshots], [2, 3]);
      assert.deepEqual([getItem(email.id)!.title, getItem(email.id)!.summary, getItem(conflict.id)!.title], ['Email thread', null, 'Calendar event']);
      assert.deepEqual([...getSnapshots('email').keys(), ...getSnapshots('calendar').keys()], []);
      assert.deepEqual([...getSnapshots('cr').keys()], ['cr:CR-1:mine'], 'other sources\' snapshots are theirs to keep');
      assert.equal(getItem(cr.id)!.title, 'cr:CR-1:mine needs attention');

      // Back on: the items show again, until the baseline poll and the two-miss rule refresh or resolve them.
      patchCompanionSettings({ sources: { email: { enabled: true } } });
      assert.deepEqual(ids(listOpenItems(T0)), ids([email, trouble, cr]));
    });

    test('the whole Companion off: email and calendar words go a week after the last look', () => {
      const email = upsertItem(emailDraft('email:thread', 'Email from Alice', ago(9)), ago(9)).item;
      assert.equal(purgeExpired(T0).items, 0, 'on, and the source still sees it: kept');
      patchCompanionSettings({ enabled: false });
      assert.equal(purgeExpired(T0).items, 1);
      assert.equal(getItem(email.id)!.title, 'Email thread');
    });

    test('nothing of a source that is off is notified, escalated, caught up on or replayed', () => {
      const blocked = upsertItem(draft('pipeline:Alpha', { source: 'pipeline', subtype: 'pipeline_blocked', title: 'Pipeline Alpha is blocked' }), T0).item;
      const waiting = upsertItem(draft('michi:node:n1', { source: 'michi', subtype: 'michi_waiting', severity: 'digest', title: 'A chat waits for you' }), T0).item;
      const notice = insertNotice({ title: 'Companion', body: 'Pipeline Alpha is blocked', target: { kind: 'companion', tab: 'today' }, itemIds: [blocked.id], now: T0 });
      const visible = () => [
        listUnnotifiedNowItems(T0).map((item) => item.id),
        listUnescalatedItems('michi_waiting', T0, T0).map((item) => item.id),
        buildCatchUp(T0 - HOUR, T0 + MINUTE).changedItemIds.sort(),
        pendingNotices(T0).map((pending) => pending.id),
      ];
      assert.deepEqual(visible(), [[blocked.id], [waiting.id], [blocked.id, waiting.id].sort(), [notice.id]]);
      patchCompanionSettings({ sources: { pipeline: { enabled: false }, michi: { enabled: false } } });
      assert.deepEqual(visible(), [[], [], [], []]);
      patchCompanionSettings({ sources: { pipeline: { enabled: true }, michi: { enabled: true } } });
      assert.deepEqual(visible(), [[blocked.id], [waiting.id], [blocked.id, waiting.id].sort(), [notice.id]], 'back with its source');
    });

    test('with every source behind the Auth check off, the Auth item is out of sight too, and back with any of them (B2)', () => {
      const auth = upsertItem(draft('system:auth', { source: 'system', subtype: 'system_auth', severity: 'now', title: 'Auth session expired', target: { kind: 'settings' } }), T0).item;
      const waiting = upsertItem(draft('michi:node:n1', { source: 'michi', subtype: 'michi_waiting', severity: 'digest', title: 'A chat waits for you' }), T0).item;
      const notice = insertNotice({ title: 'Companion', body: 'Auth session expired', target: { kind: 'settings' }, itemIds: [auth.id], now: T0 });
      const shown = () => {
        const snapshot = snapshotDto({ now: T0 + MINUTE, conversation: null });
        return {
          items: snapshot.items.map((item) => item.id).sort(),
          needsYou: snapshot.counts.needsYou,
          // What every turn's material and the fallback brief read.
          open: listOpenItems(T0 + MINUTE, { limit: 500 }).map((item) => item.id).sort(),
          unnotified: listUnnotifiedNowItems(T0 + MINUTE).map((item) => item.id),
          catchUp: buildCatchUp(T0 - HOUR, T0 + MINUTE).changedItemIds.sort(),
          replay: pendingNotices(T0 + MINUTE).map((pending) => pending.id),
        };
      };
      const both = [auth.id, waiting.id].sort();
      const everything = { items: both, needsYou: 2, open: both, unnotified: [auth.id], catchUp: both, replay: [notice.id] };
      assert.deepEqual(shown(), everything);
      patchCompanionSettings({ sources: { cr: { enabled: false }, pipeline: { enabled: false }, email: { enabled: false } } });
      assert.deepEqual(shown(), everything, 'the calendar still needs the session');
      patchCompanionSettings({ sources: { calendar: { enabled: false } } });
      assert.deepEqual(shown(), { items: [waiting.id], needsYou: 1, open: [waiting.id], unnotified: [], catchUp: [waiting.id], replay: [] });
      assert.equal(getItem(auth.id)!.status, 'new', 'kept as it was, not resolved');
      patchCompanionSettings({ sources: { email: { enabled: true } } });
      assert.deepEqual(shown(), everything, 'back with a source that needs the session');
    });
  });

  test('an "until approved" watch fires for a CR that is approved but still has a merge blocker (A0)', () => {
    const cr = upsertItem(draft('cr:CR-1:mine', { facts: { approved: false } }), T0).item;
    const watch = createReminder({ text: 'When CR-1 is approved', itemId: cr.id, until: 'approved' }, T0);
    const workdays = { workdays: [1, 2, 3, 4, 5] };
    assert.deepEqual(fireDueReminders(workdays, T0 + MINUTE), []);
    // Approved, but an unresolved critical comment keeps it in Needs you.
    upsertItem(draft('cr:CR-1:mine', { version: 'v2', summary: 'Approved, but 1 unresolved critical comment on revision 3', facts: { approved: true } }), T0 + 2 * MINUTE);
    assert.deepEqual(fireDueReminders(workdays, T0 + 3 * MINUTE).map((firing) => firing.reminderId), [watch.id]);
    const item = getItem(cr.id)!;
    assert.equal(watchReached('approved', { ...item, subtype: 'cr_approved', facts: {} }, T0), true);
    assert.equal(watchReached('approved', { ...item, facts: { approved: false } }, T0), false);
    assert.equal(watchReached('approved', { ...item, subtype: 'cr_stale', facts: { approved: null } }, T0), false);
  });
});
