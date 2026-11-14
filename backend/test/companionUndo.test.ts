import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * "Undo all" of a check-in (DESIGN-v2 §2.7; posts.ts undoCompanionRun, POST
 * /companion/runs/:runId/undo): what it did to the user's pages
 * (pages/pageChanges revertRunPageChanges, after its node S was purged) and
 * to Today and the goals (companion_run_changes), newest first. A target that
 * moved on since is a conflict and stays as it is; calling it again is safe
 * and clears what a conflict left once it is sorted out; the run is undone
 * (undoneAt) once nothing of it stands. Only a check-in's run can be undone.
 * Temp MICHI_DATA_DIR per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_LIMITS, checkinNodeId, companionCheckinTurnId } from 'michi-shared';
import { ensureAssistant } from '../src/assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { createPage, getPage } from '../src/services/pages/repository';
import { createCheckinNode, purgeCheckinNode } from '../src/services/companion/checkinNode';
import { checkinRunChanges, undoCompanionRun } from '../src/services/companion/posts';
import {
  addGoal,
  editGoal,
  getItem,
  getRun,
  listGoals,
  recordRun,
  recordRunChange,
  startRun,
  upsertItem,
} from '../src/services/companion/repository';
import type { ItemDraft } from '../src/services/companion/types';

const OWNER = LOCAL_AGENT_OWNER_ID;
const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const HOUR = 60 * 60_000;

function draft(itemKey: string): ItemDraft {
  return {
    source: 'cr', subtype: 'cr_needs_attention', itemKey, version: 'v1', bucket: 'needs_you', severity: 'now',
    title: `${itemKey} needs attention`, summary: null, target: null, facts: {}, observedAt: T0,
  };
}

describe('Undo all of a check-in', () => {
  let tmpDir: string;
  let assistantWorkspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-undo-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    assistantWorkspace = ensureAssistant().workspaceId;
    getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', OWNER);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A check-in run with its node S and S's live turn, as the runner makes them: its write source. */
  function checkin(startedAt = T0) {
    const run = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt });
    const { nodeId } = createCheckinNode(run.id, assistantWorkspace, startedAt);
    const turnId = companionCheckinTurnId(run.id);
    const assistantId = `self-${nodeId}-${turnId}`;
    getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',?,?)")
      .run(turnId, nodeId, assistantId, startedAt, startedAt);
    return { runId: run.id, nodeId, source: { kind: 'chat' as const, nodeId, turnId, assistantId } };
  }

  /** The run is over: S purged, as after every check-in (§3.1 step 9). */
  function over(runId: string): void {
    getDb().prepare("UPDATE companion_runs SET outcome = 'quiet', finished_at = ? WHERE id = ?").run(T0 + 1000, runId);
    assert.equal(purgeCheckinNode(checkinNodeId(runId)), true);
  }

  /** The page's text blocks (a new page starts with an empty one). */
  const blockTexts = (pageId: string) => getPage(pageId, OWNER).blocks.map((block) => (block as { text?: string }).text).filter(Boolean);

  test('the run keeps what S\'s replies used once S is purged (Q17): by charge, credits or uncached tokens, never a total alone', () => {
    const run = checkin();
    const reply = (id: string, usage: unknown) => getDb().prepare(`INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata)
      VALUES (?,?,'assistant','ok',0,?,?)`).run(id, run.nodeId, T0, JSON.stringify({ usageSummary: usage }));
    reply('m-1', { charge: { amount: 18, unit: 'credits', provenance: 'native_metering' } });
    reply('m-2', { inputTokens: 5_000, cachedInputTokens: 4_800, outputTokens: 120, totalTokens: 9_999 });
    reply('m-3', { totalTokens: 7_000 });
    over(run.runId);
    const row = getDb().prepare('SELECT usage_json FROM companion_runs WHERE id = ?').get(run.runId) as { usage_json: string | null };
    assert.deepEqual(JSON.parse(row.usage_json!), { credits: 18, tokens: 320 });

    const quiet = checkin(T0 + 1);
    over(quiet.runId);
    assert.equal((getDb().prepare('SELECT usage_json FROM companion_runs WHERE id = ?').get(quiet.runId) as { usage_json: string | null }).usage_json, null,
      'a run whose replies reported nothing records nothing');
  });

  test('puts back its page edits, Today changes and goal edits after S is gone, newest first; the run is then undone', async () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Tasks', now: T0 - HOUR });
    const item = upsertItem(draft('cr:CR-1:mine'), T0).item;
    const kept = addGoal('Ship the auth fix', T0 - HOUR);
    const dropped = addGoal('Write the RFC', T0 - HOUR);
    const run = checkin();

    const written = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: run.source, now: T0 + 10,
      ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Moved 3 tasks to Done.' } }] });
    assert.equal(written.applied.length, 1, JSON.stringify(written.rejected));
    getDb().prepare("UPDATE companion_items SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(T0 + HOUR, item.id);
    const snooze = recordRunChange({ runId: run.runId, targetKind: 'item', targetId: item.id, action: 'snooze',
      before: { status: 'new', snoozedUntil: null }, after: { status: 'snoozed', snoozedUntil: T0 + HOUR }, reason: 'Waits on its author', now: T0 + 11 });
    const added = editGoal({ action: 'add', text: 'Review CR-2', origin: 'checkin' }, T0 + 12);
    const add = recordRunChange({ runId: run.runId, targetKind: 'goal', targetId: added.id, action: 'add', before: null, after: { text: 'Review CR-2', textOrigin: 'checkin' }, reason: null, now: T0 + 12 });
    editGoal({ action: 'reword', id: kept.id, text: 'Ship the auth fix by Friday', origin: 'checkin' }, T0 + 13);
    const reword = recordRunChange({ runId: run.runId, targetKind: 'goal', targetId: kept.id, action: 'reword',
      before: { text: 'Ship the auth fix', textOrigin: 'user' }, after: { text: 'Ship the auth fix by Friday', textOrigin: 'checkin' }, reason: null, now: T0 + 13 });
    editGoal({ action: 'remove', id: dropped.id, origin: 'checkin' }, T0 + 14);
    const remove = recordRunChange({ runId: run.runId, targetKind: 'goal', targetId: dropped.id, action: 'remove',
      before: { text: 'Write the RFC', textOrigin: 'user' }, after: null, reason: null, now: T0 + 14 });
    over(run.runId);
    assert.deepEqual(checkinRunChanges(run.runId).map((change) => [change.kind, change.id]),
      [['page', page.id], ['item', item.id], ['goal', added.id], ['goal', kept.id], ['goal', dropped.id]], 'what its receipt lists');
    assert.deepEqual(blockTexts(page.id), ['Moved 3 tasks to Done.']);

    const undone = undoCompanionRun(run.runId, T0 + HOUR)!;
    assert.deepEqual(undone.conflicts, []);
    assert.equal(undone.undone, true);
    assert.deepEqual(undone.reverted.slice(-4), [remove, reword, add, snooze], 'Today and goal changes newest first, after the page changes');
    assert.ok(undone.reverted.length > 4, 'the page change too');
    assert.deepEqual(blockTexts(page.id), [], 'the block it wrote is gone, though S was purged');
    assert.deepEqual([getItem(item.id)!.status, getItem(item.id)!.snoozedUntil], ['new', null]);
    const goals = new Map(listGoals().map((goal) => [goal.id, goal]));
    assert.equal(goals.has(added.id), false, 'the goal it added is removed again');
    assert.deepEqual([goals.get(kept.id)?.text, goals.get(kept.id)?.textOrigin], ['Ship the auth fix', 'user'], 'reworded back, the user\'s words again');
    assert.equal(goals.get(dropped.id)?.text, 'Write the RFC', 'the goal it removed is back');
    assert.equal(getRun(run.runId)!.undoneAt, T0 + HOUR);

    const again = undoCompanionRun(run.runId, T0 + 2 * HOUR)!;
    assert.deepEqual([again.reverted, again.conflicts, again.undone], [[], [], true], 'safe to repeat');
    assert.equal(getRun(run.runId)!.undoneAt, T0 + HOUR, 'undone once');
  });

  test('what moved on since is a conflict and stays; once the user sorts it out, Undo all again clears it', async () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan', now: T0 - HOUR });
    const item = upsertItem(draft('cr:CR-1:mine'), T0).item;
    const goal = addGoal('Ship the auth fix', T0 - HOUR);
    const run = checkin();
    const written = applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: run.source, now: T0 + 10,
      ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Agent line' } }] });
    const blockId = (written.applied[0]!.target as { blockId: string }).blockId;
    getDb().prepare("UPDATE companion_items SET status = 'dismissed' WHERE id = ?").run(item.id);
    const dismiss = recordRunChange({ runId: run.runId, targetKind: 'item', targetId: item.id, action: 'dismiss',
      before: { status: 'new', snoozedUntil: null }, after: { status: 'dismissed', snoozedUntil: null }, reason: 'Merged', now: T0 + 11 });
    editGoal({ action: 'reword', id: goal.id, text: 'Ship it', origin: 'checkin' }, T0 + 12);
    const reword = recordRunChange({ runId: run.runId, targetKind: 'goal', targetId: goal.id, action: 'reword',
      before: { text: 'Ship the auth fix', textOrigin: 'user' }, after: { text: 'Ship it', textOrigin: 'checkin' }, reason: null, now: T0 + 12 });
    over(run.runId);

    // The user moves on: edits the block, mutes the item, rewords the goal.
    const edited = applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: getPage(page.id, OWNER).revision, now: T0 + 20,
      ops: [{ op: 'update', id: blockId, block: { type: 'markdown', text: 'My line now' } }] });
    assert.equal(edited.applied.length, 1, JSON.stringify(edited.rejected));
    getDb().prepare("UPDATE companion_items SET status = 'muted' WHERE id = ?").run(item.id);
    editGoal({ action: 'reword', id: goal.id, text: 'Ship it this week', origin: 'user' }, T0 + 21);

    const first = undoCompanionRun(run.runId, T0 + HOUR)!;
    assert.equal(first.undone, false);
    assert.deepEqual(first.reverted, []);
    assert.deepEqual(first.conflicts.filter((conflict) => [dismiss, reword].includes(conflict.changeId)).map((conflict) => conflict.message).sort(),
      ['This goal changed since', 'This item changed since']);
    assert.ok(first.conflicts.length >= 3, 'the page change too');
    assert.deepEqual(blockTexts(page.id), ['My line now'], 'the user\'s edit stands');
    assert.equal(getItem(item.id)!.status, 'muted');
    assert.equal(listGoals().find((entry) => entry.id === goal.id)!.text, 'Ship it this week');
    assert.equal(getRun(run.runId)!.undoneAt, undefined);

    // Sorted out: the item and the goal are as the run left them again.
    getDb().prepare("UPDATE companion_items SET status = 'dismissed' WHERE id = ?").run(item.id);
    editGoal({ action: 'reword', id: goal.id, text: 'Ship it', origin: 'checkin' }, T0 + 30);
    const second = undoCompanionRun(run.runId, T0 + 2 * HOUR)!;
    assert.deepEqual(second.reverted.slice(-2), [reword, dismiss]);
    assert.equal(getItem(item.id)!.status, 'new');
    assert.equal(listGoals().find((entry) => entry.id === goal.id)!.text, 'Ship the auth fix');
    assert.equal(second.undone, false, 'the page edit still stands');
  });

  test('a goal it removed does not come back past the goal limit', () => {
    const goals = Array.from({ length: COMPANION_LIMITS.maxGoals }, (_, index) => addGoal(`Goal ${index}`, T0 - HOUR));
    const run = checkin();
    editGoal({ action: 'remove', id: goals[0]!.id, origin: 'checkin' }, T0 + 1);
    const remove = recordRunChange({ runId: run.runId, targetKind: 'goal', targetId: goals[0]!.id, action: 'remove',
      before: { text: 'Goal 0', textOrigin: 'user' }, after: null, reason: null, now: T0 + 1 });
    over(run.runId);
    addGoal('The user filled the slot', T0 + 2);
    const undone = undoCompanionRun(run.runId, T0 + HOUR)!;
    assert.deepEqual(undone.conflicts, [{ changeId: remove, message: `There are ${COMPANION_LIMITS.maxGoals} goals already` }]);
    assert.equal(undone.undone, false);
    assert.equal(listGoals().some((goal) => goal.id === goals[0]!.id), false);
  });

  test('only a check-in\'s run: a poll, an MVP turn or an unknown id has nothing to undo', () => {
    const poll = recordRun({ kind: 'poll', trigger: 'cr', startedAt: T0, outcome: 'ok', finishedAt: T0 + 1 });
    const mvp = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0, outcome: 'spoke', finishedAt: T0 + 1, messageId: 'm-1' });
    assert.equal(undoCompanionRun(poll.id, T0 + HOUR), null);
    assert.equal(undoCompanionRun(mvp.id, T0 + HOUR), null);
    assert.equal(undoCompanionRun('cmr-missing', T0 + HOUR), null);
  });
});
