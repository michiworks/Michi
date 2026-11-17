import { useCallback, useMemo } from 'react';
import type { HomeSectionItem, SpacesHomeSectionsDto } from 'michi-shared';
import { useOptionalChatProjects, useStructuralSelector } from '../../../../state/chatStore';
import type { ChatNodeState } from '../../../../state/chatTypes';
import { useHomeSections, type HomeResource } from '../../../../state/pages/useSpacesHome';

/**
 * Whether the user opened a Just done conversation after it completed, by the
 * conversation sidebar's unread mark: its `viewedAt` against its last reply,
 * and the conversation on screen counts as read. A node this window has not
 * seen opened since it loaded keeps its row.
 */
export function openedSinceDone(item: HomeSectionItem, node: ChatNodeState | undefined, focusedNodeId: string | null): boolean {
  if (item.target.kind !== 'conversation') return false;
  if (item.target.nodeId === focusedNodeId) return true;
  if (!node || node.viewedAt === undefined) return false;
  return Math.max(node.lastAssistantAt ?? 0, item.at ?? 0) <= node.viewedAt;
}

/**
 * Whether the user opened a failed Waiting or Stalled conversation since it
 * failed, by the sidebar's Failed mark: the node still failed, and its
 * `viewedAt` at or after the failure, or the conversation on screen now. The
 * backend leaves such a row out on its next read (homeSections'
 * failureSettled); this drops it at once. A node this window has not loaded
 * keeps its row until then.
 */
export function openedSinceFailed(item: HomeSectionItem, node: ChatNodeState | undefined, focusedNodeId: string | null): boolean {
  if (item.target.kind !== 'conversation' || node?.status !== 'error') return false;
  if (item.target.nodeId === focusedNodeId) return true;
  if (node.viewedAt === undefined || item.at === null) return false;
  // A retry that failed again since the backend's read is a new failure the row does not show yet.
  return Math.max(item.at, node.errorCompletedAt ?? 0) <= node.viewedAt;
}

/** The sections without the Just done rows the user has opened since; the total drops with them. */
export function withoutOpenedDone(sections: SpacesHomeSectionsDto, opened: ReadonlySet<string>): SpacesHomeSectionsDto {
  if (opened.size === 0) return sections;
  const items = sections.done.items.filter((item) => !opened.has(item.id));
  const dropped = sections.done.items.length - items.length;
  return { ...sections, done: { ...sections.done, items, total: Math.max(items.length, sections.done.total - dropped) } };
}

/** The sections without the failed Waiting and Stalled rows the user has opened since; totals and per-workspace counts drop with them. */
export function withoutOpenedFailures(sections: SpacesHomeSectionsDto, opened: ReadonlySet<string>): SpacesHomeSectionsDto {
  if (opened.size === 0) return sections;
  let byWorkspace = sections.byWorkspace;
  const drop = (key: 'waiting' | 'stalled') => {
    const section = sections[key];
    const items = section.items.filter((item) => !opened.has(item.id));
    if (items.length === section.items.length) return section;
    for (const item of section.items) {
      const counts = item.workspaceId ? byWorkspace?.[item.workspaceId] : undefined;
      if (!opened.has(item.id) || !counts || !item.workspaceId) continue;
      byWorkspace = { ...byWorkspace, [item.workspaceId]: { ...counts, [key]: Math.max(0, counts[key] - 1) } };
    }
    return { ...section, items, total: Math.max(items.length, section.total - (section.items.length - items.length)) };
  };
  const waiting = drop('waiting');
  const stalled = drop('stalled');
  if (waiting === sections.waiting && stalled === sections.stalled) return sections;
  return { ...sections, waiting, stalled, ...(byWorkspace ? { byWorkspace } : {}) };
}

const NO_ITEMS: readonly HomeSectionItem[] = [];

type OpenedSince = (item: HomeSectionItem, node: ChatNodeState | undefined, focusedNodeId: string | null) => boolean;

/** The ids of `items` opened since, by `opened`, joined so an unchanged answer keeps its identity. */
function useOpenedKey(items: readonly HomeSectionItem[], opened: OpenedSince): string {
  const focusedNodeId = useOptionalChatProjects()?.focusedNodeId ?? null;
  const select = useCallback((nodes: Record<string, ChatNodeState>) => items
    .filter((item) => item.target.kind === 'conversation' && opened(item, nodes[item.target.nodeId], focusedNodeId))
    .map((item) => item.id).join('\n'), [focusedNodeId, items, opened]);
  return useStructuralSelector(select);
}

/** The ids of `items` opened since they completed, joined so an unchanged answer keeps its identity. */
export function useOpenedDoneKey(items: readonly HomeSectionItem[]): string {
  return useOpenedKey(items, openedSinceDone);
}

export const openedSet = (key: string): ReadonlySet<string> => new Set(key ? key.split('\n') : []);

/**
 * Waiting, Stalled and Done for a connection, counted from Michi's own
 * conversations, without the rows this window opened since (a Just done
 * conversation, a failed one). Read the sections through this rather than
 * useHomeSections, so a row the user opened leaves every list and count at once.
 */
export function useSpacesHomeSections(connectionId: string): HomeResource<SpacesHomeSectionsDto> {
  const resource = useHomeSections(connectionId);
  const openedKey = useOpenedDoneKey(resource.data?.done.items ?? NO_ITEMS);
  const waitingItems = useMemo(
    () => (resource.data ? [...resource.data.waiting.items, ...resource.data.stalled.items] : NO_ITEMS),
    [resource.data],
  );
  const failedKey = useOpenedKey(waitingItems, openedSinceFailed);
  const data = useMemo(() => (resource.data
    ? withoutOpenedFailures(withoutOpenedDone(resource.data, openedSet(openedKey)), openedSet(failedKey))
    : null), [failedKey, openedKey, resource.data]);
  return { ...resource, data };
}

/** The "Waiting on you" total: conversations waiting for a reply plus page suggestions waiting for review. */
export function homeWaitingTotal(sections: SpacesHomeSectionsDto | null | undefined): number {
  return sections?.waiting.total ?? 0;
}
