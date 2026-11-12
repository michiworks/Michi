import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../src/contract/events';
import { discardBackgroundTurn } from '../src/core/backgroundTurns';
import * as root from '../src/index';

test('the package root exports discardBackgroundTurn', () => {
  assert.equal(root.discardBackgroundTurn, discardBackgroundTurn);
});

test('a discarded background turn is cancelled first, then drained to its end', async () => {
  const steps: string[] = [];
  const events = (async function* (): AsyncIterableIterator<NormalizedEvent> {
    steps.push('read');
    yield { kind: 'chunk', text: 'unseen' };
    yield { kind: 'turn_end', stopReason: 'cancelled' };
    steps.push('drained');
  })();
  await discardBackgroundTurn({ events, cancel: () => { steps.push('cancel'); } });
  assert.deepEqual(steps, ['cancel', 'read', 'drained']);
});

test('a failing cancel or stream still ends the discard', async () => {
  let drained = false;
  const events = (async function* (): AsyncIterableIterator<NormalizedEvent> {
    drained = true;
    throw new Error('stream broke');
  })();
  await discardBackgroundTurn({ events, cancel: async () => { throw new Error('cancel failed'); } });
  assert.equal(drained, true);
  await discardBackgroundTurn({ events: (async function* () {})() });
});
