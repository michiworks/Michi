import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMemory } from '../src/services/memory/memoryService';
import { buildProfilePrompt, commitProfilePayload, installUserProfileHooks, profileRebuildState } from '../src/services/memory/userProfile';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { indexTurn } from '../src/services/memory/recallIndex';
import { setupMemoryRoutes } from '../src/routes/memories';

let dataDir: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;

async function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  // Stands in for the session gate: the authenticated user, when there is one.
  app.use((req, _res, next) => {
    const owner = req.header('x-user');
    if (owner) req.user = { id: owner, email: `${owner}@example.com` };
    next();
  });
  app.use('/api', setupMemoryRoutes());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function call(method: string, route: string, owner: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-user': owner } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function seedWorkspace(id: string, ownerUserId: string): void {
  getDb().prepare("INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Project', ?, 1, 1)")
    .run(id, ownerUserId);
}

function storedCount(): number {
  return (getDb().prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n;
}

function pending(ownerUserId: string, body: string): MemoryRecord {
  return createMemory({ ownerUserId }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'pending', origin: 'extracted' });
}

describe('memory routes (cloud)', () => {
  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-routes-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    closeDb();
    initDb();
    seedWorkspace('ws-alice', 'alice');
    seedWorkspace('ws-bob', 'bob');
    await start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('every route needs an authenticated owner', async () => {
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/memories'],
      ['POST', '/memories', { scope: { kind: 'user' }, kind: 'fact', body: 'x' }],
      ['PATCH', '/memories/mem-1', { body: 'x', expectedVersion: 1 }],
      ['DELETE', '/memories/mem-1'],
      ['POST', '/memories/mem-1/approve'],
      ['POST', '/memories/mem-1/reject'],
      ['GET', '/memory-settings'],
      ['PUT', '/memory-settings', { mode: 'off' }],
      ['POST', '/memories/reset', { confirm: true }],
      ['GET', '/memory-profile'],
      ['POST', '/memory-profile/rebuild', {}],
      ['POST', '/memory-profile/remove-line', { index: 0 }],
      ['GET', '/nodes/n-1/memory-mode'],
      ['PUT', '/nodes/n-1/memory-mode', { mode: 'off' }],
    ];
    for (const [method, route, body] of requests) {
      const response = await call(method, route, null, body);
      assert.equal(response.status, 401, `${method} ${route}`);
    }
    assert.equal(storedCount(), 0);
  });

  test('creates explicit active memories and lists them by scope', async () => {
    const created = await call('POST', '/memories', 'alice', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'convention', body: ' use 2 spaces ' });
    assert.equal(created.status, 201);
    assert.equal(created.json.memory.body, 'use 2 spaces');
    assert.equal(created.json.memory.origin, 'explicit');
    assert.equal(created.json.memory.status, 'active');
    assert.equal(created.json.memory.ownerUserId, 'alice');
    await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'preference', body: '回答用中文' });

    const all = await call('GET', '/memories', 'alice');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((item: MemoryRecord) => item.body), ['回答用中文', 'use 2 spaces']);
    assert.equal(all.json.nextCursor, null);
    const workspace = await call('GET', '/memories?scope=workspace&workspaceId=ws-alice', 'alice');
    assert.deepEqual(workspace.json.items.map((item: MemoryRecord) => item.body), ['use 2 spaces']);
    const user = await call('GET', '/memories?scope=user', 'alice');
    assert.deepEqual(user.json.items.map((item: MemoryRecord) => item.body), ['回答用中文']);
    const searched = await call('GET', `/memories?q=${encodeURIComponent('中文')}`, 'alice');
    assert.deepEqual(searched.json.items.map((item: MemoryRecord) => item.body), ['回答用中文']);
    const paged = await call('GET', '/memories?limit=1', 'alice');
    assert.equal(paged.json.items.length, 1);
    const next = await call('GET', `/memories?limit=1&cursor=${encodeURIComponent(paged.json.nextCursor)}`, 'alice');
    assert.deepEqual(next.json.items.map((item: MemoryRecord) => item.body), ['use 2 spaces']);

    assert.deepEqual((await call('GET', '/memories', 'bob')).json.items, []);
  });

  test('rejects fields that would choose origin, status, owner or source, and malformed queries', async () => {
    for (const extra of [{ origin: 'extracted' }, { status: 'pending' }, { ownerUserId: 'bob' }, { source: { nodeId: 'n' } }]) {
      const response = await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'x', ...extra });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.equal(response.json.code, 'invalid_argument');
    }
    assert.equal((await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'rumor', body: 'x' })).status, 400);
    assert.equal((await call('GET', '/memories?scope=global', 'alice')).status, 400);
    assert.equal((await call('GET', '/memories?limit=-1', 'alice')).status, 400);
    assert.equal((await call('GET', '/memories?status=deleted', 'alice')).status, 400);
    assert.equal((await call('GET', '/memories?cursor=bogus', 'alice')).status, 400);
    assert.equal(storedCount(), 0);
  });

  test("another owner's memory or workspace answers 404, like a missing one", async () => {
    const own = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'alice fact' })).json.memory as MemoryRecord;
    const waiting = pending('alice', 'alice pending');
    const attempts: Array<[string, string, unknown?]> = [
      ['PATCH', `/memories/${own.id}`, { body: 'stolen', expectedVersion: 1 }],
      ['DELETE', `/memories/${own.id}`],
      ['POST', `/memories/${waiting.id}/approve`],
      ['POST', `/memories/${waiting.id}/reject`],
      ['GET', '/memories?workspaceId=ws-alice'],
      ['POST', '/memories', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'fact', body: 'x' }],
    ];
    for (const [method, route, body] of attempts) {
      const response = await call(method, route, 'bob', body);
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(response.json.code, 'not_found');
    }
    assert.equal((await call('PATCH', '/memories/mem-missing', 'alice', { body: 'x', expectedVersion: 1 })).status, 404);
    assert.equal((await call('DELETE', '/memories/mem-missing', 'alice')).status, 404);
    const stored = (await call('GET', '/memories', 'alice')).json.items.map((item: MemoryRecord) => item.body);
    assert.deepEqual(stored, ['alice pending', 'alice fact']);
  });

  test('a stale expectedVersion answers 409 version_conflict with the current version', async () => {
    const created = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'v1' })).json.memory as MemoryRecord;
    const edited = await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v2', expectedVersion: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.memory.version, 2);
    const stale = await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v3', expectedVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'version_conflict');
    assert.equal(stale.json.currentVersion, 2);
    assert.equal((await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v3' })).status, 400);
    const moved = await call('PATCH', `/memories/${created.id}`, 'alice', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, expectedVersion: 2 });
    assert.deepEqual(moved.json.memory.scope, { kind: 'workspace', workspaceId: 'ws-alice' });
  });

  test('an edit in Settings marks the memory the user\'s own for consolidation, and nothing of it reaches the wire', async () => {
    const created = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'v1' })).json.memory as MemoryRecord;
    const editedAt = () => (getDb().prepare('SELECT user_edited_at FROM memories WHERE id = ?').get(created.id) as { user_edited_at: number | null }).user_edited_at;
    assert.equal(editedAt(), null);
    const edited = await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v2', expectedVersion: 1 });
    assert.equal(edited.status, 200);
    assert.equal(typeof editedAt(), 'number');
    assert.equal('userEditedAt' in edited.json.memory || 'user_edited_at' in edited.json.memory, false);
    assert.equal(edited.json.memory.origin, 'explicit', 'its origin is unchanged');
  });

  test('approve, reject and delete', async () => {
    const approveMe = pending('alice', 'approve me');
    const rejectMe = pending('alice', 'reject me');
    const approved = await call('POST', `/memories/${approveMe.id}/approve`, 'alice');
    assert.equal(approved.status, 200);
    assert.equal(approved.json.memory.status, 'active');
    assert.equal((await call('POST', `/memories/${approveMe.id}/approve`, 'alice')).json.code, 'invalid_state');
    assert.equal((await call('POST', `/memories/${rejectMe.id}/reject`, 'alice')).status, 204);
    assert.equal((await call('POST', `/memories/${approveMe.id}/reject`, 'alice')).status, 409);
    assert.equal((await call('DELETE', `/memories/${approveMe.id}`, 'alice')).status, 204);
    assert.deepEqual((await call('GET', '/memories?status=active,pending,superseded', 'alice')).json.items, []);
    assert.equal((await call('DELETE', `/memories/${approveMe.id}`, 'alice')).status, 404);
  });

  test('a delete in Settings forgets as memory_delete does: every version goes with a tombstone; the conversation stays as it is', async () => {
    const uninstall = installMemoryExtractionHooks();
    try {
      getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-1', 'ws-alice', 'chat', 'idle', 1)").run();
      indexTurn({ ownerUserId: 'alice', nodeId: 'n-1', turnId: 't-1', humanOrigin: true, userText: 'We use table-driven tests here.', assistantText: 'Noted.', completedAt: 1 });
      indexTurn({ ownerUserId: 'alice', nodeId: 'n-1', turnId: 't-2', humanOrigin: true, userText: 'Thanks for the help.', assistantText: 'Any time.', completedAt: 2 });
      const memory = createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'convention',
        body: 'Tests are table-driven.', status: 'active', origin: 'extracted', source: { nodeId: 'n-1', turnId: 't-1' } });
      assert.equal((await call('DELETE', `/memories/${memory.id}`, 'alice')).status, 204);
      const hidden = (turnId: string) => (getDb().prepare("SELECT hidden FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = ?").get(turnId) as { hidden: number }).hidden;
      assert.deepEqual([hidden('t-1'), hidden('t-2')], [0, 0], 'chat history, as in ChatGPT and Claude');
      const tombstones = getDb().prepare("SELECT COUNT(*) AS n FROM memory_extraction_tombstones WHERE owner_user_id = 'alice' AND source_turn_id = 't-1'").get() as { n: number };
      assert.ok(tombstones.n > 0, 'extraction never saves it again from that turn');
      assert.deepEqual((await call('GET', '/memories?status=active,pending,superseded', 'alice')).json.items, []);
    } finally {
      uninstall();
    }
  });

  test('memory settings default to on (auto); off refuses new memories but keeps management', async () => {
    const on = { mode: 'auto', migratedFromExplicit: false, noticeSeen: false };
    assert.deepEqual((await call('GET', '/memory-settings', 'alice')).json, on);
    const kept = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'kept' })).json.memory as MemoryRecord;
    assert.deepEqual(kept.keywords, []);
    assert.equal(kept.eventAt, null);
    assert.equal(kept.observedAt, kept.createdAt);
    const off = await call('PUT', '/memory-settings', 'alice', { mode: 'off' });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json, { ...on, mode: 'off' });
    assert.deepEqual((await call('GET', '/memory-settings', 'bob')).json, on);

    const refused = await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'new' });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'memory_disabled');
    assert.equal((await call('GET', '/memories?q=kept', 'alice')).json.items.length, 1);
    assert.equal((await call('DELETE', `/memories/${kept.id}`, 'alice')).status, 204);

    assert.equal((await call('PUT', '/memory-settings', 'alice', { mode: 'sometimes' })).status, 400);
    assert.equal((await call('PUT', '/memory-settings', 'alice', { mode: 'auto', ownerUserId: 'bob' })).status, 400);
    assert.deepEqual((await call('GET', '/memory-settings', 'alice')).json, { ...on, mode: 'off' });

    // An older client's "Explicit only" turns memory on, and the answer says so.
    const explicit = await call('PUT', '/memory-settings', 'alice', { mode: 'explicit' });
    assert.equal(explicit.status, 200);
    assert.deepEqual(explicit.json, on);
    assert.deepEqual((await call('GET', '/memory-settings', 'alice')).json, on);

    // The one-time notice: seen once, for this owner only.
    assert.deepEqual((await call('PUT', '/memory-settings', 'alice', { noticeSeen: true })).json, { ...on, noticeSeen: true });
    assert.equal((await call('GET', '/memory-settings', 'bob')).json.noticeSeen, false);
    assert.equal((await call('PUT', '/memory-settings', 'alice', { noticeSeen: false })).status, 400);
    assert.equal((await call('PUT', '/memory-settings', 'alice', {})).status, 400);
  });

  test('the profile: its lines with the memories they cite, rebuild on request, and Remove deleting what a line cites', async () => {
    const uninstall = installUserProfileHooks();
    try {
      const empty = await call('GET', '/memory-profile', 'alice');
      assert.deepEqual(empty.json, { lines: [], builtAt: null, version: 0, rebuildRequested: false });
      const notes = ['The user has only an air fryer.', 'The user is a night owl.', 'The user is an INFJ.'].map((body) =>
        createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted' }));
      const prompt = buildProfilePrompt({ ownerUserId: 'alice' })!;
      const ref = (id: string) => prompt.sources.find((source) => source.memoryId === id)!.ref;
      commitProfilePayload({ sections: [
        { topic: 'Home', lines: [{ text: 'Only an air fryer', refs: [ref(notes[0]!.id)] }] },
        { topic: 'Habits', lines: [{ text: 'Night owl; INFJ', refs: [ref(notes[1]!.id), ref(notes[2]!.id)] }] },
      ] }, { ownerUserId: 'alice', sources: prompt.sources, sourceVersion: prompt.sourceVersion, language: 'en' });
      const view = (await call('GET', '/memory-profile', 'alice')).json;
      assert.equal(view.version, 1);
      assert.equal(typeof view.builtAt, 'number');
      assert.deepEqual(view.lines.map((line: { text: string; refs: Array<{ id: string; body: string; ref: string }> }) => [line.text, line.refs.map((cited) => cited.body)]), [
        ['Only an air fryer', ['The user has only an air fryer.']],
        ['Night owl; INFJ', ['The user is a night owl.', 'The user is an INFJ.']],
      ]);
      assert.match(view.lines[0].refs[0].ref, /^m:[0-9a-z]+v1$/);
      assert.deepEqual((await call('GET', '/memory-profile', 'bob')).json.lines, [], 'another owner sees their own, empty, profile');

      const rebuild = await call('POST', '/memory-profile/rebuild', 'alice', {});
      assert.equal(rebuild.status, 202);
      assert.equal(rebuild.json.rebuildRequested, true);
      assert.notEqual(profileRebuildState('alice').requestedAt, null);

      assert.equal((await call('POST', '/memory-profile/remove-line', 'alice', { index: 1, version: 7 })).json.code, 'version_conflict');
      assert.equal((await call('POST', '/memory-profile/remove-line', 'alice', { index: 5 })).status, 404);
      assert.equal((await call('POST', '/memory-profile/remove-line', 'alice', { index: -1 })).status, 400);
      assert.equal((await call('POST', '/memory-profile/remove-line', 'bob', { index: 0 })).status, 404, 'bob has no such line');
      const removed = await call('POST', '/memory-profile/remove-line', 'alice', { index: 1, version: 1 });
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.json.lines.map((line: { text: string }) => line.text), ['Only an air fryer']);
      assert.deepEqual((await call('GET', '/memories', 'alice')).json.items.map((item: MemoryRecord) => item.body), ['The user has only an air fryer.'],
        'the memories the line cited are gone');
    } finally {
      uninstall();
    }
  });

  test('a conversation\'s memory mode: owned conversations only; leaving learn hides its turns and removes what Michi saved from it on its own', async () => {
    const uninstall = installMemoryExtractionHooks();
    try {
      getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-1', 'ws-alice', 'chat', 'idle', 1)").run();
      getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-bob', 'ws-bob', 'chat', 'idle', 1)").run();
      indexTurn({ ownerUserId: 'alice', nodeId: 'n-1', turnId: 't-1', humanOrigin: true, userText: 'I moved to Nakano.', assistantText: 'Nice.', completedAt: 1 });
      const unasked = createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'fact', body: 'The user moved to Nakano.',
        status: 'active', origin: 'extracted', source: { nodeId: 'n-1', turnId: 't-1' } });
      createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'preference', body: 'Reply in English.',
        status: 'active', origin: 'explicit', source: { nodeId: 'n-1', turnId: 't-1' } });
      assert.deepEqual((await call('GET', '/nodes/n-1/memory-mode', 'alice')).json, { mode: 'learn' });
      assert.equal((await call('GET', '/nodes/n-1/memory-mode', 'bob')).status, 404);
      assert.equal((await call('PUT', '/nodes/n-bob/memory-mode', 'alice', { mode: 'off' })).status, 404);
      assert.equal((await call('GET', '/nodes/n-missing/memory-mode', 'alice')).status, 404);
      assert.equal((await call('PUT', '/nodes/n-1/memory-mode', 'alice', { mode: 'sometimes' })).status, 400);
      const changed = await call('PUT', '/nodes/n-1/memory-mode', 'alice', { mode: 'use_only' });
      assert.deepEqual(changed.json, { mode: 'use_only', hiddenTurns: 1, removedMemories: 1 });
      assert.deepEqual((await call('GET', '/memories', 'alice')).json.items.map((item: MemoryRecord) => item.body), ['Reply in English.'],
        'the user\'s own saved note stays');
      assert.ok(!(await call('GET', '/memories', 'alice')).json.items.some((item: MemoryRecord) => item.id === unasked.id));
      assert.equal((getDb().prepare("SELECT hidden FROM memory_recall_docs WHERE ref_id = 't-1'").get() as { hidden: number }).hidden, 1);
      assert.deepEqual((await call('GET', '/nodes/n-1/memory-mode', 'alice')).json, { mode: 'use_only' });
      assert.deepEqual((await call('PUT', '/nodes/n-1/memory-mode', 'alice', { mode: 'use_only' })).json, { mode: 'use_only', hiddenTurns: 0, removedMemories: 0 });
      assert.deepEqual((await call('PUT', '/nodes/n-1/memory-mode', 'alice', { mode: 'learn' })).json, { mode: 'learn', hiddenTurns: 0, removedMemories: 0 });
      assert.equal(indexTurn({ ownerUserId: 'alice', nodeId: 'n-1', turnId: 't-2', humanOrigin: true, userText: 'Learning again.', completedAt: 2 }), true);
    } finally {
      uninstall();
    }
  });

  test('reset deletes every memory of the owner, their profile and recall text, after an explicit confirm', async () => {
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-1', 'ws-alice', 'chat', 'idle', 1)").run();
    indexTurn({ ownerUserId: 'alice', nodeId: 'n-1', turnId: 't-1', humanOrigin: true, userText: 'I moved to Nakano.', assistantText: 'Nice.', completedAt: 1 });
    await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'alice fact' });
    await call('POST', '/memories', 'alice', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'convention', body: 'use pnpm' });
    await call('POST', '/memories', 'bob', { scope: { kind: 'user' }, kind: 'fact', body: 'bob fact' });
    assert.equal((await call('POST', '/memories/reset', 'alice', {})).status, 400, 'confirm is required');
    assert.equal((await call('POST', '/memories/reset', 'alice', { confirm: 'yes' })).status, 400);
    const reset = await call('POST', '/memories/reset', 'alice', { confirm: true });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.json, { removed: 2, hiddenTurns: 1 });
    assert.deepEqual((await call('GET', '/memories?status=active,pending,superseded', 'alice')).json.items, []);
    assert.deepEqual((await call('GET', '/memories', 'bob')).json.items.map((item: MemoryRecord) => item.body), ['bob fact'], 'another owner keeps theirs');
    const doc = getDb().prepare("SELECT hidden, snippet FROM memory_recall_docs WHERE ref_id = 't-1'").get() as { hidden: number; snippet: string };
    assert.deepEqual({ ...doc }, { hidden: 1, snippet: '' });
    assert.equal((await call('GET', '/memory-settings', 'alice')).json.mode, 'auto', 'the setting stays');
  });
});

describe('memory routes (desktop)', () => {
  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-routes-'));
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-local', 'Local', 1, 1)").run();
    await start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('requests act as the local user, whatever user they carry', async () => {
    const created = await call('POST', '/memories', null, { scope: { kind: 'workspace', workspaceId: 'ws-local' }, kind: 'fact', body: 'local note' });
    assert.equal(created.status, 201);
    assert.equal(created.json.memory.ownerUserId, 'local-user');
    assert.deepEqual((await call('GET', '/memories', 'someone-else')).json.items.map((item: MemoryRecord) => item.body), ['local note']);
  });
});
