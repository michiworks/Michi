/**
 * The backend follows the desktop app that forked it (services/parentDisconnect.ts):
 * when the app's IPC channel closes without a SIGTERM, the backend shuts down.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shutdownWhenParentDisconnects } from '../src/services/parentDisconnect';

const BACKEND_DIR = path.resolve(__dirname, '..');

function fakeProcess(link: { send?: () => boolean; connected: boolean }) {
  return Object.assign(new EventEmitter(), link) as unknown as NodeJS.Process & EventEmitter;
}

describe('a backend forked with an IPC channel', () => {
  test('shuts down once when the channel closes', () => {
    const proc = fakeProcess({ send: () => true, connected: true });
    let shutdowns = 0;
    shutdownWhenParentDisconnects(() => { shutdowns += 1; }, () => false, proc);
    assert.equal(shutdowns, 0);
    proc.emit('disconnect');
    proc.emit('disconnect');
    assert.equal(shutdowns, 1);
  });

  test('leaves a shutdown already under way to finish', () => {
    const proc = fakeProcess({ send: () => true, connected: true });
    let shutdowns = 0;
    shutdownWhenParentDisconnects(() => { shutdowns += 1; }, () => true, proc);
    proc.emit('disconnect');
    assert.equal(shutdowns, 0);
  });

  test('shuts down at once when the channel had already closed', () => {
    let shutdowns = 0;
    shutdownWhenParentDisconnects(() => { shutdowns += 1; }, () => false, fakeProcess({ send: () => true, connected: false }));
    assert.equal(shutdowns, 1);
  });

  test('a backend started without IPC has no parent to follow', () => {
    const proc = fakeProcess({ connected: false });
    let shutdowns = 0;
    shutdownWhenParentDisconnects(() => { shutdowns += 1; }, () => false, proc);
    assert.equal(proc.listenerCount('disconnect'), 0);
    assert.equal(shutdowns, 0);
  });

  test('a real forked child shuts down when its parent drops the channel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-parent-disconnect-'));
    const script = path.join(dir, 'child.js');
    fs.writeFileSync(script, `
      const { shutdownWhenParentDisconnects } = require(${JSON.stringify(path.join(BACKEND_DIR, 'src/services/parentDisconnect'))});
      shutdownWhenParentDisconnects(() => { console.log('shutdown'); process.exit(0); }, () => false);
      process.send('ready');
      setTimeout(() => { console.log('timed out'); process.exit(2); }, 20000);
    `);
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const child = fork(script, [], {
      cwd: BACKEND_DIR,
      execArgv: ['--require', 'ts-node/register'],
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk; });
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', (code) => reject(new Error(`child exited ${code} before it was ready: ${stderr}`)));
    });
    child.disconnect();
    assert.equal(await exited, 0, stderr);
    assert.equal(stdout, 'shutdown\n');
  });
});
