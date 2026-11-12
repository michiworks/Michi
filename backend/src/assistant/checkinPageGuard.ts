/**
 * What a check-in may do with the user's Pages and databases (DESIGN-v2
 * §2.6), around the Page tools of a check-in catalog (assistant/tools.ts
 * assistantToolsFor('checkin')). It acts only for a check-in node
 * (`n-cmph-…`); every other caller goes straight to the tool.
 *
 * 1. Where: only a workspace of the user's with "Let AI navigate this
 *    workspace" on, not archived and not the assistant's own (the Pages
 *    Home belongs to Pages upkeep). Reads and writes alike. Remote
 *    workspaces never reach this backend's tools at all.
 * 2. What: every write goes through the remote-content detector
 *    (services/pages/remoteMedia.ts checkinWriteProblem); content that would
 *    load from, or link to, anywhere outside Michi and the agent's own
 *    sources refuses the whole call, telling the model to propose it instead.
 * 3. How much: per check-in at most CHECKIN_WRITE_LIMITS.writes write calls,
 *    .targets change targets, .pages new page and .databases new database;
 *    per day .dailyWrites write calls (a meta counter).
 * 4. The engine keeps the rest: a block the user edited gets only a
 *    proposal, the first run's lock and edit leases hold as for any writer.
 * 5. Every write it lets through is noted for the check-in's post
 *    (services/companion/checkinWrites.ts noteCheckinWrite, §3.4): a turn
 *    that changed the user's pages must say so. A title goes with it only
 *    when no check-in wrote it (§2.8 T1): never for a page or database this
 *    check-in made (in that write or an earlier one), nor one whose title a
 *    check-in made or renamed it to (checkinWroteTitle).
 */

import { isSystemWorkspaceSettings } from 'michi-shared';
import type { AssistantTool, AssistantToolContext, AssistantToolResult } from './tools';
import { getDb } from '../services/db';
import { getAiGlobalContext, getWorkspace } from '../services/dbRepository';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError } from '../services/pages/core';
import { getDatabase, getPage } from '../services/pages/repository';
import { CHECKIN_PAGE_WRITE_TOOLS, checkinWriteProblem } from '../services/pages/remoteMedia';
import { assistantPurposeOf, isAssistantWorkspace } from './identity';
import { noteCheckinWrite } from '../services/companion/checkinWrites';
import { log } from '../services/logger';

/** §2.6.3. */
export const CHECKIN_WRITE_LIMITS = Object.freeze({
  /** Write calls in one check-in. */
  writes: 5,
  /** Blocks, rows, columns and views one check-in may change. */
  targets: 40,
  /** Pages one check-in may create. */
  pages: 1,
  /** Databases one check-in may create. */
  databases: 1,
  /** Write calls all check-ins of one day may make. */
  dailyWrites: 20,
});

const WRITE_TOOLS: ReadonlySet<string> = new Set(CHECKIN_PAGE_WRITE_TOOLS);

interface TurnBudget {
  writes: number; targets: number; pages: number; databases: number;
  /** Pages and databases this check-in made (`page:<id>`, `database:<id>`): their titles are its own. */
  made: Set<string>;
}

/** Each running check-in's budget, by its turn id (`cmp-<runId>`); bounded, one check-in runs at a time. */
const budgets = new Map<string, TurnBudget>();
const MAX_TRACKED_TURNS = 32;

function budgetFor(turnId: string): TurnBudget {
  let budget = budgets.get(turnId);
  if (!budget) {
    budget = { writes: 0, targets: 0, pages: 0, databases: 0, made: new Set() };
    budgets.set(turnId, budget);
    if (budgets.size > MAX_TRACKED_TURNS) budgets.delete(budgets.keys().next().value!);
  }
  return budget;
}

function localDay(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The meta key of one day's check-in write count. */
export const checkinDailyWritesKey = (now: number) => `companion:checkin_writes:${localDay(now)}`;

function dailyWrites(now: number): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(checkinDailyWritesKey(now)) as { value: string } | undefined;
  const count = row ? Number(row.value) : 0;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function countDailyWrite(now: number): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(checkinDailyWritesKey(now), String(dailyWrites(now) + 1));
}

function refusal(message: string): AssistantToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringArg = (args: Record<string, unknown>, key: string): string | null => (typeof args[key] === 'string' && args[key] ? args[key] as string : null);

function ownerOf(ctx: AssistantToolContext): string {
  return ctx.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? '' : LOCAL_AGENT_OWNER_ID);
}

/** Why a check-in may not read or write in this workspace; null when it may (rule 1). */
function workspaceRefusal(ctx: AssistantToolContext, workspaceId: string): string | null {
  const workspace = getWorkspace(workspaceId, ctx.ownerUserId ?? undefined);
  if (!workspace || workspace.deleted_at != null) return `Workspace not found: ${workspaceId}.`;
  if (isAssistantWorkspace(workspace.id) || isSystemWorkspaceSettings(workspace.settings)) {
    return 'A check-in does not read or change the Pages Home: Pages upkeep keeps it. Leave it as it is.';
  }
  if (workspace.archived_at != null) return `${workspace.name} is archived; a check-in leaves it alone.`;
  if (!getAiGlobalContext(workspace.id, ctx.ownerUserId ?? undefined)) {
    return `NAVIGATION_DISABLED: "Let AI navigate this workspace" is off in ${workspace.name}, so a check-in cannot read or change its pages.`;
  }
  return null;
}

/**
 * The workspaces a call reads or writes in, as far as its arguments name
 * them; a page or database that cannot be found is left to the tool, which
 * answers it the same way.
 */
function targetWorkspaces(ctx: AssistantToolContext, name: string, args: Record<string, unknown>): string[] {
  const owner = ownerOf(ctx);
  const page = (id: string | null) => (id ? [getPage(id, owner).workspaceId] : []);
  const database = (id: string | null) => (id ? [getDatabase(id, owner).workspaceId] : []);
  try {
    switch (name) {
      case 'read_page':
      case 'edit_page':
        return page(stringArg(args, 'pageId'));
      case 'read_database':
      case 'edit_database':
      case 'configure_database':
        return database(stringArg(args, 'databaseId'));
      case 'create_page': {
        const named = stringArg(args, 'workspaceId');
        return [...(named ? [named] : []), ...page(stringArg(args, 'parentId'))];
      }
      case 'list_tasks':
        return Array.isArray(args.workspaceIds) ? args.workspaceIds.filter((id): id is string => typeof id === 'string') : [];
      default: {
        const named = stringArg(args, 'workspaceId');
        return named ? [named] : [];
      }
    }
  } catch (error) {
    if (error instanceof PageWriteError) return [];
    throw error;
  }
}

/** The change targets a write's arguments ask for, before it runs (rule 3). */
function requestedTargets(name: string, args: Record<string, unknown>): number {
  const ops = Array.isArray(args.ops) ? args.ops.length : 0;
  switch (name) {
    case 'create_database': return 1 + (Array.isArray(args.columns) ? args.columns.length : 0);
    case 'create_page':
    case 'open_task_database': return 1;
    default: return Math.max(1, ops);
  }
}

interface PageWriteReceipt {
  resourceKind?: unknown;
  resourceId?: unknown;
  title?: unknown;
  created?: unknown;
  appliedCount?: unknown;
  proposedCount?: unknown;
}

function receiptOf(result: AssistantToolResult): PageWriteReceipt | null {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const receipt = isObject(structured) ? structured.michiPageWrite : null;
  return isObject(receipt) ? receipt as PageWriteReceipt : null;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0);

/** A change source's node, whether its purpose is a check-in's (by id, or its recorded purpose). */
function checkinNode(nodeId: unknown): boolean {
  return typeof nodeId === 'string' && nodeId.length > 0 && assistantPurposeOf(nodeId) === 'checkin';
}

/**
 * Whether the page's current title is a check-in's (§2.8 T1): the revision
 * that last set it (the page's first, or the last that changed the title)
 * came from a check-in's node. A title nothing recorded is not.
 */
function checkinWrotePageTitle(pageId: string): boolean {
  const row = getDb().prepare(`SELECT source FROM (
      SELECT revision, source, json_extract(snapshot, '$.title') AS title,
        LAG(json_extract(snapshot, '$.title')) OVER (ORDER BY revision) AS previous,
        ROW_NUMBER() OVER (ORDER BY revision) AS position
      FROM page_revisions WHERE page_id = ?)
    WHERE position = 1 OR previous IS NOT title ORDER BY revision DESC LIMIT 1`).get(pageId) as { source: string } | undefined;
  if (!row) return false;
  try { return checkinNode((JSON.parse(row.source) as { nodeId?: unknown } | null)?.nodeId); }
  catch { return true; }
}

/**
 * Of these pages, the ones whose current title is a check-in's
 * (checkinWrotePageTitle), for text that names pages by title outside a
 * read that taints (the Spaces context, services/metaAgent/chatTurnContext.ts).
 * One query finds the pages any check-in ever revised; only those are
 * looked at closer.
 */
export function checkinTitledPages(pageIds: readonly string[]): Set<string> {
  const ids = [...new Set(pageIds)].filter((id) => typeof id === 'string' && id.length > 0);
  const titled = new Set<string>();
  const looked = new Set<string>();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const writers = getDb().prepare(`SELECT DISTINCT page_id, json_extract(source, '$.nodeId') AS nodeId FROM page_revisions
      WHERE page_id IN (${chunk.map(() => '?').join(',')}) AND json_extract(source, '$.nodeId') IS NOT NULL`)
      .all(...chunk) as Array<{ page_id: string; nodeId: unknown }>;
    for (const { page_id: pageId, nodeId } of writers) {
      if (looked.has(pageId) || !checkinNode(nodeId)) continue;
      looked.add(pageId);
      if (checkinWrotePageTitle(pageId)) titled.add(pageId);
    }
  }
  return titled;
}

/**
 * What text that names pages by title without a read that taints (every
 * chat's Pages manifest, the Spaces context, list_pages outside the
 * assistant's own conversations) shows for a title a check-in made or last
 * renamed (§2.8 T1, w3-fix D24).
 */
export const CHECKIN_TITLE_STUB = '(title written by a check-in)';

/**
 * checkinTitledPages, failing closed: when the titles cannot be judged,
 * every page's is held back. `where` names the text for the log.
 */
export function heldCheckinPageTitles(pageIds: readonly string[], where: string): Set<string> {
  try {
    return checkinTitledPages(pageIds);
  } catch (err) {
    log.warn('chat', `check-in page titles unreadable; ${where} names none`, { error: err instanceof Error ? err.message : String(err) });
    return new Set(pageIds);
  }
}

/**
 * Whether the database's current title is a check-in's (§2.8 T1): the last
 * applied change that made it (a database a check-in created starts with its
 * first change, from revision 1 at the moment it was made: checkinSources.ts
 * databasesCheckinTaint) or renamed it came from a check-in's node.
 */
function checkinWroteDatabaseTitle(databaseId: string): boolean {
  const row = getDb().prepare(`SELECT c.source_node_id AS nodeId FROM page_changes c
    WHERE c.database_id = ? AND c.application_state = 'applied' AND json_extract(c.before_json, '$.kind') = 'database'
      AND ((json_extract(c.before_json, '$.database.revision') = 1
          AND c.created_at = (SELECT d.created_at FROM page_databases d WHERE d.id = c.database_id))
        OR json_extract(c.before_json, '$.database.title') IS NOT json_extract(c.after_json, '$.database.title'))
    ORDER BY c.seq DESC LIMIT 1`).get(databaseId) as { nodeId: string | null } | undefined;
  return checkinNode(row?.nodeId);
}

/** The title a write's note may carry: none for what this check-in made, or whose title any check-in wrote (§2.8 T1). */
function notedTitle(kind: 'page' | 'database', id: string, title: unknown, budget: TurnBudget): string | null {
  if (typeof title !== 'string' || !title || budget.made.has(`${kind}:${id}`)) return null;
  try {
    return (kind === 'page' ? checkinWrotePageTitle(id) : checkinWroteDatabaseTitle(id)) ? null : title;
  } catch {
    return null;
  }
}

/** Notes a write the check-in made for its post (§3.4); a title only for what no check-in named (§2.8 T1). */
function noteWrite(turnId: string, name: string, result: AssistantToolResult, budget: TurnBudget): void {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (name === 'open_task_database') {
    if (!isObject(structured) || typeof structured.databaseId !== 'string') return;
    const created = structured.created === true;
    if (created) {
      budget.databases += 1;
      budget.made.add(`database:${structured.databaseId}`);
    }
    noteCheckinWrite(turnId, {
      kind: 'database', id: structured.databaseId, title: notedTitle('database', structured.databaseId, structured.title, budget),
      applied: created ? 1 : 0, proposed: 0,
    });
    return;
  }
  const receipt = receiptOf(result);
  if (!receipt || typeof receipt.resourceId !== 'string') return;
  const created = receipt.created === true;
  if (name === 'create_page') budget.pages += 1;
  if (name === 'create_database') budget.databases += 1;
  const kind = receipt.resourceKind === 'database' || name.endsWith('_database') ? 'database' : 'page';
  if (created) budget.made.add(`${kind}:${receipt.resourceId}`);
  noteCheckinWrite(turnId, {
    kind,
    id: receipt.resourceId,
    title: notedTitle(kind, receipt.resourceId, receipt.title, budget),
    applied: created ? Math.max(1, count(receipt.appliedCount)) : count(receipt.appliedCount),
    proposed: count(receipt.proposedCount),
  });
}

/** A check-in catalog's Page tool behind §2.6's rules; the same tool for any other node. */
export function guardCheckinPageTool(tool: AssistantTool): AssistantTool {
  const write = WRITE_TOOLS.has(tool.name);
  return {
    ...tool,
    execute: async (ctx, rawArgs) => {
      if (!ctx.nodeId || assistantPurposeOf(ctx.nodeId) !== 'checkin') return tool.execute(ctx, rawArgs);
      const args = isObject(rawArgs) ? rawArgs : {};
      for (const workspaceId of targetWorkspaces(ctx, tool.name, args)) {
        const refused = workspaceRefusal(ctx, workspaceId);
        if (refused) return refusal(refused);
      }
      if (!write) return tool.execute(ctx, rawArgs);

      const turnId = ctx.getActivePageTurnAttribution?.()?.turnId;
      if (!turnId) return refusal('There is no active owning chat turn for this page write');
      const problem = checkinWriteProblem(tool.name, args, ownerOf(ctx));
      if (problem) return refusal(problem.message);

      const budget = budgetFor(turnId);
      const now = Date.now();
      const targets = requestedTargets(tool.name, args);
      if (budget.writes >= CHECKIN_WRITE_LIMITS.writes) {
        return refusal(`A check-in makes at most ${CHECKIN_WRITE_LIMITS.writes} page writes. Say what is left to do, or propose it to the user.`);
      }
      if (budget.targets + targets > CHECKIN_WRITE_LIMITS.targets) {
        return refusal(`A check-in changes at most ${CHECKIN_WRITE_LIMITS.targets} blocks, rows, columns or views. Propose the rest to the user.`);
      }
      if (tool.name === 'create_page' && budget.pages >= CHECKIN_WRITE_LIMITS.pages) {
        return refusal(`A check-in creates at most ${CHECKIN_WRITE_LIMITS.pages} page. Propose another one to the user.`);
      }
      if ((tool.name === 'create_database' || tool.name === 'open_task_database') && budget.databases >= CHECKIN_WRITE_LIMITS.databases) {
        return refusal(`A check-in creates at most ${CHECKIN_WRITE_LIMITS.databases} database. Propose another one to the user.`);
      }
      if (dailyWrites(now) >= CHECKIN_WRITE_LIMITS.dailyWrites) {
        return refusal(`Check-ins already made ${CHECKIN_WRITE_LIMITS.dailyWrites} page writes today. Propose this to the user instead.`);
      }
      budget.writes += 1;
      budget.targets += targets;
      countDailyWrite(now);
      const result = await tool.execute(ctx, rawArgs);
      if (!result.isError) noteWrite(turnId, tool.name, result, budget);
      return result;
    },
  };
}
