import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readApiError } from '../src/index';

// Each body is one a Michi route answers with today; a remote on another version
// can send any of them, so the reader keeps every one.
describe('readApiError', () => {
  const cases: Array<[string, unknown, { message?: string; code?: string }]> = [
    ['{ error } (most routes)', { error: 'workspace not found' }, { message: 'workspace not found' }],
    ['{ code, error } (michi.ts turn_active)', { code: 'turn_active', error: 'Cannot change model during an active turn' },
      { message: 'Cannot change model during an active turn', code: 'turn_active' }],
    ['{ error: { code, message } } (Pages)', { error: { code: 'invalid', message: 'Invalid request body' } },
      { message: 'Invalid request body', code: 'invalid' }],
    ['{ ok: false, error } (agent.ts)', { ok: false, error: 'Invalid expectedRuntime' }, { message: 'Invalid expectedRuntime' }],
    ['{ code, message } (conversationUpdates.ts)', { code: 'internal_error', message: 'Could not read conversation updates' },
      { message: 'Could not read conversation updates', code: 'internal_error' }],
    ['{ error: code, message } (agentRunActions.ts)', { error: 'parent_unavailable', message: 'Start a new thread instead.' },
      { message: 'Start a new thread instead.', code: 'parent_unavailable' }],
  ];
  for (const [name, body, expected] of cases) {
    test(name, () => { assert.deepEqual(readApiError(body), expected); });
  }

  test('reads nothing from a body that is not an error object', () => {
    for (const body of [null, undefined, 'Bad Gateway', 42, [], {}, { error: 7 }, { error: { code: 3 } }]) {
      assert.deepEqual(readApiError(body), {}, JSON.stringify(body));
    }
  });
});
