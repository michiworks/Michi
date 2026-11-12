import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, canonicalString, sameCanonical, sha256Canonical } from '../src/services/pages/canonicalJson';
import { homeWritePayloadHash } from '../src/services/metaAgent/firstRunWriter';
import { toolApprovalId } from '../src/services/metaAgent/toolApprovals';
import { maintenancePayloadHash } from '../src/services/pages/maintenanceRepository';
import type { McpServerConfig, McpToolInfo } from '../src/services/mcpClientManager';

// Undefined values and integer-like keys are where the serializers differ; stored hashes depend on each one's bytes.
const tricky = { b: 1, a: { '10': 'ten', '2': 'two', u: undefined, z: null }, list: [undefined, { y: 2, x: 1 }], s: 'é' };

test('canonicalJson sorts keys, drops undefined values and hashes those bytes', () => {
  assert.equal(canonicalJson(tricky), '{"a":{"2":"two","10":"ten","z":null},"b":1,"list":[null,{"x":1,"y":2}],"s":"é"}');
  assert.equal(sha256Canonical(tricky), '4ccf70026be73201fd14c828164e735896dcdd93be5f94000f418f0bb9db0d86');
  assert.equal(sameCanonical({ a: 1, b: [{ c: 1, d: 2 }] }, { b: [{ d: 2, c: 1 }], a: 1 }), true);
  assert.equal(sameCanonical([1, 2], [2, 1]), false);
});

test('canonicalString keeps undefined as text and orders integer-like keys as strings', () => {
  assert.equal(canonicalString(tricky), '{"a":{"10":"ten","2":"two","u":undefined,"z":null},"b":1,"list":[,{"x":1,"y":2}],"s":"é"}');
});

test('home write, maintenance receipt and tool approval hashes keep their stored values', () => {
  assert.equal(maintenancePayloadHash({ ops: [{ op: 'insert', after: null, block: { type: 'text', text: 'Hi' } }] }, { blockIds: ['block-x-0'] }),
    'd92ab8280a21b5abfc61cf1bd65ce0b6a437bd35049a38bf76bb715fd7c0f025');
  assert.equal(maintenancePayloadHash({ decision: 'no_change', reason: 'Nothing new' }, {}),
    'efabe940ca838d235c454098fc9d4c2b9914318888f85026402b67f76abf4ef5');
  assert.equal(homeWritePayloadHash('pg-1', [{ op: 'insert', after: null, block: { type: 'text', text: 'Hi', id: undefined } }, tricky]),
    '772d8a67cb7b04a32b476917079112574b7d0fb58548c382905762ee7b08bf01');
  assert.equal(toolApprovalId({ name: 'srv', command: 'x', args: ['1'], env: undefined } as unknown as McpServerConfig,
    { name: 'tool', description: 'd', inputSchema: { type: 'object', properties: { '10': {}, '2': {} } } } as unknown as McpToolInfo),
  '527c8ddfd4e56bc2ff995b04275a3750fadd82e94f40b4335b60657369d6a6f9');
});
