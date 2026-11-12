import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { setupMobileAccessRoutes } from '../src/routes/mobileAccess';
import { setupTerminalRoutes } from '../src/routes/terminals';
import type { MobileAccessController } from '../src/services/mobileAccessManager';
import { TerminalHost, type PtyProcess, type SpawnPty } from '../src/services/terminalHost';

class FakePty implements PtyProcess {
  listener?: (data: string) => void;
  written: string[] = [];
  onData(listener: (data: string) => void) { this.listener = listener; }
  onExit() {}
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() {}
}

async function fixture(t: TestContext, options: { hosted?: boolean; spawn?: SpawnPty | null } = {}) {
  const ptys: FakePty[] = [];
  const host = new TerminalHost({
    spawn: options.spawn === undefined ? () => { const pty = new FakePty(); ptys.push(pty); return pty; } : options.spawn,
    unsupportedReason: 'Build node-pty here.',
    shell: '/bin/sh',
    flushMs: 0,
  });
  let phoneOn = false;
  const setting = { enabled: () => phoneOn, set: (enabled: boolean) => { phoneOn = enabled; if (!enabled) host.disconnectPhones(); } };
  const status = { state: 'connected', url: 'https://phone.example', error: '', available: true };
  const app = express();
  app.use(express.json());
  app.use('/api', setupTerminalRoutes(host, { hosted: options.hosted === true, phoneAllowed: setting.enabled }));
  app.use('/api', setupMobileAccessRoutes({ status: () => status } as unknown as MobileAccessController, { terminal: setting }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { host.dispose(); server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, init: { method?: string; body?: unknown; phone?: boolean; signal?: AbortSignal } = {}) => fetch(base + path, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers: { origin: base, 'content-type': 'application/json', ...(init.phone ? { 'x-michi-via': 'phone' } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { host, ptys, call, base };
}

const open = { terminalId: 't1', cwd: '/', cols: 80, rows: 24, clientId: 'w1' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (response: Response | Promise<Response>) => (await (await response).json()) as Record<string, any>;

test('a phone needs the Terminal setting, which only the desktop management routes change; the desktop needs none', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await json(f.call('/api/terminals', { phone: true })), {
    available: false, reason: 'phone-off', terminals: [],
    message: 'Terminals are off for phones on this machine. Turn them on in Settings › Phone access on your computer.',
  });
  const refused = await f.call('/api/terminals', { method: 'POST', body: open, phone: true });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'terminal_phone_off');
  assert.equal(f.ptys.length, 0);

  assert.equal((await f.call('/api/terminals', { method: 'POST', body: open })).status, 200);
  assert.equal(f.ptys.length, 1);
  // The phone cannot send input to the desktop's terminal either.
  assert.equal((await f.call('/api/terminals/t1/input', { method: 'POST', body: { clientId: 'p1', data: 'id\r' }, phone: true })).status, 403);
  assert.deepEqual(f.ptys[0].written, []);

  const turnedOn = await f.call('/api/mobile-access/terminal', { method: 'POST', body: { enabled: true } });
  assert.equal(turnedOn.status, 200);
  assert.equal((await json(turnedOn)).terminal, true);
  assert.equal((await json(f.call('/api/mobile-access'))).terminal, true);
  const list = await json(f.call('/api/terminals', { phone: true }));
  assert.equal(list.available, true);
  assert.deepEqual(list.terminals.map((terminal: { terminalId: string }) => terminal.terminalId), ['t1']);
  assert.equal((await f.call('/api/terminals/t1/input', { method: 'POST', body: { clientId: 'p1', data: 'id\r' }, phone: true })).status, 200);
  assert.deepEqual(f.ptys[0].written, ['id\r']);
  assert.equal((await f.call('/api/mobile-access/terminal', { method: 'POST', body: { enabled: 'yes' } })).status, 400);
});

test('turning the setting off ends a phone stream that is open', async (t) => {
  const f = await fixture(t);
  await f.call('/api/mobile-access/terminal', { method: 'POST', body: { enabled: true } });
  await f.call('/api/terminals', { method: 'POST', body: open });
  const stream = await f.call('/api/terminals/t1/stream?after=-1&clientId=p1', { phone: true });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const text = stream.text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.call('/api/mobile-access/terminal', { method: 'POST', body: { enabled: false } });
  const body = await text;
  assert.match(body, /event: reset\n/);
  assert.match(body, /event: closed\ndata: \{"type":"closed","reason":"phone-off"\}/);
  assert.equal(f.host.list().length, 1);
});

test('the stream replays the buffer, then sends live output; closing it detaches the window', async (t) => {
  const f = await fixture(t);
  await f.call('/api/terminals', { method: 'POST', body: open });
  f.ptys[0].listener!('$ ');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const controller = new AbortController();
  const stream = await f.call('/api/terminals/t1/stream?after=-1&clientId=w2', { signal: controller.signal });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const until = async (pattern: RegExp) => { while (!pattern.test(seen)) seen += decoder.decode((await reader.read()).value); };
  await until(/event: reset\ndata: \{[^\n]*"data":"\$ "/);
  assert.deepEqual(f.host.get('t1')?.clients, { phone: 0, desktop: 1 });
  f.ptys[0].listener!('ls');
  await until(/event: data\ndata: \{"type":"data","seq":4,"data":"ls"\}/);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.host.get('t1')?.clients, { phone: 0, desktop: 0 });
  assert.equal((await f.call('/api/terminals/missing/stream?clientId=w2')).status, 404);
  assert.equal((await f.call('/api/terminals/t1/stream')).status, 400);
});

test('hosted backends and machines without node-pty run no terminals, and say why', async (t) => {
  const hosted = await fixture(t, { hosted: true });
  assert.equal((await json(hosted.call('/api/terminals'))).reason, 'hosted');
  assert.equal((await hosted.call('/api/terminals', { method: 'POST', body: open })).status, 403);

  const unsupported = await fixture(t, { spawn: null });
  assert.deepEqual(await json(unsupported.call('/api/terminals')), { available: false, reason: 'unsupported', message: 'Build node-pty here.', terminals: [] });
  const refused = await unsupported.call('/api/terminals', { method: 'POST', body: open });
  assert.equal(refused.status, 503);
  assert.equal((await json(refused)).code, 'terminal_unsupported');
});

test('closing detaches the caller, and ends the terminal once nobody shows it', async (t) => {
  const f = await fixture(t);
  await f.call('/api/terminals', { method: 'POST', body: open });
  assert.equal((await f.call('/api/terminals/t1', { method: 'DELETE' })).status, 400);
  assert.deepEqual(await json(f.call('/api/terminals/t1?clientId=w1', { method: 'DELETE' })), { closed: true });
  assert.deepEqual(f.host.list(), []);
  assert.equal((await f.call('/api/terminals/t1/input', { method: 'POST', body: { clientId: 'w1', data: 'x' } })).status, 404);
});
