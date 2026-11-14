import type { DatabaseSync } from 'node:sqlite';
import {
  SCHEDULED_JOB_LIMITS,
  isSystemWorkspaceSettings,
  type BackgroundUsageAmounts,
  type MetaAgentTodayMetrics,
  type MetaAgentUsageToday,
} from 'michi-shared';
import { workspaceOwnerMatches } from '../agentOwner';
import { getDb } from '../db';
import { memoryExtractionJobIds } from '../memory/extractionRepository';
import { mergeUsage, parseUsageAmounts, usageOfSummaries } from '../backgroundUsage';

export interface MaintenanceConfigRow {
  workspace_id: string; job_id: string; paused: number; revision: number; completion_cursor: number;
  workspace_name: string; workspace_owner: string | null; workspace_settings: string | null;
  last_status: string | null; last_error: string | null; auto_paused: number | null;
}

export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Midnight of `now`'s day in the server's local time zone, which is the user's own on the desktop. */
export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Enabled maintenance configs of the owner's live, unarchived user workspaces. */
export function listMaintenanceConfigs(ownerUserId: string, database: DatabaseSync = getDb()): MaintenanceConfigRow[] {
  const rows = database.prepare(`SELECT c.workspace_id,c.job_id,c.paused,c.revision,c.completion_cursor,
      w.name AS workspace_name,w.owner_user_id AS workspace_owner,w.settings AS workspace_settings,
      j.last_status,j.last_error,j.auto_paused
    FROM page_maintenance_configs c JOIN workspaces w ON w.id=c.workspace_id LEFT JOIN scheduled_jobs j ON j.id=c.job_id
    WHERE c.owner_user_id=? AND c.enabled=1 AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL
    ORDER BY w.created_at,w.id`).all(ownerUserId) as unknown as MaintenanceConfigRow[];
  return rows.filter((row) => workspaceOwnerMatches(row.workspace_owner, ownerUserId) && !isSystemWorkspaceSettings(row.workspace_settings));
}

/** The jobs of every maintenance config the owner has, enabled or not: they are the Meta agent, not ordinary jobs. */
export function listManagedMaintenanceJobIds(ownerUserId: string, database: DatabaseSync = getDb()): string[] {
  return (database.prepare('SELECT job_id FROM page_maintenance_configs WHERE owner_user_id=? ORDER BY job_id').all(ownerUserId) as Array<{ job_id: string }>)
    .map((row) => row.job_id);
}

/**
 * Runs that opened a model session since `dayStart`, for an incremental batch,
 * a first read or the Spaces Home summary. Each such run starts one turn in a
 * fresh maintenance conversation; a run that failed before its session opened
 * leaves none, however much it had to read. Conversations outlive the pruned
 * run history, so the count holds all day.
 */
function modelCallsSince(jobIds: string[], dayStart: number, database: DatabaseSync): number {
  return (database.prepare(`SELECT COUNT(DISTINCT t.node_id) AS n FROM turns t JOIN nodes n ON n.id=t.node_id
    WHERE n.maintenance_job_id IN (${placeholders(jobIds.length)}) AND t.started_at>=?`)
    .get(...jobIds, dayStart) as { n: number }).n;
}

export function todayMetrics(ownerUserId: string, configs: MaintenanceConfigRow[], dayStart: number, database: DatabaseSync = getDb()): MetaAgentTodayMetrics {
  const jobIds = configs.map((config) => config.job_id);
  const workspaceIds = configs.map((config) => config.workspace_id);
  if (jobIds.length === 0) return { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 };
  const jobs = placeholders(jobIds.length);
  const runs = database.prepare(`SELECT COUNT(*) AS n FROM scheduled_job_runs WHERE job_id IN (${jobs}) AND started_at>=?`)
    .get(...jobIds, dayStart) as { n: number };
  const history = database.prepare(`SELECT job_id,COUNT(*) AS n,MIN(started_at) AS oldest FROM scheduled_job_runs
    WHERE job_id IN (${jobs}) GROUP BY job_id`).all(...jobIds) as unknown as Array<{ n: number; oldest: number }>;
  const checksTruncated = history.some((row) => row.n >= SCHEDULED_JOB_LIMITS.runHistoryPerJob && row.oldest >= dayStart);
  const modelCalls = modelCallsSince(jobIds, dayStart, database);
  const writes = (database.prepare(`SELECT COUNT(*) AS n FROM page_maintenance_receipts r JOIN page_maintenance_plans p ON p.id=r.plan_id
    WHERE p.owner_user_id=? AND r.job_id IN (${jobs}) AND r.outcome='written' AND r.committed_at>=?`)
    .get(ownerUserId, ...jobIds, dayStart) as { n: number }).n;
  const pendingProposals = (database.prepare(`SELECT COUNT(*) AS n FROM page_changes WHERE owner_user_id=?
    AND workspace_id IN (${placeholders(workspaceIds.length)}) AND proposal_state='pending' AND json_extract(source,'$.kind')='maintenance'`)
    .get(ownerUserId, ...workspaceIds) as { n: number }).n;
  const coordinator = database.prepare('SELECT check_count FROM meta_agent_maintenance_state WHERE owner_user_id=? AND check_day_start=?')
    .get(ownerUserId, dayStart) as { check_count: number } | undefined;
  return { checks: coordinator?.check_count ?? Math.max(runs.n, modelCalls), checksTruncated: coordinator ? false : checksTruncated,
    modelCalls, writes, pendingProposals };
}

/** The usage_summary of each reply in these jobs' maintenance sessions since `dayStart` (backgroundUsage.ts counts them). */
function sessionUsageSince(jobIds: string[], dayStart: number, database: DatabaseSync): BackgroundUsageAmounts {
  if (jobIds.length === 0) return {};
  // Start with maintenance nodes, then use the messages(node_id, role) index.
  // SQLite otherwise scans every conversation's message rows for this status
  // request; large histories can block the server (including static assets).
  const rows = database.prepare(`SELECT json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.usageSummary') AS usage
      FROM nodes n CROSS JOIN messages m ON m.node_id=n.id
      WHERE n.maintenance_job_id IN (${placeholders(jobIds.length)}) AND m.role='assistant' AND m.created_at>=?`)
    .all(...jobIds, dayStart) as Array<{ usage: string | null }>;
  return usageOfSummaries(rows.map((row) => row.usage));
}

/** Automatic memory runs answered by a direct structured call open no session: their run records hold the tokens they reported. */
function directMemoryTokensSince(jobIds: string[], dayStart: number, database: DatabaseSync): BackgroundUsageAmounts {
  if (jobIds.length === 0) return {};
  const row = database.prepare(`SELECT COUNT(x.reported_tokens) AS reported, SUM(x.reported_tokens) AS total
      FROM memory_extraction_runs x JOIN scheduled_job_runs r ON r.id = x.run_id
      WHERE x.job_id IN (${placeholders(jobIds.length)}) AND r.node_id IS NULL AND x.reported_tokens IS NOT NULL AND x.started_at >= ?`)
    .get(...jobIds, dayStart) as { reported: number; total: number | null };
  return row.reported > 0 ? { tokens: Math.round(row.total ?? 0) } : {};
}

/** What the check-ins that started since `dayStart` recorded (companion_runs.usage_json, written before their node goes). */
function checkinUsageSince(ownerUserId: string, dayStart: number, database: DatabaseSync): BackgroundUsageAmounts {
  const rows = database.prepare('SELECT usage_json FROM companion_runs WHERE owner_user_id=? AND started_at>=? AND usage_json IS NOT NULL')
    .all(ownerUserId, dayStart) as Array<{ usage_json: string }>;
  return rows.reduce((total, row) => mergeUsage(total, parseUsageAmounts(row.usage_json)), {} as BackgroundUsageAmounts);
}

function usageToday(ownerUserId: string, configs: MaintenanceConfigRow[], dayStart: number, today: MetaAgentTodayMetrics, database: DatabaseSync): MetaAgentUsageToday {
  const memoryJobs = memoryExtractionJobIds(ownerUserId, database);
  const pages = sessionUsageSince(configs.map((config) => config.job_id), dayStart, database);
  const memory = mergeUsage(sessionUsageSince(memoryJobs, dayStart, database), directMemoryTokensSince(memoryJobs, dayStart, database));
  const tokens = pages.tokens === undefined && memory.tokens === undefined ? null : Math.round((pages.tokens ?? 0) + (memory.tokens ?? 0));
  return { checks: today.checks, modelCalls: today.modelCalls, tokens,
    usage: { pages, memory, checkins: checkinUsageSince(ownerUserId, dayStart, database) } };
}

/** Today's background usage: the same checks and model calls as Scheduled › Pages upkeep, and what Pages, memory and check-ins used. */
export function metaAgentUsageToday(ownerUserId: string, now: number, database: DatabaseSync = getDb()): MetaAgentUsageToday {
  const configs = listMaintenanceConfigs(ownerUserId, database);
  const dayStart = startOfLocalDay(now);
  return usageToday(ownerUserId, configs, dayStart, todayMetrics(ownerUserId, configs, dayStart, database), database);
}

/** One read transaction in the background statistics worker, shared by both status APIs. */
export function metaAgentMetricsSnapshot(ownerUserId: string, now: number, database: DatabaseSync) {
  const configs = listMaintenanceConfigs(ownerUserId, database);
  const dayStart = startOfLocalDay(now);
  const today = todayMetrics(ownerUserId, configs, dayStart, database);
  return { dayStart, today, usage: usageToday(ownerUserId, configs, dayStart, today, database) };
}
