import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { accessLogLine, accessOriginFields, observeAccess, shouldLogAccess, type AccessLogLine } from '../src/services/accessLog';

test('Pages no-change polls are quiet while changed reads and writes remain logged', () => {
  for (const prefix of ['', '/api']) {
    for (const pathname of ['/spaces', '/pages/page-1', '/pages/page-1/changes', '/databases/db-1', '/workspaces/ws/pages']) {
      assert.equal(shouldLogAccess('GET', prefix + pathname, 204), false);
      assert.equal(shouldLogAccess('GET', prefix + pathname, 304), false);
      assert.equal(shouldLogAccess('GET', prefix + pathname, 200), true);
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        assert.equal(shouldLogAccess(method, prefix + pathname, 204), true);
      }
    }
  }
  assert.equal(shouldLogAccess('POST', '/api/pages/pg/edits', 200), true);
  assert.equal(shouldLogAccess('POST', '/workspaces/ws/open-url/claim', 200), true);
  assert.equal(shouldLogAccess('GET', '/unrelated', 304), true);
});

test('all polling and legacy silent paths retain errors', () => {
  const routes = ['/health', '/agent/status', '/ready', '/mcp/slot', '/nodes/node/ensure-session',
    '/workspaces/all', '/chats/chat/heartbeat', '/pages/page', '/spaces', '/backend-connections/recovery', '/companion/tray'];
  for (const pathname of routes) {
    for (const status of [400, 401, 404, 429, 500, 503]) {
      assert.equal(shouldLogAccess('GET', `/api${pathname}`, status), true, `${pathname}: ${status}`);
    }
  }
  assert.equal(shouldLogAccess('GET', '/backend-connections/recovery', 200), false);
  assert.equal(shouldLogAccess('GET', '/api/ready', 200), false);
});

test('access lines name the forwarding hop only from the allowlist and a window only by a short prefix', () => {
  assert.deepEqual(accessOriginFields({ 'x-michi-via': 'phone', 'x-michi-window-id': 'w-1234567890abcdef' }), { via: 'phone', window: 'w-123456' });
  assert.deepEqual(accessOriginFields({ 'x-michi-via': 'desktop-proxy' }), { via: 'desktop-proxy' });
  for (const via of ['Phone', 'phone ', 'evil\nline', 'x'.repeat(500), ['phone']]) {
    assert.deepEqual(accessOriginFields({ 'x-michi-via': via as string, 'x-michi-window-id': 'has space' }), {});
  }
});

test('a finished response keeps its fields first; one closed before finishing logs status=aborted', () => {
  const base = { method: 'GET', path: '/api/workspaces/ws/trees/t/messages', durMs: 37_000, requestId: 9, headersSent: true,
    headers: { 'x-michi-via': 'desktop-proxy' } };
  const finished = accessLogLine({ ...base, status: 200, aborted: false });
  assert.deepEqual(finished, { level: 'info', meta: { status: 200, durMs: 37_000, requestId: 9, via: 'desktop-proxy' } });
  assert.deepEqual(Object.keys(finished!.meta), ['status', 'durMs', 'requestId', 'via']);
  assert.deepEqual(accessLogLine({ ...base, status: 200, aborted: true, bytes: 65_536 }),
    { level: 'info', meta: { status: 'aborted', durMs: 37_000, requestId: 9, sentStatus: 200, bytes: 65_536, via: 'desktop-proxy' } });
  // Aborted before any header: no status was sent; quiet paths still log the abort.
  assert.deepEqual(accessLogLine({ ...base, path: '/api/health', status: 200, aborted: true, headersSent: false, bytes: 0, headers: {} }),
    { level: 'info', meta: { status: 'aborted', durMs: 37_000, requestId: 9, bytes: 0 } });
  assert.equal(accessLogLine({ ...base, path: '/api/health', status: 200, aborted: false }), null);
  assert.equal(accessLogLine({ ...base, method: 'POST', status: 400, aborted: false })?.level, 'warn');
  assert.equal(accessLogLine({ ...base, status: 502, aborted: false })?.level, 'error');
});

test('a response the client drops before it finishes still logs, with the bytes it got', async (t) => {
  const lines: Array<AccessLogLine & { path: string }> = [];
  const app = express();
  app.use((req, res, next) => { observeAccess(req, res, 7, (line) => lines.push({ ...line, path: req.path })); next(); });
  app.get('/api/workspaces/ws/trees/t/messages', (_req, res) => { res.write('x'.repeat(64 * 1024)); });
  app.get('/api/done', (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const done = await fetch(`${base}/api/done`, { headers: { 'x-michi-via': 'desktop-proxy' } });
  await done.text();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/workspaces/ws/trees/t/messages`, { signal: controller.signal });
  await response.body!.getReader().read();
  controller.abort();
  for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lines.length, 2);
  assert.deepEqual({ ...lines[0], meta: { ...lines[0].meta, durMs: 0 } },
    { level: 'info', path: '/api/done', meta: { status: 200, durMs: 0, requestId: 7, via: 'desktop-proxy' } });
  const aborted = lines[1];
  assert.equal(aborted.meta.status, 'aborted');
  assert.equal(aborted.meta.sentStatus, 200);
  assert.ok((aborted.meta.bytes as number) > 1024, `bytes ${aborted.meta.bytes}`);
});

test('the tray\'s minute refresh is quiet when it succeeds; the rest of the Companion is logged as before', () => {
  for (const prefix of ['', '/api']) {
    assert.equal(shouldLogAccess('GET', `${prefix}/companion/tray`, 200), false);
    assert.equal(shouldLogAccess('GET', `${prefix}/companion/tray`, 304), false);
  }
  assert.equal(shouldLogAccess('GET', '/api/companion/tray', 404), true, 'a backend without it is still a warning');
  assert.equal(shouldLogAccess('GET', '/api/companion/tray/extra', 200), true);
  assert.equal(shouldLogAccess('GET', '/api/companion', 200), true);
  assert.equal(shouldLogAccess('POST', '/api/companion/check', 202), true);
});
