import { toast } from 'sonner';
import type { MetaAgentChatPageRef, PageSummaryDto, SpacesHomeDto, SpaceSummaryDto, WorkspaceHomeSummaryDto } from 'michi-shared';
import { isMetaAgentChatId, META_AGENT_CHAT_CONTEXT_LIMITS } from 'michi-shared';
import { fetchPage, PageApiError } from '../../services/api/pages';
import { fetchSpacesHome, fetchWorkspaceHomes } from '../../services/api/spacesHome';
import { loadResource, readResource, resourceKey, startResourceRead, writeResource } from '../pages/resourceCache';
import { openNativePageRoute } from '../pages/nativePageRoute';
import { requestWorkspaceHome } from '../pages/workspaceHomeNav';
import { revealPageTarget } from '../pages/revealPageTarget';
import { navPageEvent } from '../appEvents';
import { namesRemoteEntity } from '../../config/backendIdentity';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';

// The cache keys useSpaces, useSpaceTree, useSpacesHome and useSpacesHomeWorkspaces
// read into; built here so modules that mock those hooks still mount the window.
const spacesKey = (connectionId: string) => resourceKey('spaces', connectionId);
const treeKey = (connectionId: string, workspaceId: string) => resourceKey('page-tree', connectionId, workspaceId);
const spacesHomeKey = (connectionId: string) => resourceKey('spaces-home', connectionId);
const workspaceHomesKey = (connectionId: string) => resourceKey('spaces-home-workspaces', connectionId);

/**
 * The Spaces pages the Meta agent window knows by id: the Spaces Home, each
 * workspace's home and the pages the sidebar has loaded. Only this machine's
 * backend: the Meta agent's conversation lives there.
 */
export interface SpacesHomeIds {
  home: { id: string; title: string } | null;
  workspaces: Record<string, string>;
}

type HomeRead = Pick<SpacesHomeDto, 'page'> | null;
type WorkspaceHomesRead = Array<Pick<WorkspaceHomeSummaryDto, 'workspaceId' | 'homePageId'>> | null;
let derived: { home: HomeRead; workspaces: WorkspaceHomesRead; ids: SpacesHomeIds } | null = null;

/** The ids in the shared cache, which the Spaces Home and sidebar hooks keep fresh too. */
export function getSpacesHomeIds(): SpacesHomeIds {
  const home = readResource<HomeRead>(spacesHomeKey(LOCAL_BACKEND_CONNECTION_ID)).data;
  const workspaces = readResource<WorkspaceHomesRead>(workspaceHomesKey(LOCAL_BACKEND_CONNECTION_ID)).data;
  if (derived?.home !== home || derived.workspaces !== workspaces) {
    const ids: SpacesHomeIds = { home: home?.page ? { id: home.page.id, title: typeof home.page.title === 'string' ? home.page.title : 'Home' } : null, workspaces: {} };
    for (const item of workspaces ?? []) if (item.homePageId) ids.workspaces[item.workspaceId] = item.homePageId;
    derived = { home, workspaces, ids };
  }
  return derived.ids;
}

/**
 * Reads the home page ids again, into the cache. A failed read keeps the ids
 * known so far; older backends without the routes leave them empty.
 */
export async function loadSpacesHomeIds(): Promise<SpacesHomeIds> {
  await Promise.all([
    loadResource(spacesHomeKey(LOCAL_BACKEND_CONNECTION_ID), () => fetchSpacesHome(LOCAL_BACKEND_CONNECTION_ID)),
    loadResource(workspaceHomesKey(LOCAL_BACKEND_CONNECTION_ID), () => fetchWorkspaceHomes(LOCAL_BACKEND_CONNECTION_ID)),
  ]);
  return getSpacesHomeIds();
}

/** Nothing in this window has read the Spaces Home yet. */
const homeIdsUnread = () => readResource(spacesHomeKey(LOCAL_BACKEND_CONNECTION_ID)).status === 'loading';

const sendable = (id: string) => isMetaAgentChatId(id) && !namesRemoteEntity(id);

/** The pages the sidebar knows, for the turn context: Home, workspace homes, then Spaces and their pages. */
export function knownSpacesPages(workspaces: ReadonlyArray<{ id: string; name: string }>): MetaAgentChatPageRef[] {
  const out = new Map<string, MetaAgentChatPageRef>();
  const add = (id: string, title: string, workspaceId?: string) => {
    if (out.has(id) || !sendable(id) || out.size >= META_AGENT_CHAT_CONTEXT_LIMITS.pages) return;
    out.set(id, { id, title: title.slice(0, META_AGENT_CHAT_CONTEXT_LIMITS.titleChars), ...(workspaceId && sendable(workspaceId) ? { workspaceId } : {}) });
  };
  const homeIds = getSpacesHomeIds();
  if (homeIds.home) add(homeIds.home.id, homeIds.home.title);
  for (const ws of workspaces) {
    const homeId = homeIds.workspaces[ws.id];
    if (homeId) add(homeId, ws.name, ws.id);
  }
  for (const space of readResource<SpaceSummaryDto[]>(spacesKey(LOCAL_BACKEND_CONNECTION_ID)).data ?? []) add(space.id, space.title || 'Untitled', space.workspaceId);
  for (const ws of workspaces) {
    for (const page of readResource<PageSummaryDto[]>(treeKey(LOCAL_BACKEND_CONNECTION_ID, ws.id)).data ?? []) add(page.id, page.title || 'Untitled', page.workspaceId);
  }
  return [...out.values()];
}

export interface SpacesPageTarget {
  pageId: string;
  workspaceId?: string;
  backendConnectionId?: string;
  /** A block to show; with `databaseId`, a row of that database. */
  blockId?: string;
  databaseId?: string;
  /** The page already on screen: opening it only scrolls to the block. */
  currentPageId?: string | null;
}

export const PAGE_DELETED_MESSAGE = 'This page has been deleted.';

/** The workspace whose default home `pageId` is: from the Spaces Home's list, or the ids this window loaded. */
function workspaceHomeOf(connectionId: string, pageId: string): string | undefined {
  const listed = readResource<WorkspaceHomeSummaryDto[]>(workspaceHomesKey(connectionId)).data
    ?.find((home) => home.homePageId === pageId)?.workspaceId;
  if (listed || connectionId !== LOCAL_BACKEND_CONNECTION_ID) return listed;
  return Object.entries(getSpacesHomeIds().workspaces).find(([, homePageId]) => homePageId === pageId)?.[0];
}

/**
 * Opens a Spaces page (the Spaces Home and a workspace's home as their own views) and flashes `blockId`.
 * A page that is gone shows a toast instead. Resolves to what happened.
 */
export async function openSpacesPage(target: SpacesPageTarget): Promise<'opened' | 'deleted' | 'failed'> {
  const backendConnectionId = target.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID;
  const reveal = () => { if (target.blockId) revealPageTarget({ targetId: target.blockId, ...(target.databaseId ? { databaseId: target.databaseId } : {}) }); };
  if (target.currentPageId === target.pageId) {
    // Already on screen.
    reveal();
    return 'opened';
  }
  // A home row can name a home before anything in this window has read the home ids.
  const ids = backendConnectionId === LOCAL_BACKEND_CONNECTION_ID && homeIdsUnread() ? loadSpacesHomeIds() : null;
  let workspaceId = target.workspaceId;
  try {
    const page = await fetchPage(target.pageId, { backendConnectionId, workspaceId: workspaceId ?? '' });
    workspaceId = page?.workspaceId ?? workspaceId;
  } catch (error) {
    if (error instanceof PageApiError && (error.status === 404 || error.status === 410)) {
      toast(PAGE_DELETED_MESSAGE);
      return 'deleted';
    }
    if (!workspaceId) {
      toast.error("Couldn't open this page.");
      return 'failed';
    }
  }
  if (!workspaceId) {
    toast(PAGE_DELETED_MESSAGE);
    return 'deleted';
  }
  await ids;
  const workspaceHome = workspaceHomeOf(backendConnectionId, target.pageId);
  if (backendConnectionId === LOCAL_BACKEND_CONNECTION_ID && getSpacesHomeIds().home?.id === target.pageId) {
    navPageEvent.dispatch({ page: 'spaces' });
  } else if (workspaceHome) {
    requestWorkspaceHome({ workspaceId: workspaceHome, backendConnectionId });
  } else {
    openNativePageRoute({ pageId: target.pageId, workspaceId, backendConnectionId });
  }
  reveal();
  return 'opened';
}

/**
 * Test seam.
 * @testonly
 */
export function resetSpacesPagesForTests(next?: SpacesHomeIds): void {
  const homeKey = spacesHomeKey(LOCAL_BACKEND_CONNECTION_ID);
  const homesKey = workspaceHomesKey(LOCAL_BACKEND_CONNECTION_ID);
  writeResource<HomeRead>(homeKey, next?.home ? { page: next.home as SpacesHomeDto['page'] } : null);
  writeResource<WorkspaceHomesRead>(homesKey, next ? Object.entries(next.workspaces).map(([workspaceId, homePageId]) => ({ workspaceId, homePageId })) : null);
  if (next) return;
  // Unread again: data null with a read pending, which nothing will finish.
  startResourceRead(homeKey);
  startResourceRead(homesKey);
}
