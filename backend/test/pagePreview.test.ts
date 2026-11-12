import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, createPage, deletePage } from '../src/services/pages/repository';
import { configurePagePreview, createPagePreviewMiddleware, issuePagePreview, resetPagePreviewsForTests } from '../src/services/pages/pagePreview';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';
import { runPageTool } from '../src/agents/pageTools';

const ownerUserId = 'alice';
const workspaceId = 'ws';
const TOKEN = 'long-enough-remote-token';
let dir: string;
let server: Server | null = null;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD, remote: process.env.MICHI_REMOTE_ACCESS, token: process.env.MICHI_REMOTE_TOKEN };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-preview-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  process.env.MICHI_REMOTE_ACCESS = '1';
  process.env.MICHI_REMOTE_TOKEN = TOKEN;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run(workspaceId, 'Workspace', ownerUserId);
  resetPagePreviewsForTests();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  resetPagePreviewsForTests();
  closeDb();
  restore('MICHI_DATA_DIR', saved.data);
  restore('MICHI_CLOUD', saved.cloud);
  restore('MICHI_REMOTE_ACCESS', saved.remote);
  restore('MICHI_REMOTE_TOKEN', saved.token);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The server's order: preview middleware, then the token check, then routes that answer 200. */
async function start(): Promise<string> {
  const app = express();
  app.use('/api', createPagePreviewMiddleware());
  app.use('/api', createRemoteAccessMiddleware());
  app.all('/api/*splat', (req, res) => { res.json({ reached: req.path }); });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configurePagePreview({ apiBase: base, renderer: '' });
  return base;
}

async function openCookie(url: string): Promise<{ cookie: string; location: string }> {
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api/);
  return { cookie: setCookie.split(';')[0], location: response.headers.get('location') ?? '' };
}

test('a preview link opens one page read-only and nothing else', async () => {
  const base = await start();
  const page = createPage({ workspaceId, ownerUserId, title: 'Board' });
  const other = createPage({ workspaceId, ownerUserId, title: 'Other' });
  const shown = createDatabase({ workspaceId, ownerUserId, title: 'Shown' });
  const hidden = createDatabase({ workspaceId, ownerUserId, title: 'Hidden' });
  getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES(?,?)').run(page.id, shown.id);

  const { url } = issuePagePreview(ownerUserId, workspaceId, page.id);
  assert.equal(issuePagePreview(ownerUserId, workspaceId, page.id).url, url, 'the same page gets the same link');
  assert.ok(url.startsWith(`${base}/api/page-preview/`));

  const { cookie, location } = await openCookie(`${url}?palette=midnight`);
  assert.equal(location, `/?pagePreview=${page.id}&workspace=${workspaceId}&palette=midnight`);

  const get = (p: string, init: RequestInit = {}) => fetch(`${base}/api${p}`, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });
  assert.equal((await get(`/pages/${page.id}`)).status, 200);
  assert.equal((await get(`/pages/${page.id}/changes?direction=backward`)).status, 200);
  assert.equal((await get(`/databases/${shown.id}`)).status, 200);
  assert.equal((await get(`/pages/${other.id}`)).status, 401, 'another page');
  assert.equal((await get(`/databases/${hidden.id}`)).status, 401, 'a database the page does not show');
  assert.equal((await get(`/workspaces/${workspaceId}/pages`)).status, 401, 'the page list');
  assert.equal((await get(`/workspaces/${workspaceId}/task-database`)).status, 401, 'no task board on the page');
  assert.equal((await get(`/pages/${page.id}/edits`, { method: 'POST' })).status, 401, 'writes');
  assert.equal((await get(`/pages/${page.id}`, { headers: { authorization: 'Bearer wrong' } })).status, 401, 'a bearer token is checked as usual');

  deletePage(page.id, ownerUserId);
  assert.equal((await get(`/pages/${page.id}`)).status, 401, 'a deleted page revokes its link');
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 404);
});

test('unknown tickets and unconfigured previews are refused', async () => {
  const page = createPage({ workspaceId, ownerUserId, title: 'Board' });
  assert.throws(() => issuePagePreview(ownerUserId, workspaceId, page.id), /web UI/);
  const base = await start();
  assert.equal((await fetch(`${base}/api/page-preview/${'0'.repeat(64)}`, { redirect: 'manual' })).status, 404);
  const forged = `michi_pp_x=${'0'.repeat(64)}`;
  assert.equal((await fetch(`${base}/api/pages/${page.id}`, { headers: { cookie: forged } })).status, 401);
});

test('preview_page returns a link for a page in the caller workspace only', async () => {
  await start();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws2', 'Other', ownerUserId);
  const page = createPage({ workspaceId, ownerUserId, title: 'Board' });
  const foreign = createPage({ workspaceId: 'ws2', ownerUserId, title: 'Elsewhere' });
  const caller = { ownerUserId, workspaceId, nodeId: 'node', ownerKind: 'chat_node' as const };
  const result = runPageTool('preview_page', caller, { pageId: page.id });
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.structuredContent ?? result.details), /\/api\/page-preview\/[a-f0-9]{64}/);
  assert.equal(runPageTool('preview_page', caller, { pageId: foreign.id }).isError, true);
});
