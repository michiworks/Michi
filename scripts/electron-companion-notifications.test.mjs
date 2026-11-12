import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

// Reads the tsc output; run `npm run electron:build-main` first. No Electron
// process, window or OS notification is involved: the notifier takes doubles,
// and the feed talks to a throwaway loopback server.
const require = createRequire(import.meta.url);
const companion = require('../electron/dist/companionNotifications.js');

const NOW = 1_800_000_000_000;
const STREAM = '/api/companion/notifications/stream';
const HOLD_MS = companion.COMPANION_HOLD_MS;

const TODAY = { kind: 'companion', tab: 'today' };
/** Today at one item: the target of a notice about a single item. */
const TODAY_ITEM = { kind: 'companion', tab: 'today', itemId: 'cmi-1' };
const CHAT = { kind: 'companion', tab: 'chat' };
const CONVERSATION = { kind: 'node', workspaceId: 'ws-1', nodeId: 'node-1' };

/** A notice as the backend sends one about a single item (delivery.ts itemNoticeDraft): Today, at that item. */
function notice(overrides = {}) {
  return {
    id: 'cmn-1',
    title: 'Companion',
    body: 'CR-123456 has 2 unresolved comments.',
    target: TODAY_ITEM,
    itemIds: ['cmi-1'],
    createdAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

const frame = (event, data) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

// ── Parsing ──────────────────────────────────────────────────────────────────

test('notices are rebuilt from their known fields', () => {
  const parsed = companion.parseCompanionNotice({
    ...notice(),
    extra: 'dropped',
    target: { ...notice().target, extra: true },
    itemIds: ['cmi-1', 7, '', null],
  });
  assert.deepEqual(parsed, notice());
});

test('malformed notices are rejected', () => {
  for (const bad of [
    null, [], 'cmn-1',
    notice({ id: '' }), notice({ id: 3 }), notice({ title: null }), notice({ body: undefined }),
    notice({ target: null }), notice({ target: 'chat' }), notice({ itemIds: 'cmi-1' }),
    notice({ createdAt: '1' }), notice({ expiresAt: Number.NaN }), notice({ expiresAt: undefined }),
  ]) {
    assert.equal(companion.parseCompanionNotice(bad), null, JSON.stringify(bad));
  }
});

test('a target this app cannot place opens the Companion chat', () => {
  for (const target of [
    { kind: 'spaces' }, { kind: 'url', url: 'javascript:alert(1)' }, { kind: 'url', url: 'not a url' },
    { kind: 'url', url: ' https://reviews.example.com' }, { kind: 'url', url: 'file:///etc/passwd' },
    { kind: 'node', workspaceId: 'w' }, { kind: 'companion', tab: 'inbox' }, { kind: 'companion', tab: 'inbox', itemId: 'cmi-1' }, {},
  ]) {
    assert.deepEqual(companion.parseCompanionNotice(notice({ target })).target, CHAT, JSON.stringify(target));
  }
  for (const target of [CONVERSATION, TODAY, TODAY_ITEM, CHAT, { kind: 'settings' }, { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' }]) {
    assert.deepEqual(companion.parseCompanionNotice(notice({ target })).target, target);
  }
});

test('a Companion target keeps the item it names on Today, and only a well-formed one', () => {
  assert.deepEqual(companion.parseCompanionTarget({ ...TODAY_ITEM, extra: true }), TODAY_ITEM);
  assert.deepEqual(companion.parseCompanionTarget({ ...TODAY, itemId: 'x'.repeat(160) }), { ...TODAY, itemId: 'x'.repeat(160) });
  // Malformed: just the tab.
  for (const itemId of ['', 7, null, 'x'.repeat(161), ['cmi-1']]) {
    assert.deepEqual(companion.parseCompanionTarget({ ...TODAY, itemId }), TODAY, JSON.stringify(itemId));
  }
  // Today only: Chat has no item to bring into view.
  assert.deepEqual(companion.parseCompanionTarget({ ...CHAT, itemId: 'cmi-1' }), CHAT);
});

// ── Delivery plan ────────────────────────────────────────────────────────────

test('delivery plan: stale and already-shown notices are skipped but acknowledged', () => {
  for (const focusedWindow of ['none', 'loading', 'ready']) {
    const env = { now: NOW, focusedWindow, heldForMs: 0, osNotificationsSupported: true, alreadyShown: false };
    assert.deepEqual(companion.planCompanionNoticeDelivery(notice({ expiresAt: NOW }), env), { kind: 'skip', ack: true, reason: 'expired' });
    assert.deepEqual(companion.planCompanionNoticeDelivery(notice({ expiresAt: NOW - 1 }), env), { kind: 'skip', ack: true, reason: 'expired' });
    assert.deepEqual(companion.planCompanionNoticeDelivery(notice(), { ...env, alreadyShown: true }), { kind: 'skip', ack: true, reason: 'duplicate' });
  }
});

test('delivery plan: a focused window that shows toasts gets one, otherwise a banner, otherwise the notice waits', () => {
  const env = { now: NOW, heldForMs: 0, alreadyShown: false };
  for (const osNotificationsSupported of [true, false]) {
    assert.deepEqual(
      companion.planCompanionNoticeDelivery(notice(), { ...env, focusedWindow: 'ready', osNotificationsSupported }),
      { kind: 'toast', ack: true },
    );
  }
  assert.deepEqual(
    companion.planCompanionNoticeDelivery(notice(), { ...env, focusedWindow: 'none', osNotificationsSupported: true }),
    { kind: 'banner', ack: true },
  );
  assert.deepEqual(
    companion.planCompanionNoticeDelivery(notice(), { ...env, focusedWindow: 'none', osNotificationsSupported: false }),
    { kind: 'defer', ack: false },
  );
});

test('delivery plan: a focused window that does not listen yet holds the notice, unacknowledged, for COMPANION_HOLD_MS', () => {
  const env = { now: NOW, focusedWindow: 'loading', alreadyShown: false };
  for (const osNotificationsSupported of [true, false]) {
    for (const heldForMs of [0, HOLD_MS - 1]) {
      assert.deepEqual(
        companion.planCompanionNoticeDelivery(notice(), { ...env, heldForMs, osNotificationsSupported }),
        { kind: 'hold', ack: false },
      );
    }
  }
  // Waited long enough: a banner; with no banners, it keeps waiting for the window.
  assert.deepEqual(
    companion.planCompanionNoticeDelivery(notice(), { ...env, heldForMs: HOLD_MS, osNotificationsSupported: true }),
    { kind: 'banner', ack: true },
  );
  assert.deepEqual(
    companion.planCompanionNoticeDelivery(notice(), { ...env, heldForMs: HOLD_MS, osNotificationsSupported: false }),
    { kind: 'hold', ack: false },
  );
});

// ── Notifier (Electron doubles) ──────────────────────────────────────────────

function fakeElectron({ focused = false, listening = true, supported = true } = {}) {
  const state = {
    focused, listening, supported, now: NOW,
    toasts: [], banners: [], opened: [], acks: [], handled: [], timers: [], background: 0,
  };
  class FakeNotification {
    static isSupported() { return state.supported; }
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.shown = false;
      state.banners.push(this);
    }
    on(event, listener) { this.listeners[event] = listener; return this; }
    show() { this.shown = true; }
  }
  const host = {
    Notification: FakeNotification,
    focusedWindow: () => (state.focused ? { listening: state.listening, showNotice: (value) => state.toasts.push(value) } : null),
    open: (target) => state.opened.push(target),
    acknowledge: (id) => state.acks.push(id),
    now: () => state.now,
    onBackgroundDelivery: () => { state.background += 1; },
    onHandled: (value, plan) => state.handled.push([value.id, plan]),
    setTimer: (callback, delayMs) => {
      const timer = { at: state.now + delayMs, callback, live: true };
      state.timers.push(timer);
      return () => { timer.live = false; };
    },
  };
  /** Moves the clock on and runs the timers that came due. */
  const advance = (ms) => {
    state.now += ms;
    for (const timer of [...state.timers]) {
      if (timer.live && timer.at <= state.now) {
        timer.live = false;
        timer.callback();
      }
    }
  };
  const liveTimers = () => state.timers.filter((timer) => timer.live).length;
  return { host, state, advance, liveTimers };
}

const HOLD = { kind: 'hold', ack: false };

test('a focused Michi window shows the notice as an in-app toast and acknowledges it', () => {
  const { host, state } = fakeElectron({ focused: true });
  const notifier = new companion.CompanionNotifier(host);
  const value = notice();
  assert.deepEqual(notifier.deliver(value), { kind: 'toast', ack: true });
  assert.deepEqual(state.toasts, [value]);
  assert.equal(state.banners.length, 0);
  assert.deepEqual(state.acks, ['cmn-1']);
  assert.equal(state.background, 0);
  assert.deepEqual(state.handled, [['cmn-1', { kind: 'toast', ack: true }]]);
});

test('in the background the notice is an OS banner whose click opens the Companion at its target', () => {
  const { host, state } = fakeElectron({ focused: false });
  const notifier = new companion.CompanionNotifier(host);
  assert.deepEqual(notifier.deliver(notice()), { kind: 'banner', ack: true });
  assert.equal(state.toasts.length, 0);
  assert.equal(state.banners.length, 1);
  const [banner] = state.banners;
  assert.deepEqual(banner.options, { title: 'Companion', body: 'CR-123456 has 2 unresolved comments.' });
  assert.equal(banner.shown, true);
  assert.deepEqual(state.acks, ['cmn-1']);
  assert.equal(state.background, 1, 'a background launch re-arms its idle quit');
  assert.deepEqual(state.opened, []);
  banner.listeners.click();
  // At the item, as the toast's click would open it.
  assert.deepEqual(state.opened, [TODAY_ITEM]);
  assert.equal(typeof banner.listeners.close, 'function');
});

test('every notice shape the backend sends: a banner opens exactly its target, a toast carries the notice unchanged', () => {
  // backend/src/services/companion/delivery.ts: the target is the single source of truth for a click.
  const shapes = [
    notice({ id: 'one-item', target: TODAY_ITEM, itemIds: ['cmi-1'] }),
    notice({ id: 'waiting-conversation', target: CONVERSATION, itemIds: ['cmi-2'] }),
    notice({ id: 'batch-or-fold', target: TODAY, itemIds: ['cmi-1', 'cmi-3'] }),
    notice({ id: 'reply', target: CHAT, itemIds: [] }),
    notice({ id: 'worker-finished', target: CONVERSATION, itemIds: [] }),
  ];
  for (const value of shapes) {
    const parsed = companion.parseCompanionNotice(JSON.parse(JSON.stringify(value)));
    assert.deepEqual(parsed, value, value.id);
    const background = fakeElectron({ focused: false });
    new companion.CompanionNotifier(background.host).deliver(parsed);
    background.state.banners[0].listeners.click();
    assert.deepEqual(background.state.opened, [value.target], value.id);
    const foreground = fakeElectron({ focused: true });
    new companion.CompanionNotifier(foreground.host).deliver(parsed);
    assert.deepEqual(foreground.state.toasts, [value], value.id);
  }
});

test('a stale notice is never shown but is acknowledged so it is not replayed', () => {
  for (const [focused, listening] of [[true, true], [true, false], [false, true]]) {
    const { host, state } = fakeElectron({ focused, listening });
    const notifier = new companion.CompanionNotifier(host);
    assert.deepEqual(notifier.deliver(notice({ expiresAt: NOW })), { kind: 'skip', ack: true, reason: 'expired' });
    assert.equal(state.toasts.length + state.banners.length, 0);
    assert.deepEqual(state.acks, ['cmn-1']);
  }
});

test('a replay after a lost acknowledgement is acknowledged again without a second notification', () => {
  const { host, state } = fakeElectron({ focused: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice());
  state.focused = true;
  assert.deepEqual(notifier.deliver(notice()), { kind: 'skip', ack: true, reason: 'duplicate' });
  assert.equal(state.banners.length, 1);
  assert.equal(state.toasts.length, 0);
  assert.deepEqual(state.acks, ['cmn-1', 'cmn-1']);
});

test('a notice nothing can show stays pending and is shown when it is replayed later', () => {
  const { host, state } = fakeElectron({ focused: false, supported: false });
  const notifier = new companion.CompanionNotifier(host);
  assert.deepEqual(notifier.deliver(notice()), { kind: 'defer', ack: false });
  assert.deepEqual(state.acks, []);
  assert.equal(state.background, 1);
  state.focused = true;
  assert.deepEqual(notifier.deliver(notice()), { kind: 'toast', ack: true });
  assert.deepEqual(state.acks, ['cmn-1']);
});

// ── Notifier: a focused window whose renderer does not listen yet ────────────

test('a focused window whose renderer does not listen yet holds the notice: not shown, not acknowledged', () => {
  const { host, state, liveTimers } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  assert.deepEqual(notifier.deliver(notice()), HOLD);
  assert.equal(state.toasts.length + state.banners.length, 0);
  assert.deepEqual(state.acks, []);
  assert.equal(state.background, 0);
  assert.deepEqual(state.handled, [['cmn-1', HOLD]]);
  assert.equal(liveTimers(), 1, 'it wakes up when the wait runs out');
  // The same notice again while it waits: still one, reported once.
  assert.deepEqual(notifier.deliver(notice()), HOLD);
  notifier.refresh();
  assert.equal(state.toasts.length + state.banners.length, 0);
  assert.deepEqual(state.acks, []);
  assert.equal(state.handled.length, 1);
});

test('a held notice becomes a toast, and is acknowledged, once the focused renderer listens', () => {
  const { host, state, liveTimers } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice());
  state.now += 2_000;
  state.listening = true;
  notifier.refresh();
  assert.deepEqual(state.toasts, [notice()]);
  assert.deepEqual(state.acks, ['cmn-1']);
  assert.deepEqual(state.handled, [['cmn-1', HOLD], ['cmn-1', { kind: 'toast', ack: true }]]);
  assert.equal(liveTimers(), 0, 'nothing waits any more');
  // Shown once: a replay after a lost acknowledgement is a duplicate.
  assert.deepEqual(notifier.deliver(notice()), { kind: 'skip', ack: true, reason: 'duplicate' });
  assert.equal(state.toasts.length, 1);
});

test('a held notice becomes a banner when Michi loses focus, and its click opens the target', () => {
  const { host, state } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice({ target: CONVERSATION, itemIds: ['cmi-2'] }));
  state.focused = false;
  notifier.refresh();
  assert.equal(state.toasts.length, 0);
  assert.equal(state.banners.length, 1);
  assert.deepEqual(state.acks, ['cmn-1']);
  assert.equal(state.background, 1);
  state.banners[0].listeners.click();
  assert.deepEqual(state.opened, [CONVERSATION]);
});

test('a held notice becomes a banner once it has waited COMPANION_HOLD_MS; each notice waits its own time', () => {
  const { host, state, advance, liveTimers } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice({ id: 'cmn-1' }));
  advance(4_000);
  notifier.deliver(notice({ id: 'cmn-2' }));
  advance(HOLD_MS - 4_000 - 1);
  assert.equal(state.banners.length, 0);
  advance(1);
  assert.deepEqual(state.banners.map((banner) => banner.options.body), [notice().body]);
  assert.deepEqual(state.acks, ['cmn-1']);
  assert.equal(liveTimers(), 1, 'the second notice still waits');
  advance(4_000);
  assert.equal(state.banners.length, 2);
  assert.deepEqual(state.acks, ['cmn-1', 'cmn-2']);
  assert.deepEqual(state.handled.map(([id, plan]) => [id, plan.kind]), [['cmn-1', 'hold'], ['cmn-2', 'hold'], ['cmn-1', 'banner'], ['cmn-2', 'banner']]);
  assert.equal(liveTimers(), 0);
});

test('with no banners, a held notice waits for the focused window past COMPANION_HOLD_MS, and is deferred once Michi loses focus', () => {
  const { host, state, advance, liveTimers } = fakeElectron({ focused: true, listening: false, supported: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice({ id: 'cmn-1' }));
  advance(HOLD_MS * 3);
  assert.deepEqual(state.acks, []);
  assert.equal(liveTimers(), 0, 'no wake-up: only the renderer or focus can change anything');
  state.listening = true;
  notifier.refresh();
  assert.deepEqual(state.toasts.map((value) => value.id), ['cmn-1']);
  assert.deepEqual(state.acks, ['cmn-1']);

  state.listening = false;
  notifier.deliver(notice({ id: 'cmn-2' }));
  state.focused = false;
  notifier.refresh();
  assert.deepEqual(state.handled.at(-1), ['cmn-2', { kind: 'defer', ack: false }]);
  assert.deepEqual(state.acks, ['cmn-1'], 'deferred: the backend replays it on the next connection');
  assert.equal(state.background, 1);
  state.focused = true;
  state.listening = true;
  notifier.refresh();
  assert.equal(state.toasts.length, 1, 'a deferred notice no longer waits here');
});

test('held notices are shown in the order they arrived, before a notice that arrives after them', () => {
  const { host, state } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice({ id: 'cmn-1' }));
  notifier.deliver(notice({ id: 'cmn-2' }));
  // The renderer listens, and a notice arrives before main has refreshed.
  state.listening = true;
  assert.deepEqual(notifier.deliver(notice({ id: 'cmn-3' })), { kind: 'toast', ack: true });
  assert.deepEqual(state.toasts.map((value) => value.id), ['cmn-1', 'cmn-2', 'cmn-3']);
  assert.deepEqual(state.acks, ['cmn-1', 'cmn-2', 'cmn-3']);
});

test('a held notice that went stale while it waited is skipped and acknowledged', () => {
  const { host, state } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice({ expiresAt: NOW + 5_000 }));
  state.now += 5_000;
  state.listening = true;
  notifier.refresh();
  assert.equal(state.toasts.length + state.banners.length, 0);
  assert.deepEqual(state.acks, ['cmn-1']);
  assert.deepEqual(state.handled.at(-1), ['cmn-1', { kind: 'skip', ack: true, reason: 'expired' }]);
});

test('when the feed connects, held notices are dropped unacknowledged and their replay is shown, not taken for a duplicate', () => {
  const { host, state, advance, liveTimers } = fakeElectron({ focused: true, listening: false });
  const notifier = new companion.CompanionNotifier(host);
  notifier.deliver(notice());
  notifier.dropHeld();
  assert.equal(liveTimers(), 0);
  advance(HOLD_MS);
  state.listening = true;
  notifier.refresh();
  assert.equal(state.toasts.length + state.banners.length, 0, 'a dropped notice is not shown');
  assert.deepEqual(state.acks, []);
  // The backend replays it on the new connection.
  assert.deepEqual(notifier.deliver(notice()), { kind: 'toast', ack: true });
  assert.deepEqual(state.acks, ['cmn-1']);
});

// ── Renderers: who listens, and the click waiting for a window ───────────────

test('renderers: preload reports set and clear what each window listens for; malformed ones are ignored', () => {
  const sent = [];
  const renderers = new companion.CompanionRenderers((windowId, target) => sent.push([windowId, target]));
  assert.equal(renderers.listens(1, 'notice'), false);
  assert.equal(renderers.report(1, 'notice', true), true);
  assert.equal(renderers.report(1, 'notice', true), false, 'no change');
  assert.equal(renderers.listens(1, 'notice'), true);
  assert.equal(renderers.listens(1, 'open'), false);
  assert.equal(renderers.listens(2, 'notice'), false, 'per window');
  for (const [kind, listening] of [['toast', true], ['notice', 'yes'], [null, true], ['open', 1], ['notice', undefined]]) {
    assert.equal(renderers.report(1, kind, listening), false, JSON.stringify([kind, listening]));
  }
  assert.equal(renderers.listens(1, 'notice'), true);
  assert.equal(renderers.report(1, 'notice', false), true);
  assert.equal(renderers.listens(1, 'notice'), false);
  // A document that goes away (navigation, crash) listens to nothing.
  renderers.report(1, 'notice', true);
  renderers.report(1, 'open', true);
  assert.equal(renderers.documentGone(1), true);
  assert.equal(renderers.documentGone(1), false);
  assert.equal(renderers.listens(1, 'notice') || renderers.listens(1, 'open'), false);
  assert.deepEqual(sent, []);
});

test('renderers: a notification click waits until the window listens for clicks; a later click replaces it', () => {
  const sent = [];
  const renderers = new companion.CompanionRenderers((windowId, target) => sent.push([windowId, target]));
  renderers.report(7, 'open', true);
  renderers.open(7, TODAY);
  assert.deepEqual(sent, [[7, TODAY]], 'a renderer that listens gets it at once');
  sent.length = 0;
  renderers.open(8, TODAY);
  renderers.open(8, CONVERSATION);
  renderers.report(8, 'notice', true);
  assert.deepEqual(sent, [], 'listening for notices is not listening for clicks');
  renderers.report(8, 'open', true);
  assert.deepEqual(sent, [[8, CONVERSATION]]);
  renderers.report(8, 'open', false);
  renderers.report(8, 'open', true);
  assert.equal(sent.length, 1, 'delivered once');
});

test('renderers: a waiting click goes to the window\'s next document, and is dropped when the window closes', () => {
  const sent = [];
  const renderers = new companion.CompanionRenderers((windowId, target) => sent.push([windowId, target]));
  renderers.open(3, CHAT);
  renderers.documentGone(3);
  renderers.report(3, 'open', true);
  assert.deepEqual(sent, [[3, CHAT]]);
  renderers.open(4, CHAT);
  renderers.forget(4);
  renderers.report(4, 'open', true);
  assert.deepEqual(sent, [[3, CHAT]]);
});

// ── As main wires them together ──────────────────────────────────────────────

/** main.ts: the focused window is shown toasts once its preload reports that it listens; clicks go through the renderers. */
function wired({ focused }) {
  const electron = fakeElectron({ focused });
  const WINDOW = 11;
  const toasts = [];
  const clicks = [];
  const renderers = new companion.CompanionRenderers((windowId, target) => clicks.push([windowId, target]));
  const notifier = new companion.CompanionNotifier({
    ...electron.host,
    focusedWindow: () => (electron.state.focused
      ? { listening: renderers.listens(WINDOW, 'notice'), showNotice: (value) => toasts.push(value.id) }
      : null),
    open: (target) => {
      electron.state.focused = true;
      renderers.open(WINDOW, target);
    },
  });
  const report = (kind, listening) => { if (renderers.report(WINDOW, kind, listening)) notifier.refresh(); };
  const documentGone = () => { if (renderers.documentGone(WINDOW)) notifier.refresh(); };
  return { ...electron, WINDOW, toasts, clicks, notifier, report, documentGone };
}

test('as wired in main: the backlog replayed at launch waits for the focused window\'s renderer and becomes its toast', () => {
  const { state, toasts, notifier, report, documentGone } = wired({ focused: true });
  // The feed connects once the window has loaded; the workspace has not, so nothing listens.
  notifier.dropHeld();
  const fold = notice({ id: 'cmn-fold', body: 'While you were away: 3 updates', itemIds: ['cmi-1', 'cmi-2', 'cmi-3'] });
  assert.deepEqual(notifier.deliver(fold), HOLD);
  assert.deepEqual(toasts, []);
  assert.deepEqual(state.acks, []);
  // About 2 s later the workspace has loaded and CompanionNotifications subscribes.
  state.now += 2_000;
  report('open', true);
  report('notice', true);
  assert.deepEqual(toasts, ['cmn-fold']);
  assert.deepEqual(state.acks, ['cmn-fold']);
  // A reload: the next document listens only once it has loaded again.
  documentGone();
  notifier.deliver(notice({ id: 'cmn-2' }));
  assert.deepEqual(toasts, ['cmn-fold']);
  report('notice', true);
  assert.deepEqual(toasts, ['cmn-fold', 'cmn-2']);
  assert.deepEqual(state.acks, ['cmn-fold', 'cmn-2']);
});

test('as wired in main: a banner clicked while its window is still loading opens the Companion once the renderer listens', () => {
  const { state, WINDOW, clicks, notifier, report } = wired({ focused: false });
  notifier.deliver(notice({ target: CONVERSATION, itemIds: ['cmi-2'] }));
  state.banners[0].listeners.click();
  assert.deepEqual(clicks, []);
  report('open', true);
  assert.deepEqual(clicks, [[WINDOW, CONVERSATION]]);
});

// ── Feed (loopback test server) ──────────────────────────────────────────────

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitFor(predicate, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Records acknowledgements; answers 204 like the backend. */
function ackRecorder() {
  const acks = [];
  const handle = (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      acks.push({ path: req.url, body, contentType: req.headers['content-type'] });
      res.writeHead(204);
      res.end();
    });
  };
  return { acks, handle };
}

function openStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(': connected\n\n');
}

test('the feed reads companion_notice frames, skips everything else, reconnects, replays and acknowledges', async () => {
  const { acks, handle } = ackRecorder();
  const requests = [];
  let connections = 0;
  await withServer((req, res) => {
    if (req.method === 'POST') return handle(req, res);
    requests.push({ path: req.url, accept: req.headers.accept });
    connections += 1;
    openStream(res);
    if (connections === 1) {
      res.write(frame('scheduled_job_run', { runId: 'r' }));
      res.write(frame('companion_notice', '{oops'));
      res.write(frame('companion_notice', { ...notice(), id: '' }));
      // One notice split across writes, with CRLF line ends.
      const split = frame('companion_notice', notice()).replace(/\n/g, '\r\n');
      res.write(split.slice(0, 25));
      setTimeout(() => res.write(split.slice(25)), 5);
      // Drop the connection to exercise the reconnect.
      setTimeout(() => res.destroy(), 40);
    } else {
      res.write(frame('companion_notice', notice({ id: 'cmn-2' })));
    }
  }, async (port) => {
    const seen = [];
    const feed = new companion.CompanionNotificationFeed({
      port: () => port,
      onNotice: (value) => {
        seen.push(value.id);
        feed.acknowledge(value.id);
      },
      reconnectBaseMs: 10,
    });
    try {
      feed.start();
      await waitFor(() => seen.length >= 2 && acks.length >= 2, 'two notices and their acknowledgements');
      assert.deepEqual(seen, ['cmn-1', 'cmn-2']);
      assert.ok(connections >= 2);
      assert.deepEqual(requests[0], { path: STREAM, accept: 'text/event-stream' });
      assert.deepEqual(
        acks.map((ack) => ack.path).sort(),
        ['/api/companion/notifications/cmn-1/ack', '/api/companion/notifications/cmn-2/ack'],
      );
      for (const ack of acks) {
        assert.equal(ack.body, '{}');
        assert.equal(ack.contentType, 'application/json');
      }
    } finally {
      feed.stop();
    }
  });
});

test('the feed reports each connection before the notices replayed on it', async () => {
  let connections = 0;
  await withServer((_req, res) => {
    connections += 1;
    openStream(res);
    res.write(frame('companion_notice', notice({ id: `cmn-${connections}` })));
    // The first connection ends after its notice, so the feed reconnects.
    if (connections === 1) res.end();
  }, async (port) => {
    const events = [];
    const feed = new companion.CompanionNotificationFeed({
      port: () => port,
      onConnected: () => events.push('connected'),
      onNotice: (value) => events.push(value.id),
      reconnectBaseMs: 10,
    });
    try {
      feed.start();
      await waitFor(() => events.length >= 4, 'two connections and their notices');
      assert.deepEqual(events.slice(0, 4), ['connected', 'cmn-1', 'connected', 'cmn-2']);
    } finally {
      feed.stop();
    }
  });
});

test('a backend that refuses the stream is retried slowly and logged once per status', async () => {
  let connections = 0;
  await withServer((req, res) => {
    connections += 1;
    if (connections <= 2) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    } else if (connections === 3) {
      // A 200 that is not an event stream is no feed either.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else {
      openStream(res);
      res.write(frame('companion_notice', notice()));
    }
  }, async (port) => {
    const seen = [];
    const logs = [];
    let connected = 0;
    const feed = new companion.CompanionNotificationFeed({
      port: () => port,
      onNotice: (value) => seen.push(value.id),
      onConnected: () => { connected += 1; },
      log: (level, message, meta) => logs.push({ level, message, meta }),
      // A refusal must use refusedRetryMs, not the (here very slow) backoff.
      reconnectBaseMs: 60_000,
      refusedRetryMs: 20,
    });
    try {
      feed.start();
      await waitFor(() => seen.length === 1, 'the notice after the refusals');
      assert.equal(connections, 4);
      assert.equal(connected, 1, 'a refused stream is no connection');
      const refusals = logs.filter((entry) => entry.message === 'companion notification feed refused');
      assert.deepEqual(refusals.map((entry) => [entry.level, entry.meta.status]), [['WARN', 404], ['WARN', 200]]);
      assert.equal(logs.filter((entry) => entry.message === 'companion notification feed connected').length, 1);
    } finally {
      feed.stop();
    }
  });
});

test('a silent connection is treated as dead and replaced', async () => {
  let connections = 0;
  await withServer((_req, res) => {
    connections += 1;
    openStream(res);
    // The first connection never says anything again (no keepalive).
    if (connections > 1) res.write(frame('companion_notice', notice()));
  }, async (port) => {
    const seen = [];
    const feed = new companion.CompanionNotificationFeed({
      port: () => port,
      onNotice: (value) => seen.push(value.id),
      reconnectBaseMs: 10,
      idleTimeoutMs: 100,
    });
    try {
      feed.start();
      await waitFor(() => seen.length === 1, 'the notice on the second connection');
      assert.ok(connections >= 2, 'the silent first connection was replaced');
    } finally {
      feed.stop();
    }
  });
});

test('a failed delivery is logged without dropping the stream', async () => {
  await withServer((_req, res) => {
    openStream(res);
    res.write(frame('companion_notice', notice({ id: 'cmn-bad' })));
    res.write(frame('companion_notice', notice({ id: 'cmn-good' })));
  }, async (port) => {
    const seen = [];
    const logs = [];
    const feed = new companion.CompanionNotificationFeed({
      port: () => port,
      onNotice: (value) => {
        if (value.id === 'cmn-bad') throw new Error('Notification failed');
        seen.push(value.id);
      },
      log: (level, message, meta) => logs.push({ level, message, meta }),
    });
    try {
      feed.start();
      await waitFor(() => seen.length === 1, 'the second notice');
      assert.deepEqual(seen, ['cmn-good']);
      assert.deepEqual(
        logs.filter((entry) => entry.level === 'WARN').map((entry) => [entry.message, entry.meta.error]),
        [['companion notice delivery failed', 'Notification failed']],
      );
    } finally {
      feed.stop();
    }
  });
});

test('the feed waits for a backend port, and stop() and restart() control the connection', async () => {
  let connections = 0;
  await withServer((_req, res) => {
    connections += 1;
    openStream(res);
  }, async (port) => {
    let available = null;
    const feed = new companion.CompanionNotificationFeed({ port: () => available, onNotice: () => {}, reconnectBaseMs: 10, reconnectMaxMs: 20 });
    try {
      feed.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(connections, 0, 'no port, no connection');
      available = port;
      await waitFor(() => connections === 1, 'the first connection');
      feed.restart();
      await waitFor(() => connections === 2, 'the restarted connection');
      feed.stop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(connections, 2, 'a stopped feed does not reconnect');
    } finally {
      feed.stop();
    }
  });
});

test('feed and notifier together: a stale notice is dropped, a fresh one becomes a banner that opens its target', async () => {
  const { acks, handle } = ackRecorder();
  await withServer((req, res) => {
    if (req.method === 'POST') return handle(req, res);
    openStream(res);
    res.write(frame('companion_notice', notice({ id: 'cmn-stale', expiresAt: Date.now() - 1 })));
    res.write(frame('companion_notice', notice({ id: 'cmn-fresh', expiresAt: Date.now() + 60_000, target: CONVERSATION })));
  }, async (port) => {
    const { host, state } = fakeElectron({ focused: false });
    let feed;
    const notifier = new companion.CompanionNotifier({ ...host, now: () => Date.now(), acknowledge: (id) => feed.acknowledge(id) });
    feed = new companion.CompanionNotificationFeed({ port: () => port, onNotice: (value) => notifier.deliver(value), onConnected: () => notifier.dropHeld() });
    try {
      feed.start();
      await waitFor(() => acks.length === 2, 'both acknowledgements');
      assert.deepEqual(
        acks.map((ack) => ack.path).sort(),
        ['/api/companion/notifications/cmn-fresh/ack', '/api/companion/notifications/cmn-stale/ack'],
      );
      assert.equal(state.banners.length, 1, 'only the fresh notice is shown');
      state.banners[0].listeners.click();
      assert.deepEqual(state.opened, [CONVERSATION]);
    } finally {
      feed.stop();
    }
  });
});
