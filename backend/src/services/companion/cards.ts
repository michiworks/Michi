import { assertPublicCompanionCard } from './publicAvailability';
/**
 * Change cards (DESIGN §7.5, R2.1, R2.9): the Companion proposes a change to
 * its goals, its settings, the user's reminders, watches or rules, or a
 * conversation to start in one of the user's workspaces, and nothing changes
 * until the user presses Apply.
 *
 * Michi validates the payload when the card is proposed and again when it
 * is applied (a goal may have gone, the watch list may be full, the workspace
 * may be archived), and writes the card's summary itself from the payload:
 * the Companion's own words are kept only as its `reason`. Applying and
 * dismissing are the user's, through REST only: no agent tool catalog may
 * ever offer them. A conversation.start card's Apply is the user's approval
 * of that conversation; the server injects how one starts
 * (setCompanionCardDeps), and without it the card fails. Its outcome reaches
 * the Companion ([CARD RESULTS]) only once the conversation started or
 * failed to, so a failure after Apply is reported like any other.
 *
 * The payload is the full change, exactly as Apply makes it (a goal's or a
 * reminder's whole text, the rules' every line, a conversation's whole
 * brief): the card the user reads before Apply shows it from the payload,
 * while the summary is Michi's one-line headline and may clip long text.
 *
 * A reminder's `at` takes a local "YYYY-MM-DD HH:MM" or a time from now
 * ("+90m"), read in this computer's zone (conv-2, clock.ts
 * parseCompanionTime), and is stored as the time it means.
 *
 * A session.send card (DESIGN-v2 §4) is a follow-up into a conversation the
 * agent started and still follows: its payload is what the user approves
 * (the exact text as delivered) and what Michi read about the target when it
 * was proposed (CompanionSessionSendCardPayload: title, workspace, the reply
 * it answers, the permission choice). At most three wait at once, each for
 * six hours. Apply re-checks everything (sessionSend.ts checkCompanionSend:
 * still followed, not taken over, the conversation not moved on, idle, not
 * waiting on the user, its choice no wider than when proposed): a target
 * still running answers 409 and leaves the card pending; any other problem
 * fails it with the reason. The card is decided before it sends, so a
 * second Apply sends nothing.
 */

import {
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_LIMITS,
  THREAD_MESSAGE_MAX_CHARS,
  isSystemWorkspaceSettings,
  parseCompanionSessionSendCardPayload,
  type CompanionCardDto,
  type CompanionCardKind,
  type CompanionConfigurableSource,
  type CompanionSessionSendCardPayload,
} from 'michi-shared';
import { getDb } from '../db';
import { getWorkspace } from '../dbRepository';
import { parseCompanionTime } from './clock';
import { CompanionError, invalidRequest, limitReached, notFound } from './errors';
import {
  COMPANION_OWNER,
  COMPANION_WATCH_UNTIL,
  addGoal,
  cardDto,
  companionTransaction,
  countOpenReminders,
  countPendingCards,
  createReminder,
  decideCard,
  failAppliedCard,
  getCard,
  getGoal,
  getItem,
  insertCard,
  listGoals,
  parseCompanionRules,
  parseGoalText,
  parseReminderInput,
  recordDelegation,
  removeGoal,
  setCompanionRules,
  updateGoal,
  type CompanionWatchUntil,
} from './repository';
import { getCompanionSettings, parsePipelineNames, patchCompanionSettings, previewCompanionSettings, type CompanionSettingsPatch } from './settings';
import {
  CompanionSendRefusal,
  checkCompanionSend,
  companionSendBody,
  companionSendTarget,
  companionTargetPermissionLine,
  deliverCompanionMessage,
} from './sessionSend';

export const COMPANION_CARD_KINDS: readonly CompanionCardKind[] = Object.freeze([
  'goal.add', 'goal.update', 'goal.remove', 'checkins.update', 'source.update', 'pipeline.watch', 'quiet_hours.update',
  'conversation.start', 'reminder.add', 'watch.add', 'rules.update', 'session.send',
]);

/** Cards waiting on the user at once. */
export const COMPANION_MAX_PENDING_CARDS = 8;
export const COMPANION_CARD_REASON_MAX_CHARS = 500;
/** A delegated conversation's title, as start_conversation clips it. */
export const COMPANION_CONVERSATION_TITLE_MAX_CHARS = 80;

/** The note every conversation.start summary carries (R2.1): its brief is the Companion's, from material it read. */
export const COMPANION_DELEGATION_NOTE = 'brief written by the Companion from collector data — review before applying';

const SOURCE_LABELS: Record<CompanionConfigurableSource, string> = {
  michi: 'Michi conversations',
  cr: 'code reviews',
  pipeline: 'pipelines',
  email: 'email',
  calendar: 'the calendar',
};

const WATCH_PHRASES: Record<CompanionWatchUntil, string> = {
  approved: 'is approved',
  merged: 'is merged',
  recovered: 'recovers',
  read: 'is read',
  answered: 'is answered',
};

type Payload = Record<string, unknown>;

/** What a card's Apply changed, as snapshot change reasons (a follow-up's `send` run is Activity). */
export type CompanionCardChange = 'goals' | 'settings' | 'reminders' | 'rules' | 'activity';

// ── Injected effects ────────────────────────────────────────────────────────

/** A conversation an applied conversation.start card started. */
export interface CompanionStartedConversation {
  workspaceId: string;
  nodeId: string;
  title: string;
}

export interface CompanionCardDeps {
  /**
   * Starts an ordinary conversation in one of the user's workspaces on the
   * user's own runtime settings and sends `text` as its first message. The
   * user's Apply is the approval. Rejects with a user-safe message.
   */
  startConversation?(input: { workspaceId: string; title: string; text: string }): Promise<CompanionStartedConversation>;
}

let cardDeps: CompanionCardDeps = {};

/** The server sets these once (server.ts); tests set fakes. Replaces what was set. */
export function setCompanionCardDeps(deps: CompanionCardDeps): void {
  cardDeps = { ...deps };
}

// ── Validation ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The payload's fields, refusing any outside `required` + `optional` and any required one missing. */
function fields(payload: unknown, required: readonly string[], optional: readonly string[] = []): Payload {
  if (!isRecord(payload)) throw invalidRequest('payload must be an object');
  const unknown = Object.keys(payload).find((key) => !required.includes(key) && !optional.includes(key));
  if (unknown !== undefined) throw invalidRequest(`payload: unknown field ${unknown}`);
  const missing = required.find((key) => payload[key] === undefined);
  if (missing !== undefined) throw invalidRequest(`payload: ${missing} is required`);
  return payload;
}

function goalId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160) throw invalidRequest('payload: goalId must be a goal id');
  if (!getGoal(value)) throw notFound('That goal no longer exists');
  return value;
}

function quoted(text: string, max = 80): string {
  const chars = Array.from(text);
  return `"${chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text}"`;
}

function everyMinutes(minutes: number): string {
  return minutes % 60 === 0 ? `every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `every ${minutes} minutes`;
}

/** The settings change a settings card means. */
function settingsPatchOf(kind: CompanionCardKind, payload: Payload): CompanionSettingsPatch {
  switch (kind) {
    case 'checkins.update': {
      const patch: CompanionSettingsPatch = {};
      if (payload.heartbeat !== undefined) patch.heartbeat = payload.heartbeat as CompanionSettingsPatch['heartbeat'];
      if (payload.brief !== undefined) patch.brief = payload.brief as CompanionSettingsPatch['brief'];
      return patch;
    }
    case 'source.update':
      return { sources: { [payload.source as CompanionConfigurableSource]: { enabled: payload.enabled as boolean } } };
    case 'pipeline.watch': {
      const remove = new Set((payload.remove as string[] | undefined) ?? []);
      const watch = getCompanionSettings().sources.pipeline.watch.filter((name) => !remove.has(name));
      for (const name of (payload.add as string[] | undefined) ?? []) if (!watch.includes(name)) watch.push(name);
      return { sources: { pipeline: { watch: parsePipelineNames(watch) } } };
    }
    case 'quiet_hours.update':
      return { quietHours: payload as CompanionSettingsPatch['quietHours'] };
    default:
      throw new Error(`${kind} is not a settings card`);
  }
}

/** A workspace a delegated conversation may start in: one of the user's own, live, not archived, not a hidden system one. */
function delegationWorkspace(value: unknown): { id: string; name: string } {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) throw invalidRequest('payload: workspaceId must be a workspace id');
  const workspace = getWorkspace(value.trim());
  if (!workspace || workspace.deleted_at != null || isSystemWorkspaceSettings(workspace.settings)) throw notFound('That workspace does not exist');
  if (workspace.archived_at != null) throw invalidRequest(`${workspace.name} is archived; it takes no new conversations`);
  return { id: workspace.id, name: workspace.name.replace(/\s+/g, ' ').trim() || 'Untitled' };
}

function delegationTitle(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('payload: title is text');
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) throw invalidRequest('payload: title cannot be empty');
  if (Array.from(title).length > COMPANION_CONVERSATION_TITLE_MAX_CHARS) {
    throw invalidRequest(`payload: title is at most ${COMPANION_CONVERSATION_TITLE_MAX_CHARS} characters`);
  }
  return title;
}

function delegationText(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest('payload: text is text');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw invalidRequest('payload: text cannot be empty');
  if (text.length > THREAD_MESSAGE_MAX_CHARS) throw invalidRequest(`payload: text is at most ${THREAD_MESSAGE_MAX_CHARS} characters`);
  return text;
}

/** A payload checked for its kind, in the form stored and applied. Throws CompanionError. */
function validatePayload(kind: CompanionCardKind, raw: unknown, now: number): Payload {
  switch (kind) {
    case 'goal.add': {
      const payload = fields(raw, ['text']);
      return { text: parseGoalText(payload.text) };
    }
    case 'goal.update': {
      const payload = fields(raw, ['goalId', 'text']);
      return { goalId: goalId(payload.goalId), text: parseGoalText(payload.text) };
    }
    case 'goal.remove': {
      const payload = fields(raw, ['goalId']);
      return { goalId: goalId(payload.goalId) };
    }
    case 'checkins.update': {
      const payload = fields(raw, [], ['heartbeat', 'brief']);
      if (payload.heartbeat === undefined && payload.brief === undefined) throw invalidRequest('payload: heartbeat or brief is required');
      const result: Payload = {};
      for (const key of ['heartbeat', 'brief'] as const) {
        if (payload[key] === undefined) continue;
        if (!isRecord(payload[key]) || Object.keys(payload[key] as object).length === 0) throw invalidRequest(`payload: ${key} must name what changes`);
        result[key] = payload[key];
      }
      previewSettings(() => settingsPatchOf(kind, result));
      return result;
    }
    case 'source.update': {
      const payload = fields(raw, ['source', 'enabled']);
      if (!COMPANION_CONFIGURABLE_SOURCES.includes(payload.source as CompanionConfigurableSource)) {
        throw invalidRequest(`payload: source must be one of: ${COMPANION_CONFIGURABLE_SOURCES.join(', ')}`);
      }
      if (typeof payload.enabled !== 'boolean') throw invalidRequest('payload: enabled must be true or false');
      return { source: payload.source, enabled: payload.enabled };
    }
    case 'pipeline.watch': {
      const payload = fields(raw, [], ['add', 'remove']);
      const add = payload.add === undefined ? [] : asPayload(() => parsePipelineNames(payload.add, 'add'));
      const remove = payload.remove === undefined ? [] : asPayload(() => parsePipelineNames(payload.remove, 'remove'));
      if (add.length === 0 && remove.length === 0) throw invalidRequest('payload: add or remove at least one pipeline');
      const result: Payload = {};
      if (add.length > 0) result.add = add;
      if (remove.length > 0) result.remove = remove;
      previewSettings(() => settingsPatchOf(kind, result));
      return result;
    }
    case 'quiet_hours.update': {
      const payload = fields(raw, ['enabled'], ['start', 'end']);
      const result: Payload = { enabled: payload.enabled };
      if (payload.start !== undefined) result.start = payload.start;
      if (payload.end !== undefined) result.end = payload.end;
      previewSettings(() => settingsPatchOf(kind, result));
      return result;
    }
    case 'conversation.start': {
      const payload = fields(raw, ['workspaceId', 'title', 'text']);
      return { workspaceId: delegationWorkspace(payload.workspaceId).id, title: delegationTitle(payload.title), text: delegationText(payload.text) };
    }
    case 'reminder.add': {
      const payload = fields(raw, ['text'], ['at', 'dailyAt', 'itemId']);
      const spec = asPayload(() => parseReminderInput({ text: payload.text, at: reminderTime(payload.at, now), dailyAt: payload.dailyAt, itemId: payload.itemId }, now));
      return {
        text: spec.text,
        ...(spec.at !== null ? { at: spec.at } : {}),
        ...(spec.dailyAt !== null ? { dailyAt: spec.dailyAt } : {}),
        ...(spec.itemId !== null ? { itemId: spec.itemId } : {}),
      };
    }
    case 'watch.add': {
      const payload = fields(raw, ['itemId', 'until']);
      if (!COMPANION_WATCH_UNTIL.includes(payload.until as CompanionWatchUntil)) {
        throw invalidRequest(`payload: until must be one of: ${COMPANION_WATCH_UNTIL.join(', ')}`);
      }
      const spec = asPayload(() => parseReminderInput({ text: watchText(payload.itemId, payload.until as CompanionWatchUntil), itemId: payload.itemId, until: payload.until }, now));
      return { itemId: spec.itemId, until: spec.until };
    }
    case 'rules.update': {
      const payload = fields(raw, ['rules']);
      return { rules: asPayload(() => parseCompanionRules(payload.rules)) };
    }
    case 'session.send':
      return sessionSendPayload(raw, now) as unknown as Payload;
    default:
      throw invalidRequest(`kind must be one of: ${COMPANION_CARD_KINDS.join(', ')}`);
  }
}

/**
 * A reminder's `at` as epoch ms (conv-2): a local "YYYY-MM-DD HH:MM", a time
 * from now ("+90m", "+3h", "+2d") or epoch ms; anything else stays as given
 * for parseReminderInput to refuse. Whether it lies ahead is that rule's.
 */
function reminderTime(value: unknown, now: number): unknown {
  if (value === undefined || value === null) return value;
  const parsed = parseCompanionTime(value, now);
  if (!parsed.ok) throw invalidRequest(`payload: at ${parsed.problem}`);
  return parsed.at;
}

/**
 * A proposed follow-up (DESIGN-v2 §4) as stored: the text as delivered and
 * what Michi reads about its target now, the reply it answers (the target's
 * latest; one given that is not the latest is refused) and its permission
 * choice. The target must be a conversation the agent follows; it may be
 * busy now, since the user applies later.
 */
function sessionSendPayload(raw: unknown, now: number): CompanionSessionSendCardPayload {
  const payload = fields(raw, ['nodeId', 'text'], ['afterMessageId']);
  if (typeof payload.nodeId !== 'string' || !payload.nodeId.trim() || payload.nodeId.trim().length > 160) {
    throw invalidRequest('payload: nodeId must be the conversation\'s node id');
  }
  const asCard = <T>(read: () => T): T => {
    try {
      return read();
    } catch (error) {
      if (error instanceof CompanionSendRefusal) throw invalidRequest(`payload: ${error.message}`);
      throw error;
    }
  };
  const text = asCard(() => companionSendBody(payload.text));
  const target = asCard(() => companionSendTarget(payload.nodeId as string, now));
  if (payload.afterMessageId !== undefined && payload.afterMessageId !== target.latestReplyId) {
    throw invalidRequest('payload: that conversation moved on since the reply you read; read it again');
  }
  if (target.permission === null) throw invalidRequest('payload: Michi could not read how that conversation runs');
  return {
    nodeId: target.node.id,
    text,
    afterMessageId: target.latestReplyId,
    workspaceId: target.workspaceId,
    title: target.title,
    permissionWhenProposed: target.permission,
  };
}

/** The settings rules' and the reminders' refusals, read as payload errors. */
function asPayload<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof CompanionError && (error.code === 'invalid_settings' || error.code === 'invalid_request')) {
      throw invalidRequest(error.message.startsWith('payload:') ? error.message : `payload: ${error.message}`);
    }
    throw error;
  }
}

/** The settings the change would leave, validated without writing. */
function previewSettings(patch: () => CompanionSettingsPatch): void {
  asPayload(() => previewCompanionSettings(patch()));
}

/** A watch's own words: what it waits for, in terms of its item (the payload has none of the Companion's). */
function watchText(itemId: unknown, until: CompanionWatchUntil): string {
  const item = typeof itemId === 'string' ? getItem(itemId) : null;
  return `When ${quoted(item?.title ?? 'the item', 120)} ${WATCH_PHRASES[until]}`;
}

function localTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What the card does, in Michi's words (never the Companion's). */
function summarize(kind: CompanionCardKind, payload: Payload): string {
  switch (kind) {
    case 'goal.add':
      return `Add a goal: ${quoted(payload.text as string)}`;
    case 'goal.update':
      return `Change the goal ${quoted(getGoal(payload.goalId as string)?.text ?? '')} to ${quoted(payload.text as string)}`;
    case 'goal.remove':
      return `Remove the goal ${quoted(getGoal(payload.goalId as string)?.text ?? '')}`;
    case 'checkins.update': {
      const parts: string[] = [];
      const heartbeat = payload.heartbeat as { enabled?: boolean; intervalMinutes?: number } | undefined;
      if (heartbeat) {
        if (heartbeat.enabled === false) parts.push('Turn off check-ins');
        else if (heartbeat.intervalMinutes !== undefined) parts.push(`Check in ${everyMinutes(heartbeat.intervalMinutes)}`);
        else parts.push('Turn on check-ins');
      }
      const brief = payload.brief as { enabled?: boolean; time?: string } | undefined;
      if (brief) {
        if (brief.enabled === false) parts.push('Turn off the morning brief');
        else if (brief.time !== undefined) parts.push(`Send the morning brief at ${brief.time}`);
        else parts.push('Turn on the morning brief');
      }
      return parts.join('; ');
    }
    case 'source.update': {
      const label = SOURCE_LABELS[payload.source as CompanionConfigurableSource];
      return payload.enabled ? `Watch ${label}` : `Stop watching ${label}`;
    }
    case 'pipeline.watch': {
      const parts: string[] = [];
      const add = (payload.add as string[] | undefined) ?? [];
      const remove = (payload.remove as string[] | undefined) ?? [];
      if (add.length > 0) parts.push(`Watch ${add.length === 1 ? 'the pipeline' : 'pipelines'} ${add.join(', ')}`);
      if (remove.length > 0) parts.push(`Stop watching ${remove.join(', ')}`);
      return parts.join('; ');
    }
    case 'quiet_hours.update': {
      if (payload.enabled === false) return 'Turn off quiet hours';
      const current = getCompanionSettings().quietHours;
      return `Quiet hours from ${(payload.start as string | undefined) ?? current.start} to ${(payload.end as string | undefined) ?? current.end}`;
    }
    case 'conversation.start': {
      const workspace = getWorkspace(payload.workspaceId as string)?.name.replace(/\s+/g, ' ').trim() || 'Untitled';
      return `Start a conversation in ${quoted(workspace, 60)}: ${quoted(payload.title as string)} (${COMPANION_DELEGATION_NOTE})`;
    }
    case 'reminder.add': {
      const when = typeof payload.at === 'number' ? `on ${localTime(payload.at)}` : `every workday at ${payload.dailyAt as string}`;
      const item = typeof payload.itemId === 'string' ? getItem(payload.itemId) : null;
      return `Remind you ${when}: ${quoted(payload.text as string)}${item ? ` (about ${quoted(item.title, 60)})` : ''}`;
    }
    case 'watch.add': {
      const item = getItem(payload.itemId as string);
      return `Tell you when ${quoted(item?.title ?? 'the item')} ${WATCH_PHRASES[payload.until as CompanionWatchUntil]}`;
    }
    case 'rules.update': {
      const rules = payload.rules as string;
      return rules ? `Replace your rules for the Companion with: ${quoted(rules.replace(/\s+/g, ' '), 120)}` : 'Clear your rules for the Companion';
    }
    case 'session.send': {
      const send = payload as unknown as CompanionSessionSendCardPayload;
      const workspace = getWorkspace(send.workspaceId)?.name.replace(/\s+/g, ' ').trim() || 'Untitled';
      return `Send a follow-up to ${quoted(send.title, 60)} in ${quoted(workspace, 40)}: ${quoted(send.text.replace(/\s+/g, ' '), 120)} `
        + `(${companionTargetPermissionLine(send.permissionWhenProposed).replace(/\.$/, '').replace(/^It /, 'it ')})`;
    }
    default:
      return kind;
  }
}

// ── Proposing ───────────────────────────────────────────────────────────────

export interface CompanionCardProposal {
  kind: unknown;
  payload: unknown;
  /** The Companion's reason, at most 500 characters. */
  reason?: unknown;
}

/** Public tool boundary: do not offer changes this build cannot carry out. */
export function proposePublicCompanionCard(proposal: CompanionCardProposal, now: number): CompanionCardDto {
  assertPublicCompanionCard(proposal.kind, proposal.payload);
  return proposeCompanionCard(proposal, now);
}

/** Validates a proposal and shows it to the user as a pending card. Throws CompanionError. */
export function proposeCompanionCard(proposal: CompanionCardProposal, now: number): CompanionCardDto {
  if (!COMPANION_CARD_KINDS.includes(proposal.kind as CompanionCardKind)) {
    throw invalidRequest(`kind must be one of: ${COMPANION_CARD_KINDS.join(', ')}`);
  }
  const kind = proposal.kind as CompanionCardKind;
  const payload = validatePayload(kind, proposal.payload, now);
  if (kind === 'goal.add' && listGoals().length >= COMPANION_LIMITS.maxGoals) {
    throw limitReached(`There are already ${COMPANION_LIMITS.maxGoals} goals; propose removing one first`);
  }
  if ((kind === 'reminder.add' || kind === 'watch.add') && countOpenReminders() >= COMPANION_LIMITS.maxReminders) {
    throw limitReached(`There are already ${COMPANION_LIMITS.maxReminders} reminders and watches; the user must remove one first`);
  }
  if (kind === 'session.send' && countPendingCards(now, 'session.send') >= COMPANION_LIMITS.maxPendingSessionSendCards) {
    throw limitReached(`${COMPANION_LIMITS.maxPendingSessionSendCards} follow-up cards already wait on the user; wait for their answers`);
  }
  let reason: string | null = null;
  if (proposal.reason !== undefined && proposal.reason !== null) {
    if (typeof proposal.reason !== 'string') throw invalidRequest('reason must be text');
    reason = proposal.reason.trim() || null;
    if (reason && reason.length > COMPANION_CARD_REASON_MAX_CHARS) throw invalidRequest(`reason is at most ${COMPANION_CARD_REASON_MAX_CHARS} characters`);
  }
  if (countPendingCards(now) >= COMPANION_MAX_PENDING_CARDS) {
    throw limitReached(`${COMPANION_MAX_PENDING_CARDS} cards already wait on the user; wait for their answers`);
  }
  return cardDto(insertCard({
    kind, payload, summary: summarize(kind, payload), reason, now,
    ...(kind === 'session.send' ? { ttlMs: COMPANION_LIMITS.sessionSendCardTtlMs } : {}),
  }));
}

// ── Deciding (the user's REST only) ─────────────────────────────────────────

/** What an Apply or Dismiss came to, and which parts of the snapshot it changed. */
export interface CompanionCardDecision {
  outcome: 'applied' | 'failed' | 'dismissed' | 'expired' | 'not_pending';
  card: CompanionCardDto;
  changed: CompanionCardChange[];
}

/** The change of every kind but conversation.start, made inside the Apply's transaction. */
function applyEffect(kind: CompanionCardKind, payload: Payload, now: number): CompanionCardChange[] {
  switch (kind) {
    case 'goal.add':
      addGoal(payload.text, now);
      return ['goals'];
    case 'goal.update':
      updateGoal(payload.goalId as string, { text: payload.text }, now);
      return ['goals'];
    case 'goal.remove':
      removeGoal(payload.goalId as string, now);
      return ['goals'];
    case 'reminder.add':
      createReminder({ text: payload.text, at: payload.at, dailyAt: payload.dailyAt, itemId: payload.itemId }, now);
      return ['reminders'];
    case 'watch.add':
      createReminder({ text: watchText(payload.itemId, payload.until as CompanionWatchUntil), itemId: payload.itemId, until: payload.until }, now);
      return ['reminders'];
    case 'rules.update':
      setCompanionRules(payload.rules);
      return ['rules'];
    case 'checkins.update':
    case 'source.update':
    case 'pipeline.watch':
    case 'quiet_hours.update':
      patchCompanionSettings(settingsPatchOf(kind, payload));
      return ['settings'];
    default:
      throw new Error(`${kind} has no immediate effect`);
  }
}

/** A card that can still be decided, else the decision that ends the request. */
function pendingCard(id: string, now: number): { kind: CompanionCardKind; payload: Payload } | CompanionCardDecision {
  const card = getCard(id);
  if (!card) throw notFound('Card not found');
  if (card.status !== 'pending') return { outcome: 'not_pending', card: cardDto(card), changed: [] };
  if (card.expiresAt <= now) {
    const expired = decideCard(id, 'expired', now) ?? getCard(id)!;
    return { outcome: 'expired', card: cardDto(expired), changed: [] };
  }
  return { kind: card.kind, payload: card.payload };
}

function failed(id: string, now: number, error: string): CompanionCardDecision {
  const card = decideCard(id, 'failed', now, error) ?? failAppliedCard(id, now, error) ?? getCard(id)!;
  return { outcome: 'failed', card: cardDto(card), changed: [] };
}

// ── A conversation that is starting, a follow-up going out ──────────────────
// From its Apply until its conversation started or failed to, a
// conversation.start card is applied (a second Apply, a Dismiss and expiry
// leave it alone) but held out of [CARD RESULTS]: a Companion turn that runs
// meanwhile (the user writes "thanks", a heartbeat comes due) must not be
// told "applied" about a conversation that may still fail, since a card it
// was told about is never reported again. The hold is reported_at =
// START_HOLD, a value listUnreportedCards and markCardsReported skip like any
// reported card; lifting it puts the card's final outcome in the next turn.
// A session.send card is held the same way while its follow-up goes out.

const START_HOLD = -1;
/** Longer than any start takes; a hold older than this was left by a Michi that stopped mid-start. */
const START_HOLD_MAX_MS = 10 * 60_000;
export const COMPANION_ABANDONED_START_ERROR = 'Michi stopped before this conversation finished starting, so it may not have started: look in the workspace before starting it again';
export const COMPANION_ABANDONED_SEND_ERROR = 'Michi stopped while this follow-up went out, so it may not have been sent: look in the conversation before sending it again';
/** Cards whose conversation this process is starting right now. */
const startingHere = new Set<string>();

function holdCardReport(id: string): void {
  getDb().prepare('UPDATE companion_cards SET reported_at = ? WHERE owner_user_id = ? AND id = ? AND reported_at IS NULL')
    .run(START_HOLD, COMPANION_OWNER, id);
}

function releaseCardReport(id: string): void {
  getDb().prepare('UPDATE companion_cards SET reported_at = NULL WHERE owner_user_id = ? AND id = ? AND reported_at = ?')
    .run(COMPANION_OWNER, id, START_HOLD);
}

/** A held, applied session.send card whose follow-up did not go out because its target turned busy: pending again, undecided and unreported. */
function reopenHeldCard(id: string): void {
  getDb().prepare(`UPDATE companion_cards SET status = 'pending', decided_at = NULL, error = NULL, reported_at = NULL
      WHERE owner_user_id = ? AND id = ? AND status = 'applied' AND reported_at = ?`).run(COMPANION_OWNER, id, START_HOLD);
}

/**
 * Holds a stopped Michi left (it went down while a conversation started):
 * the card ends failed, saying it may not have started, and the Companion
 * hears so in its next turn. conversation.ts runs this before each hidden
 * turn reads its card results. Returns how many it settled.
 */
export function settleAbandonedStarts(now: number): number {
  const rows = getDb().prepare(`SELECT id, kind FROM companion_cards WHERE owner_user_id = ? AND kind IN ('conversation.start', 'session.send')
      AND status = 'applied' AND reported_at = ? AND decided_at <= ?`).all(COMPANION_OWNER, START_HOLD, now - START_HOLD_MAX_MS) as Array<{ id: string; kind: string }>;
  let settled = 0;
  for (const { id, kind } of rows) {
    if (startingHere.has(id)) continue;
    companionTransaction(() => {
      failAppliedCard(id, now, kind === 'session.send' ? COMPANION_ABANDONED_SEND_ERROR : COMPANION_ABANDONED_START_ERROR);
      releaseCardReport(id);
    });
    settled += 1;
  }
  return settled;
}

/**
 * A conversation.start Apply: the card is decided (so a second click finds
 * it applied and starts nothing) and held out of [CARD RESULTS] in one step,
 * then the conversation starts and is recorded as the Companion's
 * delegation; when it cannot start, the card ends failed with the reason.
 * Either way the hold is lifted only after the outcome is written, so the
 * Companion is told how it ended, never "applied" before it did.
 */
async function applyConversationStart(id: string, payload: Payload, now: number): Promise<CompanionCardDecision> {
  let request: { workspaceId: string; title: string; text: string };
  try {
    request = validatePayload('conversation.start', payload, now) as typeof request;
  } catch (error) {
    if (!(error instanceof CompanionError)) throw error;
    return failed(id, now, error.message);
  }
  const start = cardDeps.startConversation;
  if (!start) return failed(id, now, 'Starting conversations is not available on this backend');
  const decided = companionTransaction(() => {
    if (!decideCard(id, 'applied', now)) return false;
    holdCardReport(id);
    return true;
  });
  if (!decided) return { outcome: 'not_pending', card: cardDto(getCard(id)!), changed: [] };
  startingHere.add(id);
  let started: CompanionStartedConversation;
  try {
    started = await start(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return companionTransaction(() => {
      const decision = failed(id, now, message);
      releaseCardReport(id);
      return decision;
    });
  } finally {
    startingHere.delete(id);
  }
  try {
    // The agent follows it (DESIGN-v2 §4); the card, not start_conversation, is how it began.
    recordDelegation({ workspaceId: started.workspaceId, nodeId: started.nodeId, title: started.title || request.title, now, origin: 'card' });
  } finally {
    releaseCardReport(id);
  }
  return { outcome: 'applied', card: cardDto(getCard(id)!), changed: [] };
}

/**
 * A session.send Apply (DESIGN-v2 §4), the user's approval of the exact
 * text: everything is checked again first (checkCompanionSend with the
 * card's record). A target still running answers 409 `companion_busy` and
 * the card stays pending; any other problem fails the card with the reason.
 * Then the card is decided and held out of [CARD RESULTS] in one step (a
 * second Apply finds it applied and sends nothing), the follow-up goes out
 * (via `card`), and the hold is lifted once it went or failed. A target that
 * turned busy after the decision (another Apply into it went first) puts
 * the card back to pending and answers 409 too: it waits, as §4 says.
 */
async function applySessionSend(id: string, payload: Payload, now: number): Promise<CompanionCardDecision> {
  const card = parseCompanionSessionSendCardPayload(payload);
  if (!card) return failed(id, now, 'This card no longer reads as a follow-up');
  const send = { nodeId: card.nodeId, text: card.text, via: 'card' as const, cardId: id, now, afterMessageId: card.afterMessageId, notWiderThan: card.permissionWhenProposed };
  try {
    checkCompanionSend(send);
  } catch (error) {
    if (!(error instanceof CompanionSendRefusal)) throw error;
    if (error.code === 'TARGET_BUSY') throw new CompanionError(409, 'companion_busy', `${error.message} The card waits.`);
    return failed(id, now, error.message);
  }
  const decided = companionTransaction(() => {
    if (!decideCard(id, 'applied', now)) return false;
    holdCardReport(id);
    return true;
  });
  if (!decided) return { outcome: 'not_pending', card: cardDto(getCard(id)!), changed: [] };
  startingHere.add(id);
  try {
    await deliverCompanionMessage(send);
  } catch (error) {
    if (error instanceof CompanionSendRefusal && error.code === 'TARGET_BUSY') {
      companionTransaction(() => reopenHeldCard(id));
      throw new CompanionError(409, 'companion_busy', `${error.message} The card waits.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return companionTransaction(() => {
      const decision = failed(id, now, message);
      releaseCardReport(id);
      return { ...decision, changed: ['activity'] as CompanionCardChange[] };
    });
  } finally {
    startingHere.delete(id);
  }
  releaseCardReport(id);
  return { outcome: 'applied', card: cardDto(getCard(id)!), changed: ['activity'] };
}

/**
 * The user's Apply: re-validates the payload against the current goals,
 * settings, items and workspaces, makes the change and marks the card
 * applied, all or nothing. When the change no longer holds, the card is
 * marked failed with the reason.
 */
export async function applyCompanionCard(id: string, now: number): Promise<CompanionCardDecision> {
  const pending = pendingCard(id, now);
  if ('outcome' in pending) return pending;
  if (pending.kind === 'conversation.start') return applyConversationStart(id, pending.payload, now);
  if (pending.kind === 'session.send') return applySessionSend(id, pending.payload, now);
  try {
    const changed = companionTransaction(() => {
      const effect = applyEffect(pending.kind, validatePayload(pending.kind, pending.payload, now), now);
      if (!decideCard(id, 'applied', now)) throw new Error('card was decided while it was applied');
      return effect;
    });
    return { outcome: 'applied', card: cardDto(getCard(id)!), changed };
  } catch (error) {
    if (!(error instanceof CompanionError)) throw error;
    return failed(id, now, error.message);
  }
}

/** Recheck saved cards at the public HTTP boundary, including cards from an older build. */
export async function applyPublicCompanionCard(id: string, now: number): Promise<CompanionCardDecision> {
  const pending = pendingCard(id, now);
  if ('outcome' in pending) return pending;
  try {
    assertPublicCompanionCard(pending.kind, pending.payload);
  } catch (error) {
    if (!(error instanceof CompanionError)) throw error;
    return failed(id, now, error.message);
  }
  return applyCompanionCard(id, now);
}

/** The user's Dismiss. */
export function dismissCompanionCard(id: string, now: number): CompanionCardDecision {
  const pending = pendingCard(id, now);
  if ('outcome' in pending) return pending;
  const dismissed = decideCard(id, 'dismissed', now) ?? getCard(id)!;
  return { outcome: 'dismissed', card: cardDto(dismissed), changed: [] };
}
