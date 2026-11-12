/**
 * agentSpawnEnv: what of the backend's environment the processes Michi starts
 * for agents get on desktop, and cloudSubprocessEnv, cloud mode's allowlist.
 * Fixture values only; assertions compare names, so a failure prints no value.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_MICHI_ENV, BACKEND_ENV, agentSpawnEnv, cloudSubprocessEnv } from '../src/agents/agentSpawnEnv';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';

const names = (env: Record<string, string | undefined>) => Object.keys(env).sort();

afterEach(() => __resetRuntimeDeps());

test("keeps only the Crew adapter's MICHI_* and drops the backend's own, PORT and a production NODE_ENV; credentials stay", () => {
  const backendOwn = [
    // What the live remote backend runs with (names seen in an agent shell on 2026-11-08).
    'MICHI_DATA_DIR', 'MICHI_CONFIG_DIR', 'MICHI_REMOTE_ACCESS', 'MICHI_REMOTE_TOKEN', 'MICHI_BIND_HOST', 'MICHI_REQUIRE_AUTH', 'MICHI_CLOUD',
    // What the desktop app gives its backend (electron/main.ts, backgroundService.ts), cloud's key, and settings only the backend reads.
    'MICHI_LOG_DIR', 'MICHI_LAUNCH_CWD', 'MICHI_DEV_RENDERER', 'MICHI_RENDERER_URL', 'MICHI_STARTUP_TRACE', 'MICHI_STARTUP_RUN_ID',
    'MICHI_SERVICE_MODE', 'MICHI_SERVICE_BUILD', 'MICHI_APP_BUNDLE', 'MICHI_ENCRYPTION_KEY', 'MICHI_CLAUDE_BARE', 'MICHI_KIRO_ENGINE',
    // A setting added later is the backend's too.
    'MICHI_NOT_YET_INVENTED',
    'PORT', 'BETTER_AUTH_SECRET',
  ];
  const base: NodeJS.ProcessEnv = {
    ...Object.fromEntries(backendOwn.map((name) => [name, 'fixture'])),
    ...Object.fromEntries(AGENT_MICHI_ENV.map((name) => [name, 'fixture'])),
    NODE_ENV: 'production',
    PATH: '/usr/bin', HOME: '/home/u',
    ANTHROPIC_API_KEY: 'fixture', AWS_PROFILE: 'fixture', CLAUDE_CONFIG_DIR: '/c', KIRO_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture',
    // Only the MICHI_ prefix is the backend's.
    VITE_MICHI_FEATURE: '1', MICHIGAN: 'fixture',
    UNSET: undefined,
  };
  assert.deepEqual(names(agentSpawnEnv(base)), [
    'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'CLAUDE_CONFIG_DIR', 'HOME', 'KIRO_API_KEY',
    'MICHIGAN', 'MICHI_CREW_AGENT', 'MICHI_CREW_APP', 'MICHI_CREW_MCP_DIR', 'MICHI_CREW_MEMORY_MODE',
    'OPENAI_API_KEY', 'PATH', 'VITE_MICHI_FEATURE',
  ]);
  assert.equal(agentSpawnEnv(base).PATH, '/usr/bin');
});

test('the keep-list is what the Crew adapter reads; the other list is PORT and the cloud session secret', () => {
  assert.deepEqual([...AGENT_MICHI_ENV].sort(), ['MICHI_CREW_AGENT', 'MICHI_CREW_APP', 'MICHI_CREW_MCP_DIR', 'MICHI_CREW_MEMORY_MODE']);
  assert.deepEqual([...BACKEND_ENV].sort(), ['BETTER_AUTH_SECRET', 'PORT']);
});

test('only a production NODE_ENV is dropped', () => {
  for (const value of ['development', 'test', 'Production', '']) {
    assert.equal(agentSpawnEnv({ NODE_ENV: value }).NODE_ENV, value, JSON.stringify(value));
  }
  assert.ok(!('NODE_ENV' in agentSpawnEnv({ NODE_ENV: 'production' })));
});

test('names compare in upper case, as Windows environments do', () => {
  assert.deepEqual(names(agentSpawnEnv({
    Michi_Remote_Token: 'fixture', michi_data_dir: '/d', node_env: 'production', Port: '3000', Path: '/bin', Michi_Crew_App: 'fixture',
  })), ['Michi_Crew_App', 'Path']);
});

test('a new object, from process.env by default, read when called; the base is left alone', (t) => {
  const saved = { token: process.env.MICHI_REMOTE_TOKEN, marker: process.env.AGENT_SPAWN_ENV_MARKER };
  t.after(() => {
    for (const [name, value] of [['MICHI_REMOTE_TOKEN', saved.token], ['AGENT_SPAWN_ENV_MARKER', saved.marker]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.MICHI_REMOTE_TOKEN = 'fixture-token';
  process.env.AGENT_SPAWN_ENV_MARKER = 'first';
  const first = agentSpawnEnv();
  assert.ok(first !== (process.env as unknown));
  assert.ok(!('MICHI_REMOTE_TOKEN' in first));
  assert.equal(first.AGENT_SPAWN_ENV_MARKER, 'first');
  process.env.AGENT_SPAWN_ENV_MARKER = 'second';
  assert.equal(agentSpawnEnv().AGENT_SPAWN_ENV_MARKER, 'second');
  assert.equal(process.env.MICHI_REMOTE_TOKEN, 'fixture-token', 'process.env keeps its own');
});

test("cloud: PATH, LANG and NODE_NO_WARNINGS, the owner's extra entries, then HOME at the owner's sandbox", (t) => {
  const saved = { path: process.env.PATH, lang: process.env.LANG, secret: process.env.CLOUD_SPAWN_SECRET };
  t.after(() => {
    for (const [name, value] of [['PATH', saved.path], ['LANG', saved.lang], ['CLOUD_SPAWN_SECRET', saved.secret]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-spawn-env-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  configureRuntimeDeps({ dataDir } as any);
  Object.assign(process.env, { PATH: '/opt/bin', LANG: 'C.UTF-8', CLOUD_SPAWN_SECRET: 'fixture' });
  const home = path.join(dataDir, 'user-cwds', 'owner-1');
  assert.deepEqual(cloudSubprocessEnv('owner-1'), { PATH: '/opt/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1', HOME: home });
  assert.deepEqual(cloudSubprocessEnv('owner-1', { PATH: '/owner/bin', TOKEN: 'owner', HOME: '/elsewhere' }),
    { PATH: '/owner/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1', TOKEN: 'owner', HOME: home }, 'HOME is always the sandbox');
  delete process.env.PATH; delete process.env.LANG;
  assert.deepEqual(cloudSubprocessEnv('owner-1'), { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1', HOME: home });
});
