import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeChildEnv, claudeConfigRoot, findClaudeBinary, preflightClaudeAuth, type SpawnClaudeArgs } from './claudeBinary';
import { resolveClaudeCliModelId } from './claudeModelCatalog';
import { spawnAgentProcess, killProcessTree } from '../../core/processTree';
import { withDeadline } from '../../core/runtimeLifecycle';
import type { RuntimeObservability } from '../../contract/host';
import { ClaudeSdkMissingError } from './claudeSdkPeer';

export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let modulePromise: Promise<ClaudeSdkModule> | undefined;

function resolveInstalledClaudeSdk(): string {
  try {
    return require.resolve('@anthropic-ai/claude-agent-sdk');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') throw new ClaudeSdkMissingError(error);
    throw error;
  }
}

/** Preserve native ESM import in our CJS backend. Packaged builds copy the SDK
 * and its sibling modules into dist/claude-sdk; otherwise it is the host's
 * installed SDK, and a host without one gets a ClaudeSdkMissingError. */
export function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (!modulePromise) {
    const bundled = path.join(__dirname, 'claude-sdk', 'sdk.mjs');
    const entry = fs.existsSync(bundled) ? bundled : resolveInstalledClaudeSdk();
    const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<ClaudeSdkModule>;
    modulePromise = nativeImport(pathToFileURL(entry).href).catch((error) => { modulePromise = undefined; throw error; });
  }
  return modulePromise;
}

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('Claude SDK input is closed');
    this.items.push(message);
    this.wake?.();
  }
  close(): void { this.ended = true; this.items = []; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.ended) {
      if (!this.items.length) await new Promise<void>((resolve) => { this.wake = resolve; });
      while (!this.ended && this.items.length) yield this.items.shift()!;
    }
  }
}

/**
 * The PreToolUse hook's verdict: allow or deny the call, or ask, which the
 * CLI (pinned 2.1.306) answers by skipping its own permission evaluation and
 * sending the call to canUseTool; deny and ask rules, and another hook's
 * deny, still win (the CLI ranks hook decisions deny > ask > allow).
 */
export type ClaudePreToolUseVerdict = PermissionResult | { behavior: 'ask'; message: string };

export interface ClaudeSdkTransportOptions extends SpawnClaudeArgs {
  onMessage(message: Record<string, unknown>): void;
  onError(error: Error): void;
  onStderr(text: string): void;
  authorize(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<PermissionResult>;
  /**
   * Mandatory host policy, evaluated even when CLI settings auto-approve:
   * the session's PreToolUse hook. Undefined leaves the call to the CLI's own
   * permission flow; `ask` sends it to canUseTool (authorize) even where an
   * allow rule, the permission mode or another hook's allow would approve it.
   */
  preToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<ClaudePreToolUseVerdict | undefined>;
  tools?: string[];
  /** Tools denied outright, in every permission mode (the CLI's --disallowedTools). */
  disallowedTools?: string[];
  /** Keep host hooks mandatory even when no explicit tool profile was supplied. */
  restricted?: boolean;
  /**
   * Load no user, project or local settings, only the provider/auth keys of
   * claudeProviderSettings (as a bare restricted session does): no user hooks,
   * plugins, skills, permission rules or CLAUDE.md. Implies restricted.
   */
  isolateSettings?: boolean;
  /** The CLI's --restricted mode (see ClaudeSpawnPolicy.restrictedMode). Implies restricted. */
  restrictedMode?: boolean;
  /**
   * Write the session's transcript to `<config>/projects/<slug>/<id>.jsonl`
   * (the SDK's persistSession). Default true; an ephemeral session (a
   * Companion check-in, DESIGN-v2 §3.2) passes false and keeps none.
   */
  persistSession?: boolean;
  /**
   * Start the CLI without telemetry (claudeEphemeralEnv): no `OTEL_*`, no
   * `CLAUDE_CODE_ENABLE_TELEMETRY`, and non-essential traffic off. Set for
   * ephemeral sessions (DESIGN-v2 §2.4); a wrapper that starts the CLI may
   * still set its own (probe P2: the installed wrapper re-adds
   * CLAUDE_CODE_ENABLE_TELEMETRY).
   */
  quietTelemetry?: boolean;
  /** The host's log (RuntimeObservability.log). */
  log: RuntimeObservability['log'];
  /** Test seam for exercising SDK callbacks without starting a real agent. */
  sdk?: Pick<ClaudeSdkModule, 'query'>;
}

export interface ClaudeSdkTransport {
  child: ChildProcessWithoutNullStreams;
  query: Query;
  initialized: ReturnType<Query['initializationResult']>;
  send(message: SDKUserMessage): void;
  close(): void;
}

/** Bare mode disables programmatic hooks. Restricted profiles keep only the
 * provider/auth configuration while excluding user/project tools and hooks;
 * so do a structured one-shot (claudeStructured.ts) and a title CLI
 * (claudeTitleGenerator.ts). */
export function claudeProviderSettings(log: RuntimeObservability['log'], spawnEnv: NodeJS.ProcessEnv, configDir?: string): Record<string, unknown> {
  const file = path.join(claudeConfigRoot(configDir, spawnEnv), 'settings.json');
  if (!fs.existsSync(file)) return {};
  let source: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    // A malformed file carries no provider keys. Log neither its contents
    // nor the parser's message, which quotes them.
    log('warn', 'chat', 'claude settings file is unreadable; no provider settings carried over', {
      file, error: error instanceof Error ? error.name : 'unknown',
    });
    return {};
  }
  const settings: Record<string, unknown> = {};
  for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'model', 'fallbackModel',
    'availableModels', 'enforceAvailableModels', 'modelOverrides', 'modelSettings']) {
    if (source[key] !== undefined) settings[key] = source[key];
  }
  if (source.env && typeof source.env === 'object') {
    settings.env = Object.fromEntries(Object.entries(source.env).filter(([key]) => /^(ANTHROPIC_|AWS_|GOOGLE_|CLOUD_ML_|CLAUDE_CODE_USE_)/.test(key)));
  }
  return settings;
}

/**
 * The environment of an ephemeral session's CLI (ClaudeSdkTransportOptions.quietTelemetry):
 * `env` without `OTEL_*` and `CLAUDE_CODE_ENABLE_TELEMETRY`, with
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Collected material a check-in
 * reads must not leave through the user's telemetry exporter. Provider and
 * auth variables (apiKeyHelper, awsAuthRefresh, AWS_*, ANTHROPIC_*) are kept:
 * the session reaches its model through them.
 */
export function claudeEphemeralEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const quiet: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^OTEL_/i.test(key) || key.toUpperCase() === 'CLAUDE_CODE_ENABLE_TELEMETRY') continue;
    quiet[key] = value;
  }
  quiet.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return quiet;
}

export async function createClaudeSdkTransport(args: ClaudeSdkTransportOptions): Promise<ClaudeSdkTransport> {
  preflightClaudeAuth(args.configDir, args.spawnEnv);
  const executable = findClaudeBinary(args.binaryPath);
  const sdk = args.sdk ?? await loadClaudeSdk();
  const restricted = args.isolateSettings === true || args.restrictedMode === true || (args.restricted ?? !!args.tools);
  const isolated = args.isolateSettings === true || (!!args.bare && restricted);
  const input = new InputQueue();
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let resolveChild!: (child: ChildProcessWithoutNullStreams) => void;
  const childReady = new Promise<ChildProcessWithoutNullStreams>((resolve) => { resolveChild = resolve; });
  const settings: Record<string, unknown> = { ...(isolated ? claudeProviderSettings(args.log, args.spawnEnv, args.configDir) : {}),
    ...(args.settingsInline ? JSON.parse(args.settingsInline) : {}) };
  // The flag layer outranks user and project settings files, so an explicit
  // value keeps a settings file from turning Ultracode on unseen.
  if (args.ultracode === true || (args.ultracode === false && !isolated)) settings.ultracode = args.ultracode;
  // Provider credentials belong in the child environment, not in the inline
  // --settings argv visible to process inspectors.
  const settingsEnv: NodeJS.ProcessEnv = settings.env && typeof settings.env === 'object'
    ? Object.fromEntries(Object.entries(settings.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  delete settings.env;
  const mcpServers = args.mcpConfigInline ? JSON.parse(args.mcpConfigInline).mcpServers : {};
  const options: Options = {
    cwd: args.cwd,
    pathToClaudeCodeExecutable: executable,
    model: args.model ? resolveClaudeCliModelId(args.model) : undefined,
    effort: args.effort,
    resume: args.resumeSessionId,
    forkSession: args.forkSession,
    sessionId: args.sessionId,
    persistSession: args.persistSession !== false,
    includePartialMessages: true,
    forwardSubagentText: args.forwardSubagentText,
    systemPrompt: { type: 'preset', preset: 'claude_code', ...(args.systemPromptAppend ? { append: args.systemPromptAppend } : {}) },
    // --bare suppresses SDK PreToolUse hooks too. Restricted Run sessions
    // instead isolate settings sources while keeping mandatory hooks enabled.
    settingSources: isolated ? [] : ['user', 'project', 'local'],
    settings: restricted ? { ...settings, disableAllHooks: false } : settings,
    mcpServers,
    strictMcpConfig: args.strictMcpConfig,
    permissionMode: args.permissionMode ?? 'default',
    // This enables a later explicit YOLO mode switch; it does not enable bypass.
    allowDangerouslySkipPermissions: !restricted,
    tools: args.tools ?? { type: 'preset', preset: 'claude_code' },
    ...(args.disallowedTools?.length ? { disallowedTools: args.disallowedTools } : {}),
    additionalDirectories: args.addDirs,
    env: (() => {
      const env = claudeChildEnv({ ...args.spawnEnv, ...settingsEnv }, args.configDir, args.env);
      return args.quietTelemetry ? claudeEphemeralEnv(env) : env;
    })(),
    extraArgs: { ...(args.bare && !restricted ? { bare: null } : {}), ...(args.includeHookEvents ? { 'include-hook-events': null } : {}),
      ...(args.restrictedMode ? { restricted: null } : {}) },
    canUseTool: (name, toolInput, context) => args.authorize(name, toolInput, context.toolUseID, context.signal),
    hooks: { PreToolUse: [{ hooks: [async (hook, id, context) => {
      if (hook.hook_event_name !== 'PreToolUse') return {};
      const result = await args.preToolUse(hook.tool_name, hook.tool_input as Record<string, unknown>, id ?? hook.tool_use_id, context.signal);
      if (!result) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.behavior,
        ...(result.behavior === 'allow' ? { updatedInput: result.updatedInput } : { permissionDecisionReason: result.message }) } };
    }] }] },
    stderr: (text) => { if (!closed) args.onStderr(text); },
    spawnClaudeCodeProcess: (spawn) => {
      if (closed) throw new Error('Claude SDK transport closed during startup');
      child = spawnAgentProcess(spawn.command, spawn.args, { cwd: spawn.cwd, env: spawn.env, signal: spawn.signal });
      resolveChild(child);
      return child;
    },
  };
  let query: Query | undefined;
  const cleanFailedStartup = () => {
    closed = true;
    input.close();
    try { query?.close(); } finally {
      // Until this factory returns, Session cannot retire a child it has not
      // received. Keep process-tree cleanup owned here on every startup error.
      if (child?.pid) killProcessTree(child.pid, 'SIGKILL');
    }
  };
  let initialized: ReturnType<Query['initializationResult']>;
  try {
    query = sdk.query({ prompt: input, options });
    initialized = query.initializationResult();
  } catch (error) {
    cleanFailedStartup();
    throw error;
  }
  const activeQuery = query;
  const report = (error: unknown) => { if (!closed) args.onError(error instanceof Error ? error : new Error(String(error))); };
  initialized.catch(report);
  void (async () => {
    try {
      for await (const message of activeQuery) { if (!closed) args.onMessage(message as unknown as Record<string, unknown>); }
      if (!closed) report(new Error('Claude SDK output ended. Original session retained.'));
    } catch (error) { report(error); }
  })();
  try {
    child = await withDeadline(childReady, 10000, 'Claude SDK process did not start');
  } catch (error) { cleanFailedStartup(); throw error; }
  return {
    child, query: activeQuery, initialized,
    send: (message) => input.push(message),
    close: () => { if (!closed) { closed = true; input.close(); activeQuery.close(); } },
  };
}
