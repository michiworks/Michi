import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerClient, CodexRpcTimeoutError } from '../src/adapters/codex/CodexAppServerClient';

/** Minimal ChildProcess stand-in: scriptable stdout, captured stdin. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = '';
  child.stdin.on('data', (d: Buffer) => {
    child.written += d.toString();
  });
  child.kill = () => {
    child.emit('exit', 0);
  };
  return child;
}

function makeClient(child: any, overrides: Record<string, unknown> = {}) {
  return new CodexAppServerClient({
    spawnFn: () => child,
    rpcTimeoutMs: 200,
    initTimeoutMs: 200,
    ...overrides,
  });
}

/** Auto-answer initialize so ensureStarted resolves.
 *  Responds on the first `data` event from stdin that contains an initialize
 *  request. Using a stream `data` event (rather than a polled interval) keeps
 *  the approach synchronous with the event loop and avoids unref-related
 *  cancellations in node:test.
 */
function autoInit(child: any) {
  let buf = '';
  let done = false;
  child.stdin.on('data', (d: Buffer) => {
    if (done) return;
    buf += d.toString();
    const m = buf.match(/\{"jsonrpc":"2\.0","id":(\d+),"method":"initialize"/);
    if (m) {
      done = true;
      const id = Number(m[1]);
      child.stdout.write(JSON.stringify({ id, result: { userAgent: 'fake' } }) + '\n');
    }
  });
}

test('request rejects with CodexRpcTimeoutError when no response arrives', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  await assert.rejects(client.request('thread/start', {}), CodexRpcTimeoutError);
  await client.shutdown();
});

test('notifications route to thread-scoped handlers; unknown methods are ignored', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  const seen: string[] = [];
  client.onNotification('t-1', (method) => {
    seen.push(method);
  });
  child.stdout.write(
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't-1', delta: 'x' },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't-OTHER', delta: 'y' },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      method: 'totally/unknown/notification',
      params: { threadId: 't-1' },
    }) + '\n',
  );
  child.stdout.write('not json at all\n');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['item/agentMessage/delta', 'totally/unknown/notification']);
  await client.shutdown();
});

test('a throwing thread handler reaches neither the stdout listener nor the handlers and lines after it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  const seen: unknown[] = [];
  client.onNotification('t-1', () => { throw new Error('translator failed'); });
  client.onNotification('t-1', (_method, params) => { seen.push(params.delta); });
  const line = (delta: string) => JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't-1', delta } }) + '\n';
  child.stdout.write(line('a') + line('b'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['a', 'b']);
  await client.shutdown();
});

test('server requests (string AND numeric ids) dispatch and respond is wired back', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child);
  await client.ensureStarted();
  client.onServerRequest((method, _params, respond) => {
    respond({ decision: 'accept' });
  });
  child.stdout.write(
    JSON.stringify({
      id: 'req-abc',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't-1' },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't-1' },
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 20));
  const outs = child.written
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
  assert.ok(outs.some((o: any) => o.id === 'req-abc' && o.result?.decision === 'accept'));
  assert.ok(outs.some((o: any) => o.id === 42 && o.result?.decision === 'accept'));
  await client.shutdown();
});

test('daemon exit rejects pending requests and fires exit handlers', async () => {
  const child = fakeChild();
  autoInit(child);
  const client = makeClient(child, { rpcTimeoutMs: 5_000 });
  await client.ensureStarted();
  let exited = false;
  client.onExit(() => {
    exited = true;
  });
  const pending = client.request('thread/start', {});
  child.emit('exit', 1);
  await assert.rejects(pending, /exited/);
  assert.equal(exited, true);
  await client.shutdown();
});

test('stdout EOF rejects local work and late old-child callbacks cannot kill a replacement', async () => {
  const first = fakeChild(), second = fakeChild();
  autoInit(first); autoInit(second);
  const children = [first, second];
  const client = makeClient(first, { spawnFn: () => children.shift() });
  await client.ensureStarted();
  let oldRespond!: (value: unknown) => void;
  client.onServerRequest((_method, _params, respond) => { oldRespond = respond; });
  first.stdout.write(JSON.stringify({ id: 'old-approval', method: 'requestApproval' }) + '\n');
  const pending = client.request('turn/start', { threadId: 'native' });
  const failed = assert.rejects(pending, /exited/);
  first.stdout.end();
  await failed;
  await client.ensureStarted();
  oldRespond({ decision: 'accept' });
  first.emit('exit', 0);
  first.stdin.emit('error', new Error('old pipe'));
  assert.equal(client.isRunning(), true);
  assert.doesNotMatch(second.written, /old-approval/);
  await client.shutdown();
});

test("start handlers run after each app-server's initialize handshake, before ensureStarted resolves", async (t) => {
  const children = [fakeChild(), fakeChild()];
  for (const child of children) {
    let buf = '';
    child.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const message = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (message.id !== undefined) child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
      }
    });
  }
  const spawned = [...children];
  const client = makeClient(children[0], { spawnFn: () => spawned.shift() });
  const warn = t.mock.method(console, 'warn', () => {});
  const events: string[] = [];
  client.onStarted(async () => {
    await client.request('probe/started', {});
    events.push('first');
    throw new Error('a failing handler does not fail the start');
  });
  client.onStarted(async () => { events.push('second'); });
  await client.ensureStarted();
  events.push('started');
  children[0].emit('exit', 1);
  await client.ensureStarted();
  events.push('restarted');
  assert.deepEqual(events, ['first', 'second', 'started', 'first', 'second', 'restarted']);
  assert.equal(warn.mock.callCount(), 2);
  for (const child of children) {
    const methods = child.written.split('\n').filter(Boolean).map((line: string) => JSON.parse(line).method);
    assert.deepEqual(methods, ['initialize', 'initialized', 'probe/started']);
  }
  await client.shutdown();
});

test('failed spawn without a PID or exit event does not permanently quarantine the client', async () => {
  const first = fakeChild(), second = fakeChild();
  first.kill = () => false;
  autoInit(second);
  const children = [first, second];
  const client = makeClient(first, { spawnFn: () => children.shift() });
  const starting = assert.rejects(client.ensureStarted(), /exited/);
  first.emit('error', new Error('ENOENT'));
  await starting;
  await client.ensureStarted();
  assert.equal(client.isRunning(), true);
  await client.shutdown();
});
