import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isServiceTierId, normalizeAgentModel } from '../src/index';

describe('model speed tiers on the wire', () => {
  test('a model keeps the tiers it lists; malformed entries and empty lists drop', () => {
    const ultrafast = { id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' };
    assert.deepEqual(normalizeAgentModel({ id: 'sol', serviceTiers: [ultrafast, { id: 'Bad Id', name: 'x' }, { id: 'fast' }, null] })?.serviceTiers, [ultrafast]);
    assert.deepEqual(normalizeAgentModel({ id: 'sol', serviceTiers: [{ id: 'fast', name: 'Fast' }] })?.serviceTiers, [{ id: 'fast', name: 'Fast' }]);
    for (const serviceTiers of [[], undefined, 'ultrafast', [{ id: 'x' }]]) {
      assert.equal('serviceTiers' in normalizeAgentModel({ id: 'sol', serviceTiers })!, false);
    }
  });

  test('a tier id is a short lower-case name', () => {
    for (const id of ['ultrafast', 'priority', 'flex_2', 'fast-mode']) assert.equal(isServiceTierId(id), true, id);
    for (const id of ['', 'Ultrafast', '1fast', 'a'.repeat(33), 'ultra fast', null, 7]) assert.equal(isServiceTierId(id), false, String(id));
  });
});
