import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createTakeoverBridges, noteTakeoverBridges, takeoverBridged } from '../src/services/takeoverBridges';

/** Bridges an older window's chunk left behind (domainCommands.ts): bounded, pruned, per owner. */
describe('takeover bridges', () => {
  const none = new Set<string>();
  const byName = (entries: Record<string, string[]>) => new Map(Object.entries(entries));
  /** Holder ids kept, per owner and sender. */
  const kept = (bridges: ReturnType<typeof createTakeoverBridges>) => Object.fromEntries(
    [...bridges.owners].map(([owner, senders]) => [owner, Object.fromEntries([...senders].map(([sender, holders]) => [sender, [...holders.keys()]]))]),
  );

  test('keeps at most holdersPerName per skipped name (the exact name first) and perSender per sender, the oldest dropped', () => {
    const bridges = createTakeoverBridges({ holdersPerName: 2, perSender: 3 });
    noteTakeoverBridges(bridges, 'alice', 'w1', byName({ notes: ['exact', 'Case-1', 'Case-2'] }), none, 1_000);
    assert.deepEqual(kept(bridges), { alice: { w1: ['exact', 'Case-1'] } });
    noteTakeoverBridges(bridges, 'alice', 'w1', byName({ plan: ['p'], spec: ['s'] }), none, 2_000);
    assert.deepEqual(kept(bridges), { alice: { w1: ['Case-1', 'p', 's'] } });
    // A holder noted again (any number of skipped writes under its name) is one entry, refreshed.
    noteTakeoverBridges(bridges, 'alice', 'w2', byName({ notes: ['exact', 'exact'] }), none, 3_000);
    noteTakeoverBridges(bridges, 'alice', 'w2', byName({ Notes: ['exact'] }), none, 3_001);
    assert.deepEqual(kept(bridges).alice.w2, ['exact']);
    assert.equal(bridges.owners.get('alice')?.get('w2')?.get('exact'), 3_001);
  });

  test('keeps at most sendersPerOwner per owner, the least recently written dropped; another owner\'s are never touched', () => {
    const bridges = createTakeoverBridges({ sendersPerOwner: 2 });
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({ notes: ['c'] }), none, 1_000);
    for (let i = 0; i < 50; i += 1) noteTakeoverBridges(bridges, 'bob', `b${i}`, byName({ notes: [`d${i}`] }), none, 1_000 + i);
    noteTakeoverBridges(bridges, 'alice', 'a2', byName({ plan: ['p'] }), none, 2_000);
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({ spec: ['s'] }), none, 2_001);
    noteTakeoverBridges(bridges, 'alice', 'a3', byName({ todo: ['t'] }), none, 2_002);
    assert.deepEqual(kept(bridges), { alice: { a1: ['c', 's'], a3: ['t'] }, bob: { b48: ['d48'], b49: ['d49'] } });
    assert.equal(takeoverBridged(bridges, 'alice', 'a1', 'c', 2_010), true);
    assert.equal(takeoverBridged(bridges, 'bob', 'a1', 'c', 2_010), false);
  });

  test('holds only within the TTL; a write prunes its owner\'s expired entries, and a sweep every TTL everyone\'s', () => {
    const bridges = createTakeoverBridges({ ttlMs: 1_000 });
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({ notes: ['old'] }), none, 0);
    noteTakeoverBridges(bridges, 'bob', 'b1', byName({ notes: ['his'] }), none, 0);
    assert.equal(takeoverBridged(bridges, 'alice', 'a1', 'old', 1_000), true);
    assert.equal(takeoverBridged(bridges, 'alice', 'a1', 'old', 1_001), false);
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({ plan: ['new'] }), none, 999);
    // Not yet a TTL since the last sweep, and still within it: kept.
    assert.deepEqual(kept(bridges), { alice: { a1: ['old', 'new'] }, bob: { b1: ['his'] } });
    noteTakeoverBridges(bridges, 'alice', 'a2', byName({ spec: ['s'] }), none, 1_500);
    // The sweep (a TTL since the last) drops bob's, gone for good; alice's own expired entry goes too.
    assert.deepEqual(kept(bridges), { alice: { a1: ['new'], a2: ['s'] } });
    assert.equal(bridges.sweptAt, 1_500);
    noteTakeoverBridges(bridges, 'carol', 'c1', byName({ notes: ['x'] }), none, 2_100);
    // No sweep yet (600 ms since): alice's expired entries stay until a write of hers or the next sweep.
    assert.deepEqual(Object.keys(kept(bridges)).sort(), ['alice', 'carol']);
    noteTakeoverBridges(bridges, 'carol', 'c1', byName({}), none, 2_600);
    assert.deepEqual(kept(bridges), { carol: { c1: ['x'] } });
  });

  test('a spent bridge is gone; spending or noting nothing for an unknown sender keeps nothing', () => {
    const bridges = createTakeoverBridges();
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({ notes: ['c', 'C2'] }), none, 1_000);
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({}), new Set(['c']), 1_100);
    assert.deepEqual(kept(bridges), { alice: { a1: ['C2'] } });
    noteTakeoverBridges(bridges, 'alice', 'a1', byName({}), new Set(['C2']), 1_200);
    assert.deepEqual(kept(bridges), {});
    noteTakeoverBridges(bridges, 'bob', 'b1', byName({ notes: [] }), new Set(['c']), 1_300);
    assert.deepEqual(kept(bridges), {});
  });
});
