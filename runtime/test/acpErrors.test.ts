import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACPError } from '../src/adapters/kiro/acpClient';
import { classifyAcpError, isRetryable, needsRespawn, toErrorKind } from '../src/adapters/kiro/acpErrors';
import { KIRO_SIGN_IN_MARKERS } from '../src/adapters/kiro/kiroErrorMarkers';
import { isKiroSignInError } from '../src/adapters/kiro/kiroSignIn';

/**
 * kiro-cli collapses every runtime failure into JSON-RPC `-32603 "Internal error"`;
 * the only discriminator is the `rpcData` string. These fixtures are the exact
 * strings observed in ~/.michi/logs/backend.log plus the error taxonomy baked
 * into the kiro-cli binary (aws-smithy transport + CodeWhisperer/Q service).
 */
function rpcErr(rpcData: unknown): ACPError {
  return new ACPError('Internal error', {
    method: 'session/prompt',
    sessionId: 's1',
    rpcCode: -32603,
    rpcData,
  });
}

describe('classifyAcpError — auth class (no retry, re-login)', () => {
  for (const marker of [
    'ExpiredTokenException',
    'InvalidGrantException',
    'UnauthorizedClientException',
    'NotAuthorizedException',
    'AuthorizationPendingException',
  ]) {
    test(marker, () => {
      assert.equal(classifyAcpError(rpcErr(marker)), 'auth');
      assert.equal(isRetryable('auth'), false);
      assert.equal(needsRespawn('auth'), false);
    });
  }
});

describe('Kiro sign-in detection', () => {
  test('reads every sign-in marker as signed out, in any case', () => {
    for (const marker of KIRO_SIGN_IN_MARKERS) {
      assert.equal(isKiroSignInError(`Internal error: ${marker.toUpperCase()}`), true, marker);
      assert.equal(isKiroSignInError(new Error(marker)), true, marker);
    }
  });

  test('a device login still pending is an auth error, not a sign-out', () => {
    assert.equal(isKiroSignInError('AuthorizationPendingException'), false);
  });
});

describe('classifyAcpError — generic class (no retry, surface raw)', () => {
  test('MonthlyRequestCount quota → generic (not auth, not retry)', () => {
    assert.equal(classifyAcpError(rpcErr('MonthlyRequestCount limit reached')), 'generic');
  });

  test('test-provider stub object rpcData → generic', () => {
    assert.equal(classifyAcpError(rpcErr({ provider: 'test-provider', requestId: 'req-123' })), 'generic');
  });

  test('non-error value → generic', () => {
    assert.equal(classifyAcpError('nope'), 'generic');
    assert.equal(classifyAcpError(undefined), 'generic');
  });
});

describe('toErrorKind — UI-facing collapse to 3 kinds', () => {
  test('auth → auth', () => {
    assert.equal(toErrorKind('auth'), 'auth');
  });
});
