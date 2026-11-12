import type { NarrationOption } from 'michi-shared';
import { buildMessagesByNode } from '../chatHydration';
import type { ChatMessage } from '../chatTypes';
import { firstRunActive } from '../metaAgent/spacesFirstRun';
import { fetchTreeMessages } from '../../services/api/persistence';
import type { SpacesFirstRunStatus } from '../../services/api/spacesHome';

/**
 * The panel's side of Pages upkeep's first run: it opens the panel once per
 * opening of Spaces. The run's narration reaches V as Michi's own turns
 * (chatHub.postSelfMessage); the Chat tab reads a question's options from the
 * stored row (fetchWindowConversation).
 */

const OPENED_KEY = 'michi:metaChat:firstRunOpened:v1';

function opened(storage: Storage | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(OPENED_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, number> : {};
  } catch {
    return {};
  }
}

function defaultStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** True while a first run is going that has not opened the window yet; later visits and a finished run never do. */
export function firstRunOpensWindow(connectionId: string, status: SpacesFirstRunStatus | null | undefined, storage = defaultStorage()): boolean {
  if (!status || status.requestedAt === null || !firstRunActive(status)) return false;
  return opened(storage)[connectionId] !== status.requestedAt;
}

export function noteFirstRunOpenedWindow(connectionId: string, requestedAt: number, storage = defaultStorage()): void {
  try {
    storage?.setItem(OPENED_KEY, JSON.stringify({ ...opened(storage), [connectionId]: requestedAt }));
  } catch {
    // Quota or privacy mode: at worst the window opens once more.
  }
}

export interface WindowConversation {
  messages: ChatMessage[];
  /** The options of the last message, when it is a question the first run asked. */
  options: NarrationOption[];
}

function narrationOf(row: Record<string, unknown>): { kind?: unknown; options?: unknown } | null {
  if (typeof row.metadata !== 'string') return null;
  try {
    const value = (JSON.parse(row.metadata) as Record<string, unknown>).metaAgentNarration;
    return value && typeof value === 'object' ? value as { kind?: unknown; options?: unknown } : null;
  } catch {
    return null;
  }
}

function parseOptions(value: unknown): NarrationOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NarrationOption[] => {
    if (!entry || typeof entry !== 'object' || typeof (entry as NarrationOption).label !== 'string') return [];
    const { label, open } = entry as NarrationOption;
    const valid = open && typeof open.nodeId === 'string' && typeof open.workspaceId === 'string' && typeof open.draft === 'string';
    return [valid ? { label, open: { nodeId: open.nodeId, workspaceId: open.workspaceId, draft: open.draft } } : { label }];
  });
}

export async function fetchWindowConversation(ref: { workspaceId: string; treeId: string; nodeId: string }, signal?: AbortSignal): Promise<WindowConversation> {
  const rows = await fetchTreeMessages(ref.workspaceId, ref.treeId, undefined, signal);
  const own = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && (row as Record<string, unknown>).node_id === ref.nodeId);
  const messages = buildMessagesByNode(own)[ref.nodeId] ?? [];
  const last = messages.at(-1);
  const lastRow = last ? own.find((row) => row.id === last.id) : undefined;
  const narration = lastRow ? narrationOf(lastRow) : null;
  return { messages, options: narration?.kind === 'end' ? parseOptions(narration.options) : [] };
}
