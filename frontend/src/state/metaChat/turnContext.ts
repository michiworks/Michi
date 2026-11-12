import type { MetaAgentChatTurnContext } from 'michi-shared';
import { isMetaAgentChatId, META_AGENT_CHAT_CONTEXT_LIMITS } from 'michi-shared';
import { getSpacesHomeIds, knownSpacesPages } from './spacesPages';
import { namesRemoteEntity } from '../../config/backendIdentity';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';

/** What the Spaces main area shows, as the window sees it. */
export type MetaChatView =
  | { kind: 'home' }
  | { kind: 'workspace'; workspaceId: string; name: string }
  | { kind: 'page'; backendConnectionId: string; workspaceId: string; pageId: string };

const usable = (id: string | null | undefined): id is string => isMetaAgentChatId(id) && !namesRemoteEntity(id);

/** At most titleChars UTF-16 units, the bound the backend checks, without splitting a surrogate pair. */
function clip(text: string): string {
  const cut = text.slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The page on screen by id (the Spaces Home and workspace homes are pages too), or null when it isn't known yet. */
export function viewPageId(view: MetaChatView): string | null {
  const homes = getSpacesHomeIds();
  if (view.kind === 'home') return homes.home?.id ?? null;
  if (view.kind === 'workspace') return homes.workspaces[view.workspaceId] ?? null;
  return view.backendConnectionId === LOCAL_BACKEND_CONNECTION_ID ? view.pageId : null;
}

/** The `metaAgentContext` for one message from the window. */
export function buildMetaAgentTurnContext({ view, target, workspaces, remoteWorkspaces = [] }: {
  view: MetaChatView;
  target: {
    pageId: string;
    blockId: string;
    backendConnectionId?: string;
    item?: { index: number; text: string };
    row?: { databaseId: string; rowId: string; text: string };
  } | null;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  /** Workspaces on remote connections, which Spaces doesn't support yet: named so the Meta agent can say so. */
  remoteWorkspaces?: ReadonlyArray<{ id: string; name: string }>;
}): MetaAgentChatTurnContext {
  const onScreen = viewPageId(view);
  const local = target && (target.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID) === LOCAL_BACKEND_CONNECTION_ID ? target : null;
  const pageId = usable(local?.pageId) ? local!.pageId : usable(onScreen) ? onScreen : null;
  const blockId = local && pageId === local.pageId && usable(local.blockId) ? local.blockId : null;
  const item = blockId && local?.item && Number.isInteger(local.item.index) && local.item.index >= 0 && local.item.index < META_AGENT_CHAT_CONTEXT_LIMITS.blockItemIndex
    ? { index: local.item.index, text: clip(local.item.text) }
    : null;
  const row = blockId && !item && local?.row && usable(local.row.databaseId) && usable(local.row.rowId)
    ? { databaseId: local.row.databaseId, rowId: local.row.rowId, text: clip(local.row.text) }
    : null;
  const context: MetaAgentChatTurnContext = {
    pageId,
    blockId,
    ...(item ? { blockItem: item } : {}),
    ...(row ? { blockRow: row } : {}),
    pages: knownSpacesPages(workspaces),
  };
  if (remoteWorkspaces.length === 0) return context;
  const shown = view.kind === 'home' ? null : remoteWorkspaces.find((workspace) => workspace.id === view.workspaceId);
  return {
    ...context,
    remoteWorkspaces: remoteWorkspaces.slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.remoteWorkspaces).map((workspace) => workspace.name.slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars)),
    remoteOnScreen: shown ? shown.name.slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) : null,
  };
}
