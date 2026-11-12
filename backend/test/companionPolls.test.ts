import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * One source poll stored as a whole (repository.applySourcePoll, DESIGN
 * R2.4/R2.5): the baseline poll of a source (everything it finds was already
 * there: seen, counted as notified, logged `baseline`), a failed poll and a
 * suspect drop that write nothing, absence counted only for ok and complete
 * polls (or the window rule of an incomplete one) and resolving on the second
 * miss in a row, items that leave while their object stays, validation
 * before any write, and the snapshot helpers. Temp MICHI_DATA_DIR per test.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  applySourcePoll,
  getItemByKey,
  getSnapshots,
  getSourceBaseline,
  isSourceBaselined,
  isSuspectPollDrop,
  latestEventSeq,
  listEventsAfter,
  listItemEvents,
  listUnnotifiedNowItems,
  markSourceBaselined,
  notifiedVersionOf,
  putSnapshots,
  recordMissingSnapshots,
} from '../src/services/companion/repository';
import { stableHash } from '../src/services/companion/observations';
import { patchCompanionSettings } from '../src/services/companion/settings';
import type { ItemDraft, Observation } from '../src/services/companion/types';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const MINUTE = 60_000;

const observation = (objectKey: string, state: Record<string, unknown> = { revision: 1 }, observedAt = T0): Observation => ({
  source: 'cr', objectKey, fingerprint: stableHash(state), state, observedAt,
});

function draft(itemKey: string, version = 'v1', overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr',
    subtype: 'cr_needs_attention',
    itemKey,
    version,
    bucket: 'needs_you',
    severity: 'now',
    title: `${itemKey} needs attention`,
    summary: null,
    target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: {},
    observedAt: T0,
    ...overrides,
  };
}

/** A poll of `cr` that observes these objects and drafts an item for each one (same key). */
function poll(keys: string[], now: number, options: { ok?: boolean; complete?: boolean; versions?: Record<string, string>; absenceCounts?: (key: string) => boolean } = {}) {
  return applySourcePoll({
    source: 'cr',
    result: { ok: options.ok ?? true, complete: options.complete ?? true, observations: keys.map((key) => observation(key, { version: options.versions?.[key] ?? 'v1' }, now)) },
    drafts: keys.map((key) => draft(key, options.versions?.[key] ?? 'v1', { observedAt: now })),
    now,
    absenceCounts: options.absenceCounts,
  });
}

const missingCount = (objectKey: string) =>
  (getDb().prepare('SELECT missing_count FROM companion_snapshots WHERE object_key = ?').get(objectKey) as { missing_count: number } | undefined)?.missing_count;
const status = (key: string) => getItemByKey(key)?.status;

describe('Companion source polls', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-polls-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the first successful poll of a source is its baseline: what it finds was already there (R2.5)', () => {
    assert.equal(isSourceBaselined('cr'), false);
    const first = poll(['cr:CR-1:mine', 'cr:CR-2:mine'], T0);
    assert.deepEqual([first.outcome, first.baseline], ['applied', true]);
    assert.deepEqual(first.upserts.map((upsert) => upsert.change), ['created', 'created']);
    assert.deepEqual(first.upserts.map((upsert) => upsert.event?.kind), ['baseline', 'baseline']);
    for (const key of ['cr:CR-1:mine', 'cr:CR-2:mine']) {
      assert.equal(status(key), 'seen', key);
      assert.equal(notifiedVersionOf(getItemByKey(key)!.id), 'v1', 'counted as notified: never a notice');
    }
    assert.deepEqual(listUnnotifiedNowItems(T0), []);
    assert.deepEqual(listEventsAfter(0).map((event) => event.kind), ['baseline', 'baseline']);
    assert.equal(isSourceBaselined('cr'), true);
    assert.equal(isSourceBaselined('pipeline'), false, 'each source has its own baseline');
    assert.equal(getSnapshots('cr').size, 2);

    // The next poll reports what is new from then on.
    const cursor = latestEventSeq();
    const second = poll(['cr:CR-1:mine', 'cr:CR-2:mine', 'cr:CR-3:mine'], T0 + 5 * MINUTE, { versions: { 'cr:CR-2:mine': 'v2' } });
    assert.deepEqual([second.outcome, second.baseline], ['applied', false]);
    assert.deepEqual(second.upserts.map((upsert) => upsert.change), ['unchanged', 'changed', 'created']);
    assert.deepEqual([status('cr:CR-1:mine'), status('cr:CR-2:mine'), status('cr:CR-3:mine')], ['seen', 'new', 'new']);
    assert.deepEqual(listEventsAfter(cursor).map((event) => event.kind), ['changed', 'created']);
    assert.deepEqual(listUnnotifiedNowItems(T0 + 5 * MINUTE).map((item) => item.itemKey).sort(), ['cr:CR-2:mine', 'cr:CR-3:mine']);
    assert.deepEqual(second.diff?.added.map((added) => added.objectKey), ['cr:CR-3:mine']);
    assert.deepEqual(second.diff?.changed.map((changed) => changed.current.objectKey), ['cr:CR-2:mine']);
  });

  test('turning a source on again makes its next poll a baseline; so does clearing it', () => {
    poll(['cr:CR-1:mine'], T0);
    patchCompanionSettings({ sources: { cr: { enabled: false } } });
    assert.equal(isSourceBaselined('cr'), true, 'turning off forgets nothing');
    patchCompanionSettings({ sources: { cr: { enabled: true } } });
    assert.equal(isSourceBaselined('cr'), false);
    const back = poll(['cr:CR-1:mine', 'cr:CR-4:mine'], T0 + MINUTE, { versions: { 'cr:CR-1:mine': 'v2' } });
    assert.equal(back.baseline, true);
    assert.deepEqual([status('cr:CR-1:mine'), status('cr:CR-4:mine')], ['seen', 'seen'], 'what changed while it was off is not news');
    assert.deepEqual(back.upserts.map((upsert) => upsert.event?.kind), ['baseline', 'baseline']);
    assert.equal(notifiedVersionOf(getItemByKey('cr:CR-1:mine')!.id), 'v2');

    // Turned off and on again: the next poll is a baseline again.
    patchCompanionSettings({ sources: { cr: { enabled: false } } });
    patchCompanionSettings({ sources: { cr: { enabled: true } } });
    assert.equal(poll(['cr:CR-1:mine', 'cr:CR-5:mine'], T0 + 2 * MINUTE).baseline, true);
    assert.equal(status('cr:CR-5:mine'), 'seen');
    markSourceBaselined('cr', T0);
    assert.equal(poll(['cr:CR-1:mine', 'cr:CR-5:mine', 'cr:CR-6:mine'], T0 + 3 * MINUTE).baseline, false);
    assert.equal(status('cr:CR-6:mine'), 'new');
  });

  test('an incomplete baseline poll leaves the first look open: what later polls bring in that it had not seen is baseline too (A2)', () => {
    const first = poll(['cr:A', 'cr:B'], T0, { complete: false });
    assert.equal(first.baseline, true);
    assert.deepEqual(getSourceBaseline('cr'), { at: T0, open: true });

    // Still incomplete: the newcomer is part of the first look; a change to what it saw is news.
    const second = poll(['cr:A', 'cr:B', 'cr:C'], T0 + 5 * MINUTE, { complete: false, versions: { 'cr:B': 'v2' } });
    assert.equal(second.baseline, false);
    assert.deepEqual([status('cr:A'), status('cr:B'), status('cr:C')], ['seen', 'new', 'seen']);
    assert.deepEqual(listItemEvents(getItemByKey('cr:C')!.id).map((event) => event.kind), ['baseline']);
    assert.equal(notifiedVersionOf(getItemByKey('cr:C')!.id), 'v1');
    assert.deepEqual(listUnnotifiedNowItems(T0 + 5 * MINUTE).map((item) => item.itemKey), ['cr:B']);
    assert.equal(getSourceBaseline('cr')!.open, true);

    // The first complete poll is still the first look for what it brings in, and closes it.
    poll(['cr:A', 'cr:B', 'cr:C', 'cr:D'], T0 + 10 * MINUTE);
    assert.equal(status('cr:D'), 'seen');
    assert.deepEqual(getSourceBaseline('cr'), { at: T0, open: false });
    poll(['cr:A', 'cr:B', 'cr:C', 'cr:D', 'cr:E'], T0 + 15 * MINUTE);
    assert.equal(status('cr:E'), 'new', 'after that, a new object is news');
  });

  test('an open first look ends after an hour, however incomplete the polls stay', () => {
    poll(['cr:A'], T0, { complete: false });
    poll(['cr:A', 'cr:B'], T0 + 59 * MINUTE, { complete: false });
    assert.equal(status('cr:B'), 'seen');
    poll(['cr:A', 'cr:B', 'cr:C'], T0 + 60 * MINUTE, { complete: false });
    assert.equal(status('cr:C'), 'new');
    assert.deepEqual(getSourceBaseline('cr'), { at: T0, open: false });
  });

  test('a poll that looked before the first look opened (still running when the scope grew) does not close it (A5)', () => {
    poll(['cr:A'], T0);
    patchCompanionSettings({ sources: { cr: { includeReviews: false } } }, T0 + MINUTE);
    patchCompanionSettings({ sources: { cr: { includeReviews: true } } }, T0 + 2 * MINUTE);
    assert.deepEqual(getSourceBaseline('cr'), { at: T0 + 2 * MINUTE, open: true });
    // Started a minute before the change, finished after it: its newcomers are first look, but it cannot close the look.
    const late = applySourcePoll({
      source: 'cr',
      result: { ok: true, complete: true, observations: ['cr:A', 'cr:B'].map((key) => observation(key, { version: 'v1' }, T0 + MINUTE)) },
      drafts: ['cr:A', 'cr:B'].map((key) => draft(key, 'v1', { observedAt: T0 + MINUTE })),
      now: T0 + 3 * MINUTE,
    });
    assert.equal(late.outcome, 'applied');
    assert.equal(status('cr:B'), 'seen');
    assert.equal(getSourceBaseline('cr')!.open, true);
    // The first complete poll that looked after the change brings in its reviews as the first look, and closes it.
    poll(['cr:A', 'cr:B', 'cr:CR-9:review'], T0 + 8 * MINUTE, { versions: { 'cr:A': 'v2' } });
    assert.deepEqual([status('cr:A'), status('cr:CR-9:review')], ['new', 'seen'], 'what it already watched stays news');
    assert.equal(getSourceBaseline('cr')!.open, false);
  });

  test('a draft its source marks baseline is stored as the first look even after the baseline poll (A2)', () => {
    poll(['cr:A'], T0);
    const later = applySourcePoll({
      source: 'cr',
      result: { ok: true, complete: true, observations: ['cr:A', 'cr:B'].map((key) => observation(key, { version: 'v1' }, T0 + MINUTE)) },
      drafts: [draft('cr:A', 'v2', { observedAt: T0 + MINUTE }), { ...draft('cr:B', 'v1', { observedAt: T0 + MINUTE }), baseline: true }],
      now: T0 + MINUTE,
    });
    assert.deepEqual(later.upserts.map((upsert) => upsert.event?.kind), ['changed', 'baseline']);
    assert.deepEqual([status('cr:A'), status('cr:B')], ['new', 'seen']);
    assert.deepEqual(listUnnotifiedNowItems(T0 + MINUTE).map((item) => item.itemKey), ['cr:A']);
  });

  test('a failed poll writes nothing, not even its baseline', () => {
    const failed = poll(['cr:CR-1:mine'], T0, { ok: false });
    assert.deepEqual(failed, { outcome: 'failed', baseline: false, diff: null, upserts: [], resolved: [], gone: [] });
    assert.equal(isSourceBaselined('cr'), false);
    assert.equal(getSnapshots('cr').size, 0);
    assert.equal(getItemByKey('cr:CR-1:mine'), null);

    poll(['cr:CR-1:mine', 'cr:CR-2:mine'], T0);
    for (let i = 1; i <= 3; i++) assert.equal(poll([], T0 + i * MINUTE, { ok: false }).outcome, 'failed');
    assert.deepEqual([status('cr:CR-1:mine'), status('cr:CR-2:mine')], ['seen', 'seen'], 'a failing source never resolves anything');
    assert.deepEqual([missingCount('cr:CR-1:mine'), missingCount('cr:CR-2:mine')], [0, 0]);
  });

  test('a poll that loses every row at once (3 or more) is suspect and writes nothing; a smaller source may empty out', () => {
    assert.deepEqual([isSuspectPollDrop(3, 0), isSuspectPollDrop(2, 0), isSuspectPollDrop(3, 1), isSuspectPollDrop(0, 0)], [true, false, false, false]);
    poll(['cr:CR-1:mine', 'cr:CR-2:mine', 'cr:CR-3:mine'], T0);
    for (let i = 1; i <= 3; i++) {
      const suspect = poll([], T0 + i * MINUTE);
      assert.deepEqual([suspect.outcome, suspect.upserts, suspect.resolved, suspect.gone], ['suspect', [], [], []]);
    }
    assert.equal(getSnapshots('cr').size, 3);
    assert.deepEqual(['cr:CR-1:mine', 'cr:CR-2:mine', 'cr:CR-3:mine'].map(status), ['seen', 'seen', 'seen']);
    assert.equal(missingCount('cr:CR-1:mine'), 0);
    // One row left is an answer, not a broken one.
    assert.equal(poll(['cr:CR-1:mine'], T0 + 10 * MINUTE).outcome, 'applied');
    assert.equal(poll(['cr:CR-1:mine'], T0 + 11 * MINUTE).resolved.length, 2);

    // Two rows can go to none.
    assert.equal(isSourceBaselined('pipeline'), false);
    const pipelinePoll = (keys: string[], now: number) => applySourcePoll({
      source: 'pipeline',
      result: { ok: true, complete: true, observations: keys.map((key) => ({ ...observation(key), source: 'pipeline' as const })) },
      drafts: keys.map((key) => draft(key, 'v1', { source: 'pipeline', subtype: 'pipeline_blocked' })),
      now,
    });
    pipelinePoll(['pipeline:A', 'pipeline:B'], T0);
    assert.equal(pipelinePoll([], T0 + MINUTE).outcome, 'applied');
    assert.deepEqual(pipelinePoll([], T0 + 2 * MINUTE).gone.sort(), ['pipeline:A', 'pipeline:B']);
    assert.deepEqual([status('pipeline:A'), status('pipeline:B')], ['resolved', 'resolved']);
    assert.equal(getSnapshots('pipeline').size, 0);
  });

  test('absence counts only for an ok and complete poll, and the second miss in a row resolves the item and forgets the object (R2.4)', () => {
    poll(['cr:A', 'cr:B', 'cr:C'], T0);
    const once = poll(['cr:A'], T0 + MINUTE);
    assert.deepEqual([once.resolved, once.gone], [[], []], 'one miss only counts');
    assert.deepEqual([missingCount('cr:B'), missingCount('cr:C')], [1, 1]);
    assert.deepEqual([status('cr:B'), status('cr:C')], ['seen', 'seen']);

    const twice = poll(['cr:A', 'cr:C'], T0 + 2 * MINUTE);
    assert.deepEqual(twice.resolved, [getItemByKey('cr:B')!.id]);
    assert.deepEqual(twice.gone, ['cr:B']);
    assert.equal(status('cr:B'), 'resolved');
    assert.equal(missingCount('cr:B'), undefined, 'the object left its source');
    assert.equal(missingCount('cr:C'), 0, 'C was back: its count starts over');

    // An incomplete poll (a truncated window) counts no absence by itself.
    for (let i = 3; i <= 5; i++) {
      const partial = poll(['cr:A'], T0 + i * MINUTE, { complete: false });
      assert.deepEqual([partial.outcome, partial.resolved, partial.gone], ['applied', [], []]);
    }
    assert.equal(status('cr:C'), 'seen');
    assert.equal(missingCount('cr:C'), 0);

    // With the window's rule it counts what the window reached.
    const reached = (key: string) => key === 'cr:C';
    poll(['cr:A'], T0 + 6 * MINUTE, { complete: false, absenceCounts: reached });
    assert.equal(missingCount('cr:C'), 1);
    const windowed = poll(['cr:A'], T0 + 7 * MINUTE, { complete: false, absenceCounts: reached });
    assert.deepEqual([windowed.resolved, windowed.gone], [[getItemByKey('cr:C')!.id], ['cr:C']]);

    // The object comes back: the same version reopens as it was, a new one as new.
    const back = poll(['cr:A', 'cr:B', 'cr:C'], T0 + 8 * MINUTE, { versions: { 'cr:C': 'v2' } });
    assert.deepEqual(back.upserts.map((upsert) => upsert.change), ['unchanged', 'reopened', 'reopened']);
    assert.deepEqual([status('cr:B'), status('cr:C')], ['seen', 'new']);
  });

  test('an item can leave while its object stays: the drafts decide the item, the observations the snapshot', () => {
    poll(['cr:CR-1:mine', 'cr:CR-2:mine'], T0);
    // CR-2 is still open but no longer needs attention: observed, not drafted.
    const keepObject = (now: number) => applySourcePoll({
      source: 'cr',
      result: { ok: true, complete: true, observations: [observation('cr:CR-1:mine', { version: 'v1' }, now), observation('cr:CR-2:mine', { version: 'v1' }, now)] },
      drafts: [draft('cr:CR-1:mine', 'v1', { observedAt: now })],
      now,
    });
    assert.deepEqual(keepObject(T0 + MINUTE).resolved, []);
    const second = keepObject(T0 + 2 * MINUTE);
    assert.deepEqual(second.resolved, [getItemByKey('cr:CR-2:mine')!.id]);
    assert.deepEqual(second.gone, []);
    assert.equal(getSnapshots('cr').size, 2, 'the snapshot stays for the next diff');
  });

  test('records of another source, or an object reported twice, throw before anything is written', () => {
    assert.throws(() => applySourcePoll({
      source: 'cr', result: { ok: true, complete: true, observations: [observation('cr:A')] },
      drafts: [draft('pipeline:P', 'v1', { source: 'pipeline' })], now: T0,
    }), /a cr poll cannot store pipeline records/);
    assert.throws(() => applySourcePoll({
      source: 'cr', result: { ok: true, complete: true, observations: [{ ...observation('email:E'), source: 'email' }] },
      drafts: [], now: T0,
    }), /a cr poll cannot store email records/);
    assert.throws(() => applySourcePoll({
      source: 'cr', result: { ok: true, complete: true, observations: [observation('cr:A'), observation('cr:A', { revision: 2 })] },
      drafts: [draft('cr:A')], now: T0,
    }), /reported cr:A twice/);
    assert.equal(isSourceBaselined('cr'), false);
    assert.equal(getSnapshots('cr').size, 0);
    assert.equal(getItemByKey('cr:A'), null);
    assert.equal(latestEventSeq(), 0);
  });

  test('snapshot helpers: a put starts the miss count over, the second recorded miss forgets', () => {
    const record = (objectKey: string) => ({ source: 'cr' as const, objectKey, fingerprint: 'f', state: { a: 1 }, firstSeenAt: T0, fingerprintSince: T0, lastSeenAt: T0 });
    putSnapshots([record('cr:A'), record('cr:B'), record('cr:C')]);
    assert.deepEqual(recordMissingSnapshots('cr', ['cr:A', 'cr:B', 'cr:A', 'cr:missing']), []);
    assert.deepEqual([missingCount('cr:A'), missingCount('cr:B')], [1, 1]);
    putSnapshots([record('cr:A')]);
    assert.equal(missingCount('cr:A'), 0);
    assert.deepEqual(recordMissingSnapshots('cr', ['cr:A', 'cr:B']), ['cr:B']);
    assert.deepEqual([...getSnapshots('cr').keys()].sort(), ['cr:A', 'cr:C']);
    assert.deepEqual(recordMissingSnapshots('pipeline', ['cr:A']), [], 'another source\'s keys are not this one\'s');
    assert.deepEqual(recordMissingSnapshots('cr', ['cr:A', 'cr:C', 'cr:C']), ['cr:A'], 'A\'s second miss in a row, C\'s first');
    assert.deepEqual(recordMissingSnapshots('cr', ['cr:C']), ['cr:C']);
    assert.equal(getSnapshots('cr').size, 0);
    assert.deepEqual(recordMissingSnapshots('cr', []), []);
    assert.deepEqual(getSnapshots('cr').get('cr:A'), undefined);
  });
});
