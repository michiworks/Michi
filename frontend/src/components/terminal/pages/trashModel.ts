import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { threadDisplayTitle, treeOfRoot } from '../../../state/displayTitle';
import { isArchiveGroupId } from '../../../state/trashActions';
import type { PageTrashEntry } from '../../../services/api/pages';
import { isVisibleConversationNode } from '../../../state/conversationVisibility';
import { nodeMessageCount } from '../../../state/nodeMessageCount';

export interface TrashGroup {
  id: string;
  projectId: string;
  deletedAt: number;
  oldestDeletedAt: number;
  root: ChatNodeState;
  title: string;
  members: ChatNodeState[];
  messageCount: number;
}

export interface TrashSection {
  project: Project;
  groups: TrashGroup[];
}

export type TrashEntry =
  | { kind: 'thread'; project: Project; group: TrashGroup }
  | { kind: 'workspace'; project: Project; groups: TrashGroup[] }
  | { kind: 'page'; project: Project; page: PageTrashEntry };

export const entryKey = (entry: TrashEntry) => entry.kind === 'thread' ? `thread:${entry.group.id}` : entry.kind === 'page' ? `page:${entry.page.deletionGroupId}` : `workspace:${entry.project.id}`;
export const entryTitle = (entry: TrashEntry) => entry.kind === 'thread' ? entry.group.title : entry.kind === 'page' ? entry.page.root.title : entry.project.name;
export const entryDeletedAt = (entry: TrashEntry) => entry.kind === 'thread' ? entry.group.deletedAt : entry.kind === 'page' ? entry.page.deletedAt : entry.project.deletedAt ?? 0;

export function buildTrashSections(projects: Project[], nodes: Record<string, ChatNodeState>): TrashSection[] {
  const byGroup = new Map<string, ChatNodeState[]>();
  for (const node of Object.values(nodes)) {
    if (!node.deletionGroupId || isArchiveGroupId(node.deletionGroupId) || !isVisibleConversationNode(node)) continue;
    const key = `${node.projectId}:${node.deletionGroupId}`;
    const members = byGroup.get(key) ?? [];
    members.push(node);
    byGroup.set(key, members);
  }
  const byProject = new Map<string, TrashGroup[]>();
  const projectById = new Map(projects.map(project => [project.id, project]));
  for (const members of byGroup.values()) {
    const ids = new Set(members.map(node => node.nodeId));
    const root = members.find(node => !node.parentNodeId || !ids.has(node.parentNodeId)) ?? members[0];
    const dates = members.map(node => node.deletedAt ?? 0).filter(Boolean);
    const groups = byProject.get(root.projectId) ?? [];
    // Deleting a thread keeps its tree record, and with it the name the user gave it.
    const project = projectById.get(root.projectId);
    groups.push({
      id: root.deletionGroupId!, projectId: root.projectId, root, members,
      title: threadDisplayTitle(project && treeOfRoot(project, root.nodeId), root, 'Untitled thread'),
      deletedAt: dates.length ? Math.max(...dates) : 0,
      oldestDeletedAt: dates.length ? Math.min(...dates) : 0,
      messageCount: members.reduce((sum, node) => sum + nodeMessageCount(node), 0),
    });
    byProject.set(root.projectId, groups);
  }
  return projects.flatMap(project => {
    const groups = byProject.get(project.id) ?? [];
    return project.deletedAt || groups.length ? [{ project, groups }] : [];
  });
}

export function buildPageTrashEntries(projects: readonly Project[], pagesByWorkspace: ReadonlyMap<string, PageTrashEntry[]>): Extract<TrashEntry, { kind: 'page' }>[] {
  return projects.flatMap(project => (pagesByWorkspace.get(project.id) ?? []).map(page => ({ kind: 'page' as const, project, page })));
}

export function remainingDays(group: TrashGroup, ttl: number, now: number): number | null {
  if (ttl <= 0 || !group.oldestDeletedAt) return null;
  return Math.max(0, Math.ceil((group.oldestDeletedAt + ttl * 86_400_000 - now) / 86_400_000));
}

export function relativeDeletion(ts: number, now: number): string {
  if (!ts) return 'Unknown date';
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

const DAY = 86_400_000;

/** Days before `now`'s calendar day that `ts` falls on: 0 today, 1 yesterday. */
function calendarDaysBefore(ts: number, now: number): number {
  const start = (value: number) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
  return Math.round((start(now) - start(ts)) / DAY);
}

/** Trash's time groups, by the calendar day an item was deleted. */
export type DeletionBucket = 'Today' | 'Yesterday' | 'Last 7 days' | 'Earlier';

export function deletionBucket(ts: number, now: number): DeletionBucket {
  const days = calendarDaysBefore(ts, now);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Last 7 days' : 'Earlier';
}

/** Consecutive runs of one bucket, in the order the items are already sorted. */
export function groupByBucket<T>(items: readonly T[], deletedAt: (item: T) => number, now: number): Array<{ bucket: DeletionBucket; items: T[] }> {
  const groups: Array<{ bucket: DeletionBucket; items: T[] }> = [];
  for (const item of items) {
    const bucket = deletionBucket(deletedAt(item), now);
    const last = groups[groups.length - 1];
    if (last?.bucket === bucket) last.items.push(item);
    else groups.push({ bucket, items: [item] });
  }
  return groups;
}

/** Days until automatic deletion; only threads expire, and only while retention is on. */
export function entryRemainingDays(entry: TrashEntry, ttl: number, now: number): number | null {
  return entry.kind === 'thread' ? remainingDays(entry.group, ttl, now) : null;
}

/** Within three days of automatic deletion. */
export function isExpiringSoon(entry: TrashEntry, ttl: number, now: number): boolean {
  const days = entryRemainingDays(entry, ttl, now);
  return days !== null && days <= 3;
}

/** Thread groups the retention sweep deletes as soon as `ttl` takes effect. */
export function groupsPastRetention(sections: TrashSection[], ttl: number, now: number): TrashGroup[] {
  if (ttl <= 0) return [];
  return sections.flatMap(section => section.groups).filter(group => group.oldestDeletedAt > 0 && group.oldestDeletedAt < now - ttl * DAY);
}
