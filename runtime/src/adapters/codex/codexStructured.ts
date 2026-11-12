import type { StructuredCompletion, StructuredCompletionUsage } from '../../contract/types';
import { abortable } from '../../core/runtimeLifecycle';
import { parseJsonAnswer } from '../../core/structuredAnswer';
import type { CodexAppServerClient } from './CodexAppServerClient';

/**
 * CodexRuntime.completeStructured: one turn on an ephemeral thread, as the
 * title thread runs (codexTitleGenerator.ts), with the answer's schema as the
 * turn's outputSchema. The thread is read-only, approves nothing, keeps no
 * rollout, and its config disables the user's MCP servers, Codex's own
 * memories, its tools and its instruction blocks (CodexRuntime builds it); a
 * short base prompt replaces Codex's default one, and the host's system
 * prompt is the developer instructions.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** Bounds the strict schema of an output format leaves to the host, which validates the answer. */
const UNSTRICT_KEYWORDS = new Set(['minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'format']);

/**
 * The schema as strict structured outputs take it: every object closed and
 * every property required (an optional property of the host's schemas allows
 * null, which the model sends instead of leaving it out), without length or
 * count bounds.
 */
export function strictOutputSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictOutputSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSTRICT_KEYWORDS.has(key)) continue;
    out[key] = key === 'properties' && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, strictOutputSchema(child)]))
      : strictOutputSchema(value);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

export interface CodexStructuredOptions {
  client: CodexAppServerClient;
  cwd: string;
  model: string | null;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort: string;
  /** The thread's config: the user's MCP servers disabled, memories, tools and instruction blocks off. */
  config: Record<string, unknown>;
  /** Codex's base prompt for the thread; absent: Codex's default. */
  baseInstructions?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function threadIdOf(result: Record<string, unknown>): string | null {
  const thread = result['thread'] as Record<string, unknown> | undefined;
  return (typeof thread?.['id'] === 'string' ? thread['id'] : null) ?? (typeof result['threadId'] === 'string' ? result['threadId'] : null);
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** thread/tokenUsage/updated: the thread's running total (an ephemeral thread has this one turn). */
function usageOf(params: Record<string, unknown>): StructuredCompletionUsage | null {
  const tokenUsage = (params['tokenUsage'] ?? params) as Record<string, unknown>;
  const total = (tokenUsage['total'] ?? tokenUsage) as Record<string, unknown>;
  if (!total || typeof total !== 'object') return null;
  const cached = count(total['cachedInputTokens']);
  return {
    inputTokens: Math.max(0, count(total['inputTokens']) - cached),
    outputTokens: count(total['outputTokens']),
    cacheReadTokens: cached,
  };
}

export async function completeCodexStructured(opts: CodexStructuredOptions): Promise<StructuredCompletion> {
  opts.signal?.throwIfAborted();
  const started = await opts.client.request('thread/start', {
    model: opts.model || undefined,
    cwd: opts.cwd,
    ...(opts.baseInstructions ? { baseInstructions: opts.baseInstructions } : {}),
    developerInstructions: opts.system,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    config: opts.config,
  }) as Record<string, unknown>;
  const threadId = threadIdOf(started);
  if (!threadId) throw new Error('codex thread/start did not return a threadId');
  let output = '';
  let usage: StructuredCompletionUsage | null = null;
  let turnId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe = () => {};
  const interrupt = () => {
    if (turnId) void opts.client.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => {});
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const completed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => { interrupt(); reject(new Error(`codex structured answer timed out after ${timeoutMs} ms`)); }, timeoutMs);
    unsubscribe = opts.client.onNotification(threadId, (method, params) => {
      if (method === 'turn/started') {
        const id = (params.turn as { id?: string } | undefined)?.id;
        if (typeof id === 'string') turnId = id;
        return;
      }
      if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') { output += params['delta']; return; }
      if (method === 'thread/tokenUsage/updated') { usage = usageOf(params) ?? usage; return; }
      if (method !== 'turn/completed') return;
      const turn = (params['turn'] ?? params) as Record<string, unknown>;
      if (turn['status'] === 'failed') reject(new Error('codex structured answer turn failed'));
      else if (turn['status'] === 'interrupted') reject(new Error('codex structured answer was interrupted'));
      else resolve();
    });
  });
  const onAbort = () => interrupt();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.all([
      opts.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: opts.prompt }],
        effort: opts.effort,
        summary: 'none',
        outputSchema: strictOutputSchema(opts.schema),
      }).then((result) => {
        const value = result as { turn?: { id?: string }; turnId?: string };
        turnId ??= value.turn?.id ?? value.turnId;
        if (opts.signal?.aborted) interrupt();
      }),
      opts.signal ? abortable(completed, opts.signal) : completed,
    ]);
    return { value: parseJsonAnswer(output), text: output, model: opts.model, usage };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    void opts.client.request('thread/unsubscribe', { threadId }, 2_000).catch(() => {});
  }
}
