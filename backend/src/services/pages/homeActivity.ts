import {
  SPACE_ACTIVITY_LIMITS, clipPageName, isCheckinNodeId, isSystemWorkspaceSettings, pageBlockName, pageRowName, parseChangeSource, titleColumn,
  type ChangeSource, type MichiDbColumn, type PageBlock, type SpaceActivityDetail, type SpaceActivityItem, type TargetSnapshot,
} from 'michi-shared';
import { getDb } from '../db';
import { homeHiddenJoin, pageShownOnHome } from './homeVisibility';
import { FIRST_LOOK_WINDOW_MS, blockLine, getSpacesHomeLook, parseJson, snapshotLine } from './homeSections';
import { startedConversations } from './progressCards';
import { checkinSourceResolver, companionActorOf, type CheckinSourceResolver } from './checkinSources';
import { sourceNodeId } from './core';

type ChangeRow = {
  seq: number; batch_id: string; workspace_id: string; op: string; after_json: string | null; before_json: string | null;
  source: string; source_node_id: string | null; proposal_state: string | null; application_state: string | null;
  target_key: string; created_at: number;
  workspace_name: string; workspace_owner: string | null; workspace_settings: string | null;
  workspace_deleted_at: number | null; workspace_archived_at: number | null; workspace_purged_at: number | null; home_hidden_at: number | null;
  page_id: string | null; page_title: string | null; page_role: string | null; page_deleted_at: number | null; page_owner: string | null;
  database_id: string | null; database_columns: string | null;
};

/** Recent change rows read per request; groups are made from these. */
const CHANGE_WINDOW = 500;
/** Changes further apart than this start a new group, even from the same writer. */
const GROUP_GAP_MS = 30 * 60_000;
const NAME_MAX = 24;
const NAMES_SHOWN = 3;

function recentChanges(ownerUserId: string): ChangeRow[] {
  return getDb().prepare(`SELECT c.seq,c.batch_id,c.workspace_id,c.op,c.after_json,c.before_json,c.source,c.source_node_id,c.proposal_state,
      c.application_state,c.target_key,c.created_at,
      w.name AS workspace_name,w.owner_user_id AS workspace_owner,w.settings AS workspace_settings,
      w.deleted_at AS workspace_deleted_at,w.archived_at AS workspace_archived_at,w.purged_at AS workspace_purged_at,hp.hidden_at AS home_hidden_at,
      p.id AS page_id,p.title AS page_title,p.role AS page_role,p.deleted_at AS page_deleted_at,p.owner_user_id AS page_owner,
      c.database_id,d.columns_json AS database_columns
    FROM page_changes c JOIN workspaces w ON w.id=c.workspace_id ${homeHiddenJoin('w')}
    LEFT JOIN page_databases d ON d.id=c.database_id AND d.owner_user_id=c.owner_user_id
    LEFT JOIN pages p ON p.id=COALESCE(c.page_id,(SELECT r.page_id FROM page_database_refs r JOIN pages rp ON rp.id=r.page_id
        WHERE r.database_id=c.database_id AND rp.deleted_at IS NULL ORDER BY rp.position,rp.id LIMIT 1))
    WHERE c.owner_user_id=? AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL AND hp.hidden_at IS NULL
    ORDER BY c.seq DESC LIMIT ?`).all(ownerUserId, ownerUserId, CHANGE_WINDOW) as unknown as ChangeRow[];
}

function shown(row: ChangeRow, ownerUserId: string): boolean {
  return row.page_id !== null && row.page_owner !== null && pageShownOnHome(
    { role: row.page_role, deleted_at: row.page_deleted_at, owner_user_id: row.page_owner },
    { owner_user_id: row.workspace_owner, settings: row.workspace_settings, deleted_at: row.workspace_deleted_at,
      archived_at: row.workspace_archived_at, purged_at: row.workspace_purged_at, home_hidden_at: row.home_hidden_at },
    ownerUserId);
}

/** Who wrote a change, as one key: a conversation turn, a maintenance run, a component version, or the person. */
function writerKey(source: ChangeSource | null): string {
  switch (source?.kind) {
    case 'chat': case 'helper': return `${source.kind}:${source.nodeId}:${source.turnId}`;
    case 'maintenance': return `run:${source.runId}`;
    case 'component': return `component:${source.componentId}:${source.version}`;
    default: return 'user';
  }
}

interface Group {
  key: string;
  source: ChangeSource | null;
  /** Newest first. */
  rows: ChangeRow[];
}

/**
 * One group per page and writer: a conversation turn, a maintenance run, or a
 * stretch of the person's own edits. A group holds consecutive changes on its
 * page, none further than GROUP_GAP_MS from the next.
 */
function groupChanges(ownerUserId: string, limit: number): Group[] {
  const groups: Group[] = [];
  const open = new Map<string, Group>();
  for (const row of recentChanges(ownerUserId)) {
    if (!shown(row, ownerUserId)) continue;
    const source = parseChangeSource(parseJson(row.source));
    const key = writerKey(source);
    const pageId = row.page_id!;
    const current = open.get(pageId);
    if (current && current.key === key && current.rows.at(-1)!.created_at - row.created_at <= GROUP_GAP_MS) {
      current.rows.push(row);
      continue;
    }
    if (groups.length >= limit) {
      open.delete(pageId);
      continue;
    }
    const group: Group = { key, source, rows: [row] };
    groups.push(group);
    open.set(pageId, group);
  }
  return groups;
}

/** The column a row change is named by: the one the database's views title its rows by. */
function titleColumnId(row: ChangeRow): string | null {
  if (!row.database_id || !row.database_columns) return null;
  const columns = parseJson(row.database_columns);
  return Array.isArray(columns) ? titleColumn({ id: row.database_id, kind: 'user', columns: columns as MichiDbColumn[] })?.id ?? null : null;
}

function snapshotName(snapshot: TargetSnapshot | null, row: ChangeRow): string {
  if (!snapshot || !snapshot.exists) return '';
  if (snapshot.kind === 'block') return pageBlockName(snapshot.block, NAME_MAX);
  if (snapshot.kind === 'row') return pageRowName(snapshot.row.values, titleColumnId(row), NAME_MAX);
  return clipPageName(snapshot.database.title, NAME_MAX);
}

const snapshotOf = (raw: string | null) => parseJson(raw) as TargetSnapshot | null;
const blockOf = (snapshot: TargetSnapshot | null) => (snapshot?.kind === 'block' && snapshot.exists ? snapshot.block : null);

const VALUE = /[¥$€£]?\d[\d,]*(?:\.\d+)?%?/g;
const VALUE_TYPES = new Set<PageBlock['type']>(['callout', 'markdown', 'heading', 'metrics']);

/** The one value that differs between two texts, when every other value the old text held is still there. */
export function oneValueChange(before: string, after: string): { from: string; to: string } | null {
  const a = before.match(VALUE) ?? [];
  const b = after.match(VALUE) ?? [];
  if (a.length === 0 || b.length < a.length) return null;
  const changed = a.flatMap((value, index) => (value === b[index] ? [] : [index]));
  return changed.length === 1 ? { from: a[changed[0]!]!, to: b[changed[0]!]! } : null;
}

type ListBlock = Extract<PageBlock, { type: 'checklist' | 'next-steps' | 'timeline' }>;
const isList = (block: PageBlock): block is ListBlock => block.type === 'checklist' || block.type === 'next-steps' || block.type === 'timeline';

/** Entries a list block only gained, or only lost. */
function entryChange(before: ListBlock, after: ListBlock): { added: number; removed: number } | null {
  const key = (item: unknown) => JSON.stringify(item);
  const had = new Set(before.items.map(key));
  const has = new Set(after.items.map(key));
  const added = after.items.filter((item) => !had.has(key(item))).length;
  const removed = before.items.filter((item) => !has.has(key(item))).length;
  return (added > 0) !== (removed > 0) ? { added, removed } : null;
}

type NodeInfo = { title: string | null; settings: string | null };

function nodesById(ids: readonly string[]): Map<string, NodeInfo> {
  if (!ids.length) return new Map();
  const rows = getDb().prepare(`SELECT n.id,n.title,w.settings FROM nodes n LEFT JOIN workspaces w ON w.id=n.workspace_id
    WHERE n.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; title: string | null; settings: string | null }>;
  return new Map(rows.map((row) => [row.id, { title: row.title, settings: row.settings }]));
}

/** The node a group's writer is named by: a conversation turn's own node, or the one conversation a maintenance run cites. */
function namingNode(source: ChangeSource | null): string | null {
  if (source?.kind === 'chat' || source?.kind === 'helper') return source.nodeId;
  if (source?.kind === 'maintenance' && source.evidence.length === 1 && (source.read?.count ?? 1) <= 1) return source.evidence[0]!.nodeId;
  return null;
}

/**
 * Who wrote a group. The user's own agent is a CompanionActor: a check-in
 * (by its node id: the node is purged after the run), a conversation in its
 * workspace, or upkeep. Upkeep that read one titled conversation of the
 * person's is named by that conversation, as before.
 */
function writer(source: ChangeSource | null, nodes: ReadonlyMap<string, NodeInfo>): SpaceActivityDetail['by'] {
  if (!source || source.kind === 'user') return { kind: 'user' };
  const nodeId = namingNode(source);
  const node = nodeId ? nodes.get(nodeId) : undefined;
  const settingsOf = (id: string) => nodes.get(id)?.settings;
  if (source.kind !== 'maintenance' || (node && isSystemWorkspaceSettings(node.settings))) {
    const actor = companionActorOf(source, settingsOf);
    if (actor) return actor;
  }
  if (node?.title?.trim()) return { kind: 'conversation', title: node.title.trim() };
  return companionActorOf(source, settingsOf) ?? { kind: 'agent' };
}

const applies = (row: ChangeRow) => row.proposal_state === null || row.proposal_state === 'accepted';

function describe(group: Group, nodes: ReadonlyMap<string, NodeInfo>): SpaceActivityDetail {
  const oldestFirst = [...group.rows].reverse();
  const targets = new Map<string, { first: ChangeRow; last: ChangeRow }>();
  for (const row of oldestFirst) {
    const seen = targets.get(row.target_key);
    if (seen) seen.last = row;
    else targets.set(row.target_key, { first: row, last: row });
  }
  const names = [...new Set([...targets.values()]
    .map(({ first, last }) => snapshotName(snapshotOf(last.after_json), last) || snapshotName(snapshotOf(first.before_json), first))
    .filter(Boolean))].slice(0, NAMES_SHOWN);
  const states = group.rows.map((row) => row.proposal_state);
  const applied = group.rows.filter(applies);
  // Applied changes beside ones still waiting read as an update: "updated 2 places, 1 waiting for you".
  const action: SpaceActivityDetail['action'] = applied.length === 0 ? (states.includes('pending') ? 'suggested' : 'dismissed')
    : states.includes('pending') ? 'updated'
    : states.every((state) => state === 'accepted') ? 'accepted'
    : applied.every((row) => row.op === 'insert') ? 'added'
    : applied.every((row) => row.op === 'delete') ? 'removed'
    : targets.size === 1 && applied.every((row) => row.op === 'update')
      && ['markdown', 'callout', 'heading'].includes(blockOf(snapshotOf(applied[0]!.after_json))?.type ?? '') ? 'rewrote'
    : 'updated';
  const detail: SpaceActivityDetail = {
    by: writer(group.source, nodes), action, names, targets: targets.size,
    undone: applied.length > 0 && applied.every((row) => row.application_state === 'reverted') && !states.includes('pending'),
  };
  const only = targets.size === 1 ? [...targets.values()][0]! : null;
  const before = only ? blockOf(snapshotOf(only.first.before_json)) : null;
  const after = only ? blockOf(snapshotOf(only.last.after_json)) : null;
  if (before && after && before.type === after.type && (action === 'rewrote' || action === 'updated' || action === 'accepted')) {
    if (isList(before) && isList(after)) {
      const entries = entryChange(before, after);
      if (entries) detail.entries = entries;
    } else if (VALUE_TYPES.has(after.type)) {
      const value = oneValueChange(blockLine(before), blockLine(after));
      if (value) detail.value = { name: pageBlockName(after, NAME_MAX), ...value };
    }
  }
  return detail;
}

/** The conversation a group's source opens: a check-in's is the one it posted in (checkinSources.ts). */
function openedNode(nodeId: string | null, resolver: CheckinSourceResolver): string | null {
  if (!nodeId || !isCheckinNodeId(nodeId)) return nodeId;
  return resolver.target(nodeId)?.nodeId ?? null;
}

function pageChangeItems(ownerUserId: string, limit: number): SpaceActivityItem[] {
  const groups = groupChanges(ownerUserId, limit);
  const nodes = nodesById([...new Set(groups.map((group) => namingNode(group.source)).filter((id): id is string => id !== null))]);
  const resolver = checkinSourceResolver(ownerUserId);
  return groups.map((group) => {
    const newest = group.rows[0]!;
    const oldest = group.rows.at(-1)!;
    // The window can cut an old write short; count each write in the group whole.
    const batches = [...new Set(group.rows.map((row) => row.batch_id))];
    const totals = getDb().prepare(`SELECT COUNT(*) AS count,SUM(CASE WHEN proposal_state='pending' THEN 1 ELSE 0 END) AS pending
      FROM page_changes WHERE workspace_id=? AND owner_user_id=? AND batch_id IN (${batches.map(() => '?').join(',')})`)
      .get(newest.workspace_id, ownerUserId, ...batches) as { count: number; pending: number | null };
    const sourceKind = group.source?.kind ?? 'user';
    const system = isSystemWorkspaceSettings(newest.workspace_settings);
    return {
      kind: 'page-change', batchId: newest.batch_id, pageId: newest.page_id!, pageTitle: newest.page_title ?? '',
      workspaceId: system ? '' : newest.workspace_id, workspaceName: system ? '' : newest.workspace_name,
      at: newest.created_at, count: totals.count, pending: totals.pending ?? 0,
      ops: [...new Set(group.rows.map((row) => row.op))], summary: snapshotLine(snapshotOf(oldest.after_json) ?? snapshotOf(oldest.before_json)),
      actor: sourceKind === 'user' ? 'user' : 'agent', sourceKind,
      sourceNodeId: openedNode(group.source ? sourceNodeId(group.source) : newest.source_node_id, resolver),
      detail: describe(group, nodes),
    };
  });
}

export function activityLimit(value: number | undefined): number {
  if (value === undefined) return SPACE_ACTIVITY_LIMITS.default;
  return Math.min(Math.max(1, value), SPACE_ACTIVITY_LIMITS.max);
}

/** The person's own edits and reviews are not news to them. */
function freshFor(item: SpaceActivityItem, since: number): boolean {
  if (item.at <= since) return false;
  if (item.kind === 'conversation') return true;
  return item.actor !== 'user' && item.detail?.action !== 'accepted' && item.detail?.action !== 'dismissed';
}

/**
 * Recent page changes (one item per page and writer, see groupChanges) and
 * conversations started from a page, newest first. An item is fresh when it
 * is newer than the owner's last look at the Spaces Home, or than a day ago
 * before the first look, as Just done counts it.
 */
export function spaceActivity(ownerUserId: string, options: { limit?: number; now?: number } = {}): SpaceActivityItem[] {
  const limit = activityLimit(options.limit);
  const since = getSpacesHomeLook(ownerUserId).lookedAt ?? (options.now ?? Date.now()) - FIRST_LOOK_WINDOW_MS;
  const conversations: SpaceActivityItem[] = startedConversations(ownerUserId, limit).map(({ card, node, pageTitle }) => ({
    kind: 'conversation', threadNodeId: card.thread_node_id, title: node.title ?? '', workspaceId: node.workspace_id,
    workspaceName: node.workspace_name, startedFromPageId: card.started_from_page_id, startedFromPageTitle: pageTitle, at: card.created_at,
  }));
  return [...pageChangeItems(ownerUserId, limit), ...conversations]
    .sort((a, b) => b.at - a.at).slice(0, limit)
    .map((item) => ({ ...item, fresh: freshFor(item, since) }));
}
