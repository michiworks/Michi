/**
 * The Michi assistant: one persistent conversation, kept in a hidden system
 * workspace, that reads Michi threads across every workspace and messages
 * them, and works with native conversations and pages. It is not a worker: it never edits
 * files or runs commands.
 *
 * Backend: GET /api/assistant, PUT /api/assistant/settings, POST /api/assistant/reset.
 */

import type { RuntimeReasoning } from './agentRuns';

/** `settings.system` value marking the assistant's hidden workspace. */
export const ASSISTANT_WORKSPACE_SYSTEM = 'assistant';

/** A runtime/provider/model/reasoning an assistant conversation runs on. */
export interface MichiAssistantSettings {
  runtimeId: string;
  /** Provider runtimes (Pi) only; null elsewhere. Absent from older backends. */
  providerId?: string | null;
  /** Null: the runtime's default model. */
  modelId: string | null;
  /** Null: the runtime's default reasoning. */
  reasoning: RuntimeReasoning | null;
}

/** GET /api/assistant, and the answer of PUT /api/assistant/settings and POST /api/assistant/reset. */
export interface MichiAssistantInfo {
  /** The current conversation's chat node. */
  nodeId: string;
  workspaceId: string;
  treeId: string;
  /** The global runtime settings resolved now: what a new conversation runs on. */
  settings: MichiAssistantSettings;
  /**
   * What the conversation's next message runs on: what the user picked in its
   * composer, else `settings`. When it differs from the runtime the
   * conversation last ran on, that message starts a new native session
   * carrying the visible history.
   */
  conversation: MichiAssistantSettings;
  /** True while the conversation has no pick of its own. Absent from older backends. */
  conversationFollowsGlobal?: boolean;
  /** Runtimes that can host the assistant without file edits, shell or network. */
  supportedRuntimes: string[];
  /**
   * Where the current conversation moved to another runtime, oldest first:
   * show "From here on: <runtime>" after `afterMessageId`. Absent from older
   * backends.
   */
  runtimeSwitches?: MichiAssistantRuntimeSwitch[];
  /**
   * A turn the user sent from the Scheduled area created a scheduled job, so
   * "Create with agent" starts a new conversation (W2 fix decision D6).
   * Absent from older backends.
   */
  jobCreated?: boolean;
  /**
   * The conversation held the user's own messages before the v2 merge
   * (`v2_merged_at`): the panel shows its one-time upgrade note (W2 fix
   * decision D7). The backend decides; absent from older backends (= false).
   */
  hadMessagesBeforeMerge?: boolean;
}

/** One point where an assistant conversation continued on another runtime. */
export interface MichiAssistantRuntimeSwitch {
  /** The last message before the switch. */
  afterMessageId: string;
  previousRuntimeId: string;
  runtimeId: string;
  switchedAt: number;
}

/** A saved assistant conversation, ordered by its most recent message. */
export interface MichiAssistantConversation {
  nodeId: string;
  title: string;
  updatedAt: number;
}

export interface MichiAssistantConversations {
  items: MichiAssistantConversation[];
  nextCursor: string | null;
}

/**
 * PUT /api/assistant/settings: the user's pick in one conversation's
 * composer, which that conversation keeps. Omitted fields keep their value.
 */
export interface MichiAssistantSettingsPatch {
  /** The conversation; the current one when omitted. */
  nodeId?: string;
  runtimeId?: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: RuntimeReasoning | null;
}

/** Workspace `settings` keys only the backend's assistant store writes. */
export const SERVER_OWNED_WORKSPACE_SETTINGS = ['system', 'assistant'] as const;

/** A workspace's `settings` JSON as an object; null when unset, malformed or not an object. */
export function parseWorkspaceSettings(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** True for the settings JSON of the assistant's hidden workspace. */
export function isAssistantWorkspaceSettings(raw: string | null | undefined): boolean {
  return parseWorkspaceSettings(raw)?.system === ASSISTANT_WORKSPACE_SYSTEM;
}

/**
 * The system flag of parsed workspace settings; undefined for a user
 * workspace. Any non-null `settings.system` marks a system workspace, as the
 * SQL predicates read it; a value other than a non-blank string comes back
 * as its JSON so it still reads as set.
 */
export function workspaceSystemOf(settings: Record<string, unknown> | null | undefined): string | undefined {
  const system = settings?.system;
  if (system === undefined || system === null) return undefined;
  return typeof system === 'string' && system.trim() ? system : JSON.stringify(system);
}

/**
 * True for any system workspace (`settings.system` set: the assistant's, or
 * the one holding a cloud Spaces Home). Its conversations are not search or
 * navigation material for anything outside it.
 */
export function isSystemWorkspaceSettings(raw: string | null | undefined): boolean {
  return workspaceSystemOf(parseWorkspaceSettings(raw)) !== undefined;
}

/**
 * The settings JSON to store when a workspace write puts `incoming` over
 * `existing` (null for a new workspace). Server-owned keys always come from
 * `existing`: a write can neither set, change nor drop them, so no client can
 * mark a workspace as the assistant's or unmark it. Everything else is the
 * writer's. The assistant store sets these keys with its own UPDATE.
 */
export function mergeServerOwnedSettings(existing: string | null | undefined, incoming: string | null | undefined): string | null {
  const before = parseWorkspaceSettings(existing);
  const next = parseWorkspaceSettings(incoming);
  const ownedBefore = before ? SERVER_OWNED_WORKSPACE_SETTINGS.filter(key => key in before) : [];
  const ownedIncoming = next ? SERVER_OWNED_WORKSPACE_SETTINGS.filter(key => key in next) : [];
  if (ownedBefore.length === 0 && ownedIncoming.length === 0) return incoming ?? null;
  const merged: Record<string, unknown> = { ...(next ?? {}) };
  for (const key of SERVER_OWNED_WORKSPACE_SETTINGS) delete merged[key];
  for (const key of ownedBefore) merged[key] = before![key];
  return JSON.stringify(merged);
}
