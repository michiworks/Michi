/**
 * Companion observations: a stable (key-sorted) serialization and its
 * 16-hex SHA-256 fingerprint, and the per-source diff that keeps
 * fingerprintSince while an object stays the same. Pure functions plus one
 * round trip through the repository's snapshot table.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { diffObservations, stableHash, stableStringify } from '../src/services/companion/observations';
import { getSnapshots, putSnapshots, recordMissingSnapshots } from '../src/services/companion/repository';
import type { CompanionSnapshotRecord, Observation } from '../src/services/companion/types';

function observation(objectKey: string, state: Record<string, unknown>, observedAt: number, source: Observation['source'] = 'cr'): Observation {
  return { source, objectKey, fingerprint: stableHash(state), state, observedAt };
}

describe('stable serialization and hash', () => {
  test('object keys are sorted at every depth; arrays keep their order', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}');
    assert.equal(stableStringify([2, 1]), '[2,1]');
    assert.equal(stableStringify('text'), '"text"');
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(true), 'true');
  });

  test('matches JSON for what JSON drops or nulls', () => {
    assert.equal(stableStringify({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 }), '{"d":1}');
    assert.equal(stableStringify([undefined, () => 1, NaN, Infinity]), '[null,null,null,null]');
    assert.equal(stableStringify({ at: new Date(Date.UTC(2026, 10, 5)) }), '{"at":"2026-11-05T00:00:00.000Z"}');
    assert.equal(stableStringify(undefined), 'null');
    const shared = { x: 1 };
    assert.equal(stableStringify({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}', 'a repeated object is not a cycle');
  });

  test('cycles and bigints throw', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => stableStringify(cyclic), /cycle/);
    assert.throws(() => stableStringify({ n: BigInt(1) }), /bigint/);
  });

  test('the hash is the first 16 hex characters of SHA-256, whatever the key order', () => {
    const value = { revision: 3, unresolved: 2, approvals: ['a', 'b'] };
    const hash = stableHash(value);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(hash, createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16));
    assert.equal(stableHash({ approvals: ['a', 'b'], unresolved: 2, revision: 3 }), hash);
    assert.notEqual(stableHash({ ...value, unresolved: 3 }), hash);
    assert.notEqual(stableHash({ ...value, approvals: ['b', 'a'] }), hash, 'array order matters');
  });
});

describe('diffObservations', () => {
  test('sorts a poll into added, changed, unchanged and removed, and yields the snapshots to store', () => {
    const t0 = 1_000;
    const first = diffObservations(new Map(), [observation('cr:1:mine', { rev: 1 }, t0), observation('cr:2:mine', { rev: 1 }, t0)]);
    assert.deepEqual(first.added.map((o) => o.objectKey), ['cr:1:mine', 'cr:2:mine']);
    assert.deepEqual([first.changed, first.unchanged, first.removed], [[], [], []]);
    assert.deepEqual(first.snapshots.map((s) => [s.objectKey, s.firstSeenAt, s.fingerprintSince, s.lastSeenAt]),
      [['cr:1:mine', t0, t0, t0], ['cr:2:mine', t0, t0, t0]]);

    const previous = new Map(first.snapshots.map((s) => [s.objectKey, s]));
    const t1 = 5_000;
    const second = diffObservations(previous, [
      observation('cr:1:mine', { rev: 1 }, t1),
      observation('cr:2:mine', { rev: 2 }, t1),
      observation('cr:3:mine', { rev: 1 }, t1),
    ]);
    assert.deepEqual(second.unchanged.map((c) => c.current.objectKey), ['cr:1:mine']);
    assert.deepEqual(second.changed.map((c) => [c.previous.fingerprint, c.current.fingerprint]), [[stableHash({ rev: 1 }), stableHash({ rev: 2 })]]);
    assert.deepEqual(second.added.map((o) => o.objectKey), ['cr:3:mine']);
    assert.deepEqual(second.removed, []);
    const byKey = new Map(second.snapshots.map((s) => [s.objectKey, s]));
    assert.deepEqual([byKey.get('cr:1:mine')!.firstSeenAt, byKey.get('cr:1:mine')!.fingerprintSince, byKey.get('cr:1:mine')!.lastSeenAt], [t0, t0, t1],
      'an unchanged object keeps the time its fingerprint began');
    assert.deepEqual([byKey.get('cr:2:mine')!.firstSeenAt, byKey.get('cr:2:mine')!.fingerprintSince], [t0, t1], 'a change restarts it');
    assert.deepEqual(byKey.get('cr:2:mine')!.state, { rev: 2 });

    const third = diffObservations(new Map(second.snapshots.map((s) => [s.objectKey, s])), [observation('cr:3:mine', { rev: 1 }, 9_000)]);
    assert.deepEqual(third.removed.map((s) => s.objectKey).sort(), ['cr:1:mine', 'cr:2:mine']);
    assert.deepEqual(third.snapshots.map((s) => s.objectKey), ['cr:3:mine'], 'removed objects are not stored again');
    assert.deepEqual(diffObservations(previous, []).removed.length, 2, 'an empty poll removes everything');
  });

  test('a poll naming an object twice or mixing sources is a bug and throws', () => {
    assert.throws(() => diffObservations(new Map(), [observation('k', { a: 1 }, 1), observation('k', { a: 2 }, 1)]), /twice/);
    assert.throws(() => diffObservations(new Map(), [observation('k', {}, 1, 'cr'), observation('j', {}, 1, 'email')]), /mixes sources/);
    const foreign: CompanionSnapshotRecord = { source: 'email', objectKey: 'k', fingerprint: 'f', state: {}, firstSeenAt: 1, fingerprintSince: 1, lastSeenAt: 1 };
    assert.throws(() => diffObservations(new Map([['k', foreign]]), [observation('k', {}, 2, 'cr')]), /belongs to source email/);
  });
});

describe('snapshot storage', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-observations-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a diff\'s snapshots round-trip per source; removed ones go on their second miss', () => {
    const first = diffObservations(getSnapshots('cr'), [observation('cr:1:mine', { rev: 1, title: '中文' }, 100), observation('cr:2:mine', { rev: 1 }, 100)]);
    putSnapshots(first.snapshots);
    putSnapshots(diffObservations(getSnapshots('email'), [observation('email:c1', { unread: 1 }, 100, 'email')]).snapshots);
    const stored = getSnapshots('cr');
    assert.deepEqual([...stored.keys()].sort(), ['cr:1:mine', 'cr:2:mine']);
    assert.deepEqual(stored.get('cr:1:mine'), first.snapshots[0]);

    const second = diffObservations(stored, [observation('cr:1:mine', { rev: 1, title: '中文' }, 200)]);
    putSnapshots(second.snapshots);
    const removed = second.removed.map((s) => s.objectKey);
    assert.deepEqual(removed, ['cr:2:mine']);
    assert.deepEqual(recordMissingSnapshots('cr', removed), [], 'one miss is not enough');
    assert.deepEqual(recordMissingSnapshots('cr', removed), ['cr:2:mine']);
    const after = getSnapshots('cr');
    assert.deepEqual([...after.keys()], ['cr:1:mine']);
    assert.deepEqual([after.get('cr:1:mine')!.fingerprintSince, after.get('cr:1:mine')!.lastSeenAt], [100, 200]);
    assert.equal(getSnapshots('email').size, 1, 'other sources are untouched');
  });
});
