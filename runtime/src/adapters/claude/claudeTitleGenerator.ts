import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '../../contract/types';
import { cleanGeneratedTitle, withTitleTimeout } from '../../core/titles';
import { killProcessTree, spawnAgentProcess } from '../../core/processTree';
import { withDeadline } from '../../core/runtimeLifecycle';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { claudeChildEnv, findClaudeBinary } from './claudeBinary';
import { resolveClaudeCliModelId } from './claudeModelCatalog';
import { neutralClaudeCwd } from './claudeModelProbe';
import { claudeProviderSettings, InputQueue, loadClaudeSdk, type ClaudeSdkModule } from './claudeSdkTransport';

/** The adapter options a title CLI reads. */
export type ClaudeTitleConfig = Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv' | 'binaryPath' | 'configDir'>;

export interface ClaudeTitleRequest {
  /** The host's title prompt for the user's message (TitlePolicy.prompt). */
  prompt: string;
  /** A model id the CLI accepts (claudeTitleModelId). */
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ClaudeTitleGeneratorOptions {
  config: ClaudeTitleConfig;
  /** Keep a started CLI ready for the next title. Off: every title starts its own. */
  spare: boolean;
  /** A spare idle this long is replaced by a new one. */
  spareMaxIdleMs?: number;
  /** Test seam: no hand-written wire implementation in production. */
  sdk?: Pick<ClaudeSdkModule, 'query'>;
}

/** Each start also sends the CLI wrapper's start-up telemetry, so the spare is replaced rarely. */
export const DEFAULT_SPARE_MAX_IDLE_MS = 60 * 60_000;
/** A spare that is not up by then is dropped instead of holding the slot. */
const TITLE_PROCESS_START_TIMEOUT_MS = 30_000;

/**
 * The model for a configured title model. A tier name such as `haiku` is
 * that tier's model in the CLI's own list; the installed build resolves no short
 * aliases itself. Without a list, or with a concrete id, it is the id the
 * static alias table gives.
 */
export function claudeTitleModelId(model: string, listed: readonly ModelInfo[] | null | undefined): string {
  const tier = model.trim().toLowerCase();
  const match = listed?.find((entry) => entry.label?.trim().toLowerCase() === tier)
    ?? listed?.find((entry) => entry.id.toLowerCase().startsWith(`claude-${tier}-`));
  return match?.id ?? resolveClaudeCliModelId(model);
}

/**
 * A CLI that answers one title prompt: no tools, MCP servers or hooks, no
 * thinking, one turn, no transcript on disk, and none of the user's or the
 * workspace's settings but the provider ones. It starts at construction and
 * waits for its prompt, so a started one costs only the model's answer.
 */
class TitleProcess {
  readonly ready: Promise<void>;
  private readonly input = new InputQueue();
  private query: Query | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopped = false;
  private exited = false;

  constructor(config: ClaudeTitleConfig, readonly model: string, sdk: Pick<ClaudeSdkModule, 'query'> | undefined,
    private readonly onExit: () => void = () => {}) {
    this.ready = this.start(config, sdk);
    this.ready.catch(() => this.stop());
  }

  /** Not stopped, and its CLI has not exited. */
  get usable(): boolean {
    return !this.stopped && !this.exited;
  }

  /** The cleaned title, or '' when the model gave no usable one. The process is spent afterwards. */
  async ask(prompt: string): Promise<string> {
    await this.ready;
    const query = this.query!;
    this.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() });
    for await (const message of query) {
      if (message.type !== 'result') continue;
      return message.subtype === 'success' ? cleanGeneratedTitle(message.result) : '';
    }
    return '';
  }

  /** Closing the query ends its output, so a waiting ask() returns. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.input.close();
    try { this.query?.close(); } finally {
      if (this.child?.pid) killProcessTree(this.child.pid, 'SIGKILL');
    }
  }

  private async start(config: ClaudeTitleConfig, sdkOverride: Pick<ClaudeSdkModule, 'query'> | undefined): Promise<void> {
    const configDir = config.configDir?.();
    const spawnEnv = config.spawnEnv();
    const binary = findClaudeBinary(config.binaryPath());
    const sdk = sdkOverride ?? await loadClaudeSdk();
    if (this.stopped) throw new Error('claude title process stopped');
    // Provider credentials go to the child's environment, never the --settings argv.
    const { env: providerEnv, ...settings } = claudeProviderSettings(config.host.observability.log, spawnEnv, configDir);
    const env = providerEnv && typeof providerEnv === 'object'
      ? Object.fromEntries(Object.entries(providerEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
    this.query = sdk.query({ prompt: this.input, options: {
      cwd: neutralClaudeCwd(config),
      pathToClaudeCodeExecutable: binary,
      model: this.model,
      persistSession: false,
      settingSources: [],
      settings: { ...settings, disableAllHooks: true },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      thinking: { type: 'disabled' },
      maxTurns: 1,
      env: claudeChildEnv({ ...spawnEnv, ...env }, configDir, {
        // As in a structured one-shot (claudeStructured.ts): Michi keeps memory
        // itself, and a prompt sent once is not worth writing to the cache.
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        DISABLE_PROMPT_CACHING: '1',
      }),
      spawnClaudeCodeProcess: (args) => {
        const child = spawnAgentProcess(args.command, args.args, { cwd: args.cwd, env: args.env, signal: args.signal });
        child.once('exit', () => { this.exited = true; this.onExit(); });
        this.child = child;
        return child;
      },
    } });
    await withDeadline(this.query.initializationResult(), TITLE_PROCESS_START_TIMEOUT_MS,
      `claude title process did not start within ${TITLE_PROCESS_START_TIMEOUT_MS}ms`);
    if (this.stopped) throw new Error('claude title process stopped');
  }
}

/**
 * Thread titles beside the chat's own turn, each on a TitleProcess. With
 * `spare`, one is kept started for the next title: warm() starts it, every
 * title starts the next, and one idle for `spareMaxIdleMs` is replaced.
 */
export class ClaudeTitleGenerator {
  private spare: TitleProcess | null = null;
  private spareTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: ClaudeTitleGeneratorOptions) {}

  /** Start the spare for `model` unless it is there. Never throws. */
  warm(model: string): void {
    if (!this.options.spare || this.closed) return;
    if (this.spare?.usable && this.spare.model === model) return;
    this.dropSpare();
    const spare = new TitleProcess(this.options.config, model, this.options.sdk, () => {
      if (this.spare === spare) this.dropSpare();
    });
    this.spare = spare;
    spare.ready.catch((error: unknown) => {
      if (this.spare === spare) this.dropSpare();
      this.options.config.host.observability.log('debug', 'chat', 'claude title process did not start', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.spareTimer = setTimeout(() => {
      if (this.spare !== spare) return;
      this.dropSpare();
      this.warm(model);
    }, this.options.spareMaxIdleMs ?? DEFAULT_SPARE_MAX_IDLE_MS);
    this.spareTimer.unref?.();
  }

  /**
   * One title, on the spare when it is for `request.model`, else on a new
   * TitleProcess. Resolves '' when the model gave no usable title; rejects on
   * failure or at the deadline, after stopping the CLI.
   */
  async generate(request: ClaudeTitleRequest): Promise<string> {
    if (request.signal?.aborted) throw new Error('claude title generation aborted');
    const spare = this.takeSpare(request.model);
    try {
      return await withTitleTimeout(async (deadline) => {
        const titleProcess = spare ?? new TitleProcess(this.options.config, request.model, this.options.sdk);
        const stop = () => titleProcess.stop();
        deadline.addEventListener('abort', stop, { once: true });
        request.signal?.addEventListener('abort', stop, { once: true });
        try {
          return await titleProcess.ask(request.prompt);
        } finally {
          deadline.removeEventListener('abort', stop);
          request.signal?.removeEventListener('abort', stop);
          titleProcess.stop();
        }
      }, request.timeoutMs, 'claude title generation');
    } finally {
      this.warm(request.model);
    }
  }

  shutdown(): void {
    this.closed = true;
    this.dropSpare();
  }

  /** The spare when it can answer for `model`; any other spare is stopped. */
  private takeSpare(model: string): TitleProcess | null {
    const spare = this.spare;
    this.clearSpare();
    if (spare?.usable && spare.model === model) return spare;
    spare?.stop();
    return null;
  }

  private dropSpare(): void {
    const spare = this.spare;
    this.clearSpare();
    spare?.stop();
  }

  private clearSpare(): void {
    this.spare = null;
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.spareTimer = undefined;
  }
}
