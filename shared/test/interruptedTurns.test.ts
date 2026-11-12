import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseInterruptedTurns, turnInterruptionCause } from '../src/index';

describe('turnInterruptionCause', () => {
  test('a restart marker or code is a restart', () => {
    assert.equal(turnInterruptionCause('backend_restarted'), 'restart');
    assert.equal(turnInterruptionCause('Michi restarted', 'backend_restarted'), 'restart');
  });

  // The failures recorded when a Auth session lapsed under Claude, Codex (Bedrock) and Kiro.
  test('expired or refused agent credentials are a credentials interruption', () => {
    for (const error of [
      'Claude authentication failed. Refresh the CLI credentials and retry; the original session is retained.',
      'unexpected status 403 Forbidden: User: arn:aws:sts::123456789012:assumed-role/BedrockAccess/someone is not authorized to perform: bedrock:InvokeModel',
      'stream disconnected before completion: failed to load AWS credentials: AWS credential export command failed',
      'Internal error: ExpiredTokenException: the SSO session has expired',
      'The security token included in the request is expired',
    ]) assert.equal(turnInterruptionCause(error), 'credentials', error);
    assert.equal(turnInterruptionCause('anything', 'auth'), 'credentials');
  });

  test('an ordinary failure is not an interruption', () => {
    for (const error of [null, undefined, '', 'DeepSeek API key not configured', 'Gemini Argon stopped with: MALFORMED_FUNCTION_CALL', '403 Forbidden']) {
      assert.equal(turnInterruptionCause(error), null, String(error));
    }
  });
});

test('parseInterruptedTurns keeps well-formed items and drops the rest', () => {
  const good = { turnId: 't1', nodeId: 'n1', workspaceId: 'w1', workspaceName: 'Space', title: 'Fix it', interruptedAt: 10 };
  const parsed = parseInterruptedTurns({ items: [good, { ...good, interruptedAt: 'soon' }, { ...good, nodeId: '' }, 'x', { ...good, turnId: 't2', title: 7 }] });
  assert.deepEqual(parsed.items.map((item) => [item.turnId, item.title]), [['t1', 'Fix it'], ['t2', '']]);
  assert.deepEqual(parseInterruptedTurns(null), { items: [] });
});
