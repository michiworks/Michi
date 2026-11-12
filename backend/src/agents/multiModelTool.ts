/**
 * `list_ready_models` and `propose_multi_model_plan`: a chat agent lists the
 * runtimes and models ready right now, then proposes asking several of them
 * the user's question in parallel branches. Proposing only shows a plan card
 * in the caller; the user edits its models and presses Start, and the
 * backend runs the plan without the agent (services/multiModel/).
 *
 * This module imports no ChatHub and no database. The orchestrator reaches
 * it through MultiModelToolPort, configured once at boot (server.ts), the
 * way configureThreadMessaging works. MultiModelError lives here so the
 * handlers recognize it without importing the orchestrator, which
 * re-exports it.
 */
import type { MultiModelProposalResult, ReadyModelsDto } from 'michi-shared';

export interface MultiModelToolCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  runtimeSessionId: string | null;
  turn: { turnId: string; assistantId: string } | null;
  isAgentRun: boolean;
  assistant: boolean;
  maintenance: boolean;
}

export type MultiModelErrorCode =
  | 'not_found' | 'not_proposed' | 'not_running' | 'already_running' | 'thread_busy' | 'thread_not_retryable'
  | 'limit' | 'duplicate_model' | 'model_unavailable' | 'caller_unavailable' | 'refused' | 'invalid';

/** Defined here (not in the orchestrator) so this module needs only shared types; orchestrator.ts re-exports it. */
export class MultiModelError extends Error {
  constructor(readonly code: MultiModelErrorCode, message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export interface MultiModelToolPort {
  propose(caller: MultiModelToolCaller, args: unknown, opts?: { signal?: AbortSignal }): Promise<MultiModelProposalResult>;
  listReadyModels(caller: MultiModelToolCaller): Promise<ReadyModelsDto>;
}

export const PROPOSE_MULTI_MODEL_PLAN_TOOL = 'propose_multi_model_plan';
export const LIST_READY_MODELS_TOOL = 'list_ready_models';

/** The shape threadMessageTool returns: MCP text content, isError on failure. */
interface MichiToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

let configuredPort: MultiModelToolPort | null = null;

/** Wired once at boot (server.ts). Tests pass a port explicitly instead. */
export function configureMultiModelTools(port: MultiModelToolPort | null): void {
  configuredPort = port;
}

const UNAVAILABLE_RESULT = {
  status: 'error',
  code: 'unavailable',
  message: 'Multi-model plans are not available in this Michi backend.',
} as const;

const CANCELLED_RESULT = {
  status: 'error',
  code: 'cancelled',
  message: 'The call was cancelled before the plan was proposed; nothing was created.',
} as const;

function errorResult(value: { status: 'error'; code: string; message: string }): MichiToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: true };
}

function jsonResult(value: MultiModelProposalResult | ReadyModelsDto): MichiToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** The abort of this call's own signal, as opposed to a backend fault that happened while it was aborted. */
function isAbortOf(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  return error === signal.reason || (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** A MultiModelError is the agent's to read; anything else is a backend fault for the generic error path. */
function toolError(error: unknown, signal?: AbortSignal): MichiToolResult {
  if (error instanceof MultiModelError) return errorResult({ status: 'error', code: error.code, message: error.message });
  if (isAbortOf(error, signal)) return errorResult(CANCELLED_RESULT);
  throw error;
}

/** Handler of propose_multi_model_plan: creates the proposed run and returns at once; the user starts it. */
export async function proposeMultiModelPlanTool(
  caller: MultiModelToolCaller,
  args: unknown,
  opts: { signal?: AbortSignal } = {},
  port: MultiModelToolPort | null = configuredPort,
): Promise<MichiToolResult> {
  if (!port) return errorResult(UNAVAILABLE_RESULT);
  if (opts.signal?.aborted) return errorResult(CANCELLED_RESULT);
  try {
    return jsonResult(await port.propose(caller, args, { signal: opts.signal }));
  } catch (error) {
    return toolError(error, opts.signal);
  }
}

/** Handler of list_ready_models. Read-only. */
export async function listReadyModelsTool(
  caller: MultiModelToolCaller,
  port: MultiModelToolPort | null = configuredPort,
): Promise<MichiToolResult> {
  if (!port) return errorResult(UNAVAILABLE_RESULT);
  try {
    return jsonResult(await port.listReadyModels(caller));
  } catch (error) {
    return toolError(error);
  }
}
