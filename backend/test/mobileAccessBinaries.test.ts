import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTailscaleBinary } from '../src/services/tailscaleMobileAccess';

const providers = [
  { resolve: resolveTailscaleBinary, override: 'MICHI_TAILSCALE_BIN', name: 'tailscale' },
] as const;

for (const { resolve, override, name } of providers) {
  test(`${name}: an override is final and must be an executable regular file; PATH skips folders`, { skip: process.platform === 'win32' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-mobile-binary-'));
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, [override]: process.env[override] };
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const folderDir = path.join(dir, 'a'), binDir = path.join(dir, 'b');
    fs.mkdirSync(path.join(folderDir, name), { recursive: true });
    fs.mkdirSync(binDir);
    const executable = path.join(binDir, name), plain = path.join(dir, 'plain');
    fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(plain, '', { mode: 0o644 });
    process.env.PATH = `${folderDir}${path.delimiter}${binDir}`;
    process.env.HOME = dir;

    delete process.env[override];
    assert.equal(resolve(), executable);
    process.env[override] = executable;
    assert.equal(resolve(), executable);
    for (const bad of [path.join(dir, 'missing'), plain, path.join(folderDir, name)]) {
      process.env[override] = bad;
      assert.equal(resolve(), null, bad);
    }
  });
}
