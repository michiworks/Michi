import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createPage, deletePage, purgePageDeletionGroup } from '../src/services/pages/repository';
import { purgeWorkspaceNodes } from '../src/services/repository/nodeTrash';
import { BlockSubmissionExistsError, listBlockSubmissions, recordBlockSubmission } from '../src/services/pages/blockSubmissions';
import { setupBlockSubmissionRoutes } from '../src/routes/blockSubmissions';

let dataDir: string;
let previousDataDir: string | undefined;
let previousCloud: string | undefined;
let server: Server | undefined;
let baseUrl = '';
let pageId = '';

const FORM = { id: 'blk-form', type: 'form', title: 'Trip', prompt: 'Plan it', fields: [{ key: 'city', label: 'City', type: 'text' }] };
const POLL = { id: 'blk-poll', type: 'poll', question: 'When?', options: ['Mon', 'Tue'] };

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR; previousCloud = process.env.MICHI_CLOUD;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-block-submissions-'));
  process.env.MICHI_DATA_DIR = dataDir;
  // Cloud mode: owners are compared exactly, so another user's requests own nothing here.
  process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1),(?,?,?,1,1)')
    .run('ws', 'Workspace', 'alice', 'ws-bob', 'Bob', 'bob');
  pageId = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Plans', now: 1 }).id;
  db.prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([FORM, POLL]), pageId);
  db.prepare(`INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES ('t1','ws','n1',1,1)`).run();
  db.prepare(`INSERT INTO nodes(id,workspace_id,tree_id,kind,status,title) VALUES ('n1','ws','t1','chat','idle','Chat')`).run();
  db.prepare(`INSERT INTO messages(id,node_id,role,content,seq) VALUES ('m-user','n1','user','hi',0),('m1','n1','assistant','Pick one',1)`).run();
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { (req as typeof req & { user: { id: string; email: string } }).user = { id: req.header('x-user-id') ?? 'alice', email: 'test@example.invalid' }; next(); });
  app.use('/api', setupBlockSubmissionRoutes());
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined; closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const pageHost = () => ({ kind: 'page' as const, pageId });
const chatHost = { kind: 'chat' as const, nodeId: 'n1', messageId: 'm1' };
const post = (body: unknown, user = 'alice', workspace = 'ws') => fetch(`${baseUrl}/workspaces/${workspace}/block-submissions`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': user }, body: JSON.stringify(body),
});
const list = (host: string, user = 'alice', workspace = 'ws') =>
  fetch(`${baseUrl}/workspaces/${workspace}/block-submissions?host=${encodeURIComponent(host)}`, { headers: { 'x-user-id': user } });
const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM block_submissions').get() as { n: number }).n;

test('a page submission is stored once: the first write wins and a second answers 409 with the stored one', async () => {
  const body = { host: pageHost(), blockId: 'blk-form', signature: 'form-abc-12', value: { city: 'Kyoto' }, text: 'Plan it\n\n{"city":"Kyoto"}' };
  const created = await post(body);
  assert.equal(created.status, 201);
  const { submission } = await created.json() as { submission: Record<string, unknown> };
  assert.deepEqual({ ...submission, submittedAt: 0 }, { blockId: 'blk-form', signature: 'form-abc-12', value: { city: 'Kyoto' }, text: body.text, submittedAt: 0 });

  const again = await post({ ...body, value: { city: 'Tokyo' }, text: 'other' });
  assert.equal(again.status, 409);
  const conflict = await again.json() as { code: string; submission: { value: unknown } };
  assert.equal(conflict.code, 'already_submitted');
  assert.deepEqual(conflict.submission.value, { city: 'Kyoto' });

  // A rewritten block (another signature) starts fresh.
  assert.equal((await post({ ...body, signature: 'form-def-14', value: { city: 'Nara' } })).status, 201);
  const read = await list(`page:${pageId}`);
  assert.equal(read.status, 200);
  const { submissions } = await read.json() as { submissions: Array<{ signature: string; value: unknown }> };
  assert.deepEqual(submissions.map((item) => [item.signature, item.value]), [['form-abc-12', { city: 'Kyoto' }], ['form-def-14', { city: 'Nara' }]]);
});

test('another owner can neither read nor write submissions in a workspace that is not theirs', async () => {
  recordBlockSubmission({ workspaceId: 'ws', ownerUserId: 'alice', host: pageHost(), blockId: 'blk-poll', signature: 'poll-x', value: [0], text: 'Mon', now: 5 });
  assert.equal((await list(`page:${pageId}`, 'bob')).status, 404);
  assert.equal((await list(`page:${pageId}`, 'bob', 'ws-bob')).status, 404);
  assert.equal((await post({ host: pageHost(), blockId: 'blk-poll', signature: 'poll-y', value: [1], text: 'Tue' }, 'bob')).status, 404);
  assert.equal((await post({ host: pageHost(), blockId: 'blk-poll', signature: 'poll-y', value: [1], text: 'Tue' }, 'bob', 'ws-bob')).status, 404);
  assert.equal((await list('chat:n1:m1', 'bob')).status, 404);
  assert.equal((await post({ host: chatHost, blockId: 'b1', signature: 'poll-y', value: [1], text: 'Tue' }, 'bob')).status, 404);
  assert.equal(count(), 1);
  // The page in another workspace of the same owner is not found through this one.
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws2','Other','alice',1,1)").run();
  assert.equal((await list(`page:${pageId}`, 'alice', 'ws2')).status, 404);
});

test('bad hosts, ids, unknown keys and oversized values are refused before anything is stored', async () => {
  const good = { host: pageHost(), blockId: 'blk-form', signature: 'form-a', value: { city: 'x' }, text: 'x' };
  for (const host of ['', 'page:', 'page:a:b', 'chat:n1', 'chat:n1:m1:x', 'node:n1', `page:${'p'.repeat(201)}`, 'page:a b']) {
    assert.equal((await list(host)).status, 400, host);
  }
  assert.equal((await fetch(`${baseUrl}/workspaces/ws/block-submissions?host=page:${pageId}&extra=1`)).status, 400);
  for (const body of [
    { ...good, host: { kind: 'page', pageId, extra: 1 } },
    { ...good, host: { kind: 'chat', nodeId: 'n1' } },
    { ...good, host: `page:${pageId}` },
    { ...good, blockId: '' },
    { ...good, blockId: 'x'.repeat(201) },
    { ...good, signature: 'has space' },
    { ...good, signature: 's'.repeat(101) },
    { ...good, text: 7 },
    { ...good, text: 'é'.repeat(4097) },
    { ...good, value: 'v'.repeat(16 * 1024) },
    { host: good.host, blockId: good.blockId, signature: good.signature, text: good.text },
    { ...good, extra: true },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
  // A block the page does not hold is not found; a child of one it holds is accepted.
  assert.equal((await post({ ...good, blockId: 'blk-missing' })).status, 404);
  assert.equal((await post({ ...good, blockId: 'blk-form.0' })).status, 201);
  assert.equal(count(), 1);
});

test('chat submissions belong to an assistant message of a live, unarchived chat', async () => {
  const body = { host: chatHost, blockId: 'b1', signature: 'choice-1', value: 1, text: 'I pick Tue' };
  assert.equal((await post(body)).status, 201);
  assert.equal((await post(body)).status, 409);
  const { submissions } = await (await list('chat:n1:m1')).json() as { submissions: unknown[] };
  assert.equal(submissions.length, 1);
  assert.equal((await post({ ...body, host: { ...chatHost, messageId: 'm-user' } })).status, 404);
  assert.equal((await post({ ...body, host: { ...chatHost, messageId: 'm-missing' } })).status, 404);
  getDb().prepare('UPDATE trees SET archived_at=2 WHERE id=?').run('t1');
  const archived = await post({ ...body, signature: 'choice-2' });
  assert.equal(archived.status, 409);
  assert.equal(((await archived.json()) as { error: { code: string } }).error.code, 'invalid');
  // Reading an archived conversation still shows what was sent.
  assert.equal((await list('chat:n1:m1')).status, 200);
});

test('archived workspaces and trashed pages are read-only; their submissions still read', async () => {
  recordBlockSubmission({ workspaceId: 'ws', ownerUserId: 'alice', host: pageHost(), blockId: 'blk-poll', signature: 'poll-a', value: [1], text: 'Tue', now: 5 });
  getDb().prepare('UPDATE workspaces SET archived_at=9 WHERE id=?').run('ws');
  assert.equal((await post({ host: pageHost(), blockId: 'blk-form', signature: 'form-a', value: {}, text: 'x' })).status, 409);
  assert.equal(listBlockSubmissions('ws', 'alice', pageHost()).length, 1);
  getDb().prepare('UPDATE workspaces SET archived_at=NULL WHERE id=?').run('ws');
  deletePage(pageId, 'alice', { now: 10 });
  assert.throws(() => recordBlockSubmission({ workspaceId: 'ws', ownerUserId: 'alice', host: pageHost(), blockId: 'blk-form', signature: 'form-a', value: {}, text: 'x' }),
    (error: Error & { status?: number }) => error.status === 404);
  assert.equal(listBlockSubmissions('ws', 'alice', pageHost()).length, 1);
});

test('purging a page or a chat removes its submissions', () => {
  recordBlockSubmission({ workspaceId: 'ws', ownerUserId: 'alice', host: pageHost(), blockId: 'blk-poll', signature: 'poll-a', value: [1], text: 'Tue' });
  recordBlockSubmission({ workspaceId: 'ws', ownerUserId: 'alice', host: chatHost, blockId: 'b1', signature: 'poll-a', value: [0], text: 'Mon' });
  assert.throws(() => recordBlockSubmission({ workspaceId: 'ws', ownerUserId: 'alice', host: chatHost, blockId: 'b1', signature: 'poll-a', value: [1], text: 'x' }),
    (error) => error instanceof BlockSubmissionExistsError && (error.submission.value as number[])[0] === 0);
  assert.equal(count(), 2);
  purgePageDeletionGroup(deletePage(pageId, 'alice'), 'alice');
  assert.equal(count(), 1);
  purgeWorkspaceNodes('ws', ['n1']);
  assert.equal(count(), 0);
});
