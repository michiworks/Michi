/**
 * Lane D, from the live kiro-cli 3.2.1 smoke (2026-11-12): a switch to a
 * guarded copy of the chat's agent must not silently miss. v3 answers
 * session/set_mode with `{}` for any id, one it has no agent for included,
 * so the switch sets the mode config option, whose answer names the value
 * applied; v2 answers an unknown agent with an error. And Kiro sends a
 * call's kind and arguments on its tool_call update, not in the permission
 * request, so the session remembers them for the host's consequence rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/adapters/kiro/acpClient';
import { KiroToolCallNames } from '../src/adapters/kiro/kiroToolNames';
import type { KiroEngine } from '../src/adapters/kiro/kiroProtocol';

function client(engine: KiroEngine, applies: (value: string) => string) {
  const c = new AcpClient('/bin/false', '/tmp', undefined, engine);
  const internal = c as any;
  const calls: Array<{ method: string; params: any }> = [];
  internal.send = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'session/new') {
      return engine === 'v3'
        ? { sessionId: 's', modes: { currentModeId: 'vibe', availableModes: [] }, configOptions: [{ id: 'mode', type: 'select', category: 'mode', currentValue: 'vibe', options: [] }] }
        : { sessionId: 's', modes: { currentModeId: 'sample-builder', availableModes: [] } };
    }
    if (method === 'session/set_config_option') return { configOptions: [{ id: 'mode', type: 'select', category: 'mode', currentValue: applies(params.value) }] };
    if (method === 'session/set_mode') {
      if (applies(params.modeId) !== params.modeId) throw new Error('Internal error');
      return {};
    }
    return {};
  };
  return { c, calls };
}

test('v3: the guarded switch sets the mode option and fails when Kiro did not apply it', async () => {
  const { c, calls } = client('v3', (value) => (value === 'michi-does-not-exist' ? 'vibe' : value));
  await c.newSession();
  await c.selectAgentVerified('s', 'michi-guarded--sample-builder');
  assert.equal(calls.at(-1)!.method, 'session/set_config_option');
  assert.equal(c.getSessionInfo('s')?.modes?.currentModeId, 'michi-guarded--sample-builder');
  await assert.rejects(c.selectAgentVerified('s', 'michi-does-not-exist'), /did not apply config option mode/);
  // Plain setMode keeps the wire call it always made.
  await c.setMode('s', 'spec');
  assert.equal(calls.at(-1)!.method, 'session/set_mode');
});

test('v2: the guarded switch is set_mode, which rejects an agent Kiro does not have', async () => {
  const { c, calls } = client('v2', (value) => (value === 'michi-does-not-exist' ? 'sample-builder' : value));
  await c.newSession();
  await c.selectAgentVerified('s', 'michi-guarded--sample-builder');
  assert.equal(calls.at(-1)!.method, 'session/set_mode');
  await assert.rejects(c.selectAgentVerified('s', 'michi-does-not-exist'), /Internal error/);
});

test('a call\'s kind and arguments from its tool_call update are kept for its permission request', () => {
  const names = new KiroToolCallNames();
  names.remember({ toolCallId: 't1', title: 'Push main branch to origin', kind: 'execute', rawInput: { command: 'git push origin main' } });
  names.remember({ toolCallId: 't1', status: 'in_progress' });
  assert.deepEqual(names.call('t1'), { kind: 'execute', rawInput: { command: 'git push origin main' } });
  assert.deepEqual(names.call('t2'), {});
  assert.equal(names.get('t1'), undefined, 'a call without a name of its own still names nothing');
});
