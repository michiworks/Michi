import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the actual preload with an IPC double; no Electron process, windows,
// user files, background service or terminal process is started.
function loadPreload(search = '') {
  const calls = [];
  const handlers = new Map();
  const responses = new Map();
  let bridge;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electron'); bridge = value; } },
    ipcRenderer: {
      invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve(responses.get(channel)); },
      send(channel, ...args) { calls.push([channel, ...args]); },
      on(channel, handler) { handlers.set(channel, handler); },
      removeListener(channel, handler) { if (handlers.get(channel) === handler) handlers.delete(channel); },
    },
    webUtils: { getPathForFile(file) { if (file.invalid) throw new Error('not a native file'); return file.path; } },
  };
  vm.runInNewContext(compiled, {
    require(name) { assert.equal(name, 'electron'); return electron; },
    exports: {}, URLSearchParams, window: { location: { search } },
    document: { documentElement: { setAttribute() {} } },
  }, { filename: 'electron/preload.ts' });
  return { bridge, calls, handlers, responses };
}

test('preload forwards typed service and terminal responses without wrapping or dropping fields', async () => {
  const { bridge, calls, responses } = loadPreload();
  const service = { supported: true, enabled: false, running: false, port: null };
  const terminal = { surfaceId: 'surface', data: 'hello', exited: true, exitCode: 2 };
  const lifetime = { supported: true, keepInBackground: false, openAtLogin: false, trayActive: false, canStartHidden: false };
  responses.set('service:getStatus', service);
  responses.set('service:setEnabled', service);
  responses.set('lifetime:getStatus', lifetime);
  responses.set('lifetime:setKeepInBackground', lifetime);
  responses.set('lifetime:setOpenAtLogin', lifetime);
  responses.set('terminal:create', terminal);
  assert.equal(await bridge.getBackgroundServiceStatus(), service);
  assert.equal(await bridge.setBackgroundServiceEnabled(true), service);
  assert.equal(await bridge.getDesktopLifetimeStatus(), lifetime);
  assert.equal(await bridge.setKeepInBackground(true), lifetime);
  assert.equal(await bridge.setOpenAtLogin(false), lifetime);
  assert.equal(await bridge.terminalCreate('surface', '/workspace', 80, 24), terminal);
  assert.deepEqual(calls, [
    ['service:getStatus'],
    ['service:setEnabled', true],
    ['lifetime:getStatus'],
    ['lifetime:setKeepInBackground', true],
    ['lifetime:setOpenAtLogin', false],
    ['terminal:create', 'surface', '/workspace', 80, 24],
  ]);
});

test('residency reads and changes cross only the desktop: channels and come back unchanged', async () => {
  const { bridge, calls, responses } = loadPreload();
  // DesktopResidency as main answers it on macOS: the icon on, the Dock kept, no login item.
  const residency = {
    tray: { supported: true, enabled: true },
    hideDock: { supported: true, enabled: false },
    openAtLogin: { supported: false, enabled: false },
  };
  const changed = { ...residency, hideDock: { supported: true, enabled: true } };
  responses.set('desktop:getResidency', residency);
  responses.set('desktop:setResidency', changed);
  assert.equal(await bridge.getResidency(), residency);
  const patch = { hideDock: true };
  assert.equal(await bridge.setResidency(patch), changed);
  assert.deepEqual(calls, [['desktop:getResidency'], ['desktop:setResidency', patch]]);
  assert.equal(calls[1][1], patch, 'the patch is passed as given; main validates it');
});

test('main answers every channel the preload invokes', () => {
  const preloadSource = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
  const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const channels = (text, pattern) => new Set([...text.matchAll(pattern)].map((m) => m[1]));
  const invoked = channels(preloadSource, /[^\w]invoke\('([\w:-]+)'/g);
  const handled = channels(mainSource, /handleDesktopInvoke\('([\w:-]+)'/g);
  assert.ok(invoked.has('desktop:getResidency') && invoked.has('desktop:setResidency'), 'the scan finds the preload\'s invokes');
  for (const channel of invoked) assert.ok(handled.has(channel), `${channel} is invoked by the preload but main has no handler`);
});

test('backdrop capture forwards the rect and returns the image unchanged', async () => {
  const { bridge, calls, responses } = loadPreload();
  responses.set('app:captureBackdrop', 'data:image/png;base64,AAAA');
  const rect = { x: 0, y: 0, width: 1440, height: 900 };
  assert.equal(await bridge.captureBackdrop(rect), 'data:image/png;base64,AAAA');
  assert.deepEqual(calls, [['app:captureBackdrop', rect]]);
});

test('remote authentication target crosses only its dedicated IPC channel', async () => {
  const { bridge, calls, responses } = loadPreload();
  const target = { host: 'example.test', user: 'test', port: 22, scope: 'remote' };
  const snapshot = { surfaceId: 'auth', data: '', exited: false };
  responses.set('remote-auth:create', snapshot);
  assert.equal(await bridge.remoteAuthCreate('auth', target, 100, 30), snapshot);
  assert.deepEqual(calls, [['remote-auth:create', 'auth', target, 100, 30]]);
});

test('preload event subscriptions preserve payloads and release their exact listener', () => {
  const { bridge, handlers } = loadPreload();
  const notice = { title: 'Done', subtitle: 'Scheduled', body: 'Result', target: { runId: 'r', jobId: 'j', workspaceId: 'w', nodeId: null } };
  let received;
  const stop = bridge.onScheduledNotice((value) => { received = value; });
  handlers.get('scheduled:notice')({}, notice);
  assert.equal(received, notice);
  stop();
  assert.equal(handlers.has('scheduled:notice'), false);
});

test('notifications keep the two-argument call and route a targeted click back', () => {
  const { bridge, calls, handlers } = loadPreload();
  bridge.showNotification('Done', 'Result');
  bridge.showNotification('Needs input', 'Which database?', { key: 'node:n1', silent: true });
  assert.deepEqual(calls, [
    ['app:showNotification', 'Done', 'Result'],
    ['app:showNotification', 'Needs input', 'Which database?', { key: 'node:n1', silent: true }],
  ]);
  const clicked = [];
  const stop = bridge.onAttentionNotificationClick((key) => clicked.push(key));
  handlers.get('app:attentionNotificationClicked')({}, 'node:n1');
  assert.deepEqual(clicked, ['node:n1']);
  stop();
  assert.equal(handlers.has('app:attentionNotificationClicked'), false);
});

async function loadRendererNotifications() {
  const builtUrl = new URL('../electron/dist/rendererNotifications.js', import.meta.url);
  assert.ok(fs.existsSync(builtUrl), 'electron/dist/rendererNotifications.js is missing; run `npm run electron:build-main` first');
  return import(builtUrl.href);
}

test('main accepts a renderer notification only with a string title and a sane target', async () => {
  const { parseNotificationRequest } = await loadRendererNotifications();
  assert.deepEqual(parseNotificationRequest('Done', 'Result', undefined), { title: 'Done', body: 'Result', key: null, silent: false });
  assert.deepEqual(parseNotificationRequest('Done', undefined, { key: 'node:n1', silent: true }), { title: 'Done', body: '', key: 'node:n1', silent: true });
  assert.equal(parseNotificationRequest(undefined, 'Result', { key: 'node:n1' }), null);
  assert.equal(parseNotificationRequest('Done', '', { key: 'x'.repeat(2000) }).key, null);
  assert.equal(parseNotificationRequest('Done', '', { key: 42, silent: 'yes' }).silent, false);
});

test('main holds one notification per window and key, bounded', async () => {
  const { createNotificationHolder } = await loadRendererNotifications();
  const holder = createNotificationHolder(2);
  const notification = () => { const n = { closed: 0, close() { n.closed += 1; } }; return n; };
  const first = notification();
  const releaseFirst = holder.hold(1, 'node:n1', first);
  const other = notification();
  holder.hold(2, 'node:n1', other);
  const newer = notification();
  holder.hold(1, 'node:n1', newer);
  // Only the same window's older notification for the target is replaced.
  assert.equal(first.closed, 1);
  assert.equal(other.closed, 0);
  releaseFirst();
  for (const n of [notification(), notification()]) holder.hold(1, null, n);
  // Over the limit the oldest are let go, not closed: a later one for their key replaces nothing.
  holder.hold(2, 'node:n1', notification());
  holder.hold(1, 'node:n1', notification());
  assert.equal(other.closed, 0);
  assert.equal(newer.closed, 0);
});

test('Companion subscriptions pass notices and targets through and release their exact listener', () => {
  const { bridge, handlers } = loadPreload();
  // A notice about one Michi conversation, as the backend sends it.
  const notice = {
    id: 'cmn-1', title: 'Companion', body: 'Chat X has been waiting 30 min', target: { kind: 'node', workspaceId: 'w', nodeId: 'n' },
    itemIds: ['cmi-1'], createdAt: 1, expiresAt: 2,
  };
  // A banner's click for a notice about one item: Today, at that item.
  const target = { kind: 'companion', tab: 'today', itemId: 'cmi-2' };
  let receivedNotice;
  let receivedTarget;
  const stopNotice = bridge.onCompanionNotice((value) => { receivedNotice = value; });
  const stopOpen = bridge.onCompanionOpen((value) => { receivedTarget = value; });
  handlers.get('companion:notice')({}, notice);
  handlers.get('companion:open')({}, target);
  assert.equal(receivedNotice, notice);
  assert.equal(receivedTarget, target);
  stopNotice();
  stopOpen();
  assert.equal(handlers.has('companion:notice'), false);
  assert.equal(handlers.has('companion:open'), false);
});

test('Companion subscriptions tell main when this document starts and stops listening, on the channel main reads', () => {
  // The name main.ts listens on (electron/companionNotifications.ts); preload.ts cannot import it.
  const { COMPANION_READY_CHANNEL } = require('../electron/dist/companionNotifications.js');
  const { bridge, calls } = loadPreload();
  const stopFirst = bridge.onCompanionNotice(() => {});
  const stopSecond = bridge.onCompanionNotice(() => {});
  const stopOpen = bridge.onCompanionOpen(() => {});
  assert.deepEqual(calls, [[COMPANION_READY_CHANNEL, 'notice', true], [COMPANION_READY_CHANNEL, 'open', true]]);
  stopFirst();
  stopFirst();
  assert.equal(calls.length, 2, 'one notice listener is left, and a second stop does nothing');
  stopSecond();
  stopOpen();
  assert.deepEqual(calls.slice(2), [[COMPANION_READY_CHANNEL, 'notice', false], [COMPANION_READY_CHANNEL, 'open', false]]);
  // Subscribing again (React StrictMode runs an effect twice) is reported again.
  bridge.onCompanionNotice(() => {});
  assert.deepEqual(calls.slice(4), [[COMPANION_READY_CHANNEL, 'notice', true]]);
  // Other subscriptions say nothing.
  bridge.onScheduledNotice(() => {});
  bridge.onOpenUrl(() => {});
  assert.equal(calls.length, 5);
});

test('a window a Companion notification opened reads its target from the parameter main.ts sets', () => {
  // The name main.ts writes (electron/companionNotifications.ts); preload.ts cannot import it.
  const { COMPANION_TARGET_PARAM } = require('../electron/dist/companionNotifications.js');
  const withTarget = (raw) => `?${new URLSearchParams({ michiWindowId: 'window', [COMPANION_TARGET_PARAM]: raw })}`;
  for (const target of [
    { kind: 'node', workspaceId: 'w', nodeId: 'n' },
    { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    { kind: 'companion', tab: 'today' },
    // A notice about one item: Today, at that item.
    { kind: 'companion', tab: 'today', itemId: 'cmi-1' },
    { kind: 'settings' },
  ]) {
    const { bridge, calls } = loadPreload(withTarget(JSON.stringify(target)));
    assert.equal(JSON.stringify(bridge.initialCompanionTarget), JSON.stringify(target));
    assert.deepEqual(calls, []);
  }
  // Rebuilt from known fields only; an item only on Today, and only a well-formed one.
  for (const [raw, target] of [
    ['{"kind":"companion","tab":"chat","extra":1}', { kind: 'companion', tab: 'chat' }],
    ['{"kind":"companion","tab":"chat","itemId":"cmi-1"}', { kind: 'companion', tab: 'chat' }],
    ['{"kind":"companion","tab":"today","itemId":""}', { kind: 'companion', tab: 'today' }],
    ['{"kind":"companion","tab":"today","itemId":7}', { kind: 'companion', tab: 'today' }],
    [JSON.stringify({ kind: 'companion', tab: 'today', itemId: 'x'.repeat(161) }), { kind: 'companion', tab: 'today' }],
  ]) {
    assert.equal(JSON.stringify(loadPreload(withTarget(raw)).bridge.initialCompanionTarget), JSON.stringify(target), raw.slice(0, 80));
  }
  assert.equal(loadPreload('?michiWindowId=window').bridge.initialCompanionTarget, null);
  for (const raw of [
    '', 'not json', 'null', '[]', '"chat"', '{"kind":"spaces"}', '{"kind":"companion","tab":"inbox"}',
    '{"kind":"url","url":"javascript:alert(1)"}', '{"kind":"node","workspaceId":"","nodeId":"n"}', '{"kind":"node","workspaceId":"w"}',
  ]) {
    assert.equal(loadPreload(withTarget(raw)).bridge.initialCompanionTarget, null, raw);
  }
});

test('every target main.ts accepts survives the preload unchanged', () => {
  const { COMPANION_TARGET_PARAM, parseCompanionTarget } = require('../electron/dist/companionNotifications.js');
  const long = (n) => 'x'.repeat(n);
  const candidates = [
    { kind: 'node', workspaceId: 'w', nodeId: 'n' }, { kind: 'node', workspaceId: long(160), nodeId: long(160) },
    { kind: 'node', workspaceId: long(161), nodeId: 'n' },
    { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' }, { kind: 'url', url: 'HTTP://builds.example.com/pipelines/A' },
    { kind: 'url', url: 'https://outlook.office.com/mail/a b' }, { kind: 'url', url: ' https://reviews.example.com' },
    { kind: 'url', url: `https://x.test/${long(2048 - 'https://x.test/'.length)}` }, { kind: 'url', url: `https://x.test/${long(2048)}` },
    { kind: 'url', url: 'ftp://x.test' }, { kind: 'url', url: 'https://' },
    { kind: 'companion', tab: 'chat' }, { kind: 'companion', tab: 'today' }, { kind: 'settings' },
    { kind: 'companion', tab: 'today', itemId: 'cmi-1' }, { kind: 'companion', tab: 'today', itemId: long(160) },
    { kind: 'companion', tab: 'today', itemId: long(161) }, { kind: 'companion', tab: 'chat', itemId: 'cmi-1' },
  ];
  let accepted = 0;
  for (const candidate of candidates) {
    const target = parseCompanionTarget(candidate);
    if (!target) continue;
    accepted += 1;
    const query = `?${new URLSearchParams({ [COMPANION_TARGET_PARAM]: JSON.stringify(target) })}`;
    assert.equal(JSON.stringify(loadPreload(query).bridge.initialCompanionTarget), JSON.stringify(target), JSON.stringify(candidate).slice(0, 80));
  }
  assert.ok(accepted >= 8, 'the sample covers each target kind');
});

test('bootstrap values and native File conversion retain legacy renderer behavior', () => {
  const { bridge, calls } = loadPreload('?michiPackaged=1&michiWindowId=window&michiOpenRun=r&michiOpenJob=j&michiOpenWorkspace=w');
  assert.equal(bridge.isPackaged, true);
  assert.equal(bridge.michiWindowId, 'window');
  assert.equal(JSON.stringify(bridge.initialScheduledRun), JSON.stringify({ runId: 'r', jobId: 'j', workspaceId: 'w', nodeId: null }));
  assert.equal(bridge.getPathForFile({ path: '/workspace/file' }), '/workspace/file');
  assert.equal(bridge.getPathForFile({ invalid: true }), null);
  assert.deepEqual(calls, []);
});


test('public updater uses the shared invoke channels and update-state event', async () => {
  const { bridge, calls, handlers, responses } = loadPreload();
  const state = { status: 'ready', currentVersion: '0.3.2', latestVersion: '0.3.3' };
  for (const name of ['getUpdateState', 'checkForUpdate', 'downloadUpdate', 'installUpdate']) {
    responses.set(`app:${name}`, state);
    assert.equal(await bridge[name](), state);
  }
  assert.deepEqual(calls.map(([channel]) => channel), [
    'app:getUpdateState', 'app:checkForUpdate', 'app:downloadUpdate', 'app:installUpdate',
  ]);
  const received = [];
  const unsubscribe = bridge.onAppUpdate(value => received.push(value));
  handlers.get('app:update-state')({}, state);
  assert.deepEqual(received, [state]);
  unsubscribe();
  assert.equal(handlers.has('app:update-state'), false);
});

// ── Sandbox contract ──────────────────────────────────────────────────────
// The windows run with sandbox: true, so the shipped preload may require only
// 'electron' and must not touch Node-only globals. These checks read the real
// tsc output; run `npm run electron:build-main` first.
const NODE_ONLY_GLOBALS = new Set(['Buffer', 'setImmediate', 'clearImmediate', 'process', '__dirname', '__filename', 'global', 'module']);

function isPropertyName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  return (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
}

function sandboxViolations(code) {
  const file = ts.createSourceFile('preload.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const violations = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (node.text === 'require') {
        const call = node.parent;
        const ok = ts.isCallExpression(call) && call.expression === node && call.arguments.length === 1
          && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'electron';
        if (!ok) violations.push(node.parent.getText(file));
      } else if (NODE_ONLY_GLOBALS.has(node.text)) {
        violations.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function webPreferencesOf(sourceText, constructorNames) {
  const file = ts.createSourceFile('main.ts', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && constructorNames.includes(node.expression.text)) {
      const options = node.arguments?.[0];
      const prefs = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'webPreferences')
        : undefined;
      if (prefs && ts.isObjectLiteralExpression(prefs.initializer)) {
        const values = {};
        for (const p of prefs.initializer.properties) {
          if (ts.isPropertyAssignment(p)) values[p.name.getText(file)] = p.initializer.getText(file);
        }
        found.push({ constructor: node.expression.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, values });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test('sandbox scan detects Node-only globals and non-electron requires', () => {
  assert.deepEqual(
    sandboxViolations('const fs = require("fs"); Buffer.from("x"); setImmediate(() => {}); process.platform; obj.process = 1;'),
    ['require("fs")', 'Buffer', 'setImmediate', 'process'],
  );
  assert.deepEqual(sandboxViolations('const electron_1 = require("electron"); window.process; ({ process: 1 });'), []);
});

test('compiled preload requires only electron and uses no Node-only globals', () => {
  const builtUrl = new URL('../electron/dist/preload.js', import.meta.url);
  assert.ok(fs.existsSync(builtUrl), 'electron/dist/preload.js is missing; run `npm run electron:build-main` first');
  const built = fs.readFileSync(builtUrl, 'utf8');
  assert.deepEqual(sandboxViolations(built), []);
  // The tsc CommonJS output loads with only the module/exports/require a
  // sandboxed preload receives, plus the web globals it reads.
  let exposed;
  vm.runInNewContext(built, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
        ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} },
        webUtils: { getPathForFile() { return ''; } },
      };
    },
    exports: {}, URLSearchParams, window: { location: { search: '' } },
    document: { documentElement: { setAttribute() {} } },
  }, { filename: 'electron/dist/preload.js' });
  assert.equal(typeof exposed?.getPathForFile, 'function');
});

test('every window and view that loads web content keeps the renderer sandboxed', () => {
  const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const found = webPreferencesOf(mainSource, ['BrowserWindow', 'WebContentsView']);
  assert.ok(found.some((entry) => entry.constructor === 'BrowserWindow' && 'preload' in entry.values), 'main window webPreferences not found');
  for (const entry of found) {
    const where = `${entry.constructor} at electron/main.ts:${entry.line}`;
    assert.equal(entry.values.sandbox, 'true', `${where} must set sandbox: true`);
    assert.equal(entry.values.contextIsolation, 'true', `${where} must set contextIsolation: true`);
    assert.equal(entry.values.nodeIntegration, 'false', `${where} must set nodeIntegration: false`);
  }
});
