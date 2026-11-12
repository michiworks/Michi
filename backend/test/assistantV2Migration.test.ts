/**
 * The one-time v2 merge (DESIGN-v2 §7, §8.1(c)): V is the Spaces window's
 * current conversation, kept as it is; the Scheduled window's conversation
 * is archived when it has messages and stays in History; the MVP Companion's
 * is archived and closed whatever its row said; both pointers go; the
 * agent's settings migrate (the MVP's default name 'Companion' becomes
 * 'Michi' without counting as chosen, any other name stays and counts as
 * chosen) and its notes count as a check-in's; `assistant:v2_merged_at` is
 * written. Steps 2-6 are one transaction: a failing step leaves everything
 * as it was. A second run changes nothing. Temp MICHI_DATA_DIR per test; a
 * pre-v2 database is the v2 one with the key removed and the old pointers
 * and conversations put back.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_COMPANION_NAME, LEGACY_DEFAULT_COMPANION_NAME, type MichiAssistantInfo } from 'michi-shared';
import { assistantPurposeKey } from '../src/assistant/identity';
import {
  ASSISTANT_V2_MERGED_AT_KEY,
  AssistantSettingsError,
  activateAssistantConversation,
  assistantPurposeOf,
  assistantV2MergedAt,
  ensureAssistant,
  listAssistantConversations,
  migrateAssistantV2,
  resetAssistant,
  type AssistantV2MigrationHooks,
} from '../src/assistant/store';
import { getCompanionNotesState, setNotesByUser } from '../src/services/companion/repository';
import { getCompanionSettings } from '../src/services/companion/settings';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getWorkspace, saveMessage } from '../src/services/dbRepository';

const NOW = 1_800_000_000_000;
/** store.ts records there whether the merged V held the user's messages (D7). */
const V2_HAD_MESSAGES_KEY = 'assistant:v2_had_messages';

interface PreV2 { v: MichiAssistantInfo; schedule: string; companion: string }

/** A conversation of the assistant's workspace, its own tree, with `messages` user messages. */
function conversation(workspaceId: string, id: string, purpose: string | null, messages: number): string {
  const db = getDb();
  db.prepare('INSERT INTO trees (id, workspace_id, root_node_id, name, last_active_at, created_at) VALUES (?, ?, ?, NULL, 1, 1)').run(`t-${id}`, workspaceId, id);
  db.prepare("INSERT INTO nodes (id, workspace_id, tree_id, kind, status, created_at) VALUES (?, ?, ?, 'chat', 'idle', 1)").run(id, workspaceId, `t-${id}`);
  if (purpose) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(id), purpose);
  for (let i = 0; i < messages; i++) saveMessage({ id: `${id}-m${i}`, node_id: id, role: 'user', content: `${id} question ${i}`, seq: i, created_at: 100 + i });
  return id;
}

function pointers(workspaceId: string): Record<string, unknown> {
  return JSON.parse(getWorkspace(workspaceId)!.settings!).assistant;
}

const archivedAt = (nodeId: string) => (getDb().prepare('SELECT archived_at FROM trees WHERE root_node_id = ?').get(nodeId) as { archived_at: number | null }).archived_at;

/** The MVP's database: V, the Scheduled window's conversation, the Companion's (its meta row gone), both pointers, no merge key. */
function preV2(opts: { scheduleMessages?: number; storedName?: string } = {}): PreV2 {
  const v = ensureAssistant();
  saveMessage({ id: 'v-m0', node_id: v.nodeId, role: 'user', content: 'What changed today', seq: 0, created_at: 90 });
  const schedule = conversation(v.workspaceId, 'n-old-schedule', 'schedule', opts.scheduleMessages ?? 2);
  const companion = conversation(v.workspaceId, 'n-old-companion', null, 1);
  const settings = JSON.parse(getWorkspace(v.workspaceId)!.settings!);
  settings.assistant = { nodeId: v.nodeId, scheduleNodeId: schedule, companionNodeId: companion };
  const db = getDb();
  db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), v.workspaceId);
  db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(ASSISTANT_V2_MERGED_AT_KEY, V2_HAD_MESSAGES_KEY);
  if (opts.storedName !== undefined) {
    // The MVP stored the whole settings object on every PATCH, without `reasoning`.
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('companion:settings', JSON.stringify({ displayName: opts.storedName }));
  }
  return { v, schedule, companion };
}

describe('the v2 merge (DESIGN-v2 §7)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-assistant-v2-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('V stays the current conversation; the Scheduled one is archived into History; the Companion\'s is archived and closed; the pointers go', () => {
    const { v, schedule, companion } = preV2();
    assert.equal(assistantPurposeOf(companion), 'main', 'before: nothing closes the Companion\'s conversation but its pointer');
    const result = migrateAssistantV2(undefined, NOW);
    assert.deepEqual(result, { vNodeId: v.nodeId, mergedAt: NOW });
    assert.equal(assistantV2MergedAt(), NOW);

    assert.equal(ensureAssistant().nodeId, v.nodeId, 'V is the Spaces window\'s conversation, as it was');
    assert.equal(archivedAt(v.nodeId), null);
    assert.deepEqual(pointers(v.workspaceId), { nodeId: v.nodeId }, 'both old pointers are gone');

    assert.equal(archivedAt(schedule), NOW);
    assert.equal(assistantPurposeOf(schedule), 'main');
    assert.equal(archivedAt(companion), NOW);
    assert.equal(assistantPurposeOf(companion), 'checkin', 'closed whatever its row said');

    // History: V and the old Scheduled conversation, never the Companion's; the Scheduled one can be picked up again.
    assert.deepEqual(new Set(listAssistantConversations(50).items.map((item) => item.nodeId)), new Set([v.nodeId, schedule]));
    assert.equal(activateAssistantConversation(schedule).nodeId, schedule);
    assert.equal(archivedAt(schedule), null);
    assert.throws(() => activateAssistantConversation(companion), AssistantSettingsError);
  });

  test('a Scheduled conversation without messages is left as it was', () => {
    const { v, schedule } = preV2({ scheduleMessages: 0 });
    migrateAssistantV2(undefined, NOW);
    assert.equal(archivedAt(schedule), null);
    assert.deepEqual(pointers(v.workspaceId), { nodeId: v.nodeId });
    assert.ok(!listAssistantConversations(50).items.some((item) => item.nodeId === schedule));
  });

  test('§8.1(c): the MVP\'s default name becomes Michi; reasoning is added; the notes count as a check-in\'s', () => {
    preV2({ storedName: LEGACY_DEFAULT_COMPANION_NAME });
    setNotesByUser('Watch CR-1 until it merges');
    assert.equal(getCompanionNotesState().origin, 'user');
    migrateAssistantV2(undefined, NOW);
    assert.equal(getCompanionSettings().displayName, DEFAULT_COMPANION_NAME);
    assert.equal(JSON.parse((getDb().prepare("SELECT value FROM meta WHERE key = 'companion:settings'").get() as { value: string }).value).reasoning, null);
    assert.equal(getCompanionNotesState().origin, 'checkin', 'not inlined into V until the user writes or keeps them');
    assert.equal(getCompanionNotesState().notes, 'Watch CR-1 until it merges', 'the notes themselves are kept');
  });

  test('§8.1(c): a name the user gave stays, at the merge', () => {
    preV2({ storedName: 'Robin' });
    migrateAssistantV2(undefined, NOW);
    assert.equal(getCompanionSettings().displayName, 'Robin');
  });

  test('§8.1(c): a second run changes nothing', () => {
    const { v, schedule } = preV2({ storedName: LEGACY_DEFAULT_COMPANION_NAME });
    migrateAssistantV2(undefined, NOW);
    const snapshot = () => getDb().prepare('SELECT key, value FROM meta ORDER BY key').all();
    const trees = () => getDb().prepare('SELECT id, archived_at FROM trees ORDER BY id').all();
    const before = { meta: snapshot(), trees: trees(), workspace: getWorkspace(v.workspaceId)!.settings };
    activateAssistantConversation(schedule);
    activateAssistantConversation(v.nodeId);
    const afterActivations = { meta: snapshot(), trees: trees(), workspace: getWorkspace(v.workspaceId)!.settings };

    let called = 0;
    const hooks: AssistantV2MigrationHooks = { migrateCompanionSettings: () => { called += 1; }, setNotesOrigin: () => { called += 1; } };
    assert.deepEqual(migrateAssistantV2(hooks, NOW + 5_000), { vNodeId: v.nodeId, mergedAt: NOW });
    assert.equal(called, 0, 'the key guards the whole merge');
    assert.deepEqual({ meta: snapshot(), trees: trees(), workspace: getWorkspace(v.workspaceId)!.settings }, afterActivations);
    assert.equal(before.workspace, afterActivations.workspace);
    assert.equal(getCompanionSettings().displayName, DEFAULT_COMPANION_NAME);
  });

  test('steps 2-6 are one transaction: a failing step leaves the archive, the pointers and the key as they were; the next run does it all', () => {
    const { v, schedule, companion } = preV2();
    const failing: AssistantV2MigrationHooks = {
      migrateCompanionSettings: () => {},
      setNotesOrigin: () => { throw new Error('disk full'); },
    };
    assert.throws(() => migrateAssistantV2(failing, NOW), /disk full/);
    assert.equal(assistantV2MergedAt(), null);
    assert.equal(archivedAt(schedule), null);
    assert.equal(archivedAt(companion), null);
    assert.deepEqual(pointers(v.workspaceId), { nodeId: v.nodeId, scheduleNodeId: schedule, companionNodeId: companion });
    assert.equal(getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(assistantPurposeKey(companion)), undefined);

    const calls: string[] = [];
    const hooks: AssistantV2MigrationHooks = {
      migrateCompanionSettings: (now) => { calls.push(`settings@${now}`); },
      setNotesOrigin: (origin) => { calls.push(`notes:${origin}`); },
    };
    migrateAssistantV2(hooks, NOW + 1);
    assert.deepEqual(calls, [`settings@${NOW + 1}`, 'notes:checkin']);
    assert.equal(archivedAt(schedule), NOW + 1);
    assert.equal(assistantPurposeOf(companion), 'checkin');
  });

  test('D7: hadMessagesBeforeMerge is true only for a V the user wrote in before the merge, and stays so after New conversation', () => {
    const { v } = preV2();
    migrateAssistantV2(undefined, NOW);
    assert.equal((getDb().prepare('SELECT value FROM meta WHERE key = ?').get(V2_HAD_MESSAGES_KEY) as { value: string } | undefined)?.value, '1', 'decided in the merge');
    assert.equal(ensureAssistant().hadMessagesBeforeMerge, true, 'the user wrote in V before v2: the upgrade note is theirs');
    assert.equal(resetAssistant().info.hadMessagesBeforeMerge, true, 'decided once: a New conversation does not take it away');
    assert.equal(activateAssistantConversation(v.nodeId).hadMessagesBeforeMerge, true);

    // A merge an earlier build ran recorded nothing: V's own messages from before the merge decide.
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(V2_HAD_MESSAGES_KEY);
    assert.equal(ensureAssistant().hadMessagesBeforeMerge, true);
    assert.equal(resetAssistant().info.hadMessagesBeforeMerge, false, 'that fallback reads the conversation shown');
  });

  test('D7: a new user\'s first messages never count as written before the merge', () => {
    const v = ensureAssistant();
    assert.notEqual(assistantV2MergedAt(), null, 'the merge ran on first use');
    assert.equal(v.hadMessagesBeforeMerge, false);
    saveMessage({ id: 'v-new', node_id: v.nodeId, role: 'user', content: 'Hi', seq: 0, created_at: Date.now() + 1_000 });
    saveMessage({ id: 'v-narration', node_id: v.nodeId, role: 'assistant', content: 'Setting up Pages', seq: 1, created_at: 1 });
    assert.equal(ensureAssistant().hadMessagesBeforeMerge, false, 'recorded at the merge, which found an empty V');
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(V2_HAD_MESSAGES_KEY);
    assert.equal(ensureAssistant().hadMessagesBeforeMerge, false, 'without the record: only the user\'s own messages from before the merge count');
  });

  test('ensureAssistant runs the merge when boot has not, so no route ever sees the old pointers', () => {
    const { v, companion } = preV2();
    assert.equal(assistantV2MergedAt(), null);
    assert.equal(ensureAssistant().nodeId, v.nodeId);
    assert.notEqual(assistantV2MergedAt(), null);
    assert.deepEqual(pointers(v.workspaceId), { nodeId: v.nodeId });
    assert.equal(assistantPurposeOf(companion), 'checkin');
  });
});
