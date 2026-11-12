import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb, runInTransaction } from '../src/services/db';
import { deleteWorkspace } from '../src/services/dbRepository';
import { runMigrations } from '../src/services/migrate';
import {
  MemoryError,
  approveMemory,
  createMemory,
  deleteMemory,
  getMemorySettings,
  listMemories,
  memoryEvents,
  memoryVersion,
  onMemoryRemoved,
  rejectMemory,
  setMemorySettings,
  supersedeMemory,
  updateMemory,
  type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { packMemoryRows, purgeOwnerMemories } from '../src/services/memory/memoryRepository';

const alice = { ownerUserId: 'alice' };
const bob = { ownerUserId: 'bob' };

let dataDir: string;

function seedWorkspace(id: string, name: string, ownerUserId: string | null): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(id, name, ownerUserId);
}

function save(caller: { ownerUserId: string }, body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory(caller, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'explicit', ...extra });
}

function inWorkspace(workspaceId: string) {
  return { scope: { kind: 'workspace' as const, workspaceId } };
}

function bodies(records: MemoryRecord[]): string[] {
  return records.map((record) => record.body);
}

function memoryError(code: MemoryError['code']) {
  return (error: unknown) => error instanceof MemoryError && error.code === code;
}

function ftsMatches(text: string): number {
  return (getDb().prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get(`"${text}"`) as { n: number }).n;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-'));
  process.env.MICHI_DATA_DIR = dataDir;
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
  seedWorkspace('ws-alice-1', 'Project', 'alice');
  seedWorkspace('ws-alice-2', 'Project', 'alice');
  seedWorkspace('ws-bob', 'Project', 'bob');
});

afterEach(() => {
  closeDb();
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migration 0059_memories', () => {
  test('applies on a fresh database with a trigram index kept in sync', () => {
    const db = getDb();
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = '0059_memories'").get());
    for (const name of ['memories', 'memories_fts', 'memory_scope_versions', 'memory_settings']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name), name);
    }
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string };
    assert.match(fts.sql, /tokenize='trigram'/);

    const kept = save(alice, 'keeps the index consistent');
    const edited = save(alice, 'original wording');
    const gone = save(alice, 'removed later');
    updateMemory(alice, edited.id, { body: 'edited wording' });
    deleteMemory(alice, gone.id);
    assert.equal(ftsMatches('consistent'), 1);
    assert.equal(ftsMatches('original'), 0);
    assert.equal(ftsMatches('edited'), 1);
    assert.equal(ftsMatches('removed'), 0);
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')");
    assert.ok(kept.id.startsWith('mem-'));
  });

  test('constraints reject a workspace scope without a workspace and unknown kinds', () => {
    const insert = (scope: string, workspaceId: string | null, kind: string) => getDb().prepare(`INSERT INTO memories
      (id, owner_user_id, scope, workspace_id, kind, body, status, origin, created_at, updated_at)
      VALUES (?, 'alice', ?, ?, ?, 'x', 'active', 'explicit', 1, 1)`).run(`raw-${scope}-${kind}`, scope, workspaceId, kind);
    assert.throws(() => insert('workspace', null, 'fact'), /CHECK constraint/);
    assert.throws(() => insert('user', 'ws-alice-1', 'fact'), /CHECK constraint/);
    assert.throws(() => insert('user', null, 'rumor'), /CHECK constraint/);
  });
});

describe('migration 0071_memory_v3', () => {
  test('adds keywords, event and observed times to existing memories without rebuilding the table', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-v3-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(__dirname, '../src/db/migrations');
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    // 0059's foreign key target, and the table 0071's recall triggers watch.
    db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE nodes (id TEXT PRIMARY KEY, purged_at INTEGER)');
    fs.copyFileSync(path.join(source, '0059_memories.sql'), path.join(dir, '0059_memories.sql'));
    runMigrations(db, dir);
    db.prepare(`INSERT INTO memories (id, owner_user_id, scope, workspace_id, kind, body, status, origin, source_turn_id, created_at, updated_at)
      VALUES ('mem-old', 'alice', 'user', NULL, 'fact', 'from before', 'active', 'explicit', 'turn-1', 1234, 1234)`).run();
    const createSql = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories'").get() as { sql: string }).sql;
    const before = createSql();

    fs.copyFileSync(path.join(source, '0071_memory_v3.sql'), path.join(dir, '0071_memory_v3.sql'));
    runMigrations(db, dir);
    assert.deepEqual({ ...db.prepare("SELECT keywords, event_at, observed_at, body FROM memories WHERE id = 'mem-old'").get() },
      { keywords: '', event_at: null, observed_at: 1234, body: 'from before' });
    // Additive: apart from the three new columns the definition, CHECKs included, is unchanged.
    assert.equal(createSql().replace(", keywords TEXT NOT NULL DEFAULT '', event_at INTEGER, observed_at INTEGER", ''), before);
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')");
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_memories_owner_source_turn'").get() as { sql: string };
    assert.match(index.sql, /\(owner_user_id, source_turn_id\)\s+WHERE source_turn_id IS NOT NULL/);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM memories WHERE owner_user_id = ? AND source_turn_id = ?").all('alice', 'turn-1') as Array<{ detail: string }>;
    assert.ok(plan.some((step) => /idx_memories_owner_source_turn/.test(step.detail)), JSON.stringify(plan));
    runMigrations(db, dir);
    assert.equal((db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, 2);
  });

  test('creates the recall index: documents unique per kind and ref, a contentless FTS that follows deletions', () => {
    const db = getDb();
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = '0071_memory_v3'").get());
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_recall_fts'").get() as { sql: string };
    assert.match(fts.sql, /content=''/);
    assert.match(fts.sql, /contentless_delete=1/);
    // One term per query (memoryTerms writes identifiers joined: cr-12 → cr12), so no positions are stored.
    assert.match(fts.sql, /detail=none/);
    assert.match(fts.sql, /unicode61 remove_diacritics 2/);
    const doc = (id: number, kind: string, ref: string, ownerUserId = 'alice', workspaceId: string | null = 'ws-alice-1') =>
      db.prepare(`INSERT INTO memory_recall_docs (id, owner_user_id, workspace_id, doc_kind, ref_id, at, snippet) VALUES (?, ?, ?, ?, ?, 1, 'x')`)
        .run(id, ownerUserId, workspaceId, kind, ref);
    const terms = (rowid: number, text: string) => db.prepare('INSERT INTO memory_recall_fts (rowid, terms) VALUES (?, ?)').run(rowid, text);
    const matches = (query: string) => (db.prepare('SELECT rowid FROM memory_recall_fts WHERE memory_recall_fts MATCH ? ORDER BY rowid')
      .all(query) as Array<{ rowid: number }>).map((row) => row.rowid);
    doc(1, 'memory', 'mem-1');
    doc(2, 'turn', 'turn-1');
    doc(3, 'turn', 'turn-2', 'bob', 'ws-bob');
    doc(4, 'memory', 'mem-user', 'alice', null);
    assert.throws(() => doc(5, 'memory', 'mem-1'), /UNIQUE constraint/);
    doc(6, 'turn', 'mem-1');
    terms(1, '中野 搬到 nakano');
    terms(2, '中野 部署 deploy cr12');
    terms(3, '中野 bob');
    terms(4, 'pnpm 中野');
    assert.deepEqual(matches('"中野"'), [1, 2, 3, 4]);
    assert.deepEqual(matches('"cr12"'), [2]);
    // Replacing a document's terms needs only its rowid.
    db.prepare('UPDATE memory_recall_fts SET terms = ? WHERE rowid = ?').run('目黑 deploy', 2);
    assert.deepEqual(matches('"中野"'), [1, 3, 4]);
    // A deleted document leaves no index entry, and purges delete per workspace and per owner.
    db.prepare('DELETE FROM memory_recall_docs WHERE id = 1').run();
    assert.deepEqual(matches('"中野"'), [3, 4]);
    deleteWorkspace('ws-bob', 'bob');
    assert.deepEqual(matches('"中野"'), [4]);
    purgeOwnerMemories('alice');
    assert.deepEqual(matches('"deploy" OR "中野"'), []);
    assert.equal((db.prepare('SELECT count(*) AS n FROM memory_recall_docs').get() as { n: number }).n, 0);
    db.exec("INSERT INTO memory_recall_fts(memory_recall_fts) VALUES ('integrity-check')");
  });
});

describe('keywords, event and observed times', () => {
  test('are stored, returned and edited; observedAt defaults to the creation time', () => {
    const plain = save(alice, 'no extras');
    assert.deepEqual(plain.keywords, []);
    assert.equal(plain.eventAt, null);
    assert.equal(plain.observedAt, plain.createdAt);

    const dated = save(alice, 'Flight to Osaka on 2026-12-01', {
      keywords: ['  Osaka  trip ', '大阪', 'osaka trip', 'flight', ''], eventAt: Date.UTC(2026, 11, 1), observedAt: 1_000,
    });
    assert.deepEqual(dated.keywords, ['Osaka trip', '大阪', 'flight'], 'trimmed, whitespace collapsed, blanks and case duplicates dropped');
    assert.equal(dated.eventAt, Date.UTC(2026, 11, 1));
    assert.equal(dated.observedAt, 1_000);
    assert.deepEqual(listMemories(alice).items.find((record) => record.id === dated.id)?.keywords, ['Osaka trip', '大阪', 'flight']);
    assert.equal((getDb().prepare('SELECT keywords FROM memories WHERE id = ?').get(dated.id) as { keywords: string }).keywords, 'Osaka trip\n大阪\nflight');

    const edited = updateMemory(alice, dated.id, { keywords: ['大阪', 'Osaka'], eventAt: null });
    assert.deepEqual(edited.keywords, ['大阪', 'Osaka']);
    assert.equal(edited.eventAt, null);
    assert.equal(edited.version, 2);
    assert.equal(edited.observedAt, 1_000, 'an edit keeps when the user said it');
    assert.equal(updateMemory(alice, dated.id, { keywords: ['大阪', 'Osaka'], eventAt: null }).version, 2, 'no change, no new version');
    const editedAt = () => (getDb().prepare('SELECT user_edited_at FROM memories WHERE id = ?').get(dated.id) as { user_edited_at: number | null }).user_edited_at;
    assert.equal(editedAt(), null, 'an edit by another writer (an import, extraction) is not the user\'s');
    updateMemory(alice, dated.id, { keywords: ['大阪', 'Osaka'] }, undefined, { byUser: true });
    assert.equal(editedAt(), null, 'nothing changed: no edit');
    updateMemory(alice, dated.id, { keywords: ['大阪', 'Osaka', 'trip'] }, undefined, { byUser: true });
    assert.equal(typeof editedAt(), 'number', 'the user edited it (Settings): consolidation never changes it');

    // A correction takes only what it is given.
    const corrected = supersedeMemory(alice, dated.id, { body: 'Flight to Osaka on 2026-12-02', status: 'active', origin: 'explicit',
      keywords: ['Osaka'], eventAt: Date.UTC(2026, 11, 2), observedAt: 2_000 });
    assert.deepEqual([corrected.keywords, corrected.eventAt, corrected.observedAt], [['Osaka'], Date.UTC(2026, 11, 2), 2_000]);
    const bare = supersedeMemory(alice, corrected.id, { body: 'Flight to Osaka moved to January', status: 'active', origin: 'explicit' });
    assert.deepEqual([bare.keywords, bare.eventAt, bare.observedAt], [[], null, bare.createdAt]);
  });

  test('reject malformed keywords and times', () => {
    for (const extra of [
      { keywords: 'osaka' as never },
      { keywords: [7] as never },
      { keywords: ['x'.repeat(101)] },
      { keywords: Array.from({ length: 33 }, (_, i) => `k${i}`) },
      { eventAt: 1.5 },
      { eventAt: '2026-12-01' as never },
      { observedAt: 9e15 },
    ]) {
      assert.throws(() => save(alice, 'bad extras', extra), memoryError('invalid_argument'), JSON.stringify(extra));
    }
    assert.equal(save(alice, 'many keywords', { keywords: Array.from({ length: 32 }, (_, i) => `k${i}`) }).keywords?.length, 32);
    const record = save(alice, 'valid');
    assert.throws(() => updateMemory(alice, record.id, { keywords: [null] as never }), memoryError('invalid_argument'));
    assert.throws(() => updateMemory(alice, record.id, { eventAt: Number.NaN }), memoryError('invalid_argument'));
  });
});

describe('topic', () => {
  test('stored on one line within 40 characters, one spelling per owner, kept by a correction unless a new one is given, edited and cleared', () => {
    assert.equal(save(alice, 'no topic').topic, null);
    const job = save(alice, 'Works on the FMH frontend.', { topic: '  Work \n stuff ' });
    assert.equal(job.topic, 'Work stuff');
    assert.equal(save(alice, 'Long topic', { topic: 'x'.repeat(60) }).topic, 'x'.repeat(40), 'a label is cut, not refused');
    assert.equal(save(alice, 'Reviews go through Anders.', { topic: 'work STUFF' }).topic, 'Work stuff', 'the owner\'s spelling');
    assert.equal(save(bob, 'Bob works too.', { topic: 'work STUFF' }).topic, 'work STUFF', 'another owner\'s spelling is not read');
    const corrected = supersedeMemory(alice, job.id, { body: 'Works on the FMH frontend and Michi.', status: 'active', origin: 'explicit' });
    assert.equal(corrected.topic, 'Work stuff', 'a correction stays in its topic');
    assert.equal(supersedeMemory(alice, corrected.id, { body: 'Builds Michi.', status: 'active', origin: 'explicit', topic: 'Michi' }).topic, 'Michi');
    const edited = updateMemory(alice, save(alice, 'Lives in Tokyo.').id, { topic: 'Home' });
    assert.equal(edited.topic, 'Home');
    assert.equal(updateMemory(alice, edited.id, { topic: 'Home' }).version, edited.version, 'no change, no new version');
    assert.equal(updateMemory(alice, edited.id, { topic: null }).topic, null);
    assert.throws(() => save(alice, 'bad', { topic: 3 as never }), memoryError('invalid_argument'));
  });
});

describe('ownership', () => {
  test('another owner can neither see nor change a memory', () => {
    const own = save(alice, 'alice prefers dark mode', { kind: 'preference' });
    const pending = save(alice, 'alice pending note', { status: 'pending' });

    assert.throws(() => updateMemory(bob, own.id, { body: 'hijacked' }), memoryError('not_found'));
    assert.throws(() => deleteMemory(bob, own.id), memoryError('not_found'));
    assert.throws(() => approveMemory(bob, pending.id), memoryError('not_found'));
    assert.throws(() => rejectMemory(bob, pending.id), memoryError('not_found'));
    assert.throws(() => supersedeMemory(bob, own.id, { body: 'x', status: 'active', origin: 'explicit' }), memoryError('not_found'));
    assert.throws(() => save(bob, 'correction', { supersedesId: own.id }), memoryError('not_found'));
    assert.deepEqual(listMemories(bob).items, []);
    assert.deepEqual(listMemories(bob, { query: 'dark mode' }).items, []);

    assert.equal(listMemories(alice).items.length, 2);
    assert.equal(updateMemory(alice, own.id, {}).body, 'alice prefers dark mode');
  });

  test('a workspace scope must be a workspace the caller owns', () => {
    assert.throws(() => save(bob, 'into alice workspace', inWorkspace('ws-alice-1')), memoryError('not_found'));
    assert.throws(() => save(bob, 'into a missing workspace', inWorkspace('ws-missing')), memoryError('not_found'));
    assert.throws(() => listMemories(bob, { workspaceId: 'ws-alice-1' }), memoryError('not_found'));
    assert.throws(() => listMemories(bob, { query: 'anything', workspaceId: 'ws-alice-1' }), memoryError('not_found'));

    const own = save(bob, 'bob note', inWorkspace('ws-bob'));
    assert.throws(() => updateMemory(bob, own.id, { scope: { kind: 'workspace', workspaceId: 'ws-alice-1' } }), memoryError('not_found'));
    assert.deepEqual(updateMemory(bob, own.id, { scope: { kind: 'user' } }).scope, { kind: 'user' });
  });

  test('a permanently deleted workspace takes its memories with it and accepts no new ones', () => {
    const kept = save(alice, 'user scoped survives');
    save(alice, 'workspace scoped goes', inWorkspace('ws-alice-1'));
    deleteWorkspace('ws-alice-1', 'alice');
    assert.deepEqual(bodies(listMemories(alice).items), [kept.body]);
    assert.equal(ftsMatches('scoped goes'), 0);
    assert.throws(() => save(alice, 'too late', inWorkspace('ws-alice-1')), memoryError('not_found'));
  });

  test('deleting an account purges its memories, counters and settings only', () => {
    save(alice, 'alice user note');
    save(alice, 'alice workspace note', inWorkspace('ws-alice-1'));
    setMemorySettings('alice', { mode: 'off' });
    const bobs = save(bob, 'bob note');
    purgeOwnerMemories('alice');
    assert.deepEqual(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items, []);
    assert.deepEqual(getMemorySettings('alice'), { mode: 'auto' });
    assert.equal(memoryVersion(alice, 'ws-alice-1'), 0);
    assert.equal(ftsMatches('alice'), 0);
    assert.deepEqual(listMemories(bob).items.map((record) => record.id), [bobs.id]);
  });

  test('on the desktop the local user owns legacy workspaces without an owner', () => {
    delete process.env.MICHI_CLOUD;
    seedWorkspace('ws-legacy', 'Legacy', null);
    const local = { ownerUserId: 'local-user' };
    const record = save(local, 'legacy workspace note', inWorkspace('ws-legacy'));
    assert.deepEqual(record.scope, { kind: 'workspace', workspaceId: 'ws-legacy' });
    assert.throws(() => save(alice, 'not alice workspace', inWorkspace('ws-legacy')), memoryError('not_found'));
  });

  test('two workspaces with the same name stay isolated', () => {
    save(alice, 'deploys with the blue pipeline', inWorkspace('ws-alice-1'));
    save(alice, 'deploys with the green pipeline', inWorkspace('ws-alice-2'));
    save(bob, 'deploys with the red pipeline', inWorkspace('ws-bob'));

    assert.deepEqual(bodies(listMemories(alice, { query: 'pipeline', workspaceId: 'ws-alice-1' }).items), ['deploys with the blue pipeline']);
    assert.deepEqual(bodies(listMemories(alice, { query: 'pipeline', workspaceId: 'ws-alice-2' }).items), ['deploys with the green pipeline']);
    assert.deepEqual(bodies(listMemories(alice, { scope: 'workspace', workspaceId: 'ws-alice-2' }).items), ['deploys with the green pipeline']);
    assert.deepEqual(bodies(listMemories(alice, { scope: 'workspace' }).items).sort(),
      ['deploys with the blue pipeline', 'deploys with the green pipeline']);
    // The user scope alone holds none of them.
    assert.deepEqual(listMemories(alice, { query: 'pipeline', scope: 'user' }).items, []);
  });
});

describe('search', () => {
  // Ranked recall is recallIndex.recallSearch (memoryRecallIndex.test.ts); the list's query filter uses this index.
  test('the list filter finds Chinese with two-character (LIKE) and three-or-more-character (trigram) terms', () => {
    save(alice, '回答请使用中文，并保持简洁', { kind: 'preference' });
    save(alice, '提交信息用英文写');
    assert.deepEqual(bodies(listMemories(alice, { query: '中文' }).items), ['回答请使用中文，并保持简洁']);
    assert.deepEqual(bodies(listMemories(alice, { query: '用中文' }).items), ['回答请使用中文，并保持简洁']);
    assert.deepEqual(bodies(listMemories(alice, { query: '使用中文' }).items), ['回答请使用中文，并保持简洁']);
    assert.deepEqual(bodies(listMemories(alice, { query: '英文' }).items), ['提交信息用英文写']);
    assert.deepEqual(listMemories(alice, { query: '日文' }).items, []);
  });

  test('the list filter matches English case-insensitively and needs every term', () => {
    save(alice, 'Prefer pnpm over npm in this repository');
    save(alice, 'Run the linter before pushing');
    save(alice, 'The repository uses pnpm workspaces and the linter config lives at the root');
    assert.deepEqual(bodies(listMemories(alice, { query: 'PNPM' }).items).sort(), [
      'Prefer pnpm over npm in this repository',
      'The repository uses pnpm workspaces and the linter config lives at the root',
    ]);
    assert.deepEqual(bodies(listMemories(alice, { query: 'pnpm linter repository' }).items),
      ['The repository uses pnpm workspaces and the linter config lives at the root']);
  });

  test('treats FTS and LIKE syntax in a query literally', () => {
    save(alice, 'coverage goal is 100% of src_dir');
    save(alice, 'cobalt theme');
    save(alice, 'cod liver oil');
    save(alice, 'say "hello" AND NEAR(x)');
    assert.deepEqual(bodies(listMemories(alice, { query: '100%' }).items), ['coverage goal is 100% of src_dir']);
    assert.deepEqual(bodies(listMemories(alice, { query: '%' }).items), ['coverage goal is 100% of src_dir']);
    // `_` is not a wildcard: "o_" is not in "cobalt" or "cod", and "c_d" is only in "src_dir".
    assert.deepEqual(listMemories(alice, { query: 'o_' }).items, []);
    assert.deepEqual(bodies(listMemories(alice, { query: 'c_d' }).items), ['coverage goal is 100% of src_dir']);
    assert.deepEqual(bodies(listMemories(alice, { query: '"hello"' }).items), ['say "hello" AND NEAR(x)']);
    assert.deepEqual(bodies(listMemories(alice, { query: 'NEAR(' }).items), ['say "hello" AND NEAR(x)']);
    assert.deepEqual(listMemories(alice, { query: '* OR ^' }).items, []);
  });

  test('a workspace is listed together with the user scope unless the scope is workspace', () => {
    save(alice, 'shared style rule');
    save(alice, 'workspace style rule', inWorkspace('ws-alice-1'));
    assert.deepEqual(bodies(listMemories(alice, { query: 'style', workspaceId: 'ws-alice-1' }).items).sort(),
      ['shared style rule', 'workspace style rule']);
    assert.deepEqual(bodies(listMemories(alice, { query: 'style', workspaceId: 'ws-alice-1', scope: 'workspace' }).items),
      ['workspace style rule']);
  });

  test('list filters by every term and pages with an opaque cursor', () => {
    for (let i = 1; i <= 5; i++) save(alice, `note ${i} about 部署`);
    save(alice, 'unrelated');
    const first = listMemories(alice, { limit: 2, query: 'note 部署' });
    assert.deepEqual(bodies(first.items), ['note 5 about 部署', 'note 4 about 部署']);
    assert.ok(first.nextCursor);
    const second = listMemories(alice, { limit: 2, query: 'note 部署', cursor: first.nextCursor });
    assert.deepEqual(bodies(second.items), ['note 3 about 部署', 'note 2 about 部署']);
    const third = listMemories(alice, { limit: 2, query: 'note 部署', cursor: second.nextCursor });
    assert.deepEqual(bodies(third.items), ['note 1 about 部署']);
    assert.equal(third.nextCursor, null);
    assert.throws(() => listMemories(alice, { cursor: 'not-a-cursor' }), memoryError('invalid_argument'));
    assert.throws(() => listMemories(alice, { scope: 'user', workspaceId: 'ws-alice-1' }), memoryError('invalid_argument'));
  });
});

describe('corrections and approval', () => {
  test('an active correction supersedes the old value, which default search and list no longer return', () => {
    const old = save(alice, 'indent with tabs', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    const correction = supersedeMemory(alice, old.id, { body: 'indent with two spaces', status: 'active', origin: 'explicit' });
    assert.equal(correction.supersedesId, old.id);
    assert.equal(correction.kind, 'convention');
    assert.deepEqual(correction.scope, { kind: 'workspace', workspaceId: 'ws-alice-1' });

    assert.deepEqual(bodies(listMemories(alice, { query: 'indent', workspaceId: 'ws-alice-1' }).items), ['indent with two spaces']);
    assert.deepEqual(bodies(listMemories(alice).items), ['indent with two spaces']);
    const history = listMemories(alice, { query: 'indent', workspaceId: 'ws-alice-1', status: ['active', 'superseded'] }).items;
    const superseded = history.find((record) => record.id === old.id);
    assert.equal(superseded?.status, 'superseded');
    assert.equal(superseded?.version, 2);

    assert.throws(() => supersedeMemory(alice, old.id, { body: 'indent with four spaces', status: 'active', origin: 'explicit' }),
      memoryError('invalid_state'));
    assert.throws(() => updateMemory(alice, old.id, { body: 'rewrite history' }), memoryError('invalid_state'));
  });

  test('a pending correction leaves the old value active until it is approved', () => {
    const old = save(alice, 'release on Fridays', { kind: 'decision' });
    const pending = supersedeMemory(alice, old.id, {
      body: 'release on Tuesdays', status: 'pending', origin: 'extracted', sourceRisk: 'untrusted', source: { turnId: 'turn-1', nodeId: 'node-1' },
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.sourceRisk, 'untrusted');
    assert.deepEqual(pending.source, { turnId: 'turn-1', nodeId: 'node-1' });
    assert.deepEqual(bodies(listMemories(alice, { query: 'release', status: ['active'] }).items), ['release on Fridays']);
    assert.deepEqual(bodies(listMemories(alice, { status: ['pending'] }).items), ['release on Tuesdays']);

    const approved = approveMemory(alice, pending.id);
    assert.equal(approved.status, 'active');
    assert.equal(approved.version, 2);
    assert.deepEqual(bodies(listMemories(alice, { query: 'release', status: ['active'] }).items), ['release on Tuesdays']);
    assert.equal(listMemories(alice, { status: ['superseded'] }).items[0]?.id, old.id);
    assert.throws(() => approveMemory(alice, pending.id), memoryError('invalid_state'));
  });

  test('rejecting removes a pending memory and only a pending one', () => {
    const old = save(alice, 'use yarn');
    const pending = supersedeMemory(alice, old.id, { body: 'use bun', status: 'pending', origin: 'extracted' });
    assert.throws(() => rejectMemory(alice, old.id), memoryError('invalid_state'));
    rejectMemory(alice, pending.id);
    assert.throws(() => approveMemory(alice, pending.id), memoryError('not_found'));
    assert.deepEqual(bodies(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items), ['use yarn']);
    assert.equal(ftsMatches('use bun'), 0);
  });

  test('deleting the corrected memory takes its pending correction with it: one memory, every version', () => {
    const old = save(alice, 'old fact');
    const pending = supersedeMemory(alice, old.id, { body: 'new fact', status: 'pending', origin: 'explicit' });
    deleteMemory(alice, old.id);
    assert.throws(() => approveMemory(alice, pending.id), memoryError('not_found'));
    assert.deepEqual(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items, []);
  });
});

describe('delete, versions and events', () => {
  test('a deleted memory is gone from search, list and the index, and removal hooks run in its transaction', () => {
    const record = save(alice, 'secret project codename');
    const removals: string[] = [];
    const off = onMemoryRemoved(({ record: removed, reason }) => {
      removals.push(`${reason}:${removed.id}`);
      assert.equal(getDb().prepare('SELECT 1 FROM memories WHERE id = ?').get(removed.id), undefined);
    });
    try {
      deleteMemory(alice, record.id);
    } finally {
      off();
    }
    assert.deepEqual(removals, [`deleted:${record.id}`]);
    assert.deepEqual(listMemories(alice, { query: 'codename' }).items, []);
    assert.deepEqual(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items, []);
    assert.equal(ftsMatches('codename'), 0);
    assert.throws(() => deleteMemory(alice, record.id), memoryError('not_found'));
  });

  test('a delete takes every version of the memory, the corrections before and after it, each with its hook', () => {
    const first = save(alice, 'lives in Meguro', { source: { nodeId: 'node-1', turnId: 'turn-1' } });
    const second = supersedeMemory(alice, first.id, { body: 'lives in Nakano', status: 'active', origin: 'explicit' });
    const third = supersedeMemory(alice, second.id, { body: 'lives in Koenji', status: 'active', origin: 'explicit' });
    save(alice, 'prefers tea');
    save(bob, 'lives in Meguro too');
    const removals: string[] = [];
    const off = onMemoryRemoved(({ record, reason }) => {
      removals.push(`${reason}:${record.id}`);
      assert.equal(getDb().prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id), undefined);
    });
    try {
      // A middle version named: the chain is followed both ways.
      deleteMemory(alice, second.id);
    } finally {
      off();
    }
    assert.deepEqual(removals.sort(), [first.id, second.id, third.id].map((id) => `deleted:${id}`).sort());
    assert.deepEqual(bodies(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items), ['prefers tea']);
    const docs = getDb().prepare("SELECT count(*) AS n FROM memory_recall_docs WHERE doc_kind = 'memory' AND ref_id IN (?, ?, ?)")
      .get(first.id, second.id, third.id) as { n: number };
    assert.equal(docs.n, 0);
    assert.equal(ftsMatches('Meguro'), 1, "bob's memory stays");
  });

  test('a hook that throws for any version rolls the whole delete back', () => {
    const old = save(alice, 'first wording');
    const next = supersedeMemory(alice, old.id, { body: 'second wording', status: 'active', origin: 'explicit' });
    const off = onMemoryRemoved(({ record }) => { if (record.id === old.id) throw new Error('tombstone write failed'); });
    try {
      assert.throws(() => deleteMemory(alice, next.id), /tombstone write failed/);
    } finally {
      off();
    }
    assert.deepEqual(bodies(listMemories(alice, { status: ['active', 'superseded'] }).items), ['second wording', 'first wording']);
  });

  test('a throwing removal hook rolls the deletion back', () => {
    const record = save(alice, 'survives a failed hook');
    const off = onMemoryRemoved(() => { throw new Error('tombstone write failed'); });
    try {
      assert.throws(() => deleteMemory(alice, record.id), /tombstone write failed/);
    } finally {
      off();
    }
    assert.deepEqual(bodies(listMemories(alice, { query: 'failed hook' }).items), ['survives a failed hook']);
  });

  test('a stale expectedVersion is a version conflict carrying the stored version', () => {
    const record = save(alice, 'first draft');
    const edited = updateMemory(alice, record.id, { body: 'second draft' }, 1);
    assert.equal(edited.version, 2);
    assert.throws(() => updateMemory(alice, record.id, { body: 'stale edit' }, 1), (error: unknown) =>
      error instanceof MemoryError && error.code === 'version_conflict' && error.currentVersion === 2);
    assert.equal(updateMemory(alice, record.id, { kind: 'decision' }, 2).version, 3);
  });

  test('memoryVersion grows with the user scope or the given workspace only', () => {
    const start = memoryVersion(alice, 'ws-alice-1');
    save(alice, 'user scope change');
    const afterUser = memoryVersion(alice, 'ws-alice-1');
    assert.ok(afterUser > start);
    save(alice, 'other workspace change', inWorkspace('ws-alice-2'));
    assert.equal(memoryVersion(alice, 'ws-alice-1'), afterUser);
    const record = save(alice, 'this workspace change', inWorkspace('ws-alice-1'));
    const afterWorkspace = memoryVersion(alice, 'ws-alice-1');
    assert.ok(afterWorkspace > afterUser);
    deleteMemory(alice, record.id);
    assert.ok(memoryVersion(alice, 'ws-alice-1') > afterWorkspace);
    assert.equal(memoryVersion(bob, 'ws-alice-1'), 0);
  });

  test('changes are announced after they commit', () => {
    const events: MemoryChangedEvent[] = [];
    const listener = (event: MemoryChangedEvent) => { events.push(event); };
    memoryEvents.on('changed', listener);
    try {
      const old = save(alice, 'event body', { ...inWorkspace('ws-alice-1'), source: { nodeId: 'node-7' } });
      const correction = supersedeMemory(alice, old.id, { body: 'event body corrected', status: 'active', origin: 'explicit' });
      deleteMemory(alice, correction.id);
      assert.deepEqual(events.map((event) => [event.action, event.memoryId, event.status]), [
        ['created', old.id, 'active'],
        ['created', correction.id, 'active'],
        ['superseded', old.id, 'superseded'],
        ['deleted', correction.id, 'active'],
        ['deleted', old.id, 'superseded'],
      ]);
      assert.deepEqual(events[0], {
        ownerUserId: 'alice', workspaceId: 'ws-alice-1', memoryId: old.id, action: 'created', status: 'active',
        body: 'event body', origin: 'explicit', nodeId: 'node-7', supersedesId: null,
      });
      assert.equal(events[1].supersedesId, old.id);
    } finally {
      memoryEvents.off('changed', listener);
    }
  });

  test('a change inside a caller\'s transaction is announced when it commits, and never if it rolls back', () => {
    const events: string[] = [];
    const listener = (event: MemoryChangedEvent) => { events.push(event.body); };
    memoryEvents.on('changed', listener);
    try {
      assert.throws(() => runInTransaction(() => { save(alice, 'rolled back'); throw new Error('settle failed'); }), /settle failed/);
      runInTransaction(() => {
        save(alice, 'committed');
        assert.deepEqual(events, []);
      });
      assert.deepEqual(events, ['committed']);
    } finally {
      memoryEvents.off('changed', listener);
    }
  });
});

describe('settings, pack rows and validation', () => {
  test('mode off refuses new memories and corrections but still lists, edits and deletes', () => {
    assert.deepEqual(getMemorySettings('alice'), { mode: 'auto' });
    const existing = save(alice, 'kept while off', { kind: 'preference' });
    const versionBefore = memoryVersion(alice, null);
    setMemorySettings('alice', { mode: 'off' });
    assert.deepEqual(getMemorySettings('alice'), { mode: 'off' });
    assert.deepEqual(getMemorySettings('bob'), { mode: 'auto' });
    assert.ok(memoryVersion(alice, null) > versionBefore);

    assert.throws(() => save(alice, 'new while off'), memoryError('memory_disabled'));
    assert.throws(() => supersedeMemory(alice, existing.id, { body: 'x', status: 'active', origin: 'explicit' }), memoryError('memory_disabled'));
    assert.deepEqual(bodies(listMemories(alice).items), ['kept while off']);
    assert.equal(updateMemory(alice, existing.id, { body: 'edited while off' }).body, 'edited while off');
    deleteMemory(alice, existing.id);
    assert.deepEqual(listMemories(alice).items, []);

    save(bob, 'bob is unaffected');
    setMemorySettings('alice', { mode: 'auto' });
    assert.equal(save(alice, 'back on').status, 'active');
    assert.throws(() => setMemorySettings('alice', { mode: 'sometimes' as never }), memoryError('invalid_argument'));
  });

  test('memory is on by default; the retired explicit mode reads and stores as auto', () => {
    const changes: Array<[string, string, string]> = [];
    const listener = (event: { ownerUserId: string; mode: string; previousMode: string }) => {
      changes.push([event.ownerUserId, event.previousMode, event.mode]);
    };
    memoryEvents.on('settingsChanged', listener);
    try {
      assert.deepEqual(getMemorySettings('alice'), { mode: 'auto' });
      // A row an older version wrote: on, like auto.
      getDb().prepare("INSERT INTO memory_settings (owner_user_id, mode, updated_at) VALUES ('bob', 'explicit', 1)").run();
      assert.deepEqual(getMemorySettings('bob'), { mode: 'auto' });
      assert.equal(save(bob, 'saved under explicit').status, 'active');

      // An older client choosing "Explicit only" stores auto, which changes nothing in effect.
      const before = memoryVersion(alice, null);
      setMemorySettings('alice', { mode: 'explicit' });
      assert.equal((getDb().prepare("SELECT mode FROM memory_settings WHERE owner_user_id = 'alice'").get() as { mode: string }).mode, 'auto');
      assert.deepEqual(getMemorySettings('alice'), { mode: 'auto' });
      assert.equal(memoryVersion(alice, null), before);
      assert.deepEqual(changes, []);

      setMemorySettings('alice', { mode: 'off' });
      setMemorySettings('alice', { mode: 'explicit' });
      assert.deepEqual(getMemorySettings('alice'), { mode: 'auto' });
      assert.deepEqual(changes, [['alice', 'auto', 'off'], ['alice', 'off', 'auto']]);
    } finally {
      memoryEvents.off('settingsChanged', listener);
    }
  });

  test('pack rows: active saved memories of any kind and active preferences and conventions, newest said first, user scope and one workspace', () => {
    const at = (day: number) => ({ observedAt: Date.UTC(2026, 9, day) });
    save(alice, 'aaaa', { kind: 'preference', origin: 'extracted', ...at(1) });
    save(alice, 'an extracted fact is not pinned', { kind: 'fact', origin: 'extracted', ...at(2) });
    save(alice, 'a saved fact is', { kind: 'fact', ...at(3) });
    save(alice, 'pending is not pinned', { kind: 'preference', status: 'pending', ...at(4) });
    save(alice, 'bbbbbbbbbb', { kind: 'convention', origin: 'extracted', ...inWorkspace('ws-alice-1'), ...at(5) });
    save(alice, 'other workspace', { kind: 'convention', ...inWorkspace('ws-alice-2'), ...at(6) });
    save(alice, 'dddddddd', { kind: 'preference', ...at(7) });
    const rows = (workspaceId: string | null, limit = 50, owner = 'alice') => packMemoryRows(owner, workspaceId, limit).map((row) => row.record.body);
    assert.deepEqual(rows('ws-alice-1'), ['dddddddd', 'bbbbbbbbbb', 'a saved fact is', 'aaaa']);
    assert.deepEqual(rows(null), ['dddddddd', 'a saved fact is', 'aaaa']);
    assert.deepEqual(rows('ws-alice-1', 2), ['dddddddd', 'bbbbbbbbbb']);
    assert.deepEqual(rows('ws-alice-1', 50, 'bob'), []);
    assert.ok(packMemoryRows('alice', null, 1)[0].rowId > 0);
  });

  test('rejects malformed input', () => {
    assert.throws(() => save(alice, '   '), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'x'.repeat(2001)), memoryError('invalid_argument'));
    assert.equal(save(alice, `  ${'x'.repeat(2000)}  `).body.length, 2000);
    assert.throws(() => save(alice, 'bad kind', { kind: 'rumor' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad status', { status: 'superseded' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad origin', { origin: 'guessed' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad risk', { sourceRisk: 'risky' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad source', { source: { ownerUserId: 'bob' } as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad scope', { scope: { kind: 'user', workspaceId: 'ws-alice-1' } as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad scope', { scope: { kind: 'global' } as never }), memoryError('invalid_argument'));
    assert.throws(() => save({ ownerUserId: ' ' }, 'no owner'), memoryError('invalid_argument'));
    assert.throws(() => listMemories(alice, { query: 'x', limit: 0 }), memoryError('invalid_argument'));
    assert.throws(() => listMemories(alice, { status: ['deleted' as never] }), memoryError('invalid_argument'));
  });
});
