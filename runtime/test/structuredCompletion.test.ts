// AgentRuntime.completeStructured, as the Claude and Codex adapters answer it:
// one isolated call with no tools, no session and nothing persisted, the
// answer parsed and its usage reported. Fakes stand in for the Agent SDK and
// for codex app-server.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAdapterOptions } from '../src/adapters/claude/index';
import { cheapClaudeModel, completeClaudeStructured } from '../src/adapters/claude/claudeStructured';
import { completeCodexStructured, strictOutputSchema } from '../src/adapters/codex/codexStructured';
import { CODEX_STRUCTURED_BASE_INSTRUCTIONS, CODEX_STRUCTURED_CONFIG_OFF, CODEX_STRUCTURED_FEATURES_OFF } from '../src/adapters/codex/codexProtocol';
import { createDefaultHost } from '../src/core/defaultHost';
import { parseJsonAnswer } from '../src/core/structuredAnswer';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['memories'],
  properties: {
    memories: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 300 }, target: { type: ['string', 'null'], maxLength: 64 } },
      },
    },
    exclude_turns: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

const dataDirs: string[] = [];
after(() => { for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function claudeConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-claude-'));
  dataDirs.push(dataDir);
  const host = createDefaultHost({ logLevel: 'silent', dataDir });
  return { ...claudeAdapterOptions({ host, spawnEnv: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'test-key' }) }), binaryPath: () => process.execPath };
}

/** An SDK query that yields the given messages and records its options. */
function fakeQuery(messages: unknown[], seen: { options?: any; prompt?: unknown; closed?: boolean }) {
  return {
    query: (args: { prompt: unknown; options: any }) => {
      seen.options = args.options;
      seen.prompt = args.prompt;
      return {
        async *[Symbol.asyncIterator]() { for (const message of messages) yield message; },
        close: () => { seen.closed = true; },
      };
    },
  } as never;
}

describe('Claude: one isolated Agent SDK query', () => {
  it('no tools, no settings sources, no session file, json_schema output; the structured answer and every model\'s usage', async () => {
    const seen: { options?: any; prompt?: unknown; closed?: boolean } = {};
    const answer = { memories: [{ body: 'The user lives in Nakano.' }] };
    const result = await completeClaudeStructured(claudeConfig(), { system: 'You extract.', prompt: 'Turns: …', schema: SCHEMA }, 'claude-haiku-4-5', fakeQuery([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: answer,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { 'claude-haiku-4-5': { inputTokens: 1_200, outputTokens: 150, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 } } },
    ], seen));
    assert.deepEqual(result, { value: answer, text: '', model: 'claude-haiku-4-5',
      usage: { inputTokens: 1_200, outputTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 0 } });
    const options = seen.options;
    assert.equal(seen.prompt, 'Turns: …');
    assert.equal(options.systemPrompt, 'You extract.', 'the extractor\'s instructions replace Claude Code\'s');
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.settings.disableAllHooks, true);
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: SCHEMA });
    assert.equal(options.model, 'claude-haiku-4-5');
    assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.match(options.cwd, /structured-cwd$/);
    assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny');
    assert.ok(seen.closed, 'the query is closed once answered');
  });

  it('an error result fails the call; a cancelled one says so', async () => {
    const seen: { closed?: boolean } = {};
    await assert.rejects(completeClaudeStructured(claudeConfig(), { system: 's', prompt: 'p', schema: SCHEMA }, null,
      fakeQuery([{ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true }], seen)), /error_max_structured_output_retries/);
    assert.ok(seen.closed);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(completeClaudeStructured(claudeConfig(), { system: 's', prompt: 'p', schema: SCHEMA, signal: controller.signal }, null,
      fakeQuery([], {})), /abort/i);
  });

  it('waits out the CLI\'s credential refresh, then stops on a second authentication failure', async () => {
    const retry = (attempt: number) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: 403, error: 'authentication_failed' });
    const answer = { memories: [] };
    // A rate limit first makes the authentication failure attempt 2; it still gets its refresh.
    const rateLimited = { ...retry(1), error_status: 429, error: 'rate_limit' };
    const recovered = await completeClaudeStructured(claudeConfig(), { system: 's', prompt: 'p', schema: SCHEMA }, null,
      fakeQuery([rateLimited, retry(2), { type: 'result', subtype: 'success', structured_output: answer, result: '' }], {}));
    assert.deepEqual(recovered.value, answer);
    const seen: { closed?: boolean } = {};
    await assert.rejects(completeClaudeStructured(claudeConfig(), { system: 's', prompt: 'p', schema: SCHEMA }, null,
      fakeQuery([retry(1), retry(2), { type: 'result', subtype: 'success', structured_output: answer }], seen)), /Claude authentication failed/);
    assert.ok(seen.closed);
  });

  it('with no model named, a Haiku model the account lists', () => {
    assert.equal(cheapClaudeModel([{ id: 'claude-opus-5', label: 'Opus' }, { id: 'global.anthropic.claude-haiku-4-5-v1', label: 'Haiku' }]),
      'global.anthropic.claude-haiku-4-5-v1');
    assert.equal(cheapClaudeModel([{ id: 'claude-opus-5', label: 'Opus' }]), null);
    assert.equal(cheapClaudeModel(null), null);
  });
});

/** A codex app-server that answers a thread's one turn with these deltas and usage. */
function fakeCodex(deltas: string[], status = 'completed') {
  const requests: Array<{ method: string; params: any }> = [];
  let listener: ((method: string, params: any) => void) | null = null;
  const client = {
    async request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        setImmediate(() => {
          listener?.('turn/started', { turn: { id: 'turn-1' } });
          for (const delta of deltas) listener?.('item/agentMessage/delta', { delta });
          listener?.('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 2_000, cachedInputTokens: 500, outputTokens: 120 } } });
          listener?.('turn/completed', { turn: { id: 'turn-1', status } });
        });
        return { turn: { id: 'turn-1' } };
      }
      return {};
    },
    onNotification(threadId: string, fn: (method: string, params: any) => void) {
      assert.equal(threadId, 'thread-1');
      listener = fn;
      return () => { listener = null; };
    },
  };
  return { client: client as never, requests };
}

describe('Codex: one turn on an ephemeral thread', () => {
  it('a read-only thread that approves nothing and keeps no rollout, the schema as outputSchema, the answer parsed and its usage', async () => {
    const { client, requests } = fakeCodex(['{"memories": [{"body": ', '"Nakano"}]}']);
    const config = { features: { goals: false }, memories: { generate_memories: false, use_memories: false } };
    const result = await completeCodexStructured({ client, cwd: '/tmp/structured', model: 'gpt-5.6-luna', system: 'You extract.', prompt: 'Turns', schema: SCHEMA,
      effort: 'low', config });
    assert.deepEqual(result, { value: { memories: [{ body: 'Nakano' }] }, text: '{"memories": [{"body": "Nakano"}]}', model: 'gpt-5.6-luna',
      usage: { inputTokens: 1_500, outputTokens: 120, cacheReadTokens: 500 } });
    const start = requests.find((request) => request.method === 'thread/start')!.params;
    assert.deepEqual({ ...start }, { model: 'gpt-5.6-luna', cwd: '/tmp/structured', developerInstructions: 'You extract.', approvalPolicy: 'never',
      sandbox: 'read-only', ephemeral: true, config });
    const turn = requests.find((request) => request.method === 'turn/start')!.params;
    assert.equal(turn.effort, 'low');
    assert.deepEqual(turn.outputSchema, strictOutputSchema(SCHEMA));
    assert.ok(requests.some((request) => request.method === 'thread/unsubscribe'), 'the thread is let go');
  });

  it('a base prompt replaces Codex\'s default one; the structured thread runs without Codex\'s tools and instruction blocks', async () => {
    const { client, requests } = fakeCodex(['{"memories": []}']);
    await completeCodexStructured({ client, cwd: '/tmp/structured', model: null, system: 'You extract.', prompt: 'Turns', schema: SCHEMA,
      effort: 'low', config: {}, baseInstructions: CODEX_STRUCTURED_BASE_INSTRUCTIONS });
    const start = requests.find((request) => request.method === 'thread/start')!.params;
    assert.equal(start.baseInstructions, CODEX_STRUCTURED_BASE_INSTRUCTIONS);
    assert.equal(start.developerInstructions, 'You extract.', 'the host\'s system prompt stays the developer instructions');
    // What was measured to take a one-turn memory extraction from 14.2k to 6.2k tokens (codex 0.167.0.945).
    assert.equal(CODEX_STRUCTURED_FEATURES_OFF.goals, false);
    for (const feature of ['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'browser_use', 'computer_use', 'apps', 'plugins']) {
      assert.equal(CODEX_STRUCTURED_FEATURES_OFF[feature], false, feature);
    }
    assert.deepEqual(CODEX_STRUCTURED_CONFIG_OFF, {
      include_permissions_instructions: false, include_apps_instructions: false, include_collaboration_mode_instructions: false,
      include_environment_context: false, web_search: 'disabled',
    });
  });

  it('a failed turn fails the call', async () => {
    const { client } = fakeCodex([], 'failed');
    await assert.rejects(completeCodexStructured({ client, cwd: '/tmp', model: null, system: 's', prompt: 'p', schema: SCHEMA, effort: 'low', config: {} }),
      /turn failed/);
  });

  it('strict output: every object closed with every property required, no length or count bounds; nullable fields stay nullable', () => {
    assert.deepEqual(strictOutputSchema(SCHEMA), {
      type: 'object', additionalProperties: false, required: ['memories', 'exclude_turns'],
      properties: {
        memories: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['body', 'target'],
          properties: { body: { type: 'string' }, target: { type: ['string', 'null'] } } } },
        exclude_turns: { type: 'array', items: { type: 'string' } },
      },
    });
  });
});

describe('parseJsonAnswer', () => {
  it('the whole text, a fenced block, or the outermost object; null for anything else', () => {
    assert.deepEqual(parseJsonAnswer('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonAnswer('Here it is:\n```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(parseJsonAnswer('Sure. {"a":3} Done.'), { a: 3 });
    assert.equal(parseJsonAnswer('[1, 2]'), null);
    assert.equal(parseJsonAnswer('no json here'), null);
    assert.equal(parseJsonAnswer(''), null);
  });
});
