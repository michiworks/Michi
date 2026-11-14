import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

// Electron main's one notification subscription (electron/attentionNotifications.ts)
// and its system beacon (electron/systemPresence.ts). Reads the tsc output; run
// `npm run electron:build-main` first. No Electron process, window or OS
// notification is involved: the notifier takes doubles, and the feed talks to a
// throwaway loopback server. Its lifecycle (start, restart, stop, refusals) is
// in electron-lifecycle-helpers.test.mjs.
const require = createRequire(import.meta.url);
const attention = require('../electron/dist/attentionNotifications.js');
const presence = require('../electron/dist/systemPresence.js');
const sharedAttention = require('../shared/dist/attention.js');

const NOW = 1_800_000_000_000;

function record(overrides = {}) {
  return {
    id: 'attn-1', key: 'node:n-1', kind: 'needs_input', reason: 'approval', title: 'Fix the build', body: 'Run npm test',
    target: { type: 'node', nodeId: 'n-1', workspaceId: 'ws-1' }, createdAt: NOW - 1_000, claimedByWindowId: null, claimedAt: null,
    ...overrides,
  };
}

// ── The mirrors follow shared ────────────────────────────────────────────────

test('the event names, protocol and routes are shared\'s, under /api', () => {
  assert.equal(attention.ATTENTION_SNAPSHOT_EVENT, sharedAttention.ATTENTION_EVENTS.snapshot);
  assert.equal(attention.ATTENTION_NOTIFICATION_EVENT, sharedAttention.ATTENTION_EVENTS.notification);
  assert.equal(attention.ATTENTION_RESOLVED_EVENT, sharedAttention.ATTENTION_EVENTS.resolved);
  assert.equal(attention.ATTENTION_PROTOCOL, sharedAttention.ATTENTION_PROTOCOL);
  assert.equal(attention.ATTENTION_DESKTOP_STREAM_PATH, `/api${sharedAttention.ATTENTION_DESKTOP_STREAM_PATH}`);
  for (const id of ['attn-1', 'attn 1/2', 'é']) {
    assert.equal(attention.attentionDesktopClaimPath(id), `/api${sharedAttention.attentionDesktopClaimPath(id)}`);
  }
});

test('targets are read as shared reads them: every type, and nothing a click could not place', () => {
  const open = { kind: 'companion', tab: 'today', itemId: 'cmi-1' };
  const cases = [
    { type: 'node', nodeId: 'n-1', workspaceId: 'ws-1' },
    { type: 'agent_run', runId: 'run-1', workspaceId: 'ws-1' },
    { type: 'agent', ref: 'item:cmi-1', open, workspaceId: 'ws-michi' },
    { type: 'agent', ref: 'chat', open: { kind: 'companion', tab: 'chat', itemId: 'cmi-1' }, workspaceId: 'ws-michi' },
    { type: 'agent', ref: 'node:n-1', open: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-1' }, workspaceId: 'ws-michi' },
    { type: 'agent', ref: 'x', open: { kind: 'url', url: 'javascript:alert(1)' }, workspaceId: 'ws-michi' },
    { type: 'agent', ref: '', open, workspaceId: 'ws-michi' },
    { type: 'scheduled_run', runId: 'run-1', jobId: 'job-1', nodeId: null, workspaceId: 'ws-1' },
    { type: 'scheduled_run', runId: 'run-1', jobId: 'job-1', nodeId: 'n-1', workspaceId: 'ws-1' },
    { type: 'scheduled_run', runId: 'run-1', nodeId: null, workspaceId: 'ws-1' },
    { type: 'node', nodeId: 'n-1' },
    { type: 'spaces', workspaceId: 'ws-1' },
    null,
  ];
  for (const target of cases) {
    assert.deepEqual(attention.parseAttentionTarget(target), sharedAttention.parseAttentionTarget(target), JSON.stringify(target));
  }
  for (const value of [{ kind: 'settings' }, { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' }, { kind: 'companion', tab: 'inbox' }, {}]) {
    assert.deepEqual(attention.parseCompanionTarget(value), sharedAttention.parseAttentionOpenTarget(value), JSON.stringify(value));
  }
});

test('a record is rebuilt from its known fields, and dropped when malformed', () => {
  const value = record({ extra: 1 });
  const parsed = attention.parseAttentionRecord(value);
  assert.deepEqual(parsed, {
    id: 'attn-1', key: 'node:n-1', kind: 'needs_input', reason: 'approval', title: 'Fix the build', body: 'Run npm test',
    target: value.target, createdAt: value.createdAt, claimedByWindowId: null,
  });
  assert.equal(attention.parseAttentionRecord(record({ claimedByWindowId: 'w-1' })).claimedByWindowId, 'w-1');
  for (const bad of [record({ kind: 'loud' }), record({ id: '' }), record({ createdAt: 'x' }), record({ target: { type: 'elsewhere', workspaceId: 'w' } }), null]) {
    assert.equal(attention.parseAttentionRecord(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('the SSE parser takes split chunks, comments and CRLF', () => {
  const events = [];
  const parse = attention.createSseParser((event, data) => events.push([event, data]));
  parse(': keepalive\n\nevent: attention_notification\r\ndata: {"a"');
  parse(':1}\r\n\r\ndata: plain\n\n');
  assert.deepEqual(events, [['attention_notification', '{"a":1}'], ['message', 'plain']]);
});

// ── Delivery ─────────────────────────────────────────────────────────────────

function host(overrides = {}) {
  const banners = [];
  const opened = [];
  const handled = [];
  const claims = [];
  const state = { windowOpen: false, supported: true, claim: async () => true, background: 0 };
  class Banner {
    constructor(options) { this.options = options; this.listeners = {}; this.closed = false; this.shown = false; banners.push(this); }
    on(event, listener) { this.listeners[event] = listener; }
    show() { this.shown = true; }
    close() { this.closed = true; this.listeners.close?.(); }
    static isSupported() { return state.supported; }
  }
  const notifier = new attention.AttentionNotifier({
    Notification: Banner,
    hasOpenWindow: () => state.windowOpen,
    claim: (id) => { claims.push(id); return state.claim(id); },
    open: (target) => opened.push(target),
    now: () => NOW,
    onBackgroundDelivery: () => { state.background += 1; },
    onHandled: (value, outcome) => handled.push([value.id, outcome]),
    ...overrides,
  });
  return { notifier, banners, opened, handled, claims, state };
}

test('with no window open: claimed first, then a banner whose click opens the record\'s target, once', async () => {
  const { notifier, banners, opened, handled, claims, state } = host();
  const target = { type: 'agent', ref: 'item:cmi-1', open: { kind: 'companion', tab: 'today', itemId: 'cmi-1' }, workspaceId: 'ws-michi' };
  assert.equal(await notifier.notification(record({ target, kind: 'needs_input', reason: 'needs_you', title: 'Robin', body: 'MyService is blocked' })), 'banner');
  assert.deepEqual(claims, ['attn-1']);
  assert.deepEqual([banners[0].options, banners[0].shown], [{ title: 'Robin', body: 'MyService is blocked' }, true]);
  assert.equal(state.background, 1, 'a background launch may now idle-quit');
  banners[0].listeners.click();
  assert.deepEqual(opened, [target]);
  assert.equal(await notifier.notification(record()), 'duplicate');
  assert.deepEqual(handled, [['attn-1', 'banner'], ['attn-1', 'duplicate']]);
});

test('a window open, a record a window claimed, a claim lost or no OS notifications: no banner', async () => {
  const { notifier, banners, claims, state } = host();
  state.windowOpen = true;
  assert.equal(await notifier.notification(record({ id: 'a' })), 'window');
  state.windowOpen = false;
  assert.equal(await notifier.notification(record({ id: 'b', claimedByWindowId: 'w-1' })), 'claimed');
  state.claim = async () => false;
  assert.equal(await notifier.notification(record({ id: 'c' })), 'claimed');
  state.claim = async () => { throw new Error('offline'); };
  assert.equal(await notifier.notification(record({ id: 'd' })), 'claimed', 'a claim that failed is no claim');
  state.supported = false;
  assert.equal(await notifier.notification(record({ id: 'e' })), 'unavailable');
  assert.deepEqual([banners.length, claims], [0, ['c', 'd']]);
});

test('a resolved record takes its banner down, and one resolved while its claim was on its way never shows', async () => {
  const { notifier, banners, state } = host();
  await notifier.notification(record({ id: 'attn-1' }));
  notifier.resolved('attn-1');
  assert.equal(banners[0].closed, true);
  notifier.resolved('attn-unknown');
  let answer;
  state.claim = () => new Promise((resolve) => { answer = resolve; });
  const pending = notifier.notification(record({ id: 'attn-2' }));
  notifier.resolved('attn-2');
  answer(true);
  assert.equal(await pending, 'resolved');
  assert.equal(banners.length, 1);
});

test('a snapshot shows the newest unclaimed records of the last hour, at most three; older or claimed ones are left to the windows', async () => {
  const { notifier, banners, handled } = host();
  const at = (minutes) => NOW - minutes * 60_000;
  notifier.snapshot([
    record({ id: 'r-90', createdAt: at(90) }),
    record({ id: 'r-50', createdAt: at(50) }),
    record({ id: 'r-claimed', createdAt: at(2), claimedByWindowId: 'w-1' }),
    record({ id: 'r-40', createdAt: at(40) }),
    record({ id: 'r-30', createdAt: at(30) }),
    record({ id: 'r-1', createdAt: at(1) }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(banners.map((banner) => banner.options.title), ['Fix the build', 'Fix the build', 'Fix the build']);
  assert.deepEqual(handled.filter(([, outcome]) => outcome === 'banner').map(([id]) => id).sort(), ['r-1', 'r-30', 'r-40']);
  assert.deepEqual(handled.filter(([, outcome]) => outcome !== 'banner').sort(), [['r-50', 'old'], ['r-90', 'old'], ['r-claimed', 'claimed']].sort());
  assert.equal(attention.ATTENTION_DESKTOP_REPLAY_MS, 60 * 60_000);
  assert.equal(attention.ATTENTION_DESKTOP_REPLAY_MAX, 3);
});

// ── Windows ──────────────────────────────────────────────────────────────────

test('a click waits for a window whose renderer does not listen yet, and goes to it once it does', () => {
  const sent = [];
  const renderers = new attention.CompanionRenderers((windowId, target) => sent.push([windowId, target]));
  const target = { kind: 'companion', tab: 'chat' };
  renderers.open(1, target);
  assert.deepEqual(sent, []);
  assert.equal(renderers.report(1, 'notice', true), false, 'only clicks are listened for');
  assert.equal(renderers.report(1, 'open', 'yes'), false);
  assert.equal(renderers.report(1, 'open', true), true);
  assert.deepEqual(sent, [[1, target]]);
  renderers.open(1, { kind: 'settings' });
  assert.deepEqual(sent.at(-1), [1, { kind: 'settings' }]);
  assert.equal(renderers.documentGone(1), true);
  renderers.open(1, target);
  assert.equal(sent.length, 2, 'a new document listens only once it says so');
  renderers.forget(1);
  renderers.report(1, 'open', true);
  assert.equal(sent.length, 2, 'a closed window\'s click is dropped');
});

// ── The claim over HTTP ──────────────────────────────────────────────────────

test('a claim is the desktop notifier\'s when the backend says claimed', async (t) => {
  const answers = [{ status: 200, body: { claimed: true, claimedByWindowId: 'desktop-notifier', status: 'active' } },
    { status: 200, body: { claimed: false, claimedByWindowId: 'w-1', status: 'active' } }, { status: 404, body: { error: 'not_found' } },
    { status: 200, body: 'not json' }];
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    const answer = answers.shift();
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const feed = new attention.AttentionDesktopFeed({ port: () => server.address().port, onSnapshot() {}, onNotification() {}, onResolved() {} });
  assert.deepEqual([await feed.claim('attn-1'), await feed.claim('attn-1'), await feed.claim('attn-1'), await feed.claim('attn-1')], [true, false, false, false]);
  assert.deepEqual(paths, Array(4).fill('POST /api/attention/desktop/notifications/attn-1/claim'));
});

// ── The system beacon ────────────────────────────────────────────────────────

test('the system beacon posts the computer\'s idle seconds every minute, and asks seldom where the backend refuses it', async () => {
  const posts = [];
  const timers = [];
  let status = 204;
  let port = null;
  const reporter = new presence.SystemPresenceReporter({
    port: () => port,
    idleSeconds: () => 42.7,
    post: async (to, body) => { posts.push([to, JSON.parse(body)]); return status; },
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  const tick = async () => { const timer = timers.at(-1); await timer.callback(); await new Promise((resolve) => setImmediate(resolve)); };
  reporter.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([posts, timers.at(-1).delayMs], [[], presence.SYSTEM_PRESENCE_INTERVAL_MS], 'no port yet: it waits a beat');
  port = 3000;
  await tick();
  assert.deepEqual(posts, [[3000, { systemIdleSeconds: 42 }]]);
  assert.equal(timers.at(-1).delayMs, 60_000);
  status = 404;
  await tick();
  assert.equal(timers.at(-1).delayMs, presence.SYSTEM_PRESENCE_REFUSED_MS);
  reporter.stop();
  assert.equal(timers.at(-1).cancelled, true);
  assert.equal(presence.SYSTEM_PRESENCE_PATH, '/api/companion/presence');
});
