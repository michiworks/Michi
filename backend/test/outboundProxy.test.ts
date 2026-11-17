import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyOutboundProxyFromEnv, outboundProxyEnv } from '../src/services/outboundProxy';

test('a proxy applies only when one is named, and loopback stays direct', () => {
  assert.equal(outboundProxyEnv({ NO_PROXY: 'corp.example' }), null);
  assert.deepEqual(outboundProxyEnv({ https_proxy: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://other:1', no_proxy: '.corp.example' }), {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: undefined,
    NO_PROXY: '.corp.example,localhost,127.0.0.1,[::1]',
  });
});

test('an invalid proxy is ignored instead of stopping the backend', () => {
  const target = http as { setGlobalProxyFromEnv?: unknown };
  const original = target.setGlobalProxyFromEnv;
  target.setGlobalProxyFromEnv = () => { throw Object.assign(new Error('127.0.0.1:7890'), { code: 'ERR_PROXY_INVALID_CONFIG' }); };
  try {
    assert.equal(applyOutboundProxyFromEnv({ HTTPS_PROXY: '127.0.0.1:7890' }), false);
  } finally {
    target.setGlobalProxyFromEnv = original;
  }
});
