import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { log } from '../src/services/logger';
import { PageWriteError } from '../src/services/pages/core';
import { pageBody, pageErrors, pageId, route } from '../src/routes/pageRouteKit';
import { setupPagesRoutes } from '../src/routes/pages';
import { setupPageComponentRoutes } from '../src/routes/pageComponents';
import { setupPageHelperRoutes } from '../src/routes/pageHelpers';
import { setupSpacesHomeRoutes } from '../src/routes/spacesHome';

let server: Server | undefined;

async function listen(app: express.Express): Promise<string> {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function call(url: string, init?: RequestInit): Promise<[number, unknown]> {
  const response = await fetch(url, { ...init, headers: init?.body ? { 'content-type': 'application/json' } : {} });
  return [response.status, await response.json()];
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('pageRouteKit', () => {
  test('answers a sync throw, an async rejection and a classified error through the error middleware', async (t) => {
    t.mock.method(log, 'error', () => {});
    class Forbidden extends Error {}
    const app = express();
    app.use(express.json());
    app.get('/sync', route(() => { throw new Error('boom'); }));
    app.get('/async', route(async () => { await Promise.resolve(); throw new Error('boom'); }));
    app.get('/page', route(() => { throw new PageWriteError(409, 'stale_revision', 'Page changed'); }));
    app.get('/forbidden', route(() => { throw new Forbidden('No navigation'); }));
    app.post('/body', route((req, res) => { res.json(pageBody(req, ['title'])); }));
    app.post('/empty', route((req, res) => { res.json(pageBody(req, [])); }));
    app.get('/id/:value', route((req, res) => { res.json({ id: pageId(req.params.value, 'pageId') }); }));
    app.use(pageErrors('Unable to complete test request',
      (error) => error instanceof Forbidden ? { status: 403, code: 'navigation_disabled', message: error.message } : null));
    const base = await listen(app);
    const internal = [500, { error: { code: 'internal_error', message: 'Unable to complete test request' } }];

    assert.deepEqual(await call(`${base}/sync`), internal);
    assert.deepEqual(await call(`${base}/async`), internal);
    assert.deepEqual(await call(`${base}/page`), [409, { error: { code: 'stale_revision', message: 'Page changed' } }]);
    assert.deepEqual(await call(`${base}/forbidden`), [403, { error: { code: 'navigation_disabled', message: 'No navigation' } }]);
    assert.deepEqual(await call(`${base}/body`, { method: 'POST', body: '{"title":"A"}' }), [200, { title: 'A' }]);
    assert.deepEqual(await call(`${base}/body`, { method: 'POST', body: '{"other":1}' }),
      [400, { error: { code: 'invalid', message: 'Invalid request body' } }]);
    assert.deepEqual(await call(`${base}/empty`, { method: 'POST' }), [200, {}]);
    assert.deepEqual(await call(`${base}/id/%20`), [400, { error: { code: 'invalid', message: 'Invalid pageId' } }]);
    assert.deepEqual(await call(`${base}/id/${'x'.repeat(201)}`), [400, { error: { code: 'invalid', message: 'Invalid pageId' } }]);
  });

  test('logs the cause of a 500, and nothing for an error it answers', async (t) => {
    const logged = t.mock.method(log, 'error', () => {});
    const app = express();
    app.get('/sql', route(() => { throw Object.assign(new Error('no such table: pages'), { code: 'ERR_SQLITE_ERROR' }); }));
    app.get('/stale', route(() => { throw new PageWriteError(409, 'stale_revision', 'Page changed'); }));
    app.use(pageErrors('Unable to complete Pages request'));
    const base = await listen(app);

    assert.deepEqual(await call(`${base}/sql`), [500, { error: { code: 'internal_error', message: 'Unable to complete Pages request' } }]);
    assert.equal((await call(`${base}/stale`))[0], 409);
    assert.equal(logged.mock.callCount(), 1);
    const [stage, message, meta] = logged.mock.calls[0]!.arguments;
    assert.equal(stage, 'http');
    assert.equal(message, 'Unable to complete Pages request');
    assert.match(String(meta?.error), /no such table: pages/);
    assert.equal(meta?.route, 'GET /sql');
  });
});

describe('Pages-family routers', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.MICHI_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-route-kit-'));
    process.env.MICHI_DATA_DIR = dataDir;
    closeDb();
    initDb();
    getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
      .run('ws-a', 'Workspace A', LOCAL_AGENT_OWNER_ID);
  });

  afterEach(() => {
    closeDb();
    if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('refuse an unknown key, an unknown query parameter and a bad id the same way', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', setupPagesRoutes());
    app.use('/api', setupPageHelperRoutes());
    app.use('/api', setupPageComponentRoutes());
    app.use('/api', setupSpacesHomeRoutes());
    const base = `${await listen(app)}/api`;
    const invalid = (message: string) => [400, { error: { code: 'invalid', message } }];
    const long = 'x'.repeat(201);

    assert.deepEqual(await call(`${base}/spaces?x=1`), invalid('Unknown query parameter'));
    assert.deepEqual(await call(`${base}/spaces-home?x=1`), invalid('Unknown query parameter'));
    assert.deepEqual(await call(`${base}/workspaces/ws-a/pages`, { method: 'POST', body: '{"bogus":1}' }), invalid('Invalid request body'));
    assert.deepEqual(await call(`${base}/workspaces/ws-a/components`, { method: 'POST', body: '{"bogus":1}' }), invalid('Invalid request body'));
    assert.deepEqual(await call(`${base}/pages/${long}`), invalid('Invalid pageId'));
    assert.deepEqual(await call(`${base}/pages/%20`), invalid('Invalid pageId'));
    assert.deepEqual(await call(`${base}/pages/${long}/helper`, { method: 'POST' }), invalid('Invalid pageId'));
    assert.deepEqual(await call(`${base}/pages/%20/helper`, { method: 'POST' }), invalid('Invalid pageId'));
  });
});
