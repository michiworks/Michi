/**
 * Every SQL statement of the Companion (db/migrations/0081_companion.sql,
 * 0082_companion_v2.sql) and its single-value state in `meta`
 * (`companion:*`), plus the reads it needs of the conversation it posts into
 * (welcome, unread posts) and the retention pass on its own conversations,
 * V's included (purgeCompanionToolOutputs). Writes that touch
 * more than one row run in a savepoint, so they compose with a caller's
 * transaction. Times are epoch ms and come from the caller (its clock).
 * Every row belongs to the local agent owner (LOCAL_AGENT_OWNER_ID, R2.2).
 *
 * Feed items (upsertItem: DESIGN §3.1 with R2.4 and R2.5):
 * - a new object is `new` and logged `created`; during its source's first
 *   successful poll (the baseline) it is `seen`, counts as notified and is
 *   logged `baseline` instead, so what was already there is never news (and
 *   so is what the first look could not see yet: applySourcePoll);
 * - the same version only refreshes what the user reads; a resolved item
 *   whose object shows up again reopens as it was before it resolved (seen
 *   stays seen, dismissed stays dismissed, a snooze still running keeps
 *   running), without an event;
 * - a new version brings the item back to `new` (logged `changed`, or
 *   `reopened` after it resolved) unless the user muted it.
 * An item resolves only when two successful, complete polls in a row left it
 * out (resolveMissing, applySourcePoll). A poll that failed, came back
 * truncated (without a window rule) or lost every row at once resolves
 * nothing.
 *
 * Nothing here emits change events: callers emit (delivery.ts) after their
 * writes, so subscribers never refetch ahead of them.
 */

import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_WORKSPACE_SYSTEM,
  CHAT_PERMISSION_CHOICE_ORDER,
  COMPANION_BUCKETS,
  COMPANION_CHECKIN_KINDS,
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_LIMITS,
  COMPANION_SOURCE_KINDS,
  companionChangeActionsFor,
  companionPostRunId,
  isCompanionClock,
  isOpenCompanionItem,
  parseCompanionPostMetadata,
  type ChatPermissionChoice,
  type CompanionBriefCard,
  type CompanionBriefDto,
  type CompanionBucket,
  type CompanionCardDto,
  type CompanionCardKind,
  type CompanionCardStatus,
  type CompanionCatchUpDto,
  type CompanionCheckinChangeDto,
  type CompanionCheckinKind,
  type CompanionConfigurableSource,
  type CompanionConversationDto,
  type CompanionDelegationClosedReason,
  type CompanionDelegationDto,
  type CompanionDelegationOrigin,
  type CompanionDelegationState,
  type CompanionFeedback,
  type CompanionFeedbackReason,
  type CompanionGoalDto,
  type CompanionItemAction,
  type CompanionItemDto,
  type CompanionItemStatus,
  type CompanionItemSubtype,
  type CompanionNotice,
  type CompanionPostChange,
  type CompanionPostChangeAction,
  type CompanionReminderDto,
  type CompanionRunDto,
  type CompanionRunKind,
  type CompanionRunOutcome,
  type CompanionSettings,
  type CompanionSeverity,
  type CompanionSnapshotDto,
  type CompanionSourceKind,
  type CompanionSourceStatus,
  type CompanionStatusDto,
  type CompanionTab,
  type CompanionTarget,
  type CompanionTextOrigin,
} from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import { nextCompanionBriefAt } from './briefSchedule';
import { isInQuietHours, localClockText, localDateKey, localDayStart } from './clock';
import { CompanionError, invalidRequest, limitReached, notFound, notesConflict } from './errors';
import { diffObservations, type ObservationDiff } from './observations';
import {
  companionBaselineMetaKey,
  companionBaselineValue,
  getCompanionSettings,
  parseCompanionBaselineValue,
  type CompanionBaselineRecord,
} from './settings';
import type {
  CompanionDelegationRecord,
  CompanionEventRecord,
  CompanionFactValue,
  CompanionSnapshotRecord,
  ItemDraft,
  Observation,
  SourcePollResult,
} from './types';

/** The owner of every Companion row: the Companion exists only in the local app (R2.2). */
export const COMPANION_OWNER = LOCAL_AGENT_OWNER_ID;
const OWNER = COMPANION_OWNER;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How far ahead an item can be snoozed. */
export const COMPANION_MAX_SNOOZE_MS = 30 * DAY_MS;
/** A proposed card waits this long for the user's Apply or Dismiss. */
export const COMPANION_CARD_TTL_MS = DAY_MS;
export const COMPANION_GOAL_PROGRESS_MAX_CHARS = 200;
export const COMPANION_BRIEF_CURATE_MAX_CHARS = 500;
export const COMPANION_REMINDER_TEXT_MAX_CHARS = 500;
/** How far ahead a one-off reminder can be set. */
export const COMPANION_MAX_REMINDER_AHEAD_MS = 366 * DAY_MS;
/** Successful, complete polls in a row an object or item must be missing from before it is gone (R2.4). */
export const COMPANION_MISSING_POLLS_TO_GONE = 2;
/** A poll that finds nothing where the stored snapshot has at least this many objects is suspect, not a success (R2.4). */
export const COMPANION_SUSPECT_DROP_MIN_ROWS = 3;
/** Objects of one subtype the user thumbed down as too noisy before the subtype is demoted to digest (R2.7). */
export const COMPANION_TOO_NOISY_TO_DEMOTE = 2;
/** How long text-bearing records are kept (R2.10): event summaries, runs, decided cards, briefs, closed reminders. */
export const COMPANION_RECORD_RETENTION_MS = 30 * DAY_MS;
/** Email and calendar items resolved or dismissed this long ago keep only their key and version (R2.10). */
export const COMPANION_PRIVACY_TTL_MS = COMPANION_LIMITS.privacyTtlDays * DAY_MS;
/** Acknowledged (or expired) notices are deleted this long after (R2.10). */
export const COMPANION_NOTICE_RETENTION_MS = 7 * DAY_MS;
/** Runs that count against the daily turn budget (R2.8): welcome and worker reports are exempt. */
export const COMPANION_BUDGETED_RUN_KINDS: readonly CompanionRunKind[] = Object.freeze(['heartbeat', 'wake', 'brief', 'catch_up']);
/** Items a snapshot lists (the counts cover all of them). */
const SNAPSHOT_ITEM_LIMIT = 200;
const ACTIVITY_LIMIT = 20;
const CATCH_UP_ITEM_LIMIT = 50;

// ── Plumbing ────────────────────────────────────────────────────────────────

let savepointSerial = 0;
/** A savepoint, so Companion writes compose with a caller's transaction. */
export function companionTransaction<T>(fn: () => T): T {
  const db = getDb();
  const name = `companion_${++savepointSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

const newId = (prefix: string) => `${prefix}-${randomUUID()}`;

function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `text` trimmed and cut to `max` UTF-16 units with an ellipsis, never inside a surrogate pair. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let end = max - 1;
  const code = trimmed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${trimmed.slice(0, end)}…`;
}

/** One line: every run of whitespace (newlines included) becomes one space. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function requireTime(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${what} must be an epoch ms time`);
  return Math.floor(value);
}

// ── Targets and facts ───────────────────────────────────────────────────────

const TABS: readonly CompanionTab[] = ['chat', 'today'];
const ID = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 160;
/** An id as Michi makes them (`cmi-<uuid>`) and the routes accept them: what a Today target may point at. */
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

/**
 * A well-formed target, or null. URLs must be http(s). A Today target may
 * name the item to scroll to (`itemId`, A10); one that is not an item id, or
 * on the Chat tab, is dropped and the rest of the target kept.
 */
export function parseCompanionTarget(value: unknown): CompanionTarget | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'node':
      return ID(value.workspaceId) && ID(value.nodeId)
        ? { kind: 'node', workspaceId: value.workspaceId as string, nodeId: value.nodeId as string } : null;
    case 'url': {
      if (typeof value.url !== 'string' || value.url.length > 2048) return null;
      try {
        const url = new URL(value.url);
        return url.protocol === 'https:' || url.protocol === 'http:' ? { kind: 'url', url: value.url } : null;
      } catch {
        return null;
      }
    }
    case 'companion': {
      if (!TABS.includes(value.tab as CompanionTab)) return null;
      const tab = value.tab as CompanionTab;
      return tab === 'today' && typeof value.itemId === 'string' && ITEM_ID.test(value.itemId)
        ? { kind: 'companion', tab, itemId: value.itemId }
        : { kind: 'companion', tab };
    }
    case 'settings':
      return { kind: 'settings' };
    default:
      return null;
  }
}

const MAX_FACTS = 40;
/** Facts are small: ids, counts, states, urls, ages. Anything else is dropped. */
function cleanFacts(value: unknown): Record<string, CompanionFactValue> {
  const facts: Record<string, CompanionFactValue> = {};
  if (!isRecord(value)) return facts;
  for (const [key, fact] of Object.entries(value)) {
    if (Object.keys(facts).length >= MAX_FACTS) break;
    if (!key || key.length > 64) continue;
    if (fact === null || typeof fact === 'boolean') facts[key] = fact;
    else if (typeof fact === 'number' && Number.isFinite(fact)) facts[key] = fact;
    else if (typeof fact === 'string') facts[key] = clip(fact, 500);
  }
  return facts;
}

// ── Items ───────────────────────────────────────────────────────────────────

interface ItemRow {
  id: string;
  source: string;
  subtype: string;
  item_key: string;
  version: string;
  bucket: string;
  severity: string;
  title: string;
  summary: string | null;
  target_json: string | null;
  facts_json: string;
  status: string;
  prior_status: string | null;
  snoozed_until: number | null;
  feedback: string | null;
  feedback_reason: string | null;
  /** The version the rating was given on (conv-1): it describes that version only. */
  feedback_version: string | null;
  feedback_at: number | null;
  first_seen_at: number;
  changed_at: number;
  observed_at: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  notified_version: string | null;
  missing_count: number;
}

const SUBTYPES: Record<CompanionItemSubtype, true> = {
  michi_waiting: true, michi_stalled: true, michi_done: true, michi_scheduled_failed: true,
  cr_needs_attention: true, cr_approved: true, cr_merged: true, cr_stale: true, cr_unpublished: true,
  cr_review_requested: true, cr_review_stale: true,
  pipeline_blocked: true, pipeline_recovered: true,
  email_unread: true, meeting_soon: true, calendar_conflict: true,
  system_auth: true, system_source_error: true,
  reminder_due: true,
};

/** Every item subtype (shared/src/companion.ts CompanionItemSubtype). */
export const COMPANION_ITEM_SUBTYPES: readonly CompanionItemSubtype[] = Object.freeze(Object.keys(SUBTYPES) as CompanionItemSubtype[]);

export function isCompanionItemSubtype(value: unknown): value is CompanionItemSubtype {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUBTYPES, value);
}

const SEVERITIES: readonly CompanionSeverity[] = ['now', 'digest', 'silent'];
const FEEDBACK_REASONS: readonly CompanionFeedbackReason[] = ['not_relevant', 'already_handled', 'too_early', 'too_late', 'too_noisy'];

/** Open: in front of the user (the SQL form of isOpenCompanionItem). */
const OPEN_SQL = `status IN ('new','seen','snoozed') AND (status <> 'snoozed' OR (snoozed_until IS NOT NULL AND snoozed_until <= ?))`;

/** The item that says a source keeps failing (coordinator.sourceTrouble). */
const sourceTroubleKey = (kind: CompanionConfigurableSource) => `system:source:${kind}`;
/** The item that says the Auth session expired (coordinator.ts AUTH_ITEM_KEY). */
const AUTH_ITEM_KEY = 'system:auth';
/** The sources behind the Auth check: the only ones that need a session. */
const AUTH_SOURCES: readonly CompanionConfigurableSource[] = Object.freeze(['cr', 'pipeline', 'email', 'calendar']);

/** The sources the user turned off. */
function sourcesOff(): CompanionConfigurableSource[] {
  const settings = getCompanionSettings();
  return COMPANION_CONFIGURABLE_SOURCES.filter((kind) => !settings.sources[kind].enabled);
}

/** What is out of sight: the items of these sources, and the system items with these keys. */
interface HiddenItems {
  sources: CompanionConfigurableSource[];
  keys: string[];
}

/**
 * Out of sight while their source is off (A3): the source's items and its
 * trouble item; and the Auth item while every source behind the Auth
 * check is off (B2), since nothing checks the session then. Nothing polls an
 * off source, so they would stay open as they were last seen; they stay
 * stored instead, out of the feed, the counts, the notices and the model's
 * material, and come back when the source is on again, when its baseline
 * poll and the two-miss rule (or the Auth check before the source's first
 * poll) refresh or resolve them without news.
 */
function hiddenItems(): HiddenItems {
  const sources = sourcesOff();
  const keys = sources.map(sourceTroubleKey);
  if (AUTH_SOURCES.every((kind) => sources.includes(kind))) keys.push(AUTH_ITEM_KEY);
  return { sources, keys };
}

/** hiddenItems as an SQL fragment for after OPEN_SQL, and its arguments. */
function hiddenItemsSql(): { sql: string; args: string[] } {
  const { sources, keys } = hiddenItems();
  const sql = [
    sources.length > 0 ? `AND source NOT IN (${placeholders(sources.length)})` : '',
    keys.length > 0 ? `AND item_key NOT IN (${placeholders(keys.length)})` : '',
  ].filter(Boolean).join(' ');
  return { sql, args: [...sources, ...keys] };
}

function isHiddenItem(row: Pick<ItemRow, 'source' | 'item_key'>, hidden: HiddenItems): boolean {
  return hidden.sources.some((kind) => row.source === kind) || hidden.keys.includes(row.item_key);
}

/**
 * Whether an item is out of sight right now (hiddenItems): code that reads
 * single items or events outside the list queries (tools, turn material,
 * held notices) must skip these the way the lists do (B15).
 */
export function isCompanionItemHidden(item: Pick<CompanionItemDto, 'source' | 'itemKey'>): boolean {
  return isHiddenItem({ source: item.source, item_key: item.itemKey }, hiddenItems());
}

/** isCompanionItemHidden for many items: the settings are read once, when this is called. */
export function companionHiddenItemTest(): (item: Pick<CompanionItemDto, 'source' | 'itemKey'>) => boolean {
  const hidden = hiddenItems();
  return (item) => isHiddenItem({ source: item.source, item_key: item.itemKey }, hidden);
}

/**
 * A rating describes the version it was given on (conv-1): once a new version
 * comes in, the item reads unrated (Today's tick, the turn material's "the user
 * marked it…"), while the stored rating still counts for the subtype's
 * too_noisy demotion (feedbackEffect).
 */
function ratingOf(row: ItemRow): Pick<CompanionItemDto, 'feedback' | 'feedbackReason'> {
  const current = row.feedback !== null && (row.feedback_version === null || row.feedback_version === row.version);
  return current
    ? { feedback: row.feedback as CompanionFeedback, feedbackReason: row.feedback_reason as CompanionFeedbackReason | null }
    : { feedback: null, feedbackReason: null };
}

function toItemDto(row: ItemRow): CompanionItemDto {
  return {
    id: row.id,
    source: row.source as CompanionSourceKind,
    subtype: row.subtype as CompanionItemSubtype,
    bucket: row.bucket as CompanionBucket,
    severity: row.severity as CompanionSeverity,
    itemKey: row.item_key,
    version: row.version,
    title: row.title,
    summary: row.summary,
    target: parseCompanionTarget(parseJson(row.target_json)),
    facts: cleanFacts(parseJson(row.facts_json)),
    status: row.status as CompanionItemStatus,
    snoozedUntil: row.snoozed_until,
    ...ratingOf(row),
    firstSeenAt: row.first_seen_at,
    changedAt: row.changed_at,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function itemRow(id: string): ItemRow | undefined {
  return getDb().prepare('SELECT * FROM companion_items WHERE owner_user_id = ? AND id = ?').get(OWNER, id) as ItemRow | undefined;
}

export function getItem(id: string): CompanionItemDto | null {
  const row = itemRow(id);
  return row ? toItemDto(row) : null;
}

export function getItemByKey(itemKey: string): CompanionItemDto | null {
  const row = getDb().prepare('SELECT * FROM companion_items WHERE owner_user_id = ? AND item_key = ?').get(OWNER, itemKey) as ItemRow | undefined;
  return row ? toItemDto(row) : null;
}

interface CleanDraft {
  source: CompanionSourceKind;
  subtype: CompanionItemSubtype;
  itemKey: string;
  version: string;
  bucket: CompanionBucket;
  severity: CompanionSeverity;
  title: string;
  summary: string | null;
  targetJson: string | null;
  factsJson: string;
  observedAt: number;
}

/** A draft as stored. A malformed draft is a rules bug: it throws instead of storing garbage. */
function cleanDraft(draft: ItemDraft): CleanDraft {
  if (!COMPANION_SOURCE_KINDS.includes(draft.source)) throw new Error(`unknown Companion source: ${String(draft.source)}`);
  if (!isCompanionItemSubtype(draft.subtype)) throw new Error(`unknown Companion item subtype: ${String(draft.subtype)}`);
  if (!COMPANION_BUCKETS.includes(draft.bucket)) throw new Error(`unknown Companion bucket: ${String(draft.bucket)}`);
  if (!SEVERITIES.includes(draft.severity)) throw new Error(`unknown Companion severity: ${String(draft.severity)}`);
  if (typeof draft.itemKey !== 'string' || !draft.itemKey || draft.itemKey.length > 300) throw new Error('item key must be 1-300 characters');
  if (typeof draft.version !== 'string' || !draft.version || draft.version.length > 300) throw new Error('item version must be 1-300 characters');
  const title = typeof draft.title === 'string' ? clip(oneLine(draft.title), 200) : '';
  if (!title) throw new Error('item title is required');
  const summary = typeof draft.summary === 'string' ? clip(oneLine(draft.summary), 600) || null : null;
  let targetJson: string | null = null;
  if (draft.target !== null && draft.target !== undefined) {
    const target = parseCompanionTarget(draft.target);
    if (!target) throw new Error('item target is malformed');
    targetJson = JSON.stringify(target);
  }
  return {
    source: draft.source,
    subtype: draft.subtype,
    itemKey: draft.itemKey,
    version: draft.version,
    bucket: draft.bucket,
    severity: draft.severity,
    title,
    summary,
    targetJson,
    factsJson: JSON.stringify(cleanFacts(draft.facts)),
    observedAt: requireTime(draft.observedAt, 'observedAt'),
  };
}

function eventSummary(title: string, summary: string | null): string {
  return clip(summary ? `${title} · ${summary}` : title, 400);
}

function insertEvent(itemId: string, kind: CompanionEventRecord['kind'], version: string, severity: CompanionSeverity, summary: string | null, now: number): CompanionEventRecord {
  const result = getDb().prepare(`INSERT INTO companion_events (owner_user_id, item_id, kind, version, severity, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(OWNER, itemId, kind, version, severity, summary, now);
  return { seq: Number(result.lastInsertRowid), itemId, kind, version, severity, summary, createdAt: now };
}

/**
 * created   = a new object (status `new`, event `created`; `seen` and `baseline` in a baseline poll);
 * changed   = a new version (status back to `new` unless muted; event `changed` unless muted);
 * reopened  = a resolved item observed again: with a new version it is `new` and logged `reopened`,
 *             with the same version it reopens as it was before it resolved, without an event;
 * refreshed = the same version with new display fields (no event, status kept);
 * unchanged = the same version, only observed_at moved.
 */
export type CompanionItemChange = 'created' | 'changed' | 'reopened' | 'refreshed' | 'unchanged';

export interface CompanionUpsertResult {
  item: CompanionItemDto;
  change: CompanionItemChange;
  /** The event written, if any. */
  event: CompanionEventRecord | null;
}

export interface CompanionUpsertOptions {
  /**
   * The source's baseline poll (R2.5): what it finds was already there. A new
   * or changed item is `seen`, its version counts as notified, and its event
   * is `baseline` (never turn material, never a notice).
   */
  baseline?: boolean;
}

/** How a resolved item reopens when its object is back with the same version (R2.4). */
function reopenedStatus(row: ItemRow, now: number, baseline: boolean): { status: CompanionItemStatus; snoozedUntil: number | null } {
  if (row.prior_status === 'seen' || row.prior_status === 'dismissed') return { status: row.prior_status, snoozedUntil: null };
  if (row.prior_status === 'snoozed' && row.snoozed_until !== null && row.snoozed_until > now) {
    return { status: 'snoozed', snoozedUntil: row.snoozed_until };
  }
  return { status: baseline ? 'seen' : 'new', snoozedUntil: null };
}

/** Applies one draft with the version semantics above. */
export function upsertItem(draft: ItemDraft, now: number, options: CompanionUpsertOptions = {}): CompanionUpsertResult {
  const next = cleanDraft(draft);
  requireTime(now, 'now');
  const baseline = options.baseline === true;
  return companionTransaction(() => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM companion_items WHERE owner_user_id = ? AND item_key = ?').get(OWNER, next.itemKey) as ItemRow | undefined;
    const summary = eventSummary(next.title, next.summary);
    if (!row) {
      const id = newId('cmi');
      db.prepare(`INSERT INTO companion_items (id, owner_user_id, source, subtype, item_key, version, bucket, severity, title, summary,
          target_json, facts_json, status, first_seen_at, changed_at, observed_at, created_at, updated_at, notified_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, OWNER, next.source, next.subtype, next.itemKey, next.version, next.bucket, next.severity, next.title, next.summary,
          next.targetJson, next.factsJson, baseline ? 'seen' : 'new', now, now, next.observedAt, now, now, baseline ? next.version : null);
      const event = insertEvent(id, baseline ? 'baseline' : 'created', next.version, next.severity, summary, now);
      return { item: toItemDto(itemRow(id)!), change: 'created', event };
    }
    if (row.source !== next.source) throw new Error(`item key ${next.itemKey} belongs to source ${row.source}, not ${next.source}`);
    const reopening = row.status === 'resolved';
    const notifiedVersion = baseline ? next.version : row.notified_version;
    if (row.version === next.version) {
      const display = row.subtype !== next.subtype || row.bucket !== next.bucket || row.severity !== next.severity
        || row.title !== next.title || row.summary !== next.summary || row.target_json !== next.targetJson || row.facts_json !== next.factsJson;
      const reopened = reopening ? reopenedStatus(row, now, baseline) : null;
      const touched = display || reopened !== null || notifiedVersion !== row.notified_version;
      db.prepare(`UPDATE companion_items SET subtype = ?, bucket = ?, severity = ?, title = ?, summary = ?, target_json = ?, facts_json = ?,
          status = ?, prior_status = ?, snoozed_until = ?, resolved_at = ?, notified_version = ?, observed_at = ?, missing_count = 0, updated_at = ?
        WHERE id = ?`)
        .run(next.subtype, next.bucket, next.severity, next.title, next.summary, next.targetJson, next.factsJson,
          reopened?.status ?? row.status, reopened ? null : row.prior_status, reopened ? reopened.snoozedUntil : row.snoozed_until,
          reopened ? null : row.resolved_at, notifiedVersion, next.observedAt, touched ? now : row.updated_at, row.id);
      return { item: toItemDto(itemRow(row.id)!), change: reopened ? 'reopened' : display ? 'refreshed' : 'unchanged', event: null };
    }
    // A meaningful change: everything moves; the user's mute holds.
    const muted = row.status === 'muted';
    const status: CompanionItemStatus = muted ? 'muted' : baseline ? 'seen' : 'new';
    db.prepare(`UPDATE companion_items SET subtype = ?, version = ?, bucket = ?, severity = ?, title = ?, summary = ?, target_json = ?,
        facts_json = ?, status = ?, prior_status = NULL, snoozed_until = ?, changed_at = ?, observed_at = ?, updated_at = ?, resolved_at = ?,
        notified_version = ?, missing_count = 0 WHERE id = ?`)
      .run(next.subtype, next.version, next.bucket, next.severity, next.title, next.summary, next.targetJson, next.factsJson,
        status, muted ? row.snoozed_until : null, now, next.observedAt, now, reopening ? null : row.resolved_at, notifiedVersion, row.id);
    const event = muted ? null
      : insertEvent(row.id, baseline ? 'baseline' : reopening ? 'reopened' : 'changed', next.version, next.severity, summary, now);
    return { item: toItemDto(itemRow(row.id)!), change: reopening ? 'reopened' : 'changed', event };
  });
}

/** Resolves one open item, remembering its status so it can reopen as it was (R2.4). */
function resolveRow(row: ItemRow, now: number): string {
  getDb().prepare(`UPDATE companion_items SET status = 'resolved', prior_status = ?, resolved_at = ?, missing_count = 0, updated_at = ? WHERE id = ?`)
    .run(row.status, now, now, row.id);
  insertEvent(row.id, 'resolved', row.version, row.severity as CompanionSeverity, eventSummary(row.title, null), now);
  return row.id;
}

export interface CompanionAbsenceOptions {
  /**
   * Which absent keys count as missing; all of them when omitted. A windowed
   * poll (complete false) passes its window rule, e.g. only emails newer than
   * the oldest one the window reached.
   */
  counts?: (key: string) => boolean;
}

/**
 * One successful, complete poll's absences (R2.4): an open item of `source`
 * that `presentItemKeys` leaves out counts one more miss, and the second
 * miss in a row resolves it; a present one starts over. Muted and resolved
 * items are left alone. Call it only for an ok and complete poll (or with
 * `counts` for a windowed one): a failed source must never resolve anything.
 * Returns the ids resolved now.
 */
export function resolveMissing(source: CompanionSourceKind, presentItemKeys: Iterable<string>, now: number, options: CompanionAbsenceOptions = {}): string[] {
  const present = new Set(presentItemKeys);
  requireTime(now, 'now');
  return companionTransaction(() => {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM companion_items WHERE owner_user_id = ? AND source = ? AND status NOT IN ('resolved','muted')`)
      .all(OWNER, source) as unknown as ItemRow[];
    const miss = db.prepare('UPDATE companion_items SET missing_count = ? WHERE id = ?');
    const resolved: string[] = [];
    for (const row of rows) {
      if (present.has(row.item_key)) {
        if (row.missing_count !== 0) miss.run(0, row.id);
        continue;
      }
      if (options.counts && !options.counts(row.item_key)) continue;
      const misses = row.missing_count + 1;
      if (misses >= COMPANION_MISSING_POLLS_TO_GONE) resolved.push(resolveRow(row, now));
      else miss.run(misses, row.id);
    }
    return resolved;
  });
}

/** Resolves these items at once (a recovered Auth session, good news after its brief); muted and resolved ones are left alone. */
export function resolveItems(ids: readonly string[], now: number): string[] {
  if (ids.length === 0) return [];
  return companionTransaction(() => {
    const rows = getDb().prepare(`SELECT * FROM companion_items WHERE owner_user_id = ? AND id IN (${placeholders(ids.length)})
        AND status NOT IN ('resolved','muted')`).all(OWNER, ...ids) as unknown as ItemRow[];
    return rows.map((row) => resolveRow(row, now));
  });
}

/** Snoozes that ran out go back to `new` (the coordinator's tick). Returns their ids. */
export function wakeSnoozedItems(now: number): string[] {
  const rows = getDb().prepare(`UPDATE companion_items SET status = 'new', snoozed_until = NULL, updated_at = ?
      WHERE owner_user_id = ? AND status = 'snoozed' AND (snoozed_until IS NULL OR snoozed_until <= ?) RETURNING id`)
    .all(now, OWNER, now) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** The user saw these: only `new` ones become `seen`. Returns the ids that changed. */
export function markItemsSeen(ids: readonly string[], now: number): string[] {
  if (ids.length === 0) return [];
  const rows = getDb().prepare(`UPDATE companion_items SET status = 'seen', updated_at = ?
      WHERE owner_user_id = ? AND status = 'new' AND id IN (${placeholders(ids.length)}) RETURNING id`)
    .all(now, OWNER, ...ids) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * A thumbs-down's deterministic effect (R2.7): `already_handled` dismisses
 * this version, `not_relevant` mutes the object (restore undoes either), and
 * `too_noisy` on a second object of one subtype demotes the subtype to digest
 * (Settings undoes that, and the count starts again from the undo, conv-1).
 */
function feedbackEffect(row: ItemRow, reason: CompanionFeedbackReason | null, now: number): void {
  const db = getDb();
  const status = row.status as CompanionItemStatus;
  if (reason === 'already_handled' && (status === 'new' || status === 'seen' || status === 'snoozed')) {
    db.prepare(`UPDATE companion_items SET status = 'dismissed', snoozed_until = NULL, updated_at = ? WHERE id = ?`).run(now, row.id);
  } else if (reason === 'not_relevant' && status !== 'muted') {
    db.prepare(`UPDATE companion_items SET status = 'muted', snoozed_until = NULL, updated_at = ? WHERE id = ?`).run(now, row.id);
  } else if (reason === 'too_noisy') {
    const subtype = row.subtype as CompanionItemSubtype;
    if (tooNoisyCount(subtype) >= COMPANION_TOO_NOISY_TO_DEMOTE) demoteSubtype(subtype, now);
  }
}

/** Objects of this subtype rated too noisy since the user last undid its demotion (conv-1), whatever version they are at now. */
function tooNoisyCount(subtype: CompanionItemSubtype): number {
  const since = getCompanionMetaNumber(noisyResetKey(subtype)) ?? -1;
  const { n } = getDb().prepare(`SELECT COUNT(*) AS n FROM companion_items WHERE owner_user_id = ? AND subtype = ?
      AND feedback = 'down' AND feedback_reason = 'too_noisy' AND COALESCE(feedback_at, 0) > ?`).get(OWNER, subtype, since) as { n: number };
  return Number(n);
}

/**
 * A user action on one item. Actions that do not apply to the item's status
 * leave it as it is (seen on a non-new item, dismiss on a muted one, restore
 * on an open one), so a retried or late click is harmless. A thumbs-down
 * with a reason also has its effect (feedbackEffect).
 */
export function applyItemAction(id: string, action: CompanionItemAction, now: number): CompanionItemDto {
  return companionTransaction(() => {
    const row = itemRow(id);
    if (!row) throw notFound('Companion item not found');
    const status = row.status as CompanionItemStatus;
    const db = getDb();
    const setStatus = (next: CompanionItemStatus, snoozedUntil: number | null) => {
      db.prepare('UPDATE companion_items SET status = ?, snoozed_until = ?, updated_at = ? WHERE id = ?').run(next, snoozedUntil, now, id);
    };
    switch (action.action) {
      case 'seen':
        if (status === 'new') setStatus('seen', null);
        break;
      case 'snooze': {
        const until = action.until;
        if (typeof until !== 'number' || !Number.isInteger(until) || until <= now) throw invalidRequest('until must be a future time (epoch ms)');
        if (until > now + COMPANION_MAX_SNOOZE_MS) throw invalidRequest('An item can be snoozed for at most 30 days');
        if (status === 'new' || status === 'seen' || status === 'snoozed') setStatus('snoozed', until);
        break;
      }
      case 'dismiss':
        if (status === 'new' || status === 'seen' || status === 'snoozed') setStatus('dismissed', null);
        break;
      case 'mute':
        if (status !== 'muted') setStatus('muted', null);
        break;
      case 'restore':
        if (status === 'dismissed' || status === 'muted' || status === 'snoozed') setStatus('seen', null);
        break;
      case 'feedback': {
        const { feedback } = action;
        if (feedback !== null && feedback !== 'up' && feedback !== 'down') throw invalidRequest('feedback must be up, down or null');
        const reason = action.reason ?? null;
        if (reason !== null && (feedback !== 'down' || !FEEDBACK_REASONS.includes(reason))) {
          throw invalidRequest(`reason goes with a thumbs-down and is one of: ${FEEDBACK_REASONS.join(', ')}`);
        }
        // The rating belongs to this version (conv-1): a later version reads unrated.
        db.prepare('UPDATE companion_items SET feedback = ?, feedback_reason = ?, feedback_version = ?, feedback_at = ?, updated_at = ? WHERE id = ?')
          .run(feedback, reason, feedback === null ? null : row.version, feedback === null ? null : now, now, id);
        if (feedback === 'down') feedbackEffect(row, reason, now);
        break;
      }
      default:
        throw invalidRequest('Unknown item action');
    }
    return toItemDto(itemRow(id)!);
  });
}

export interface CompanionItemQuery {
  source?: CompanionSourceKind;
  bucket?: CompanionBucket;
  /** 1-500, default 200. */
  limit?: number;
}

/** Open items (isOpenCompanionItem) of the sources that are on, newest change first. */
export function listOpenItems(now: number, query: CompanionItemQuery = {}): CompanionItemDto[] {
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit ?? SNAPSHOT_ITEM_LIMIT)));
  const hidden = hiddenItemsSql();
  const filters: string[] = [hidden.sql];
  const args: Array<string | number> = [OWNER, now, ...hidden.args];
  if (query.source) { filters.push('AND source = ?'); args.push(query.source); }
  if (query.bucket) { filters.push('AND bucket = ?'); args.push(query.bucket); }
  const rows = getDb().prepare(`SELECT * FROM companion_items WHERE owner_user_id = ? AND ${OPEN_SQL} ${filters.join(' ')}
      ORDER BY changed_at DESC, id DESC LIMIT ?`).all(...args, limit) as unknown as ItemRow[];
  return rows.map(toItemDto);
}

/** Badge counts over every open item of the sources that are on: those in Needs you, and those changed since the user saw them. */
export function countOpenItems(now: number): { needsYou: number; newItems: number } {
  const hidden = hiddenItemsSql();
  const row = getDb().prepare(`SELECT
      COALESCE(SUM(CASE WHEN bucket = 'needs_you' THEN 1 ELSE 0 END), 0) AS needs_you,
      COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END), 0) AS new_items
    FROM companion_items WHERE owner_user_id = ? AND ${OPEN_SQL} ${hidden.sql}`).get(OWNER, now, ...hidden.args) as { needs_you: number; new_items: number };
  return { needsYou: Number(row.needs_you), newItems: Number(row.new_items) };
}

/**
 * Open `now` items (of the sources that are on) whose current version has
 * not been notified yet: what the delivery policy may turn into a notice.
 * Oldest change first.
 */
export function listUnnotifiedNowItems(now: number): CompanionItemDto[] {
  const hidden = hiddenItemsSql();
  const rows = getDb().prepare(`SELECT * FROM companion_items WHERE owner_user_id = ? AND ${OPEN_SQL} ${hidden.sql} AND severity = 'now'
      AND (notified_version IS NULL OR notified_version <> version) ORDER BY changed_at ASC, id ASC`).all(OWNER, now, ...hidden.args) as unknown as ItemRow[];
  return rows.map(toItemDto);
}

/**
 * Records that these versions were notified (or deliberately not: quiet
 * hours, level off). `version` may carry a suffix of the delivery policy's
 * own (an escalation, `<version>:escalated`).
 */
export function markItemsNotified(items: ReadonlyArray<Pick<CompanionItemDto, 'id' | 'version'>>): void {
  const statement = getDb().prepare('UPDATE companion_items SET notified_version = ? WHERE owner_user_id = ? AND id = ?');
  companionTransaction(() => {
    for (const item of items) statement.run(item.version, OWNER, item.id);
  });
}

/** The version last notified for an item, null when never. */
export function notifiedVersionOf(id: string): string | null {
  return itemRow(id)?.notified_version ?? null;
}

/** The suffix the delivery policy marks an escalated version with (`<version>:escalated`, R2.7). */
export const COMPANION_ESCALATED_SUFFIX = ':escalated';

/**
 * Open items of `subtype` whose current version began at or before
 * `changedBefore` and was neither notified nor escalated yet (a baseline
 * sighting counts as notified): what may get the one 30-minute reminder of
 * R2.7. Oldest change first.
 */
export function listUnescalatedItems(subtype: CompanionItemSubtype, changedBefore: number, now: number): CompanionItemDto[] {
  const hidden = hiddenItemsSql();
  const rows = getDb().prepare(`SELECT * FROM companion_items WHERE owner_user_id = ? AND ${OPEN_SQL} ${hidden.sql} AND subtype = ? AND changed_at <= ?
      AND (notified_version IS NULL OR (notified_version <> version AND notified_version <> version || ?))
      ORDER BY changed_at ASC, id ASC`).all(OWNER, now, ...hidden.args, subtype, changedBefore, COMPANION_ESCALATED_SUFFIX) as unknown as ItemRow[];
  return rows.map(toItemDto);
}

// ── Events ──────────────────────────────────────────────────────────────────

interface EventRow {
  seq: number;
  item_id: string;
  kind: string;
  version: string;
  severity: string;
  summary: string | null;
  created_at: number;
}

function toEvent(row: EventRow): CompanionEventRecord {
  return {
    seq: Number(row.seq),
    itemId: row.item_id,
    kind: row.kind as CompanionEventRecord['kind'],
    version: row.version,
    severity: row.severity as CompanionSeverity,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

/** Events after the cursor `seq`, oldest first (heartbeat / brief material; `baseline` ones are never material). */
export function listEventsAfter(seq: number, limit = 200): CompanionEventRecord[] {
  const rows = getDb().prepare(`SELECT seq, item_id, kind, version, severity, summary, created_at FROM companion_events
      WHERE owner_user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`).all(OWNER, Math.floor(seq), Math.max(1, Math.floor(limit))) as unknown as EventRow[];
  return rows.map(toEvent);
}

/** The newest event's seq; 0 before the first. */
export function latestEventSeq(): number {
  const row = getDb().prepare('SELECT MAX(seq) AS seq FROM companion_events WHERE owner_user_id = ?').get(OWNER) as { seq: number | null };
  return Number(row.seq ?? 0);
}

/** One item's latest events, newest first. */
export function listItemEvents(itemId: string, limit = 10): CompanionEventRecord[] {
  const rows = getDb().prepare(`SELECT seq, item_id, kind, version, severity, summary, created_at FROM companion_events
      WHERE owner_user_id = ? AND item_id = ? ORDER BY seq DESC LIMIT ?`).all(OWNER, itemId, Math.max(1, Math.floor(limit))) as unknown as EventRow[];
  return rows.map(toEvent);
}

// ── Snapshots and polls ─────────────────────────────────────────────────────

interface SnapshotRow {
  source: string;
  object_key: string;
  fingerprint: string;
  state_json: string;
  first_seen_at: number;
  fingerprint_since: number;
  last_seen_at: number;
  missing_count: number;
}

const SNAPSHOT_COLUMNS = 'source, object_key, fingerprint, state_json, first_seen_at, fingerprint_since, last_seen_at, missing_count';

function toSnapshot(row: SnapshotRow): CompanionSnapshotRecord {
  const state = parseJson(row.state_json);
  return {
    source: row.source as CompanionSourceKind,
    objectKey: row.object_key,
    fingerprint: row.fingerprint,
    state: isRecord(state) ? state : {},
    firstSeenAt: row.first_seen_at,
    fingerprintSince: row.fingerprint_since,
    lastSeenAt: row.last_seen_at,
  };
}

/** A source's stored observations by objectKey. */
export function getSnapshots(source: CompanionSourceKind): Map<string, CompanionSnapshotRecord> {
  const rows = getDb().prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM companion_snapshots WHERE owner_user_id = ? AND source = ?`)
    .all(OWNER, source) as unknown as SnapshotRow[];
  return new Map(rows.map((row) => [row.object_key, toSnapshot(row)]));
}

/**
 * One object as its source last stored it; null when it has none: never
 * observed, or let go (it left what the source watches: two complete polls
 * without it, or a reset such as another CR account).
 */
export function getSnapshot(source: CompanionSourceKind, objectKey: string): CompanionSnapshotRecord | null {
  const row = getDb().prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM companion_snapshots WHERE owner_user_id = ? AND source = ? AND object_key = ?`)
    .get(OWNER, source, objectKey) as SnapshotRow | undefined;
  return row ? toSnapshot(row) : null;
}

/** Inserts or replaces these snapshots (diffObservations' `snapshots`); an object seen again starts its missing count over. */
export function putSnapshots(records: readonly CompanionSnapshotRecord[]): void {
  if (records.length === 0) return;
  const statement = getDb().prepare(`INSERT INTO companion_snapshots
      (owner_user_id, source, object_key, fingerprint, state_json, first_seen_at, fingerprint_since, last_seen_at, missing_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT (owner_user_id, source, object_key) DO UPDATE SET fingerprint = excluded.fingerprint, state_json = excluded.state_json,
      first_seen_at = excluded.first_seen_at, fingerprint_since = excluded.fingerprint_since, last_seen_at = excluded.last_seen_at,
      missing_count = 0`);
  companionTransaction(() => {
    for (const record of records) {
      statement.run(OWNER, record.source, record.objectKey, record.fingerprint, JSON.stringify(record.state ?? {}),
        record.firstSeenAt, record.fingerprintSince, record.lastSeenAt);
    }
  });
}

/**
 * These objects were missing from a successful, complete poll: each counts
 * one more miss, and the second in a row forgets the snapshot (the object
 * left its source). Returns the object keys forgotten now.
 */
export function recordMissingSnapshots(source: CompanionSourceKind, objectKeys: Iterable<string>): string[] {
  const keys = [...new Set(objectKeys)];
  if (keys.length === 0) return [];
  return companionTransaction(() => {
    const db = getDb();
    const read = db.prepare('SELECT missing_count FROM companion_snapshots WHERE owner_user_id = ? AND source = ? AND object_key = ?');
    const count = db.prepare('UPDATE companion_snapshots SET missing_count = ? WHERE owner_user_id = ? AND source = ? AND object_key = ?');
    const remove = db.prepare('DELETE FROM companion_snapshots WHERE owner_user_id = ? AND source = ? AND object_key = ?');
    const gone: string[] = [];
    for (const key of keys) {
      const row = read.get(OWNER, source, key) as { missing_count: number } | undefined;
      if (!row) continue;
      const misses = Number(row.missing_count) + 1;
      if (misses >= COMPANION_MISSING_POLLS_TO_GONE) {
        remove.run(OWNER, source, key);
        gone.push(key);
      } else {
        count.run(misses, OWNER, source, key);
      }
    }
    return gone;
  });
}

/** Whether the source has had its baseline poll (R2.5); until then its findings are what was already there. */
export function isSourceBaselined(source: CompanionSourceKind): boolean {
  return getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(companionBaselineMetaKey(source)) !== undefined;
}

/** The source's baseline record (settings.ts CompanionBaselineRecord); null before its baseline poll. */
export function getSourceBaseline(source: CompanionSourceKind): CompanionBaselineRecord | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(companionBaselineMetaKey(source)) as { value: string } | undefined;
  return row ? parseCompanionBaselineValue(row.value) : null;
}

/** Records the source's baseline; `open` keeps its first look open for objects it has not seen yet (A2). */
export function markSourceBaselined(source: CompanionSourceKind, now: number, options: { open?: boolean } = {}): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(companionBaselineMetaKey(source), companionBaselineValue({ at: requireTime(now, 'now'), open: options.open === true }));
}

/** A poll that lost every row at once (R2.4): more likely a broken answer than everything resolving together. */
export function isSuspectPollDrop(storedObjects: number, observedObjects: number): boolean {
  return storedObjects >= COMPANION_SUSPECT_DROP_MIN_ROWS && observedObjects === 0;
}

/**
 * A draft as applySourcePoll takes it. A source marks one `baseline` when it
 * belongs to a first look although the source had its baseline poll already
 * (A2, A5): a CR whose details the baseline poll could not read, the review
 * requests of the first successful read of the review list, the CRs of an
 * account the user just switched to. It is stored the way the baseline poll
 * stores what it finds: seen, counted as notified, logged `baseline`.
 */
export type CompanionPollDraft = ItemDraft & { baseline?: boolean };

/**
 * How long a source's first look stays open for objects it has not seen
 * (A2, A5) when no complete poll closes it sooner: after an incomplete
 * baseline poll, or after what the source watches grew.
 */
export const COMPANION_FIRST_LOOK_WINDOW_MS = HOUR_MS;

/** When a poll looked: its observations carry the poll's time (CompanionPollContext.now); `fallback` when it saw nothing. */
function pollLookedAt(observations: readonly Observation[], fallback: number): number {
  return observations.reduce((latest, observation) => Math.max(latest, observation.observedAt), observations.length === 0 ? fallback : Number.NEGATIVE_INFINITY);
}

export interface CompanionPollWrite {
  source: CompanionSourceKind;
  result: Pick<SourcePollResult, 'ok' | 'complete' | 'observations'>;
  /** The source's drafts for this poll (CompanionSource.draft over the same observations). */
  drafts: readonly CompanionPollDraft[];
  now: number;
  /**
   * For a poll that is ok but not complete: which absent keys (object keys
   * and item keys) still count as missing, e.g. emails newer than the oldest
   * one the window reached (R2.4). Without it an incomplete poll counts no
   * absence at all.
   */
  absenceCounts?: (key: string) => boolean;
}

export interface CompanionPollWriteResult {
  /** applied = stored; failed = the poll was not ok; suspect = it lost every row at once (treat it as a failure). Neither of those writes anything. */
  outcome: 'applied' | 'failed' | 'suspect';
  /** This was the source's baseline poll (R2.5). */
  baseline: boolean;
  diff: ObservationDiff | null;
  upserts: CompanionUpsertResult[];
  /** Items resolved by this poll. */
  resolved: string[];
  /** Objects that left the source (missing two complete polls in a row): their snapshots are gone. */
  gone: string[];
}

/**
 * One poll of one source, stored as a whole: the snapshots for the next
 * diff, every draft (in baseline mode when the source has had none yet), and
 * the absences of an ok and complete poll (two in a row resolve an item and
 * forget an object). Validates first: drafts of another source or a poll that
 * names an object twice throw before anything is written.
 *
 * The baseline is a first look, and an incomplete poll is not a whole one
 * (A2): when the baseline poll is incomplete (a list that failed or was cut
 * short), the first look stays open, and what later polls bring in that it
 * had not seen (no snapshot yet) is stored as baseline too, until an ok and
 * complete poll that looked after the look opened closes it, or
 * COMPANION_FIRST_LOOK_WINDOW_MS has passed. settings.ts reopens it when
 * what a source watches grows (A5). Changes to objects the first look did
 * see stay news, and so do drafts the source does not mark `baseline`.
 */
export function applySourcePoll(input: CompanionPollWrite): CompanionPollWriteResult {
  const { source, result, drafts } = input;
  const now = requireTime(input.now, 'now');
  const nothing = (outcome: 'failed' | 'suspect'): CompanionPollWriteResult => ({ outcome, baseline: false, diff: null, upserts: [], resolved: [], gone: [] });
  if (!result.ok) return nothing('failed');
  const strange = drafts.find((draft) => draft.source !== source) ?? result.observations.find((observation) => observation.source !== source);
  if (strange) throw new Error(`a ${source} poll cannot store ${strange.source} records`);
  const previous = getSnapshots(source);
  if (isSuspectPollDrop(previous.size, result.observations.length)) return nothing('suspect');
  const diff = diffObservations(previous, result.observations);
  const counts = result.complete ? () => true : input.absenceCounts;
  return companionTransaction(() => {
    const record = getSourceBaseline(source);
    const baseline = record === null;
    const lookOpen = record !== null && record.open && now - record.at < COMPANION_FIRST_LOOK_WINDOW_MS;
    const firstLook = (draft: CompanionPollDraft) => baseline || draft.baseline === true || (lookOpen && !previous.has(draft.itemKey));
    putSnapshots(diff.snapshots);
    const gone = counts ? recordMissingSnapshots(source, diff.removed.map((snapshot) => snapshot.objectKey).filter((key) => counts(key))) : [];
    const upserts = drafts.map((draft) => upsertItem(draft, now, { baseline: firstLook(draft) }));
    const resolved = counts ? resolveMissing(source, drafts.map((draft) => draft.itemKey), now, { counts }) : [];
    if (baseline) {
      markSourceBaselined(source, now, { open: !result.complete });
    } else if (record.open && (!lookOpen || (result.complete && pollLookedAt(result.observations, now) >= record.at))) {
      // A poll that looked before the look opened (one still running when the scope grew) cannot close it.
      markSourceBaselined(source, record.at);
    }
    return { outcome: 'applied', baseline, diff, upserts, resolved, gone };
  });
}

// ── Runs ────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  kind: string;
  trigger: string;
  outcome: string;
  detail: string | null;
  turn_id: string | null;
  message_id: string | null;
  started_at: number;
  finished_at: number | null;
  checkin_node_id: string | null;
  runtime_id: string | null;
  native_session_id: string | null;
  checkin_cwd: string | null;
  profile_hash: string | null;
  posted_message_id: string | null;
  posted_at: number | null;
  told_at: number | null;
  discarded_at: number | null;
  reply_chars: number | null;
  changes_json: string | null;
  undone_at: number | null;
  native_kept_at: number | null;
}

const RUN_KINDS: readonly CompanionRunKind[] = ['poll', 'heartbeat', 'brief', 'welcome', 'catch_up', 'worker_report', 'wake', 'send'];
const RUN_OUTCOMES: readonly CompanionRunOutcome[] = ['running', 'ok', 'spoke', 'quiet', 'skipped', 'error', 'preempted', 'superseded'];

/** A run with what only the backend reads (the DTO leaves these out). */
export interface CompanionRunRecord extends CompanionRunDto {
  turnId: string | null;
  messageId: string | null;
  /** The check-in's throwaway node `n-cmph-<runId>`, written before the node exists (DESIGN-v2 §3.1 step 2); kept after it is purged. */
  checkinNodeId: string | null;
  /** What discarding the check-in's native record needs once its node row is gone (§3.7). */
  session: { runtimeId: string; nativeSessionId: string | null; cwd: string; profileHash: string | null } | null;
  postedAt: number | null;
  /** When the user's next turn was told about the post (§3.5). */
  toldAt: number | null;
  /** When the runtime confirmed its native record is gone (discarded or absent); null while it may still be there. */
  discardedAt: number | null;
  /** When the runtime answered that it keeps the native record (`unsupported`): final, boot cleanup no longer asks (D11). */
  nativeKeptAt: number | null;
  /** A superseded reply's length, kept instead of its text (§3.3). */
  replyChars: number | null;
}

function runChangesOf(row: Pick<RunRow, 'id' | 'kind' | 'changes_json'>): CompanionPostChange[] {
  if (!row.changes_json) return [];
  const kind = (COMPANION_CHECKIN_KINDS as readonly string[]).includes(row.kind) ? row.kind : 'heartbeat';
  return parseCompanionPostMetadata({ runId: row.id, kind, changes: parseJson(row.changes_json) })?.changes ?? [];
}

function toRun(row: RunRow): CompanionRunRecord {
  const changes = runChangesOf(row);
  return {
    id: row.id,
    kind: row.kind as CompanionRunKind,
    trigger: row.trigger,
    outcome: row.outcome as CompanionRunOutcome,
    detail: row.detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    // Only what a run has: the Activity rows of polls stay as they were.
    ...(row.posted_message_id ? { postedMessageId: row.posted_message_id } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    ...(row.undone_at !== null && row.undone_at !== undefined ? { undoneAt: row.undone_at } : {}),
    turnId: row.turn_id,
    messageId: row.message_id,
    checkinNodeId: row.checkin_node_id ?? null,
    session: row.runtime_id && row.checkin_cwd
      ? { runtimeId: row.runtime_id, nativeSessionId: row.native_session_id, cwd: row.checkin_cwd, profileHash: row.profile_hash }
      : null,
    postedAt: row.posted_at ?? null,
    toldAt: row.told_at ?? null,
    discardedAt: row.discarded_at ?? null,
    nativeKeptAt: row.native_kept_at ?? null,
    replyChars: row.reply_chars ?? null,
  };
}

function runDto(run: CompanionRunRecord): CompanionRunDto {
  const {
    turnId: _turnId, messageId: _messageId, checkinNodeId: _node, session: _session,
    postedAt: _postedAt, toldAt: _toldAt, discardedAt: _discardedAt, nativeKeptAt: _nativeKeptAt, replyChars: _replyChars, ...dto
  } = run;
  return dto;
}

export interface CompanionRunStart {
  kind: CompanionRunKind;
  /** What started it: the source for a poll, `schedule`, `check_now`, `now-items`, … (≤ 80 characters). */
  trigger: string;
  startedAt: number;
  detail?: string | null;
  turnId?: string | null;
  messageId?: string | null;
}

function cleanRunStart(input: CompanionRunStart): { kind: CompanionRunKind; trigger: string; startedAt: number; detail: string | null; turnId: string | null; messageId: string | null } {
  if (!RUN_KINDS.includes(input.kind)) throw new Error(`unknown Companion run kind: ${String(input.kind)}`);
  const trigger = typeof input.trigger === 'string' ? clip(oneLine(input.trigger), 80) : '';
  if (!trigger) throw new Error('run trigger is required');
  return {
    kind: input.kind,
    trigger,
    startedAt: requireTime(input.startedAt, 'startedAt'),
    detail: input.detail ? clip(oneLine(input.detail), 500) || null : null,
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
  };
}

function runRow(id: string): RunRow | undefined {
  return getDb().prepare('SELECT * FROM companion_runs WHERE owner_user_id = ? AND id = ?').get(OWNER, id) as RunRow | undefined;
}

/** A run that begins now (outcome `running`). */
export function startRun(input: CompanionRunStart): CompanionRunRecord {
  const run = cleanRunStart(input);
  const id = newId('cmr');
  getDb().prepare(`INSERT INTO companion_runs (id, owner_user_id, kind, trigger, outcome, detail, turn_id, message_id, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`).run(id, OWNER, run.kind, run.trigger, run.detail, run.turnId, run.messageId, run.startedAt);
  return toRun(runRow(id)!);
}

/** A running turn's chat turn id, recorded as soon as it is known (R2.3: turnId = `cmp-${runId}`). */
export function setRunTurnId(id: string, turnId: string): boolean {
  const changed = getDb().prepare(`UPDATE companion_runs SET turn_id = ? WHERE owner_user_id = ? AND id = ? AND outcome = 'running'`).run(turnId, OWNER, id);
  return Number(changed.changes) > 0;
}

export interface CompanionRunFinish {
  outcome: Exclude<CompanionRunOutcome, 'running'>;
  finishedAt: number;
  /** Replaces the start's detail when given. */
  detail?: string | null;
  turnId?: string | null;
  /** The assistant message the turn produced (MVP runs; a check-in's lived in its purged node, and its post is recordRunPost's). */
  messageId?: string | null;
}

/** Ends a running run; null when it is not running (already finished, or unknown). */
export function finishRun(id: string, result: CompanionRunFinish): CompanionRunRecord | null {
  if (!RUN_OUTCOMES.includes(result.outcome) || (result.outcome as string) === 'running') throw new Error(`a run cannot finish as ${String(result.outcome)}`);
  const finishedAt = requireTime(result.finishedAt, 'finishedAt');
  const detail = result.detail === undefined ? undefined : result.detail ? clip(oneLine(result.detail), 500) || null : null;
  const changed = getDb().prepare(`UPDATE companion_runs SET outcome = ?, finished_at = ?,
      detail = CASE WHEN ? THEN ? ELSE detail END, turn_id = COALESCE(?, turn_id), message_id = COALESCE(?, message_id)
    WHERE owner_user_id = ? AND id = ? AND outcome = 'running'`)
    .run(result.outcome, finishedAt, detail === undefined ? 0 : 1, detail ?? null, result.turnId ?? null, result.messageId ?? null, OWNER, id);
  return Number(changed.changes) > 0 ? toRun(runRow(id)!) : null;
}

/** A run that is over as it is recorded (a skipped heartbeat, a poll that never started). */
export function recordRun(input: CompanionRunStart & CompanionRunFinish): CompanionRunRecord {
  return companionTransaction(() => finishRun(startRun(input).id, input)!);
}

/** One run by id. */
export function getRun(id: string): CompanionRunRecord | null {
  const row = runRow(id);
  return row ? toRun(row) : null;
}

/** The Activity list: newest first. */
export function listRuns(limit = ACTIVITY_LIMIT): CompanionRunRecord[] {
  const rows = getDb().prepare('SELECT * FROM companion_runs WHERE owner_user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
    .all(OWNER, Math.max(1, Math.floor(limit))) as unknown as RunRow[];
  return rows.map(toRun);
}

/** Runs still marked running, oldest first (after a restart: the turns to re-attach or fail, R2.3). */
export function listRunningRuns(): CompanionRunRecord[] {
  const rows = getDb().prepare(`SELECT * FROM companion_runs WHERE owner_user_id = ? AND outcome = 'running' ORDER BY started_at ASC, rowid ASC`)
    .all(OWNER) as unknown as RunRow[];
  return rows.map(toRun);
}

/**
 * Model turns started since `since` that count against the daily budget
 * (R2.8: heartbeat, wake, brief and catch-up; welcome and worker reports are
 * exempt), skipped ones aside.
 */
export function countTurnsSince(since: number, kinds: readonly CompanionRunKind[] = COMPANION_BUDGETED_RUN_KINDS): number {
  if (kinds.length === 0) return 0;
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM companion_runs
      WHERE owner_user_id = ? AND kind IN (${placeholders(kinds.length)}) AND outcome <> 'skipped' AND started_at >= ?`)
    .get(OWNER, ...kinds, since) as { n: number };
  return Number(row.n);
}

/** When the latest finished run of this kind ended (and with which trigger, e.g. a poll's source); null when none. */
export function latestFinishedRun(kind: CompanionRunKind, trigger?: string): CompanionRunRecord | null {
  const row = (trigger === undefined
    ? getDb().prepare(`SELECT * FROM companion_runs WHERE owner_user_id = ? AND kind = ? AND finished_at IS NOT NULL
        ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(OWNER, kind)
    : getDb().prepare(`SELECT * FROM companion_runs WHERE owner_user_id = ? AND kind = ? AND trigger = ? AND finished_at IS NOT NULL
        ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(OWNER, kind, trigger)) as RunRow | undefined;
  return row ? toRun(row) : null;
}

/** The latest run of this kind that ended with one of these outcomes (e.g. a turn that really ran: spoke or quiet); null when none. */
export function latestRunWithOutcome(kind: CompanionRunKind, outcomes: readonly CompanionRunOutcome[]): CompanionRunRecord | null {
  if (outcomes.length === 0) return null;
  const row = getDb().prepare(`SELECT * FROM companion_runs WHERE owner_user_id = ? AND kind = ? AND outcome IN (${placeholders(outcomes.length)})
      ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(OWNER, kind, ...outcomes) as RunRow | undefined;
  return row ? toRun(row) : null;
}

/**
 * Runs a previous process left `running` end as errors (call once at start),
 * except those named in `except` (turns the caller re-attached). `only`: just
 * these runs (the ones the caller found running before it began cleaning up),
 * so a run this process started meanwhile is never taken for one a stopped
 * Michi left. Returns how many.
 */
export function failInterruptedRuns(now: number, options: { except?: Iterable<string>; only?: Iterable<string> } = {}): number {
  const keep = [...new Set(options.except ?? [])];
  const only = options.only === undefined ? null : [...new Set(options.only)];
  if (only && only.length === 0) return 0;
  const changed = getDb().prepare(`UPDATE companion_runs SET outcome = 'error', finished_at = ?, detail = 'Interrupted: Michi stopped while it ran'
      WHERE owner_user_id = ? AND outcome = 'running'${keep.length ? ` AND id NOT IN (${placeholders(keep.length)})` : ''}${only ? ` AND id IN (${placeholders(only.length)})` : ''}`)
    .run(now, OWNER, ...keep, ...(only ?? []));
  return Number(changed.changes);
}

/** The note on a run whose runtime keeps its native record (`unsupported`): it is not gone, and asking again does not help (D11). */
export const COMPANION_NATIVE_KEPT_NOTE = 'Its runtime kept the check-in transcript';

/**
 * A check-in run whose native record may still be on disk and is still to be
 * asked about (the runtime said deferred, or its discard never ran): the row
 * is what boot cleanup retries it from (DESIGN-v2 §3.7), so neither the cap
 * nor the 30-day purge removes it. A record the runtime keeps (`unsupported`,
 * native_kept_at) is final, never asked about again (D11).
 */
const PENDING_DISCARD_SQL = `(checkin_node_id IS NOT NULL AND discarded_at IS NULL AND native_kept_at IS NULL)`;

/**
 * A check-in run whose native record is not known to be gone: still to be
 * asked about (PENDING_DISCARD_SQL), or kept by its runtime. The 30-day
 * purge keeps its row (the record that a transcript may be on disk), not its
 * text or its receipt's titles (purgeExpired).
 */
const NATIVE_RECORD_KEPT_SQL = `(checkin_node_id IS NOT NULL AND discarded_at IS NULL)`;

/**
 * The run log's cap (the daily cleanup, cleanup.ts): keeps the newest `keep`
 * runs, and always the ones still running and the check-ins whose native
 * record is still to be discarded (they do not count against `keep`), with
 * the Today and goal changes of the runs that stay. Returns how many runs went.
 */
export function pruneRuns(keep: number): number {
  return companionTransaction(() => {
    const changed = getDb().prepare(`DELETE FROM companion_runs WHERE owner_user_id = ? AND id IN (
        SELECT id FROM companion_runs WHERE owner_user_id = ? AND outcome <> 'running' AND NOT ${PENDING_DISCARD_SQL}
        ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
      .run(OWNER, OWNER, Math.max(0, Math.floor(keep)));
    dropOrphanRunChanges();
    return Number(changed.changes);
  });
}

/** Today and goal changes whose run is gone: nothing undoes them any more, and their reasons are check-in text. */
function dropOrphanRunChanges(): number {
  return Number(getDb().prepare(`DELETE FROM companion_run_changes WHERE owner_user_id = ?
      AND run_id NOT IN (SELECT id FROM companion_runs WHERE owner_user_id = ?)`).run(OWNER, OWNER).changes);
}

// ── Check-in runs (DESIGN-v2 §3.1, §3.3, §3.7) ──────────────────────────────

/** Records the check-in's node on its run, before the node exists (§3.1 step 2). */
export function setRunCheckinNode(runId: string, nodeId: string): void {
  const changed = getDb().prepare('UPDATE companion_runs SET checkin_node_id = ? WHERE owner_user_id = ? AND id = ?').run(nodeId, OWNER, runId);
  if (Number(changed.changes) === 0) throw new Error(`no Companion run ${runId}`);
}

/** What the check-in's session ran on, as soon as it opened: boot cleanup discards its native record from this once the node is gone. */
export function recordRunSession(runId: string, session: { runtimeId: string; nativeSessionId: string | null; cwd: string; profileHash: string | null }): void {
  getDb().prepare(`UPDATE companion_runs SET runtime_id = ?, native_session_id = ?, checkin_cwd = ?, profile_hash = ?
      WHERE owner_user_id = ? AND id = ?`).run(session.runtimeId, session.nativeSessionId, session.cwd, session.profileHash, OWNER, runId);
}

/** The run's post went into the conversation: its message, when, and what its receipt lists (the Activity row's "Undo all" reads it). */
export function recordRunPost(runId: string, post: { messageId: string; at: number; changes: readonly CompanionPostChange[] }): void {
  getDb().prepare(`UPDATE companion_runs SET posted_message_id = ?, posted_at = COALESCE(posted_at, ?), changes_json = ?
      WHERE owner_user_id = ? AND id = ?`)
    .run(post.messageId, requireTime(post.at, 'at'), post.changes.length > 0 ? JSON.stringify(post.changes) : null, OWNER, runId);
}

/** A superseded check-in: its reply's length stays, its text does not (§3.3). */
export function setRunReplyChars(runId: string, chars: number): void {
  getDb().prepare('UPDATE companion_runs SET reply_chars = ? WHERE owner_user_id = ? AND id = ?').run(Math.max(0, Math.floor(chars)), OWNER, runId);
}

/** The runtime said the check-in's native record is gone (discarded, or there was none). */
export function markRunDiscarded(runId: string, now: number): void {
  getDb().prepare('UPDATE companion_runs SET discarded_at = COALESCE(discarded_at, ?) WHERE owner_user_id = ? AND id = ?')
    .run(requireTime(now, 'now'), OWNER, runId);
}

/**
 * The runtime answered that it keeps the check-in's native record
 * (`unsupported`): final (D11). Boot cleanup stops asking, and the run's
 * Activity detail says so (COMPANION_NATIVE_KEPT_NOTE, once).
 */
export function markRunNativeKept(runId: string, now: number): void {
  getDb().prepare('UPDATE companion_runs SET native_kept_at = COALESCE(native_kept_at, ?) WHERE owner_user_id = ? AND id = ? AND discarded_at IS NULL')
    .run(requireTime(now, 'now'), OWNER, runId);
  appendRunDetail(runId, COMPANION_NATIVE_KEPT_NOTE);
}

/** Adds a note to a finished run's Activity detail once (e.g. that its native record could not be removed). */
export function appendRunDetail(runId: string, note: string): void {
  const row = runRow(runId);
  if (!row || (row.detail ?? '').includes(note)) return;
  const detail = clip(oneLine(row.detail ? `${row.detail} · ${note}` : note), 500);
  getDb().prepare('UPDATE companion_runs SET detail = ? WHERE owner_user_id = ? AND id = ?').run(detail, OWNER, runId);
}

/** Every Undo all of the run left nothing of it standing (CompanionRunDto.undoneAt). */
export function markRunUndone(runId: string, now: number): void {
  getDb().prepare('UPDATE companion_runs SET undone_at = ? WHERE owner_user_id = ? AND id = ?').run(requireTime(now, 'now'), OWNER, runId);
}

/**
 * Check-in runs boot cleanup still has work on: running, with a native
 * record still to be asked about (not confirmed gone, not kept), or whose
 * node S is still there (a purge that failed, or a turn that would not stop:
 * it may still have a receipt to post). Oldest first.
 */
export function listCheckinRunsToClean(): CompanionRunRecord[] {
  const rows = getDb().prepare(`SELECT * FROM companion_runs WHERE owner_user_id = ? AND checkin_node_id IS NOT NULL
      AND (outcome = 'running' OR ${PENDING_DISCARD_SQL} OR checkin_node_id IN (SELECT id FROM nodes))
      ORDER BY started_at ASC, rowid ASC`).all(OWNER) as unknown as RunRow[];
  return rows.map(toRun);
}

/** A post the user's next turn has not been told about (§3.5): Michi's facts only. */
export interface CompanionUntoldPost {
  runId: string;
  /** `cmp-post-<runId>`. */
  messageId: string;
  kind: CompanionCheckinKind;
  postedAt: number;
  /**
   * What it changed, without the check-in's reasons (§2.8 T1: they are
   * check-in material); titles only of pages and databases that existed
   * before it.
   */
  changes: Array<Omit<CompanionPostChange, 'reason'>>;
}

/**
 * The newest posts not told yet (told_at IS NULL), at most `limit`
 * (COMPANION_LIMITS.maxUntoldPosts), newest first: the [CHECK-INS SINCE THE
 * USER'S LAST MESSAGE] facts (W2-G1b turnContext.ts).
 */
export function listUntoldPosts(limit: number = COMPANION_LIMITS.maxUntoldPosts): CompanionUntoldPost[] {
  const rows = getDb().prepare(`SELECT * FROM companion_runs WHERE owner_user_id = ? AND posted_message_id IS NOT NULL
      AND posted_at IS NOT NULL AND told_at IS NULL ORDER BY posted_at DESC, rowid DESC LIMIT ?`)
    .all(OWNER, Math.max(1, Math.floor(limit))) as unknown as RunRow[];
  return rows.flatMap((row) => {
    if (!(COMPANION_CHECKIN_KINDS as readonly string[]).includes(row.kind)) return [];
    return [{
      runId: row.id,
      messageId: row.posted_message_id!,
      kind: row.kind as CompanionCheckinKind,
      postedAt: row.posted_at!,
      changes: runChangesOf(row).map(({ reason: _reason, ...change }) => change),
    }];
  });
}

/**
 * The user's turn was told about these posts (by run id, or by their
 * `cmp-post-<runId>` message id). Returns how many were marked.
 */
export function markPostsTold(ids: readonly string[], now: number): number {
  const runIds = [...new Set(ids.map((id) => companionPostRunId(id) ?? id).filter((id) => typeof id === 'string' && id.length > 0))];
  if (runIds.length === 0) return 0;
  const changed = getDb().prepare(`UPDATE companion_runs SET told_at = ? WHERE owner_user_id = ? AND told_at IS NULL
      AND posted_message_id IS NOT NULL AND id IN (${placeholders(runIds.length)})`).run(requireTime(now, 'now'), OWNER, ...runIds);
  return Number(changed.changes);
}

/** Where the latest quiet poll of each source is recorded (keepLatestQuietPoll). */
const quietPollKey = (source: CompanionConfigurableSource) => `companion:quiet_poll:${source}` as const;

/**
 * A scheduled poll of `source` that was ok and changed nothing just finished
 * as run `runId` (H#5). Every outside poll writes a row, about two dozen an
 * hour, and the Activity list shows only the newest twenty: of these quiet
 * looks the log keeps the latest one per source, so the source's previous
 * one goes now. Failed polls, polls that changed items, baselines, Check now
 * and first looks are never recorded here, so they all stay; and the newest
 * poll row is never the one that goes, so the last check time
 * (latestFinishedRun) stays right. Returns how many rows went.
 */
export function keepLatestQuietPoll(source: CompanionConfigurableSource, runId: string): number {
  return companionTransaction(() => {
    const previous = getCompanionMeta(quietPollKey(source));
    setCompanionMeta(quietPollKey(source), runId);
    if (previous === null || previous === runId) return 0;
    const changed = getDb().prepare(`DELETE FROM companion_runs WHERE owner_user_id = ? AND id = ? AND kind = 'poll' AND trigger = ? AND outcome = 'ok'`)
      .run(OWNER, previous, source);
    return Number(changed.changes);
  });
}

/**
 * The unread badge (DESIGN-v2 §3.8): messages the check-ins posted into the
 * conversation after the user last viewed the panel (`companion:last_viewed_at`).
 */
export function countUnreadMessages(): number {
  const viewedAt = getCompanionMetaNumber('companion:last_viewed_at') ?? 0;
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM companion_runs WHERE owner_user_id = ?
      AND posted_message_id IS NOT NULL AND posted_at IS NOT NULL AND posted_at > ?`).get(OWNER, viewedAt) as { n: number };
  return Number(row.n);
}

// ── Goals ───────────────────────────────────────────────────────────────────

interface GoalRow {
  id: string;
  text: string;
  progress: string | null;
  progress_at: number | null;
  position: number;
  created_at: number;
  updated_at: number;
  removed_at: number | null;
  text_origin: string | null;
}

/** A stored origin: none recorded is the user's (fresh state); anything unreadable is not trusted as theirs (§2.8 T1). */
const textOriginOf = (value: string | null | undefined): CompanionTextOrigin => (value === undefined || value === null || value === 'user' ? 'user' : 'checkin');

function toGoal(row: GoalRow): CompanionGoalDto {
  return {
    id: row.id, text: row.text, progress: row.progress, progressAt: row.progress_at, createdAt: row.created_at, updatedAt: row.updated_at,
    textOrigin: textOriginOf(row.text_origin),
  };
}

function parseTextOrigin(value: unknown): CompanionTextOrigin {
  if (value !== 'user' && value !== 'checkin') throw invalidRequest('origin must be user or checkin');
  return value;
}

/** A goal's text: one line, 1 to COMPANION_LIMITS.maxGoalChars characters. */
export function parseGoalText(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('A goal is text');
  const text = oneLine(value);
  if (!text) throw invalidRequest('A goal cannot be empty');
  if (text.length > COMPANION_LIMITS.maxGoalChars) throw invalidRequest(`A goal is at most ${COMPANION_LIMITS.maxGoalChars} characters`);
  return text;
}

function parseGoalProgress(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('Goal progress is text');
  const text = oneLine(value);
  if (!text) throw invalidRequest('Goal progress cannot be empty');
  if (text.length > COMPANION_GOAL_PROGRESS_MAX_CHARS) throw invalidRequest(`Goal progress is at most ${COMPANION_GOAL_PROGRESS_MAX_CHARS} characters`);
  return text;
}

function goalRow(id: string): GoalRow | undefined {
  return getDb().prepare('SELECT * FROM companion_goals WHERE owner_user_id = ? AND id = ? AND removed_at IS NULL').get(OWNER, id) as GoalRow | undefined;
}

/** Current goals in order. */
export function listGoals(): CompanionGoalDto[] {
  const rows = getDb().prepare('SELECT * FROM companion_goals WHERE owner_user_id = ? AND removed_at IS NULL ORDER BY position ASC, created_at ASC')
    .all(OWNER) as unknown as GoalRow[];
  return rows.map(toGoal);
}

export function getGoal(id: string): CompanionGoalDto | null {
  const row = goalRow(id);
  return row ? toGoal(row) : null;
}

/** Adds a goal at the end; at most COMPANION_LIMITS.maxGoals. `origin`: who wrote its text (the user's REST: `user`). */
export function addGoal(text: unknown, now: number, origin: CompanionTextOrigin = 'user'): CompanionGoalDto {
  const value = parseGoalText(text);
  return companionTransaction(() => {
    const db = getDb();
    const { n, last } = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS last FROM companion_goals WHERE owner_user_id = ? AND removed_at IS NULL')
      .get(OWNER) as { n: number; last: number | null };
    if (Number(n) >= COMPANION_LIMITS.maxGoals) throw limitReached(`There can be at most ${COMPANION_LIMITS.maxGoals} goals; remove one first`);
    const id = newId('cmg');
    db.prepare(`INSERT INTO companion_goals (id, owner_user_id, text, position, created_at, updated_at, text_origin) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, OWNER, value, (last ?? -1) + 1, now, now, parseTextOrigin(origin));
    return toGoal(goalRow(id)!);
  });
}

/**
 * Changes a goal's text and/or progress (null clears it). Any text given,
 * the same text too, is the user's from then on unless `origin` says
 * otherwise: saving it unchanged is the "Keep" that confirms a check-in's
 * wording (CompanionTextOrigin). A progress reading alone keeps the origin.
 */
export function updateGoal(id: string, patch: { text?: unknown; progress?: unknown }, now: number, origin: CompanionTextOrigin = 'user'): CompanionGoalDto {
  const row = goalRow(id);
  if (!row) throw notFound('Goal not found');
  const text = patch.text === undefined ? row.text : parseGoalText(patch.text);
  const textOrigin = patch.text === undefined ? textOriginOf(row.text_origin) : parseTextOrigin(origin);
  let progress = row.progress;
  let progressAt = row.progress_at;
  if (patch.progress === null) { progress = null; progressAt = null; }
  else if (patch.progress !== undefined) { progress = parseGoalProgress(patch.progress); progressAt = now; }
  getDb().prepare('UPDATE companion_goals SET text = ?, text_origin = ?, progress = ?, progress_at = ?, updated_at = ? WHERE id = ?')
    .run(text, textOrigin, progress, progressAt, now, id);
  return toGoal(goalRow(id)!);
}

/**
 * One goal edit by the agent (W2-G1b companion_edit_goal, DESIGN-v2 §2.6.7:
 * add, reword or remove; `origin` is who wrote the new text): the goal after it
 * (the removed one as it was removed). A check-in passes origin `checkin`, so
 * its wording stays out of the conversation's context until the user keeps
 * or changes it (§2.8 T1). The caller records the change for the receipt and
 * Undo all (recordRunChange).
 */
export function editGoal(edit: { action: CompanionPostChangeAction; id?: string; text?: unknown; origin: CompanionTextOrigin }, now: number = Date.now()): CompanionGoalDto {
  const origin = parseTextOrigin(edit.origin);
  switch (edit.action) {
    case 'add':
      return addGoal(edit.text, now, origin);
    case 'reword':
      if (typeof edit.id !== 'string') throw invalidRequest('id is required to reword a goal');
      if (edit.text === undefined) throw invalidRequest('text is required to reword a goal');
      return updateGoal(edit.id, { text: edit.text }, now, origin);
    case 'remove':
      if (typeof edit.id !== 'string') throw invalidRequest('id is required to remove a goal');
      return removeGoal(edit.id, now);
    default:
      throw invalidRequest('action must be add, reword or remove');
  }
}

/** The Companion's latest reading of a goal (≤ 200 characters). */
export function recordGoalProgress(id: string, progress: unknown, now: number): CompanionGoalDto {
  return updateGoal(id, { progress: parseGoalProgress(progress) }, now);
}

/** Removes a goal (kept, marked removed). */
export function removeGoal(id: string, now: number): CompanionGoalDto {
  const row = goalRow(id);
  if (!row) throw notFound('Goal not found');
  getDb().prepare('UPDATE companion_goals SET removed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  return toGoal({ ...row, updated_at: now });
}

// ── What a check-in changed in Today and the goals (DESIGN-v2 §2.6.5, §2.7) ──

/**
 * A Today item's state as a change records it (`before`, `after`): what a
 * snooze, dismiss or restore moves, and what Undo all puts back. A whole
 * CompanionItemDto is read as one too.
 */
export interface CompanionItemChangeState {
  status: CompanionItemStatus;
  snoozedUntil: number | null;
}

/** A goal as a change records it: null when it did not exist (before an add, after a remove). */
export interface CompanionGoalChangeState {
  text: string;
  textOrigin?: CompanionTextOrigin;
}

export interface CompanionRunChangeInput {
  runId: string;
  targetKind: 'item' | 'goal';
  targetId: string;
  action: CompanionPostChangeAction;
  /** CompanionItemChangeState for an item; CompanionGoalChangeState or null for a goal. */
  before: unknown;
  after: unknown;
  /** Required for Today changes (§2.6.5); at most COMPANION_LIMITS.maxChangeReasonChars. */
  reason: string | null;
  now?: number;
}

interface RunChangeRow {
  id: string;
  run_id: string;
  target_kind: string;
  target_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  created_at: number;
  undone_at: number | null;
}

function itemStateOf(value: unknown): CompanionItemChangeState | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const until = value.snoozedUntil ?? null;
  if (typeof status !== 'string' || !['new', 'seen', 'snoozed', 'dismissed', 'muted', 'resolved'].includes(status)) return null;
  if (until !== null && (typeof until !== 'number' || !Number.isSafeInteger(until))) return null;
  return { status: status as CompanionItemStatus, snoozedUntil: until as number | null };
}

function goalStateOf(value: unknown): CompanionGoalChangeState | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  return { text: value.text, textOrigin: textOriginOf(typeof value.textOrigin === 'string' ? value.textOrigin : null) };
}

/**
 * Records one check-in change to a Today item or a goal (W2-G1b's tools call
 * it on every snooze, dismiss, restore and goal edit): its receipt line, the
 * Today row's "by <name>", and what Undo all restores. Returns the row's id.
 */
export function recordRunChange(input: CompanionRunChangeInput): string {
  if (input.targetKind !== 'item' && input.targetKind !== 'goal') throw invalidRequest('targetKind must be item or goal');
  if (!ID(input.runId) || !ID(input.targetId)) throw invalidRequest('a change needs run and target ids');
  if (!companionChangeActionsFor(input.targetKind).includes(input.action)) {
    throw invalidRequest(`${input.targetKind} changes are ${companionChangeActionsFor(input.targetKind).join(', ')}`);
  }
  const reason = typeof input.reason === 'string' ? clip(oneLine(input.reason), COMPANION_LIMITS.maxChangeReasonChars) || null : null;
  if (input.targetKind === 'item' && !reason) throw invalidRequest('A change to a Today item needs a reason');
  const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));
  const id = newId('cmx');
  getDb().prepare(`INSERT INTO companion_run_changes (id, owner_user_id, run_id, target_kind, target_id, action, before_json, after_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, OWNER, input.runId, input.targetKind, input.targetId, input.action, json(input.before), json(input.after), reason,
      requireTime(input.now ?? Date.now(), 'now'));
  return id;
}

function runChangeRows(runId: string): RunChangeRow[] {
  return getDb().prepare('SELECT * FROM companion_run_changes WHERE owner_user_id = ? AND run_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(OWNER, runId) as unknown as RunChangeRow[];
}

/**
 * A run's Today and goal changes as its receipt lists them: one entry per
 * target, its latest action and reason, how many changes. Never a title
 * (§2.8 T1: item titles are collector material, goal text the check-in's).
 */
export function runItemAndGoalChanges(runId: string): CompanionPostChange[] {
  const byTarget = new Map<string, CompanionPostChange>();
  for (const row of runChangeRows(runId)) {
    const key = `${row.target_kind}:${row.target_id}`;
    const kind = row.target_kind === 'goal' ? 'goal' : 'item';
    const previous = byTarget.get(key);
    byTarget.set(key, {
      kind,
      id: row.target_id,
      applied: (previous?.applied ?? 0) + 1,
      proposed: 0,
      action: row.action as CompanionPostChangeAction,
      ...(row.reason ? { reason: row.reason } : {}),
    });
  }
  return [...byTarget.values()];
}

/** What a change's row shows (CompanionCheckinChangeDto.title): the item's title, or the goal's text after it (before it, for a removal). */
function changeTitle(row: RunChangeRow): string | null {
  if (row.target_kind === 'item') {
    const item = itemRow(row.target_id);
    return item ? item.title : null;
  }
  return goalStateOf(parseJson(row.after_json))?.text ?? goalStateOf(parseJson(row.before_json))?.text ?? null;
}

/**
 * The check-ins' Today and goal changes, newest first, undone ones too
 * (snapshot.checkinChanges). `standing` is the check Undo all makes
 * (undoOne): not undone, and the target is still as the change left it. The
 * user's own actions and a source's resolving leave no row here, so only
 * the target's state tells whether the check-in's change still holds.
 */
export function listCheckinChanges(limit: number = COMPANION_LIMITS.maxSnapshotCheckinChanges): CompanionCheckinChangeDto[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM companion_run_changes WHERE owner_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(OWNER, Math.max(1, Math.floor(limit))) as unknown as RunChangeRow[];
  const standing = (row: RunChangeRow, after: unknown): boolean => {
    if (row.undone_at !== null) return false;
    if (row.target_kind === 'item') {
      const current = itemRow(row.target_id);
      return !!current && sameItemState({ status: current.status as CompanionItemStatus, snoozedUntil: current.snoozed_until }, itemStateOf(after));
    }
    const goal = db.prepare('SELECT text, removed_at FROM companion_goals WHERE owner_user_id = ? AND id = ?')
      .get(OWNER, row.target_id) as Pick<GoalRow, 'text' | 'removed_at'> | undefined;
    if (!goal) return false;
    const live = goal.removed_at === null;
    if (row.action === 'remove') return !live;
    const text = goalStateOf(after)?.text;
    return live && (text === undefined || goal.text === text);
  };
  return rows.map((row) => {
    const after = parseJson(row.after_json);
    return {
      id: row.id,
      runId: row.run_id,
      targetKind: row.target_kind === 'goal' ? 'goal' : 'item',
      targetId: row.target_id,
      action: row.action as CompanionPostChangeAction,
      reason: row.reason,
      title: changeTitle(row),
      at: row.created_at,
      undoneAt: row.undone_at,
      standing: standing(row, after),
      snoozedUntil: row.target_kind === 'item' && row.action === 'snooze' ? itemStateOf(after)?.snoozedUntil ?? null : null,
    };
  });
}

export interface CompanionRunChangesUndo {
  /** companion_run_changes ids put back. */
  reverted: string[];
  /** Changes left alone because their target moved on since (the user, or a later run). */
  conflicts: Array<{ changeId: string; message: string }>;
  /** How many of the run's changes still stand. */
  remaining: number;
}

const sameItemState = (a: CompanionItemChangeState | null, b: CompanionItemChangeState | null) =>
  !!a && !!b && a.status === b.status && (a.snoozedUntil ?? null) === (b.snoozedUntil ?? null);

/** Puts one change back when its target is still as the change left it; a message for the user otherwise. */
function undoOne(row: RunChangeRow, now: number): string | null {
  const db = getDb();
  if (row.target_kind === 'item') {
    const before = itemStateOf(parseJson(row.before_json));
    const after = itemStateOf(parseJson(row.after_json));
    const current = itemRow(row.target_id);
    if (!current) return 'This item is gone';
    if (!before) return 'This change cannot be undone';
    const state = { status: current.status as CompanionItemStatus, snoozedUntil: current.snoozed_until };
    if (!sameItemState(state, after) && !sameItemState(state, before)) return 'This item changed since';
    db.prepare('UPDATE companion_items SET status = ?, snoozed_until = ?, updated_at = ? WHERE id = ?').run(before.status, before.snoozedUntil, now, row.target_id);
    return null;
  }
  const before = goalStateOf(parseJson(row.before_json));
  const after = goalStateOf(parseJson(row.after_json));
  const goal = db.prepare('SELECT * FROM companion_goals WHERE owner_user_id = ? AND id = ?').get(OWNER, row.target_id) as GoalRow | undefined;
  if (!goal) return 'This goal is gone';
  const live = goal.removed_at === null;
  if (row.action === 'add') {
    if (!live) return null;
    if (after && goal.text !== after.text) return 'This goal changed since';
    db.prepare('UPDATE companion_goals SET removed_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.target_id);
    return null;
  }
  if (row.action === 'remove') {
    if (live) return null;
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM companion_goals WHERE owner_user_id = ? AND removed_at IS NULL').get(OWNER) as { n: number };
    if (Number(n) >= COMPANION_LIMITS.maxGoals) return `There are ${COMPANION_LIMITS.maxGoals} goals already`;
    db.prepare('UPDATE companion_goals SET removed_at = NULL, updated_at = ? WHERE id = ?').run(now, row.target_id);
    return null;
  }
  // reword
  if (!before || !live) return live ? 'This change cannot be undone' : 'This goal was removed since';
  if (after && goal.text !== after.text) return goal.text === before.text ? null : 'This goal changed since';
  db.prepare('UPDATE companion_goals SET text = ?, text_origin = ?, updated_at = ? WHERE id = ?')
    .run(before.text, before.textOrigin ?? 'user', now, row.target_id);
  return null;
}

/**
 * Undo all's Today and goal half (POST /companion/runs/:runId/undo, §2.7):
 * the run's changes newest first, each only while its target is as the
 * change left it; one moved on since is a conflict and stays. Done ones are
 * skipped, so it is safe to repeat.
 */
export function undoRunChanges(runId: string, now: number): CompanionRunChangesUndo {
  requireTime(now, 'now');
  return companionTransaction(() => {
    const reverted: string[] = [];
    const conflicts: Array<{ changeId: string; message: string }> = [];
    const rows = runChangeRows(runId).filter((row) => row.undone_at === null).reverse();
    for (const row of rows) {
      const problem = undoOne(row, now);
      if (problem) { conflicts.push({ changeId: row.id, message: problem }); continue; }
      getDb().prepare('UPDATE companion_run_changes SET undone_at = ? WHERE id = ?').run(now, row.id);
      reverted.push(row.id);
    }
    return { reverted, conflicts, remaining: conflicts.length };
  });
}

// ── Cards ───────────────────────────────────────────────────────────────────

interface CardRow {
  id: string;
  kind: string;
  payload_json: string;
  summary: string;
  reason: string | null;
  status: string;
  error: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number;
  reported_at: number | null;
}

/** A card with whether its outcome reached the Companion yet. */
export interface CompanionCardRecord extends CompanionCardDto {
  reportedAt: number | null;
}

function toCard(row: CardRow): CompanionCardRecord {
  const payload = parseJson(row.payload_json);
  return {
    id: row.id,
    kind: row.kind as CompanionCardKind,
    payload: isRecord(payload) ? payload : {},
    summary: row.summary,
    reason: row.reason,
    status: row.status as CompanionCardStatus,
    error: row.error,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    reportedAt: row.reported_at,
  };
}

/** The card as the renderer sees it. */
export function cardDto({ reportedAt: _reportedAt, ...card }: CompanionCardRecord): CompanionCardDto {
  return card;
}

function cardRow(id: string): CardRow | undefined {
  return getDb().prepare('SELECT * FROM companion_cards WHERE owner_user_id = ? AND id = ?').get(OWNER, id) as CardRow | undefined;
}

export interface CompanionCardInsert {
  kind: CompanionCardKind;
  /** Already validated for its kind (cards.ts). */
  payload: Record<string, unknown>;
  /** Written by Michi from the payload. */
  summary: string;
  reason: string | null;
  now: number;
  ttlMs?: number;
}

/** Stores a pending card. cards.ts validates first; prefer proposeCompanionCard there. */
export function insertCard(input: CompanionCardInsert): CompanionCardRecord {
  if (typeof input.kind !== 'string' || !input.kind) throw new Error('card kind is required');
  const summary = clip(oneLine(input.summary ?? ''), 300);
  if (!summary) throw new Error('card summary is required');
  const reason = input.reason ? clip(input.reason, 500) || null : null;
  const id = newId('cmc');
  getDb().prepare(`INSERT INTO companion_cards (id, owner_user_id, kind, payload_json, summary, reason, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(id, OWNER, input.kind, JSON.stringify(input.payload ?? {}), summary, reason, input.now, input.now + (input.ttlMs ?? COMPANION_CARD_TTL_MS));
  return toCard(cardRow(id)!);
}

export function getCard(id: string): CompanionCardRecord | null {
  const row = cardRow(id);
  return row ? toCard(row) : null;
}

/** Cards waiting on the user (pending and not past their TTL), oldest first. */
export function listPendingCards(now: number): CompanionCardRecord[] {
  const rows = getDb().prepare(`SELECT * FROM companion_cards WHERE owner_user_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at ASC, id ASC`).all(OWNER, now) as unknown as CardRow[];
  return rows.map(toCard);
}

export function countPendingCards(now: number, kind?: CompanionCardKind): number {
  const row = (kind === undefined
    ? getDb().prepare(`SELECT COUNT(*) AS n FROM companion_cards WHERE owner_user_id = ? AND status = 'pending' AND expires_at > ?`).get(OWNER, now)
    : getDb().prepare(`SELECT COUNT(*) AS n FROM companion_cards WHERE owner_user_id = ? AND status = 'pending' AND expires_at > ? AND kind = ?`)
      .get(OWNER, now, kind)) as { n: number };
  return Number(row.n);
}

/** Decides a pending card; null when it is not pending (or unknown), so one decision wins. */
export function decideCard(id: string, status: Exclude<CompanionCardStatus, 'pending'>, now: number, error: string | null = null): CompanionCardRecord | null {
  const changed = getDb().prepare(`UPDATE companion_cards SET status = ?, decided_at = ?, error = ?
      WHERE owner_user_id = ? AND id = ? AND status = 'pending'`)
    .run(status, now, error ? clip(oneLine(error), 300) : null, OWNER, id);
  return Number(changed.changes) > 0 ? toCard(cardRow(id)!) : null;
}

/**
 * An applied card whose change could not be made after all (a conversation
 * that did not start): `failed` with the reason. Null unless it was applied.
 */
export function failAppliedCard(id: string, now: number, error: string): CompanionCardRecord | null {
  const changed = getDb().prepare(`UPDATE companion_cards SET status = 'failed', decided_at = ?, error = ?
      WHERE owner_user_id = ? AND id = ? AND status = 'applied'`)
    .run(now, clip(oneLine(error), 300) || 'The change could not be made', OWNER, id);
  return Number(changed.changes) > 0 ? toCard(cardRow(id)!) : null;
}

/** Pending cards past their TTL become `expired`. Returns their ids. */
export function expireCards(now: number): string[] {
  const rows = getDb().prepare(`UPDATE companion_cards SET status = 'expired', decided_at = ?
      WHERE owner_user_id = ? AND status = 'pending' AND expires_at <= ? RETURNING id`).all(now, OWNER, now) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Decided cards whose outcome the Companion has not been told yet, in decision order ([CARD RESULTS]). */
export function listUnreportedCards(limit = 20): CompanionCardRecord[] {
  const rows = getDb().prepare(`SELECT * FROM companion_cards WHERE owner_user_id = ? AND status <> 'pending' AND reported_at IS NULL
      ORDER BY decided_at ASC, id ASC LIMIT ?`).all(OWNER, Math.max(1, Math.floor(limit))) as unknown as CardRow[];
  return rows.map(toCard);
}

/** The Companion was told these outcomes. */
export function markCardsReported(ids: readonly string[], now: number): number {
  if (ids.length === 0) return 0;
  const changed = getDb().prepare(`UPDATE companion_cards SET reported_at = ? WHERE owner_user_id = ? AND status <> 'pending'
      AND reported_at IS NULL AND id IN (${placeholders(ids.length)})`).run(now, OWNER, ...ids);
  return Number(changed.changes);
}

// ── Briefs ──────────────────────────────────────────────────────────────────

interface BriefRow {
  id: string;
  date: string;
  headline: string;
  cards_json: string;
  closing: string;
  origin: string;
  card_feedback_json: string;
  created_at: number;
}

function toBrief(row: BriefRow): CompanionBriefDto {
  const cards = parseJson(row.cards_json);
  const feedback = parseJson(row.card_feedback_json);
  const cardFeedback: Record<number, CompanionFeedback> = {};
  if (isRecord(feedback)) {
    for (const [index, value] of Object.entries(feedback)) {
      if (/^\d+$/.test(index) && (value === 'up' || value === 'down')) cardFeedback[Number(index)] = value;
    }
  }
  return {
    id: row.id,
    date: row.date,
    headline: row.headline,
    cards: Array.isArray(cards) ? cards as CompanionBriefCard[] : [],
    closing: row.closing,
    origin: row.origin as CompanionBriefDto['origin'],
    createdAt: row.created_at,
    cardFeedback,
  };
}

function requiredText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw invalidRequest(`${what} is text`);
  const text = oneLine(value);
  if (!text) throw invalidRequest(`${what} cannot be empty`);
  if (text.length > max) throw invalidRequest(`${what} is at most ${max} characters`);
  return text;
}

/** A brief card as stored: known fields only, each within its limit. */
function cleanBriefCard(value: unknown, index: number): CompanionBriefCard {
  if (!isRecord(value)) throw invalidRequest(`brief card ${index + 1} must be an object`);
  const itemIds = value.itemIds ?? [];
  if (!Array.isArray(itemIds) || itemIds.length > 10 || !itemIds.every(ID)) throw invalidRequest(`brief card ${index + 1}: itemIds is a list of at most 10 item ids`);
  let action: CompanionBriefCard['action'] = null;
  if (value.action !== null && value.action !== undefined) {
    if (!isRecord(value.action)) throw invalidRequest(`brief card ${index + 1}: action is {label, prompt} or null`);
    action = {
      label: requiredText(value.action.label, `brief card ${index + 1} action label`, 40),
      prompt: requiredText(value.action.prompt, `brief card ${index + 1} action prompt`, 1000),
    };
  }
  return {
    title: requiredText(value.title, `brief card ${index + 1} title`, 120),
    body: requiredText(value.body, `brief card ${index + 1} body`, 800),
    itemIds: [...new Set(itemIds as string[])],
    action,
  };
}

export interface CompanionBriefInsert {
  /** Local `YYYY-MM-DD`. */
  date: string;
  headline: string;
  cards: readonly CompanionBriefCard[];
  closing: string;
  origin: CompanionBriefDto['origin'];
  now: number;
}

/** Stores a day's brief; null when that day already has one of this origin (one llm brief a day). */
export function insertBrief(input: CompanionBriefInsert): CompanionBriefDto | null {
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw invalidRequest('date must be YYYY-MM-DD');
  if (input.origin !== 'llm' && input.origin !== 'fallback') throw invalidRequest('origin must be llm or fallback');
  if (!Array.isArray(input.cards) || input.cards.length > COMPANION_LIMITS.maxBriefCards) {
    throw invalidRequest(`A brief has at most ${COMPANION_LIMITS.maxBriefCards} cards`);
  }
  const cards = input.cards.map(cleanBriefCard);
  const headline = requiredText(input.headline, 'headline', 200);
  const closing = requiredText(input.closing, 'closing', 200);
  const id = newId('cmb');
  const inserted = getDb().prepare(`INSERT INTO companion_briefs (id, owner_user_id, date, headline, cards_json, closing, origin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_user_id, date, origin) DO NOTHING`)
    .run(id, OWNER, input.date, headline, JSON.stringify(cards), closing, input.origin, input.now);
  return Number(inserted.changes) > 0 ? getBrief(id) : null;
}

export function getBrief(id: string): CompanionBriefDto | null {
  const row = getDb().prepare('SELECT * FROM companion_briefs WHERE owner_user_id = ? AND id = ?').get(OWNER, id) as BriefRow | undefined;
  return row ? toBrief(row) : null;
}

/** A day's brief: the Companion's own when there is one, else Michi's fallback. */
export function briefForDate(date: string): CompanionBriefDto | null {
  const row = getDb().prepare(`SELECT * FROM companion_briefs WHERE owner_user_id = ? AND date = ?
      ORDER BY CASE origin WHEN 'llm' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`).get(OWNER, date) as BriefRow | undefined;
  return row ? toBrief(row) : null;
}

/** 👍 / 👎 (or neither) on one brief card. */
export function setBriefCardFeedback(id: string, index: number, feedback: CompanionFeedback | null): CompanionBriefDto {
  return companionTransaction(() => {
    const brief = getBrief(id);
    if (!brief) throw notFound('Brief not found');
    if (!Number.isInteger(index) || index < 0 || index >= brief.cards.length) throw invalidRequest(`index must be a card of this brief (0-${brief.cards.length - 1})`);
    if (feedback !== null && feedback !== 'up' && feedback !== 'down') throw invalidRequest('feedback must be up, down or null');
    const next: Record<string, CompanionFeedback> = Object.fromEntries(Object.entries(brief.cardFeedback).map(([key, value]) => [key, value]));
    if (feedback === null) delete next[String(index)];
    else next[String(index)] = feedback;
    getDb().prepare('UPDATE companion_briefs SET card_feedback_json = ? WHERE owner_user_id = ? AND id = ?').run(JSON.stringify(next), OWNER, id);
    return getBrief(id)!;
  });
}

// ── Notices (desktop notification outbox) ───────────────────────────────────

interface NoticeRow {
  id: string;
  title: string;
  body: string;
  target_json: string;
  item_ids_json: string;
  item_versions_json: string;
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
}

function toNotice(row: NoticeRow): CompanionNotice {
  const itemIds = parseJson(row.item_ids_json);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    target: parseCompanionTarget(parseJson(row.target_json)) ?? { kind: 'companion', tab: 'chat' },
    itemIds: Array.isArray(itemIds) ? itemIds.filter((id): id is string => typeof id === 'string') : [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface CompanionNoticeInsert {
  title: string;
  body: string;
  target: CompanionTarget;
  /** The feed items it is about; their current versions are recorded with it. Unknown ids are left out. */
  itemIds: readonly string[];
  now: number;
  /** When it goes stale; default `now` + COMPANION_LIMITS.noticeTtlMs (a meeting's: its start). */
  expiresAt?: number;
}

/** Stores a notice in the outbox (delivery.ts publishes it). */
export function insertNotice(input: CompanionNoticeInsert): CompanionNotice {
  const title = typeof input.title === 'string' ? clip(oneLine(input.title), 120) : '';
  const body = typeof input.body === 'string' ? clip(input.body, 500) : '';
  if (!title || !body) throw new Error('a notice needs a title and a body');
  const target = parseCompanionTarget(input.target);
  if (!target) throw new Error('notice target is malformed');
  const now = requireTime(input.now, 'now');
  const expiresAt = input.expiresAt === undefined ? now + COMPANION_LIMITS.noticeTtlMs : requireTime(input.expiresAt, 'expiresAt');
  const wanted = [...new Set(input.itemIds)].filter(ID);
  const versions: Record<string, string> = {};
  if (wanted.length > 0) {
    const rows = getDb().prepare(`SELECT id, version FROM companion_items WHERE owner_user_id = ? AND id IN (${placeholders(wanted.length)})`)
      .all(OWNER, ...wanted) as Array<{ id: string; version: string }>;
    for (const row of rows) versions[row.id] = row.version;
  }
  const itemIds = wanted.filter((id) => versions[id] !== undefined);
  const id = newId('cmn');
  getDb().prepare(`INSERT INTO companion_notices (id, owner_user_id, title, body, target_json, item_ids_json, item_versions_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, OWNER, title, body, JSON.stringify(target), JSON.stringify(itemIds), JSON.stringify(versions), now, expiresAt);
  return toNotice(getDb().prepare('SELECT * FROM companion_notices WHERE id = ?').get(id) as unknown as NoticeRow);
}

/**
 * Whether a notice is still worth showing (R2.7): it has not expired, and it
 * is about nothing in particular (a Companion reply) or at least one of its
 * items is still open at the version it was about.
 */
function noticeStillValid(row: NoticeRow, now: number, hidden: HiddenItems): boolean {
  if (row.expires_at <= now) return false;
  const versions = parseJson(row.item_versions_json);
  const ids = Object.keys(isRecord(versions) ? versions : {});
  if (ids.length === 0) return true;
  return ids.some((id) => {
    const item = itemRow(id);
    return !!item && item.version === (versions as Record<string, unknown>)[id] && isOpenCompanionItem(toItemDto(item), now) && !isHiddenItem(item, hidden);
  });
}

/** Undelivered notices still worth showing, oldest first: what a notifier that connects gets (delivery.ts folds a backlog). */
export function pendingNotices(now: number, limit = 50): CompanionNotice[] {
  const rows = getDb().prepare(`SELECT * FROM companion_notices WHERE owner_user_id = ? AND delivered_at IS NULL AND expires_at > ?
      ORDER BY created_at ASC, id ASC`).all(OWNER, now) as unknown as NoticeRow[];
  const hidden = hiddenItems();
  return rows.filter((row) => noticeStillValid(row, now, hidden)).slice(0, Math.max(1, Math.floor(limit))).map(toNotice);
}

/** These notices are done with without being shown on their own (folded into one). Returns how many changed. */
export function markNoticesDelivered(ids: readonly string[], now: number): number {
  if (ids.length === 0) return 0;
  const changed = getDb().prepare(`UPDATE companion_notices SET delivered_at = ? WHERE owner_user_id = ? AND delivered_at IS NULL
      AND id IN (${placeholders(ids.length)})`).run(now, OWNER, ...ids);
  return Number(changed.changes);
}

/** A notifier showed it: `acked` the first time, `already` after, `missing` for an unknown id. */
export function ackNotice(id: string, now: number): 'acked' | 'already' | 'missing' {
  const changed = getDb().prepare('UPDATE companion_notices SET delivered_at = ? WHERE owner_user_id = ? AND id = ? AND delivered_at IS NULL')
    .run(now, OWNER, id);
  if (Number(changed.changes) > 0) return 'acked';
  return getDb().prepare('SELECT 1 FROM companion_notices WHERE owner_user_id = ? AND id = ?').get(OWNER, id) ? 'already' : 'missing';
}

/** Notices created since `since` (the delivery caps). */
export function countNoticesSince(since: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM companion_notices WHERE owner_user_id = ? AND created_at >= ?').get(OWNER, since) as { n: number };
  return Number(row.n);
}

// ── Delegations (conversations the Companion started) ───────────────────────

interface DelegationRow {
  id: string;
  workspace_id: string;
  node_id: string;
  title: string;
  created_at: number;
  last_reported_message_id: string | null;
  last_reported_at: number | null;
  closed_at: number | null;
  state: string;
  origin: string | null;
  last_sent_at: number | null;
  closed_reason: string | null;
  /** 0: ask before each follow-up; 1 + the choice's place in CHAT_PERMISSION_CHOICE_ORDER: "stop asking" while it runs no wider (D22). */
  auto_send: number;
  /** The reply a held-back "Worker finished" notice left to Today (D18); only the joined reads carry it. */
  left_to_today?: string | null;
}

const DELEGATION_ORIGINS: readonly CompanionDelegationOrigin[] = ['card', 'start_conversation'];
const DELEGATION_CLOSED_REASONS: readonly CompanionDelegationClosedReason[] = ['took_over', 'gone', 'idle', 'age'];

/** meta key prefix of the reply a held-back "Worker finished" notice left to Today (D18), by delegation id. */
const DELEGATION_LEFT_KEY = 'companion:delegation_left:';
/** companion_delegations `d` with the reply it left to Today, as `left_to_today`. */
const DELEGATION_SELECT = `SELECT d.*, m.value AS left_to_today FROM companion_delegations d LEFT JOIN meta m ON m.key = '${DELEGATION_LEFT_KEY}' || d.id`;

/**
 * The permission choice "Send, and stop asking" was chosen under (D22):
 * auto_send is 1 + its place in CHAT_PERMISSION_CHOICE_ORDER. Null when it
 * is off. A value that is no choice reads as `ask`, the narrowest, so any
 * wider mode asks again.
 */
function autoSendChoice(value: unknown): ChatPermissionChoice | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return CHAT_PERMISSION_CHOICE_ORDER[n - 1] ?? 'ask';
}

function toDelegationDto(row: DelegationRow): CompanionDelegationDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    title: row.title,
    state: row.state === 'following' ? 'following' : 'closed',
    origin: DELEGATION_ORIGINS.includes(row.origin as CompanionDelegationOrigin) ? row.origin as CompanionDelegationOrigin : null,
    autoSend: autoSendChoice(row.auto_send) !== null,
    createdAt: row.created_at,
    lastSentAt: row.last_sent_at,
    lastReportedAt: row.last_reported_at,
    closedAt: row.closed_at,
    closedReason: DELEGATION_CLOSED_REASONS.includes(row.closed_reason as CompanionDelegationClosedReason)
      ? row.closed_reason as CompanionDelegationClosedReason : null,
  };
}

/**
 * The conversations the agent still follows (DESIGN-v2 §4), newest first:
 * snapshot.delegations, the session_send targets. recordDelegation starts
 * following one; every delegation from before v2 is closed.
 */
export function listFollowedDelegations(): CompanionDelegationDto[] {
  const rows = getDb().prepare(`SELECT * FROM companion_delegations WHERE owner_user_id = ? AND state = 'following'
      ORDER BY created_at DESC, id DESC`).all(OWNER) as unknown as DelegationRow[];
  return rows.map(toDelegationDto);
}

/**
 * Settings › <name> › Activity's "Ask before sending" (PATCH
 * /companion/delegations/:id): follow-ups to this conversation ask again.
 * Null when there is no such delegation of the local owner.
 */
export function stopDelegationAutoSend(id: string): CompanionDelegationDto | null {
  return companionTransaction(() => {
    getDb().prepare('UPDATE companion_delegations SET auto_send = 0 WHERE owner_user_id = ? AND id = ?').run(OWNER, id);
    const row = getDb().prepare('SELECT * FROM companion_delegations WHERE owner_user_id = ? AND id = ?').get(OWNER, id) as DelegationRow | undefined;
    return row ? toDelegationDto(row) : null;
  });
}

/**
 * A delegation as the engine and session_send read it (DESIGN-v2 §4): the
 * record the worker reports use, plus whether the agent still follows it,
 * how it began, "Send, and stop asking", and its last follow-up. A row from
 * before v2 is `closed` (0082's default) even when the MVP never closed it.
 */
export interface CompanionDelegation extends CompanionDelegationRecord {
  state: CompanionDelegationState;
  origin: CompanionDelegationOrigin | null;
  autoSend: boolean;
  /** The choice "Send, and stop asking" was given under (D22): it holds while the conversation runs no wider. Null when off. */
  autoSendChoice: ChatPermissionChoice | null;
  lastSentAt: number | null;
  closedReason: CompanionDelegationClosedReason | null;
  /** The reply a held-back "Worker finished" notice left to Today (D18): not reported again, shown by the Michi source. */
  leftToTodayMessageId: string | null;
}

function toDelegation(row: DelegationRow): CompanionDelegation {
  const dto = toDelegationDto(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    title: row.title,
    createdAt: row.created_at,
    lastReportedMessageId: row.last_reported_message_id,
    lastReportedAt: row.last_reported_at,
    closedAt: row.closed_at,
    state: dto.state,
    origin: dto.origin,
    autoSend: dto.autoSend,
    autoSendChoice: autoSendChoice(row.auto_send),
    lastSentAt: dto.lastSentAt,
    closedReason: dto.closedReason,
    leftToTodayMessageId: typeof row.left_to_today === 'string' && row.left_to_today ? row.left_to_today : null,
  };
}

export function getDelegation(nodeId: string): CompanionDelegation | null {
  const row = getDb().prepare(`${DELEGATION_SELECT} WHERE d.owner_user_id = ? AND d.node_id = ?`).get(OWNER, nodeId) as DelegationRow | undefined;
  return row ? toDelegation(row) : null;
}

/** The delegation of this conversation while the agent follows it (DESIGN-v2 §4: the only session_send target); null otherwise. */
export function getFollowedDelegation(nodeId: string): CompanionDelegation | null {
  const delegation = getDelegation(nodeId);
  return delegation?.state === 'following' ? delegation : null;
}

/**
 * Records a conversation the agent started, which it now follows (DESIGN-v2
 * §4): an applied conversation.start card (`card`) or start_conversation in
 * the user's own turn (`start_conversation`). The first record of a node is
 * kept; a later one may only name how a conversation it still follows began
 * (an applied card starts its conversation through start_conversation, so
 * the card has the last word).
 */
export function recordDelegation(input: { workspaceId: string; nodeId: string; title: string; now: number; origin?: CompanionDelegationOrigin }): CompanionDelegation {
  if (!ID(input.workspaceId) || !ID(input.nodeId)) throw new Error('a delegation needs workspace and node ids');
  if (input.origin !== undefined && !DELEGATION_ORIGINS.includes(input.origin)) throw new Error(`unknown delegation origin: ${String(input.origin)}`);
  const title = clip(oneLine(input.title ?? ''), 200) || 'Conversation';
  getDb().prepare(`INSERT INTO companion_delegations (id, owner_user_id, workspace_id, node_id, title, created_at, state, origin)
      VALUES (?, ?, ?, ?, ?, ?, 'following', ?)
      ON CONFLICT (owner_user_id, node_id) DO UPDATE SET origin = COALESCE(excluded.origin, origin) WHERE state = 'following'`)
    .run(newId('cmd'), OWNER, input.workspaceId, input.nodeId, title, input.now, input.origin ?? null);
  return getDelegation(input.nodeId)!;
}

/** Delegations the agent still follows, oldest first (worker reports). */
export function listOpenDelegations(): CompanionDelegation[] {
  const rows = getDb().prepare(`${DELEGATION_SELECT} WHERE d.owner_user_id = ? AND d.state = 'following' ORDER BY d.created_at ASC, d.id ASC`)
    .all(OWNER) as unknown as DelegationRow[];
  return rows.map(toDelegation);
}

/**
 * Delegations started since `since` whose replies a worker report covers,
 * open or closed, oldest first: the Michi source leaves their finished
 * replies out of Today. One whose reply a held-back "Worker finished" notice
 * left to Today (D18) is not among them, so that reply shows in Today and
 * the brief, while the agent still follows the conversation.
 */
export function listDelegationsSince(since: number): CompanionDelegation[] {
  const rows = getDb().prepare(`${DELEGATION_SELECT} WHERE d.owner_user_id = ? AND d.created_at >= ? AND m.value IS NULL
      ORDER BY d.created_at ASC, d.id ASC`).all(OWNER, Math.floor(since)) as unknown as DelegationRow[];
  return rows.map(toDelegation);
}

/** Forgets the reply a delegation left to Today: a report or a follow-up made the conversation the agent's to report again. */
function clearDelegationLeftToToday(nodeId: string): void {
  getDb().prepare(`DELETE FROM meta WHERE key = (SELECT '${DELEGATION_LEFT_KEY}' || id FROM companion_delegations WHERE owner_user_id = ? AND node_id = ?)`)
    .run(OWNER, nodeId);
}

/** The worker's reply `messageId` reached the Companion. A delegation stays followed after its report (DESIGN-v2 §4). */
export function markDelegationReported(nodeId: string, messageId: string, now: number): boolean {
  return companionTransaction(() => {
    const changed = getDb().prepare(`UPDATE companion_delegations SET last_reported_message_id = ?, last_reported_at = ?
        WHERE owner_user_id = ? AND node_id = ?`).run(messageId, now, OWNER, nodeId);
    clearDelegationLeftToToday(nodeId);
    return Number(changed.changes) > 0;
  });
}

/**
 * A "Worker finished" notice the gate held back (an off day, quiet hours,
 * notifications off, a cap, its pane on screen; D18): the reply `messageId`
 * is left to Today and the brief, so worker reports skip it and the Michi
 * source shows it (listDelegationsSince), and the agent keeps following the
 * conversation: its next reply is reported as usual. Nothing reported it,
 * so the idle clock does not restart. False unless followed.
 */
export function leaveDelegationReplyToToday(nodeId: string, messageId: string): boolean {
  if (!messageId) throw new Error('leaveDelegationReplyToToday needs the reply id');
  const row = getDb().prepare(`SELECT id FROM companion_delegations WHERE owner_user_id = ? AND node_id = ? AND state = 'following'`)
    .get(OWNER, nodeId) as { id: string } | undefined;
  if (!row) return false;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`${DELEGATION_LEFT_KEY}${row.id}`, messageId);
  return true;
}

/**
 * Stops following a delegation (DESIGN-v2 §4): the user wrote in it
 * (`took_over`), it went or was cancelled (`gone`), a day passed since the
 * last follow-up or report (`idle`), or it is older than three days (`age`).
 * The engine always names one (a held-back notice no longer closes it, D18);
 * a row closed without one before reads as having none. False when it was
 * not followed.
 */
export function closeDelegation(nodeId: string, now: number, reason: CompanionDelegationClosedReason | null = null): boolean {
  if (reason !== null && !DELEGATION_CLOSED_REASONS.includes(reason)) throw new Error(`unknown delegation close reason: ${String(reason)}`);
  const changed = getDb().prepare(`UPDATE companion_delegations SET state = 'closed', closed_at = ?, closed_reason = ?
      WHERE owner_user_id = ? AND node_id = ? AND state = 'following'`).run(now, reason, OWNER, nodeId);
  return Number(changed.changes) > 0;
}

/**
 * The user answered a follow-up's approval with "Send, and stop asking for
 * this conversation" while it ran under `choice` (D22): later follow-ups go
 * without asking only while it runs no wider (CompanionDelegation
 * autoSendChoice). False unless followed.
 */
export function setDelegationAutoSend(id: string, choice: ChatPermissionChoice): boolean {
  const rank = CHAT_PERMISSION_CHOICE_ORDER.indexOf(choice);
  if (rank < 0) throw new Error(`unknown permission choice: ${String(choice)}`);
  const changed = getDb().prepare(`UPDATE companion_delegations SET auto_send = ? WHERE owner_user_id = ? AND id = ? AND state = 'following'`)
    .run(rank + 1, OWNER, id);
  return Number(changed.changes) > 0;
}

/** A follow-up went into the delegated conversation (DESIGN-v2 §4): the idle clock counts from it, and its answer is reported (D18). */
export function markDelegationSent(id: string, now: number): boolean {
  return companionTransaction(() => {
    const changed = getDb().prepare('UPDATE companion_delegations SET last_sent_at = ? WHERE owner_user_id = ? AND id = ?').run(requireTime(now, 'now'), OWNER, id);
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(`${DELEGATION_LEFT_KEY}${id}`);
    return Number(changed.changes) > 0;
  });
}

// ── Follow-ups (DESIGN-v2 §4: a `send` run each) ────────────────────────────

/**
 * One follow-up's run (kind `send`, outside the turn budget), tied to its
 * delegation. Its detail says how it went out (via, the card, the length),
 * never the text. The turn id is recorded when it finishes, so a Michi that
 * stops mid-send leaves a run boot ends as interrupted, never a turn it
 * re-attaches.
 */
export function startSendRun(input: { delegationId: string; via: string; detail: string; startedAt: number }): CompanionRunRecord {
  return companionTransaction(() => {
    const run = startRun({ kind: 'send', trigger: input.via, detail: input.detail, startedAt: input.startedAt });
    getDb().prepare('UPDATE companion_runs SET delegation_id = ? WHERE owner_user_id = ? AND id = ?').run(input.delegationId, OWNER, run.id);
    return run;
  });
}

/** Follow-ups delivered into this delegation since `since` (COMPANION_LIMITS.maxDailySendsPerDelegation counts them per local day). */
export function countDeliveredSends(delegationId: string, since: number): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM companion_runs WHERE owner_user_id = ? AND kind = 'send' AND delegation_id = ?
      AND outcome = 'ok' AND started_at >= ?`).get(OWNER, delegationId, Math.floor(since)) as { n: number };
  return Number(row.n);
}

/**
 * A check-in sent a follow-up itself (Q1) into conversation `nodeId`
 * (w3-fix D21): kept on the check-in's run as a `send` change, so its post
 * or Michi's receipt lists it even after a restart (posts.ts
 * checkinRunChanges reads it back; the post's own record then replaces the
 * run's changes with the full list, this one included). Once per
 * conversation. Throws for a run that is not there.
 */
export function recordCheckinSend(checkinRunId: string, send: { nodeId: string; title: string }): void {
  if (!ID(send.nodeId)) throw new Error('recordCheckinSend needs the conversation\'s node id');
  companionTransaction(() => {
    const row = getDb().prepare('SELECT id, kind, changes_json FROM companion_runs WHERE owner_user_id = ? AND id = ?')
      .get(OWNER, checkinRunId) as Pick<RunRow, 'id' | 'kind' | 'changes_json'> | undefined;
    if (!row) throw new Error(`no run ${checkinRunId}`);
    const title = clip(oneLine(send.title ?? ''), 200);
    const changes = runChangesOf(row).filter((change) => !(change.kind === 'send' && change.id === send.nodeId));
    changes.push({ kind: 'send', id: send.nodeId, ...(title ? { title } : {}), applied: 1, proposed: 0 });
    getDb().prepare('UPDATE companion_runs SET changes_json = ? WHERE owner_user_id = ? AND id = ?').run(JSON.stringify(changes), OWNER, checkinRunId);
  });
}

/** The follow-ups check-in run `runId` sent itself (recordCheckinSend), as its receipt lists them. */
export function checkinRunSends(runId: string): CompanionPostChange[] {
  const row = getDb().prepare('SELECT id, kind, changes_json FROM companion_runs WHERE owner_user_id = ? AND id = ?')
    .get(OWNER, runId) as Pick<RunRow, 'id' | 'kind' | 'changes_json'> | undefined;
  return row ? runChangesOf(row).filter((change) => change.kind === 'send') : [];
}

// ── Reminders and watches (R2.9) ────────────────────────────────────────────

interface ReminderRow {
  id: string;
  kind: string;
  text: string;
  at: number | null;
  daily_at: string | null;
  item_id: string | null;
  until: string | null;
  status: string;
  created_at: number;
  fired_at: number | null;
  last_fired_date: string | null;
}

export type CompanionWatchUntil = NonNullable<CompanionReminderDto['until']>;
export type CompanionReminderStatus = CompanionReminderDto['status'];

export const COMPANION_WATCH_UNTIL: readonly CompanionWatchUntil[] = Object.freeze(['approved', 'merged', 'recovered', 'read', 'answered']);

/** What a watch can wait for, by its item's source: a CR is approved or merged, a pipeline recovers, an email is read, a Michi conversation answered. */
export const COMPANION_WATCH_UNTIL_BY_SOURCE: Readonly<Record<CompanionSourceKind, readonly CompanionWatchUntil[]>> = Object.freeze({
  cr: ['approved', 'merged'],
  pipeline: ['recovered'],
  email: ['read'],
  michi: ['answered'],
  calendar: [],
  system: [],
});

/** A reminder with the local date its daily reminder last fired (the DTO leaves it out). */
export interface CompanionReminderRecord extends CompanionReminderDto {
  lastFiredDate: string | null;
}

function toReminder(row: ReminderRow): CompanionReminderRecord {
  return {
    id: row.id,
    kind: row.kind as CompanionReminderDto['kind'],
    text: row.text,
    at: row.at,
    dailyAt: row.daily_at,
    itemId: row.item_id,
    until: row.until as CompanionReminderDto['until'],
    status: row.status as CompanionReminderStatus,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    lastFiredDate: row.last_fired_date,
  };
}

export function reminderDto({ lastFiredDate: _lastFiredDate, ...reminder }: CompanionReminderRecord): CompanionReminderDto {
  return reminder;
}

function reminderRow(id: string): ReminderRow | undefined {
  return getDb().prepare('SELECT * FROM companion_reminders WHERE owner_user_id = ? AND id = ?').get(OWNER, id) as ReminderRow | undefined;
}

export interface CompanionReminderInput {
  text?: unknown;
  /** Epoch ms of a one-off reminder. */
  at?: unknown;
  /** Local `HH:MM` of a daily (workday) reminder. */
  dailyAt?: unknown;
  /** The item the reminder or watch is about. */
  itemId?: unknown;
  /** Makes it a watch: the state its item must reach. */
  until?: unknown;
}

export interface CompanionReminderSpec {
  kind: CompanionReminderDto['kind'];
  text: string;
  at: number | null;
  dailyAt: string | null;
  itemId: string | null;
  until: CompanionWatchUntil | null;
}

const absent = (value: unknown) => value === undefined || value === null;

/** The words of a reminder: one line, 1 to COMPANION_REMINDER_TEXT_MAX_CHARS characters. */
export function parseReminderText(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('A reminder is text');
  const text = oneLine(value);
  if (!text) throw invalidRequest('A reminder cannot be empty');
  if (text.length > COMPANION_REMINDER_TEXT_MAX_CHARS) throw invalidRequest(`A reminder is at most ${COMPANION_REMINDER_TEXT_MAX_CHARS} characters`);
  return text;
}

/**
 * A reminder or watch checked against the current items (validated again on
 * a card's Apply): a watch names an item and a state its source can reach and
 * no time; a time reminder has exactly one of a future `at` (within a year)
 * or a daily `dailyAt`, and may name an item. Throws CompanionError.
 */
export function parseReminderInput(input: CompanionReminderInput, now: number): CompanionReminderSpec {
  const text = parseReminderText(input.text);
  let item: ItemRow | undefined;
  if (!absent(input.itemId)) {
    if (!ID(input.itemId)) throw invalidRequest('itemId must be a Companion item id');
    item = itemRow(input.itemId as string);
    if (!item) throw notFound('That item does not exist');
  }
  if (!absent(input.until)) {
    if (!COMPANION_WATCH_UNTIL.includes(input.until as CompanionWatchUntil)) {
      throw invalidRequest(`until must be one of: ${COMPANION_WATCH_UNTIL.join(', ')}`);
    }
    if (!item) throw invalidRequest('A watch needs the itemId of the item it watches');
    if (!absent(input.at) || !absent(input.dailyAt)) throw invalidRequest('A watch has no time: give until or a time, not both');
    const allowed = COMPANION_WATCH_UNTIL_BY_SOURCE[item.source as CompanionSourceKind] ?? [];
    if (!allowed.includes(input.until as CompanionWatchUntil)) {
      throw invalidRequest(allowed.length
        ? `A ${item.source} item can be watched until: ${allowed.join(', ')}`
        : `A ${item.source} item cannot be watched`);
    }
    return { kind: 'watch', text, at: null, dailyAt: null, itemId: item.id, until: input.until as CompanionWatchUntil };
  }
  const hasAt = !absent(input.at);
  const hasDaily = !absent(input.dailyAt);
  if (hasAt === hasDaily) throw invalidRequest('A reminder has either at (a time) or dailyAt (HH:MM every workday)');
  if (hasAt) {
    const at = input.at;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= now) throw invalidRequest('at must be a future time (epoch ms)');
    if (at > now + COMPANION_MAX_REMINDER_AHEAD_MS) throw invalidRequest('A reminder can be set at most a year ahead');
    return { kind: 'time', text, at, dailyAt: null, itemId: item?.id ?? null, until: null };
  }
  if (!isCompanionClock(input.dailyAt)) throw invalidRequest('dailyAt must be a time as HH:MM (24-hour)');
  return { kind: 'time', text, at: null, dailyAt: input.dailyAt, itemId: item?.id ?? null, until: null };
}

/** Reminders and watches still to fire (active or paused). */
export function countOpenReminders(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM companion_reminders WHERE owner_user_id = ? AND status IN ('active','paused')`)
    .get(OWNER) as { n: number };
  return Number(row.n);
}

/** Adds a reminder or watch (the user's REST, or an applied card); at most COMPANION_LIMITS.maxReminders open at once. */
export function createReminder(input: CompanionReminderInput, now: number): CompanionReminderRecord {
  return companionTransaction(() => {
    const spec = parseReminderInput(input, now);
    if (countOpenReminders() >= COMPANION_LIMITS.maxReminders) {
      throw limitReached(`There can be at most ${COMPANION_LIMITS.maxReminders} reminders and watches; remove one first`);
    }
    const id = newId('cmrm');
    getDb().prepare(`INSERT INTO companion_reminders (id, owner_user_id, kind, text, at, daily_at, item_id, until, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, OWNER, spec.kind, spec.text, spec.at, spec.dailyAt, spec.itemId, spec.until, now);
    return toReminder(reminderRow(id)!);
  });
}

/**
 * One reminder by id, whatever its status; the backend itself reads reminders as lists.
 * @testonly
 */
export function getReminder(id: string): CompanionReminderRecord | null {
  const row = reminderRow(id);
  return row ? toReminder(row) : null;
}

/** Reminders with these statuses (default: the open ones the Today tab lists), oldest first. */
export function listReminders(statuses: readonly CompanionReminderStatus[] = ['active', 'paused']): CompanionReminderRecord[] {
  if (statuses.length === 0) return [];
  const rows = getDb().prepare(`SELECT * FROM companion_reminders WHERE owner_user_id = ? AND status IN (${placeholders(statuses.length)})
      ORDER BY created_at ASC, id ASC`).all(OWNER, ...statuses) as unknown as ReminderRow[];
  return rows.map(toReminder);
}

/** Pauses or resumes an open reminder; a fired or cancelled one refuses (409 reminder_closed). */
export function setReminderStatus(id: string, status: 'active' | 'paused'): CompanionReminderRecord {
  if (status !== 'active' && status !== 'paused') throw invalidRequest('status must be active or paused');
  return companionTransaction(() => {
    const row = reminderRow(id);
    if (!row) throw notFound('Reminder not found');
    if (row.status !== 'active' && row.status !== 'paused') throw new CompanionError(409, 'reminder_closed', `This reminder is already ${row.status}`);
    getDb().prepare('UPDATE companion_reminders SET status = ? WHERE id = ?').run(status, id);
    return toReminder(reminderRow(id)!);
  });
}

/** The user removed a reminder: it is kept as cancelled and never fires. Idempotent. */
export function cancelReminder(id: string): CompanionReminderRecord {
  return companionTransaction(() => {
    const row = reminderRow(id);
    if (!row) throw notFound('Reminder not found');
    if (row.status === 'active' || row.status === 'paused') getDb().prepare(`UPDATE companion_reminders SET status = 'cancelled' WHERE id = ?`).run(id);
    return toReminder(reminderRow(id)!);
  });
}

/**
 * An active reminder fired (the coordinator made its reminder_due item): a
 * one-off reminder or a watch ends `fired`; a daily one stays active and
 * records the local date, so it fires once a day. Null unless it was active.
 */
export function markReminderFired(id: string, now: number): CompanionReminderRecord | null {
  return companionTransaction(() => {
    const row = reminderRow(id);
    if (!row || row.status !== 'active') return null;
    if (row.kind === 'time' && row.daily_at) {
      getDb().prepare('UPDATE companion_reminders SET fired_at = ?, last_fired_date = ? WHERE id = ?').run(now, localDateKey(now), id);
    } else {
      getDb().prepare(`UPDATE companion_reminders SET status = 'fired', fired_at = ? WHERE id = ?`).run(now, id);
    }
    return toReminder(reminderRow(id)!);
  });
}

// ── Single values (meta) ────────────────────────────────────────────────────

/** The Companion's `meta` keys (`companion:settings` and `companion:baseline:*` belong to settings.ts' helpers). */
export type CompanionMetaKey =
  | 'companion:notes'
  | 'companion:notes_revision'
  | 'companion:rules'
  | 'companion:brief_curate'
  | 'companion:heartbeat_cursor'
  | 'companion:wake_cursor'
  | 'companion:brief_cursor'
  | 'companion:last_heartbeat_at'
  | 'companion:last_wake_at'
  | 'companion:last_viewed_at'
  | 'companion:last_purge_at'
  | 'companion:catch_up'
  | 'companion:welcome_done'
  /** Who last wrote the notes (CompanionTextOrigin; absent: `user`). */
  | 'companion:notes_origin'
  | 'companion:revision'
  | `companion:demoted:${CompanionItemSubtype}`
  /** When the user last undid the subtype's demotion: its too_noisy count starts again there (conv-1). */
  | `companion:noisy_reset:${CompanionItemSubtype}`
  | `companion:quiet_poll:${CompanionConfigurableSource}`;

export function getCompanionMeta(key: CompanionMetaKey): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setCompanionMeta(key: CompanionMetaKey, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function deleteCompanionMeta(key: CompanionMetaKey): void {
  getDb().prepare('DELETE FROM meta WHERE key = ?').run(key);
}

/** A stored whole number (cursors, times); null when unset or not a number. */
export function getCompanionMetaNumber(key: CompanionMetaKey): number | null {
  const value = getCompanionMeta(key);
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function setCompanionMetaNumber(key: CompanionMetaKey, value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be a whole number`);
  setCompanionMeta(key, String(value));
}

// ── The first welcome (R2.6) ────────────────────────────────────────────────

/**
 * When the first welcome turn started; null before it. Until then no model
 * turn runs and no notice goes out. A stored value that is not a time still
 * counts as done (at 0).
 */
export function companionWelcomeDoneAt(): number | null {
  const value = getCompanionMeta('companion:welcome_done');
  if (value === null) return null;
  const at = Number(value);
  return Number.isSafeInteger(at) && at > 0 ? at : 0;
}

export function isCompanionWelcomeDone(): boolean {
  return getCompanionMeta('companion:welcome_done') !== null;
}

export function markCompanionWelcomeDone(now: number): void {
  setCompanionMetaNumber('companion:welcome_done', requireTime(now, 'now'));
}

/** The welcome never got going (its turn failed before it said anything): the next open of the chat asks again. */
export function clearCompanionWelcomeDone(): void {
  deleteCompanionMeta('companion:welcome_done');
}

/** When the v2 merge ran (E's migrateAssistantV2 writes it); the welcome counts only the user's messages after it. */
const V2_MERGED_AT_KEY = 'assistant:v2_merged_at';

function v2MergedAt(): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(V2_MERGED_AT_KEY) as { value: string } | undefined;
  const at = row ? Number(row.value) : NaN;
  return Number.isSafeInteger(at) ? at : 0;
}

/**
 * The user wrote in the conversation `nodeId` since the v2 merge: their own
 * messages only (posted check-ins and first-run narration are the
 * assistant's). They have met the agent then (DESIGN-v2 §3.8).
 */
export function userWroteInConversation(nodeId: string | null, since: number = v2MergedAt()): boolean {
  if (!nodeId) return false;
  return getDb().prepare("SELECT 1 FROM messages WHERE node_id = ? AND role = 'user' AND created_at >= ? LIMIT 1").get(nodeId, since) !== undefined;
}

/**
 * snapshot.welcome (DESIGN-v2 §3.8): `wanted` while no welcome happened and
 * the user has written nothing in the conversation since the v2 merge.
 */
export function companionWelcomeState(nodeId: string | null): { wanted: boolean } {
  return { wanted: !isCompanionWelcomeDone() && !userWroteInConversation(nodeId) };
}

// ── Notes (R2.9) ────────────────────────────────────────────────────────────

/** The Companion's notes to itself, the revision they are at (every write bumps it), and who last wrote them. */
export interface CompanionNotesState {
  notes: string;
  notesRevision: number;
  /** CompanionTextOrigin: only `user` notes go into the conversation's [COMPANION CONTEXT] (§2.8 T1). */
  origin: CompanionTextOrigin;
}

export function getCompanionNotes(): string {
  return getCompanionMeta('companion:notes') ?? '';
}

export function getCompanionNotesRevision(): number {
  return getCompanionMetaNumber('companion:notes_revision') ?? 0;
}

export function getCompanionNotesState(): CompanionNotesState {
  return { notes: getCompanionNotes(), notesRevision: getCompanionNotesRevision(), origin: textOriginOf(getCompanionMeta('companion:notes_origin')) };
}

/**
 * Who wrote the notes, without touching them: the v2 migration records the
 * MVP's as `checkin` (W2-E migrateAssistantV2, DESIGN-v2 §7 step 5).
 */
export function setCompanionNotesOrigin(origin: CompanionTextOrigin): void {
  setCompanionMeta('companion:notes_origin', parseTextOrigin(origin));
}

/** Notes as stored: line breaks kept (CRLF folded), trimmed, at most COMPANION_LIMITS.maxNotesChars. */
function parseNotes(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('notes must be text');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > COMPANION_LIMITS.maxNotesChars) throw invalidRequest(`Notes are at most ${COMPANION_LIMITS.maxNotesChars} characters`);
  return text;
}

function writeNotes(text: string, origin: CompanionTextOrigin): CompanionNotesState {
  if (text) setCompanionMeta('companion:notes', text);
  else deleteCompanionMeta('companion:notes');
  const notesRevision = getCompanionNotesRevision() + 1;
  setCompanionMetaNumber('companion:notes_revision', notesRevision);
  setCompanionMeta('companion:notes_origin', origin);
  return { notes: text, notesRevision, origin };
}

/**
 * The user's edit (Settings): replaces the notes whatever revision they are
 * at; empty clears them. Saving them unchanged is the "Keep" that makes a
 * check-in's notes the user's (CompanionTextOrigin), so it always writes.
 */
export function setNotesByUser(notes: unknown): CompanionNotesState {
  const text = parseNotes(notes);
  return companionTransaction(() => writeNotes(text, 'user'));
}

/**
 * companion_save_notes: replaces the notes only when they are still at the
 * revision the Companion read; otherwise 409 notes_conflict ("notes changed;
 * read them again"), so it never overwrites the user's edit. `origin`: the
 * turn's (W2-G1b: `checkin` for a check-in or a tainted turn, `user` for a
 * clean user turn); absent, `checkin`, which keeps the text out of the
 * conversation's context (§2.8 T1).
 */
export function setNotesByCompanion(notes: unknown, expectedRevision: unknown, origin: CompanionTextOrigin = 'checkin'): CompanionNotesState {
  const text = parseNotes(notes);
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw invalidRequest('expectedRevision must be the notes revision you read');
  }
  const writer = parseTextOrigin(origin);
  return companionTransaction(() => {
    if (getCompanionNotesRevision() !== expectedRevision) throw notesConflict();
    return writeNotes(text, writer);
  });
}

// ── The user's rules (R2.9) ─────────────────────────────────────────────────

/** A read of the user's rules; a failed one must stop every model turn (fail closed). */
export type CompanionRulesRead = { ok: true; rules: string } | { ok: false; error: string };

/** The rules as the user wrote them (Settings, or an applied rules.update card): kept as written, at most COMPANION_LIMITS.maxRulesChars. */
export function parseCompanionRules(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('rules must be text');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > COMPANION_LIMITS.maxRulesChars) throw invalidRequest(`Rules are at most ${COMPANION_LIMITS.maxRulesChars} characters`);
  return text;
}

/** The user's rules, or why they could not be read (a database error, or a stored value no write path could have made). */
export function readCompanionRules(): CompanionRulesRead {
  try {
    const stored = getCompanionMeta('companion:rules');
    if (stored === null) return { ok: true, rules: '' };
    if (stored.length > COMPANION_LIMITS.maxRulesChars) return { ok: false, error: 'The stored rules are longer than rules can be' };
    return { ok: true, rules: stored };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The rules to show; empty when they cannot be read (turns must use readCompanionRules and stop instead). */
export function getCompanionRules(): string {
  const read = readCompanionRules();
  return read.ok ? read.rules : '';
}

/** Replaces the user's rules; empty clears them. Only the user's REST and an applied rules.update card call this. */
export function setCompanionRules(value: unknown): string {
  const text = parseCompanionRules(value);
  if (text) setCompanionMeta('companion:rules', text);
  else deleteCompanionMeta('companion:rules');
  return text;
}

// ── Demoted subtypes (R2.7) ─────────────────────────────────────────────────

const demotedKey = (subtype: CompanionItemSubtype) => `companion:demoted:${subtype}` as const;
const noisyResetKey = (subtype: CompanionItemSubtype) => `companion:noisy_reset:${subtype}` as const;

/** The user's feedback demoted this subtype to digest; true when it was not demoted yet. */
export function demoteSubtype(subtype: CompanionItemSubtype, now: number): boolean {
  if (!isCompanionItemSubtype(subtype)) throw invalidRequest('unknown item subtype');
  const inserted = getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(demotedKey(subtype), String(requireTime(now, 'now')));
  return Number(inserted.changes) > 0;
}

/**
 * Undoes a demotion (Settings); true when there was one. The subtype's
 * too_noisy count starts again from now (conv-1), so one more thumb does not
 * demote it again at once.
 */
export function clearSubtypeDemotion(subtype: CompanionItemSubtype, now: number = Date.now()): boolean {
  if (!isCompanionItemSubtype(subtype)) throw invalidRequest('unknown item subtype');
  return companionTransaction(() => {
    const cleared = Number(getDb().prepare('DELETE FROM meta WHERE key = ?').run(demotedKey(subtype)).changes) > 0;
    if (cleared) setCompanionMetaNumber(noisyResetKey(subtype), Math.floor(requireTime(now, 'now')));
    return cleared;
  });
}

/** Whether the delivery policy treats this subtype's `now` items as digest. */
export function isSubtypeDemoted(subtype: CompanionItemSubtype): boolean {
  return getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(demotedKey(subtype)) !== undefined;
}

/** Every demoted subtype, in subtype order. */
export function listDemotedSubtypes(): CompanionItemSubtype[] {
  const rows = getDb().prepare(`SELECT key FROM meta WHERE key LIKE 'companion:demoted:%'`).all() as Array<{ key: string }>;
  const demoted = new Set(rows.map((row) => row.key.slice('companion:demoted:'.length)));
  return COMPANION_ITEM_SUBTYPES.filter((subtype) => demoted.has(subtype));
}

// ── Brief focus ─────────────────────────────────────────────────────────────

/** What the user asked the next brief to focus on ("Tomorrow, focus on…"). */
export function getBriefCurate(): string {
  return getCompanionMeta('companion:brief_curate') ?? '';
}

export function setBriefCurate(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('text must be text');
  const text = oneLine(value);
  if (text.length > COMPANION_BRIEF_CURATE_MAX_CHARS) throw invalidRequest(`text is at most ${COMPANION_BRIEF_CURATE_MAX_CHARS} characters`);
  if (text) setCompanionMeta('companion:brief_curate', text);
  else deleteCompanionMeta('companion:brief_curate');
  return text;
}

// ── Viewing and catch-up (R2.8, R2.12) ──────────────────────────────────────

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The deterministic "Since you left" (R2.8): the items still open that were
 * created, changed or reopened after `awaySince` (never baseline sightings),
 * newest first, and one line saying how many and how many need the user.
 */
export function buildCatchUp(awaySince: number, returnedAt: number): CompanionCatchUpDto {
  const hidden = hiddenItemsSql();
  const rows = getDb().prepare(`SELECT * FROM companion_items i WHERE i.owner_user_id = ? AND ${OPEN_SQL} ${hidden.sql}
      AND EXISTS (SELECT 1 FROM companion_events e WHERE e.owner_user_id = i.owner_user_id AND e.item_id = i.id
        AND e.kind IN ('created','changed','reopened') AND e.created_at > ? AND e.created_at <= ?)
      ORDER BY i.changed_at DESC, i.id DESC LIMIT ?`).all(OWNER, returnedAt, ...hidden.args, awaySince, returnedAt, CATCH_UP_ITEM_LIMIT) as unknown as ItemRow[];
  const needsYou = rows.filter((row) => row.bucket === 'needs_you').length;
  const line = rows.length === 0 ? `Nothing new since ${localClockText(awaySince)}.`
    : needsYou === rows.length ? `${plural(needsYou, 'thing needs', 'things need')} you.`
      : `${plural(rows.length, 'update', 'updates')}${needsYou ? `, ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : ''}.`;
  return { awaySince, returnedAt, changedItemIds: rows.map((row) => row.id), line };
}

export interface CompanionViewResult {
  /** When the user last looked before now; null the first time. */
  previousViewedAt: number | null;
  /** A "Since you left" when they were away at least COMPANION_LIMITS.catchUpAfterMinutes. */
  catchUp: CompanionCatchUpDto | null;
  /** Companion messages were unread until now (the badge changes). */
  hadUnread: boolean;
}

/**
 * The user opened (or focused) the Companion panel: from now on its messages
 * are read, and after an absence of COMPANION_LIMITS.catchUpAfterMinutes the
 * "Since you left" is built and kept for the snapshot (latestCatchUp).
 */
export function recordCompanionView(now: number): CompanionViewResult {
  requireTime(now, 'now');
  return companionTransaction(() => {
    const previousViewedAt = getCompanionMetaNumber('companion:last_viewed_at');
    const hadUnread = countUnreadMessages() > 0;
    setCompanionMetaNumber('companion:last_viewed_at', Math.floor(now));
    let catchUp: CompanionCatchUpDto | null = null;
    if (previousViewedAt !== null && now - previousViewedAt >= COMPANION_LIMITS.catchUpAfterMinutes * MINUTE_MS) {
      catchUp = buildCatchUp(previousViewedAt, now);
      setCompanionMeta('companion:catch_up', JSON.stringify(catchUp));
    }
    return { previousViewedAt, catchUp, hadUnread };
  });
}

/** The latest "Since you left", while it is recent (built within COMPANION_LIMITS.catchUpAfterMinutes); null otherwise. */
export function latestCatchUp(now: number): CompanionCatchUpDto | null {
  const stored = parseJson(getCompanionMeta('companion:catch_up'));
  if (!isRecord(stored) || typeof stored.awaySince !== 'number' || typeof stored.returnedAt !== 'number'
    || typeof stored.line !== 'string' || !Array.isArray(stored.changedItemIds)) return null;
  if (now - stored.returnedAt >= COMPANION_LIMITS.catchUpAfterMinutes * MINUTE_MS || stored.returnedAt > now) return null;
  return {
    awaySince: stored.awaySince,
    returnedAt: stored.returnedAt,
    changedItemIds: stored.changedItemIds.filter((id): id is string => typeof id === 'string'),
    line: stored.line,
  };
}

// ── Privacy retention (R2.10) ───────────────────────────────────────────────

export interface CompanionPurgeResult {
  /** Email and calendar items reduced to key and version. */
  items: number;
  /** Event summaries trimmed (old ones, and those of the items above). */
  events: number;
  notices: number;
  runs: number;
  cards: number;
  briefs: number;
  reminders: number;
  /** Email and calendar snapshots not seen for privacyTtlDays. */
  snapshots: number;
}

/** What a purged email or calendar item shows instead of its subject. */
const PURGED_TITLES: Partial<Record<CompanionSourceKind, string>> = { email: 'Email thread', calendar: 'Calendar event' };

/**
 * Every retention rule of R2.10, at `now` (the coordinator runs it daily):
 * email and calendar items resolved or dismissed at least privacyTtlDays ago
 * keep only their key and version (title, summary, facts, target and their
 * events' summaries go), and so do those nobody looked at for that long
 * (A3): muted ones (a mute never resolves) and every one of a source that is
 * off (all of them while the Companion is off). Their status, prior status
 * and feedback stay, so a mute holds, and the words come back with the
 * object if it is seen again (upsertItem). Email and calendar snapshots not
 * seen for that long go too (a polled source refreshes its own every poll).
 * Event summaries older than 30 days are trimmed; notices acknowledged (or
 * expired) 7 days ago are deleted; finished runs older than 30 days are
 * deleted, except check-ins whose native record is not known to be gone
 * (still to be discarded, or kept by its runtime: their detail and their
 * receipt's changes go, a kept one keeps the note that says so), and so are
 * the Today and goal changes of the runs
 * that went (older reasons are trimmed). Decided cards, briefs and closed
 * reminders follow the runs' 30 days.
 */
export function purgeExpired(now: number): CompanionPurgeResult {
  requireTime(now, 'now');
  const privacyCutoff = now - COMPANION_PRIVACY_TTL_MS;
  const recordCutoff = now - COMPANION_RECORD_RETENTION_MS;
  const noticeCutoff = now - COMPANION_NOTICE_RETENTION_MS;
  const settings = getCompanionSettings();
  const unwatched = (['email', 'calendar'] as const).filter((kind) => !settings.enabled || !settings.sources[kind].enabled);
  return companionTransaction(() => {
    const db = getDb();
    const stale = db.prepare(`SELECT id, source FROM companion_items WHERE owner_user_id = ? AND source IN ('email','calendar')
        AND ((status IN ('resolved','dismissed') AND (CASE WHEN status = 'resolved' THEN resolved_at ELSE updated_at END) <= ?)
          OR (status = 'muted' AND observed_at <= ?)
          ${unwatched.length > 0 ? `OR (source IN (${placeholders(unwatched.length)}) AND observed_at <= ?)` : ''})
        AND (summary IS NOT NULL OR facts_json <> '{}' OR target_json IS NOT NULL OR title NOT IN ('Email thread','Calendar event'))`)
      .all(OWNER, privacyCutoff, privacyCutoff, ...(unwatched.length > 0 ? [...unwatched, privacyCutoff] : [])) as Array<{ id: string; source: CompanionSourceKind }>;
    const forget = db.prepare(`UPDATE companion_items SET title = ?, summary = NULL, facts_json = '{}', target_json = NULL WHERE id = ?`);
    const silence = db.prepare('UPDATE companion_events SET summary = NULL WHERE owner_user_id = ? AND item_id = ? AND summary IS NOT NULL');
    let events = 0;
    for (const item of stale) {
      forget.run(PURGED_TITLES[item.source] ?? 'Item', item.id);
      events += Number(silence.run(OWNER, item.id).changes);
    }
    events += Number(db.prepare('UPDATE companion_events SET summary = NULL WHERE owner_user_id = ? AND created_at <= ? AND summary IS NOT NULL')
      .run(OWNER, recordCutoff).changes);
    const notices = Number(db.prepare(`DELETE FROM companion_notices WHERE owner_user_id = ?
        AND ((delivered_at IS NOT NULL AND delivered_at <= ?) OR expires_at <= ?)`).run(OWNER, noticeCutoff, noticeCutoff).changes);
    // A check-in whose native record may still be on disk keeps its row (boot cleanup retries from it), not its text or its
    // receipt's titles; one whose runtime keeps it (D11) keeps its row too, with only the note that says so.
    db.prepare(`UPDATE companion_runs SET changes_json = NULL, detail = CASE WHEN native_kept_at IS NOT NULL THEN ? ELSE NULL END
        WHERE owner_user_id = ? AND ${NATIVE_RECORD_KEPT_SQL} AND outcome <> 'running' AND started_at <= ?`)
      .run(COMPANION_NATIVE_KEPT_NOTE, OWNER, recordCutoff);
    const runs = Number(db.prepare(`DELETE FROM companion_runs WHERE owner_user_id = ? AND outcome <> 'running' AND started_at <= ?
        AND NOT ${NATIVE_RECORD_KEPT_SQL}`).run(OWNER, recordCutoff).changes);
    db.prepare(`UPDATE companion_run_changes SET reason = NULL WHERE owner_user_id = ? AND created_at <= ? AND reason IS NOT NULL`).run(OWNER, recordCutoff);
    dropOrphanRunChanges();
    const cards = Number(db.prepare(`DELETE FROM companion_cards WHERE owner_user_id = ? AND status <> 'pending' AND COALESCE(decided_at, created_at) <= ?`)
      .run(OWNER, recordCutoff).changes);
    const briefs = Number(db.prepare('DELETE FROM companion_briefs WHERE owner_user_id = ? AND created_at <= ?').run(OWNER, recordCutoff).changes);
    const reminders = Number(db.prepare(`DELETE FROM companion_reminders WHERE owner_user_id = ? AND status IN ('fired','cancelled')
        AND COALESCE(fired_at, created_at) <= ?`).run(OWNER, recordCutoff).changes);
    const snapshots = Number(db.prepare(`DELETE FROM companion_snapshots WHERE owner_user_id = ? AND source IN ('email','calendar')
        AND last_seen_at <= ?`).run(OWNER, privacyCutoff).changes);
    return { items: stale.length, events, notices, runs, cards, briefs, reminders, snapshots };
  });
}

/** What a tool's output in the Companion's conversations reads once it is privacyTtlDays old (purgeCompanionToolOutputs). */
export const COMPANION_PURGED_TOOL_OUTPUT = `[Removed: the Companion keeps what its tools read for ${COMPANION_LIMITS.privacyTtlDays} days]`;

/** A message's tool_calls JSON with every output replaced; null when nothing in it needs replacing (or it is not a list). */
function withoutToolOutputs(raw: string): string | null {
  const calls = parseJson(raw);
  if (!Array.isArray(calls)) return null;
  let replaced = false;
  const next = calls.map((call) => {
    if (!isRecord(call) || call.output === undefined || call.output === null || call.output === '' || call.output === COMPANION_PURGED_TOOL_OUTPUT) return call;
    replaced = true;
    return { ...call, output: COMPANION_PURGED_TOOL_OUTPUT };
  });
  return replaced ? JSON.stringify(next) : null;
}

/**
 * Michi's own copy of what the Companion's tools returned (R2.10, B18): the
 * tool calls of its conversations' messages, hidden turns included, keep each
 * tool's output in messages.tool_calls (mail previews, meeting titles, CR
 * comments). Once a message is privacyTtlDays old, every output in it becomes
 * COMPANION_PURGED_TOOL_OUTPUT; the rest of the row stays (the text, each
 * call's tool, status and input), so the conversation still reads as it did.
 * Every conversation of an assistant workspace counts (`settings.system =
 * 'assistant'`, assistant/store.ts): V, current and archived (New
 * conversation, the v2 merge), the MVP's conversation and the check-in
 * nodes. The runtimes' own transcripts of these turns are theirs, not
 * Michi's, and are not touched. Returns how many messages changed.
 */
export function purgeCompanionToolOutputs(now: number): number {
  const cutoff = requireTime(now, 'now') - COMPANION_PRIVACY_TTL_MS;
  return companionTransaction(() => {
    const db = getDb();
    const rows = db.prepare(`SELECT id, tool_calls FROM messages
        WHERE node_id IN (
            SELECT n.id FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
             WHERE (CASE WHEN json_valid(w.settings) THEN json_extract(w.settings, '$.system') END) = ?)
          AND tool_calls IS NOT NULL AND created_at <= ?`)
      .all(ASSISTANT_WORKSPACE_SYSTEM, cutoff) as Array<{ id: string; tool_calls: string }>;
    const update = db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?');
    let changed = 0;
    for (const row of rows) {
      const scrubbed = withoutToolOutputs(row.tool_calls);
      if (scrubbed === null) continue;
      update.run(scrubbed, row.id);
      changed += 1;
    }
    return changed;
  });
}

// ── Revision ────────────────────────────────────────────────────────────────

/** The snapshot revision: bumps on every change, kept across restarts so it never goes back. */
export function currentRevision(): number {
  return getCompanionMetaNumber('companion:revision') ?? 0;
}

export function bumpRevision(): number {
  const row = getDb().prepare(`INSERT INTO meta (key, value) VALUES ('companion:revision', '1')
      ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value`).get() as { value: string };
  return Number(row.value);
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface CompanionStatusInput {
  settings: CompanionSettings;
  now: number;
  /** A model turn runs in the Companion's conversation. */
  working: boolean;
  /** What the coordinator knows about each source; unknown fields default (disabled or pending). */
  sources?: Partial<Record<CompanionConfigurableSource, Partial<Omit<CompanionSourceStatus, 'kind'>>>>;
  auth?: CompanionStatusDto['auth'];
}

const UNKNOWN_AUTH: CompanionStatusDto['auth'] = Object.freeze({ valid: null, expiresAt: null, checkedAt: null });

/**
 * A status from settings and storage alone, for when no coordinator reports
 * a live one (and the one the coordinator's live view is built with): state
 * from enabled/paused/quiet hours (degraded when a given source failed or
 * Auth expired), last check and today's budgeted turns from the runs, the
 * next heartbeat from the last one, the next brief by the engine's own rule
 * (briefSchedule.ts). With every source behind the Auth check off, the
 * session is nobody's business: Auth reads as unknown (B2), as its item is
 * out of sight then.
 */
export function defaultCompanionStatus(input: CompanionStatusInput): CompanionStatusDto {
  const { settings, now } = input;
  const active = settings.enabled && !settings.paused;
  const needsAuth = AUTH_SOURCES.some((kind) => settings.sources[kind].enabled);
  const auth = needsAuth ? input.auth ?? { ...UNKNOWN_AUTH } : { ...UNKNOWN_AUTH };
  const sources: CompanionSourceStatus[] = COMPANION_CONFIGURABLE_SOURCES.map((kind) => {
    const known = input.sources?.[kind] ?? {};
    const enabled = settings.sources[kind].enabled;
    return {
      kind,
      state: enabled ? known.state ?? 'pending' : 'disabled',
      lastPolledAt: known.lastPolledAt ?? null,
      nextPollAt: enabled && active ? known.nextPollAt ?? null : null,
      detail: known.detail ?? null,
    };
  });
  const failing = auth.valid === false || sources.some((source) => source.state === 'error' || source.state === 'unavailable');
  const state: CompanionStatusDto['state'] = !settings.enabled ? 'off'
    : settings.paused ? 'paused'
      : isInQuietHours(settings, now) ? 'quiet_hours'
        : failing ? 'degraded' : 'ok';
  const nextPolls = sources.map((source) => source.nextPollAt).filter((at): at is number => at !== null);
  const lastHeartbeatAt = getCompanionMetaNumber('companion:last_heartbeat_at');
  const today = localDateKey(now);
  // A poll that ran fine and changed nothing records no run (coordinator.ts keeps only failures, changes and
  // baselines, or each source's latest quiet look), so the live engine's last good poll of each source counts too.
  const checks = [latestFinishedRun('poll')?.finishedAt ?? null,
    ...sources.map((source) => (source.state === 'ok' ? source.lastPolledAt : null))].filter((at): at is number => at !== null);
  return {
    state,
    auth,
    sources,
    lastCheckAt: checks.length > 0 ? Math.max(...checks) : null,
    nextCheckAt: nextPolls.length > 0 ? Math.min(...nextPolls) : null,
    nextHeartbeatAt: active && settings.heartbeat.enabled && lastHeartbeatAt !== null
      ? lastHeartbeatAt + settings.heartbeat.intervalMinutes * 60_000 : null,
    nextBriefAt: nextCompanionBriefAt({ settings, now, welcomeAt: companionWelcomeDoneAt(), briefToday: briefForDate(today) !== null }),
    turnsToday: countTurnsSince(localDayStart(now)),
    working: input.working,
  };
}

export interface CompanionSnapshotOptions {
  now: number;
  /** The conversation V the agent answers in and posts into (DESIGN-v2 §0.2); null when it cannot be had. */
  conversation: CompanionConversationDto | null;
  /** The live status; built with defaultCompanionStatus when absent. */
  status?: CompanionStatusDto;
  /** For the built status: a model turn runs. */
  working?: boolean;
  /** The live "Since you left"; the latest stored one (latestCatchUp) when undefined. */
  catchUp?: CompanionCatchUpDto | null;
}

/** Everything the Companion window shows (GET /api/companion). */
export function snapshotDto(options: CompanionSnapshotOptions): CompanionSnapshotDto {
  const { now } = options;
  // Read first: a change after this bumps past it, so the client refetches.
  const revision = currentRevision();
  const settings = getCompanionSettings();
  const notes = getCompanionNotesState();
  return {
    settings,
    status: options.status ?? defaultCompanionStatus({ settings, now, working: options.working ?? false }),
    conversation: options.conversation,
    items: listOpenItems(now, { limit: SNAPSHOT_ITEM_LIMIT }),
    brief: briefForDate(localDateKey(now)),
    cards: listPendingCards(now).map(cardDto),
    goals: listGoals(),
    notes: notes.notes,
    notesRevision: notes.notesRevision,
    rules: getCompanionRules(),
    reminders: listReminders().map(reminderDto),
    demotedSubtypes: listDemotedSubtypes(),
    catchUp: options.catchUp !== undefined ? options.catchUp : latestCatchUp(now),
    activity: listRuns(ACTIVITY_LIMIT).map(runDto),
    counts: { ...countOpenItems(now), unreadMessages: countUnreadMessages() },
    revision,
    welcome: companionWelcomeState(options.conversation?.nodeId ?? null),
    delegations: listFollowedDelegations(),
    notesOrigin: notes.origin,
    checkinChanges: listCheckinChanges(),
  };
}
