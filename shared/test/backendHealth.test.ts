import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMichiBackendHealth, type MichiBackendHealth } from '../src/index';

test('isMichiBackendHealth accepts a Michi backend, including older ones without the later fields', () => {
  const current: MichiBackendHealth = {
    status: 'healthy', service: 'michi-backend', connectionProtocol: 1, build: { version: '1.0.0', revision: 'abc1234' },
    serverId: 'server-1', serviceMode: false, serviceBuild: null,
  };
  assert.equal(isMichiBackendHealth(current), true);
  assert.equal(isMichiBackendHealth({ ...current, auditLog: 'unavailable' }), true);
  assert.equal(isMichiBackendHealth({ status: 'healthy', service: 'michi-backend' }), true);
});

test('isMichiBackendHealth rejects other servers and bodies that are not objects', () => {
  for (const body of [null, undefined, 'healthy', 1, [], { status: 'healthy' }, { status: 'healthy', service: 'other' },
    { status: 'unavailable', service: 'michi-backend' }]) {
    assert.equal(isMichiBackendHealth(body), false, JSON.stringify(body));
  }
});
