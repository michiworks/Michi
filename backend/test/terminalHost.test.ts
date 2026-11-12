import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import type { TerminalStreamEvent } from 'michi-shared';
import { TerminalError, TerminalHost, terminalEnvironment, type PtyProcess, type SpawnPty, type TerminalHostOptions } from '../src/services/terminalHost';

class FakePty implements PtyProcess {
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number }) => void;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  constructor(readonly file: string, readonly args: string[], readonly options: Parameters<SpawnPty>[2]) {}
  onData(listener: (data: string) => void) { this.dataListener = listener; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListener = listener; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; }
  emit(data: string) { this.dataListener?.(data); }
  exit(exitCode: number) { this.exitListener?.({ exitCode }); }
}

function harness(options: Partial<TerminalHostOptions> = {}) {
  const ptys: FakePty[] = [];
  let now = 1_000;
  const host = new TerminalHost({
    spawn: (file, args, opts) => { const pty = new FakePty(file, args, opts); ptys.push(pty); return pty; },
    shell: '/bin/sh',
    env: { HOME: '/tmp', PATH: '/bin', MICHI_DATA_DIR: '/data', MICHI_REMOTE_TOKEN: 'secret', ELECTRON_RUN_AS_NODE: '1' },
    now: () => now,
    flushMs: 0,
    ...options,
  });
  const subscriber = (clientId: string, phone = false) => {
    const events: TerminalStreamEvent[] = [];
    const sub = {
      clientId, phone, events, closed: false,
      send: (event: TerminalStreamEvent) => { if (sub.closed) return false; events.push(event); return true; },
      close: () => { sub.closed = true; },
    };
    return sub;
  };
  return { host, ptys, subscriber, advance: (ms: number) => { now += ms; } };
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 5));
const create = (host: TerminalHost, terminalId = 't1', clientId = 'w1', cols = 80, rows = 24) =>
  host.create({ terminalId, cwd: '/definitely/not/here', cols, rows, clientId });
const without = (events: TerminalStreamEvent[], type: TerminalStreamEvent['type']) => events.filter((event) => event.type !== type);

test('starts a login shell without the backend secrets and streams its output to attached windows', async (t) => {
  const { host, ptys, subscriber } = harness();
  t.after(() => host.dispose());
  const summary = create(host);
  assert.equal(ptys.length, 1);
  assert.equal(ptys[0].file, '/bin/sh');
  assert.deepEqual(ptys[0].args, ['-l']);
  assert.equal(ptys[0].options.cwd, os.homedir());
  assert.equal(ptys[0].options.env.MICHI_REMOTE_TOKEN, undefined);
  assert.equal(ptys[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(ptys[0].options.env.MICHI_DATA_DIR, '/data');
  assert.equal(ptys[0].options.env.TERM, 'xterm-256color');

  const window = subscriber('w1');
  host.attach('t1', window, -1);
  assert.deepEqual(window.events[0], { type: 'reset', seq: 0, instance: summary.instance, data: '', exited: false });
  ptys[0].emit('hello ');
  ptys[0].emit('world');
  await flushed();
  assert.deepEqual(without(window.events, 'peers').slice(1), [{ type: 'data', seq: 11, data: 'hello world' }]);
  // Opening the same id again attaches to the running shell.
  assert.equal(create(host).instance, summary.instance);
  assert.equal(ptys.length, 1);
});

test('a reconnecting window gets only what it missed, or the whole buffer when that is gone', async (t) => {
  const { host, ptys, subscriber } = harness({ replayChars: 10 });
  t.after(() => host.dispose());
  const { instance } = create(host);
  ptys[0].emit('abcdef');
  await flushed();
  const back = subscriber('w1');
  host.attach('t1', back, 3, instance);
  assert.deepEqual(back.events[0], { type: 'data', seq: 6, data: 'def' });

  const otherRun = subscriber('w2');
  host.attach('t1', otherRun, 3, 'an-earlier-backend');
  assert.equal(otherRun.events[0].type, 'reset');

  ptys[0].emit('ghijklmn');
  await flushed();
  const late = subscriber('w3');
  host.attach('t1', late, 2, instance);
  assert.deepEqual(late.events[0], { type: 'reset', seq: 14, instance, data: 'efghijklmn', exited: false });
  const ahead = subscriber('w4');
  host.attach('t1', ahead, 20, instance);
  assert.equal(ahead.events[0].type, 'reset');
});

test('the window that typed last decides the size', (t) => {
  const { host, ptys, subscriber } = harness();
  t.after(() => host.dispose());
  create(host, 't1', 'desk', 120, 40);
  host.attach('t1', subscriber('desk'), -1);
  const phone = subscriber('phone', true);
  const detachPhone = host.attach('t1', phone, -1);
  host.resize('t1', 'phone', 48, 30);
  assert.deepEqual(ptys[0].sizes, []);
  host.write('t1', 'phone', 'l');
  assert.deepEqual(ptys[0].sizes, [[48, 30]]);
  assert.deepEqual(ptys[0].written, ['l']);
  host.resize('t1', 'desk', 121, 40);
  assert.deepEqual(ptys[0].sizes, [[48, 30]]);
  detachPhone();
  host.resize('t1', 'desk', 122, 40);
  assert.deepEqual(ptys[0].sizes, [[48, 30], [122, 40]]);
  assert.throws(() => host.write('t1', 'desk', 'x'.repeat(16 * 1024 + 1)), (error: unknown) => error instanceof TerminalError && error.status === 413);
});

test('closing a pane ends the terminal only when no other window shows it', (t) => {
  const { host, ptys, subscriber } = harness();
  t.after(() => host.dispose());
  create(host);
  const one = subscriber('w1');
  const two = subscriber('w2');
  host.attach('t1', one, -1);
  host.attach('t1', two, -1);
  assert.deepEqual(host.close('t1', 'w1'), { closed: false });
  assert.equal(one.closed, true);
  assert.equal(ptys[0].killed, false);
  assert.deepEqual(two.events.at(-1), { type: 'peers', phone: 0, desktop: 0 });
  assert.deepEqual(host.close('t1', 'w2'), { closed: true });
  assert.equal(ptys[0].killed, true);
  assert.equal(two.closed, true);
  assert.deepEqual(host.list(), []);
});

test('an exit reaches windows that attach later, and a restart starts a new shell for every window', async (t) => {
  const { host, ptys, subscriber } = harness();
  t.after(() => host.dispose());
  const { instance } = create(host);
  const window = subscriber('w1');
  host.attach('t1', window, -1);
  ptys[0].emit('bye');
  ptys[0].exit(3);
  assert.deepEqual(without(window.events, 'peers').slice(-2), [{ type: 'data', seq: 3, data: 'bye' }, { type: 'exit', seq: 3, exitCode: 3 }]);
  const caughtUp = subscriber('w2');
  host.attach('t1', caughtUp, 3, instance);
  assert.deepEqual(caughtUp.events[0], { type: 'exit', seq: 3, exitCode: 3 });
  const fresh = subscriber('w3');
  host.attach('t1', fresh, -1);
  assert.deepEqual(fresh.events[0], { type: 'reset', seq: 3, instance, data: 'bye', exited: true, exitCode: 3 });

  const restarted = host.restart('t1', 'w1');
  assert.equal(restarted.exited, false);
  assert.equal(ptys.length, 2);
  assert.deepEqual(window.events.at(-1), { type: 'restart', seq: 3 });
  ptys[1].emit('$ ');
  await flushed();
  assert.deepEqual(window.events.at(-1), { type: 'data', seq: 5, data: '$ ' });
  // Output of the old shell after the restart is ignored.
  ptys[0].emit('late');
  await flushed();
  assert.deepEqual(window.events.at(-1), { type: 'data', seq: 5, data: '$ ' });
});

test('peers count the other windows by how they connected; turning phones off ends only phone streams', (t) => {
  const { host, subscriber } = harness();
  t.after(() => host.dispose());
  create(host);
  const desk = subscriber('desk');
  const phone = subscriber('phone', true);
  host.attach('t1', desk, -1);
  host.attach('t1', phone, -1);
  assert.deepEqual(desk.events.at(-1), { type: 'peers', phone: 1, desktop: 0 });
  assert.deepEqual(phone.events.at(-1), { type: 'peers', phone: 0, desktop: 1 });
  assert.deepEqual(host.get('t1')?.clients, { phone: 1, desktop: 1 });
  host.disconnectPhones();
  assert.deepEqual(phone.events.at(-1), { type: 'closed', reason: 'phone-off' });
  assert.equal(phone.closed, true);
  assert.equal(desk.closed, false);
  assert.deepEqual(desk.events.at(-1), { type: 'peers', phone: 0, desktop: 0 });
  assert.equal(host.list().length, 1);
});

test('a machine runs a bounded number of terminals and closes ones no window has used for long', (t) => {
  const { host, ptys, subscriber, advance } = harness({ maxTerminals: 2, idleMs: 1_000, exitedIdleMs: 100 });
  t.after(() => host.dispose());
  create(host, 'a');
  create(host, 'b');
  assert.throws(() => create(host, 'c'), (error: unknown) => error instanceof TerminalError && error.code === 'terminal_limit' && error.status === 429);
  ptys[1].exit(0);
  create(host, 'c');
  const watching = subscriber('w1');
  const detach = host.attach('c', watching, -1);
  advance(150);
  host.sweep();
  assert.deepEqual(host.list().map((terminal) => terminal.terminalId).sort(), ['a', 'c']);
  advance(1_000);
  host.sweep();
  assert.deepEqual(host.list().map((terminal) => terminal.terminalId), ['c']);
  assert.equal(ptys[0].killed, true);
  detach();
  advance(999);
  host.sweep();
  assert.equal(host.list().length, 1);
  advance(1);
  host.sweep();
  assert.equal(host.list().length, 0);
});

test('without node-pty, creating a terminal explains why it cannot', () => {
  const host = new TerminalHost({ spawn: null, unsupportedReason: 'Build node-pty here.' });
  try {
    assert.equal(host.supported, false);
    assert.throws(() => create(host), (error: unknown) => error instanceof TerminalError && error.status === 503 && error.message === 'Build node-pty here.');
  } finally { host.dispose(); }
});

test('shells never inherit the backend secrets', () => {
  const env = terminalEnvironment({ MICHI_REMOTE_TOKEN: 'a', MICHI_ENCRYPTION_KEY: 'b', BETTER_AUTH_SECRET: 'c', MICHI_DATA_DIR: '/d', HOME: '/h' });
  assert.deepEqual(env, { MICHI_DATA_DIR: '/d', HOME: '/h', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
});
