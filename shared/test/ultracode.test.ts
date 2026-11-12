import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeAgentCapabilities, parseSessionState } from '../src/index';

const CAPABILITIES = {
  modes: true, permissions: true, models: true, providerModels: false, reasoning: true, supportedReasoningLevels: ['high'],
  apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: true, nativeResume: true,
};

describe('Ultracode on the wire', () => {
  test('a runtime that has it keeps the capability; others, and older gateways, omit it', () => {
    assert.equal(normalizeAgentCapabilities({ ...CAPABILITIES, ultracode: true })?.ultracode, true);
    assert.equal('ultracode' in normalizeAgentCapabilities(CAPABILITIES)!, false);
    assert.equal('ultracode' in normalizeAgentCapabilities({ ...CAPABILITIES, ultracode: 'yes' })!, false);
  });

  test("a session's report keeps what the agent said and drops what it did not", () => {
    assert.deepEqual(parseSessionState({ runtimeId: 'claude', ultracode: { requested: true, active: false, available: false } }).ultracode,
      { requested: true, active: false, available: false });
    assert.deepEqual(parseSessionState({ runtimeId: 'claude', ultracode: { requested: false } }).ultracode, { requested: false },
      'not yet reported by the agent');
    assert.deepEqual(parseSessionState({ runtimeId: 'claude', ultracode: { requested: true, active: 'yes', available: 1 } }).ultracode,
      { requested: true });
    for (const malformed of [undefined, null, true, [], { active: true }]) {
      assert.equal(parseSessionState({ runtimeId: 'claude', ultracode: malformed }).ultracode, undefined);
    }
  });
});
