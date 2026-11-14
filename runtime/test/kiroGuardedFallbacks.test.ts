/**
 * The mode a Kiro chat left for a guarded turn's fallback (lane D): kept by
 * native session id in a file under the host's data directory, so a restart
 * between the guarded turn and the next does not lose it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kiroGuardedFallbacks } from '../src/adapters/kiro/kiroGuardedFallbacks';

test('set, get and delete, across store objects on the same folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-fallbacks-'));
  const store = kiroGuardedFallbacks(() => dir);
  assert.equal(store.get('s1'), undefined);
  store.set('s1', 'autonomous');
  store.set('s2', null);
  assert.deepEqual(kiroGuardedFallbacks(() => dir).get('s1'), { base: 'autonomous' });
  assert.deepEqual(kiroGuardedFallbacks(() => dir).get('s2'), { base: null }, 'Kiro\'s default');
  store.delete('s1');
  store.delete('missing');
  assert.equal(kiroGuardedFallbacks(() => dir).get('s1'), undefined);
});

test('a missing or broken file reads as empty; the oldest entries go past the bound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-fallbacks-'));
  const store = kiroGuardedFallbacks(() => path.join(dir, 'not-yet'));
  assert.equal(store.get('s'), undefined);
  fs.writeFileSync(path.join(dir, 'kiro-guarded-fallbacks.json'), '{ broken');
  assert.equal(kiroGuardedFallbacks(() => dir).get('s'), undefined);
  const bounded = kiroGuardedFallbacks(() => dir);
  for (let index = 0; index < 505; index += 1) bounded.set(`s${index}`, 'autonomous', index);
  assert.equal(bounded.get('s0'), undefined);
  assert.deepEqual(bounded.get('s504'), { base: 'autonomous' });
});
