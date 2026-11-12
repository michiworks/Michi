import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import dotenv from 'dotenv';
import { loadMichiDotenv } from '../src/bootEnv';

const backendRoot = path.resolve(__dirname, '..');
// The same file scripts/electron-background-service.test.mjs gives the backend the app forks.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'michiDotenv.json'), 'utf8')) as {
  dotenv: string;
  parsed: Record<string, string>;
  dropped: string[];
};

function homeWith(content: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-boot-env-'));
  fs.mkdirSync(path.join(home, '.michi'));
  fs.writeFileSync(path.join(home, '.michi', '.env'), content);
  return home;
}

test('the background service reads ~/.michi/.env as the app reads it for the backend it forks', () => {
  // backend/.env's reader agrees on the format.
  assert.deepEqual(dotenv.parse(fixture.dotenv), fixture.parsed);
  // What launchd starts the service with (electron/backgroundService.ts buildServiceLaunchSpec).
  const plist = { PORT: '51234', MICHI_LOG_DIR: '/Users/test/.michi/logs', MICHI_BIND_HOST: '127.0.0.1', MICHI_REMOTE_ACCESS: '0', MICHI_SERVICE_MODE: '1', EMPTY: 'from-plist' };
  const env: NodeJS.ProcessEnv = { ...plist };
  loadMichiDotenv(env, homeWith(fixture.dotenv));
  const expected: Record<string, string> = { ...fixture.parsed, ...plist };
  for (const key of fixture.dropped) delete expected[key];
  assert.deepEqual(env, expected);
});

test('without the file the service keeps its environment', () => {
  const env: NodeJS.ProcessEnv = { PORT: '51234' };
  loadMichiDotenv(env, fs.mkdtempSync(path.join(os.tmpdir(), 'michi-boot-env-')));
  assert.deepEqual(env, { PORT: '51234' });
});

test('server.ts loads it first, so settings read at import see the file', () => {
  const server = fs.readFileSync(path.join(backendRoot, 'src', 'server.ts'), 'utf8');
  assert.equal(server.match(/^import\s+(?:[^;]*?\sfrom\s+)?['"]([^'"]+)['"]/m)?.[1], './bootEnv');

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-boot-env-config-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ prefs: { uiFont: 'Inter' } }));
  const home = homeWith(`MICHI_CONFIG_DIR=${configDir}\nMICHI_KIRO_MAX_PROCESSES=7\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MICHI_SERVICE_MODE: '1', TS_NODE_TRANSPILE_ONLY: '1' };
  delete env.MICHI_CONFIG_DIR;
  delete env.MICHI_KIRO_MAX_PROCESSES;
  // prefsConfig and michiKiroOptions resolve these when they load.
  const script = [
    "require('./src/bootEnv');",
    "const { readPrefs } = require('./src/services/prefsConfig');",
    "const { kiroEnvOptions } = require('./src/agents/michiKiroOptions');",
    'process.stdout.write(JSON.stringify({ prefs: readPrefs(), processCap: kiroEnvOptions().processCap }));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--require', 'ts-node/register', '-e', script], { cwd: backendRoot, env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { prefs: { uiFont: 'Inter' }, processCap: 7 });
});
