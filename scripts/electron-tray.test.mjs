import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The menu-bar / notification-area icon (DESIGN-v2 §5.1). Reads the tsc
// output; run `npm run electron:build-main` first. No Electron process,
// window, tray icon or user file is involved: the pure models take plain
// values, and the controller and the feed talk to a throwaway loopback server
// that stands in for the backend's GET /api/companion/tray and the notifier
// feed's `companion_changed` frames (W3-H serves the real ones). The shared
// contract itself (its tsc output, which `test:contracts` builds first) is
// read where the mirrors must agree with it: the paths, the status lines of
// companionStatusLine, the notice gate and the change frame.
const require = createRequire(import.meta.url);
const tray = require('../electron/dist/tray.js');
const desktop = require('../electron/dist/desktopSettings.js');
const companion = require('../electron/dist/attentionNotifications.js');
const sharedCompanion = require('../shared/dist/companion.js');
const sharedAttention = require('../shared/dist/attention.js');
const sharedStatus = require('../shared/dist/companionStatus.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const CHAT = { kind: 'companion', tab: 'chat' };
const TODAY = { kind: 'companion', tab: 'today' };
const SETTINGS = { kind: 'settings' };

/**
 * CompanionTrayDto as the backend sends it (shared/src/companion.ts,
 * delivery.ts companionTrayDto): `welcomeWanted` is the welcome the tray
 * reads (W0b recheck D-1, DESIGN-v2 §8.1 "D2 → H"); the deprecated
 * `welcomeDone` is gone from the contract.
 */
function dto(overrides = {}) {
  return {
    displayName: 'Robin',
    enabled: true,
    paused: false,
    welcomeWanted: false,
    conversationWaiting: false,
    statusLine: { text: 'Watching · checked 2m ago', tone: 'ok' },
    badge: 0,
    needsYou: [],
    needsYouTotal: 0,
    briefReady: false,
    revision: 7,
    ...overrides,
  };
}

/** The DTO as an older backend sent it: with the legacy `welcomeDone`, always `!welcomeWanted`. */
const withLegacyWelcomeDone = (value) => ({ ...value, welcomeDone: !value.welcomeWanted });

const needs = (n) => Array.from({ length: n }, (_, i) => ({
  id: `cmi-${i + 1}`,
  title: `CR-${i + 1} has 2 unresolved comments`,
  isNew: i % 2 === 0,
  target: { kind: 'companion', tab: 'today', itemId: `cmi-${i + 1}` },
}));

const ready = (overrides) => ({ kind: 'ready', dto: tray.parseCompanionTrayDto(dto(overrides)) });
const labels = (menu) => menu.map((entry) => (entry.type === 'separator' ? '—' : entry.label));
const entry = (menu, label) => menu.find((e) => e.type === 'item' && e.label === label);

// ── How Michi starts ─────────────────────────────────────────────────────────

test('startup: a background launch is hidden; a Windows login launch starts in the notification area; everything else opens a window', () => {
  const base = { argv: ['michi'], wasOpenedAtLogin: false, trayEnabled: true };
  for (const platform of ['darwin', 'win32']) {
    assert.equal(tray.startupMode({ ...base, platform }), 'window');
    assert.equal(tray.startupMode({ ...base, platform, argv: ['michi', tray.BACKGROUND_LAUNCH_ARG] }), 'background');
    // A background wake stays hidden whatever else is true.
    assert.equal(tray.startupMode({ ...base, platform, trayEnabled: false, argv: ['michi', tray.BACKGROUND_LAUNCH_ARG, tray.LOGIN_LAUNCH_ARG] }), 'background');
  }
  assert.equal(tray.startupMode({ ...base, platform: 'win32', argv: ['michi.exe', tray.LOGIN_LAUNCH_ARG] }), 'tray');
  assert.equal(tray.startupMode({ ...base, platform: 'win32', wasOpenedAtLogin: true }), 'tray');
  // With the icon off nothing would show Michi runs: a window.
  assert.equal(tray.startupMode({ ...base, platform: 'win32', trayEnabled: false, argv: ['michi.exe', tray.LOGIN_LAUNCH_ARG] }), 'window');
  // macOS offers no login launch (DESIGN-v2 §5.1, Q3): a Login Items entry opens a window as before.
  assert.equal(tray.startupMode({ ...base, platform: 'darwin', wasOpenedAtLogin: true }), 'window');
  assert.equal(tray.startupMode({ ...base, platform: 'darwin', argv: ['michi', tray.LOGIN_LAUNCH_ARG] }), 'window');
  assert.equal(tray.BACKGROUND_LAUNCH_ARG, '--michi-background-launch', 'the backend app launcher passes this one');
  assert.equal(tray.LOGIN_LAUNCH_ARG, '--michi-login-launch');
});

test('closing the last window: with the icon up Michi keeps running on both platforms; without it, as before v2', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(
      tray.windowAllClosedAction({ platform, trayShown: true, hideDockWhenNoWindows: false, hintShown: false }),
      { quit: false, hideDock: false, showHint: true },
      `${platform}: the first time, a note says it is still running`,
    );
    assert.deepEqual(
      tray.windowAllClosedAction({ platform, trayShown: true, hideDockWhenNoWindows: false, hintShown: true }),
      { quit: false, hideDock: false, showHint: false },
      `${platform}: only once`,
    );
  }
  // The Dock icon goes only when asked (default off), only on macOS, only while the icon is up.
  assert.equal(tray.windowAllClosedAction({ platform: 'darwin', trayShown: true, hideDockWhenNoWindows: true, hintShown: true }).hideDock, true);
  assert.equal(tray.windowAllClosedAction({ platform: 'win32', trayShown: true, hideDockWhenNoWindows: true, hintShown: true }).hideDock, false);
  assert.deepEqual(
    tray.windowAllClosedAction({ platform: 'darwin', trayShown: false, hideDockWhenNoWindows: true, hintShown: false }),
    { quit: false, hideDock: false, showHint: false },
  );
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(
      tray.windowAllClosedAction({ platform, trayShown: false, hideDockWhenNoWindows: false, hintShown: false }),
      { quit: true, hideDock: false, showHint: false },
    );
  }
});

test('startup: a login launch whose icon did not come up opens a window instead, as before v2', () => {
  assert.equal(tray.startupModeAfterTray('tray', true), 'tray');
  assert.equal(tray.startupModeAfterTray('tray', false), 'window', 'nothing else would show that Michi runs');
  for (const shown of [true, false]) {
    assert.equal(tray.startupModeAfterTray('window', shown), 'window');
    assert.equal(tray.startupModeAfterTray('background', shown), 'background', 'a background wake shows no icon by design');
  }
});

test('relaunch: the new instance keeps this one\'s arguments but not the login or background flag, so it opens its window', () => {
  assert.deepEqual(tray.relaunchArgs(['C:\\Michi\\michi.exe', tray.LOGIN_LAUNCH_ARG]), []);
  assert.deepEqual(tray.relaunchArgs(['/Applications/michi.app/Contents/MacOS/michi', tray.BACKGROUND_LAUNCH_ARG, '--inspect=0']), ['--inspect=0']);
  // `electron .` in dev: everything after the executable, as Electron's own relaunch would pass it.
  assert.deepEqual(tray.relaunchArgs(['/x/electron', '.', '--remote-debugging-port=9222']), ['.', '--remote-debugging-port=9222']);
  assert.deepEqual(tray.relaunchArgs(['/x/electron']), []);
});

test('the one-time note names where Michi still runs', () => {
  assert.deepEqual(tray.stillRunningHint('darwin'), { title: 'Michi', body: 'Michi is still running in the menu bar.' });
  assert.deepEqual(tray.stillRunningHint('win32'), { title: 'Michi', body: 'Michi is still running in the notification area.' });
});

test('clicks: macOS pops the menu up on either button; Windows opens Michi on a left click and the menu on a right one', () => {
  assert.equal(tray.trayClickBehavior('darwin', 'click'), 'menu');
  assert.equal(tray.trayClickBehavior('darwin', 'right-click'), 'menu');
  assert.equal(tray.trayClickBehavior('darwin', 'double-click'), 'none');
  assert.equal(tray.trayClickBehavior('win32', 'click'), 'open-michi');
  assert.equal(tray.trayClickBehavior('win32', 'double-click'), 'open-michi');
  assert.equal(tray.trayClickBehavior('win32', 'right-click'), 'menu');
});

test('the icon keeps its place: a fixed GUID on macOS, and on Windows only in the installed app', () => {
  const guid = tray.trayGuid('darwin', false);
  assert.match(guid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(tray.trayGuid('darwin', true), guid);
  assert.equal(tray.trayGuid('win32', true), guid);
  assert.equal(tray.trayGuid('win32', false), undefined, 'Windows binds it to the exe path: dev and installed builds must not share it');
  assert.equal(tray.trayGuid('linux', true), undefined);
});

// ── The data ─────────────────────────────────────────────────────────────────

test('the DTO is rebuilt from its known fields; the welcome is read from welcomeWanted, never welcomeDone', () => {
  const parsed = tray.parseCompanionTrayDto({ ...dto({ needsYou: needs(2), needsYouTotal: 2, badge: 1 }), extra: true });
  assert.deepEqual(parsed, {
    displayName: 'Robin', enabled: true, paused: false, welcomeWanted: false, conversationWaiting: false,
    statusLine: { text: 'Watching · checked 2m ago', tone: 'ok' }, badge: 1, needsYou: needs(2), needsYouTotal: 2,
    briefReady: false, revision: 7,
  });
  assert.equal('welcomeDone' in parsed, false);
  // Even when the deprecated field disagrees (it never should), welcomeWanted decides.
  assert.equal(tray.parseCompanionTrayDto({ ...dto(), welcomeWanted: true, welcomeDone: true }).welcomeWanted, true);
  assert.equal(tray.parseCompanionTrayDto({ ...dto(), welcomeWanted: false, welcomeDone: false }).welcomeWanted, false);
  const { welcomeWanted: _w, ...withoutWanted } = dto();
  assert.equal(tray.parseCompanionTrayDto({ ...withoutWanted, welcomeDone: false }).welcomeWanted, false, 'welcomeDone alone asks for nothing');
});

test('an extra legacy welcomeDone (an older backend\'s) is ignored: the DTO reads as the one the backend sends now', () => {
  for (const welcomeWanted of [true, false]) {
    const current = dto({ welcomeWanted, needsYou: needs(1), needsYouTotal: 1 });
    assert.equal('welcomeDone' in current, false);
    const legacy = withLegacyWelcomeDone(current);
    assert.equal(legacy.welcomeDone, !welcomeWanted);
    assert.deepEqual(tray.parseCompanionTrayDto(legacy), tray.parseCompanionTrayDto(current));
    assert.equal(tray.parseCompanionTrayDto(current).welcomeWanted, welcomeWanted);
    assert.deepEqual(
      tray.trayMenuModel({ kind: 'ready', dto: tray.parseCompanionTrayDto(legacy) }, { platform: 'darwin' }),
      tray.trayMenuModel({ kind: 'ready', dto: tray.parseCompanionTrayDto(current) }, { platform: 'darwin' }),
    );
  }
  const shared = read('shared/src/companion.ts');
  const from = shared.indexOf('export interface CompanionTrayDto');
  const trayDto = shared.slice(from, shared.indexOf('\n}\n', from));
  assert.match(trayDto, /^\s*welcomeWanted: boolean;$/m, 'the shared DTO is where the welcome is read');
  assert.doesNotMatch(trayDto, /^\s*welcomeDone\??:/m, 'and has no welcomeDone field any more');
});

// ── The shared contract the mirrors follow (shared/dist) ─────────────────────

test('contract: the tray and the desktop feed call the shared paths under /api, never the windows\' events stream', () => {
  assert.equal(tray.TRAY_DATA_PATH, `/api${sharedCompanion.COMPANION_TRAY_PATH}`);
  assert.equal(companion.ATTENTION_DESKTOP_STREAM_PATH, `/api${sharedAttention.ATTENTION_DESKTOP_STREAM_PATH}`);
  assert.notEqual(companion.ATTENTION_DESKTOP_STREAM_PATH, `/api${sharedCompanion.COMPANION_EVENTS_PATH}`);
});

test('contract: the backend names the desktop feed\'s change frames as the feed reads them', () => {
  const delivery = read('backend/src/services/companion/delivery.ts');
  assert.match(delivery, new RegExp(`export const COMPANION_CHANGED_SSE_EVENT = '${companion.COMPANION_CHANGED_EVENT}';`));
  // Every reason of the shared CompanionChangedEvent (read from its source) is a frame the shared guard and the feed take, with the same fields.
  const shared = read('shared/src/companion.ts');
  const union = /export interface CompanionChangedEvent \{[^}]*?reason:([^;]+);/.exec(shared);
  assert.ok(union, 'the shared change frame names its reasons');
  const reasons = [...union[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(reasons.length >= 12 && reasons.includes('conversation') && reasons.includes('rules'), reasons.join(', '));
  for (const reason of reasons) {
    const event = { type: 'companion_changed', revision: 12, reason };
    assert.equal(sharedCompanion.isCompanionChangedEvent(event), true);
    assert.deepEqual(companion.parseCompanionChangedFrame(event), event);
  }
});

/** A CompanionStatusLineInput (a snapshot's settings, status and activity) for shared companionStatusLine. */
function statusInput({ settings = {}, status = {}, activity } = {}) {
  return {
    settings: { enabled: true, paused: false, quietHours: { start: '22:00', end: '08:00' }, dailyTurnBudget: 30, ...settings },
    status: { state: 'ok', working: false, auth: { valid: true, expiresAt: null, checkedAt: null }, turnsToday: 0, lastCheckAt: null, ...status },
    ...(activity ? { activity } : {}),
  };
}

test('contract: every status line shared companionStatusLine gives reaches the menu as the panel shows it; warnings open Settings', () => {
  const now = 1_800_000_000_000;
  const cases = [
    [statusInput({ status: { state: 'off' } }), 'Off', 'off'],
    [statusInput({ settings: { paused: true } }), 'Off', 'off'],
    [statusInput({ status: { working: true }, activity: [{ kind: 'welcome', outcome: 'running' }] }), 'Saying hello…', 'working'],
    [statusInput({ status: { working: true }, activity: [{ kind: 'wake', outcome: 'running' }] }), 'Checking in…', 'working'],
    [statusInput({ status: { working: true, firstLook: true } }), 'Taking a first look…', 'working'],
    [statusInput({ status: { working: true } }), 'Working…', 'working'],
    [statusInput({ status: { state: 'quiet_hours' } }), 'Quiet hours until 08:00', 'quiet'],
    [statusInput({ status: { auth: { valid: false, expiresAt: null, checkedAt: null } } }), 'Auth expired — refresh your credentials', 'warn'],
    [statusInput({ status: { lastCheckAt: now - 120_000 } }), 'Watching · checked 2m ago', 'ok'],
    [statusInput({ status: { state: 'degraded' } }), 'Watching · not checked yet', 'warn'],
  ];
  for (const [input, text, tone] of cases) {
    const line = sharedStatus.companionStatusLine(input, now);
    assert.deepEqual([line.text, line.tone], [text, tone], text);
    const enabled = input.settings.enabled;
    const parsed = tray.parseCompanionTrayDto(dto({ enabled, paused: input.settings.paused, statusLine: line }));
    assert.ok(parsed, `the tray takes "${text}"`);
    assert.deepEqual(parsed.statusLine, { text, tone }, 'the panel\'s Stop (stoppable) stays out of the tray');
    const row = tray.trayMenuModel({ kind: 'ready', dto: parsed }, { platform: 'darwin' })[0];
    assert.equal(row.label, `Robin · ${text}`);
    assert.deepEqual(row.action, tone === 'warn' ? { kind: 'open', target: SETTINGS } : null, text);
  }
  // The one line with a Stop in the panel.
  assert.equal(sharedStatus.companionStatusLine(cases[3][0], now).stoppable, true);
});

test('the DTO: a malformed core is refused; the rest falls back so the menu still works', () => {
  for (const bad of [
    null, [], 'tray', dto({ displayName: 3 }), dto({ enabled: 'yes' }), dto({ paused: null }), dto({ statusLine: null }),
    dto({ statusLine: { text: 'x', tone: 'loud' } }), dto({ statusLine: { tone: 'ok' } }), dto({ badge: -1 }), dto({ badge: 1.5 }),
    dto({ revision: Number.NaN }), dto({ revision: '7' }),
  ]) {
    assert.equal(tray.parseCompanionTrayDto(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  const loose = tray.parseCompanionTrayDto(dto({
    displayName: '  ', conversationWaiting: 'yes', briefReady: 1, needsYouTotal: 'many',
    needsYou: [
      ...needs(3),
      null, { id: '', title: 'x' }, { id: 'cmi-x', title: 7 }, { id: 'cmi-y', title: '   ' },
      // A target this app cannot place: Today, at the item.
      { id: 'cmi-z', title: 'Odd', isNew: 'yes', target: { kind: 'spaces' } },
      ...needs(4).slice(3),
    ],
  }));
  assert.equal(loose.displayName, 'Michi', 'the default name (DESIGN-v2 Q4)');
  assert.equal(loose.conversationWaiting, false);
  assert.equal(loose.briefReady, false);
  assert.equal(loose.needsYou.length, tray.TRAY_MAX_NEEDS_YOU);
  assert.equal(tray.TRAY_MAX_NEEDS_YOU, 5);
  assert.deepEqual(loose.needsYou[3], { id: 'cmi-z', title: 'Odd', isNew: false, target: { kind: 'companion', tab: 'today', itemId: 'cmi-z' } });
  assert.equal(loose.needsYouTotal, 5, 'never fewer than the rows shown');
});

test('the DTO: titles, the name and the status are one clipped line each', () => {
  const parsed = tray.parseCompanionTrayDto(dto({
    displayName: `Ro\nbin${'n'.repeat(60)}`,
    statusLine: { text: 'Watching now', tone: 'ok' },
    needsYou: [{ id: 'cmi-1', title: `Line one\r\nline\ttwo ${'x'.repeat(120)}`, isNew: true, target: TODAY }],
  }));
  assert.equal(parsed.displayName.length, 40);
  assert.ok(parsed.displayName.startsWith('Ro bin') && parsed.displayName.endsWith('…'));
  assert.equal(parsed.statusLine.text, 'Watching now');
  assert.ok(parsed.needsYou[0].title.startsWith('Line one line two x'));
  assert.equal(parsed.needsYou[0].title.length, 80);
});

// ── The menu ─────────────────────────────────────────────────────────────────

test('menu: the full menu, top to bottom, named by the display name, with no shortcut marks', () => {
  const menu = tray.trayMenuModel(ready({ needsYou: needs(2), needsYouTotal: 9, badge: 2, briefReady: true }), { platform: 'darwin' });
  assert.deepEqual(labels(menu), [
    'Robin · Watching · checked 2m ago',
    'Needs you',
    '● CR-1 has 2 unresolved comments',
    '○ CR-2 has 2 unresolved comments',
    'View all in Today',
    "Today's brief",
    '—',
    'Chat with Robin',
    'Check now',
    'Turn Robin off',
    '—',
    'Open Michi',
    'Settings…',
    '—',
    'Quit Michi',
  ]);
  assert.ok(!labels(menu).some((label) => /⌘|Cmd|Ctrl/.test(label)), 'no ⌘J: it is a window shortcut, not a global one');
  // Neither the status row nor the heading is clickable.
  for (const label of ['Robin · Watching · checked 2m ago', 'Needs you']) {
    assert.deepEqual([entry(menu, label).enabled, entry(menu, label).action], [false, null], label);
  }
  assert.deepEqual(entry(menu, '● CR-1 has 2 unresolved comments').action, { kind: 'open', target: needs(1)[0].target });
  assert.deepEqual(entry(menu, 'View all in Today').action, { kind: 'open', target: TODAY });
  assert.deepEqual(entry(menu, "Today's brief").action, { kind: 'open', target: TODAY });
  assert.deepEqual(entry(menu, 'Chat with Robin').action, { kind: 'open', target: CHAT });
  assert.deepEqual(entry(menu, 'Check now').action, { kind: 'check-now' });
  assert.deepEqual(entry(menu, 'Turn Robin off').action, { kind: 'set-paused', paused: true });
  assert.deepEqual(entry(menu, 'Open Michi').action, { kind: 'open-michi' });
  assert.deepEqual(entry(menu, 'Settings…').action, { kind: 'open', target: SETTINGS });
  assert.deepEqual(entry(menu, 'Quit Michi').action, { kind: 'quit' });
});

test('menu: before the welcome the status row says hello; while the conversation waits it says so; both open the chat', () => {
  const hello = tray.trayMenuModel(ready({ welcomeWanted: true }), { platform: 'darwin' });
  assert.deepEqual(entry(hello, 'Say hello to Robin'), { type: 'item', label: 'Say hello to Robin', enabled: true, action: { kind: 'open', target: CHAT } });
  // The deprecated field alone never asks for a welcome (D-1).
  const doneOnly = tray.trayMenuModel({ kind: 'ready', dto: tray.parseCompanionTrayDto({ ...dto(), welcomeDone: false }) }, { platform: 'darwin' });
  assert.equal(labels(doneOnly)[0], 'Robin · Watching · checked 2m ago');
  const waiting = tray.trayMenuModel(ready({ conversationWaiting: true, welcomeWanted: true }), { platform: 'darwin' });
  assert.deepEqual(entry(waiting, 'Robin is waiting for you').action, { kind: 'open', target: CHAT });
  assert.equal(labels(waiting)[0], 'Robin is waiting for you');
  // Off (Q29), its panel does not open: the row only says it is off.
  const off = tray.trayMenuModel(ready({ paused: true, conversationWaiting: true, statusLine: { text: 'Off', tone: 'off' } }), { platform: 'darwin' });
  assert.deepEqual(off[0], { type: 'item', label: 'Robin · Off', enabled: false, action: null });
});

test('menu: off (Q29) offers only Turn <name> on: no Needs you, brief, Chat with or Check now', () => {
  const off = tray.trayMenuModel(ready({ paused: true, statusLine: { text: 'Off', tone: 'off' }, needsYou: needs(2), needsYouTotal: 2, briefReady: true, welcomeWanted: true }), { platform: 'darwin' });
  assert.deepEqual(labels(off), ['Robin · Off', '—', 'Turn Robin on', '—', 'Open Michi', 'Settings…', '—', 'Quit Michi']);
  assert.deepEqual(entry(off, 'Turn Robin on').action, { kind: 'set-paused', paused: false });

  // An older backend's own off switch is in its Settings.
  const older = tray.trayMenuModel(ready({ enabled: false, statusLine: { text: 'Off', tone: 'off' } }), { platform: 'darwin' });
  assert.deepEqual(labels(older), ['Robin · Off', '—', 'Turn Robin on…', '—', 'Open Michi', 'Settings…', '—', 'Quit Michi']);
  assert.deepEqual(entry(older, 'Turn Robin on…').action, { kind: 'open', target: SETTINGS });
});

test('menu: while the backend starts or does not answer, the status says so and Check now and Pause are disabled', () => {
  const starting = tray.trayMenuModel({ kind: 'loading' }, { platform: 'darwin' });
  assert.deepEqual(labels(starting), ['Michi is starting…', '—', 'Chat with Michi', 'Check now', 'Turn Michi off', '—', 'Open Michi', 'Settings…', '—', 'Quit Michi']);
  assert.equal(entry(starting, 'Check now').enabled, false);
  assert.equal(entry(starting, 'Turn Michi off').enabled, false);
  assert.equal(entry(starting, 'Chat with Michi').enabled, true);

  const away = tray.trayMenuModel({ kind: 'unreachable', displayName: 'Robin' }, { platform: 'darwin' });
  assert.equal(labels(away)[0], "Can't reach Michi's backend");
  assert.equal(entry(away, 'Chat with Robin').enabled, true, 'the last known name');
  assert.equal(entry(away, 'Check now').enabled, false);

  // A backend without the endpoint (404): only what needs no data.
  const older = tray.trayMenuModel({ kind: 'unsupported', displayName: 'Michi' }, { platform: 'darwin' });
  assert.deepEqual(labels(older), ['Chat with Michi', '—', 'Open Michi', 'Settings…', '—', 'Quit Michi']);
});

test('menu: a short-lived status replaces the status row', () => {
  const menu = tray.trayMenuModel(ready({ welcomeWanted: true }), { platform: 'darwin', transientStatus: 'Another Michi is checking' });
  assert.deepEqual(menu[0], { type: 'item', label: 'Another Michi is checking', enabled: false, action: null });
});

test('menu: a warning status row (Auth expired, a source degraded) opens Settings; the others stay plain (E-map §2.4)', () => {
  const auth = tray.trayMenuModel(ready({ statusLine: { text: 'Auth expired — refresh your credentials', tone: 'warn' } }), { platform: 'darwin' });
  assert.deepEqual(auth[0], { type: 'item', label: 'Robin · Auth expired — refresh your credentials', enabled: true, action: { kind: 'open', target: SETTINGS } });
  for (const tone of ['ok', 'working', 'quiet', 'off']) {
    const row = tray.trayMenuModel(ready({ statusLine: { text: 'Watching', tone } }), { platform: 'darwin' })[0];
    assert.deepEqual([row.label, row.enabled, row.action], ['Robin · Watching', false, null], tone);
  }
  // A short-lived status still takes its place, unclickable.
  const transient = tray.trayMenuModel(ready({ statusLine: { text: 'Auth expired — refresh your credentials', tone: 'warn' } }), { platform: 'darwin', transientStatus: 'Another Michi is checking' });
  assert.deepEqual(transient[0], { type: 'item', label: 'Another Michi is checking', enabled: false, action: null });
});

test('menu: "Say hello" only while the agent is on: the panel and the backend start no welcome otherwise', () => {
  assert.equal(labels(tray.trayMenuModel(ready({ welcomeWanted: true }), { platform: 'darwin' }))[0], 'Say hello to Robin');
  const off = tray.trayMenuModel(ready({ welcomeWanted: true, paused: true, statusLine: { text: 'Off', tone: 'off' } }), { platform: 'darwin' });
  assert.equal(labels(off)[0], 'Robin · Off');
  assert.ok(entry(off, 'Turn Robin on'), 'what the user can do instead');
});

test('menu: on Windows an ampersand in text from the backend shows as itself, not as a mnemonic', () => {
  const data = ready({ displayName: 'R&D', needsYou: [{ ...needs(1)[0], title: 'Q&A review' }], needsYouTotal: 1, statusLine: { text: 'A&B', tone: 'ok' } });
  const win = labels(tray.trayMenuModel(data, { platform: 'win32' }));
  assert.ok(win.includes('R&&D · A&&B') && win.includes('● Q&&A review') && win.includes('Chat with R&&D'), win.join(' | '));
  const mac = labels(tray.trayMenuModel(data, { platform: 'darwin' }));
  assert.ok(mac.includes('R&D · A&B') && mac.includes('● Q&A review'), mac.join(' | '));
});

test('menu template: Electron items whose click dispatches the action; rows without one are disabled', () => {
  const model = tray.trayMenuModel({ kind: 'loading' }, { platform: 'darwin' });
  const dispatched = [];
  const template = tray.trayMenuTemplate(model, (action) => dispatched.push(action));
  assert.equal(template.length, model.length);
  assert.deepEqual(template[0], { label: 'Michi is starting…', enabled: false });
  assert.deepEqual(template[1], { type: 'separator' });
  assert.deepEqual(template.find((t) => t.label === 'Check now'), { label: 'Check now', enabled: false });
  for (const item of template) if (item.click) item.click();
  assert.deepEqual(dispatched, [{ kind: 'open', target: CHAT }, { kind: 'open-michi' }, { kind: 'open', target: SETTINGS }, { kind: 'quit' }]);
});

// ── The icon ─────────────────────────────────────────────────────────────────

test('icon: the attention glyph while something waits; template PNGs on macOS, taskbar-themed .ico on Windows', () => {
  assert.equal(tray.trayIconState({ kind: 'loading' }), 'normal');
  assert.equal(tray.trayIconState({ kind: 'unreachable', displayName: 'Robin' }), 'normal');
  assert.equal(tray.trayIconState(ready()), 'normal');
  assert.equal(tray.trayIconState(ready({ badge: 1 })), 'attention');
  assert.equal(tray.trayIconState(ready({ conversationWaiting: true })), 'attention');
  assert.equal(tray.trayIconFile(ready(), 'darwin', true), 'trayTemplate.png');
  assert.equal(tray.trayIconFile(ready({ badge: 2 }), 'darwin', false), 'trayAttentionTemplate.png');
  assert.equal(tray.trayIconFile(ready(), 'win32', false), 'tray-light.ico');
  assert.equal(tray.trayIconFile(ready(), 'win32', true), 'tray-dark.ico');
  assert.equal(tray.trayIconFile(ready({ badge: 2 }), 'win32', false), 'tray-attention-light.ico');
  assert.equal(tray.trayIconFile(ready({ badge: 2 }), 'win32', true), 'tray-attention-dark.ico');
});

test('tooltip: Michi, plus what waits', () => {
  assert.equal(tray.trayTooltip({ kind: 'loading' }), 'Michi');
  assert.equal(tray.trayTooltip(ready()), 'Michi');
  assert.equal(tray.trayTooltip(ready({ badge: 2 })), 'Michi — 2 new');
  assert.equal(tray.trayTooltip(ready({ badge: 2, conversationWaiting: true })), 'Michi — Robin is waiting for you');
});

// ── The icon's lifecycle (TrayIconSlot; main hands it nativeImage and Tray) ───

/**
 * Stand-ins for nativeImage and Tray. `files` maps an icon file to the name
 * of its image; any other file loads as an empty image (missing from the
 * package), and `throws.png` throws. `refuse(guid)` makes the Tray throw.
 */
function fakeIcons({ refuse = () => false } = {}) {
  const files = { 'trayTemplate.png': 'glyph', 'trayAttentionTemplate.png': 'dot' };
  const loads = [];
  const built = [];
  const logs = [];
  class Image {
    constructor(name) { this.name = name; }
    isEmpty() { return this.name === null; }
  }
  class Icon {
    constructor(image, guid) {
      if (refuse(guid)) throw new Error(guid ? 'GUID bound to another executable' : 'no notification area');
      this.guid = guid;
      this.images = [image.name];
      this.destroyed = false;
      built.push(this);
    }
    setImage(image) { this.images.push(image.name); }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  const slot = new tray.TrayIconSlot({
    load: (file) => {
      loads.push(file);
      if (file === 'throws.png') throw new Error('bad path');
      return new Image(files[file] ?? null);
    },
    construct: (image, guid) => (guid ? new Icon(image, guid) : new Icon(image)),
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });
  return { slot, loads, built, logs };
}

test('icon lifecycle: an icon file missing from the package (an empty image), or one that does not load, puts up no icon, never a blank one', () => {
  for (const file of ['missing.png', 'throws.png']) {
    const { slot, built, logs } = fakeIcons();
    assert.equal(slot.show(file, 'guid-1', () => assert.fail('no setup without an icon')), null, file);
    assert.equal(slot.current, null);
    assert.equal(built.length, 0, `${file}: no Tray was made`);
    assert.deepEqual([logs[0].level, logs[0].meta.file], ['WARN', file]);
    // So closing the last window on Windows quits, as before v2, instead of leaving Michi with no visible way back.
    assert.equal(tray.windowAllClosedAction({ platform: 'win32', trayShown: slot.current !== null, hideDockWhenNoWindows: false, hintShown: false }).quit, true);
    assert.equal(tray.windowAllClosedAction({ platform: 'darwin', trayShown: slot.current !== null, hideDockWhenNoWindows: true, hintShown: false }).hideDock, false, 'and the Dock icon stays');
  }
});

test('icon lifecycle: a refused GUID is dropped; a Tray that cannot be made at all, or a setup that throws, leaves no icon and throws nothing', () => {
  const guidTaken = fakeIcons({ refuse: (guid) => guid !== undefined });
  const icon = guidTaken.slot.show('trayTemplate.png', 'guid-1');
  assert.ok(icon);
  assert.equal(icon.guid, undefined, 'kept, without its position');
  assert.equal(guidTaken.slot.current, icon);
  assert.match(guidTaken.logs[0].message, /position/);

  const refused = fakeIcons({ refuse: () => true });
  assert.equal(refused.slot.show('trayTemplate.png', 'guid-1'), null);
  assert.equal(refused.slot.show('trayTemplate.png', undefined), null);
  assert.equal(refused.slot.current, null);
  assert.equal(refused.logs.at(-1).level, 'WARN');

  const broken = fakeIcons();
  assert.equal(broken.slot.show('trayTemplate.png', undefined, () => { throw new Error('a listener'); }), null);
  assert.equal(broken.slot.current, null);
  assert.equal(broken.built[0].destroyed, true, 'the half-made icon is taken down');
});

test('icon lifecycle: a change of file never blanks the icon; each file loads once; taking it down always leaves none', () => {
  const { slot, loads, built } = fakeIcons();
  const icon = slot.show('trayTemplate.png', undefined);
  assert.equal(slot.show('trayAttentionTemplate.png', undefined), icon, 'one icon at a time');
  for (const file of ['trayAttentionTemplate.png', 'trayAttentionTemplate.png', 'missing.png', 'throws.png', 'trayTemplate.png', 'missing.png']) slot.setFile(file);
  assert.deepEqual(icon.images, ['glyph', 'dot', 'glyph'], 'a file that cannot be shown leaves the image as it is');
  assert.deepEqual([...loads].sort(), ['missing.png', 'throws.png', 'trayAttentionTemplate.png', 'trayTemplate.png']);

  icon.destroy = () => { throw new Error('already gone'); };
  slot.destroy();
  assert.equal(slot.current, null, 'even when the OS call throws');
  slot.setFile('trayAttentionTemplate.png');
  assert.equal(icon.images.length, 3, 'a taken-down icon is not touched');
  const again = slot.show('trayTemplate.png', undefined);
  assert.ok(again && again !== icon && built.length === 2, 'it can come up again');
  assert.equal(loads.length, 4, 'from the images already loaded');
});

// ── desktop-settings.json and DesktopResidency ───────────────────────────────

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-desktop-settings-'));
}

test('desktop settings: the defaults are the icon on and the Dock kept (DESIGN-v2 §5.1)', () => {
  assert.deepEqual(desktop.defaultDesktopSettings(), { tray: { enabled: true, hideDockWhenNoWindows: false, hintShown: false } });
  assert.equal(desktop.DESKTOP_SETTINGS_FILE, 'desktop-settings.json');
  for (const value of [undefined, null, [], 'x', { tray: 'on' }, { tray: { enabled: 'yes', hideDockWhenNoWindows: 1 } }]) {
    assert.deepEqual(desktop.parseDesktopSettings(value), desktop.defaultDesktopSettings(), JSON.stringify(value));
  }
  assert.deepEqual(desktop.parseDesktopSettings({ tray: { enabled: false, extra: 1 } }), { tray: { enabled: false, hideDockWhenNoWindows: false, hintShown: false } });
});

test('desktop settings: a missing or corrupt file reads as the defaults; a write goes through a temporary file and reads back', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'nested', desktop.DESKTOP_SETTINGS_FILE);
    assert.deepEqual(desktop.readDesktopSettings(file), desktop.defaultDesktopSettings());
    const settings = { tray: { enabled: false, hideDockWhenNoWindows: true, hintShown: true } };
    desktop.writeDesktopSettings(file, settings);
    assert.deepEqual(desktop.readDesktopSettings(file), settings);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [desktop.DESKTOP_SETTINGS_FILE], 'no temporary file left');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), settings);
    fs.writeFileSync(file, '{"tray":');
    assert.deepEqual(desktop.readDesktopSettings(file), desktop.defaultDesktopSettings());
    // The renaming write: a crash before the rename leaves the old file whole.
    const calls = [];
    const fake = {
      mkdirSync: (...args) => calls.push(['mkdir', ...args]),
      writeFileSync: (target) => calls.push(['write', path.basename(target)]),
      renameSync: (from, to) => calls.push(['rename', path.basename(from), path.basename(to)]),
      readFileSync: fs.readFileSync,
    };
    desktop.writeDesktopSettings(file, settings, fake);
    assert.equal(calls[1][0], 'write');
    assert.match(calls[1][1], /^desktop-settings\.json\.\d+\.tmp$/);
    assert.deepEqual(calls[2], ['rename', calls[1][1], desktop.DESKTOP_SETTINGS_FILE]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop settings: a change Michi makes on its own (the note was shown) reports a failed write instead of throwing it', () => {
  const dir = tempDir();
  try {
    const settings = { tray: { enabled: true, hideDockWhenNoWindows: false, hintShown: true } };
    const errors = [];
    const file = path.join(dir, desktop.DESKTOP_SETTINGS_FILE);
    assert.equal(desktop.writeDesktopSettingsQuietly(file, settings, (error) => errors.push(error)), true);
    assert.deepEqual(desktop.readDesktopSettings(file), settings, 'hintShown is saved');
    // No permission, a full disk: here the folder for the file is a file.
    const blocked = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocked, '');
    assert.equal(desktop.writeDesktopSettingsQuietly(path.join(blocked, desktop.DESKTOP_SETTINGS_FILE), settings, (error) => errors.push(error)), false);
    const full = { ...fs, mkdirSync: () => {}, writeFileSync: () => { throw new Error('ENOSPC: no space left on device'); } };
    assert.equal(desktop.writeDesktopSettingsQuietly(file, settings, (error) => errors.push(error), full), false);
    assert.equal(errors.length, 2);
    assert.ok(errors.every((error) => error instanceof Error));
    assert.match(errors[1].message, /ENOSPC/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('residency: macOS offers the icon and the Dock switch; Windows the icon and, installed, opening at login', () => {
  const defaults = desktop.defaultDesktopSettings();
  assert.deepEqual(desktop.desktopResidency(defaults, { platform: 'darwin', packaged: true, openAtLogin: null }), {
    tray: { supported: true, enabled: true },
    hideDock: { supported: true, enabled: false },
    openAtLogin: { supported: false, enabled: false },
  });
  assert.deepEqual(desktop.desktopResidency(defaults, { platform: 'win32', packaged: true, openAtLogin: true }), {
    tray: { supported: true, enabled: true },
    hideDock: { supported: false, enabled: false },
    openAtLogin: { supported: true, enabled: true },
  });
  const dev = desktop.desktopResidency(defaults, { platform: 'win32', packaged: false, openAtLogin: null });
  assert.deepEqual(dev.openAtLogin, { supported: false, enabled: false });
  assert.equal(dev.reason, 'Opening Michi at login is available in the installed app.');
  const linux = desktop.desktopResidency(defaults, { platform: 'linux', packaged: true, openAtLogin: null });
  assert.deepEqual(linux.tray, { supported: false, enabled: false });
  assert.match(linux.reason, /macOS and Windows/);
  // Stored switches show; the Dock one only where it exists.
  const stored = { tray: { enabled: false, hideDockWhenNoWindows: true, hintShown: false } };
  assert.deepEqual(desktop.desktopResidency(stored, { platform: 'darwin', packaged: false, openAtLogin: null }).hideDock, { supported: true, enabled: true });
  assert.deepEqual(desktop.desktopResidency(stored, { platform: 'darwin', packaged: false, openAtLogin: null }).tray, { supported: true, enabled: false });
  assert.deepEqual(desktop.desktopResidency(stored, { platform: 'win32', packaged: true, openAtLogin: false }).hideDock, { supported: false, enabled: false });
});

test('residency changes: only booleans for the known switches; a switch this install lacks is refused and nothing changes', () => {
  for (const bad of [null, [], 'tray', { tray: 'on' }, { tray: 1 }, { dock: true }, { tray: true, extra: false }]) {
    assert.throws(() => desktop.parseResidencyPatch(bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual(desktop.parseResidencyPatch({}), {});
  assert.deepEqual(desktop.parseResidencyPatch({ tray: false, hideDock: true, openAtLogin: true }), { tray: false, hideDock: true, openAtLogin: true });

  const settings = desktop.defaultDesktopSettings();
  const mac = { platform: 'darwin', packaged: true };
  assert.deepEqual(desktop.applyResidencyPatch(settings, { tray: false, hideDock: true }, mac), {
    settings: { tray: { enabled: false, hideDockWhenNoWindows: true, hintShown: false } },
  });
  assert.deepEqual(settings, desktop.defaultDesktopSettings(), 'the input is not changed');
  assert.throws(() => desktop.applyResidencyPatch(settings, { openAtLogin: true }, mac), /installed Windows app/);
  const win = { platform: 'win32', packaged: true };
  assert.deepEqual(desktop.applyResidencyPatch(settings, { openAtLogin: true }, win), { settings, openAtLogin: true });
  assert.throws(() => desktop.applyResidencyPatch(settings, { hideDock: true, openAtLogin: true }, win), /macOS/);
  assert.throws(() => desktop.applyResidencyPatch(settings, { openAtLogin: false }, { platform: 'win32', packaged: false }), /installed/);
  assert.throws(() => desktop.applyResidencyPatch(settings, { tray: true }, { platform: 'linux', packaged: true }), /not available/);
});

// ── Loopback backend ─────────────────────────────────────────────────────────

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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (event, data) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const changed = (revision, reason = 'items') => frame('companion_changed', { type: 'companion_changed', revision, reason });

/**
 * A stand-in backend: GET /api/companion/tray answers `trayAnswer()`
 * (`{status, body}`); POST /api/companion/check and PATCH
 * /api/companion/settings answer `actionAnswer(req)`; every request is recorded.
 */
function fakeBackend({ trayAnswer = () => ({ status: 200, body: dto() }), actionAnswer = () => ({ status: 202, body: { queued: true } }), stream } = {}) {
  const requests = [];
  const handler = (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const record = { method: req.method, url: req.url, body, contentType: req.headers['content-type'], origin: req.headers.origin, at: Date.now() };
      requests.push(record);
      if (req.url === '/api/attention/desktop/stream' && stream) return stream(res);
      const answer = req.url === '/api/companion/tray' ? await trayAnswer(record) : actionAnswer(record);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
    });
  };
  const trayRequests = () => requests.filter((r) => r.method === 'GET' && r.url === '/api/companion/tray');
  return { requests, handler, trayRequests, trayGets: () => trayRequests().length };
}

function controller(port, overrides = {}) {
  const changes = [];
  const logs = [];
  const instance = new tray.TrayController({
    port: () => port,
    onChange: (data) => changes.push(data),
    log: (level, message, meta) => logs.push({ level, message, meta }),
    debounceMs: 60,
    ...overrides,
  });
  return { instance, changes, logs };
}

test('the controller fetches nothing until the icon is up and the backend is ready, then fetches once', async () => {
  const backend = fakeBackend();
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port);
    instance.scheduleRefresh();
    await instance.refresh();
    instance.start();
    await sleep(100);
    assert.equal(backend.trayGets(), 0, 'no icon: nothing to fetch for');
    instance.setActive(true);
    await waitFor(() => changes.length === 1, 'the first data');
    assert.equal(backend.trayGets(), 1);
    assert.deepEqual(instance.current(), ready());
    assert.deepEqual(changes, [ready()]);
    const [get] = backend.requests;
    assert.equal(get.origin, undefined, 'loopback without an Origin, like the notice acknowledgements');
    instance.setActive(false);
    instance.scheduleRefresh();
    await sleep(100);
    assert.equal(backend.trayGets(), 1, 'the icon went away: no more fetches');
  });
});

test('the menu pops up from the cached copy: building it never touches the network', async () => {
  const backend = fakeBackend({ trayAnswer: () => ({ status: 200, body: dto({ needsYou: needs(1), needsYouTotal: 1, badge: 1 }) }) });
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port);
    instance.setActive(true);
    instance.start();
    await waitFor(() => changes.length === 1, 'the first data');
    const before = backend.requests.length;
    for (let i = 0; i < 5; i++) assert.equal(labels(instance.menu('darwin'))[2], '● CR-1 has 2 unresolved comments');
    await sleep(100);
    assert.equal(backend.requests.length, before);
  });
});

test('companion_changed frames on the desktop feed refresh the data, once per burst, after the debounce', async () => {
  let revision = 1;
  let streamRes = null;
  const backend = fakeBackend({
    trayAnswer: () => ({ status: 200, body: dto({ revision, badge: revision > 1 ? 1 : 0 }) }),
    stream: (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      streamRes = res;
    },
  });
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port, { debounceMs: 120 });
    // Wired as main wires them: the feed's change signal and reconnects schedule a refresh.
    const feed = new companion.AttentionDesktopFeed({
      port: () => port,
      onSnapshot: () => {},
      onNotification: () => {},
      onResolved: () => {},
      onConnected: () => instance.scheduleRefresh(),
      onChanged: () => instance.scheduleRefresh(),
    });
    instance.setActive(true);
    instance.start();
    try {
      await waitFor(() => changes.length === 1, 'the first data');
      feed.start();
      await waitFor(() => streamRes !== null, 'the feed to connect');
      await waitFor(() => backend.trayGets() === 2, 'the refresh after connecting');
      revision = 2;
      const t0 = Date.now();
      streamRes.write(changed(2));
      streamRes.write(changed(3, 'status'));
      streamRes.write(frame('attention_notification', { malformed: true }));
      streamRes.write(changed(4, 'cards'));
      await sleep(60);
      assert.equal(backend.trayGets(), 2, 'not before the debounce has passed');
      await waitFor(() => backend.trayGets() === 3, 'one refresh for the burst');
      assert.ok(Date.now() - t0 >= 110, 'after the debounce');
      await sleep(250);
      assert.equal(backend.trayGets(), 3, 'only one');
      assert.equal(instance.current().dto.revision, 2);
      assert.equal(tray.trayIconState(instance.current()), 'attention');
      assert.equal(tray.TRAY_REFRESH_DEBOUNCE_MS, 500, 'the default debounce (DESIGN-v2 §5.1)');
    } finally {
      feed.stop();
    }
  });
});

test('with no change frame the copy is fetched again a minute after the last fetch while the icon is up, so the status line\'s age stays true', async () => {
  let minutes = 2;
  const backend = fakeBackend({
    trayAnswer: () => ({ status: 200, body: dto({ statusLine: { text: `Watching · checked ${minutes}m ago`, tone: 'ok' } }) }),
  });
  // The minute, scaled down; each gap between two fetches is measured where the backend saw them.
  const STALE_MS = 400;
  const gap = (a, b) => backend.trayRequests()[b].at - backend.trayRequests()[a].at;
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port, { debounceMs: 20, staleRefreshMs: STALE_MS });
    instance.setActive(true);
    instance.start();
    await waitFor(() => changes.length === 1, 'the first data');
    assert.equal(labels(instance.menu('darwin'))[0], 'Robin · Watching · checked 2m ago');
    minutes = 3;
    await waitFor(() => backend.trayGets() === 2, 'the refresh with no frame', 2_000);
    assert.ok(gap(0, 1) >= STALE_MS - 3, `${gap(0, 1)} ms`);
    await waitFor(() => labels(instance.menu('darwin'))[0] === 'Robin · Watching · checked 3m ago', 'the aged line');
    // A fetch for a change (here at once, after the debounce) starts the minute over.
    instance.scheduleRefresh();
    await waitFor(() => backend.trayGets() === 3, 'the change\'s fetch');
    await waitFor(() => backend.trayGets() === 4, 'the next refresh with no frame', 2_000);
    assert.ok(gap(2, 3) >= STALE_MS - 3, `a minute after the change's fetch, not after the one before it (${gap(2, 3)} ms)`);
    // No icon, or stopped: nothing more.
    instance.setActive(false);
    await sleep(STALE_MS + 150);
    assert.equal(backend.trayGets(), 4, 'the icon went away');
    instance.setActive(true);
    await waitFor(() => backend.trayGets() === 5, 'the icon came back');
    instance.stop();
    await sleep(STALE_MS + 150);
    assert.equal(backend.trayGets(), 5, 'stopped');
  });
  assert.equal(tray.TRAY_STALE_REFRESH_MS, 60_000, 'a minute by default: the line\'s ages are in minutes');
});

test('while the icon is gone, or after stop, no refresh timer is left to wake Michi', async () => {
  const timers = new Set();
  const setTimer = (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  let hold = null;
  const backend = fakeBackend({
    trayAnswer: async () => {
      if (hold) await hold.promise;
      return { status: 200, body: dto() };
    },
  });
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port, { setTimer, staleRefreshMs: 1_000 });
    instance.setActive(true);
    instance.start();
    await waitFor(() => changes.length === 1, 'the first data');
    assert.deepEqual([...timers].map((t) => t.delayMs), [1_000], 'the minute is armed');
    instance.setActive(false);
    assert.equal(timers.size, 0, 'the icon went away');
    instance.setActive(true);
    await waitFor(() => backend.trayGets() === 2 && timers.size === 1, 'armed again');
    instance.stop();
    assert.equal(timers.size, 0, 'stopped');
    // A fetch still out when the icon goes away arms nothing when it ends.
    let release;
    hold = { promise: new Promise((resolve) => { release = resolve; }) };
    instance.start();
    await waitFor(() => backend.trayGets() === 3, 'a fetch out');
    instance.setActive(false);
    release();
    await sleep(100);
    assert.equal(timers.size, 0, 'the answer came after the icon went away');
  });
});

test('the minute\'s refresh also brings back a backend that did not answer', async () => {
  let answer = { status: 500, body: { error: 'starting' } };
  const backend = fakeBackend({ trayAnswer: () => answer });
  await withServer(backend.handler, async (port) => {
    const { instance } = controller(port, { staleRefreshMs: 100 });
    instance.setActive(true);
    instance.start();
    await waitFor(() => instance.current().kind === 'unreachable', 'the failure');
    answer = { status: 200, body: dto() };
    await waitFor(() => instance.current().kind === 'ready', 'the retry', 1_000);
    instance.stop();
  });
});

test('a backend without the endpoint (404) gets no minute poll; the next change or click fetches again (D2-review #1)', async () => {
  const timers = new Set();
  const setTimer = (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  let answer = { status: 404, body: { error: 'not found' } };
  const backend = fakeBackend({ trayAnswer: () => answer });
  await withServer(backend.handler, async (port) => {
    const { instance } = controller(port, { setTimer, staleRefreshMs: 1_000 });
    instance.setActive(true);
    instance.start();
    await waitFor(() => instance.current().kind === 'unsupported', 'the 404');
    assert.equal(timers.size, 0, 'no minute poll for a backend that has no tray data');
    answer = { status: 200, body: dto() };
    await instance.refresh();
    assert.equal(instance.current().kind, 'ready');
    assert.deepEqual([...timers].map((t) => t.delayMs), [1_000], 'a backend that answers is polled again');
    instance.stop();
  });
});

test('a change during a fetch is fetched again after it', async () => {
  let release = null;
  let gets = 0;
  const backend = fakeBackend({
    trayAnswer: async () => {
      gets += 1;
      if (gets === 2) await new Promise((resolve) => { release = resolve; });
      return { status: 200, body: dto({ revision: gets }) };
    },
  });
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port, { debounceMs: 20 });
    instance.setActive(true);
    instance.start();
    await waitFor(() => changes.length === 1, 'the first data');
    instance.scheduleRefresh();
    await waitFor(() => release !== null, 'the second fetch to be out');
    instance.scheduleRefresh();
    release();
    await waitFor(() => backend.trayGets() === 3, 'one more fetch');
    await waitFor(() => instance.current().dto?.revision === 3, 'its data');
  });
});

test('an answer that arrives after the icon went away is dropped', async () => {
  let release = null;
  const backend = fakeBackend({
    trayAnswer: async () => {
      await new Promise((resolve) => { release = resolve; });
      return { status: 200, body: dto() };
    },
  });
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port);
    instance.setActive(true);
    instance.start();
    await waitFor(() => release !== null, 'the fetch to be out');
    instance.setActive(false);
    release();
    await sleep(100);
    assert.deepEqual(changes, []);
    assert.deepEqual(instance.current(), { kind: 'loading' });
  });
});

test('a backend without the endpoint, an error, a malformed answer and no backend each have their state; failures are logged once', async () => {
  let answer = { status: 404, body: { error: 'not found' } };
  const backend = fakeBackend({ trayAnswer: () => answer });
  await withServer(backend.handler, async (port) => {
    const { instance, logs } = controller(port);
    instance.setActive(true);
    instance.start();
    await waitFor(() => instance.current().kind !== 'loading', 'an answer');
    assert.deepEqual(instance.current(), { kind: 'unsupported', displayName: 'Michi' });

    answer = { status: 200, body: dto() };
    await instance.refresh();
    assert.equal(instance.current().kind, 'ready');

    answer = { status: 500, body: { error: 'boom' } };
    await instance.refresh();
    assert.deepEqual(instance.current(), { kind: 'unreachable', displayName: 'Robin' }, 'the last known name stays');
    await instance.refresh();
    answer = { status: 200, body: '{"displayName":' };
    await instance.refresh();
    assert.deepEqual(instance.current(), { kind: 'unreachable', displayName: 'Robin' });
    const failures = logs.filter((log) => log.message === 'tray data unavailable').map((log) => log.meta.reason);
    assert.deepEqual(failures, ['status 500', 'status 200 (malformed)']);
  });
  // Nothing listens on the port any more.
  const { address, close } = await (async () => {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address().port;
    return { address: addr, close: () => new Promise((resolve) => server.close(resolve)) };
  })();
  await close();
  const { instance } = controller(address);
  instance.setActive(true);
  instance.start();
  await waitFor(() => instance.current().kind !== 'loading', 'the failure');
  assert.deepEqual(instance.current(), { kind: 'unreachable', displayName: 'Michi' });
  const noPort = controller(null).instance;
  noPort.setActive(true);
  noPort.start();
  await waitFor(() => noPort.current().kind !== 'loading', 'the failure');
  assert.equal(noPort.current().kind, 'unreachable');
});

test('Check now posts to /api/companion/check and refreshes; a 409 not_owner shows "Another Michi is checking" for a while', async () => {
  let action = { status: 202, body: { queued: true } };
  const backend = fakeBackend({ actionAnswer: () => action });
  await withServer(backend.handler, async (port) => {
    let now = 1_000_000;
    const { instance, changes } = controller(port, { debounceMs: 20, now: () => now, transientStatusMs: 5_000 });
    instance.setActive(true);
    instance.start();
    await waitFor(() => changes.length === 1, 'the first data');
    await instance.checkNow();
    const post = backend.requests.find((r) => r.method === 'POST');
    assert.deepEqual([post.url, post.body, post.contentType], ['/api/companion/check', '{}', 'application/json']);
    await waitFor(() => backend.trayGets() === 2, 'the refresh after Check now');
    assert.equal(labels(instance.menu('darwin'))[0], 'Robin · Watching · checked 2m ago');

    action = { status: 409, body: { error: 'Another Michi process runs the Companion on this computer', code: 'not_owner' } };
    await instance.checkNow();
    assert.equal(labels(instance.menu('darwin'))[0], 'Another Michi is checking');
    now += 4_999;
    assert.equal(labels(instance.menu('darwin'))[0], 'Another Michi is checking');
    now += 1;
    assert.equal(labels(instance.menu('darwin'))[0], 'Robin · Watching · checked 2m ago');
  });
});

test('Turn <name> off and on patch /api/companion/settings and the menu follows at once', async () => {
  let paused = false;
  const backend = fakeBackend({
    trayAnswer: () => ({ status: 200, body: dto({ paused, statusLine: paused ? { text: 'Off', tone: 'off' } : dto().statusLine }) }),
    actionAnswer: (req) => {
      if (req.method === 'PATCH') paused = JSON.parse(req.body).paused;
      return { status: 200, body: {} };
    },
  });
  await withServer(backend.handler, async (port) => {
    const { instance, changes } = controller(port);
    instance.setActive(true);
    instance.start();
    await waitFor(() => changes.length === 1, 'the first data');
    await instance.setPaused(true);
    const patch = backend.requests.find((r) => r.method === 'PATCH');
    assert.deepEqual([patch.url, JSON.parse(patch.body), patch.contentType], ['/api/companion/settings', { paused: true }, 'application/json']);
    assert.ok(entry(instance.menu('darwin'), 'Turn Robin on'), 'without waiting for a change frame');
    await instance.setPaused(false);
    assert.ok(entry(instance.menu('darwin'), 'Turn Robin off'));
  });
});

// ── The desktop feed: change frames ──────────────────────────────────────────
// (attentionNotifications.ts; its records, delivery and reconnects are in
// electron-attention-notifications.test.mjs and electron-lifecycle-helpers.test.mjs.)

test('the desktop feed reports companion_changed frames and skips malformed ones; records still arrive', async () => {
  const record = {
    id: 'attn-1', key: 'agent:item:cmi-1', kind: 'needs_input', reason: 'needs_you', title: 'Robin', body: 'CR-1 has 2 unresolved comments.',
    target: { type: 'agent', ref: 'item:cmi-1', open: TODAY, workspaceId: 'ws-michi' }, createdAt: Date.now() - 1_000, claimedByWindowId: null, claimedAt: null,
  };
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
    res.write(changed(5, 'items'));
    res.write(frame('companion_changed', '{oops'));
    res.write(frame('companion_changed', { type: 'companion_changed', revision: 'x', reason: 'items' }));
    res.write(frame('companion_changed', { type: 'other', revision: 6, reason: 'items' }));
    res.write(frame('attention_notification', record));
    res.write(changed(6, 'brief').replace(/\n/g, '\r\n'));
  }, async (port) => {
    const events = [];
    const feed = new companion.AttentionDesktopFeed({
      port: () => port,
      onSnapshot: () => {},
      onNotification: (value) => events.push(['notification', value.id]),
      onResolved: () => {},
      onChanged: (event) => events.push(['changed', event]),
    });
    try {
      feed.start();
      await waitFor(() => events.length >= 3, 'two changes and a record');
      assert.deepEqual(events, [
        ['changed', { type: 'companion_changed', revision: 5, reason: 'items' }],
        ['notification', 'attn-1'],
        ['changed', { type: 'companion_changed', revision: 6, reason: 'brief' }],
      ]);
    } finally {
      feed.stop();
    }
  });
});

test('a failing change handler is logged without dropping the stream', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(changed(1));
    res.write(changed(2));
  }, async (port) => {
    const seen = [];
    const logs = [];
    const feed = new companion.AttentionDesktopFeed({
      port: () => port,
      onSnapshot: () => {},
      onNotification: () => {},
      onResolved: () => {},
      onChanged: (event) => {
        seen.push(event.revision);
        if (event.revision === 1) throw new Error('boom');
      },
      log: (level, message) => logs.push([level, message]),
    });
    try {
      feed.start();
      await waitFor(() => seen.length === 2, 'both frames');
      assert.deepEqual(logs, [['INFO', 'attention desktop feed connected'], ['WARN', 'attention frame handling failed']]);
    } finally {
      feed.stop();
    }
  });
});

// ── main.ts wiring (read from source: main needs Electron to run) ────────────

const mainSource = read('electron/main.ts');

test('main: the Dock click opens a window when no Michi window is open, counting only Michi\'s own windows', () => {
  const activate = mainSource.slice(mainSource.indexOf("app.on('activate'"), mainSource.indexOf("app.on('activate'") + 400);
  assert.match(activate, /if \(windows\.size === 0\)/);
  assert.doesNotMatch(mainSource, /getAllWindows\(\)/, 'a tray popover or any other window must not count');
});

test('main: Windows groups toasts under the packaged app id', () => {
  assert.equal(tray.APP_USER_MODEL_ID, JSON.parse(read('package.json')).build.appId);
  assert.match(mainSource, /if \(process\.platform === 'win32'\) app\.setAppUserModelId\(APP_USER_MODEL_ID\);/);
});

test('main: closing the last window follows windowAllClosedAction, and the tray menu is popped up, never set as the context menu', () => {
  const closed = appHandler('window-all-closed');
  assert.match(closed, /windowAllClosedAction\(/);
  // "Up" means an icon actually came up (TrayIconSlot never holds a blank one).
  assert.match(closed, /trayShown: trayIcon\.current !== null/);
  assert.match(mainSource, /icon\.popUpContextMenu\(/);
  assert.doesNotMatch(mainSource, /setContextMenu\(/);
});

test('main: the tray refreshes from the desktop feed, never from /companion/events, whose subscribers must be windows only', () => {
  for (const file of fs.readdirSync(path.join(root, 'electron')).filter((name) => name.endsWith('.ts'))) {
    assert.doesNotMatch(read(`electron/${file}`), /companion\/events/, `electron/${file}`);
  }
  assert.match(mainSource, /onChanged: \(\) => trayController\.scheduleRefresh\(\)/);
});

test('main: a background launch shows no icon and quits when idle until the user opens a window', () => {
  assert.match(mainSource, /\(!launchedInBackground \|\| backgroundEngaged\)/, 'trayWanted waits for the user');
  assert.match(mainSource, /function armBackgroundIdleQuit\(\): void \{\n {2}if \(!launchedInBackground \|\| backgroundEngaged\) return;/);
  const create = mainSource.slice(mainSource.indexOf('async function createWindow('), mainSource.indexOf('async function createWindow(') + 600);
  assert.match(create, /engageBackgroundLaunch\(\);/);
});

/** A top-level function of main.ts, from its signature to its closing brace. */
function mainFunction(signature) {
  const start = mainSource.indexOf(signature);
  assert.ok(start >= 0, `main.ts has ${signature}`);
  return mainSource.slice(start, mainSource.indexOf('\n}\n', start) + 2);
}

/** A top-level `app.on(event, …)` handler of main.ts. */
function appHandler(event) {
  const start = mainSource.indexOf(`app.on('${event}'`);
  assert.ok(start >= 0, `main.ts handles ${event}`);
  return mainSource.slice(start, mainSource.indexOf('\n});\n', start) + 4);
}

test('main: the icon is an add-on: whatever goes wrong with it stays inside syncTray, and only TrayIconSlot makes or changes it', () => {
  // Startup, createWindow (a background launch the user opens) and setResidency all call it: none may throw.
  assert.match(mainFunction('function syncTray(): void'), /try \{\n\s+if \(trayWanted\(\)\) ensureTray\(\);\n\s+else destroyTray\(\);\n\s+\} catch \(err\) \{[\s\S]*?\n\s+destroyTray\(\);\n {2}\}\n\}/);
  const ensure = mainFunction('function ensureTray(): void');
  assert.match(ensure, /const icon = trayIcon\.show\(/);
  assert.match(ensure, /if \(!icon\) return;\n\s+renderTray\(\);\n\s+trayController\.setActive\(true\);/, 'no icon: the controller stays idle');
  const slot = mainSource.slice(mainSource.indexOf('new TrayIconSlot<'), mainSource.indexOf('\n});\n', mainSource.indexOf('new TrayIconSlot<')));
  assert.equal((mainSource.match(/new Tray\(/g) ?? []).length, (slot.match(/new Tray\(/g) ?? []).length, 'every Tray is made by the slot');
  assert.doesNotMatch(mainSource, /\.setImage\(/, 'every image change goes through the slot, which never blanks the icon');
  assert.match(mainFunction('function renderTray(): void'), /try \{[\s\S]*trayIcon\.setFile\([\s\S]*\} catch \(err\) \{/);
});

test('main: a login launch starts with the icon and no window, and opens a window when the icon did not come up', () => {
  const boot = mainSource.slice(mainSource.indexOf('app.whenReady().then('), mainSource.indexOf("app.on('window-all-closed'"));
  const decided = boot.indexOf('const mode = startupModeAfterTray(requestedMode, trayIcon.current !== null);');
  assert.ok(decided > boot.indexOf('syncTray();'), 'decided once the icon was tried');
  const trayBranch = boot.slice(boot.indexOf("} else if (mode === 'tray' && process.platform !== 'win32') {"), boot.indexOf('} else {', boot.indexOf("} else if (mode === 'tray' && process.platform !== 'win32') {")));
  assert.ok(trayBranch.length > 0);
  assert.doesNotMatch(trayBranch, /createWindow\(/);
  assert.match(boot, /windowsLifetime\.onAppReady\([\s\S]*createWindow\(undefined, undefined, \{ hidden: ready\.startHidden \}\)/);
});

test('main: a startup that fails (a backend that never becomes healthy) still settles the icon: "Can\'t reach Michi\'s backend", not "starting…" forever', () => {
  const boot = mainSource.slice(mainSource.indexOf('app.whenReady().then('), mainSource.indexOf("app.on('window-all-closed'"));
  const failed = boot.slice(boot.lastIndexOf('} catch (err) {'));
  assert.match(failed, /'startup failed'[\s\S]*trayController\.start\(\);[\s\S]*throw err;/);
});

test('main: the icon goes when the quit really goes ahead (will-quit), not while a window can still cancel it, and before a relaunch', () => {
  assert.doesNotMatch(appHandler('before-quit'), /destroyTray|stopBackend|trayController\.stop/, 'before-quit never tears down tray or backend');
  assert.match(appHandler('will-quit'), /trayController\.stop\(\);\n\s+destroyTray\(\);/);
  const relaunch = mainSource.slice(mainSource.indexOf("onDesktopCommand('app:relaunch'"), mainSource.indexOf('\n});\n', mainSource.indexOf("onDesktopCommand('app:relaunch'")));
  // app.exit() skips before-quit and will-quit alike.
  assert.match(relaunch, /trayController\.stop\(\);\n\s+destroyTray\(\);/);
  assert.match(relaunch, /app\.relaunch\(\{ args: relaunchArgs\(process\.argv\) \}\);\n\s+app\.exit\(0\);/);
  assert.doesNotMatch(relaunch, /app\.relaunch\(\)/, 'not as a login or background launch again');
});

test('main: the one-time note is marked shown (hintShown) with a write that cannot throw out of window-all-closed', () => {
  const hint = mainFunction('function showStillRunningHint(): void');
  assert.match(hint, /hintShown: true/);
  assert.match(hint, /writeDesktopSettingsQuietly\(desktopSettingsFile\(\), next,/);
  assert.doesNotMatch(hint, /saveDesktopSettings\(/);
  assert.match(appHandler('window-all-closed'), /if \(action\.showHint\) showStillRunningHint\(\);/);
});
