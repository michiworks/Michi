import {
  COMPANION_TURN_REF_LIMITS,
  type CompanionTurnRef,
  type MetaAgentChatTurnContext,
  type MichiAssistantConversations,
  type MichiAssistantRuntimeSwitch,
} from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import type { AgentReasoning, RuntimeId } from './agentRuntime';

// The ⌘J assistant: one dedicated Michi chat node in a hidden system
// workspace, served by the local backend's `/api/assistant`. Older backends
// answer 404; callers treat that as "no assistant here".

export interface AssistantSettings {
  runtimeId: RuntimeId;
  /** Provider runtimes (Pi) only. Absent from older backends. */
  providerId?: string | null;
  /** Null = the runtime's default model. */
  modelId: string | null;
  /** Null = the model's default reasoning. */
  reasoning: AgentReasoning | null;
}

export interface AssistantInfo {
  nodeId: string;
  workspaceId: string;
  treeId: string;
  /** The global runtime settings: what a new conversation runs on. */
  settings: AssistantSettings;
  /**
   * What the current conversation runs on: what the user picked in its
   * composer, else `settings`. Absent from older backends.
   */
  conversation?: AssistantSettings;
  /** True while the conversation has no pick of its own. Absent from older backends. */
  conversationFollowsGlobal?: boolean;
  supportedRuntimes: RuntimeId[];
  /** Where the conversation moved to another runtime, oldest first. Absent from older backends. */
  runtimeSwitches?: MichiAssistantRuntimeSwitch[];
  /**
   * The conversation held the user's own messages before the v2 merge
   * (`v2_merged_at`): they used ⌘J before, so the panel shows the one-time
   * upgrade note (DESIGN-v2 §1.5, D7). The backend decides; absent = false.
   */
  hadMessagesBeforeMerge?: boolean;
}

export type AssistantSettingsPatch = Partial<AssistantSettings> & {
  /** The conversation the pick is for; the current one when omitted. */
  nodeId?: string;
};

/** Fired on window after the assistant starts over; `detail` is the new AssistantInfo. */
export const MICHI_ASSISTANT_RESET_EVENT = 'michi:assistant-reset';

export class AssistantApiError extends Error {
  readonly status: number;
  /** True when this backend has no (usable) assistant: a 404, or an answer of the wrong shape. */
  readonly missing: boolean;
  /** 409 assistant_changed: the conversation that is current now (another window started over or switched). */
  readonly current: AssistantInfo | null;
  constructor(status: number, message: string, missing = status === 404, current: AssistantInfo | null = null) {
    super(message);
    this.name = 'AssistantApiError';
    this.status = status;
    this.missing = missing;
    this.current = current;
  }
}

/** True for an error that means "no assistant here", so callers hide it rather than report a failure. */
export function isAssistantMissing(err: unknown): boolean {
  return err instanceof AssistantApiError && err.missing;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAssistantInfo(value: unknown): value is AssistantInfo {
  return isObject(value)
    && typeof value.nodeId === 'string' && value.nodeId !== ''
    && typeof value.workspaceId === 'string' && value.workspaceId !== ''
    && isObject(value.settings) && typeof value.settings.runtimeId === 'string'
    && Array.isArray(value.supportedRuntimes) && value.supportedRuntimes.every((id) => typeof id === 'string');
}

async function assistantJson(path: string, init?: { method: 'PUT' | 'POST'; body?: unknown }): Promise<AssistantInfo> {
  const res = await fetch(`${API_BASE_URL}/assistant${path}`, init ? {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.body ?? {}),
  } : undefined);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AssistantApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `Assistant request failed (${res.status})`,
      res.status === 404,
      body?.code === 'assistant_changed' && isAssistantInfo(body.current) ? body.current : null,
    );
  }
  if (!isAssistantInfo(body)) throw new AssistantApiError(res.status, 'Unexpected assistant response', true);
  return body;
}

export function fetchAssistant(): Promise<AssistantInfo> {
  return assistantJson('');
}

/** The user's pick in one conversation's composer; that conversation keeps it, new ones follow the global settings. */
export function updateAssistantSettings(patch: AssistantSettingsPatch): Promise<AssistantInfo> {
  return assistantJson('/settings', { method: 'PUT', body: patch });
}

/** Starts the assistant over in a fresh conversation. */
export function resetAssistant(nodeId?: string): Promise<AssistantInfo> {
  return assistantJson('/reset', { method: 'POST', ...(nodeId ? { body: { nodeId } } : {}) });
}

export async function fetchAssistantConversations(cursor?: string, signal?: AbortSignal): Promise<MichiAssistantConversations> {
  const params = new URLSearchParams({ limit: '5', ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${API_BASE_URL}/assistant/conversations?${params}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new AssistantApiError(res.status, body?.error ?? 'Could not load conversations');
  if (!body || !Array.isArray(body.items) || !body.items.every((item: Record<string, unknown>) => typeof item.nodeId === 'string' && typeof item.title === 'string' && typeof item.updatedAt === 'number')
    || !(body.nextCursor === null || typeof body.nextCursor === 'string')) throw new AssistantApiError(200, 'Unexpected conversation history');
  return body;
}

export function activateAssistantConversation(nodeId: string, currentNodeId: string): Promise<AssistantInfo> {
  return assistantJson(`/conversations/${encodeURIComponent(nodeId)}/activate`, { method: 'POST', body: { currentNodeId } });
}

/**
 * Reads what one message to the assistant's conversation carries as
 * `metaAgentContext`. `consume` is true for the user's own send: it takes the
 * chips that send carried and the post it replies to, once. A retry reads it
 * without taking anything another send is about to carry.
 */
type MetaAgentTurnContextReader = (options: { consume: boolean }) => MetaAgentChatTurnContext | null;

const turnContexts = new Map<string, MetaAgentTurnContextReader>();
/** The context of the message going out right now (withMetaAgentTurnContext); null: it carries none. */
const carried = new Map<string, MetaAgentChatTurnContext | null>();

/**
 * Supplies `metaAgentContext` for messages sent to the assistant's
 * conversation `nodeId` (state/companion/companionTurnSource.ts keeps one
 * registered for V, whether or not the panel shows it). The backend refuses
 * the field on any other chat, so register only that node. Returns the
 * unregister function.
 */
export function provideMetaAgentTurnContext(nodeId: string, read: MetaAgentTurnContextReader): () => void {
  turnContexts.set(nodeId, read);
  return () => { if (turnContexts.get(nodeId) === read) turnContexts.delete(nodeId); };
}

/**
 * The context a message to `nodeId` carries, read the moment the user sends
 * it (DESIGN-v2 §1.3; F1a-review #1): the store keeps it with that message
 * (a queued entry, the message itself for a retry), so it goes out with it
 * even after the panel closed. Undefined for a node nobody provides for.
 */
export function captureMetaAgentTurnContext(nodeId: string, options: { consume: boolean } = { consume: true }): MetaAgentChatTurnContext | null | undefined {
  const read = turnContexts.get(nodeId);
  return read ? read(options) : undefined;
}

/**
 * Runs `start` (which builds and sends the request synchronously) with the
 * context that was captured for this message: the request carries it, not
 * whatever the screen shows now. `undefined` leaves the provider to answer.
 */
export function withMetaAgentTurnContext<T>(nodeId: string, context: MetaAgentChatTurnContext | null | undefined, start: () => T): T {
  if (context === undefined) return start();
  carried.set(nodeId, context);
  try {
    return start();
  } finally {
    carried.delete(nodeId);
  }
}

const refKey = (ref: CompanionTurnRef): string => JSON.stringify(ref);

/**
 * One message made of several queued sends (F1a-review #1): the area fields of
 * the last one that had any, every one's references (deduplicated, within
 * the limit). Null when none carried anything; undefined when none was read.
 */
export function mergeMetaAgentTurnContexts(contexts: ReadonlyArray<MetaAgentChatTurnContext | null | undefined>): MetaAgentChatTurnContext | null | undefined {
  if (contexts.every((context) => context === undefined)) return undefined;
  const present = contexts.filter((context): context is MetaAgentChatTurnContext => !!context);
  if (present.length === 0) return null;
  const refs: CompanionTurnRef[] = [];
  const seen = new Set<string>();
  for (const ref of present.flatMap((context) => context.refs ?? [])) {
    const key = refKey(ref);
    if (seen.has(key) || refs.length >= COMPANION_TURN_REF_LIMITS.refs) continue;
    seen.add(key);
    refs.push(ref);
  }
  const lastWithArea = [...present].reverse().find((context) => Object.keys(context).some((key) => key !== 'refs'));
  const { refs: _ignored, ...area } = lastWithArea ?? {};
  void _ignored;
  const merged: MetaAgentChatTurnContext = { ...area, ...(refs.length ? { refs } : {}) };
  return Object.keys(merged).length ? merged : null;
}

/** A retry or an edit: the context read now (nothing taken) with the references the original message carried. */
export function withCarriedRefs(context: MetaAgentChatTurnContext | null | undefined, refs: readonly CompanionTurnRef[] | undefined): MetaAgentChatTurnContext | null | undefined {
  if (!refs?.length) return context;
  return mergeMetaAgentTurnContexts([context ?? null, { refs: [...refs] }]);
}

/** The context the message to `nodeId` going out now carries (stream.ts reads it as it builds the request). */
export function metaAgentTurnContextFor(nodeId: string): MetaAgentChatTurnContext | undefined {
  if (carried.has(nodeId)) return carried.get(nodeId) ?? undefined;
  return turnContexts.get(nodeId)?.({ consume: true }) ?? undefined;
}
