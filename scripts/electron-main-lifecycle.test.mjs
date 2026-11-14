// Characterization tests for electron/main.ts, run against the built
// electron/dist/main.js under an in-memory Electron (scripts/lib/
// electron-main-harness.mjs): boot, backend supervision, windows, terminals,
// notifications and quit. They pin today's behavior so main.ts can be split
// into modules without changing it; run `npm run electron:build-main` first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMain, waitFor } from './lib/electron-main-harness.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { michiDisabledFeatures } = require('../electron/dist/chromiumFeatures.js');
const { SIGN_IN_COMMANDS } = require('../electron/dist/remoteCredentials.js');
const { COMPANION_READY_CHANNEL } = require('../electron/dist/attentionNotifications.js');

/** Electron main's one notification subscription: the attention desktop feed. */
const STREAM = 'GET /api/attention/desktop/stream';

/** A Scheduled Job run's attention record, as the backend sends it on the desktop feed. */
function runRecord(runId, extra = {}) {
  return {
    id: `attn-${runId}`, key: `scheduled_run:${runId}`, kind: 'finished', reason: 'run_completed', title: 'Digest', body: 'All quiet',
    target: { type: 'scheduled_run', runId, jobId: 'job-1', nodeId: 'n-1', workspaceId: 'ws-1' }, createdAt: Date.now(),
    claimedByWindowId: null, claimedAt: null, ...extra,
  };
}
const isMac = process.platform === 'darwin';
// A test body that stops making progress fails instead of stalling test:contracts.
// node:test does not apply this to t.after hooks, so cleanup must not wait on open sockets.
const BOUNDED = { timeout: 20_000 };

/** Property names of an interface in shared/src/desktopContracts.ts. */
function contractChannels(name) {
  const file = path.join(root, 'shared', 'src', 'desktopContracts.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const contract = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === name);
  return contract.members.map((member) => member.name.text).sort();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sentOn(contents, prefix) {
  return contents.sent.filter(([channel]) => channel.startsWith(prefix));
}

function menuItem(template, label) {
  for (const item of template) {
    if (item.label === label) return item;
    const found = Array.isArray(item.submenu) ? menuItem(item.submenu, label) : null;
    if (found) return found;
  }
  return null;
}

async function firstWindow(main, loads = 1) {
  return waitFor(() => main.windows[0]?.loads.length >= loads && main.windows[0], 'the first window to load');
}

const eventChannels = new Set(contractChannels('DesktopEventContract'));
function assertKnownEvents(main) {
  for (const win of main.windows) {
    for (const [channel] of win.webContents.sent) assert.ok(eventChannels.has(channel), `${channel} is not in DesktopEventContract`);
  }
}

test('importing main registers every desktop contract channel once and starts nothing before ready', BOUNDED, async (t) => {
  const main = await startMain(t, { ready: false });
  assert.deepEqual([...main.handlers.keys()].sort(), contractChannels('DesktopInvokeContract'));
  // Plus the preload's own Companion report, which no renderer code sends (not a contract channel).
  assert.deepEqual([...main.listeners.keys()].sort(), [...contractChannels('DesktopCommandContract'), COMPANION_READY_CHANNEL].sort());
  // Quit cleanup waits for will-quit: a window can still cancel the quit after before-quit.
  assert.deepEqual(
    ['second-instance', 'activate', 'window-all-closed', 'before-quit', 'will-quit'].map((name) => main.electron.app.listenerCount(name)),
    [1, 1, 1, 0, 1],
  );
  // Until boot has opened its own window, the Dock icon opens none.
  main.electron.app.emit('activate');
  // Chromium switches are set before ready (MICHI_NO_VIBRANCY=1 in the harness).
  const features = michiDisabledFeatures(process.platform, { MICHI_NO_VIBRANCY: '1' });
  assert.equal(main.switches.get('disable-features'), features.length > 0 ? features.join(',') : undefined);
  // The login-shell PATH patch runs at import.
  await waitFor(() => main.log.includes('fix-path'), 'fix-path');
  assert.equal(main.windows.length, 0);
  assert.equal(main.forks.length, 0);
  assert.equal(main.menu, null);
  assert.equal(main.log.includes('app.exit:0'), false);
});

test('a second process exits when another instance holds the profile lock', BOUNDED, async (t) => {
  const main = await startMain(t, { ready: false, singleInstance: false });
  assert.ok(main.log.includes('app.exit:0'));
});

test('a packaged launch forks a loopback backend and shows a skeleton until /api/health passes', BOUNDED, async (t) => {
  const main = await startMain(t, {
    mode: 'packaged',
    ready: false,
    env: {
      SHARED_KEY: 'from-process',
      MICHI_BIND_HOST: '0.0.0.0',
      MICHI_REMOTE_TOKEN: 'secret',
      MICHI_DEV_RENDERER: '1',
      MICHI_RENDERER_URL: 'http://127.0.0.1:5173',
      MICHI_LAUNCH_CWD: '/work/project',
    },
    homeFiles: {
      '.michi/.env': '# user keys\nDOTENV_ONLY="from dotenv"\nSHARED_KEY=from-dotenv\nMICHI_REMOTE_ACCESS=1\n'
        + 'export DOTENV_EXPORTED=sk-exported\nDOTENV_COMMENTED=sk-commented # work key\n',
      '.michi/config.json': JSON.stringify({ preventSleep: true }),
    },
  });
  main.backend.setHealthy(false);
  main.ready();

  const backend = await waitFor(() => main.forks[0], 'the backend fork');
  assert.equal(backend.entry, path.join(main.appPath, 'backend', 'dist', 'server.js'));
  assert.deepEqual(backend.args, []);
  assert.equal(backend.options.silent, false);
  assert.equal(backend.options.stdio, 'inherit');
  const env = backend.options.env;
  const port = Number(env.PORT);
  assert.ok(Number.isInteger(port) && port > 0);
  // A fresh port is remembered so the renderer origin (and its localStorage) stays stable.
  assert.equal(fs.readFileSync(path.join(main.home, '.michi', 'backend-port'), 'utf8'), env.PORT);
  assert.equal(env.MICHI_LOG_DIR, main.logDir);
  assert.equal(env.MICHI_LAUNCH_CWD, '/work/project');
  // ~/.michi/.env fills gaps; the process environment wins; the bundled backend stays loopback-only.
  assert.equal(env.DOTENV_ONLY, 'from dotenv');
  // Read as the background service's backend reads the file (dotenv format).
  assert.equal(env.DOTENV_EXPORTED, 'sk-exported');
  assert.equal(env['export DOTENV_EXPORTED'], undefined);
  assert.equal(env.DOTENV_COMMENTED, 'sk-commented');
  assert.equal(env.SHARED_KEY, 'from-process');
  assert.equal(env.MICHI_REMOTE_ACCESS, '0');
  assert.equal(env.MICHI_BIND_HOST, '127.0.0.1');
  assert.equal(env.MICHI_REMOTE_TOKEN, undefined);
  // The installed app serves its own UI, so dev-renderer trust flags are dropped.
  assert.equal(env.MICHI_DEV_RENDERER, undefined);
  assert.equal(env.MICHI_RENDERER_URL, undefined);
  assert.equal(env.MICHI_STARTUP_TRACE, undefined);
  assert.ok(main.log.includes('powerSaveBlocker.start:prevent-app-suspension'));

  const win = await firstWindow(main);
  assert.deepEqual(win.options.webPreferences, {
    preload: path.join(root, 'electron', 'dist', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  });
  assert.deepEqual(
    [win.options.width, win.options.height, win.options.minWidth, win.options.minHeight, win.options.show, win.options.x],
    [1600, 1000, 360, 480, false, undefined],
  );
  assert.equal(win.options.backgroundColor, '#F5F2EE');
  assert.match(win.loads[0], /^data:text\/html;charset=utf-8,/);
  assert.match(decodeURIComponent(win.loads[0]), /loading…/);

  // While the backend is unhealthy the window stays on the skeleton and the feed waits.
  await waitFor(() => main.backend.requests.filter((request) => request === 'GET /api/health').length >= 2, 'health polling');
  assert.equal(win.loads.length, 1);
  assert.equal(main.backend.requests.includes(STREAM), false);

  main.backend.setHealthy(true);
  await waitFor(() => win.loads.length === 2, 'the backend UI');
  assert.equal(win.loads[1], `http://127.0.0.1:${port}/?michiWindowId=win-0&michiPackaged=1`);
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed');
  win.emit('ready-to-show');
  assert.equal(win.shown, true);

  assert.deepEqual(await main.invoke('service:getStatus', win.webContents), isMac
    ? { supported: true, enabled: false, running: false, port }
    : { supported: false, reason: 'The background service is available on macOS.', enabled: false, running: false, port });

  // Cmd+W must reach the renderer (close pane); New Window stays on CmdOrCtrl+N.
  assert.equal(menuItem(main.menu, 'New Window').accelerator, 'CmdOrCtrl+N');
  assert.equal(JSON.stringify(main.menu).includes('"CmdOrCtrl+W"'), false);

  main.powerMonitor.emit('resume');
  await waitFor(() => main.backend.requests.includes('POST /api/backend-connections/check'), 'the resume check');

  // Quitting stops the app-owned backend first, then quits for real.
  const before = main.log.length;
  main.electron.app.quit();
  await waitFor(() => main.log.at(-1) === 'app.quit:done', 'quit');
  assert.deepEqual(main.log.slice(before), ['app.quit', 'backend.kill:SIGTERM', 'app.quit', 'app.quit:done']);
  assert.match(fs.readFileSync(path.join(main.logDir, 'electron-main.log'), 'utf8'), /stopping backend on quit/);
  assertKnownEvents(main);
});

test('the backend keeps its saved port while it is free and takes a new one when it is not', BOUNDED, async (t) => {
  const saved = await freePort();
  const first = await startMain(t, { mode: 'packaged', homeFiles: { '.michi/backend-port': `${saved}\n` } });
  assert.equal((await waitFor(() => first.forks[0], 'fork')).options.env.PORT, String(saved));
  assert.equal((await firstWindow(first, 2)).loads[1], `http://127.0.0.1:${saved}/?michiWindowId=win-0&michiPackaged=1`);
  await first.dispose();

  // Drop every connection: if main ever probes /api/health on the held port, close() must not wait on it.
  const holder = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => holder.listen(saved, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => holder.close(resolve)));
  const second = await startMain(t, { mode: 'packaged', homeFiles: { '.michi/backend-port': `${saved}\n` } });
  const port = (await waitFor(() => second.forks[0], 'fork')).options.env.PORT;
  assert.notEqual(port, String(saved));
  assert.equal(fs.readFileSync(path.join(second.home, '.michi', 'backend-port'), 'utf8'), port);
  await firstWindow(second, 2);
});

test('MICHI_PORT picks the backend port without touching the saved one', BOUNDED, async (t) => {
  const port = await freePort();
  const main = await startMain(t, { mode: 'packaged', env: { MICHI_PORT: String(port) }, homeFiles: { '.michi/backend-port': '4100' } });
  assert.equal((await waitFor(() => main.forks[0], 'fork')).options.env.PORT, String(port));
  await firstWindow(main, 2);
  assert.equal(fs.readFileSync(path.join(main.home, '.michi', 'backend-port'), 'utf8'), '4100');
});

test('without MICHI_LAUNCH_CWD the backend gets the working directory main started in', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged' });
  assert.equal((await waitFor(() => main.forks[0], 'fork')).options.env.MICHI_LAUNCH_CWD, process.cwd());
  await firstWindow(main, 2);
});

test('startup tracing reaches the backend environment and the renderer URL', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged', env: { MICHI_STARTUP_TRACE: '1', MICHI_STARTUP_RUN_ID: 'run-x' } });
  const env = (await waitFor(() => main.forks[0], 'fork')).options.env;
  assert.equal(env.MICHI_STARTUP_TRACE, '1');
  assert.equal(env.MICHI_STARTUP_RUN_ID, 'run-x');
  const win = await firstWindow(main, 2);
  assert.equal(win.loads[1], `http://127.0.0.1:${env.PORT}/?michiWindowId=win-0&michiPackaged=1&startupTrace=1&startupRunId=run-x`);
});

test('without a bundled backend the window loads frontend/build/index.html', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'unbundled' });
  const win = await firstWindow(main);
  assert.deepEqual(win.loads, [{ file: path.join(main.appPath, 'frontend', 'build', 'index.html'), query: { michiWindowId: 'win-0' } }]);
  assert.equal(main.forks.length, 0);
  // The backend is external, so the feed follows MICHI_BACKEND_PORT.
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed');
  assert.equal((await main.invoke('service:getStatus', win.webContents)).port, null);
});

test('a banner clicked with no window open gives the index.html window the run to open', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'unbundled' });
  const win = await firstWindow(main);
  await waitFor(() => main.backend.streams.size === 1, 'the notification feed');
  win.close();
  main.backend.pushRecord(runRecord('run-1'));
  const banner = await waitFor(() => main.notifications[0], 'the banner');
  banner.emit('click');
  const reopened = await waitFor(() => main.windows[1]?.loads.length && main.windows[1], 'a window for the run');
  assert.deepEqual(reopened.loads, [{
    file: path.join(main.appPath, 'frontend', 'build', 'index.html'),
    query: { michiWindowId: 'win-1', michiOpenRun: 'run-1', michiOpenJob: 'job-1', michiOpenWorkspace: 'ws-1', michiOpenNode: 'n-1' },
  }]);
});

test('a dev launch loads the launcher renderer URL in an isolated profile and never forks', BOUNDED, async (t) => {
  const main = await startMain(t, {
    mode: 'dev',
    env: ({ dir }) => ({ MICHI_RENDERER_URL: 'http://127.0.0.1:5999', MICHI_ELECTRON_USER_DATA_DIR: path.join(dir, 'dev-profile') }),
  });
  const win = await firstWindow(main);
  assert.deepEqual(win.loads, ['http://127.0.0.1:5999/?michiWindowId=win-0']);
  assert.equal(main.electron.app.getPath('userData'), path.join(path.dirname(main.home), 'dev-profile'));
  assert.equal(main.forks.length, 0);
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed');
  assert.equal(main.log.includes('webContents.openDevTools'), false);
});

test('the background service switch is refused outside the installed macOS app', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  await assert.rejects(main.invoke('service:setEnabled', win.webContents, 'yes'), /enabled must be a boolean/);
  const reason = isMac ? 'The background service is available in the installed app.' : 'The background service is available on macOS.';
  await assert.rejects(main.invoke('service:setEnabled', win.webContents, true), { message: reason });
  assert.deepEqual(await main.invoke('service:getStatus', win.webContents), { supported: false, reason, enabled: false, running: false, port: null });
});

test('a background launch opens no window until the user asks for one', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev', argv: ['--michi-background-launch'] });
  await waitFor(() => main.backend.requests.includes(STREAM), 'boot to finish');
  assert.equal(main.windows.length, 0);
  main.electron.app.emit('second-instance', {}, ['michi', '--michi-background-launch']);
  assert.equal(main.windows.length, 0);
  main.electron.app.emit('activate');
  await firstWindow(main);
  main.electron.app.emit('second-instance', {}, ['michi']);
  const second = await waitFor(() => main.windows[1]?.loads.length && main.windows[1], 'a second window');
  // Later windows cascade from the first.
  assert.deepEqual([second.options.x, second.options.y], [112, 112]);
  assert.deepEqual(second.loads, ['http://127.0.0.1:3001/?michiWindowId=win-1']);

  main.electron.app.emit('window-all-closed');
  assert.equal(main.log.includes('app.quit'), !isMac);
});

test('a background launch subscribes to notices only once the backend is healthy', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged', ready: false, argv: ['--michi-background-launch'] });
  main.backend.setHealthy(false);
  main.ready();
  await waitFor(() => main.backend.requests.filter((request) => request === 'GET /api/health').length >= 2, 'health polling');
  assert.equal(main.backend.requests.includes(STREAM), false);
  main.backend.setHealthy(true);
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed');
  assert.equal(main.windows.length, 0);
});

test('window sizes persist per slot: debounced while resizing, flushed on close', BOUNDED, async (t) => {
  const main = await startMain(t, {
    mode: 'dev',
    userDataFiles: { 'window-state.json': JSON.stringify([{ width: 1280.4, height: 820, isMaximized: true }, { width: 900, height: 600 }]) },
  });
  const file = path.join(main.userData, 'window-state.json');
  const first = await firstWindow(main);
  assert.deepEqual([first.options.width, first.options.height, first.maximized], [1280, 820, true]);
  menuItem(main.menu, 'New Window').click();
  const second = await waitFor(() => main.windows[1]?.loads.length && main.windows[1], 'a second window');
  // Saved sizes under 1000×700 fall back to the default.
  assert.deepEqual([second.options.width, second.options.height, second.maximized], [1600, 1000, false]);

  // Each resize restarts a 300 ms timer; the file is written once the resizing stops.
  first.normalBounds = { x: 0, y: 0, width: 1400, height: 900 };
  first.emit('resize');
  await new Promise((resolve) => setTimeout(resolve, 100));
  first.emit('resize');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(main.readJson(file)[0].width, 1280.4);
  await waitFor(() => main.readJson(file)[0].width === 1400, 'the debounced save');
  assert.deepEqual(main.readJson(file), [{ width: 1400, height: 900, isMaximized: true }, { width: 1600, height: 1000, isMaximized: false }]);

  second.normalBounds = { x: 112, y: 112, width: 1100, height: 750 };
  second.close();
  assert.equal(second.destroyed, true);
  assert.deepEqual(main.readJson(file)[1], { width: 1100, height: 750, isMaximized: false });
});

test('a single saved window state from older builds still sizes the first window', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev', userDataFiles: { 'window-state.json': JSON.stringify({ width: 1200, height: 900 }) } });
  const win = await firstWindow(main);
  assert.deepEqual([win.options.width, win.options.height, win.maximized], [1200, 900, false]);
});

test('terminal surfaces replay output, batch data, flush on exit and stay with their window', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  const sender = win.webContents;
  assert.deepEqual(
    await main.invoke('terminal:create', sender, 'term-1', path.join(main.home, 'missing'), 100.7, 30.2),
    { surfaceId: 'term-1', data: '', exited: false },
  );
  const [pty] = main.ptys;
  assert.equal(pty.file, process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
  assert.deepEqual(pty.args, process.platform === 'win32' ? [] : ['-l']);
  assert.deepEqual([pty.options.name, pty.options.cols, pty.options.rows, pty.options.cwd], ['xterm-256color', 100, 30, main.home]);
  assert.deepEqual([pty.options.env.TERM, pty.options.env.COLORTERM, pty.options.env.HOME], ['xterm-256color', 'truecolor', main.home]);

  pty.emitData('hello ');
  pty.emitData('world');
  await waitFor(() => sentOn(sender, 'terminal:').length > 0, 'batched output');
  assert.deepEqual(sentOn(sender, 'terminal:'), [['terminal:data', 'term-1', 'hello world']]);
  // Creating the surface again attaches to the running process.
  assert.deepEqual(await main.invoke('terminal:create', sender, 'term-1', '/', 80, 24),
    { surfaceId: 'term-1', data: 'hello world', exited: false, exitCode: undefined });
  assert.equal(main.ptys.length, 1);

  main.send('terminal:write', sender, 'term-1', 'ls\r');
  main.send('terminal:resize', sender, 'term-1', 1.5, 0.4);
  assert.deepEqual([pty.writes, pty.resizes], [['ls\r'], [[2, 1]]]);
  // Surface ids are scoped to the window that created them.
  const stranger = { id: 99_999, sent: [], send(...args) { this.sent.push(args); }, isDestroyed: () => false };
  main.send('terminal:write', stranger, 'term-1', 'nope');
  assert.deepEqual(pty.writes, ['ls\r']);

  pty.emitData('bye');
  pty.emitExit(3);
  assert.deepEqual(sentOn(sender, 'terminal:').slice(-2), [['terminal:data', 'term-1', 'bye'], ['terminal:exit', 'term-1', 3]]);
  assert.deepEqual(await main.invoke('terminal:create', sender, 'term-1', '/', 80, 24),
    { surfaceId: 'term-1', data: 'hello worldbye', exited: true, exitCode: 3 });
  main.send('terminal:write', sender, 'term-1', 'late');
  assert.deepEqual(pty.writes, ['ls\r']);

  await assert.rejects(main.invoke('terminal:create', sender, 'bad id', '/', 80, 24), /Invalid terminal surface id/);
  main.send('terminal:destroy', sender, 'term-1');
  assert.equal(pty.killed, 1);
  assertKnownEvents(main);
});

test('a sign-in terminal runs the fixed command and keeps its output out of the replay', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const sender = (await firstWindow(main)).webContents;
  await assert.rejects(main.invoke('remote-auth:create', sender, 'auth-1', { scope: 'local', host: '-oProxyCommand=x' }, 80, 24),
    /Invalid remote authentication target/);
  assert.equal(main.ptys.length, 0);
  await main.invoke('remote-auth:create', sender, 'auth-1', { scope: 'local', host: 'build' }, 80, 24);
  const [pty] = main.ptys;
  assert.deepEqual([pty.file, pty.args, pty.options.cwd], [SIGN_IN_COMMANDS.local[0], SIGN_IN_COMMANDS.local.slice(1), main.home]);
  pty.emitData('one-time code');
  await waitFor(() => sentOn(sender, 'terminal:data').length === 1, 'sign-in output');
  assert.equal((await main.invoke('terminal:create', sender, 'auth-1', '/', 80, 24)).data, '');
});

test('closing a window with running terminals asks first, then ends every terminal it owns', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  for (const id of ['a', 'b', 'c']) await main.invoke('terminal:create', win.webContents, id, '/', 80, 24);
  main.ptys[2].emitExit(0);

  main.state.messageBoxResponse = 1;
  win.close();
  await waitFor(() => main.messageBoxes.length === 1, 'the confirmation');
  assert.deepEqual(main.messageBoxes[0], {
    type: 'warning',
    buttons: ['Close anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Active terminals',
    message: '2 terminals still running',
    detail: 'Closing this window will terminate all running processes.',
  });
  assert.equal(win.destroyed, false);
  assert.deepEqual(main.ptys.map((pty) => pty.killed), [0, 0, 0]);

  main.state.messageBoxResponse = 0;
  win.close();
  await waitFor(() => win.destroyed, 'the window to close');
  assert.deepEqual(main.ptys.map((pty) => pty.killed), [1, 1, 1]);
  assert.equal(main.messageBoxes.length, 2);
});

test('a renderer crash ends its terminals and reloads the window a second later', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  await main.invoke('terminal:create', win.webContents, 'a', '/', 80, 24);
  win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  assert.equal(main.ptys[0].killed, 1);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(win.webContents.reloads, 0);
  await waitFor(() => win.webContents.reloads === 1, 'the reload', 3000);
});

test('links leave the app window: web URLs go to the renderer, mail and phone links to the OS', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'https://example.com/a' }), { action: 'deny' });
  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'mailto:someone@example.com' }), { action: 'deny' });
  assert.deepEqual(win.webContents.windowOpenHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });

  const navigate = (url) => {
    const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
    win.webContents.emit('will-navigate', navigation, url);
    return navigation.prevented;
  };
  assert.equal(navigate('http://127.0.0.1:3001/settings'), false, 'same-origin navigation stays');
  assert.equal(navigate('https://example.com/b'), true);
  assert.equal(navigate('tel:+15550100'), true);
  assert.deepEqual(sentOn(win.webContents, 'app:openUrl'), [['app:openUrl', 'https://example.com/a'], ['app:openUrl', 'https://example.com/b']]);
  assert.deepEqual(main.log.filter((entry) => entry.startsWith('shell.openExternal:')),
    ['shell.openExternal:mailto:someone@example.com', 'shell.openExternal:tel:+15550100']);

  main.send('app:openExternal', win.webContents, 'https://example.com/c');
  main.send('app:openExternal', win.webContents, 'file:///etc/passwd');
  assert.equal(main.log.at(-1), 'shell.openExternal:https://example.com/c');
});

test('a shell chord pressed in a Browser pane goes to the renderer with keyboard focus', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  await main.invoke('browser:create', win.webContents, 'web-1', 'p-1', 'https://example.com/');
  const page = main.views[0].webContents;
  page.focus();
  const press = (key, modifiers = {}) => {
    const input = { type: 'keyDown', key, meta: false, control: false, shift: false, alt: false, ...modifiers };
    const keyEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    page.emit('before-input-event', keyEvent, input);
    return keyEvent.prevented;
  };

  // ⌘K on macOS, Ctrl+K elsewhere: the page's own palette.
  assert.equal(press('k', isMac ? { meta: true } : { control: true }), false);
  assert.equal(page.isFocused(), true);
  assert.deepEqual(sentOn(win.webContents, 'browser:shortcut'), []);

  assert.equal(press('Tab', { control: true }), true);
  assert.deepEqual(sentOn(win.webContents, 'browser:shortcut'),
    [['browser:shortcut', 'web-1', { key: 'Tab', meta: false, control: true, shift: false, alt: false }]]);
  // Otherwise the replayed chord moves Michi's focus while typing still reaches the page.
  assert.equal(win.webContents.isFocused(), true);
  assertKnownEvents(main);
});

test('attention records: windows present them while one is open; with none, a claim and then a banner whose click opens the target', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  await waitFor(() => main.backend.streams.size === 1, 'the notification feed');
  const claimed = (id) => main.backend.requests.includes(`POST /api/attention/desktop/notifications/${id}/claim`);

  // A window is open (focused or not): it presents the record itself.
  win.focus();
  main.backend.pushRecord(runRecord('run-1'));
  main.state.focused = null;
  main.backend.pushRecord(runRecord('run-2'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([claimed('attn-run-1'), claimed('attn-run-2'), main.notifications.length], [false, false, 0]);
  assert.deepEqual(sentOn(win.webContents, 'scheduled:'), [], 'no toast from main');

  // No window: claimed, then a banner; its click opens a window on the run.
  win.close();
  main.backend.pushRecord(runRecord('run-3', { kind: 'failed', reason: 'run_failed', body: 'Failed: boom' }));
  const banner = await waitFor(() => main.notifications[0], 'the run-3 banner');
  assert.equal(claimed('attn-run-3'), true);
  assert.deepEqual([banner.options, banner.shown], [{ title: 'Digest', body: 'Failed: boom' }, true]);

  // A claim another window won, or no OS notifications: nothing.
  main.backend.claims.won = false;
  main.backend.pushRecord(runRecord('run-4'));
  await waitFor(() => claimed('attn-run-4'), 'the run-4 claim');
  main.backend.claims.won = true;
  main.state.notificationsSupported = false;
  main.backend.pushRecord(runRecord('run-5'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([claimed('attn-run-5'), main.notifications.length], [false, 1]);
  main.state.notificationsSupported = true;

  banner.emit('click');
  const reopened = await waitFor(() => main.windows[1]?.loads.length && main.windows[1], 'a window for the run');
  assert.deepEqual(reopened.loads,
    ['http://127.0.0.1:3001/?michiWindowId=win-1&michiOpenRun=run-3&michiOpenJob=job-1&michiOpenWorkspace=ws-1&michiOpenNode=n-1']);
  assertKnownEvents(main);
});

test('a resolved record takes its banner down; a newer record of the key gets its own', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  await waitFor(() => main.backend.streams.size === 1, 'the notification feed');
  win.close();
  main.backend.pushRecord(runRecord('run-1', { kind: 'needs_input', reason: 'approval', body: 'Needs your approval' }));
  main.backend.pushRecord(runRecord('run-2', { kind: 'needs_input', reason: 'approval' }));
  await waitFor(() => main.notifications.length === 2, 'two banners');
  // The approval was answered; the run then finished (a newer record of its key).
  main.backend.pushResolved('attn-run-1');
  main.backend.pushRecord(runRecord('run-1', { id: 'attn-run-1-done', body: 'Done' }));
  await waitFor(() => main.notifications.length === 3, 'the finished banner');
  const [approval, other, finished] = main.notifications;
  assert.deepEqual([approval.closed, other.closed, finished.closed], [true, false, false]);
  assert.equal(finished.options.body, 'Done');
});

test('renderer notifications focus the window that raised them and report their key back', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'dev' });
  const win = await firstWindow(main);
  main.send('app:showNotification', win.webContents, 42, 'not a title', { key: 'node:n0' });
  assert.equal(main.notifications.length, 0);
  main.send('app:showNotification', win.webContents, 'Done', 'Reply ready', { key: 'node:n1', silent: true });
  const [notification] = main.notifications;
  assert.deepEqual([notification.options, notification.shown], [{ title: 'Done', body: 'Reply ready', silent: true }, true]);
  notification.emit('click');
  assert.equal(main.state.focused, win);
  assert.deepEqual(sentOn(win.webContents, 'app:attention'), [['app:attentionNotificationClicked', 'node:n1']]);
});

test('a quit a window cancels keeps the app-owned backend; the quit that completes stops it', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged' });
  const win = await firstWindow(main, 2);
  await main.invoke('terminal:create', win.webContents, 'a', '/', 80, 24);
  main.state.messageBoxResponse = 1;
  main.electron.app.quit();
  await waitFor(() => main.messageBoxes.length === 1, 'the running-terminal confirmation');
  assert.equal(main.log.at(-1), 'app.quit:cancelled');
  assert.equal(main.log.includes('backend.kill:SIGTERM'), false, 'the backend keeps serving the window that stayed');
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed');
  const streams = main.backend.requests.filter((request) => request === STREAM).length;

  main.ptys[0].emitExit(0);
  main.electron.app.quit();
  await waitFor(() => main.log.at(-1) === 'app.quit:done', 'the quit');
  assert.ok(main.log.includes('backend.kill:SIGTERM'));
  assert.equal(main.backend.requests.filter((request) => request === STREAM).length, streams, 'the feed did not reconnect');
});

test('a backend that misses its health deadline replaces the skeleton with a message; the feed starts once it is up', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged', ready: false, env: { MICHI_BACKEND_HEALTH_TIMEOUT_MS: '300' } });
  main.backend.setHealthy(false);
  main.ready();
  const win = await waitFor(() => main.windows[0]?.loads.length === 2 && main.windows[0], 'the failure page');
  assert.match(decodeURIComponent(win.loads[1]), /did not start/);
  assert.match(decodeURIComponent(win.loads[1]), new RegExp(main.logDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(fs.readFileSync(path.join(main.logDir, 'electron-main.log'), 'utf8'), /backend did not become ready/);

  // The Dock icon still opens a window, and that one waits for the backend too.
  win.close();
  main.electron.app.emit('activate');
  const second = await waitFor(() => main.windows[1]?.loads.length === 1 && main.windows[1], 'the reopened window');
  assert.match(decodeURIComponent(second.loads[0]), /did not start/);

  main.backend.setHealthy(true);
  main.electron.app.emit('activate');
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed once the backend answers');
});

test('a window asked for before the backend has a port waits for it instead of loading the offline UI', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged', ready: false });
  main.backend.setHealthy(false);
  main.ready();
  // A second launch arrives while startBackend still runs (before the boot window exists).
  main.electron.app.emit('second-instance', {}, []);
  await waitFor(() => main.forks.length === 1, 'the backend fork');
  await waitFor(() => main.windows.length >= 1, 'a window');
  for (const win of main.windows) {
    assert.equal(win.loads.some((load) => typeof load === 'object' && 'file' in load), false, 'no window loads frontend/build');
  }
  main.backend.setHealthy(true);
  const port = Number(main.forks[0].options.env.PORT);
  await waitFor(() => main.windows.length === 2 && main.windows.every((win) => win.loads.at(-1)?.toString().startsWith(`http://127.0.0.1:${port}/`)),
    'both windows on the backend UI');
});

test('closing the skeleton while the backend starts leaves nothing behind', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged', ready: false });
  main.backend.setHealthy(false);
  main.ready();
  const win = await waitFor(() => main.windows[0]?.loads.length === 1 && main.windows[0], 'the skeleton');
  win.close();
  main.backend.setHealthy(true);
  await waitFor(() => main.backend.requests.includes(STREAM), 'the notification feed');
  assert.equal(win.loads.length, 1, 'a closed window is not navigated');
  // Nothing reaches a destroyed window: the next window is a new one, and it gets the UI.
  main.electron.app.emit('activate');
  const port = Number(main.forks[0].options.env.PORT);
  await waitFor(() => main.windows[1]?.loads.at(-1) === `http://127.0.0.1:${port}/?michiWindowId=win-1&michiPackaged=1`, 'the reopened window');
});

test('relaunch stops the app-owned backend before relaunching', BOUNDED, async (t) => {
  const main = await startMain(t, { mode: 'packaged' });
  const win = await firstWindow(main, 2);
  main.send('app:relaunch', win.webContents);
  await waitFor(() => main.log.includes('app.exit:0'), 'the relaunch');
  assert.deepEqual(main.log.filter((entry) => /^(backend\.kill|app\.relaunch|app\.exit)/.test(entry)),
    ['backend.kill:SIGTERM', 'app.relaunch', 'app.exit:0']);
});
