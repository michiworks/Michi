/** Native Pages API and reversible history contracts. Kept dependency-free for
 * use in both the browser and backend. Client input types intentionally omit
 * server-owned identity, revision, ownership and provenance fields. */

import { isRecord } from '../guards';
import { MICHI_DB_COLUMN_TYPES, MICHI_DB_VIEW_TYPES } from '../databaseModel';
import { parsePageBlock, type BlockSource, type PageBlock, type PageBlockWithSources } from './blocks';
import {
  isPageDatabaseCellValues, isPageDatabaseFilter, isPageDatabaseOptionList, isPageDatabaseSort,
  type PageDatabase, type PageDatabaseColumn, type PageDatabaseRow, type PageDatabaseView,
} from './database';
import { parsePageComponentHostConfig } from './components';

/**
 * A conversation message a maintenance change cites. `messageId` is set when
 * the cited message is the turn's user message rather than its reply.
 */
export interface ChangeEvidence extends BlockSource { messageId?: string }

/**
 * What a Meta agent home run read before it wrote, kept so a change without a
 * single cited message still says where it came from ("from 3 conversations").
 * When it is present, `evidence` lists only the messages this change cites.
 */
export interface ChangeReadScope { kind: 'conversations' | 'workspace-homes'; count: number }
export const CHANGE_READ_SCOPE_KINDS: readonly ChangeReadScope['kind'][] = ['conversations', 'workspace-homes'];

export type ChangeSource =
  | { kind: 'user' }
  | ({ kind: 'chat' | 'helper' } & BlockSource)
  | ({ kind: 'maintenance'; jobId: string; runId: string; evidence: ChangeEvidence[]; read?: ChangeReadScope } & BlockSource)
  | { kind: 'component'; componentId: string; version: number; pageId: string; blockId: string }
  | { kind: 'component'; componentId: string; version: number; databaseId: string; viewId: string };

export type ChangeTarget =
  | { kind: 'block'; pageId: string; blockId: string }
  | { kind: 'row'; databaseId: string; rowId: string; columnIds: string[]; body?: true }
  | { kind: 'database'; databaseId: string };

/** The key change history stores a target's changes under (page_changes.target_key). */
export function changeTargetKey(target: ChangeTarget | { kind: 'row'; databaseId: string; rowId: string }): string {
  if (target.kind === 'block') return `block:${target.pageId}:${target.blockId}`;
  if (target.kind === 'row') return `row:${target.databaseId}:${target.rowId}`;
  return `database:${target.databaseId}`;
}

export type ProposalState = 'pending' | 'accepted' | 'dismissed' | null;
export type ApplicationState = 'applied' | 'reverted' | null;

/**
 * How the user's own agent (the one they name in Settings, DESIGN-v2 §2.7)
 * wrote something: `conversation` = a conversation in the assistant's
 * workspace (the one the user talks to, and the archived ⌘J and Scheduled
 * ones); `checkin` = a check-in (node id prefix `n-cmph-`, decided from the id
 * alone because the node is purged after its run); `upkeep` = background
 * Pages maintenance.
 */
export type CompanionActorVia = 'conversation' | 'checkin' | 'upkeep';

export const COMPANION_ACTOR_VIAS: readonly CompanionActorVia[] = Object.freeze(['conversation', 'checkin', 'upkeep']);

/**
 * The agent as the author of a page, a task or a change (DESIGN-v2 §2.7),
 * shown as "<name>", upkeep as "<name> · Pages upkeep" (SpaceSummaryDto.createdBy,
 * SpaceActivityDetail.by, TaskOrigin.by). It replaced the MVP's 'meta-agent'
 * actor: an older backend that still sends that one is read as upkeep by the
 * frontend's API layer (services/api/legacyActor.ts).
 */
export interface CompanionActor {
  kind: 'companion';
  via: CompanionActorVia;
}

/** Narrows an actor field that may hold a CompanionActor beside the older string forms. */
export function isCompanionActor(value: unknown): value is CompanionActor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actor = value as Partial<CompanionActor>;
  return actor.kind === 'companion' && (COMPANION_ACTOR_VIAS as readonly unknown[]).includes(actor.via);
}

export interface PageSummaryDto {
  id: string;
  workspaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  color: string | null;
  updatedAt: number;
  updatedBy: 'user' | 'agent';
  pendingProposals: number;
  helperNodeId: string | null;
}

/** POST /pages/:pageId/helper and /pages/:pageId/helper/promote: the page's helper conversation. */
export interface PageHelperDescriptor {
  workspaceId: string;
  treeId: string;
  nodeId: string;
}

export interface PageDto extends PageSummaryDto {
  revision: number;
  viewVersion: number;
  blocks: PageBlockWithSources[];
}

export interface SpaceSummaryDto extends PageSummaryDto {
  workspaceName: string;
  childTitles: string[];
  pageCount: number;
  databaseCount: number;
  contributorNodeIds: string[];
  /**
   * Who made the Space: a person, the user's own agent (a CompanionActor,
   * DESIGN-v2 §2.7), or an agent in one of the workspace's conversations.
   * Absent from older backends.
   */
  createdBy?: 'user' | 'agent' | CompanionActor;
}

export interface BlockLocation {
  parentId: string | null;
  slot: string | null;
  /** Sibling anchors make restoration safe when positions have changed. */
  previousId: string | null;
  nextId: string | null;
}

export interface RowLocation {
  position: number;
  /** ID of the preceding row, or null when this is the first row. */
  after: string | null;
}

export interface BlockTargetSnapshot {
  kind: 'block';
  exists: true;
  block: PageBlock;
  location: BlockLocation;
}
export interface MissingBlockTargetSnapshot { kind: 'block'; exists: false; id: string; location: null }
export interface RowTargetSnapshot {
  kind: 'row';
  exists: true;
  row: PageDatabaseRow;
  location: RowLocation;
}
export interface MissingRowTargetSnapshot { kind: 'row'; exists: false; id: string; location: null }
export interface DatabaseTargetSnapshot {
  kind: 'database';
  exists: true;
  database: Pick<PageDatabase, 'id' | 'workspaceId' | 'title' | 'columns' | 'views' | 'revision' | 'updatedAt'>;
}
export interface MissingDatabaseTargetSnapshot { kind: 'database'; exists: false; id: string }

/** Complete snapshots retain ownership/provenance and structural anchors. */
export type TargetSnapshot =
  | BlockTargetSnapshot | MissingBlockTargetSnapshot
  | RowTargetSnapshot | MissingRowTargetSnapshot
  | DatabaseTargetSnapshot | MissingDatabaseTargetSnapshot;

export type TargetMutation =
  | { kind: 'block'; op: 'upsert'; block: PageBlock; location: BlockLocation }
  | { kind: 'block'; op: 'delete'; id: string; expectedLocation: BlockLocation }
  | { kind: 'row'; op: 'upsert'; row: PageDatabaseRow; location: RowLocation }
  | { kind: 'row'; op: 'patch'; id: string; values: Record<string, PageDatabaseRow['values'][string]>; body?: string; edited?: Record<string, number>; bodyEditedAt?: number | null }
  | { kind: 'row'; op: 'delete'; id: string; expectedLocation: RowLocation }
  | { kind: 'database'; op: 'replace'; database: Pick<PageDatabase, 'id' | 'workspaceId' | 'title' | 'columns' | 'views'> }
  | { kind: 'database'; op: 'delete'; id: string };

export interface PageChangeDto {
  id: string;
  seq: number;
  batchId: string;
  target: ChangeTarget;
  op: 'insert' | 'update' | 'delete' | 'move' | 'row' | 'schema' | 'view';
  before: TargetSnapshot | null;
  after: TargetSnapshot | null;
  forward: TargetMutation;
  inverse: TargetMutation;
  baseRev: number;
  appliedRev: number | null;
  previousHeadId: string | null;
  source: ChangeSource;
  proposalState: ProposalState;
  applicationState: ApplicationState;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PageWriteResult {
  resource: { kind: 'page' | 'database'; id: string };
  revision: number;
  applied: PageChangeDto[];
  proposed: PageChangeDto[];
  rejected: Array<{ index: number; reason: 'stale' | 'missing' | 'invalid'; message: string }>;
}

/** How an interactive agent write ended: all applied, some, only proposals, none allowed, or nothing to do. */
export type PageWriteCommitStatus = 'committed' | 'partial' | 'proposed' | 'rejected' | 'unchanged';

/** What a write to a task database did to its tasks. */
export interface PageWriteTaskCounts { added: number; updated: number; removed: number }

/**
 * The receipt a page tool's result leads with (agents/pageTools.ts), which the
 * chat's page-write card and page invalidation read. Older tool outputs and
 * output cut at 16 KB can lack any field; readers parse it tolerantly.
 */
export interface MichiPageWriteReceipt {
  kind: 'michiPageWrite';
  resourceKind: 'page' | 'database' | 'component';
  resourceId: string;
  /** The resource's workspace, when a writer outside it (the Meta agent) wrote it. */
  workspaceId?: string;
  originatingPageId?: string;
  originatingPageIds?: string[];
  title: string;
  created?: true;
  revision: number;
  viewVersion?: number;
  atomic?: boolean;
  commitStatus?: PageWriteCommitStatus;
  appliedCount: number;
  proposedCount: number;
  rejectedCount: number;
  affectedTargetIds: string[];
  batchId: string | null;
  /** The write put a task board on the page. */
  taskBoard?: true;
  /** A row write: the column its rows go by. */
  titleColumnId?: string;
  tasks?: PageWriteTaskCounts;
  /** A component write: the version it saved. */
  version?: number;
}

export const PAGE_LIMITS = { title: 200, pagesPerWorkspace: 2_000, manifestEntries: 20, blocks: 40, opsPerEdit: 50 } as const;

/** This state machine is shared by API parsing and database row validation. */
export function isValidChangeState(proposalState: unknown, applicationState: unknown): boolean {
  if (proposalState !== null && !['pending', 'accepted', 'dismissed'].includes(proposalState as string)) return false;
  if (applicationState !== null && !['applied', 'reverted'].includes(applicationState as string)) return false;
  if (proposalState === null) return applicationState === 'applied' || applicationState === 'reverted';
  if (proposalState === 'pending' || proposalState === 'dismissed') return applicationState === null;
  return applicationState === 'applied' || applicationState === 'reverted';
}

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const safeInt = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

export function parseChangeSource(value: unknown): ChangeSource | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'user') return exact(value, ['kind']) ? { kind: 'user' } : null;
  if (value.kind === 'chat' || value.kind === 'helper') {
    return exact(value, ['kind', 'nodeId', 'turnId', 'assistantId']) && [value.nodeId, value.turnId, value.assistantId].every(id)
      ? value as ChangeSource : null;
  }
  if (value.kind === 'maintenance') {
    if (!exact(value, ['kind', 'nodeId', 'turnId', 'assistantId', 'jobId', 'runId', 'evidence', 'read']) ||
      ![value.nodeId, value.turnId, value.assistantId, value.jobId, value.runId].every(id) ||
      !Array.isArray(value.evidence) || value.evidence.length > 100) return null;
    if (!value.evidence.every((entry) => isRecord(entry) && exact(entry, ['nodeId', 'turnId', 'assistantId', 'messageId']) &&
      [entry.nodeId, entry.turnId, entry.assistantId].every(id) && (entry.messageId === undefined || id(entry.messageId)))) return null;
    if (value.read !== undefined && !(isRecord(value.read) && exact(value.read, ['kind', 'count']) &&
      CHANGE_READ_SCOPE_KINDS.includes(value.read.kind as ChangeReadScope['kind']) && safeInt(value.read.count) && (value.read.count as number) <= 100_000)) return null;
    return value as ChangeSource;
  }
  if (value.kind === 'component') {
    if (!safeInt(value.version, 1) || !id(value.componentId)) return null;
    if (exact(value, ['kind', 'componentId', 'version', 'pageId', 'blockId']) && id(value.pageId) && id(value.blockId)) return value as ChangeSource;
    if (exact(value, ['kind', 'componentId', 'version', 'databaseId', 'viewId']) && id(value.databaseId) && id(value.viewId)) return value as ChangeSource;
    return null;
  }
  return null;
}

export function parseChangeTarget(value: unknown): ChangeTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'block') return exact(value, ['kind', 'pageId', 'blockId']) && id(value.pageId) && id(value.blockId) ? value as ChangeTarget : null;
  if (value.kind === 'row') {
    return exact(value, ['kind', 'databaseId', 'rowId', 'columnIds', 'body']) && id(value.databaseId) && id(value.rowId) &&
      Array.isArray(value.columnIds) && value.columnIds.length <= 100 && value.columnIds.every(id) &&
      (value.body === undefined || value.body === true) ? value as ChangeTarget : null;
  }
  if (value.kind === 'database') return exact(value, ['kind', 'databaseId']) && id(value.databaseId) ? value as ChangeTarget : null;
  return null;
}

export function isTargetSnapshot(value: unknown): value is TargetSnapshot {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.exists !== 'boolean') return false;
  if (value.kind === 'block') {
    if (!value.exists) return exact(value, ['kind', 'exists', 'id', 'location']) && id(value.id) && value.location === null;
    return exact(value, ['kind', 'exists', 'block', 'location']) && parsePageBlock(value.block) !== null && validBlockLocation(value.location);
  }
  if (value.kind === 'row') {
    if (!value.exists) return exact(value, ['kind', 'exists', 'id', 'location']) && id(value.id) && value.location === null;
    return exact(value, ['kind', 'exists', 'row', 'location']) && validRowSnapshot(value.row) && validRowLocation(value.location);
  }
  if (value.kind === 'database') {
    if (!value.exists) return exact(value, ['kind', 'exists', 'id']) && id(value.id);
    return exact(value, ['kind', 'exists', 'database']) && validDatabaseSnapshot(value.database);
  }
  return false;
}

export function isTargetMutation(value: unknown): value is TargetMutation {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.op !== 'string') return false;
  if (value.kind === 'block') {
    if (value.op === 'upsert') return exact(value, ['kind', 'op', 'block', 'location']) && parsePageBlock(value.block) !== null && validBlockLocation(value.location);
    if (value.op === 'delete') return exact(value, ['kind', 'op', 'id', 'expectedLocation']) && id(value.id) && validBlockLocation(value.expectedLocation);
    return false;
  }
  if (value.kind === 'row') {
    if (value.op === 'upsert') return exact(value, ['kind', 'op', 'row', 'location']) && validRowSnapshot(value.row) && validRowLocation(value.location);
    if (value.op === 'patch') {
      return exact(value, ['kind', 'op', 'id', 'values', 'body', 'edited', 'bodyEditedAt']) && id(value.id) && isPageDatabaseCellValues(value.values) &&
        (value.body === undefined || typeof value.body === 'string') && (value.edited === undefined || validEdited(value.edited)) &&
        (value.bodyEditedAt === undefined || value.bodyEditedAt === null || safeInt(value.bodyEditedAt));
    }
    if (value.op === 'delete') return exact(value, ['kind', 'op', 'id', 'expectedLocation']) && id(value.id) && validRowLocation(value.expectedLocation);
    return false;
  }
  if (value.kind === 'database') {
    if (value.op === 'replace') return exact(value, ['kind', 'op', 'database']) && isDatabaseContent(value.database);
    if (value.op === 'delete') return exact(value, ['kind', 'op', 'id']) && id(value.id);
    return false;
  }
  return false;
}

export function parseTargetSnapshot(value: unknown): TargetSnapshot | null { return isTargetSnapshot(value) ? value : null; }
export function parseTargetMutation(value: unknown): TargetMutation | null { return isTargetMutation(value) ? value : null; }

export function parsePageChangeDto(value: unknown): PageChangeDto | null {
  if (!isRecord(value) || !exact(value, ['id', 'seq', 'batchId', 'target', 'op', 'before', 'after', 'forward', 'inverse', 'baseRev', 'appliedRev', 'previousHeadId', 'source', 'proposalState', 'applicationState', 'createdAt', 'resolvedAt'])) return null;
  const target = parseChangeTarget(value.target);
  const source = parseChangeSource(value.source);
  if (!id(value.id) || !safeInt(value.seq, 1) || !id(value.batchId) || !target || !source ||
    !['insert', 'update', 'delete', 'move', 'row', 'schema', 'view'].includes(String(value.op)) ||
    (value.before !== null && !isTargetSnapshot(value.before)) || (value.after !== null && !isTargetSnapshot(value.after)) ||
    !isTargetMutation(value.forward) || !isTargetMutation(value.inverse) || !safeInt(value.baseRev, 1) ||
    (value.appliedRev !== null && !safeInt(value.appliedRev, 1)) || (value.previousHeadId !== null && !id(value.previousHeadId)) ||
    !isValidChangeState(value.proposalState, value.applicationState) || !safeInt(value.createdAt) ||
    (value.resolvedAt !== null && !safeInt(value.resolvedAt))) return null;
  return value as unknown as PageChangeDto;
}
export function isPageChangeDto(value: unknown): value is PageChangeDto { return parsePageChangeDto(value) !== null; }

function validBlockLocation(value: unknown): value is BlockLocation {
  return isRecord(value) && exact(value, ['parentId', 'slot', 'previousId', 'nextId']) &&
    (value.parentId === null || id(value.parentId)) && (value.slot === null || id(value.slot)) &&
    (value.previousId === null || id(value.previousId)) && (value.nextId === null || id(value.nextId));
}
function validRowLocation(value: unknown): value is RowLocation {
  return isRecord(value) && exact(value, ['position', 'after']) && safeInt(value.position) && (value.after === null || id(value.after));
}
function validRowSnapshot(value: unknown): value is PageDatabaseRow {
  return isRecord(value) && exact(value, ['id', 'values', 'body', 'position', 'updatedAt', 'rev', 'edited', 'bodyEditedAt']) && id(value.id) && isPageDatabaseCellValues(value.values) && safeInt(value.position) && safeInt(value.updatedAt) && safeInt(value.rev, 1) &&
    validEdited(value.edited) &&
    (value.body === undefined || typeof value.body === 'string') && (value.bodyEditedAt === null || safeInt(value.bodyEditedAt));
}
function validDatabaseSnapshot(value: unknown): value is DatabaseTargetSnapshot['database'] {
  return isRecord(value) && validDatabaseFields(value) && exact(value, ['id', 'workspaceId', 'title', 'columns', 'views', 'revision', 'updatedAt']) && safeInt(value['revision'], 1) && safeInt(value['updatedAt']);
}
function isDatabaseContent(value: unknown): value is Pick<PageDatabase, 'id' | 'workspaceId' | 'title' | 'columns' | 'views'> {
  return isRecord(value) && validDatabaseFields(value) && exact(value, ['id', 'workspaceId', 'title', 'columns', 'views']);
}
function validDatabaseFields(value: Record<string, unknown>): boolean {
  return id(value.id) && id(value.workspaceId) && typeof value.title === 'string' && value.title.length <= 200 &&
    Array.isArray(value.columns) && value.columns.length <= 100 && value.columns.every(validDatabaseColumn) &&
    Array.isArray(value.views) && value.views.length <= 50 && value.views.every(validDatabaseView);
}

function validEdited(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, at]) => id(key) && safeInt(at));
}
function validDatabaseColumn(value: unknown): value is PageDatabaseColumn {
  return isRecord(value) && exact(value, ['id', 'name', 'type', 'options', 'editable', 'width']) && id(value.id) && typeof value.name === 'string' && value.name.length <= 100 &&
    (MICHI_DB_COLUMN_TYPES as readonly string[]).includes(String(value.type)) &&
    (value.options === undefined || isPageDatabaseOptionList(value.options, 'stored')) &&
    (value.editable === undefined || typeof value.editable === 'boolean') && (value.width === undefined || (typeof value.width === 'number' && Number.isFinite(value.width) && value.width >= 40 && value.width <= 1000));
}
function validDatabaseView(value: unknown): value is PageDatabaseView {
  if (!isRecord(value) || !exact(value, ['id', 'name', 'type', 'config', 'position', 'edit']) || !id(value.id) || typeof value.name !== 'string' || value.name.length > 100 ||
    !(MICHI_DB_VIEW_TYPES as readonly string[]).includes(String(value.type)) || !safeInt(value.position) || !isRecord(value.config) ||
    (value.edit !== undefined && (!isRecord(value.edit) || !exact(value.edit, ['at']) || !safeInt(value.edit.at))) ||
    !exact(value.config, value.type === 'custom'
      ? ['filters', 'match', 'sorts', 'group', 'visible', 'date', 'planDate', 'cover', 'componentId', 'pinnedVersion', 'props', 'height']
      : ['filters', 'match', 'sorts', 'group', 'visible', 'date', 'planDate', 'cover', 'component', 'code'])) return false;
  const config = value.config;
  if (value.type === 'custom' && !parsePageComponentHostConfig({ componentId: config.componentId, pinnedVersion: config.pinnedVersion, props: config.props, height: config.height })) return false;
  // Older views may hold '' for these and the retired component/code keys; history keeps reading them.
  const validOptionalString = (key: string) => config[key] === undefined || (typeof config[key] === 'string' && (config[key] as string).length <= 200);
  return Array.isArray(config.filters) && config.filters.length <= 100 && config.filters.every(isPageDatabaseFilter) && Array.isArray(config.sorts) && config.sorts.length <= 100 && config.sorts.every(isPageDatabaseSort) &&
    ['all', 'any'].includes(String(config.match)) && (config.group === undefined || id(config.group)) &&
    (config.visible === undefined || (Array.isArray(config.visible) && config.visible.length <= 100 && config.visible.every(id))) &&
    (value.type === 'custom' ? true : ['date', 'planDate', 'cover', 'component', 'code'].every(validOptionalString));
}


/** Body of POST /pages/:pageId/activity-seen: the newest change the person has seen. */
export interface PageActivitySeenRequest {
  lastSeenChangeSeq: number;
}
