/**
 * The one-way import of the runtimes' own memories (services/memory/nativeMemoryImport.ts),
 * against fixture directories laid out as Claude Code 2.1, Codex 0.167 and
 * Kiro (KAS) 3.1 write them. The user's real ~/.claude, ~/.codex and ~/.kiro
 * are never read: every pass names its directories.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_BODY_MAX_CHARS, type MemoryRecord } from 'michi-shared';
import { claudeProjectSlug } from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { purgeOwnerMemories } from '../src/services/memory/memoryRepository';
import {
  createMemory, deleteMemory, forgetMemory, getMemory, listMemories, setMemorySettings, updateMemory,
} from '../src/services/memory/memoryService';
import { syncNativeMemories, type NativeMemoryImportOptions } from '../src/services/memory/nativeMemoryImport';

const me = { ownerUserId: LOCAL_AGENT_OWNER_ID };

let root: string;
let claudeDir: string;
let codexHome: string;
let kiroHome: string;
let repo: string;
let worktree: string;
let memoryDir: string;
let project: string;
let kiroDb: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Every file under the fixture's runtime homes, with its content hash: the import must change none of them. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const home of [claudeDir, codexHome, kiroHome]) {
    for (const entry of fs.readdirSync(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
      out[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex') + ':' + fs.statSync(file).mtimeMs;
    }
  }
  return out;
}

function memories(): MemoryRecord[] {
  return listMemories(me, { limit: 200 }).items;
}

function imported(source: string, workspaceId: string | null): MemoryRecord[] {
  return memories().filter((record) => record.importSource === source
    && (workspaceId === null ? record.scope.kind === 'user' : record.scope.kind === 'workspace' && record.scope.workspaceId === workspaceId))
    .sort((a, b) => (a.importRef ?? '').localeCompare(b.importRef ?? ''));
}

function byRef(ref: string, workspaceId = 'ws-app'): MemoryRecord {
  const found = memories().find((record) => record.importRef === ref && record.scope.kind === 'workspace' && record.scope.workspaceId === workspaceId);
  assert.ok(found, `a memory imported from ${ref} into ${workspaceId}`);
  return found;
}

function sync(seen = new Map<string, string>(), extra: NativeMemoryImportOptions = {}) {
  return syncNativeMemories({ claudeConfigDir: claudeDir, codexHome, kiroHome, seen, ...extra });
}

/** For each ref of the source, the scopes holding a row for it ('' is the user scope). */
function rowScopes(source: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const rows = getDb().prepare('SELECT workspace_id, import_ref FROM memory_import_items WHERE import_source = ? ORDER BY import_ref, workspace_id')
    .all(source) as Array<{ workspace_id: string; import_ref: string }>;
  for (const row of rows) (out[row.import_ref] ??= []).push(row.workspace_id);
  return out;
}

/** What an earlier version left when another workspace had the same folder: its own copy of every item, and a row for it. */
function copiesAsBefore(from: string, into: string): void {
  const rows = getDb().prepare('SELECT import_source, import_ref, memory_id, body_hash FROM memory_import_items WHERE workspace_id = ? AND memory_id IS NOT NULL')
    .all(from) as Array<{ import_source: string; import_ref: string; memory_id: string; body_hash: string }>;
  for (const row of rows) {
    const original = getMemory(me, row.memory_id);
    const copy = createMemory(me, {
      scope: { kind: 'workspace', workspaceId: into }, kind: original.kind, body: original.body, status: 'active', origin: 'extracted',
      observedAt: original.observedAt,
    });
    getDb().prepare('UPDATE memories SET import_source = ?, import_ref = ? WHERE id = ?').run(row.import_source, row.import_ref, copy.id);
    getDb().prepare(`INSERT INTO memory_import_items (owner_user_id, workspace_id, import_source, import_ref, memory_id, body_hash, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(LOCAL_AGENT_OWNER_ID, into, row.import_source, row.import_ref, copy.id, row.body_hash, copy.version);
  }
}

function tombstones(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM memory_extraction_tombstones').get() as { n: number }).n;
}

const repoFact = 'Release branch: Releases are cut from main\n\nTag after the build passes.\n\nWhy: Hotfixes went missing\n\nHow to apply: Cherry-pick into main first';

/** About 900-1200 characters: two of them fit in one memory, three do not. */
const paragraph = (word: string) => Array.from({ length: 150 }, () => word).join(' ');

function seedClaude(): void {
  write(path.join(memoryDir, 'MEMORY.md'), [
    '# Memory index',
    '',
    '- [Shared checkout](shared-checkout.md) — keep the main checkout on dev',
    '- [Live recipe](live-recipe.md) — how to run the live recipe',
    '- The user wants answers in Chinese.',
    '',
  ].join('\n'));
  write(path.join(memoryDir, 'shared-checkout.md'), [
    '---',
    'name: shared-checkout',
    'description: "The main checkout is shared by sessions"',
    'metadata:',
    '  type: project',
    '  modified: 2026-11-08T08:00:00.000Z',
    '---',
    '',
    'Keep it on dev; integrate in a separate worktree.',
    '',
  ].join('\n'));
  write(path.join(memoryDir, 'live-recipe.md'), [
    '---',
    'name: live-recipe',
    'description: Drive an isolated instance',
    'metadata:',
    '  type: reference',
    '---',
    '',
    paragraph('alpha'),
    '',
    paragraph('bravo'),
    '',
    paragraph('charlie'),
    '',
  ].join('\n'));
}

function seedCodex(): void {
  write(path.join(codexHome, 'memories', 'memory_summary.md'), [
    'v1',
    '## User preferences',
    '- Prefers pnpm over npm.',
    '## What\'s in Memory',
    '- Build notes for the app repository.',
    '',
  ].join('\n'));
  // Phase 1's temporary input is not a memory.
  write(path.join(codexHome, 'memories', 'raw_memories.md'), '# Raw Memories\n\n- draft\n');
}

function seedKiro(): void {
  fs.mkdirSync(path.dirname(kiroDb), { recursive: true });
  const db = new DatabaseSync(kiroDb);
  db.exec(`CREATE TABLE memories (
    id TEXT NOT NULL PRIMARY KEY, memory_type TEXT NOT NULL, scopes TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
    content TEXT NOT NULL, why TEXT, how_to_apply TEXT, session_id TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, cloud_state TEXT NOT NULL DEFAULT 'pending', content_version TEXT, rev_number INTEGER NOT NULL DEFAULT 1)`);
  const insert = db.prepare(`INSERT INTO memories (id, memory_type, scopes, title, summary, content, why, how_to_apply, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 's-1', '2026-11-01T10:00:00.000Z', ?)`);
  insert.run('k-pref', 'USER_PREFERENCE', '["Global"]', 'Brief answers', 'The user wants brief answers', 'The user wants brief answers', null, null, '2026-11-02T10:00:00.000Z');
  insert.run('k-repo', 'PROJECT_FACT', '["repo:github/acme/app"]', 'Release branch', 'Releases are cut from main', 'Tag after the build passes.',
    'Hotfixes went missing', 'Cherry-pick into main first', '2026-11-03T10:00:00.000Z');
  insert.run('k-other', 'PROJECT_FACT', '["repo:github/other/thing"]', 'Other repository', 'Not one of Michi\'s workspaces', 'x', null, null, '2026-11-03T10:00:00.000Z');
  insert.run('k-secret', 'PROJECT_FACT', '["Global"]', 'Deploy key', 'The deploy key', 'AKIAABCDEFGHIJKLMNOP is the key', null, null, '2026-11-03T10:00:00.000Z');
  db.close();
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-native-import-')));
  process.env.MICHI_DATA_DIR = path.join(root, 'data');
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  claudeDir = path.join(root, 'claude');
  codexHome = path.join(root, 'codex');
  kiroHome = path.join(root, 'kiro');
  // A repository with an origin remote, and a linked worktree of it.
  repo = path.join(root, 'work', 'app');
  write(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  write(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  worktree = path.join(root, 'work', 'app-wt');
  write(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  project = claudeProjectSlug(repo);
  memoryDir = path.join(claudeDir, 'projects', project, 'memory');
  kiroDb = path.join(kiroHome, 'identities', 'abc123', 'memories', 'memories.db');
  saveWorkspace({ id: 'ws-app', name: 'App', cwd: repo, created_at: 1, updated_at: 1 });
  saveWorkspace({ id: 'ws-elsewhere', name: 'Elsewhere', cwd: path.join(root, 'elsewhere'), created_at: 1, updated_at: 1 });
  seedClaude();
  seedCodex();
  seedKiro();
});

afterEach(() => {
  closeDb();
  delete process.env.MICHI_DATA_DIR;
  delete process.env.MICHI_CLOUD;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('importing the runtimes\' own memories', () => {
  test('makes Michi memories of them, marked with their source, without changing a file', () => {
    const before = snapshot();
    const summary = sync();
    assert.deepEqual(snapshot(), before, 'no file of Claude Code, Codex or Kiro changed');
    assert.equal(summary.failed, 0);

    // Claude Code: each topic file and MEMORY.md's own note, into the workspace whose folder is the project.
    const claude = imported('claude', 'ws-app');
    const shared = byRef(`${project}/shared-checkout.md`);
    assert.equal(shared.body, 'Shared checkout: The main checkout is shared by sessions\n\nKeep it on dev; integrate in a separate worktree.');
    assert.equal(shared.kind, 'fact');
    assert.equal(shared.origin, 'extracted');
    assert.equal(shared.status, 'active');
    assert.equal(shared.observedAt, Date.parse('2026-11-08T08:00:00.000Z'));
    const recipe = claude.filter((record) => record.importRef?.startsWith(`${project}/live-recipe.md`));
    assert.deepEqual(recipe.map((record) => record.importRef), [`${project}/live-recipe.md`, `${project}/live-recipe.md#2`]);
    for (const [index, part] of recipe.entries()) {
      assert.ok(part.body.length <= MEMORY_BODY_MAX_CHARS);
      assert.ok(part.body.startsWith(`Live recipe: Drive an isolated instance (${index + 1}/2)\n\n`), part.body.slice(0, 80));
    }
    assert.ok(recipe.map((part) => part.body).join(' ').includes('charlie'));
    const note = claude.filter((record) => record.importRef?.startsWith(`${project}/MEMORY.md#`));
    assert.deepEqual(note.map((record) => record.body), ['The user wants answers in Chinese.']);
    // A note's title is its topic, shared by every part of a split one; an untitled note has none.
    assert.equal(shared.topic, 'Shared checkout', 'the file\'s name, not its description');
    assert.deepEqual(recipe.map((part) => part.topic), ['Live recipe', 'Live recipe']);
    assert.equal(note[0].topic, null);
    // A workspace elsewhere has none.
    assert.equal(imported('claude', 'ws-elsewhere').length, 0);

    // Codex: one note per section of its summary, in the user scope; raw_memories.md is not read.
    assert.deepEqual(imported('codex', null).map((record) => record.body).sort(), [
      'User preferences\n\n- Prefers pnpm over npm.',
      'What\'s in Memory\n\n- Build notes for the app repository.',
    ]);

    // Kiro: Global memories are the user's, a repo one belongs to the workspace of that repository; a credential is never stored.
    assert.deepEqual(imported('kiro', null).map((record) => [record.kind, record.body]), [['preference', 'Brief answers: The user wants brief answers']]);
    assert.deepEqual(imported('kiro', 'ws-app').map((record) => record.body), [repoFact]);
    assert.equal(imported('kiro', 'ws-app')[0].importRef, 'abc123/memories.db#k-repo');
    assert.ok(!memories().some((record) => /AKIA|Other repository/u.test(record.body)));
    assert.equal(summary.created, memories().length);
  });

  test('reads again only the files that changed, and importing twice changes nothing', () => {
    const seen = new Map<string, string>();
    const first = sync(seen);
    const count = memories().length;
    assert.ok(first.filesRead >= 5);
    assert.deepEqual(sync(seen), { filesRead: 0, created: 0, updated: 0, removed: 0, duplicates: 0, collapsed: 0, failed: 0 });
    // Every file read again: the same memories, none changed.
    const again = sync();
    assert.equal(again.created + again.updated + again.removed + again.failed, 0);
    assert.equal(memories().length, count);
    assert.ok(memories().every((record) => record.version === 1));
    // One file changed: read again, with the topic files its index titles (Claude) and nothing else.
    write(path.join(codexHome, 'memories', 'memory_summary.md'), 'v1\n## User preferences\n- Prefers pnpm over npm and yarn.\n## What\'s in Memory\n- Build notes for the app repository.\n');
    const changed = sync(seen);
    assert.equal(changed.filesRead, 1);
    assert.equal(changed.updated, 1);
    assert.equal(changed.created, 0);
  });

  test('a memory imported before topics existed gets its title as topic once, and then nothing changes', () => {
    const seen = new Map<string, string>();
    sync(seen);
    getDb().prepare('UPDATE memories SET topic = NULL').run();
    const titled = memories().filter((record) => record.importRef && !record.importRef.includes('MEMORY.md#')).length;
    const backfill = sync();
    assert.ok(backfill.updated >= titled && titled > 0, JSON.stringify(backfill));
    assert.equal(sync().updated, 0, 'compared as stored: no update on every pass');
  });

  test('a changed note updates its memory in place and a removed one takes its memory along', () => {
    const seen = new Map<string, string>();
    sync(seen);
    const shared = byRef(`${project}/shared-checkout.md`);
    write(path.join(memoryDir, 'shared-checkout.md'), '---\ndescription: The main checkout is shared by sessions\n---\nKeep it on dev; use worktrees.\n');
    assert.equal(sync(seen).updated, 1);
    const updated = getMemory(me, shared.id);
    assert.equal(updated.body, 'Shared checkout: The main checkout is shared by sessions\n\nKeep it on dev; use worktrees.');
    assert.equal(updated.version, 2);
    fs.rmSync(path.join(memoryDir, 'shared-checkout.md'));
    assert.equal(sync(seen).removed, 1);
    assert.throws(() => getMemory(me, shared.id), /not found/i);
    // A directory that is gone (or unreadable) changes nothing.
    const left = memories().length;
    fs.rmSync(memoryDir, { recursive: true });
    assert.equal(sync(seen).removed, 0);
    assert.equal(memories().length, left);
  });

  test('what the user deleted stays deleted and what they changed stays theirs', () => {
    const seen = new Map<string, string>();
    sync(seen);
    const note = memories().find((record) => record.importSource === 'claude' && record.body === 'The user wants answers in Chinese.'
      && record.scope.kind === 'workspace' && record.scope.workspaceId === 'ws-app')!;
    deleteMemory(me, note.id);
    const recipe = byRef(`${project}/live-recipe.md`);
    updateMemory(me, recipe.id, { body: 'Live recipe: my own words' }, recipe.version);
    const pref = imported('kiro', null)[0];
    deleteMemory(me, pref.id);
    // Every source changes; nothing comes back and the user's edit stays.
    write(path.join(memoryDir, 'MEMORY.md'), `${fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')}\n## More\n`);
    write(path.join(memoryDir, 'live-recipe.md'), `---\ndescription: Drive an isolated instance\n---\n${paragraph('delta')}\n\n${paragraph('echo')}\n\n${paragraph('foxtrot')}\n`);
    const db = new DatabaseSync(kiroDb);
    db.prepare("UPDATE memories SET content = 'The user wants brief answers, always', updated_at = '2026-11-05T10:00:00.000Z' WHERE id = 'k-pref'").run();
    db.close();
    const summary = sync(seen);
    assert.equal(summary.failed, 0);
    assert.ok(!imported('claude', 'ws-app').some((record) => record.body === 'The user wants answers in Chinese.'));
    assert.equal(getMemory(me, recipe.id).body, 'Live recipe: my own words');
    assert.match(byRef(`${project}/live-recipe.md#2`).body, /foxtrot/u, 'the part the user did not touch still follows its source');
    assert.equal(imported('kiro', null).length, 0);
  });

  test('a body the owner already has is not stored twice', () => {
    createMemory(me, { scope: { kind: 'user' }, kind: 'preference', body: 'user preferences\n\n- prefers pnpm over npm', status: 'active', origin: 'explicit' });
    const summary = sync();
    assert.equal(summary.duplicates, 1);
    assert.deepEqual(imported('codex', null).map((record) => record.body), ['What\'s in Memory\n\n- Build notes for the app repository.']);
  });

  test('nothing comes back after the user deleted every memory, and nothing is imported while memory is off or in cloud mode', () => {
    sync();
    for (const record of memories()) deleteMemory(me, record.id);
    assert.deepEqual(sync(), { filesRead: 5, created: 0, updated: 0, removed: 0, duplicates: 0, collapsed: 0, failed: 0 });
    write(path.join(memoryDir, 'new-note.md'), '---\ndescription: A note written later\n---\nIt is new.\n');
    setMemorySettings(LOCAL_AGENT_OWNER_ID, { mode: 'off' });
    assert.equal(sync().filesRead, 0);
    setMemorySettings(LOCAL_AGENT_OWNER_ID, { mode: 'auto' });
    process.env.MICHI_CLOUD = '1';
    assert.equal(sync().filesRead, 0);
    delete process.env.MICHI_CLOUD;
    assert.equal(sync().created, 1, 'the new note');
  });

  test('a deleted account takes its import bookkeeping along', () => {
    sync();
    purgeOwnerMemories(LOCAL_AGENT_OWNER_ID);
    assert.equal(memories().length, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM memory_import_items').get() as { n: number }).n, 0);
  });

  test('a project two or more workspaces share is imported once, into the user scope', () => {
    // A linked worktree's project is its main repository's too: the repository's workspace and the worktree's share it.
    saveWorkspace({ id: 'ws-wt', name: 'App worktree', cwd: worktree, created_at: 1, updated_at: 1 });
    // The worktree's own project is that workspace's alone.
    write(path.join(claudeDir, 'projects', claudeProjectSlug(worktree), 'memory', 'MEMORY.md'), '- The worktree builds with --fast.\n');
    const summary = sync();
    assert.equal(summary.failed, 0);
    const shared = imported('claude', null);
    assert.equal(shared.length, 4, 'the shared checkout, the live recipe in two parts and the index\'s own note');
    assert.ok(shared.every((record) => record.importRef?.startsWith(`${project}/`)));
    assert.equal(imported('claude', 'ws-app').length, 0);
    assert.deepEqual(imported('claude', 'ws-wt').map((record) => record.body), ['The worktree builds with --fast.']);
    // Kiro: a repository both workspaces have the same way.
    assert.deepEqual(imported('kiro', null).map((record) => record.body).sort(), ['Brief answers: The user wants brief answers', repoFact]);
    assert.equal(imported('kiro', 'ws-app').length + imported('kiro', 'ws-wt').length, 0);
    // One memory and one row per item, and importing again changes nothing.
    assert.equal(summary.created, memories().length);
    assert.ok(Object.values({ ...rowScopes('claude'), ...rowScopes('kiro') }).every((scopes) => scopes.length === 1));
    assert.deepEqual(sync(), { filesRead: 6, created: 0, updated: 0, removed: 0, duplicates: 0, collapsed: 0, failed: 0 });
  });

  test('a project one workspace has stays in it, and the same memories move when another workspace opens the folder or closes it', () => {
    const seen = new Map<string, string>();
    sync(seen);
    const inWorkspace = () => [...imported('claude', 'ws-app'), ...imported('kiro', 'ws-app')].map((record) => record.id).sort();
    const everywhere = () => [...imported('claude', null), ...imported('kiro', null).filter((record) => record.body === repoFact)]
      .map((record) => record.id).sort();
    const ids = inWorkspace();
    assert.equal(ids.length, 5, 'the project\'s four and the repository\'s Kiro memory');
    assert.deepEqual(everywhere(), []);
    saveWorkspace({ id: 'ws-app2', name: 'App, again', cwd: repo, created_at: 1, updated_at: 2 });
    const opened = sync(seen);
    assert.deepEqual([opened.created, opened.updated, opened.removed, opened.collapsed, opened.failed], [0, 0, 0, 5, 0]);
    assert.deepEqual(inWorkspace(), []);
    assert.deepEqual(everywhere(), ids, 'moved, not imported again');
    // In Trash it has no folder: they go back to the one workspace that has it.
    saveWorkspace({ id: 'ws-app2', name: 'App, again', cwd: repo, created_at: 1, updated_at: 3, deleted_at: 3 });
    const closed = sync(seen);
    assert.deepEqual([closed.created, closed.updated, closed.removed, closed.collapsed, closed.failed], [0, 0, 0, 5, 0]);
    assert.deepEqual(inWorkspace(), ids);
    assert.deepEqual(everywhere(), []);
  });

  test('the copies an earlier version imported into each workspace with the folder collapse into one memory, without a tombstone', (t) => {
    t.after(installMemoryExtractionHooks());
    sync();
    // As the home folder was for four workspaces: each imported a copy of every note.
    for (const id of ['ws-app2', 'ws-app3']) {
      saveWorkspace({ id, name: id, cwd: repo, created_at: 1, updated_at: 2 });
      copiesAsBefore('ws-app', id);
    }
    const bodies = imported('claude', 'ws-app').map((record) => record.body).sort();
    assert.deepEqual(imported('claude', 'ws-app3').map((record) => record.body).sort(), bodies);
    const summary = sync();
    assert.deepEqual([summary.created, summary.updated, summary.removed, summary.failed], [0, 0, 0, 0]);
    assert.equal(summary.collapsed, 3 * 5, 'for each of the five items, one copy moved and two removed');
    assert.deepEqual(imported('claude', null).map((record) => record.body).sort(), bodies);
    assert.deepEqual(imported('kiro', null).map((record) => record.body).sort(), ['Brief answers: The user wants brief answers', repoFact]);
    assert.ok(memories().every((record) => record.scope.kind === 'user'));
    assert.ok(Object.values({ ...rowScopes('claude'), ...rowScopes('kiro') }).every((scopes) => scopes.length === 1 && scopes[0] === ''));
    assert.equal(tombstones(), 0, 'the user removed nothing');
    // From then on it is one memory like any other.
    assert.equal(sync().collapsed, 0);
    write(path.join(memoryDir, 'shared-checkout.md'), '---\ndescription: The main checkout is shared by sessions\n---\nKeep it on dev; use worktrees.\n');
    assert.equal(sync().updated, 1);
    assert.equal(memories().filter((record) => record.importRef === `${project}/shared-checkout.md`).length, 1);
  });

  test('a note the user deleted stays deleted when its copies collapse, and one they changed stays theirs', () => {
    sync();
    saveWorkspace({ id: 'ws-app2', name: 'App, again', cwd: repo, created_at: 1, updated_at: 2 });
    copiesAsBefore('ws-app', 'ws-app2');
    const chinese = 'The user wants answers in Chinese.';
    // The user forgot one note in one workspace, and put another in their own words in the other.
    const forgotten = memories().find((record) => record.body === chinese && record.scope.kind === 'workspace' && record.scope.workspaceId === 'ws-app2')!;
    forgetMemory(me, forgotten.id);
    const changed = byRef(`${project}/shared-checkout.md`);
    updateMemory(me, changed.id, { body: 'Shared checkout: my own words' }, changed.version);
    assert.equal(sync().failed, 0);
    assert.ok(!memories().some((record) => record.body === chinese), 'its other copy went too');
    assert.equal(getMemory(me, changed.id).body, 'Shared checkout: my own words');
    assert.deepEqual(getMemory(me, changed.id).scope, { kind: 'workspace', workspaceId: 'ws-app' });
    assert.deepEqual(memories().filter((record) => record.importRef === `${project}/shared-checkout.md`).map((record) => record.id), [changed.id]);
    assert.deepEqual(imported('claude', null).map((record) => record.importRef), [`${project}/live-recipe.md`, `${project}/live-recipe.md#2`]);
    // Each keeps one row, in the user scope; the forgotten note's still names the memory the user deleted.
    assert.ok(Object.values(rowScopes('claude')).every((scopes) => scopes.length === 1 && scopes[0] === ''));
    const note = getDb().prepare("SELECT memory_id FROM memory_import_items WHERE import_source = 'claude' AND import_ref LIKE ?")
      .get(`${project}/MEMORY.md#%`) as { memory_id: string | null };
    assert.equal(note.memory_id, forgotten.id);
    // Neither comes back when their files change.
    write(path.join(memoryDir, 'MEMORY.md'), `${fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')}\n## More\n`);
    write(path.join(memoryDir, 'shared-checkout.md'), '---\ndescription: The main checkout is shared by sessions\n---\nKeep it on dev; use worktrees.\n');
    const later = sync();
    assert.deepEqual([later.created, later.updated, later.failed], [0, 0, 0]);
    assert.ok(!memories().some((record) => record.body === chinese));
    assert.deepEqual(memories().filter((record) => record.importRef === `${project}/shared-checkout.md`).map((record) => record.id), [changed.id]);
  });

  test('the words of a note the user deleted in one workspace are not imported for every workspace from another source', () => {
    sync();
    saveWorkspace({ id: 'ws-app2', name: 'App, again', cwd: repo, created_at: 1, updated_at: 2 });
    copiesAsBefore('ws-app', 'ws-app2');
    const chinese = 'The user wants answers in Chinese.';
    const forgotten = memories().find((record) => record.body === chinese && record.scope.kind === 'workspace' && record.scope.workspaceId === 'ws-app2')!;
    forgetMemory(me, forgotten.id);
    // Claude Code dropped the note from its index, and Kiro holds the same words as a Global memory.
    write(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n- [Shared checkout](shared-checkout.md) — keep the main checkout on dev\n- [Live recipe](live-recipe.md) — how to run the live recipe\n');
    const db = new DatabaseSync(kiroDb);
    db.prepare(`INSERT INTO memories (id, memory_type, scopes, title, summary, content, session_id, created_at, updated_at)
      VALUES ('k-chinese', 'USER_PREFERENCE', '["Global"]', ?, ?, ?, 's-2', '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z')`).run(chinese, chinese, chinese);
    db.close();
    assert.equal(sync().failed, 0);
    assert.ok(!memories().some((record) => record.body === chinese), 'a memory in the user scope would show where the user deleted it');
  });
});
