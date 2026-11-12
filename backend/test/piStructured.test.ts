// PiRuntime.completeStructured (agents/pi/piStructured.ts): one provider
// request with no tools and no session, the JSON object parsed from the reply,
// the provider's usage reported. The provider is a fake stream.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { completePiStructured } from '../src/agents/pi/piStructured';

const model = { id: 'cheap-model', provider: 'openai' };

function provider(t: TestContext, reply: unknown) {
  const calls: Array<{ model: unknown; context: any; options: any }> = [];
  configureRuntimeDeps({
    dataDir: process.env.HOME,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission() {} },
    providerKeys: { getProviderApiKey: (provider: string) => (provider === 'openai' ? 'sk-test' : null) },
    agentConfig: { getAgentConfig: () => ({ provider: 'openai' } as any), resolveModel: () => 'default-model', resolveReasoning: () => undefined },
  } as any);
  t.after(__resetRuntimeDeps);
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async (_provider: string, id: string) => ({ ...model, id }));
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({
    clampThinkingLevel: (_model: unknown, level: string) => level,
    async *streamSimple(selected: unknown, context: unknown, options: unknown) {
      calls.push({ model: selected, context, options });
      yield reply;
    },
  }));
  return calls;
}

test('one request: the system prompt asks for the JSON alone, no tools; the answer parsed and the usage reported', async (t) => {
  const calls = provider(t, {
    type: 'done', reason: 'stop',
    message: { role: 'assistant', model: 'cheap-model', content: [{ type: 'text', text: '```json\n{"memories": [], "turn_keys": []}\n```' }],
      usage: { input: 1_800, output: 40, cacheRead: 200, cacheWrite: 0, totalTokens: 2_040 } },
  });
  const result = await completePiStructured({ system: 'You extract.', prompt: 'Turns: …', schema: { type: 'object' }, model: 'cheap-model' });
  assert.deepEqual(result, {
    value: { memories: [], turn_keys: [] }, text: '```json\n{"memories": [], "turn_keys": []}\n```', model: 'cheap-model',
    usage: { inputTokens: 1_800, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0 },
  });
  assert.equal(calls.length, 1);
  const { context, options } = calls[0]!;
  assert.match(context.systemPrompt, /^You extract\.\n\nAnswer with the JSON object alone/);
  assert.deepEqual(context.tools, []);
  assert.deepEqual(context.messages.map((message: any) => message.content[0].text), ['Turns: …']);
  assert.equal(options.apiKey, 'sk-test', 'the configured provider\'s key');
  assert.equal(options.reasoning, 'low');
});

test('without a model named, the configured one; a provider error fails the call', async (t) => {
  const calls = provider(t, { type: 'error', reason: 'error', error: { errorMessage: 'rate limited' } });
  await assert.rejects(completePiStructured({ system: 's', prompt: 'p', schema: {} }), /rate limited/);
  assert.equal((calls[0]!.model as { id: string }).id, 'default-model');
});
