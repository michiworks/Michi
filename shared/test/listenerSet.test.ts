import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeyedListenerSets, createListenerSet } from '../src/index';

test('every listener hears an emit even when one throws, and the error goes to onError', () => {
  const errors: unknown[] = [];
  const set = createListenerSet<[number]>({ onError: (error) => errors.push(error) });
  const seen: number[] = [];
  const boom = new Error('boom');
  set.subscribe(() => { throw boom; });
  set.subscribe((value) => seen.push(value));
  assert.doesNotThrow(() => set.emit(1));
  assert.deepEqual(seen, [1]);
  assert.deepEqual(errors, [boom]);
});

test('an emit reaches the listeners subscribed when it started', () => {
  const set = createListenerSet<[]>();
  const seen: string[] = [];
  let stopSecond = () => {};
  set.subscribe(() => {
    seen.push('first');
    stopSecond();
    set.subscribe(() => seen.push('late'));
  });
  stopSecond = set.subscribe(() => seen.push('second'));
  set.emit();
  assert.deepEqual(seen, ['first', 'second']);
  seen.length = 0;
  set.emit();
  assert.deepEqual(seen, ['first', 'late']);
});

test('keyed sets reach only the listeners of their key', () => {
  const sets = createKeyedListenerSets<string, [string]>();
  const seen: string[] = [];
  const stopA = sets.subscribe('a', (value) => seen.push(`a:${value}`));
  sets.subscribe('b', (value) => seen.push(`b:${value}`));
  sets.emit('a', '1');
  sets.emit('c', '2');
  assert.deepEqual(seen, ['a:1']);
  stopA();
  stopA();
  sets.emit('a', '3');
  sets.subscribe('a', (value) => seen.push(`a again:${value}`));
  sets.emit('a', '4');
  assert.deepEqual(seen, ['a:1', 'a again:4']);
});
