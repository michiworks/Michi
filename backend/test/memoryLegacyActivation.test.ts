// Memory v3 boot steps: legacy pending memories become active once
// (services/memory/activateLegacyPending.ts), the retired explicit-only mode
// becomes auto once (extractionService.migrateRetiredExplicitMode), and the
// local user is enrolled for extraction without a stored mode
// (extractionRepository.listAutoModeOwners).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { activateLegacyPendingMemories } from '../src/services/memory/activateLegacyPending';
import {
  getExtractionCursor, getExtractionState, insertCommittedProposal, insertExtractionCursor, listAutoModeOwners,
} from '../src/services/memory/extractionRepository';
import { installMemoryExtractionHooks, migrateRetiredExplicitMode } from '../src/services/memory/extractionService';
import {
  createMemory, getMemory, getMemorySettings, listMemories, memoryEvents, memoryVersion, onMemoryRemoved, setMemorySettings,
  type CreateMemoryInput,
} from '../src/services/memory/memoryService';

const saved = { cloud: process.env.MICHI_CLOUD, dataDir: process.env.MICHI_DATA_DIR };
let dataDir: string;
let uninstallHooks: (() => void) | null = null;

function seedWorkspace(id: string, ownerUserId: string | null): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(id, `Workspace ${id}`, ownerUserId);
}

/** A memory as an older version stored it (pending); row order is age order. */
function stored(ownerUserId: string, body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory({ ownerUserId }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'pending', origin: 'extracted', ...extra });
}

function inWorkspace(workspaceId: string) {
  return { scope: { kind: 'workspace' as const, workspaceId } };
}

/** What older extraction recorded for a pending memory it marked maybe_global. */
function markedMaybeGlobal(record: MemoryRecord): void {
  insertCommittedProposal({ idempotencyKey: `key-${record.id}`, ownerUserId: record.ownerUserId,
    workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : 'ws-a', sourceTurnId: `turn-${record.id}`,
    memoryId: record.id, scopeHint: 'maybe_global', runId: 'mxr-old', now: 1 });
}

function statusOf(ownerUserId: string, id: string): string {
  return getDb().prepare('SELECT status FROM memories WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId)
    ? getMemory({ ownerUserId }, id).status : 'gone';
}

function metaValue(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function pendingCount(): number {
  return (getDb().prepare("SELECT count(*) AS n FROM memories WHERE status = 'pending'").get() as { n: number }).n;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-v3-boot-'));
  process.env.MICHI_DATA_DIR = dataDir;
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
  seedWorkspace('ws-a', 'alice');
  seedWorkspace('ws-b', 'alice');
  seedWorkspace('ws-bob', 'bob');
  uninstallHooks = installMemoryExtractionHooks();
});

afterEach(() => {
  uninstallHooks?.();
  uninstallHooks = null;
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.dataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('activateLegacyPendingMemories', () => {
  test('activates every pending memory once, as approvals, oldest first; merges duplicates; promotes maybe_global preferences', () => {
    const english = createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'preference', body: 'Reply in English.', status: 'active', origin: 'explicit' });
    const release = createMemory({ ownerUserId: 'alice' }, { ...inWorkspace('ws-a'), kind: 'convention', body: 'Deploy from the release branch', status: 'active', origin: 'explicit' });
    const short = createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'preference', body: 'Keep answers short', status: 'active', origin: 'explicit' });

    const pnpm = stored('alice', 'This repo uses pnpm.', { ...inWorkspace('ws-a'), kind: 'convention' });
    // A correction an agent saved in a turn that read a web page.
    const chinese = stored('alice', 'Reply in Chinese.', { kind: 'preference', origin: 'explicit', sourceRisk: 'untrusted',
      source: { nodeId: 'n-1', turnId: 't-1' }, supersedesId: english.id });
    // The same body (case and closing punctuation aside) is already active in that workspace.
    const releaseAgain = stored('alice', 'deploy from the release branch.', { ...inWorkspace('ws-a'), kind: 'convention', source: { turnId: 't-2' } });
    const emoji = stored('alice', '回复里不加 emoji', { ...inWorkspace('ws-a'), kind: 'preference' });
    markedMaybeGlobal(emoji);
    // Promoted to the user scope, where the same preference is already active.
    const shortAgain = stored('alice', 'Keep answers short.', { ...inWorkspace('ws-b'), kind: 'preference' });
    markedMaybeGlobal(shortAgain);
    // A convention stays with its project whatever the hint said.
    const tabs = stored('alice', 'Indent with tabs', { ...inWorkspace('ws-a'), kind: 'convention' });
    markedMaybeGlobal(tabs);
    const twice = [stored('alice', 'CI runs on Node 22', inWorkspace('ws-b')), stored('alice', 'CI runs on node 22', inWorkspace('ws-b'))];
    const bobs = stored('bob', 'Bob deploys on Fridays', inWorkspace('ws-bob'));

    const versionsBefore = { user: memoryVersion({ ownerUserId: 'alice' }, null), wsA: memoryVersion({ ownerUserId: 'alice' }, 'ws-a') };
    const events: MemoryChangedEvent[] = [];
    const listener = (event: MemoryChangedEvent) => { events.push(event); };
    memoryEvents.on('changed', listener);
    let result;
    try {
      result = activateLegacyPendingMemories(5_000);
    } finally {
      memoryEvents.off('changed', listener);
    }
    assert.deepEqual(result, { activated: 6, merged: 3, promoted: 1 });
    assert.equal(pendingCount(), 0);
    assert.equal(metaValue('memory_pending_activated_v1'), '5000');

    // Approval semantics: active with a new version; the corrected memory is superseded; provenance is kept.
    const activeChinese = getMemory({ ownerUserId: 'alice' }, chinese.id);
    assert.deepEqual([activeChinese.status, activeChinese.version, activeChinese.sourceRisk, activeChinese.origin],
      ['active', 2, 'untrusted', 'explicit']);
    assert.deepEqual(activeChinese.source, { nodeId: 'n-1', turnId: 't-1' });
    assert.equal(statusOf('alice', english.id), 'superseded');
    assert.equal(statusOf('alice', pnpm.id), 'active');
    assert.deepEqual(getMemory({ ownerUserId: 'alice' }, pnpm.id).scope, { kind: 'workspace', workspaceId: 'ws-a' });
    assert.equal(statusOf('alice', release.id), 'active');
    assert.equal(statusOf('alice', short.id), 'active');

    // Duplicates are removed, leaving the extraction tombstone and no text.
    for (const merged of [releaseAgain, shortAgain, twice[1]!]) assert.equal(statusOf('alice', merged.id), 'gone', merged.body);
    const tombstones = getDb().prepare('SELECT * FROM memory_extraction_tombstones ORDER BY seq').all() as Array<Record<string, unknown>>;
    assert.equal(tombstones.length, 3);
    assert.ok(tombstones.every((row) => row.reason === 'rejected' && row.owner_user_id === 'alice'));
    assert.equal(tombstones[0]!.source_turn_id, 't-2');
    assert.ok(!JSON.stringify(tombstones).includes('release'), 'tombstones keep no body text');

    // maybe_global: a preference moves to the user scope, a convention does not.
    const promoted = getMemory({ ownerUserId: 'alice' }, emoji.id);
    assert.deepEqual([promoted.status, promoted.scope], ['active', { kind: 'user' }]);
    assert.deepEqual(getMemory({ ownerUserId: 'alice' }, tabs.id).scope, { kind: 'workspace', workspaceId: 'ws-a' });
    assert.equal(statusOf('alice', twice[0]!.id), 'active');

    // Every owner's, and only through that owner.
    assert.equal(statusOf('bob', bobs.id), 'active');
    assert.deepEqual(listMemories({ ownerUserId: 'bob' }).items.map((record) => record.body), ['Bob deploys on Fridays']);

    // The injected blocks see the change, and the change feed announced it as approvals.
    assert.ok(memoryVersion({ ownerUserId: 'alice' }, null) > versionsBefore.user);
    assert.ok(memoryVersion({ ownerUserId: 'alice' }, 'ws-a') > versionsBefore.wsA);
    assert.deepEqual(events.filter((event) => event.action === 'approved').map((event) => event.memoryId).sort(),
      [chinese.id, pnpm.id, emoji.id, tabs.id, twice[0]!.id, bobs.id].sort());
    assert.deepEqual(events.filter((event) => event.action === 'rejected').map((event) => event.memoryId).sort(),
      [releaseAgain.id, shortAgain.id, twice[1]!.id].sort());
    assert.deepEqual(events.filter((event) => event.action === 'superseded').map((event) => event.memoryId), [english.id]);

    // Once per database.
    const later = stored('alice', 'Pending from an older client', inWorkspace('ws-a'));
    assert.equal(activateLegacyPendingMemories(6_000), null);
    assert.equal(statusOf('alice', later.id), 'pending');
    assert.equal(metaValue('memory_pending_activated_v1'), '5000');
  });

  test('a database without pending memories only records that it ran', () => {
    createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'fact', body: 'Already active', status: 'active', origin: 'explicit' });
    assert.deepEqual(activateLegacyPendingMemories(7_000), { activated: 0, merged: 0, promoted: 0 });
    assert.equal(metaValue('memory_pending_activated_v1'), '7000');
    assert.equal(activateLegacyPendingMemories(8_000), null);
  });

  test('a failure leaves every memory pending and runs again at the next start', () => {
    const active = createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'fact', body: 'Use pnpm', status: 'active', origin: 'explicit' });
    const first = stored('alice', 'Ship on Fridays');
    const duplicate = stored('alice', 'use pnpm');
    const off = onMemoryRemoved(() => { throw new Error('tombstone write failed'); });
    try {
      assert.throws(() => activateLegacyPendingMemories(9_000), /tombstone write failed/);
    } finally {
      off();
    }
    assert.equal(statusOf('alice', first.id), 'pending', 'the approval before the failure was rolled back');
    assert.equal(getMemory({ ownerUserId: 'alice' }, first.id).version, 1);
    assert.equal(statusOf('alice', duplicate.id), 'pending');
    assert.equal(metaValue('memory_pending_activated_v1'), undefined);

    assert.deepEqual(activateLegacyPendingMemories(9_500), { activated: 1, merged: 1, promoted: 0 });
    assert.equal(statusOf('alice', first.id), 'active');
    assert.equal(statusOf('alice', duplicate.id), 'gone');
    assert.equal(statusOf('alice', active.id), 'active');
  });
});

describe('migrateRetiredExplicitMode', () => {
  test('stores auto for explicit-only owners once, moving their extraction past what they said before', () => {
    delete process.env.MICHI_CLOUD;
    const owners = { explicit: 'local-user', off: 'off-owner', auto: 'auto-owner' };
    for (const [mode, ownerUserId] of Object.entries(owners)) {
      getDb().prepare('INSERT INTO memory_settings (owner_user_id, mode, updated_at) VALUES (?, ?, 1)').run(ownerUserId, mode);
    }
    // The local user had auto mode once (a cursor at 1), then chose explicit-only; three more turns completed since.
    insertExtractionCursor({ workspaceId: 'ws-a', ownerUserId: 'local-user', cursor: 1, now: 1 });
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('conversation_completion_seq:ws-a', '4')").run();
    const before = getExtractionCursor('ws-a', 'local-user')!;
    const settingsEvents: unknown[] = [];
    const listener = (event: unknown) => { settingsEvents.push(event); };
    memoryEvents.on('settingsChanged', listener);
    try {
      assert.deepEqual(migrateRetiredExplicitMode(10_000), ['local-user']);
    } finally {
      memoryEvents.off('settingsChanged', listener);
    }
    const modes = Object.fromEntries((getDb().prepare('SELECT owner_user_id, mode FROM memory_settings').all() as Array<{ owner_user_id: string; mode: string }>)
      .map((row) => [row.owner_user_id, row.mode]));
    assert.deepEqual(modes, { 'local-user': 'auto', 'off-owner': 'off', 'auto-owner': 'auto' });
    assert.deepEqual(settingsEvents, [], 'memory was already on in effect');
    const after = getExtractionCursor('ws-a', 'local-user')!;
    assert.equal(after.completionCursor, 4, 'turns from the explicit-only time are never read');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(getExtractionState('local-user').enabledAt, 10_000);
    assert.equal(metaValue('memory_explicit_mode_migrated_v1'), '10000');

    // Once per database: a later explicit row (an older backend on the same data) is left to read as auto.
    getDb().prepare("UPDATE memory_settings SET mode = 'explicit' WHERE owner_user_id = 'auto-owner'").run();
    assert.equal(migrateRetiredExplicitMode(11_000), null);
    assert.deepEqual(getMemorySettings('auto-owner'), { mode: 'auto' });
  });

  test('on a cloud backend it only rewrites the mode', () => {
    getDb().prepare("INSERT INTO memory_settings (owner_user_id, mode, updated_at) VALUES ('alice', 'explicit', 1)").run();
    assert.deepEqual(migrateRetiredExplicitMode(12_000), ['alice']);
    assert.deepEqual(getMemorySettings('alice'), { mode: 'auto' });
    assert.equal(getExtractionState('alice').enabledAt, null, 'cloud backends run no extraction');
  });
});

describe('listAutoModeOwners', () => {
  test('the local user is on without a stored mode; off is honoured; the retired explicit counts as on', () => {
    assert.deepEqual(listAutoModeOwners('local-user'), ['local-user']);
    assert.deepEqual(listAutoModeOwners(null), []);
    getDb().prepare("INSERT INTO memory_settings (owner_user_id, mode, updated_at) VALUES ('alice', 'explicit', 1), ('bob', 'off', 1), ('carol', 'auto', 1)").run();
    assert.deepEqual(listAutoModeOwners('local-user'), ['alice', 'carol', 'local-user']);
    setMemorySettings('local-user', { mode: 'off' });
    assert.deepEqual(listAutoModeOwners('local-user'), ['alice', 'carol']);
    setMemorySettings('local-user', { mode: 'auto' });
    assert.deepEqual(listAutoModeOwners('local-user'), ['alice', 'carol', 'local-user']);
  });
});
