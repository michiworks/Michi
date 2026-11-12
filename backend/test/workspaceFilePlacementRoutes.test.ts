import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import { closeDb } from '../src/services/db';
import { JSON_BODY_LIMIT_BYTES } from '../src/services/requestBodyLimit';
import { trySymlinkSync } from './symlinkUtil';

const savedEnv = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let root: string; let cwd: string; let outside: string;
let server: Server; let base: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-file-placement-'));
  cwd = path.join(root, 'ws'); outside = path.join(root, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside);
  process.env.MICHI_DATA_DIR = path.join(root, 'data'); delete process.env.MICHI_CLOUD; closeDb();
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  app.use('/api', setupMichiRoutes({} as ChatManager));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  mock.restoreAll(); server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve())); closeDb();
  if (savedEnv.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = savedEnv.data;
  if (savedEnv.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = savedEnv.cloud;
  fs.rmSync(root, { recursive: true, force: true });
});

async function post(route: string, body: unknown) {
  const response = await fetch(`${base}/workspaces/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function source(name: string, content = 'hello'): string {
  const file = path.join(outside, name);
  fs.writeFileSync(file, content);
  return file;
}

test('import-file sanitises the name, avoids collisions and allowlists the subdir', async () => {
  const first = await post('import-file', { cwd, originalName: 'a b.txt', content: 'one' });
  assert.deepEqual(first, { status: 200, body: { name: 'a_b', displayName: 'a b.txt', filePath: '.contexts/a_b.txt', size: 3 } });
  const second = await post('import-file', { cwd, originalName: 'a b.txt', content: 'two', subdir: '../escape' });
  assert.deepEqual(second.body, { name: 'a_b-1', displayName: 'a b.txt', filePath: '.contexts/a_b-1.txt', size: 3 });
  const image = await post('import-file', {
    cwd, originalName: '/x/../??.p*ng', contentBase64: Buffer.from('png').toString('base64'), subdir: '.attachments',
  });
  assert.deepEqual(image.body, { name: '__', displayName: '??.p*ng', filePath: '.attachments/__.png', size: 3 });
  assert.equal(fs.readFileSync(path.join(cwd, '.contexts/a_b-1.txt'), 'utf8'), 'two');
  assert.equal(fs.readFileSync(path.join(cwd, '.attachments/__.png'), 'utf8'), 'png');
});

test('import-file caps text at 1,000,000 characters and decoded bytes at 20,000,000', async () => {
  const text = await post('import-file', { cwd, originalName: 'big.txt', content: 'x'.repeat(1_000_001) });
  assert.equal(text.status, 413);
  const binary = await post('import-file', {
    cwd, originalName: 'big.bin', contentBase64: Buffer.alloc(20_000_001).toString('base64'),
  });
  assert.equal(binary.status, 413);
  assert.equal(fs.existsSync(path.join(cwd, '.contexts')), false);
});

test('copy-file copies into the allowlisted subdir and caps the source at 20,000,000 bytes', async () => {
  const file = source('report final.pdf');
  const first = await post('copy-file', { cwd, sourcePath: file, subdir: '.attachments' });
  assert.deepEqual(first, { status: 200, body: { name: 'report_final', displayName: 'report final.pdf', filePath: '.attachments/report_final.pdf', size: 5 } });
  const second = await post('copy-file', { cwd, sourcePath: file, subdir: 'elsewhere' });
  assert.deepEqual(second.body, { name: 'report_final', displayName: 'report final.pdf', filePath: '.contexts/report_final.pdf', size: 5 });
  const third = await post('copy-file', { cwd, sourcePath: file, subdir: '.attachments' });
  assert.equal(third.body.filePath, '.attachments/report_final-1.pdf');
  assert.equal(fs.lstatSync(path.join(cwd, '.attachments/report_final-1.pdf')).isSymbolicLink(), false);

  const big = path.join(outside, 'big.bin');
  fs.writeFileSync(big, ''); fs.truncateSync(big, 20_000_001);
  assert.equal((await post('copy-file', { cwd, sourcePath: big })).status, 413);
});

test('link-file links into .artifacts and falls back to a copy when symlinks are refused', async (t) => {
  const file = source('notes.md');
  if (!trySymlinkSync(file, path.join(root, 'probe'))) return t.skip('host forbids symlinks');
  const linked = await post('link-file', { cwd, sourcePath: file, subdir: '.contexts' });
  assert.deepEqual(linked, { status: 200, body: { name: 'notes', displayName: 'notes.md', filePath: '.artifacts/notes.md', size: 5 } });
  assert.equal(fs.readlinkSync(path.join(cwd, '.artifacts/notes.md')), file);

  mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
  const copied = await post('link-file', { cwd, sourcePath: file });
  assert.deepEqual(copied.body, { name: 'notes-1', displayName: 'notes.md', filePath: '.artifacts/notes-1.md', size: 5 });
  assert.equal(fs.lstatSync(path.join(cwd, '.artifacts/notes-1.md')).isSymbolicLink(), false);
});

test('a dangling link already in the subdir is skipped, never written through', async (t) => {
  const moved = path.join(outside, 'moved');
  fs.mkdirSync(moved);
  const cases: Array<[string, string, (sourcePath: string) => Record<string, unknown>]> = [
    ['link-file', '.artifacts', (sourcePath) => ({ cwd, sourcePath })],
    ['copy-file', '.contexts', (sourcePath) => ({ cwd, sourcePath })],
    ['import-file', '.attachments', () => ({ cwd, originalName: 'report.pdf', content: 'new', subdir: '.attachments' })],
  ];
  for (const [route, subdir, body] of cases) {
    const stale = path.join(moved, `${route}-report.pdf`);
    fs.mkdirSync(path.join(cwd, subdir), { recursive: true });
    if (!trySymlinkSync(stale, path.join(cwd, subdir, 'report.pdf'))) return t.skip('host forbids symlinks');
    const response = await post(route, body(source('report.pdf', 'new')));
    assert.equal(response.status, 200, route);
    assert.equal(response.body.filePath, `${subdir}/report-1.pdf`, route);
    assert.equal(fs.existsSync(stale), false, `${route} wrote through the dangling link`);
  }
});
