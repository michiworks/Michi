import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, StructuredCompletion, StructuredCompletionOptions, StructuredCompletionUsage } from '../../contract/types';
import { killProcessTree, spawnAgentProcess } from '../../core/processTree';
import { claudeAuthRetryGate } from './claudeAuthRetry';
import { findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { resolveClaudeCliModelId } from './claudeModelCatalog';
import { claudeProviderSettings, loadClaudeSdk, type ClaudeSdkModule } from './claudeSdkTransport';

/**
 * ClaudeRuntime.completeStructured: one Agent SDK query that answers with
 * structured output (outputFormat json_schema) and nothing else. No tools and
 * no MCP servers, no settings sources: only the provider and auth keys of the
 * user's settings file, inline, as an isolated restricted session gets them
 * (claudeSdkTransport), with every hook off; no CLAUDE.md, no auto memory, a
 * neutral cwd and no session file (persistSession false). The CLI process is
 * killed once the answer is in.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** The CLI may retry its structured-output step once or twice before it answers. */
const MAX_TURNS = 4;

export type ClaudeStructuredConfig = Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv' | 'binaryPath' | 'configDir'>;

/** A small model the account lists, for background answers when the caller names none. */
export function cheapClaudeModel(models: readonly ModelInfo[] | null | undefined): string | null {
  return models?.find((model) => /haiku/iu.test(model.id))?.id ?? null;
}

function neutralCwd(config: ClaudeStructuredConfig): string {
  const dir = path.join(config.host.config.dataDir(), 'structured-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type ResultMessage = {
  type: 'result'; subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown;
  usage?: Record<string, unknown>; modelUsage?: Record<string, Record<string, unknown>>; errors?: unknown;
};

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** modelUsage covers every model call of the query; usage only the main loop. */
function usageOf(message: ResultMessage): StructuredCompletionUsage | null {
  const models = message.modelUsage ? Object.values(message.modelUsage) : [];
  if (models.length > 0) {
    return models.reduce<StructuredCompletionUsage>((sum, model) => ({
      inputTokens: sum.inputTokens + count(model.inputTokens),
      outputTokens: sum.outputTokens + count(model.outputTokens),
      cacheReadTokens: (sum.cacheReadTokens ?? 0) + count(model.cacheReadInputTokens),
      cacheWriteTokens: (sum.cacheWriteTokens ?? 0) + count(model.cacheCreationInputTokens),
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }
  const usage = message.usage;
  if (!usage) return null;
  return {
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens), cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
}

export async function completeClaudeStructured(
  config: ClaudeStructuredConfig,
  opts: StructuredCompletionOptions,
  model: string | null,
  sdkOverride?: Pick<ClaudeSdkModule, 'query'>,
): Promise<StructuredCompletion> {
  opts.signal?.throwIfAborted();
  const configDir = config.configDir?.(opts.ownerUserId ?? null);
  const spawnEnv = config.spawnEnv();
  preflightClaudeAuth(configDir, spawnEnv);
  const executable = findClaudeBinary(config.binaryPath());
  const sdk = sdkOverride ?? await loadClaudeSdk();
  const settings = claudeProviderSettings(config.host.observability.log, spawnEnv, configDir);
  // Provider credentials go into the child's environment, not the --settings argv.
  const settingsEnv: NodeJS.ProcessEnv = settings.env && typeof settings.env === 'object'
    ? Object.fromEntries(Object.entries(settings.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  delete settings.env;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const stop = () => controller.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  timer.unref?.();
  let child: ChildProcessWithoutNullStreams | undefined;
  let query: Query | undefined;
  try {
    const options: Options = {
      cwd: neutralCwd(config),
      pathToClaudeCodeExecutable: executable,
      model: model ? resolveClaudeCliModelId(model) : undefined,
      systemPrompt: opts.system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      settings: { ...settings, disableAllHooks: true } as Options['settings'],
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: opts.schema },
      maxTurns: MAX_TURNS,
      env: {
        ...spawnEnv, ...settingsEnv, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
        // Michi keeps memory itself; a one-shot neither reads nor writes Claude Code's.
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        // A one-shot's prompt is not sent again within the cache's lifetime: writing it there only costs more.
        DISABLE_PROMPT_CACHING: '1',
      },
      abortController: controller,
      canUseTool: async () => ({ behavior: 'deny', message: 'A structured answer uses no tools.' }),
      spawnClaudeCodeProcess: (spawn) => {
        child = spawnAgentProcess(spawn.command, spawn.args, { cwd: spawn.cwd, env: spawn.env, signal: spawn.signal });
        return child;
      },
    };
    query = sdk.query({ prompt: opts.prompt, options });
    const authRetryExhausted = claudeAuthRetryGate();
    for await (const raw of query) {
      // Rejected again after the CLI refreshed its credentials: waiting out
      // its remaining retries would only end in the timeout below.
      if (authRetryExhausted(raw as unknown as Record<string, unknown>)) {
        throw new Error('Claude authentication failed. Refresh the CLI credentials and retry.');
      }
      const message = raw as unknown as ResultMessage;
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error) {
        throw new Error(`Claude ended the structured answer with ${message.subtype ?? 'an error'}${message.result ? `: ${String(message.result).slice(0, 300)}` : ''}`);
      }
      return { value: message.structured_output ?? null, text: typeof message.result === 'string' ? message.result : '', model, usage: usageOf(message) };
    }
    throw new Error('Claude gave no structured answer');
  } catch (error) {
    if (timedOut) throw new Error(`Claude's structured answer timed out after ${timeoutMs} ms`);
    if (opts.signal?.aborted) throw new Error('The structured answer was cancelled');
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
    try { query?.close(); } finally {
      if (child?.pid) killProcessTree(child.pid, 'SIGKILL');
    }
  }
}
