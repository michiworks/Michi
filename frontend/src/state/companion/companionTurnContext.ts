import {
  COMPANION_TURN_REF_LIMITS,
  META_AGENT_CHAT_CONTEXT_LIMITS,
  type CompanionTurnRef,
  type MetaAgentChatTurnContext,
  type MichiContextItem,
} from 'michi-shared';
import type { ShellArea } from '../shellArea';
import { buildMetaAgentTurnContext, type MetaChatView } from '../metaChat/turnContext';
import type { CompanionPanelTarget } from './companionPanel';

/**
 * What one message to the agent's conversation carries as metaAgentContext
 * (DESIGN-v2 §1.3), decided by the area on screen when it is sent:
 * - Pages: the Spaces fields (page on screen, block, item, known pages,
 *   remote workspaces by name);
 * - Scheduled: `schedule: {workspaceId}` (the workspace New job preselects),
 *   whatever target is set (the route refuses both together);
 * - a target (a block's Ask, a page helper's draft) in any other area: the
 *   Spaces block fields, so the block is never lost;
 * - everywhere: `refs`, what the message points at besides its text, which
 *   the route checks for check-in and collector material (§2.8 T4).
 * Null when there is nothing to say (a plain message in Conversations).
 */
export interface CompanionTurnContextInput {
  area: ShellArea | null;
  /** Pages on screen: what the Spaces main area shows and the workspaces it knows. */
  spaces: CompanionSpacesScreen | null;
  /** Scheduled on screen: the workspace a new job goes in (null: none to schedule in). */
  scheduleWorkspaceId?: string | null;
  target: CompanionPanelTarget | null;
  /** The chips this send carries. */
  attachments: readonly MichiContextItem[];
  /** The posted check-in the message replies to (its chip filled the composer). */
  replyTo: string | null;
}

export interface CompanionSpacesScreen {
  view: MetaChatView;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  remoteWorkspaces: ReadonlyArray<{ id: string; name: string }>;
}

const ID = /^[^\s\p{Cc}]+$/u;
const usableId = (id: string | null | undefined): id is string => typeof id === 'string' && ID.test(id) && id.length <= COMPANION_TURN_REF_LIMITS.idChars;
const isLocal = (target: CompanionPanelTarget) => (target.backendConnectionId ?? 'local') === 'local';

/** The references a message carries (DESIGN-v2 §1.3): the target, handed-over rows (one per database), Today items, the post it replies to. */
function companionTurnRefs(input: Pick<CompanionTurnContextInput, 'target' | 'attachments' | 'replyTo'>): CompanionTurnRef[] {
  const refs: CompanionTurnRef[] = [];
  const { target } = input;
  if (target && isLocal(target) && usableId(target.pageId)) {
    refs.push({ kind: 'page', pageId: target.pageId, ...(usableId(target.blockId) ? { blockId: target.blockId } : {}) });
  }
  const rows = new Map<string, string[]>();
  // The row a database block's Ask targets is judged as a handed-over row of its database.
  if (target?.row && isLocal(target) && usableId(target.row.databaseId)) {
    rows.set(target.row.databaseId, usableId(target.row.rowId) ? [target.row.rowId] : []);
  }
  for (const item of input.attachments) {
    if (item.kind === 'companion_item' && usableId(item.id)) refs.push({ kind: 'companion_item', itemId: item.id });
    if (item.kind === 'row') {
      // A database row's chip id is `<databaseId>:<rowId>` (dbOps rowContextItem).
      const split = item.id.indexOf(':');
      const databaseId = split > 0 ? item.id.slice(0, split) : '';
      const rowId = split > 0 ? item.id.slice(split + 1) : '';
      if (!usableId(databaseId)) continue;
      const list = rows.get(databaseId) ?? [];
      if (usableId(rowId)) list.push(rowId);
      rows.set(databaseId, list);
    }
  }
  for (const [databaseId, rowIds] of rows) {
    // Taint is judged per database: a hand-off of more rows than a ref may name sends the database alone.
    refs.push(rowIds.length > 0 && rowIds.length <= COMPANION_TURN_REF_LIMITS.rowIds ? { kind: 'rows', databaseId, rowIds } : { kind: 'rows', databaseId });
  }
  if (usableId(input.replyTo)) refs.push({ kind: 'post', messageId: input.replyTo });
  return refs.slice(0, COMPANION_TURN_REF_LIMITS.refs);
}

function blockItem(target: CompanionPanelTarget): { index: number; text: string } | undefined {
  if (target.itemIndex === undefined || !Number.isInteger(target.itemIndex) || target.itemIndex < 0
    || target.itemIndex >= META_AGENT_CHAT_CONTEXT_LIMITS.blockItemIndex) return undefined;
  return { index: target.itemIndex, text: target.itemText ?? '' };
}

export function buildCompanionTurnContext(input: CompanionTurnContextInput): MetaAgentChatTurnContext | null {
  const refs = companionTurnRefs(input);
  const withRefs = (context: MetaAgentChatTurnContext): MetaAgentChatTurnContext => (refs.length ? { ...context, refs } : context);
  const { target } = input;
  if (input.area === 'spaces' && input.spaces) {
    const item = target ? blockItem(target) : undefined;
    return withRefs(buildMetaAgentTurnContext({
      view: input.spaces.view,
      target: target ? {
        pageId: target.pageId, blockId: target.blockId ?? '', backendConnectionId: target.backendConnectionId,
        ...(item ? { item } : target.row ? { row: target.row } : {}),
      } : null,
      workspaces: input.spaces.workspaces,
      remoteWorkspaces: input.spaces.remoteWorkspaces,
    }));
  }
  // Scheduled has no blocks to target: a message sent there is about the job it creates
  // (F1a-review #9). A target still set elsewhere rides only as a reference, for its taint.
  if (input.area === 'scheduled') return withRefs({ schedule: { workspaceId: input.scheduleWorkspaceId ?? null } });
  if (target && isLocal(target) && usableId(target.pageId)) {
    const blockId = usableId(target.blockId) ? target.blockId : null;
    const item = blockId ? blockItem(target) : undefined;
    const row = blockId && !item && target.row && usableId(target.row.databaseId) && usableId(target.row.rowId) ? target.row : undefined;
    return withRefs({
      pageId: target.pageId,
      blockId,
      ...(item ? { blockItem: { index: item.index, text: Array.from(item.text).slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars).join('') } } : {}),
      ...(row ? { blockRow: { databaseId: row.databaseId, rowId: row.rowId, text: Array.from(row.text).slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars).join('') } } : {}),
    });
  }
  return refs.length ? { refs } : null;
}
