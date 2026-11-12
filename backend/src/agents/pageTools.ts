import { readHomeCards, readHomeCustomization, editHomeCustomization } from '../services/homeCards/repository';
import { savedChatHomePageId } from '../services/homeCards/chatHomePage';
import {
  blockShowsTaskBoard, DEFAULT_COMPANION_NAME, isCheckinBlockSource, isTaskDb, PAGE_LIMITS, TASK_COLUMN, TASK_LIST_LIMITS, TASK_STATUSES, TASK_VIEW,
  titleColumn,
} from 'michi-shared';
import { getDb } from '../services/db';
import { getAiGlobalContext, getWorkspace } from '../services/dbRepository';
import { workspaceIdKindHint } from '../services/idKindHint';
import { assistantPurposeOf, assistantTargetWorkspace, isAssistantWorkspace } from '../assistant/identity';
import { CHECKIN_TITLE_STUB, heldCheckinPageTitles } from '../assistant/checkinPageGuard';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../services/agentOwner';
import { applyAgentDbEdits, configureDatabase, createAgentDatabase, configureDatabaseView } from '../services/pages/databaseWrites';
import { pageComponents } from '../services/pages/components';
import { PageWriteError, requireChatChangeSource, requirePagesWorkspace, type ChatChangeSource } from '../services/pages/core';
import { createPage, getDatabase, getPage, isHomePage, listPages } from '../services/pages/repository';
import { pageLayoutContext } from '../services/pages/layoutRules';
import { issuePagePreview } from '../services/pages/pagePreview';
import { applyAgentPageEdits, type AgentPageWriteResult } from '../services/pages/pageWrites';
import { acquirePageEditLease, describeOtherLease, livePageEditLease } from '../services/pages/editLeases';
import { openTaskDatabase } from '../services/pages/taskDatabase';
import { listTasks, type TaskListInput, type TaskListScope } from '../services/pages/taskList';
import { liveConversationSql } from '../services/nodeLifecycleSql';
import { blocksCheckinTaint, databaseCheckinTaint, databasesCheckinTaint, pageCheckinTaint } from '../services/pages/checkinSources';
import { CHECKIN_MANIFEST_STUB, checkinPassagesStubbed } from '../services/pages/pageManifest';
import { CHECKIN_PAGE_WRITE_TOOLS, checkinWriteProblem, remoteTextProblem, type RemoteContentProblem } from '../services/pages/remoteMedia';
import { getCompanionSettings } from '../services/companion/settings';
import { activeCompanionTaint, recordCompanionTaint } from '../services/turnTrust';
import type {
  CompanionTaintDetail, MichiPageWriteReceipt, PageBlock, PageChangeDto, PageDatabase, PageDatabaseRow, PageWriteTaskCounts, PageDto, PageSummaryDto,
  PageWriteResult, TargetMutation, TargetSnapshot,
} from 'michi-shared';
import type { ActivePageTurnAttribution, PageToolName } from './pageToolNames';

export interface PageToolCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  ownerKind: 'chat_node' | 'agent_run' | null;
  /**
   * The chat's running turn. `approveForMe`: the session it runs on holds
   * Kiro's Approve for me (the runtime's KiroPageTurnAttribution), so Kiro
   * may approve the turn's later tools without asking; markedRead keeps
   * check-in material from that turn, in what reads and writes answer.
   */
  getActivePageTurnAttribution?: () => ActivePageTurnAttribution | null;
  /**
   * The Meta agent's chat window (the assistant's catalog only): reaches the
   * pages of every workspace its owner has, naming the workspace per call.
   */
  metaAgent?: boolean;
}

type ToolTextContent = { type: 'text'; text: string };
export interface PageToolResult {
  [key: string]: unknown;
  content: ToolTextContent[];
  details: unknown;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

const MAX_LIST_RESULTS = 20;
const MAX_READ_BLOCKS = PAGE_LIMITS.blocks;
const MAX_DATABASE_ROWS = 100;
const MAX_SCAN_PAGES = 2_000;
const MAX_TASK_STATUSES = 20;
const MAX_TASK_WORKSPACES = 100;
const MAX_TASK_CURSOR = 1_000;

function fail(message: string, code = 'invalid'): never {
  throw new PageWriteError(400, code as PageWriteError['code'], message);
}

function trustedOwner(caller: PageToolCaller): { ownerUserId: string; workspaceId: string; nodeId: string } {
  if (caller.ownerKind !== 'chat_node' || !caller.nodeId || !caller.workspaceId) {
    throw new PageWriteError(404, 'not_found', 'Page tools are available only to workspace chat sessions');
  }
  const ownerUserId = caller.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? '' : LOCAL_AGENT_OWNER_ID);
  if (!ownerUserId || isAssistantWorkspace(caller.workspaceId)) {
    throw new PageWriteError(404, 'not_found', 'Page tools are unavailable for this workspace');
  }
  return { ownerUserId, workspaceId: caller.workspaceId, nodeId: caller.nodeId };
}

function changeSource(caller: PageToolCaller): ChatChangeSource {
  const { ownerUserId, workspaceId, nodeId } = trustedOwner(caller);
  const attribution = caller.getActivePageTurnAttribution?.();
  if (!attribution?.turnId || !attribution.assistantId) {
    throw new PageWriteError(404, 'not_found', 'There is no active owning chat turn for this page write');
  }
  const node = getDb().prepare('SELECT workspace_id,page_id,kind FROM nodes WHERE id=?').get(nodeId) as
    { workspace_id: string; page_id: string | null; kind: string } | undefined;
  if (!node || node.workspace_id !== workspaceId || node.kind !== 'chat') {
    throw new PageWriteError(404, 'not_found', 'Active chat source not found');
  }
  // Helper attribution is server-derived from the bound node, never accepted from tool input.
  const source: ChatChangeSource = {
    kind: node.page_id === null ? 'chat' : 'helper',
    nodeId,
    turnId: attribution.turnId,
    assistantId: attribution.assistantId,
  };
  requireChatChangeSource(workspaceId, ownerUserId, source);
  return source;
}

/** Where a call may act: one workspace for an ordinary chat, every one of the owner's for the Meta agent (null). */
interface PageScope { ownerUserId: string; workspaceId: string | null }

function metaAgentOwner(caller: PageToolCaller): PageScope {
  if (caller.ownerKind !== 'chat_node' || !caller.nodeId || !isAssistantWorkspace(caller.workspaceId)) {
    throw new PageWriteError(404, 'not_found', 'Page tools are available only to workspace chat sessions');
  }
  const ownerUserId = caller.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? '' : LOCAL_AGENT_OWNER_ID);
  if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Page tools are unavailable for this workspace');
  return { ownerUserId, workspaceId: null };
}

function pageScope(caller: PageToolCaller): PageScope {
  return caller.metaAgent ? metaAgentOwner(caller) : trustedOwner(caller);
}

/** Only the owner's explicitly selected Chat Home Page is shared across chat workspaces. */
function isChatHomePage(scope: PageScope, pageId: string): boolean {
  return savedChatHomePageId(scope.ownerUserId) === pageId;
}

function inScope(scope: PageScope, workspaceId: string): boolean {
  return scope.workspaceId === null || scope.workspaceId === workspaceId;
}

/** A workspace the Meta agent names for listing, creating or the component library: one of the owner's own, never a system one. */
function namedWorkspace(scope: PageScope, raw: unknown): string {
  if (scope.workspaceId !== null) return scope.workspaceId;
  const workspaceId = parseString(raw, 'workspaceId')!;
  if (!assistantTargetWorkspace(scope.ownerUserId, workspaceId)) {
    throw new PageWriteError(404, 'not_found', `Workspace not found.${workspaceIdKindHint(workspaceId)} Get workspace ids from list_workspaces.`);
  }
  requirePagesWorkspace(workspaceId, scope.ownerUserId);
  return workspaceId;
}

/** The Meta agent's writes come from its own chat-window turn, wherever the page is. */
function metaAgentChangeSource(caller: PageToolCaller, scope: PageScope, workspaceId: string): ChatChangeSource {
  const attribution = caller.getActivePageTurnAttribution?.();
  if (!attribution?.turnId || !attribution.assistantId) {
    throw new PageWriteError(404, 'not_found', 'There is no active owning chat turn for this page write');
  }
  const source: ChatChangeSource = { kind: 'chat', nodeId: caller.nodeId!, turnId: attribution.turnId, assistantId: attribution.assistantId };
  requireChatChangeSource(workspaceId, scope.ownerUserId, source);
  return source;
}

function writeSource(caller: PageToolCaller, scope: PageScope, workspaceId: string): ChatChangeSource {
  return scope.workspaceId === null ? metaAgentChangeSource(caller, scope, workspaceId) : changeSource(caller);
}

/** The Meta agent's receipts name the resource's workspace: its own chat is in none of them. */
function scopedResult(scope: PageScope, workspaceId: string, value: Record<string, unknown>): PageToolResult {
  if (scope.workspaceId !== null || !value.michiPageWrite || typeof value.michiPageWrite !== 'object') return toolResult(value);
  return toolResult({ ...value, michiPageWrite: { ...(value.michiPageWrite as Record<string, unknown>), workspaceId } });
}

/**
 * The Meta agent reads a workspace's tasks only while "Let AI navigate this
 * workspace" is on there: tasks retell its conversations. A chat in the
 * workspace reads them either way.
 */
function navigableTasks(scope: PageScope, workspaceId: string): void {
  if (scope.workspaceId !== null || getAiGlobalContext(workspaceId, scope.ownerUserId)) return;
  const name = getWorkspace(workspaceId, scope.ownerUserId)?.name ?? 'this workspace';
  fail(`NAVIGATION_DISABLED: "Let AI navigate this workspace" is off in ${name}, so its tasks cannot be read or changed. If the user needs them, ask them to turn it on in that workspace's Settings.`);
}

/** The workspaces the Meta agent names for list_tasks; null reads every one. */
function taskWorkspaceIds(scope: PageScope, raw: unknown): string[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TASK_WORKSPACES) fail(`workspaceIds must list 1 to ${MAX_TASK_WORKSPACES} workspaces`);
  return [...new Set(raw.map((value) => namedWorkspace(scope, value)))];
}

type TaskListFilters = Pick<TaskListInput, 'statuses' | 'nodeId' | 'needsYou' | 'query' | 'updatedSince' | 'limit' | 'cursor'>;

/** list_tasks filters, checked before anything is read. */
function taskListFilters(args: Record<string, unknown>): TaskListFilters {
  const filters: TaskListFilters = {};
  if (args.statuses !== undefined) {
    if (!Array.isArray(args.statuses) || args.statuses.length > MAX_TASK_STATUSES
      || args.statuses.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 200)) {
      fail(`statuses must list at most ${MAX_TASK_STATUSES} status values`);
    }
    filters.statuses = args.statuses as string[];
  }
  const nodeId = parseString(args.nodeId, 'nodeId', true);
  if (nodeId !== undefined) filters.nodeId = nodeId;
  if (args.needsYou !== undefined) {
    if (typeof args.needsYou !== 'boolean') fail('needsYou must be a boolean');
    filters.needsYou = args.needsYou;
  }
  const query = parseString(args.query, 'query', true);
  if (query !== undefined) filters.query = query;
  if (args.updatedSince !== undefined) {
    if (!Number.isSafeInteger(args.updatedSince) || (args.updatedSince as number) < 0) fail('updatedSince must be a time in milliseconds');
    filters.updatedSince = args.updatedSince as number;
  }
  if (args.limit !== undefined) {
    if (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > TASK_LIST_LIMITS.max) {
      fail(`limit must be between 1 and ${TASK_LIST_LIMITS.max}`);
    }
    filters.limit = args.limit as number;
  }
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length === 0 || args.cursor.length > MAX_TASK_CURSOR) fail('Invalid cursor');
    filters.cursor = args.cursor;
  }
  return filters;
}

/** What open_task_database answers: what an agent writes tasks with. list_tasks reads the tasks themselves. */
function taskDatabaseAnswer(database: PageDatabase, created: boolean) {
  const status = database.columns.find((column) => column.id === TASK_COLUMN.status);
  return {
    kind: 'taskDatabase', created,
    databaseId: database.id, workspaceId: database.workspaceId, title: database.title, revision: database.revision,
    taskCount: database.rows.length,
    columns: database.columns.map((column) => ({ id: column.id, name: column.name, type: column.type })),
    statuses: (status?.options ?? []).map((option) => ({
      value: option.value, label: option.label ?? option.value, core: (TASK_STATUSES as readonly string[]).includes(option.value),
    })),
    views: database.views.map((view) => ({ id: view.id, name: view.name, type: view.type })),
  };
}

type PageListToolItem = PageSummaryDto & { revision: number; home?: true };

function pageListingResult(pages: PageListToolItem[], truncated: boolean, query?: string, remaining?: number | null) {
  const marker = truncated ? `and ${remaining === null || remaining === undefined ? 'possibly' : remaining} more — use list_pages with a narrower query` : '';
  return {
    items: pages,
    query: query ?? null,
    truncated,
    ...(marker ? { more: marker } : {}),
  };
}

function listMatchingPages(workspaceId: string, ownerUserId: string, query?: string): { items: PageListToolItem[]; truncated: boolean; remaining: number | null } {
  const needle = query?.trim().toLocaleLowerCase();
  const matches: PageSummaryDto[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  let hasMore = false;
  do {
    const result = listPages(workspaceId, ownerUserId, { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of result.items) {
      scanned++;
      if (!needle || item.title.toLocaleLowerCase().includes(needle)) matches.push(item);
      if (scanned >= MAX_SCAN_PAGES) {
        hasMore = result.nextCursor !== null;
        break;
      }
    }
    if (scanned >= MAX_SCAN_PAGES) break;
    cursor = result.nextCursor;
  } while (cursor);
  const truncated = hasMore || matches.length > MAX_LIST_RESULTS;
  const home = getDb().prepare("SELECT id FROM pages WHERE workspace_id=? AND owner_user_id=? AND role='workspace-home' AND deleted_at IS NULL").get(workspaceId, ownerUserId) as { id: string } | undefined;
  return {
    items: matches.slice(0, MAX_LIST_RESULTS).map((item) => ({ ...item, revision: getPage(item.id, ownerUserId).revision, ...(item.id === home?.id ? { home: true as const } : {}) })),
    truncated,
    remaining: hasMore ? null : Math.max(0, matches.length - MAX_LIST_RESULTS),
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function pageRead(page: PageDto, blockIds?: string[]) {
  const selected = blockIds ? page.blocks.filter((block) => blockIds.includes(block.id)) : page.blocks;
  const blocks = selected.slice(0, MAX_READ_BLOCKS).map((block) => ({
    ...block,
    ownership: { humanEdited: block.edit !== undefined, editedAt: block.edit?.at ?? null },
  }));
  return {
    id: page.id, title: page.title, workspaceId: page.workspaceId, parentId: page.parentId,
    // On a home a change to a block an agent wrote applies directly, even after the user edited it.
    ...(isHomePage(page.id) ? { home: true as const } : {}),
    revision: page.revision, viewVersion: page.viewVersion, updatedAt: page.updatedAt, updatedBy: page.updatedBy,
    blocks, truncated: selected.length > blocks.length,
    missingBlockIds: blockIds ? blockIds.filter((id) => !page.blocks.some((block) => block.id === id)) : [],
  };
}

/**
 * read_page's editLease: forEdit takes or renews this turn's lease, so a
 * maintenance run or another conversation does not change the page between
 * this read and the edit. Any read reports another conversation's live lease.
 */
function readEditLease(caller: PageToolCaller, scope: PageScope, page: PageDto, forEdit: boolean): { editLease?: Record<string, unknown> } {
  const now = Date.now();
  if (!forEdit) {
    const other = livePageEditLease(page.id, now);
    const mine = caller.getActivePageTurnAttribution?.()?.turnId;
    return other && other.turnId !== mine ? { editLease: describeOtherLease(other, now) } : {};
  }
  const source = writeSource(caller, scope, page.workspaceId);
  const result = acquirePageEditLease({ pageId: page.id, ownerUserId: scope.ownerUserId, workspaceId: page.workspaceId,
    holder: { nodeId: source.nodeId, turnId: source.turnId }, now });
  if (!result.acquired) {
    return { editLease: { ...describeOtherLease(result.lease, now),
      note: 'Another conversation is editing this page; edit_page is refused until its lease ends.' } };
  }
  return { editLease: { status: 'held', expiresAt: result.lease.expiresAt,
    note: 'This turn holds the page until it ends; each read with forEdit or edit_page renews it.' } };
}

function databaseRead(database: PageDatabase, limit: number) {
  const rows = database.rows.slice(0, limit).map((row) => ({
    ...row,
    ownership: {
      humanEditedCells: Object.keys(row.edited),
      humanEditedBody: row.bodyEditedAt !== null,
      bodyEditedAt: row.bodyEditedAt,
    },
  }));
  return {
    id: database.id, title: database.title, workspaceId: database.workspaceId,
    revision: database.revision, updatedAt: database.updatedAt, columns: database.columns, views: database.views,
    rows, truncated: database.rows.length > rows.length, totalRows: database.rows.length,
  };
}

/** Whether a change snapshot's block shows a task board (alone or inside a container). */
function snapshotShowsTaskBoard(snapshot: unknown): boolean {
  const block = (snapshot as { block?: Record<string, unknown> } | undefined)?.block;
  return !!block && typeof block === 'object' && blockShowsTaskBoard(block);
}

/**
 * The receipt leads with michiPageWrite: runtimes cut tool output at 16 KB, and
 * a long write must lose its change records, not the receipt the cards read.
 */
function writeReceipt(result: PageWriteResult & Partial<Pick<AgentPageWriteResult, 'viewVersion' | 'atomic' | 'commitStatus'>>, title: string, originatingPageId?: string, created = false, originatingPageIds?: string[]) {
  const changes = [...result.applied, ...result.proposed];
  const affectedTargetIds = [...new Set(changes.flatMap((change) => {
    const target = change.target;
    if (target.kind === 'block') return [target.blockId];
    if (target.kind === 'row') return [target.rowId];
    return [target.databaseId];
  }))];
  const michiPageWrite: MichiPageWriteReceipt = {
    kind: 'michiPageWrite',
    resourceKind: result.resource.kind,
    resourceId: result.resource.id,
    ...(originatingPageId ? { originatingPageId } : {}),
    ...(originatingPageIds ? { originatingPageIds } : {}),
    title,
    ...(created ? { created: true } : {}),
    revision: result.revision,
    ...(result.viewVersion === undefined ? {} : { viewVersion: result.viewVersion }),
    ...(result.atomic === undefined ? {} : { atomic: result.atomic, commitStatus: result.commitStatus }),
    appliedCount: result.applied.length,
    proposedCount: result.proposed.length,
    rejectedCount: result.rejected.length,
    affectedTargetIds,
    batchId: changes[0]?.batchId ?? null,
    ...(result.applied.some((change) => snapshotShowsTaskBoard(change.after) && !snapshotShowsTaskBoard(change.before)) ? { taskBoard: true } : {}),
  };
  return { michiPageWrite, result };
}

/**
 * A row write names the column its rows go by (as the database's views title
 * them), and a write to a task database also counts the tasks it added,
 * updated and removed, for its receipt card.
 */
function withRowFacts(receipt: ReturnType<typeof writeReceipt>, database: PageDatabase): WriteAnswer {
  const titleColumnId = titleColumn({ id: database.id, kind: 'user', columns: database.columns })?.id;
  const michiPageWrite: MichiPageWriteReceipt = { ...receipt.michiPageWrite, ...(titleColumnId ? { titleColumnId } : {}) };
  if (!isTaskDb(database)) return { ...receipt, michiPageWrite };
  const tasks: PageWriteTaskCounts = { added: 0, updated: 0, removed: 0 };
  for (const change of receipt.result.applied) {
    if (change.target.kind !== 'row') continue;
    if (!change.before?.exists) tasks.added += 1;
    else if (!change.after?.exists) tasks.removed += 1;
    else tasks.updated += 1;
  }
  return { ...receipt, michiPageWrite: { ...michiPageWrite, tasks } };
}

function toolResult(value: unknown): PageToolResult {
  const payload = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
    structuredContent: payload,
  };
}

function parseString(value: unknown, field: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail(`Invalid ${field}`);
  return value;
}

/**
 * A read that returned check-in material marks the turn that read it
 * (DESIGN-v2 §2.8 T5), whoever reads: blocks a check-in wrote, or a
 * database a check-in changed or made (services/pages/checkinSources.ts
 * judges, a database as a whole). Without the record the read is withheld,
 * so the material never reaches a turn that would not ask. A write's answer
 * is a read too: its change records hold the blocks and rows before and
 * after, and its receipt the database's title (writtenAnswer).
 *
 * A turn whose session holds Kiro's Approve for me (the attribution's
 * `approveForMe`) would not ask either: Kiro sets that preset only when it
 * opens a session, so the taint cannot take it away mid-turn and Kiro's
 * classifier could approve the turn's later tools on its own. Such a turn
 * gets `withheld()` instead, the answer with what a check-in wrote left out
 * and a note saying where it can be read, and is not tainted.
 */
function markedRead(caller: PageToolCaller, name: PageToolName, taint: CompanionTaintDetail | null, result: PageToolResult,
  withheld: () => PageToolResult): PageToolResult {
  if (!taint || !caller.nodeId) return result;
  const turn = caller.getActivePageTurnAttribution?.();
  if (!turn?.turnId) throw new PageWriteError(404, 'not_found', 'There is no active owning chat turn for this read');
  if (turn.approveForMe === true) return withheld();
  recordCompanionTaint({ nodeId: caller.nodeId, turnId: turn.turnId }, name, taint);
  return result;
}

/** The turn's session may approve its later tools on its own (Kiro's Approve for me): it is handed stubs for what a check-in wrote. */
function holdsApproveForMe(caller: PageToolCaller): boolean {
  return caller.getActivePageTurnAttribution?.()?.approveForMe === true;
}

/** The conversation ⌘J opens, by the name the user gave it (DESIGN-v2 §1.5). */
function conversationName(): string {
  try {
    return getCompanionSettings().displayName || DEFAULT_COMPANION_NAME;
  } catch {
    return DEFAULT_COMPANION_NAME;
  }
}

/** Where what a check-in wrote can be read, or changed, instead of in this chat. */
function elsewhere(): string {
  return `in a chat without Approve for me, or in ${conversationName()}, the conversation ⌘J opens`;
}

/**
 * Leads an answer that markedRead handed over without what a check-in wrote;
 * the runtimes cut a long tool result, not its start. The stub may come from
 * a session Kiro opened with Approve for me, one Kiro does not know (counted
 * as holding it) or one that kept the preset from an earlier choice, so the
 * note says what the session may do, not what the chat's mode is.
 */
function withheldNote(): string {
  return 'Parts of this were written by a check-in and are withheld: this chat\'s Kiro session may approve tools on its own, '
    + `without asking the user, once the chat has read them. They can be read ${elsewhere()}.`;
}
/** Stands in for each passage, block, database or task a check-in wrote. */
const WITHHELD = '[Withheld: written by a check-in]';

type WithheldBlock = Pick<PageBlock, 'id' | 'rev' | 'type' | 'edit'> & { withheld: string };

/**
 * A stored block as a turn holding Approve for me is handed it: a block a
 * check-in wrote (its own sources) keeps only its id, revision and kind;
 * any other keeps all but the passages a check-in wrote. What is left
 * names no check-in, so it would not taint (checkinSources.ts blocksCheckinTaint).
 */
function withheldBlock<B extends PageBlock>(block: B): B | WithheldBlock {
  if (!(block.sources ?? []).some(isCheckinBlockSource)) return checkinPassagesStubbed(block, WITHHELD);
  return { id: block.id, rev: block.rev, type: block.type, ...(block.edit ? { edit: block.edit } : {}), withheld: WITHHELD };
}

/** read_database's answer without the database: a check-in's change anywhere in it marks all of it (checkinSources.ts). */
function withheldDatabase(database: PageDatabase) {
  return {
    withheld: withheldNote(), id: database.id, workspaceId: database.workspaceId,
    revision: database.revision, updatedAt: database.updatedAt, totalRows: database.rows.length,
  };
}

/** list_tasks' answer with the tasks of each database a check-in changed or made reduced to where they are. */
function withheldTasks(tasks: ReturnType<typeof listTasks>, ownerUserId: string) {
  const checkin = new Set([...new Set(tasks.items.map((item) => item.databaseId))].filter((id) => databaseCheckinTaint(id, ownerUserId)));
  return {
    withheld: withheldNote(),
    ...tasks,
    items: tasks.items.map((item) => !checkin.has(item.databaseId) ? item : {
      workspaceId: item.workspaceId, workspaceName: item.workspaceName, databaseId: item.databaseId, rowId: item.rowId, rev: item.rev,
      withheld: WITHHELD,
    }),
  };
}

/**
 * What a write's answer withholds of a database a check-in changed or made
 * (judged as a whole, as read_database judges it): its rows, and its title,
 * columns and views, except a task database's, which only Michi and the user
 * set (configureDatabase refuses a task database; edit_database writes rows).
 * Null when no change of a check-in's stands in it.
 */
interface DatabaseWithholding { schema: boolean }

function databaseWithholding(database: PageDatabase, ownerUserId: string): DatabaseWithholding | null {
  return databaseCheckinTaint(database.id, ownerUserId) ? { schema: !isTaskDb(database) } : null;
}

/** A row of such a database as withheld: where it is, not what it says. */
function withheldRow(row: PageDatabaseRow) {
  return { id: row.id, rev: row.rev, position: row.position, withheld: WITHHELD };
}

/** A database's own parts as withheld: its ids and revision stay, its title, columns and views go. */
function withheldSchema<D extends { id: string; title?: unknown; columns?: unknown; views?: unknown }>(database: D) {
  const { title: _title, columns: _columns, views: _views, ...rest } = database;
  return { ...rest, withheld: WITHHELD };
}

/**
 * A change record without what a check-in wrote (K-review #1): each block of
 * its snapshots and upserts as withheldBlock leaves it; with `database`, the
 * rows of the database and, when `schema`, its own parts. The same object
 * when nothing in it is withheld.
 */
function withheldChange(change: PageChangeDto, database: DatabaseWithholding | null): PageChangeDto {
  const snapshot = (value: TargetSnapshot | null): TargetSnapshot | null => {
    if (!value?.exists) return value;
    if (value.kind === 'block') {
      const block = withheldBlock(value.block);
      return block === value.block ? value : { ...value, block } as unknown as TargetSnapshot;
    }
    if (value.kind === 'row') return database ? { ...value, row: withheldRow(value.row) } as unknown as TargetSnapshot : value;
    return database?.schema ? { ...value, database: withheldSchema(value.database) } as unknown as TargetSnapshot : value;
  };
  const mutation = (value: TargetMutation): TargetMutation => {
    if (value.kind === 'block') {
      if (value.op !== 'upsert') return value;
      const block = withheldBlock(value.block);
      return block === value.block ? value : { ...value, block } as unknown as TargetMutation;
    }
    if (value.kind === 'row') {
      if (!database || value.op === 'delete') return value;
      return (value.op === 'upsert' ? { ...value, row: withheldRow(value.row) } : { kind: 'row', op: 'patch', id: value.id, withheld: WITHHELD }) as unknown as TargetMutation;
    }
    return database?.schema && value.op === 'replace' ? { ...value, database: withheldSchema(value.database) } as unknown as TargetMutation : value;
  };
  const before = snapshot(change.before);
  const after = snapshot(change.after);
  const forward = mutation(change.forward);
  const inverse = mutation(change.inverse);
  if (before === change.before && after === change.after && forward === change.forward && inverse === change.inverse) return change;
  return { ...change, before, after, forward, inverse };
}

/** A write tool's answer: its receipt and the write's result, and what else the tool adds (configure_database's `database`). */
type WriteAnswer = Record<string, unknown> & { michiPageWrite: MichiPageWriteReceipt; result: PageWriteResult };

/**
 * A write's answer without what a check-in wrote: its change records as
 * withheldChange leaves them and, for a database whose own parts are
 * withheld, the title in its receipt (the turn's receipt cards read it) and
 * the columns and views configure_database answers with. The receipt keeps
 * leading and the note follows it. Null when nothing in it is withheld.
 */
function withheldWrite(answer: WriteAnswer, database: DatabaseWithholding | null): WriteAnswer | null {
  const changes = (list: PageChangeDto[]) => list.map((change) => withheldChange(change, database));
  const applied = changes(answer.result.applied);
  const proposed = changes(answer.result.proposed);
  const changed = applied.some((change, index) => change !== answer.result.applied[index])
    || proposed.some((change, index) => change !== answer.result.proposed[index]);
  if (!changed && !database?.schema) return null;
  const { michiPageWrite, ...rest } = answer;
  const own = rest.database && typeof rest.database === 'object' && database?.schema
    ? { database: withheldSchema(rest.database as { id: string }) } : {};
  return {
    michiPageWrite: database?.schema ? { ...michiPageWrite, title: WITHHELD } : michiPageWrite,
    withheld: withheldNote(),
    ...rest,
    ...own,
    result: { ...answer.result, applied, proposed },
  };
}

/**
 * A write's answer as markedRead hands it over: the turn is tainted when the
 * answer holds what a check-in wrote, and a turn holding Approve for me gets
 * it withheld instead (K-review #1). `database`: the database written, when
 * the tool writes one.
 */
function writtenAnswer(caller: PageToolCaller, name: PageToolName, scope: PageScope, workspaceId: string, answer: WriteAnswer,
  database: PageDatabase | null): PageToolResult {
  const withheld = withheldWrite(answer, database ? databaseWithholding(database, scope.ownerUserId) : null);
  return markedRead(caller, name, withheld ? 'checkin' : null, scopedResult(scope, workspaceId, answer),
    () => scopedResult(scope, workspaceId, withheld!));
}

/** The stubs a turn is shown for what a check-in wrote: here, and in a helper chat's manifest (pageManifest.ts). */
const STUBS = [WITHHELD, CHECKIN_MANIFEST_STUB] as const;
/** The tools that write what their arguments say. */
const CONTENT_WRITES: ReadonlySet<string> = new Set(['edit_home', 'edit_page', 'create_page', 'create_database', 'configure_database',
  'edit_database', 'save_page_component', 'configure_database_view']);

/**
 * Why a write may not save a stub (K-review #2), or null: a stub in its
 * arguments stands for text a check-in wrote that the chat was not shown, so
 * writing it would replace that text with the stub. Every turn: a stub stays
 * in the session's history after its turn.
 */
function stubWriteRefusal(name: PageToolName, args: Record<string, unknown>): string | null {
  if (!CONTENT_WRITES.has(name)) return null;
  const input = JSON.stringify(args);
  const stub = STUBS.find((text) => input.includes(text));
  return stub ? `Not written: the input contains "${stub}", which stands for text a check-in wrote that this chat was not shown. `
    + `Leave that part out. To change that text, read it first with read_page, or ask the user to change it ${elsewhere()}.` : null;
}

/**
 * Why edit_page may not update these blocks in a turn holding Approve for me,
 * or null (K-review #2): the turn was shown each of them with what a
 * check-in wrote stubbed (withheldBlock), so an update would save the stub,
 * or a guess, over text nobody in this chat read and drop where its passages
 * came from. Moving and deleting such a block stay allowed.
 */
function withheldUpdateRefusal(page: PageDto, ops: readonly unknown[]): string | null {
  const updated = new Set(ops.flatMap((op) => {
    const value = op && typeof op === 'object' ? op as Record<string, unknown> : null;
    return value?.op === 'update' && typeof value.id === 'string' ? [value.id] : [];
  }));
  const held = page.blocks.filter((block) => updated.has(block.id) && blocksCheckinTaint([block]));
  if (!held.length) return null;
  const which = held.length === 1 ? `Block ${held[0]!.id} holds` : `Blocks ${held.map((block) => block.id).join(', ')} hold`;
  return `Not written: ${which} text a check-in wrote, which this chat was shown only as "${WITHHELD}": this chat's Kiro session `
    + `may approve tools on its own. An update would replace that text unread. Ask the user to make this change ${elsewhere()}; `
    + 'moving or deleting the block still works here.';
}

/** The page write tools services/pages/remoteMedia.ts checks for a check-in, argument by argument. */
const REMOTE_CHECKED_WRITES: ReadonlySet<string> = new Set(CHECKIN_PAGE_WRITE_TOOLS);
/** Writes of a library component, which can load anything its code or props name: a check-in has none. */
const COMPONENT_WRITES: ReadonlySet<string> = new Set(['save_page_component', 'configure_database_view']);
const MAX_HOME_TEXT_DEPTH = 32;
const TAINTED_WRITE = 'Not written: this turn holds check-in material, so its page writes follow a check-in\'s rules.';
const TAINTED_INSTEAD = 'Leave that part out, or give it to the user in your reply so they can add it themselves.';

/** The first string of edit_home's text (greeting, custom cards) that would load from or link outside Michi. */
function homeWriteProblem(args: Record<string, unknown>): RemoteContentProblem | null {
  let sets: unknown;
  try { sets = typeof args.setsJson === 'string' ? JSON.parse(args.setsJson) : undefined; } catch { sets = undefined; }
  const stack: Array<[unknown, string, number]> = [[sets, 'setsJson', 0], [args.greetingDetail, 'greetingDetail', 0], [args.greetingText, 'greetingText', 0]];
  while (stack.length) {
    const [value, at, depth] = stack.pop()!;
    if (typeof value === 'string') {
      const found = remoteTextProblem(value, at);
      if (found) return found;
    } else if (value && typeof value === 'object' && depth < MAX_HOME_TEXT_DEPTH) {
      const entries = Array.isArray(value) ? value.map((item, index): [string, unknown] => [`${at}[${index}]`, item])
        : Object.entries(value as Record<string, unknown>).map(([key, item]): [string, unknown] => [`${at}.${key}`, item]);
      for (const [path, item] of entries.reverse()) stack.push([item, path, depth + 1]);
    }
  }
  return null;
}

/**
 * Why a write of a turn that holds check-in or collector material may not
 * go ahead, or null (w2-fix D2, DESIGN-v2 §2.8): such a turn still makes
 * Michi-internal writes, but every page, database, Home, component and view
 * write gets a check-in write's remote-content check
 * (remoteMedia.ts checkinWriteProblem), so nothing it writes loads from or
 * links to the outside; a library component (save_page_component,
 * configure_database_view) can load anything, so it waits for the user.
 * The turn's material is activeCompanionTaint's (its own reads, or what V's
 * live session took in earlier). A check-in's own node is checked by
 * checkinPageGuard, around this tool. Every runtime's page writes run here.
 */
function taintedWriteRefusal(caller: PageToolCaller, name: PageToolName, args: Record<string, unknown>, ownerUserId: string): string | null {
  const component = COMPONENT_WRITES.has(name);
  if (!caller.nodeId || (!component && name !== 'edit_home' && !REMOTE_CHECKED_WRITES.has(name))) return null;
  if (assistantPurposeOf(caller.nodeId) === 'checkin' || !activeCompanionTaint(caller.nodeId)) return null;
  if (component) {
    return `${TAINTED_WRITE} ${name} writes a library component, which can load anything its code or props name. Propose it to the user in your reply instead.`;
  }
  const found = name === 'edit_home' ? homeWriteProblem(args) : checkinWriteProblem(name, args, ownerUserId);
  return found ? `${TAINTED_WRITE} ${found.message} ${TAINTED_INSTEAD}` : null;
}

/** Shared executor for MCP and Pi; caller identity and attribution are supplied only by runtime closures. */
export function runPageTool(name: PageToolName, caller: PageToolCaller, rawArgs: unknown): PageToolResult {
  try {
    const args = requireRecord(rawArgs ?? {}, 'Tool arguments');
    const scope = pageScope(caller);
    const { ownerUserId } = scope;
    const refused = taintedWriteRefusal(caller, name, args, ownerUserId) ?? stubWriteRefusal(name, args);
    if (refused) fail(refused, 'invalid');
    switch (name) {
      case 'read_home':
      case 'edit_home': {
        // Home is owner-wide, including when called from the Assistant's system workspace.
        // Validate the bound conversation and active turn without treating it as a Page.
        const workspace = getWorkspace(caller.workspaceId!, ownerUserId);
        const turn = caller.getActivePageTurnAttribution?.();
        const node = getDb().prepare(`SELECT n.page_id FROM nodes n JOIN turns t ON t.node_id=n.id
          LEFT JOIN trees tr ON tr.id=n.tree_id
          WHERE n.id=? AND n.workspace_id=? AND n.kind='chat' AND ${liveConversationSql({ node: 'n', tree: 'tr' })}
          AND t.turn_id=? AND t.assistant_message_id=? AND t.status='active'`)
          .get(caller.nodeId!, caller.workspaceId!, turn?.turnId ?? '', turn?.assistantId ?? '');
        if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, ownerUserId) || workspace.deleted_at != null || workspace.archived_at != null || workspace.purged_at != null || !node) {
          fail('Active Home chat source not found');
        }
        const home = name === 'read_home'
          ? { ...readHomeCustomization(ownerUserId), content: readHomeCards(ownerUserId) }
          : editHomeCustomization(ownerUserId, args);
        // The Home's content page may hold blocks a check-in wrote (§2.8 T5), judged on the
        // stored page as read_page judges it: the presented one resolves a check-in's sources
        // (to V, unflagged for a passage) and drops those with nowhere to open (D12), so it
        // no longer says which blocks came from a check-in.
        const contentPage = home.content.contentPage;
        const stored = contentPage ? getPage(contentPage.id, ownerUserId) : null;
        const taint = stored ? pageCheckinTaint(stored) : null;
        // Withheld, it is the stored page with its check-in parts left out: the rest is as presented.
        return markedRead(caller, name, taint, toolResult(home), () => toolResult({ withheld: withheldNote(), ...home,
          content: { ...home.content, contentPage: { ...contentPage!, blocks: stored!.blocks.map((block) => withheldBlock(block)) } } }));
      }
      case 'list_pages': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const query = parseString(args.query, 'query', true);
        if (query && query.length > 200) fail('query must be at most 200 characters');
        const found = listMatchingPages(workspaceId, ownerUserId, query);
        const listing = toolResult(pageListingResult(found.items, found.truncated, query, found.remaining));
        // A title a check-in made or last renamed is check-in material (§2.8 T1, w3-fix D24). Every
        // chat, V included, is shown the stub and stays untainted: listing pages is routine in V, and
        // with D1's sticky taint a tainted listing would make V ask for every tool from then on. The
        // query still matches the real title, and read_page reads (and taints) as before. Only a
        // check-in's own node, which can never write outside Michi, reads the title it wrote.
        const held = heldCheckinPageTitles(found.items.map((item) => item.id), 'list_pages');
        if (held.size === 0) return listing;
        const stubbed = () => toolResult(pageListingResult(
          found.items.map((item) => (held.has(item.id) ? { ...item, title: CHECKIN_TITLE_STUB } : item)), found.truncated, query, found.remaining));
        return caller.nodeId && assistantPurposeOf(caller.nodeId) === 'checkin' ? markedRead(caller, name, 'checkin', listing, stubbed) : stubbed();
      }
      case 'read_page': {
        const pageId = parseString(args.pageId, 'pageId')!;
        let blockIds: string[] | undefined;
        if (args.blockIds !== undefined) {
          if (!Array.isArray(args.blockIds) || args.blockIds.length > MAX_READ_BLOCKS || args.blockIds.some((id) => typeof id !== 'string' || id.length > 200)) fail(`blockIds must contain at most ${MAX_READ_BLOCKS} block IDs`);
          blockIds = args.blockIds as string[];
        }
        if (args.forEdit !== undefined && typeof args.forEdit !== 'boolean') fail('forEdit must be a boolean');
        const page = getPage(pageId, ownerUserId);
        if (!inScope(scope, page.workspaceId) && !isChatHomePage(scope, page.id)) throw new PageWriteError(404, 'not_found', 'Page not found');
        const read = pageRead(page, blockIds);
        const context = { ...pageLayoutContext(page.id, ownerUserId), ...readEditLease(caller, scope, page, args.forEdit === true) };
        return markedRead(caller, name, pageCheckinTaint(page, blockIds), toolResult({ ...read, ...context }), () => toolResult({
          withheld: withheldNote(), ...read,
          blocks: read.blocks.map((block) => ({ ...withheldBlock(block), ownership: block.ownership })), ...context }));
      }
      case 'preview_page': {
        const pageId = parseString(args.pageId, 'pageId')!;
        const page = getPage(pageId, ownerUserId);
        if (!inScope(scope, page.workspaceId)) throw new PageWriteError(404, 'not_found', 'Page not found');
        const preview = issuePagePreview(ownerUserId, page.workspaceId, page.id);
        return toolResult({ pageId: page.id, title: page.title, url: preview.url, expiresAt: new Date(preview.expiresAt).toISOString(),
          ready: 'The page has rendered when <body> has data-page-preview="ready" (or "error").' });
      }
      case 'edit_page': {
        const pageId = parseString(args.pageId, 'pageId')!;
        if (!Array.isArray(args.ops) || args.ops.length > PAGE_LIMITS.opsPerEdit) fail(`ops must contain at most ${PAGE_LIMITS.opsPerEdit} operations`);
        if (args.atomic !== undefined && typeof args.atomic !== 'boolean') fail('atomic must be a boolean');
        const page = getPage(pageId, ownerUserId);
        if (!inScope(scope, page.workspaceId) && !isChatHomePage(scope, page.id)) throw new PageWriteError(404, 'not_found', 'Page not found');
        const source = writeSource(caller, scope, page.workspaceId);
        const unread = holdsApproveForMe(caller) ? withheldUpdateRefusal(page, args.ops) : null;
        if (unread) fail(unread);
        // Scope is server-validated; a Meta agent cannot opt out through tool input.
        const atomic = scope.workspaceId === null || args.atomic === true;
        const result = applyAgentPageEdits({ pageId, ownerUserId, workspaceId: page.workspaceId, source, ops: args.ops, atomic });
        return writtenAnswer(caller, name, scope, page.workspaceId, writeReceipt(result, page.title, pageId), null);
      }
      case 'create_page': {
        const title = parseString(args.title, 'title')!;
        const parentId = parseString(args.parentId, 'parentId', true) ?? null;
        const template = parseString(args.template, 'template', true) as 'blank' | 'release' | 'research' | 'travel' | undefined;
        if (template && !['blank', 'release', 'research', 'travel'].includes(template)) fail('Invalid template');
        let workspaceId: string;
        if (scope.workspaceId === null && parentId) {
          workspaceId = getPage(parentId, ownerUserId).workspaceId;
          if (args.workspaceId !== undefined && args.workspaceId !== workspaceId) fail('parentId is in another workspace');
          namedWorkspace(scope, workspaceId);
        } else {
          workspaceId = namedWorkspace(scope, args.workspaceId);
        }
        const source = writeSource(caller, scope, workspaceId);
        const page = createPage({ workspaceId, ownerUserId, parentId, title, template, source });
        const createdTargetIds = [
          ...page.blocks.map((block) => block.id),
          ...page.blocks.flatMap((block) => block.type === 'database-ref' ? [block.databaseId] : []),
        ];
        const michiPageWrite: MichiPageWriteReceipt = {
          kind: 'michiPageWrite', resourceKind: 'page', resourceId: page.id,
          ...(parentId ? { originatingPageId: parentId } : {}),
          title, created: true, revision: page.revision, appliedCount: 0, proposedCount: 0, rejectedCount: 0,
          affectedTargetIds: createdTargetIds, batchId: null,
        };
        return scopedResult(scope, workspaceId, {
          kind: 'createdPage',
          page: { id: page.id, title: page.title, workspaceId: page.workspaceId, parentId: page.parentId, revision: page.revision, viewVersion: page.viewVersion },
          michiPageWrite,
        });
      }
      case 'create_database': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const source = writeSource(caller, scope, workspaceId);
        const { database, result } = createAgentDatabase({ workspaceId, ownerUserId, source,
          title: parseString(args.title, 'title')!, columns: args.columns });
        return scopedResult(scope, workspaceId, { ...writeReceipt(result, database.title, undefined, true), database: databaseRead(database, 1) });
      }
      case 'configure_database': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        const source = writeSource(caller, scope, database.workspaceId);
        const result = configureDatabase({ databaseId, ownerUserId, workspaceId: database.workspaceId,
          revision: args.revision as number, ops: args.ops, source });
        const refs = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=? ORDER BY page_id').all(databaseId) as Array<{ page_id: string }>;
        const updated = getDatabase(databaseId, ownerUserId);
        return writtenAnswer(caller, name, scope, database.workspaceId, { ...writeReceipt(result, database.title, undefined, false, refs.map((ref) => ref.page_id)),
          database: { id: updated.id, revision: updated.revision, columns: updated.columns, views: updated.views } }, updated);
      }
      case 'read_database': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const limit = args.limit === undefined ? 50 : args.limit;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_DATABASE_ROWS) fail('limit must be between 1 and 100');
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        if (isTaskDb(database)) navigableTasks(scope, database.workspaceId);
        return markedRead(caller, name, databaseCheckinTaint(database.id, ownerUserId), toolResult(databaseRead(database, limit as number)),
          () => toolResult(withheldDatabase(database)));
      }
      case 'edit_database': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const selectedPageId = parseString(args.pageId, 'pageId', true);
        if (!Array.isArray(args.ops) || args.ops.length > 50) fail('ops must contain at most 50 operations');
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        if (isTaskDb(database)) navigableTasks(scope, database.workspaceId);
        const workspaceId = database.workspaceId;
        const source = writeSource(caller, scope, workspaceId);
        const refs = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=? ORDER BY page_id').all(databaseId) as unknown as Array<{ page_id: string }>;
        if (selectedPageId && !refs.some((ref) => ref.page_id === selectedPageId)) throw new PageWriteError(404, 'not_found', 'Selected page does not reference this database');
        const selectedPage = selectedPageId ? getPage(selectedPageId, ownerUserId) : undefined;
        const result = applyAgentDbEdits({ databaseId, workspaceId, ownerUserId, source, ops: args.ops });
        return writtenAnswer(caller, name, scope, workspaceId,
          withRowFacts(writeReceipt(result, database.title, selectedPage?.id, false, refs.map((ref) => ref.page_id)), database), database);
      }
      case 'list_page_components': {
        return toolResult(pageComponents.list(namedWorkspace(scope, args.workspaceId), ownerUserId));
      }
      case 'read_page_component': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const componentId = parseString(args.componentId, 'componentId')!;
        const version = args.version;
        if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1)) fail('version must be a positive integer');
        return toolResult(pageComponents.read(workspaceId, ownerUserId, componentId, version as number | undefined));
      }
      case 'save_page_component': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        const expectedLibraryRevision = args.expectedLibraryRevision;
        if (!Number.isSafeInteger(expectedLibraryRevision) || (expectedLibraryRevision as number) < 0) fail('expectedLibraryRevision must be a non-negative integer');
        const component = requireRecord(args.component, 'component');
        const result = pageComponents.save(workspaceId, ownerUserId, {
          expectedLibraryRevision: expectedLibraryRevision as number,
          input: component,
          source: writeSource(caller, scope, workspaceId),
        });
        const receipt: MichiPageWriteReceipt = {
          kind: 'michiPageWrite', resourceKind: 'component', resourceId: result.component.id,
          title: result.component.name, revision: result.revision, version: result.version.version,
          appliedCount: 1, proposedCount: 0, rejectedCount: 0, affectedTargetIds: [result.component.id], batchId: null,
        };
        return scopedResult(scope, workspaceId, { ...result, michiPageWrite: receipt });
      }
      case 'configure_database_view': {
        const databaseId = parseString(args.databaseId, 'databaseId')!;
        const revision = args.revision;
        const viewId = parseString(args.viewId, 'viewId', true);
        if (!Number.isSafeInteger(revision) || (revision as number) < 1) fail('revision must be a positive integer');
        const config = requireRecord(args.config, 'config');
        const componentId = parseString(config.componentId, 'config.componentId')!;
        const props = config.props === undefined ? {} : requireRecord(config.props, 'config.props');
        const pinnedVersion = config.pinnedVersion;
        if (pinnedVersion !== undefined && (!Number.isSafeInteger(pinnedVersion) || (pinnedVersion as number) < 1)) fail('config.pinnedVersion must be a positive integer');
        const database = getDatabase(databaseId, ownerUserId);
        if (!inScope(scope, database.workspaceId)) throw new PageWriteError(404, 'not_found', 'Database not found');
        if (isTaskDb(database) && viewId && (Object.values(TASK_VIEW) as string[]).includes(viewId)) {
          fail('A task database keeps its Board, Table and Needs you views: create another view instead');
        }
        const workspaceId = database.workspaceId;
        const refs = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=? ORDER BY page_id').all(databaseId) as unknown as Array<{ page_id: string }>;
        const source = writeSource(caller, scope, workspaceId);
        const result = configureDatabaseView({
          databaseId, workspaceId, ownerUserId, revision: revision as number, ...(viewId ? { viewId } : {}), componentId,
          props, ...(pinnedVersion === undefined ? {} : { pinnedVersion: pinnedVersion as number }), source,
        });
        return writtenAnswer(caller, name, scope, workspaceId,
          { ...writeReceipt(result, database.title, undefined, false, refs.map((ref) => ref.page_id)), viewId: result.viewId }, database);
      }
      case 'open_task_database': {
        const workspaceId = namedWorkspace(scope, args.workspaceId);
        navigableTasks(scope, workspaceId);
        // Making it is a write: it needs the chat's active turn, as page writes do.
        writeSource(caller, scope, workspaceId);
        const opened = openTaskDatabase({ workspaceId, ownerUserId });
        return toolResult(taskDatabaseAnswer(opened.database, opened.created));
      }
      case 'list_tasks': {
        const filters = taskListFilters(args);
        const taskScope: TaskListScope = scope.workspaceId === null
          ? { kind: 'across', workspaceIds: taskWorkspaceIds(scope, args.workspaceIds), includeAiHidden: false }
          : { kind: 'workspace', workspaceId: scope.workspaceId };
        const tasks = listTasks({ ownerUserId, scope: taskScope, ...filters });
        return markedRead(caller, name, databasesCheckinTaint(tasks.items.map((item) => item.databaseId), ownerUserId), toolResult(tasks),
          () => toolResult(withheldTasks(tasks, ownerUserId)));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Page tool failed';
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], details: { error: message }, isError: true };
  }
}
