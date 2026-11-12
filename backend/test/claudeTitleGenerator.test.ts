import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo } from 'michi-runtime';
import {
  ClaudeTitleGenerator,
  claudeTitleModelId,
  type ClaudeTitleRequest,
} from 'michi-runtime/internal/adapters/claude/claudeTitleGenerator';
import { resolveClaudeCliModelId } from 'michi-runtime/internal/adapters/claude/claudeModelCatalog';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import { claudeTestOptions } from './helpers/claudeTestOptions';

// The binary lookup and the auth pre-flight pass; no test starts a CLI.
const ENV_NAMES = ['CLAUDE_CLI_BIN', 'ANTHROPIC_API_KEY', 'MICHI_TITLE_MODEL_CLAUDE'] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
before(() => {
  process.env.CLAUDE_CLI_BIN = process.execPath;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.MICHI_TITLE_MODEL_CLAUDE;
});
after(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
});

interface FakeQuery {
  options: any;
  prompts: string[];
  closed: boolean;
}

/** Queries that answer the first user message with `reply(prompt)`, or never when it gives null. */
function fakeSdk(reply: (prompt: string) => Record<string, unknown> | null = () => ({ type: 'result', subtype: 'success', result: 'A title' })) {
  const queries: FakeQuery[] = [];
  const sdk = {
    query: (args: any) => {
      const record: FakeQuery = { options: args.options, prompts: [], closed: false };
      queries.push(record);
      let release!: () => void;
      const closed = new Promise<{ done: true; value: undefined }>((resolve) => { release = () => resolve({ done: true, value: undefined }); });
      return {
        initializationResult: async () => ({}),
        close: () => { record.closed = true; release(); },
        async *[Symbol.asyncIterator]() {
          const next = await Promise.race([args.prompt[Symbol.asyncIterator]().next(), closed]);
          if (next.done) return;
          record.prompts.push(next.value.message.content);
          const message = reply(next.value.message.content);
          if (message === null) {
            await closed;
            return;
          }
          yield message;
        },
      };
    },
  };
  return { sdk: sdk as any, queries };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const LISTED = [
  { id: 'claude-opus-5-5', label: 'Default' },
  { id: 'claude-haiku-5-5', label: 'Haiku' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
] as ModelInfo[];

describe('claudeTitleModelId', () => {
  test('a tier name is the model the CLI lists under that name', () => {
    assert.equal(claudeTitleModelId('haiku', LISTED), 'claude-haiku-5-5');
    assert.equal(claudeTitleModelId('sonnet', LISTED), 'claude-sonnet-5');
  });

  test('a concrete id, or no list, goes through the static alias table', () => {
    assert.equal(claudeTitleModelId('claude-haiku-4-5', LISTED), 'claude-haiku-4-5');
    assert.equal(claudeTitleModelId('haiku', null), resolveClaudeCliModelId('haiku'));
  });
});

describe('ClaudeTitleGenerator', () => {
  test('without a spare, a title runs one minimal turn on a CLI of its own', async () => {
    const { sdk, queries } = fakeSdk(() => ({ type: 'result', subtype: 'success', result: '"Claude 线程标题"\n' }));
    const titles = new ClaudeTitleGenerator({ config: claudeTestOptions(), spare: false, sdk });
    titles.warm('claude-haiku-5-5');
    assert.equal(queries.length, 0, 'warm() starts nothing without a spare');
    assert.equal(await titles.generate({ prompt: 'TITLE PROMPT', model: 'claude-haiku-5-5', timeoutMs: 1_000 }), 'Claude 线程标题');
    assert.equal(queries.length, 1);
    const [{ options, prompts, closed }] = queries;
    assert.deepEqual(prompts, ['TITLE PROMPT']);
    assert.ok(closed);
    assert.equal(options.model, 'claude-haiku-5-5');
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.settings.disableAllHooks, true);
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.thinking, { type: 'disabled' });
    assert.equal(options.maxTurns, 1);
    assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(options.env.DISABLE_PROMPT_CACHING, '1');
  });

  test('warm() keeps one started CLI that answers the next title, and each title starts the next one', async () => {
    const { sdk, queries } = fakeSdk();
    const titles = new ClaudeTitleGenerator({ config: claudeTestOptions(), spare: true, sdk });
    try {
      titles.warm('m');
      titles.warm('m');
      await settle();
      assert.equal(queries.length, 1);
      assert.equal(await titles.generate({ prompt: 'P', model: 'm', timeoutMs: 1_000 }), 'A title');
      assert.deepEqual(queries[0].prompts, ['P'], 'the spare answered');
      assert.ok(queries[0].closed, 'a CLI answers one title');
      assert.equal(queries.length, 2, 'the next spare started');
      assert.equal(queries[1].options.model, 'm');
      assert.equal(queries[1].closed, false);
    } finally {
      titles.shutdown();
    }
    assert.ok(queries[1].closed, 'shutdown stops the spare');
  });

  test('a spare for another model is stopped, and the title runs on a new CLI', async () => {
    const { sdk, queries } = fakeSdk();
    const titles = new ClaudeTitleGenerator({ config: claudeTestOptions(), spare: true, sdk });
    try {
      titles.warm('a');
      await settle();
      assert.equal(await titles.generate({ prompt: 'P', model: 'b', timeoutMs: 1_000 }), 'A title');
      assert.ok(queries[0].closed);
      assert.deepEqual(queries[0].prompts, []);
      assert.equal(queries[1].options.model, 'b');
      assert.deepEqual(queries[1].prompts, ['P']);
      assert.equal(queries[2].options.model, 'b', 'the next spare is for the model in use');
    } finally {
      titles.shutdown();
    }
  });

  test('a spare idle for too long is replaced by a new one', async () => {
    const { sdk, queries } = fakeSdk();
    const titles = new ClaudeTitleGenerator({ config: claudeTestOptions(), spare: true, spareMaxIdleMs: 20, sdk });
    try {
      titles.warm('m');
      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.ok(queries.length >= 2);
      assert.ok(queries.slice(0, -1).every((query) => query.closed));
      assert.equal(queries.at(-1)!.closed, false);
    } finally {
      titles.shutdown();
    }
  });

  test('stops the CLI at the deadline', async () => {
    const { sdk, queries } = fakeSdk(() => null);
    const titles = new ClaudeTitleGenerator({ config: claudeTestOptions(), spare: false, sdk });
    await assert.rejects(titles.generate({ prompt: 'p', model: 'm', timeoutMs: 20 }), /timed out after 20ms/);
    assert.ok(queries[0].closed);
  });

  test('an unsuccessful result gives no title', async () => {
    const { sdk } = fakeSdk(() => ({ type: 'result', subtype: 'error_max_turns' }));
    const titles = new ClaudeTitleGenerator({ config: claudeTestOptions(), spare: false, sdk });
    assert.equal(await titles.generate({ prompt: 'p', model: 'm', timeoutMs: 1_000 }), '');
  });
});

describe('ClaudeRuntime titles', () => {
  const runtime = () => new ClaudeRuntime({ ...claudeTestOptions(), bridge: {} as any, mcpSlots: {} as any });

  test('generateTitle asks the host for the prompt and the model, and never throws', async (t) => {
    const rt = runtime();
    try {
      const seen: ClaudeTitleRequest[] = [];
      t.mock.method(ClaudeTitleGenerator.prototype, 'generate', async (request: ClaudeTitleRequest) => {
        seen.push(request);
        if (seen.length > 1) throw new Error('CLI failed');
        return 'A title';
      });
      assert.equal(await rt.generateTitle({ userText: 'How do titles work?' }), 'A title');
      assert.match(seen[0].prompt, /How do titles work\?/);
      assert.equal(seen[0].model, claudeTitleModelId('haiku', null));
      assert.equal(await rt.generateTitle({ userText: 'again' }), null);
    } finally {
      await rt.shutdown();
    }
  });

  test('warm() starts the title spare after the chat warm-up', async (t) => {
    const rt = runtime();
    try {
      const order: string[] = [];
      t.mock.method((rt as any).manager, 'warm', async () => { order.push('chat'); });
      t.mock.method(ClaudeTitleGenerator.prototype, 'warm', (model: string) => { order.push(`title ${model}`); });
      await rt.warm('/tmp/title-warm');
      assert.deepEqual(order, ['chat', `title ${claudeTitleModelId('haiku', null)}`]);
    } finally {
      await rt.shutdown();
    }
  });

  test('with the title model off there are no titles and no spare', async (t) => {
    process.env.MICHI_TITLE_MODEL_CLAUDE = 'off';
    const rt = runtime();
    try {
      const generate = t.mock.method(ClaudeTitleGenerator.prototype, 'generate', async () => 'unused');
      const warm = t.mock.method(ClaudeTitleGenerator.prototype, 'warm', () => {});
      t.mock.method((rt as any).manager, 'warm', async () => {});
      assert.equal(await rt.generateTitle({ userText: 'hello there' }), null);
      await rt.warm('/tmp/title-off');
      assert.equal(generate.mock.callCount(), 0);
      assert.equal(warm.mock.callCount(), 0);
    } finally {
      delete process.env.MICHI_TITLE_MODEL_CLAUDE;
      await rt.shutdown();
    }
  });
});
