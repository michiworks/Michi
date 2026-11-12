import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * snapshot.checkinChanges' `standing` and `snoozedUntil` (W3-F3-review #1):
 * Today credits a check-in ("Moved by <name>", "Brought back by <name>",
 * with Undo) only while its change still holds, by the check Undo all makes
 * (undoOne's sameItemState). The user's own actions and a source resolving
 * an item leave no companion_run_changes row, so only the target's state can
 * tell. Temp MICHI_DATA_DIR per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompanionItemStatus } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  addGoal,
  applyItemAction,
  editGoal,
  listCheckinChanges,
  recordRunChange,
  resolveItems,
  startRun,
  undoRunChanges,
  upsertItem,
  wakeSnoozedItems,
} from '../src/services/companion/repository';
import type { ItemDraft } from '../src/services/companion/types';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const HOUR = 60 * 60_000;

function draft(itemKey: string): ItemDraft {
  return {
    source: 'cr', subtype: 'cr_needs_attention', itemKey, version: 'v1', bucket: 'needs_you', severity: 'now',
    title: `${itemKey} needs attention`, summary: null, target: null, facts: {}, observedAt: T0,
  };
}

describe('whether a check-in’s Today and goal changes still stand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-checkin-changes-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = () => startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 }).id;
  const state = (id: string) => getDb().prepare('SELECT status, snoozed_until FROM companion_items WHERE id = ?').get(id) as { status: CompanionItemStatus; snoozed_until: number | null };

  /** The check-in's own change to an item, as its tools make it: the item moves, then the row records before and after. */
  function checkinItemChange(runId: string, itemId: string, action: 'snooze' | 'dismiss' | 'restore', now: number, until?: number) {
    const before = state(itemId);
    const after = applyItemAction(itemId, action === 'snooze' ? { action, until: until! } : { action }, now);
    return recordRunChange({ runId, targetKind: 'item', targetId: itemId, action,
      before: { status: before.status, snoozedUntil: before.snoozed_until }, after: { status: after.status, snoozedUntil: after.snoozedUntil },
      reason: `the check-in’s ${action}`, now });
  }
  const change = (id: string) => listCheckinChanges().find((entry) => entry.id === id)!;

  test('a snooze stands until it runs out, and says when it ends; the user’s Done after that is not the check-in’s', () => {
    const item = upsertItem(draft('cr:CR-1:mine'), T0).item;
    const id = checkinItemChange(run(), item.id, 'snooze', T0 + 1, T0 + 2 * HOUR);
    assert.deepEqual([change(id).standing, change(id).snoozedUntil], [true, T0 + 2 * HOUR]);

    assert.deepEqual(wakeSnoozedItems(T0 + 2 * HOUR), [item.id]);
    assert.equal(change(id).standing, false, 'the snooze ran out: the item is back on Today');
    applyItemAction(item.id, { action: 'dismiss' }, T0 + 3 * HOUR);
    assert.equal(change(id).standing, false, 'the user dismissed it: no "Snoozed by" line, no Undo that would bring it back');
    assert.equal(change(id).snoozedUntil, T0 + 2 * HOUR, 'the snooze end stays as the change set it');
  });

  test('a dismissal stands while the item stays dismissed, and not once its source resolved it', () => {
    const item = upsertItem(draft('cr:CR-2:mine'), T0).item;
    const id = checkinItemChange(run(), item.id, 'dismiss', T0 + 1);
    assert.deepEqual([change(id).standing, change(id).snoozedUntil], [true, null]);
    assert.deepEqual(resolveItems([item.id], T0 + HOUR), [item.id]);
    assert.equal(change(id).standing, false, 'resolved by the collector: Undo could not bring it back');
  });

  test('a restore stands only while the item is as the check-in left it', () => {
    const item = upsertItem(draft('cr:CR-3:mine'), T0).item;
    applyItemAction(item.id, { action: 'dismiss' }, T0);
    const id = checkinItemChange(run(), item.id, 'restore', T0 + 1);
    assert.equal(change(id).standing, true);
    applyItemAction(item.id, { action: 'snooze', until: T0 + HOUR }, T0 + 2);
    assert.equal(change(id).standing, false, 'the user snoozed it');
    wakeSnoozedItems(T0 + HOUR);
    assert.equal(state(item.id).status, 'new');
    assert.equal(change(id).standing, false, 'back on Today because the user’s own snooze ran out, not because of the check-in');
  });

  test('an undone change, or one whose item is gone, does not stand', () => {
    const runId = run();
    const kept = upsertItem(draft('cr:CR-4:mine'), T0).item;
    const gone = upsertItem(draft('cr:CR-5:mine'), T0).item;
    const undone = checkinItemChange(runId, kept.id, 'dismiss', T0 + 1);
    const deleted = checkinItemChange(runId, gone.id, 'dismiss', T0 + 2);
    getDb().prepare('DELETE FROM companion_items WHERE id = ?').run(gone.id);
    assert.equal(change(deleted).standing, false);
    undoRunChanges(runId, T0 + HOUR);
    assert.equal(change(undone).undoneAt, T0 + HOUR);
    assert.equal(change(undone).standing, false);
  });

  test('goal changes stand while the goal is as the check-in left it', () => {
    const runId = run();
    const added = editGoal({ action: 'add', text: 'Review CR-2', origin: 'checkin' }, T0 + 1);
    const add = recordRunChange({ runId, targetKind: 'goal', targetId: added.id, action: 'add', before: null,
      after: { text: 'Review CR-2', textOrigin: 'checkin' }, reason: null, now: T0 + 1 });
    const kept = addGoal('Ship the auth fix', T0);
    editGoal({ action: 'reword', id: kept.id, text: 'Ship it', origin: 'checkin' }, T0 + 2);
    const reword = recordRunChange({ runId, targetKind: 'goal', targetId: kept.id, action: 'reword',
      before: { text: 'Ship the auth fix', textOrigin: 'user' }, after: { text: 'Ship it', textOrigin: 'checkin' }, reason: null, now: T0 + 2 });
    const dropped = addGoal('Write the RFC', T0);
    editGoal({ action: 'remove', id: dropped.id, origin: 'checkin' }, T0 + 3);
    const remove = recordRunChange({ runId, targetKind: 'goal', targetId: dropped.id, action: 'remove',
      before: { text: 'Write the RFC', textOrigin: 'user' }, after: null, reason: null, now: T0 + 3 });
    assert.deepEqual([add, reword, remove].map((id) => [change(id).standing, change(id).snoozedUntil]), [[true, null], [true, null], [true, null]]);

    editGoal({ action: 'remove', id: added.id, origin: 'user' }, T0 + 10);
    editGoal({ action: 'reword', id: kept.id, text: 'Ship it this week', origin: 'user' }, T0 + 11);
    assert.deepEqual([add, reword, remove].map((id) => change(id).standing), [false, false, true], 'the user removed one and reworded another');
  });
});
