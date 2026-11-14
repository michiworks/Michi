import {
  COMPANION_BUCKETS,
  COMPANION_CHECKIN_KINDS,
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_HEARTBEAT_MINUTES,
  COMPANION_SOURCE_KINDS,
  DEFAULT_COMPANION_SETTINGS,
  companionDelegationPath,
  companionRunUndoPath,
  isCompanionChangedEvent,
  isReasoningLevel,
  parseCompanionPostMetadata,
  type CompanionCheckinChangeDto,
  type CompanionDelegationDto,
  type CompanionDelegationPatch,
  type CompanionPostChange,
  type CompanionPostChangeAction,
  type CompanionRunUndoResult,
  type CompanionTextOrigin,
  type CompanionBriefCard,
  type CompanionBriefDto,
  type CompanionCardDto,
  type CompanionCatchUpDto,
  type CompanionChangedEvent,
  type CompanionConfigurableSource,
  type CompanionFeedback,
  type CompanionGetStartedDto,
  type CompanionGetStartedInput,
  type CompanionGoalDto,
  type CompanionHeadlineDto,
  type CompanionHeartbeatMinutes,
  type CompanionItemAction,
  type CompanionItemDto,
  type CompanionItemSubtype,
  type CompanionPresenceInput,
  type CompanionReminderDto,
  type CompanionRunDto,
  type CompanionSettings,
  type CompanionSnapshotDto,
  type CompanionSourceStatus,
  type CompanionStatusDto,
  type CompanionTarget,
} from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import { isAssistantInfo, type AssistantInfo } from './assistant';
import { readSseStream, SseHttpError } from './sseParser';
import { fetchStream } from './streamTransport';

// The Companion on this machine's backend (backend/src/routes/companion.ts,
// DESIGN R2.17): its snapshot, item actions, cards, brief, notes, rules,
// goals, reminders, settings and the change feed. A backend without it (cloud
// mode, an older build) answers 404; an answer of another shape (the e2e mock
// answers unknown routes with `{__unmocked}`) counts the same: unavailable.

export class CompanionApiError extends Error {
  readonly status: number;
  /** invalid_request, not_found, card_expired, card_not_pending, companion_busy, not_owner, … when the backend named one. */
  readonly code: string | null;
  /** The answer was not the Companion's (a 404 on its snapshot, or the wrong shape). */
  readonly unavailable: boolean;
  /** card_expired / card_not_pending: the card as it is now. */
  readonly card: CompanionCardDto | null;
  constructor(status: number, message: string, options: { code?: string | null; unavailable?: boolean; card?: CompanionCardDto | null } = {}) {
    super(message);
    this.name = 'CompanionApiError';
    this.status = status;
    this.code = options.code ?? null;
    this.unavailable = options.unavailable ?? false;
    this.card = options.card ?? null;
  }
}

export function isCompanionUnavailable(error: unknown): boolean {
  return error instanceof CompanionApiError && error.unavailable;
}

/** The Companion's conversation, with what an embedded composer needs (null from backends that send no `assistant`). */
export interface CompanionConversation {
  workspaceId: string;
  nodeId: string;
  assistant: AssistantInfo | null;
}

/** CompanionSnapshotDto as this window keeps it: fields newer backends add are defaulted. */
export type CompanionSnapshot = Omit<CompanionSnapshotDto, 'conversation'> & { conversation: CompanionConversation | null };

type Sources = CompanionSettings['sources'];

/** PATCH /companion/settings: the backend deep-merges it over the current settings. */
export interface CompanionSettingsPatch {
  /** Michi off (Pause Michi until resumed) or, false, on (Q30). Settings no longer pause it for a while. */
  paused?: boolean;
  displayName?: string;
  sources?: { [K in keyof Sources]?: Partial<Sources[K]> };
  /** `days` replaces the list. */
  brief?: Partial<CompanionSettings['brief']>;
}

// ── shape checks ───────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const nullableNumber = (value: unknown): number | null => (isNumber(value) ? value : null);
const nullableString = (value: unknown): string | null => (isString(value) ? value : null);

const SEVERITIES = ['now', 'digest', 'silent'] as const;
const ITEM_STATUSES = ['new', 'seen', 'snoozed', 'dismissed', 'muted', 'resolved'] as const;
const FEEDBACK_REASONS = ['not_relevant', 'already_handled', 'too_early', 'too_late', 'too_noisy'] as const;
const STATES = ['off', 'paused', 'quiet_hours', 'ok', 'degraded'] as const;
const SOURCE_STATES = ['ok', 'disabled', 'unavailable', 'error', 'pending'] as const;
const CARD_STATUSES = ['pending', 'applied', 'dismissed', 'expired', 'failed'] as const;
const RUN_OUTCOMES = ['running', 'ok', 'spoke', 'quiet', 'skipped', 'error', 'preempted', 'superseded'] as const;
const TEXT_ORIGINS = ['user', 'checkin'] as const;
const CHANGE_ACTIONS = ['snooze', 'dismiss', 'restore', 'add', 'reword', 'remove'] as const;
const DELEGATION_STATES = ['following', 'closed'] as const;
const DELEGATION_ORIGINS = ['card', 'start_conversation'] as const;
const DELEGATION_CLOSED = ['took_over', 'gone', 'idle', 'age'] as const;
const REMINDER_STATUSES = ['active', 'paused', 'fired', 'cancelled'] as const;
const REMINDER_UNTIL = ['approved', 'merged', 'recovered', 'read', 'answered'] as const;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => isString(value) && (values as readonly string[]).includes(value);

/** The longest item id a target carries (electron/attentionNotifications.ts takes the same). */
const MAX_TARGET_ID_CHARS = 160;

function parseTarget(value: unknown): CompanionTarget | null {
  if (!isObject(value)) return null;
  if (value.kind === 'node' && isString(value.workspaceId) && isString(value.nodeId)) return { kind: 'node', workspaceId: value.workspaceId, nodeId: value.nodeId };
  if (value.kind === 'url' && isString(value.url)) return { kind: 'url', url: value.url };
  if (value.kind === 'companion' && (value.tab === 'chat' || value.tab === 'today')) {
    // The item to bring into view: Today only.
    const itemId = value.tab === 'today' && isString(value.itemId) && value.itemId && value.itemId.length <= MAX_TARGET_ID_CHARS ? value.itemId : null;
    return itemId ? { kind: 'companion', tab: 'today', itemId } : { kind: 'companion', tab: value.tab };
  }
  if (value.kind === 'settings') return { kind: 'settings' };
  return null;
}

function parseFacts(value: unknown): CompanionItemDto['facts'] {
  if (!isObject(value)) return {};
  const facts: CompanionItemDto['facts'] = {};
  for (const [key, fact] of Object.entries(value)) {
    if (fact === null || isString(fact) || isNumber(fact) || isBoolean(fact)) facts[key] = fact;
  }
  return facts;
}

export function parseCompanionItem(value: unknown): CompanionItemDto | null {
  if (!isObject(value)) return null;
  if (!isString(value.id) || !oneOf(COMPANION_SOURCE_KINDS, value.source) || !isString(value.subtype)
    || !oneOf(COMPANION_BUCKETS, value.bucket) || !oneOf(SEVERITIES, value.severity)
    || !isString(value.title) || !oneOf(ITEM_STATUSES, value.status) || !isNumber(value.changedAt)) return null;
  return {
    id: value.id,
    source: value.source,
    subtype: value.subtype as CompanionItemSubtype,
    bucket: value.bucket,
    severity: value.severity,
    itemKey: isString(value.itemKey) ? value.itemKey : value.id,
    version: isString(value.version) ? value.version : '',
    title: value.title,
    summary: nullableString(value.summary),
    target: parseTarget(value.target),
    facts: parseFacts(value.facts),
    status: value.status,
    snoozedUntil: nullableNumber(value.snoozedUntil),
    feedback: value.feedback === 'up' || value.feedback === 'down' ? value.feedback : null,
    feedbackReason: oneOf(FEEDBACK_REASONS, value.feedbackReason) ? value.feedbackReason : null,
    firstSeenAt: isNumber(value.firstSeenAt) ? value.firstSeenAt : value.changedAt,
    changedAt: value.changedAt,
    observedAt: isNumber(value.observedAt) ? value.observedAt : value.changedAt,
    createdAt: isNumber(value.createdAt) ? value.createdAt : value.changedAt,
    updatedAt: isNumber(value.updatedAt) ? value.updatedAt : value.changedAt,
    resolvedAt: nullableNumber(value.resolvedAt),
  };
}

const bool = (value: unknown, fallback: boolean): boolean => (isBoolean(value) ? value : fallback);
const clock = (value: unknown, fallback: string): string => (isString(value) && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback);

/** Local weekdays (0 = Sunday), de-duplicated and in week order; null unless a non-empty list of them. */
function weekdays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function parseSettings(value: unknown): CompanionSettings | null {
  if (!isObject(value) || !isBoolean(value.enabled) || !isBoolean(value.paused) || !isObject(value.sources)) return null;
  const d = DEFAULT_COMPANION_SETTINGS;
  const sources = value.sources;
  const source = (key: CompanionConfigurableSource) => (isObject(sources[key]) ? sources[key] as Record<string, unknown> : {});
  const cr = source('cr');
  const pipeline = source('pipeline');
  const heartbeat = isObject(value.heartbeat) ? value.heartbeat : {};
  const brief = isObject(value.brief) ? value.brief : {};
  const quiet = isObject(value.quietHours) ? value.quietHours : {};
  const workdays = weekdays(value.workdays) ?? [...d.workdays];
  return {
    enabled: value.enabled,
    paused: value.paused,
    pausedUntil: isNumber(value.pausedUntil) ? value.pausedUntil : null,
    displayName: isString(value.displayName) && value.displayName.trim() ? value.displayName : d.displayName,
    sources: {
      michi: { enabled: bool(source('michi').enabled, d.sources.michi.enabled) },
      cr: {
        enabled: bool(cr.enabled, d.sources.cr.enabled),
        alias: isString(cr.alias) && cr.alias.trim() ? cr.alias : null,
        includeReviews: bool(cr.includeReviews, d.sources.cr.includeReviews),
      },
      pipeline: {
        enabled: bool(pipeline.enabled, d.sources.pipeline.enabled),
        watch: Array.isArray(pipeline.watch) ? pipeline.watch.filter(isString) : [],
        includeFavorites: bool(pipeline.includeFavorites, d.sources.pipeline.includeFavorites),
      },
      email: { enabled: bool(source('email').enabled, d.sources.email.enabled) },
      calendar: { enabled: bool(source('calendar').enabled, d.sources.calendar.enabled) },
    },
    pollMinutes: isNumber(value.pollMinutes) ? value.pollMinutes : d.pollMinutes,
    heartbeat: {
      enabled: bool(heartbeat.enabled, d.heartbeat.enabled),
      intervalMinutes: (COMPANION_HEARTBEAT_MINUTES as readonly unknown[]).includes(heartbeat.intervalMinutes) ? heartbeat.intervalMinutes as CompanionHeartbeatMinutes : d.heartbeat.intervalMinutes,
    },
    brief: {
      enabled: bool(brief.enabled, d.brief.enabled),
      time: clock(brief.time, d.brief.time),
      // An older backend sends no brief days: its brief came on the workdays.
      days: weekdays(brief.days) ?? weekdays(value.workdays) ?? [...d.brief.days],
    },
    quietHours: { enabled: bool(quiet.enabled, d.quietHours.enabled), start: clock(quiet.start, d.quietHours.start), end: clock(quiet.end, d.quietHours.end) },
    workdays,
    reasoning: isReasoningLevel(value.reasoning) ? value.reasoning : null,
  };
}

function parseSourceStatus(value: unknown): CompanionSourceStatus | null {
  if (!isObject(value) || !oneOf(COMPANION_CONFIGURABLE_SOURCES, value.kind) || !oneOf(SOURCE_STATES, value.state)) return null;
  return { kind: value.kind, state: value.state, lastPolledAt: nullableNumber(value.lastPolledAt), nextPollAt: nullableNumber(value.nextPollAt), detail: nullableString(value.detail) };
}

function parseStatus(value: unknown): CompanionStatusDto | null {
  if (!isObject(value) || !oneOf(STATES, value.state)) return null;
  const auth = isObject(value.auth) ? value.auth : {};
  return {
    state: value.state,
    auth: { valid: isBoolean(auth.valid) ? auth.valid : null, expiresAt: nullableNumber(auth.expiresAt), checkedAt: nullableNumber(auth.checkedAt) },
    sources: Array.isArray(value.sources) ? value.sources.map(parseSourceStatus).filter((s): s is CompanionSourceStatus => s !== null) : [],
    lastCheckAt: nullableNumber(value.lastCheckAt),
    nextCheckAt: nullableNumber(value.nextCheckAt),
    nextHeartbeatAt: nullableNumber(value.nextHeartbeatAt),
    nextBriefAt: nullableNumber(value.nextBriefAt),
    turnsToday: isNumber(value.turnsToday) ? value.turnsToday : 0,
    working: value.working === true,
    ...(value.firstLook === true ? { firstLook: true } : {}),
  };
}

function parseBriefCard(value: unknown): CompanionBriefCard | null {
  if (!isObject(value) || !isString(value.title) || !isString(value.body)) return null;
  const action = isObject(value.action) && isString(value.action.label) && isString(value.action.prompt)
    ? { label: value.action.label, prompt: value.action.prompt } : null;
  return { title: value.title, body: value.body, itemIds: Array.isArray(value.itemIds) ? value.itemIds.filter(isString) : [], action };
}

export function parseCompanionBrief(value: unknown): CompanionBriefDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.headline) || !Array.isArray(value.cards)) return null;
  const feedback: Record<number, CompanionFeedback> = {};
  if (isObject(value.cardFeedback)) {
    for (const [index, choice] of Object.entries(value.cardFeedback)) {
      if (/^\d+$/.test(index) && (choice === 'up' || choice === 'down')) feedback[Number(index)] = choice;
    }
  }
  return {
    id: value.id,
    date: isString(value.date) ? value.date : '',
    headline: value.headline,
    cards: value.cards.map(parseBriefCard).filter((card): card is CompanionBriefCard => card !== null),
    closing: isString(value.closing) ? value.closing : '',
    origin: value.origin === 'llm' ? 'llm' : 'fallback',
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
    cardFeedback: feedback,
  };
}

export function parseCompanionCard(value: unknown): CompanionCardDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.kind) || !isString(value.summary) || !oneOf(CARD_STATUSES, value.status)) return null;
  return {
    id: value.id,
    kind: value.kind as CompanionCardDto['kind'],
    payload: isObject(value.payload) ? value.payload : {},
    summary: value.summary,
    reason: nullableString(value.reason),
    status: value.status,
    error: nullableString(value.error),
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
    decidedAt: nullableNumber(value.decidedAt),
    expiresAt: isNumber(value.expiresAt) ? value.expiresAt : 0,
  };
}

export function parseCompanionGoal(value: unknown): CompanionGoalDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.text)) return null;
  return {
    id: value.id,
    text: value.text,
    progress: nullableString(value.progress),
    progressAt: nullableNumber(value.progressAt),
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
    updatedAt: isNumber(value.updatedAt) ? value.updatedAt : 0,
    ...(oneOf(TEXT_ORIGINS, value.textOrigin) ? { textOrigin: value.textOrigin } : {}),
  };
}

export function parseCompanionReminder(value: unknown): CompanionReminderDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.text) || (value.kind !== 'time' && value.kind !== 'watch')
    || !oneOf(REMINDER_STATUSES, value.status)) return null;
  return {
    id: value.id,
    kind: value.kind,
    text: value.text,
    at: nullableNumber(value.at),
    dailyAt: isString(value.dailyAt) ? value.dailyAt : null,
    itemId: nullableString(value.itemId),
    until: oneOf(REMINDER_UNTIL, value.until) ? value.until : null,
    status: value.status,
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
    firedAt: nullableNumber(value.firedAt),
  };
}

function parseRun(value: unknown): CompanionRunDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.kind) || !oneOf(RUN_OUTCOMES, value.outcome) || !isNumber(value.startedAt)) return null;
  return {
    id: value.id,
    kind: value.kind as CompanionRunDto['kind'],
    trigger: isString(value.trigger) ? value.trigger : '',
    outcome: value.outcome,
    detail: nullableString(value.detail),
    startedAt: value.startedAt,
    finishedAt: nullableNumber(value.finishedAt),
    postedMessageId: nullableString(value.postedMessageId),
    ...(Array.isArray(value.changes) ? { changes: parseChanges(value.changes) } : {}),
    undoneAt: nullableNumber(value.undoneAt),
  };
}

/** A run's or a post's changes, entry by entry as a post's metadata reads them (a bad entry is left out). */
function parseChanges(value: unknown): CompanionPostChange[] {
  return parseCompanionPostMetadata({ runId: 'changes', kind: 'heartbeat', changes: value })?.changes ?? [];
}

function parseCheckinChange(value: unknown): CompanionCheckinChangeDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.runId) || (value.targetKind !== 'item' && value.targetKind !== 'goal')
    || !isString(value.targetId) || !oneOf(CHANGE_ACTIONS, value.action) || !isNumber(value.at)) return null;
  return {
    id: value.id,
    runId: value.runId,
    targetKind: value.targetKind,
    targetId: value.targetId,
    action: value.action as CompanionPostChangeAction,
    reason: nullableString(value.reason),
    title: nullableString(value.title),
    at: value.at,
    undoneAt: nullableNumber(value.undoneAt),
    // Only an explicit true stands: a backend without the field credits the check-in with nothing.
    standing: value.standing === true,
    snoozedUntil: nullableNumber(value.snoozedUntil),
  };
}

export function parseCompanionDelegation(value: unknown): CompanionDelegationDto | null {
  if (!isObject(value) || !isString(value.id) || !isString(value.workspaceId) || !isString(value.nodeId)
    || !oneOf(DELEGATION_STATES, value.state)) return null;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    nodeId: value.nodeId,
    title: isString(value.title) ? value.title : '',
    state: value.state,
    origin: oneOf(DELEGATION_ORIGINS, value.origin) ? value.origin : null,
    autoSend: value.autoSend === true,
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
    lastSentAt: nullableNumber(value.lastSentAt),
    lastReportedAt: nullableNumber(value.lastReportedAt),
    closedAt: nullableNumber(value.closedAt),
    closedReason: oneOf(DELEGATION_CLOSED, value.closedReason) ? value.closedReason : null,
  };
}

const GET_STARTED_STATES: ReadonlySet<unknown> = new Set(['offer', 'later', 'started']);
const nullableBoolean = (value: unknown): boolean | null => (isBoolean(value) ? value : null);

/** The Get started card (D17); null when there is none or it does not parse, undefined from an older backend. */
function parseGetStarted(value: unknown): CompanionGetStartedDto | null {
  if (!isObject(value) || !GET_STARTED_STATES.has(value.state) || !isBoolean(value.homesOn) || !isNumber(value.firstRunDays)) return null;
  return {
    state: value.state as CompanionGetStartedDto['state'],
    at: nullableNumber(value.at),
    nodeId: isString(value.nodeId) ? value.nodeId : null,
    homes: nullableBoolean(value.homes),
    watch: nullableBoolean(value.watch),
    homesOn: value.homesOn,
    firstRunDays: value.firstRunDays,
  };
}

function parseWelcome(value: unknown): CompanionSnapshot['welcome'] {
  if (!isObject(value) || !isBoolean(value.wanted)) return undefined;
  return { wanted: value.wanted };
}

function parseCompanionRunUndoResult(value: unknown): CompanionRunUndoResult | null {
  if (!isObject(value) || !Array.isArray(value.reverted) || !Array.isArray(value.conflicts)) return null;
  return {
    reverted: value.reverted.filter(isString),
    conflicts: value.conflicts.flatMap((entry) => (isObject(entry) && isString(entry.changeId) && isString(entry.message)
      ? [{ changeId: entry.changeId, message: entry.message }] : [])),
  };
}

function parseCatchUp(value: unknown): CompanionCatchUpDto | null {
  if (!isObject(value) || !isString(value.line) || !isNumber(value.awaySince)) return null;
  return {
    awaySince: value.awaySince,
    returnedAt: isNumber(value.returnedAt) ? value.returnedAt : value.awaySince,
    changedItemIds: Array.isArray(value.changedItemIds) ? value.changedItemIds.filter(isString) : [],
    line: value.line,
  };
}

function parseConversation(value: unknown): CompanionConversation | null {
  if (!isObject(value) || !isString(value.workspaceId) || !value.workspaceId || !isString(value.nodeId) || !value.nodeId) return null;
  const assistant = isAssistantInfo(value.assistant) && value.assistant.nodeId === value.nodeId ? value.assistant : null;
  return { workspaceId: value.workspaceId, nodeId: value.nodeId, assistant };
}

function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(parse).filter((entry): entry is T => entry !== null) : [];
}

/**
 * The snapshot, or null when the answer is not one (another backend's, the
 * e2e mock's `{__unmocked}`). Records that don't parse are left out; fields
 * older backends lack get their empty value.
 */
export function parseCompanionSnapshot(value: unknown): CompanionSnapshot | null {
  if (!isObject(value) || !isNumber(value.revision) || !Array.isArray(value.items) || !isObject(value.counts)) return null;
  const settings = parseSettings(value.settings);
  const status = parseStatus(value.status);
  if (!settings || !status) return null;
  const counts = value.counts;
  return {
    settings,
    status,
    conversation: parseConversation(value.conversation),
    items: list(value.items, parseCompanionItem),
    brief: parseCompanionBrief(value.brief),
    cards: list(value.cards, parseCompanionCard),
    goals: list(value.goals, parseCompanionGoal),
    notes: isString(value.notes) ? value.notes : '',
    notesRevision: isNumber(value.notesRevision) ? value.notesRevision : 0,
    rules: isString(value.rules) ? value.rules : '',
    reminders: list(value.reminders, parseCompanionReminder),
    demotedSubtypes: Array.isArray(value.demotedSubtypes) ? value.demotedSubtypes.filter(isString) as CompanionItemSubtype[] : [],
    catchUp: parseCatchUp(value.catchUp),
    activity: list(value.activity, parseRun),
    counts: {
      needsYou: isNumber(counts.needsYou) ? counts.needsYou : 0,
      newItems: isNumber(counts.newItems) ? counts.newItems : 0,
      unreadMessages: isNumber(counts.unreadMessages) ? counts.unreadMessages : 0,
    },
    revision: value.revision,
    ...(parseWelcome(value.welcome) ? { welcome: parseWelcome(value.welcome) } : {}),
    ...(Array.isArray(value.delegations) ? { delegations: list(value.delegations, parseCompanionDelegation) } : {}),
    ...(oneOf(TEXT_ORIGINS, value.notesOrigin) ? { notesOrigin: value.notesOrigin as CompanionTextOrigin } : {}),
    ...(Array.isArray(value.checkinChanges) ? { checkinChanges: list(value.checkinChanges, parseCheckinChange) } : {}),
    ...('getStarted' in value ? { getStarted: parseGetStarted(value.getStarted) } : {}),
    ...(value.offNoticeAt === null || isNumber(value.offNoticeAt) ? { offNoticeAt: value.offNoticeAt } : {}),
    ...('headline' in value ? { headline: parseHeadline(value.headline) } : {}),
  };
}

/** Michi's latest line (Q45); one that does not read as one is none. */
function parseHeadline(value: unknown): CompanionHeadlineDto | null {
  if (!isObject(value) || !isString(value.text) || !value.text.trim() || !isNumber(value.at)
    || !oneOf(COMPANION_CHECKIN_KINDS, value.kind)) return null;
  return { text: value.text, at: value.at, kind: value.kind as CompanionHeadlineDto['kind'] };
}

// ── requests ───────────────────────────────────────────────────────────────

async function request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}/companion${path}`, {
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  });
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isObject(body) && isString(body.code) ? body.code : null;
    const message = isObject(body) && isString(body.error) ? body.error : `Companion request failed (${response.status})`;
    throw new CompanionApiError(response.status, message, { code, card: isObject(body) ? parseCompanionCard(body.card) : null });
  }
  return body;
}

function unexpected(): CompanionApiError {
  return new CompanionApiError(200, 'Unexpected Companion response', { unavailable: true });
}

function snapshotOf(body: unknown): CompanionSnapshot {
  const snapshot = parseCompanionSnapshot(body);
  if (!snapshot) throw unexpected();
  return snapshot;
}

/** GET /companion. A 404 (no Companion on this backend) and a wrong shape reject as unavailable. */
export async function fetchCompanion(signal?: AbortSignal): Promise<CompanionSnapshot> {
  try {
    return snapshotOf(await request('', { signal }));
  } catch (error) {
    if (error instanceof CompanionApiError && error.status === 404) {
      throw new CompanionApiError(404, error.message, { code: error.code, unavailable: true });
    }
    throw error;
  }
}

export async function patchCompanionSettings(patch: CompanionSettingsPatch): Promise<CompanionSnapshot> {
  return snapshotOf(await request('/settings', { method: 'PATCH', body: patch }));
}

/** POST /companion/check: polls now (all sources, or these). 409 not_owner: another Michi process does the checking. */
export async function checkCompanionNow(sources?: readonly CompanionConfigurableSource[]): Promise<void> {
  await request('/check', { method: 'POST', body: sources ? { sources } : {} });
}

export async function postCompanionItemAction(id: string, action: CompanionItemAction): Promise<CompanionItemDto> {
  const item = parseCompanionItem(await request(`/items/${encodeURIComponent(id)}`, { method: 'POST', body: action }));
  if (!item) throw unexpected();
  return item;
}

export async function postCompanionItemsSeen(ids: readonly string[]): Promise<void> {
  await request('/items/seen', { method: 'POST', body: { ids } });
}

/** POST /companion/presence. Newer backends answer 204; older ones a catch-up this window ignores (POST /companion/view gives it). */
export async function postCompanionPresence(input: CompanionPresenceInput): Promise<void> {
  await request('/presence', { method: 'POST', body: input });
}

/** POST /companion/view: the panel opened or got focus. The "Since you left" summary when the user was away long enough. */
export async function postCompanionView(): Promise<CompanionCatchUpDto | null> {
  const body = await request('/view', { method: 'POST', body: {} });
  return isObject(body) ? parseCatchUp(body.catchUp) : null;
}

/** POST /companion/get-started: Get started's Start with the card's choices (D17). 409 scheduler_off: homes cannot run here. */
export async function startCompanionGetStarted(input: CompanionGetStartedInput): Promise<CompanionSnapshot> {
  return snapshotOf(await request('/get-started', { method: 'POST', body: input }));
}

/** POST /companion/off-notice: "Michi is off" was told once, or Michi was found on (Q29). */
export async function markCompanionOffNotice(): Promise<void> {
  await request('/off-notice', { method: 'POST', body: {} });
}

/** POST /companion/get-started/later: Not now. */
export async function postponeCompanionGetStarted(): Promise<CompanionSnapshot> {
  return snapshotOf(await request('/get-started/later', { method: 'POST', body: {} }));
}

async function decideCard(id: string, decision: 'apply' | 'dismiss'): Promise<CompanionCardDto> {
  const card = parseCompanionCard(await request(`/cards/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: {} }));
  if (!card) throw unexpected();
  return card;
}

/** Applies a card; a failed apply answers 200 with status `failed`. 409 card_expired / card_not_pending carry the card. */
export function applyCompanionCard(id: string): Promise<CompanionCardDto> {
  return decideCard(id, 'apply');
}

export function dismissCompanionCard(id: string): Promise<CompanionCardDto> {
  return decideCard(id, 'dismiss');
}

export async function saveCompanionNotes(notes: string): Promise<{ notes: string; notesRevision: number | null }> {
  const body = await request('/notes', { method: 'PUT', body: { notes } });
  if (!isObject(body) || !isString(body.notes)) throw unexpected();
  return { notes: body.notes, notesRevision: nullableNumber(body.notesRevision) };
}

export async function saveCompanionRules(rules: string): Promise<string> {
  const body = await request('/rules', { method: 'PUT', body: { rules } });
  if (!isObject(body) || !isString(body.rules)) throw unexpected();
  return body.rules;
}

export async function addCompanionGoal(text: string): Promise<CompanionGoalDto> {
  const goal = parseCompanionGoal(await request('/goals', { method: 'POST', body: { text } }));
  if (!goal) throw unexpected();
  return goal;
}

export async function updateCompanionGoal(id: string, text: string): Promise<CompanionGoalDto> {
  const goal = parseCompanionGoal(await request(`/goals/${encodeURIComponent(id)}`, { method: 'PATCH', body: { text } }));
  if (!goal) throw unexpected();
  return goal;
}

export async function removeCompanionGoal(id: string): Promise<void> {
  await request(`/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface CompanionReminderInput {
  text: string;
  at?: number;
  dailyAt?: string;
  itemId?: string;
  until?: CompanionReminderDto['until'];
}

export async function addCompanionReminder(input: CompanionReminderInput): Promise<CompanionReminderDto> {
  const reminder = parseCompanionReminder(await request('/reminders', { method: 'POST', body: input }));
  if (!reminder) throw unexpected();
  return reminder;
}

export async function setCompanionReminderStatus(id: string, status: 'active' | 'paused'): Promise<CompanionReminderDto> {
  const reminder = parseCompanionReminder(await request(`/reminders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }));
  if (!reminder) throw unexpected();
  return reminder;
}

export async function removeCompanionReminder(id: string): Promise<void> {
  await request(`/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Undoes the feedback demotion of one subtype (back to its own severity). */
export async function undoCompanionDemotion(subtype: CompanionItemSubtype): Promise<void> {
  await request(`/demotions/${encodeURIComponent(subtype)}`, { method: 'DELETE' });
}

/** "Tomorrow, focus on…": what the next morning brief should look at more. */
export async function curateCompanionBrief(text: string): Promise<void> {
  await request('/brief/curate', { method: 'POST', body: { text } });
}

export async function setCompanionBriefFeedback(briefId: string, index: number, feedback: CompanionFeedback | null): Promise<CompanionBriefDto> {
  const brief = parseCompanionBrief(await request(`/brief/${encodeURIComponent(briefId)}/feedback`, { method: 'POST', body: { index, feedback } }));
  if (!brief) throw unexpected();
  return brief;
}

/**
 * "Undo all" on a check-in's receipt (DESIGN-v2 §2.7): reverts what the run
 * changed, newest first, stopping at the first conflict. Safe to repeat.
 */
export async function undoCompanionRun(runId: string): Promise<CompanionRunUndoResult> {
  const result = parseCompanionRunUndoResult(await request(companionRunUndoPath(runId).slice('/companion'.length), { method: 'POST', body: {} }));
  if (!result) throw unexpected();
  return result;
}

/** Settings › <name> › Activity: follow-ups to this conversation ask before sending again (DESIGN-v2 §4, §8.1(d)). */
export async function stopCompanionDelegationAutoSend(delegationId: string): Promise<CompanionDelegationDto> {
  const body: CompanionDelegationPatch = { autoSend: false };
  const delegation = parseCompanionDelegation(await request(companionDelegationPath(delegationId).slice('/companion'.length), { method: 'PATCH', body }));
  if (!delegation) throw unexpected();
  return delegation;
}

// ── change feed ────────────────────────────────────────────────────────────

export interface CompanionEventsSubscription {
  onEvent: (event: CompanionChangedEvent) => void;
  onOpen?: () => void;
  /** The feed ended or failed; an SseHttpError carries the HTTP status. Not called after unsubscribe. */
  onDisconnect?: (error?: Error) => void;
}

/**
 * GET /api/companion/events through the shared stream transport: the current
 * revision first, then one `companion_changed` per change. Returns unsubscribe.
 */
export function subscribeCompanionEvents(options: CompanionEventsSubscription): () => void {
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    let disconnectError: Error | undefined;
    try {
      const response = await fetchStream(`${API_BASE_URL}/companion/events`, { signal: controller.signal });
      if (!response.ok) throw new SseHttpError(response.status, 'subscribeCompanionEvents failed');
      if (!response.body) throw new Error('subscribeCompanionEvents response has no body');
      if (stopped) return;
      options.onOpen?.();
      await readSseStream(response.body.getReader(), (event, data) => {
        if (event !== 'companion_changed') return;
        let json: unknown;
        try { json = JSON.parse(data); } catch { return; }
        if (isCompanionChangedEvent(json)) options.onEvent(json);
      }, { shouldStop: () => stopped });
    } catch (error) {
      if (!stopped) disconnectError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!stopped) options.onDisconnect?.(disconnectError);
    }
  })();
  return () => { stopped = true; controller.abort(); };
}
