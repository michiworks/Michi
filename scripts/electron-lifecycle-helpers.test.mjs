// Characterization tests for the helper modules electron/main.ts uses to
// supervise the backend: startup tracing, the attention desktop feed's
// lifecycle and the macOS background service.
// scripts/electron-attention-notifications.test.mjs and
// scripts/electron-background-service.test.mjs cover the rest of the last
// two. Run `npm run electron:build-main` first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const service = require('../electron/dist/backgroundService.js');
const { AttentionDesktopFeed, ATTENTION_DESKTOP_STREAM_PATH } = require('../electron/dist/attentionNotifications.js');
const startupTracePath = require.resolve('../electron/dist/startupTrace.js');

// ── Startup tracing (env is read when metrics.ts loads, so each case runs in its own process) ──

const CONSOLE_LINES = [
  '[renderer] {"type":"startup","name":"first_paint"}',
  '{"type":"metric","name":"frame"}',
  '{"type":"log"}',
  'no json here',
  'prefix {broken',
];

function traceWith(env) {
  const script = `
    const trace = require(${JSON.stringify(startupTracePath)});
    trace.startupMark('probe', { slot: 1 });
    const result = {
      enabled: trace.startupTraceEnabled(),
      runId: trace.startupRunId(),
      url: trace.withStartupTraceQuery('http://127.0.0.1:4100/?michiWindowId=win-0'),
      bare: trace.withStartupTraceQuery('http://127.0.0.1:4100'),
      fileQuery: trace.startupTraceFileQuery() ?? null,
      consoleLines: ${JSON.stringify(CONSOLE_LINES)}.map((line) => trace.isStartupTraceLine(line)),
      childRunId: process.env.MICHI_STARTUP_RUN_ID ?? null,
    };
    process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n');`;
  const stdout = execFileSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const lines = stdout.trim().split('\n');
  const result = JSON.parse(lines.find((line) => line.startsWith('RESULT ')).slice('RESULT '.length));
  return { ...result, marks: lines.filter((line) => !line.startsWith('RESULT ')).map((line) => JSON.parse(line)) };
}

test('with no trace flags URLs pass through untouched and nothing is printed', () => {
  const result = traceWith({});
  assert.deepEqual(result.marks, []);
  assert.equal(result.enabled, false);
  assert.equal(result.url, 'http://127.0.0.1:4100/?michiWindowId=win-0');
  assert.equal(result.bare, 'http://127.0.0.1:4100', 'not even normalized');
  assert.equal(result.fileQuery, null);
  assert.deepEqual(result.consoleLines, [false, false, false, false, false]);
  assert.equal(result.childRunId, null);
});

test('MICHI_STARTUP_TRACE prints marks and tags the renderer URL with the run id', () => {
  const result = traceWith({ MICHI_STARTUP_TRACE: '1', MICHI_STARTUP_RUN_ID: 'run-a' });
  assert.equal(result.enabled, true);
  assert.equal(result.runId, 'run-a');
  assert.equal(result.marks.length, 1);
  const [mark] = result.marks;
  assert.deepEqual({ ...mark, t: 0, pid: 0 }, { type: 'startup', runId: 'run-a', source: 'electron-main', name: 'probe', t: 0, pid: 0, slot: 1 });
  assert.ok(Number.isInteger(mark.t) && Number.isInteger(mark.pid));
  assert.equal(result.url, 'http://127.0.0.1:4100/?michiWindowId=win-0&startupTrace=1&startupRunId=run-a');
  assert.equal(result.bare, 'http://127.0.0.1:4100/?startupTrace=1&startupRunId=run-a');
  assert.deepEqual(result.fileQuery, { startupTrace: '1', startupRunId: 'run-a' });
  // Renderer console lines carrying startup or metric JSON are echoed by main.
  assert.deepEqual(result.consoleLines, [true, true, false, false, false]);
});

test('MICHI_METRICS prefers its own run id and tags the URL without printing startup marks', () => {
  const result = traceWith({ MICHI_METRICS: '1', MICHI_METRICS_RUN_ID: 'm-1', MICHI_STARTUP_RUN_ID: 's-1' });
  assert.deepEqual(result.marks, []);
  assert.equal(result.enabled, false);
  assert.equal(result.runId, 'm-1');
  assert.equal(result.url, 'http://127.0.0.1:4100/?michiWindowId=win-0&metrics=1&metricsRunId=m-1');
  assert.deepEqual(result.fileQuery, { metrics: '1', metricsRunId: 'm-1' });
  assert.deepEqual(result.consoleLines, [true, true, false, false, false]);
  assert.equal(result.childRunId, 's-1');
});

test('a generated run id is exported so the forked backend shares it', () => {
  const result = traceWith({ MICHI_METRICS: '1' });
  assert.match(result.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.equal(result.childRunId, result.runId);
});

test('MICHI_FRAME_METRICS tags the URL with its window but does not echo console lines', () => {
  const result = traceWith({ MICHI_FRAME_METRICS: '1', MICHI_FRAME_METRICS_WINDOW_MS: '500' });
  assert.equal(result.url, 'http://127.0.0.1:4100/?michiWindowId=win-0&frameMetrics=1&frameMetricsWindowMs=500');
  assert.deepEqual(result.fileQuery, { frameMetrics: '1', frameMetricsWindowMs: '500' });
  assert.deepEqual(result.consoleLines, [false, false, false, false, false]);
  assert.equal(result.childRunId, null);
});

// ── Attention desktop feed lifecycle (start after health, restart on handoff, stop on quit) ──

async function feedServer(t, respond = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }) {
  const requests = [];
  const open = new Set();
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      res.end('{}');
      return;
    }
    open.add(res);
    res.on('close', () => open.delete(res));
    respond(res, requests.filter((request) => request.startsWith('GET ')).length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const streams = () => requests.filter((request) => request === `GET ${ATTENTION_DESKTOP_STREAM_PATH}`).length;
  return { port: server.address().port, requests, open, streams };
}

async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const noop = { onSnapshot() {}, onNotification() {}, onResolved() {} };
const record = {
  id: 'attn-1', key: 'node:n-1', kind: 'needs_input', reason: 'approval', title: 'Fix the build', body: 'Run npm test',
  target: { type: 'node', nodeId: 'n-1', workspaceId: 'ws-1' }, createdAt: 1, claimedByWindowId: null, claimedAt: null,
};

test('the feed waits for a backend port and passes on only well-formed frames', async (t) => {
  const backend = await feedServer(t);
  let port = null;
  const seen = [];
  const logs = [];
  const feed = new AttentionDesktopFeed({
    port: () => port,
    onSnapshot: (records) => seen.push(['snapshot', records.map((item) => item.id)]),
    onNotification: (item) => seen.push(['notification', item.id]),
    onResolved: (id) => seen.push(['resolved', id]),
    onChanged: (event) => seen.push(['changed', event.reason]),
    log: (level, message, meta) => logs.push([level, message, meta]),
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
  });
  t.after(() => feed.stop());
  feed.start();
  await sleep(40);
  assert.equal(backend.requests.length, 0);
  port = backend.port;
  await until(() => backend.open.size === 1, 'the stream');
  const [res] = backend.open;
  res.write(`event: attention_snapshot\ndata: ${JSON.stringify({ protocol: 'v1', notifications: [record, { id: 'bad' }] })}\n\n`);
  res.write(`event: attention_snapshot\ndata: ${JSON.stringify({ protocol: 'v2', notifications: [record] })}\n\n`);
  res.write('event: attention_notification\ndata: {not json\n\n');
  res.write(`event: attention_notification\ndata: ${JSON.stringify({ ...record, target: { type: 'elsewhere', workspaceId: 'ws-1' } })}\n\n`);
  res.write(`event: attention_notification\ndata: ${JSON.stringify({ ...record, id: 'attn-2' })}\n\n`);
  res.write(`event: attention_resolved\ndata: ${JSON.stringify({ id: 'attn-1', key: 'node:n-1', reason: 'answered' })}\n\n`);
  res.write('event: companion_changed\ndata: {"type":"companion_changed","revision":2,"reason":"items"}\n\n');
  res.write('event: other\ndata: {"id":"x"}\n\n');
  await until(() => seen.length === 4, 'the frames');
  assert.deepEqual(seen, [['snapshot', ['attn-1']], ['notification', 'attn-2'], ['resolved', 'attn-1'], ['changed', 'items']],
    'a snapshot of another protocol and a target this build cannot place are dropped');
  assert.deepEqual(logs, [['INFO', 'attention desktop feed connected', { port: backend.port }]]);
});

test('a refused stream is retried until the backend accepts it, logged once per status', async (t) => {
  const backend = await feedServer(t, (res, attempt) => {
    if (attempt <= 2) {
      res.writeHead(404);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    }
  });
  const logs = [];
  let connected = 0;
  const feed = new AttentionDesktopFeed({
    port: () => backend.port,
    ...noop,
    onConnected: () => { connected += 1; },
    log: (level, message, meta) => logs.push([level, message, meta]),
    reconnectBaseMs: 5,
    refusedRetryMs: 5,
  });
  t.after(() => feed.stop());
  feed.start();
  await until(() => logs.some(([level]) => level === 'INFO'), 'the connection');
  assert.equal(backend.streams(), 3);
  assert.equal(connected, 1);
  assert.deepEqual(logs.map(([level, message, meta]) => [level, message, meta.status ?? meta.port]), [
    ['WARN', 'attention desktop feed refused', 404],
    ['INFO', 'attention desktop feed connected', backend.port],
  ]);
});

test('start is idempotent, restart reconnects once at once, and stop ends the stream for good', async (t) => {
  const backend = await feedServer(t);
  const feed = new AttentionDesktopFeed({ port: () => backend.port, ...noop, reconnectBaseMs: 5 });
  t.after(() => feed.stop());
  feed.start();
  feed.start();
  await until(() => backend.open.size === 1, 'the stream');
  await sleep(50);
  assert.equal(backend.streams(), 1);

  // The replaced connection's close must not schedule another one.
  feed.restart();
  await until(() => backend.streams() === 2, 'the restarted stream');
  await sleep(80);
  assert.equal(backend.streams(), 2);

  feed.stop();
  await until(() => backend.open.size === 0, 'the stream to close');
  await sleep(80);
  assert.equal(backend.streams(), 2);
  feed.start();
  await until(() => backend.streams() === 3, 'a new stream');
});

test('a claim posts the encoded record id and reads the answer; without a backend port, or on a refusal, it is no claim', async (t) => {
  const backend = await feedServer(t);
  let port = null;
  const feed = new AttentionDesktopFeed({ port: () => port, ...noop });
  assert.equal(await feed.claim('attn-0'), false);
  port = backend.port;
  assert.equal(await feed.claim('attn/1 x'), false, 'the test server answers {} : not claimed');
  assert.deepEqual(backend.requests, ['POST /api/attention/desktop/notifications/attn%2F1%20x/claim']);
});

// ── Background service (macOS LaunchAgent) ──

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-service-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function launchctl(codes = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const code = typeof codes[args[0]] === 'function' ? codes[args[0]](calls) : codes[args[0]] ?? 0;
    return { code, stdout: codes.stdout ?? '', stderr: codes.stderr ?? '' };
  };
  return { run, calls };
}

test('stopping a service launchd has not loaded skips bootout; the plist goes only when asked', async (t) => {
  const plistFile = path.join(tempDir(t), 'com.michi.backend.plist');
  fs.writeFileSync(plistFile, 'x');
  const kept = launchctl({ print: 113 });
  await service.stopService({ run: kept.run, uid: 501, plistFile, delay: async () => {} });
  assert.deepEqual(kept.calls, [['print', 'gui/501/com.michi.backend']]);
  assert.ok(fs.existsSync(plistFile));

  const removed = launchctl({ print: 113 });
  await service.stopService({ run: removed.run, uid: 501, plistFile, removePlist: true, delay: async () => {} });
  assert.deepEqual(removed.calls, [['print', 'gui/501/com.michi.backend']]);
  assert.equal(fs.existsSync(plistFile), false);
});

test('stopping waits for launchd to unload the service, but only until its timeout', { timeout: 5000 }, async (t) => {
  const plistFile = path.join(tempDir(t), 'com.michi.backend.plist');
  const { run, calls } = launchctl({ print: 0 });
  const delays = [];
  await service.stopService({
    run, uid: 501, plistFile, unloadTimeoutMs: 40,
    delay: (ms) => { delays.push(ms); return sleep(5); },
  });
  assert.equal(calls.filter(([verb]) => verb === 'bootout').length, 1);
  assert.ok(calls.filter(([verb]) => verb === 'print').length >= 3);
  assert.ok(delays.length >= 2 && delays.every((ms) => ms === 250));
});

test('install loads the rendered plist under the spec label and enables it', async (t) => {
  const dir = tempDir(t);
  const plistFile = path.join(dir, 'LaunchAgents', 'com.example.test.plist');
  const spec = service.buildServiceLaunchSpec({
    nodeExecPath: '/opt/node', entry: '/srv/server.js', port: 4100, logDir: path.join(dir, 'logs'),
    bundlePath: null, build: 'b1', baseEnv: {}, label: 'com.example.test',
  });
  const { run, calls } = launchctl({ print: 113 });
  await service.installAndStartService({ spec, run, uid: 501, plistFile, delay: async () => {} });
  assert.deepEqual(calls, [
    ['print', 'gui/501/com.example.test'],
    ['bootstrap', 'gui/501', plistFile],
    ['enable', 'gui/501/com.example.test'],
  ]);
  assert.equal(fs.readFileSync(plistFile, 'utf8'), service.renderPlist(spec));
});

test('a bootstrap that keeps failing reports launchctl output and never enables', async (t) => {
  const dir = tempDir(t);
  const spec = service.buildServiceLaunchSpec({
    nodeExecPath: '/opt/node', entry: '/srv/server.js', port: 4100, logDir: dir, bundlePath: null, build: 'b1', baseEnv: {},
  });
  const delays = [];
  const { run, calls } = launchctl({ print: 113, bootstrap: 5, stdout: ' service already loaded \n' });
  await assert.rejects(
    service.installAndStartService({ spec, run, uid: 501, plistFile: path.join(dir, 'a.plist'), delay: async (ms) => { delays.push(ms); } }),
    { message: 'launchctl bootstrap failed (5): service already loaded' },
  );
  assert.deepEqual(calls.map(([verb]) => verb), ['print', 'bootstrap', 'bootstrap']);
  assert.deepEqual(delays, [1000]);
});

test('the service environment is the fixed loopback settings plus an allowlist of the app environment', () => {
  const spec = service.buildServiceLaunchSpec({
    nodeExecPath: '/opt/helper', entry: '/srv/server.js', port: 51234, logDir: '/logs',
    bundlePath: '/Applications/michi.app', build: '1.0.0-1',
    baseEnv: {
      PATH: '/opt/bin:/usr/bin', HOME: '/Users/t', USER: 't', LOGNAME: 't', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
      LC_ALL: 'C', LC_CTYPE: 'UTF-8', TMPDIR: '', MICHI_DATA_DIR: '/data', MICHI_CONFIG_DIR: '/cfg',
      MICHI_ENABLED_RUNTIMES: 'kiro,claude', MICHI_CUSTOM_AGENTS: 'a', KIRO_CLI_BIN: '/opt/kiro',
      // Never forwarded: the service's own settings win, and secrets stay out of the plist.
      PORT: '1', MICHI_BIND_HOST: '0.0.0.0', MICHI_REMOTE_ACCESS: '1', MICHI_SERVICE_MODE: '0',
      ELECTRON_RUN_AS_NODE: '0', NODE_OPTIONS: '--inspect', MICHI_REMOTE_TOKEN: 'secret',
    },
  });
  assert.deepEqual(spec, {
    label: 'com.michi.backend',
    program: '/opt/helper',
    args: ['/srv/server.js'],
    env: {
      ELECTRON_RUN_AS_NODE: '1', PORT: '51234', MICHI_LOG_DIR: '/logs', MICHI_BIND_HOST: '127.0.0.1',
      MICHI_REMOTE_ACCESS: '0', MICHI_SERVICE_MODE: '1', MICHI_SERVICE_BUILD: '1.0.0-1',
      PATH: '/opt/bin:/usr/bin', HOME: '/Users/t', USER: 't', LOGNAME: 't', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
      LC_ALL: 'C', LC_CTYPE: 'UTF-8', MICHI_DATA_DIR: '/data', MICHI_CONFIG_DIR: '/cfg',
      MICHI_ENABLED_RUNTIMES: 'kiro,claude', MICHI_CUSTOM_AGENTS: 'a', KIRO_CLI_BIN: '/opt/kiro',
      MICHI_APP_BUNDLE: '/Applications/michi.app',
    },
    workingDirectory: '/',
    stdoutPath: '/logs/service.out.log',
    stderrPath: '/logs/service.err.log',
  });
});

test('without PATH, HOME or an app bundle the service falls back to system defaults', () => {
  const spec = service.buildServiceLaunchSpec({
    nodeExecPath: '/opt/helper', entry: '/srv/server.js', port: 4100, logDir: '/logs', bundlePath: null, build: 'b', baseEnv: {},
  });
  assert.equal(spec.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(spec.env.HOME, os.homedir());
  assert.equal('MICHI_APP_BUNDLE' in spec.env, false);
});

test('the plist sorts the environment and escapes every value', () => {
  const plist = service.renderPlist({
    label: 'com.example.test',
    program: '/opt/node',
    args: ['/srv/a&b.js'],
    env: { ZED: '1', ALPHA: `<'">` },
    workingDirectory: '/',
    stdoutPath: '/logs/out.log',
    stderrPath: '/logs/err.log',
  });
  assert.equal(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.test</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node</string>
    <string>/srv/a&amp;b.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ALPHA</key>
    <string>&lt;&apos;&quot;&gt;</string>
    <key>ZED</key>
    <string>1</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>/logs/out.log</string>
  <key>StandardErrorPath</key>
  <string>/logs/err.log</string>
</dict>
</plist>
`);
});

test('service files live under the home directory and state is replaced atomically', (t) => {
  assert.deepEqual(service.servicePaths('/Users/t'), {
    stateFile: '/Users/t/.michi/service.json',
    plistFile: '/Users/t/Library/LaunchAgents/com.michi.backend.plist',
  });
  assert.equal(service.servicePaths('/Users/t', 'com.example.test').plistFile, '/Users/t/Library/LaunchAgents/com.example.test.plist');

  const dir = tempDir(t);
  const file = path.join(dir, 'service.json');
  service.writeServiceState(file, { enabled: true, port: 4100 });
  service.writeServiceState(file, { enabled: false, port: 4100 });
  assert.deepEqual(fs.readdirSync(dir), ['service.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "enabled": false,\n  "port": 4100\n}\n');
  for (const content of ['not json', '[]', '{"enabled":true,"port":0}', '{"enabled":true,"port":1.5}', '{"enabled":true,"port":"4100"}']) {
    fs.writeFileSync(file, content);
    assert.equal(service.readServiceState(file), null, content);
  }
  fs.writeFileSync(file, '{"enabled":true,"port":4100,"extra":1}');
  assert.deepEqual(service.readServiceState(file), { enabled: true, port: 4100 });
});

test('the build stamp follows the app bundle mtime', (t) => {
  const dir = tempDir(t);
  fs.utimesSync(dir, 1_700_000_000, 1_700_000_000);
  assert.equal(service.serviceBuildStamp(dir, '2.0.0'), '2.0.0-1700000000000');
  assert.equal(service.appBundlePath('/Applications/michi.app/Contents/Frameworks/michi Helper.app/Contents/MacOS/michi Helper'), '/Applications/michi.app');
});

test('launchctl that cannot start reports exit code 1 instead of throwing', { skip: fs.existsSync('/bin/launchctl') && 'launchctl exists here' }, async () => {
  assert.deepEqual(await service.runLaunchctl(['print', 'gui/501/com.michi.backend']), { code: 1, stdout: '', stderr: '' });
});
