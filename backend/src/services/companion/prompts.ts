/**
 * The agent's prompt text (DESIGN §7.3-7.4 with R2.1, R2.9,
 * R2.12, R2.13, R2.15; DESIGN-v2 §2.2, §3.4-§3.6): every model-facing
 * fragment lives in companionPrompts.json as a key with an `_about`, and
 * fill(key, vars) fills its {placeholders}, refusing a missing or an extra
 * one. A malformed template (a stray brace) fails when this module loads.
 *
 * This module also renders what goes into them:
 * - companionMainInstructions / companionCheckinInstructions: the opening
 *   instructions of the user's conversation (V, purpose main) and of a
 *   check-in's throwaway session (S, purpose checkin);
 * - composeCompanionTurn: a check-in's note from CompanionMaterial: its
 *   [Kind] label and wake.preamble, [CURRENT RUN TIME], the user's rules
 *   first, the goals, the notes, [CARD RESULTS], the cards still waiting,
 *   the sources off in settings, [RECENT CONVERSATION], the collector data
 *   fenced as untrusted (for the brief, with the last brief and the user's
 *   ratings), and the kind's own body;
 * - companionContextText: the [COMPANION CONTEXT] ahead of the user's own
 *   message (turnContext.ts), which carries only the user's own words and
 *   Michi's facts, never text a check-in wrote (§2.8 T1);
 * - companionPostReceipt: a check-in's deterministic post (§3.4);
 * - item and event lines for the notes and for the agent's tools.
 *
 * Everything that came from outside (titles, summaries, facts, previews,
 * worker replies, even rules and notes) is scrubbed first, by the one
 * scrubber the deep reads use too (sources/common.ts inertText): hidden
 * characters go, lookalikes fold, fences (`<<<`, `>>>`) and anything that
 * looks like one of Michi's own block labels are defused, and one-line
 * fields stay on one line, so material can never pose as Michi's structure.
 */

import {
  COMPANION_LIMITS,
  DEFAULT_COMPANION_NAME,
  MICHI_ASSISTANT_MARKER,
  type CompanionBriefDto,
  type CompanionBucket,
  type CompanionCardDto,
  type CompanionCheckinKind,
  type CompanionConfigurableSource,
  type CompanionGoalDto,
  type CompanionItemDto,
  type CompanionItemSubtype,
  type CompanionPostChange,
  type CompanionPostChangeAction,
  type CompanionReminderDto,
  type CompanionSourceKind,
  type CompanionTarget,
  type CompanionTextOrigin,
} from 'michi-shared';
import PROMPTS from './companionPrompts.json';
import { localClockText, localDateKey, localIsoMinuteText } from './clock';
import { inertText } from './sources/common';
import type {
  CompanionEventRecord,
  CompanionFocusEntry,
  CompanionMaterial,
  CompanionTurnKind,
  CompanionWorkerReport,
} from './types';

// ── The prompt file ─────────────────────────────────────────────────────────

/** Every fragment's key (the file's own `_about` aside). */
export type CompanionPromptKey = Exclude<keyof typeof PROMPTS, '_about'>;

type TemplatePart = string | { name: string };

interface Template {
  parts: TemplatePart[];
  /** Placeholder names, each once, in order of first use. */
  names: string[];
}

/** `{{`, `}}`, a `{placeholder}`, or a stray brace (an error). */
const TOKEN = /\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}|\{|\}/g;

function parseTemplate(key: string, text: string): Template {
  const parts: TemplatePart[] = [];
  const names: string[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    if (match[0] === '{{') parts.push('{');
    else if (match[0] === '}}') parts.push('}');
    else if (match[1]) {
      parts.push({ name: match[1] });
      if (!names.includes(match[1])) names.push(match[1]);
    } else {
      throw new Error(`companionPrompts.json ${key}: stray "${match[0]}" at ${index}; write {{ or }} for a literal brace`);
    }
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return { parts, names };
}

function loadTemplates(): Map<string, Template> {
  const templates = new Map<string, Template>();
  for (const [key, entry] of Object.entries(PROMPTS as Record<string, unknown>)) {
    if (key === '_about') continue;
    const value = entry as { _about?: unknown; text?: unknown };
    if (!value || typeof value !== 'object' || typeof value._about !== 'string' || !value._about.trim()) {
      throw new Error(`companionPrompts.json ${key}: every key needs an _about`);
    }
    const text = Array.isArray(value.text) && value.text.every((line) => typeof line === 'string') ? value.text.join('\n')
      : typeof value.text === 'string' ? value.text : null;
    if (text === null || !text.trim()) throw new Error(`companionPrompts.json ${key}: text must be a string or a list of lines`);
    templates.set(key, parseTemplate(key, text));
  }
  return templates;
}

const TEMPLATES = loadTemplates();

export type CompanionPromptVars = Readonly<Record<string, string | number>>;

/**
 * A fragment with its placeholders filled. Throws when `vars` lacks one of
 * them or names one the fragment does not use, and on a value that is not
 * text or a finite number. Values go in as they are (never re-read as a
 * template), so material cannot add placeholders.
 */
export function fill(key: CompanionPromptKey, vars: CompanionPromptVars = {}): string {
  const template = TEMPLATES.get(key);
  if (!template) throw new Error(`unknown Companion prompt: ${String(key)}`);
  const given = Object.keys(vars);
  const missing = template.names.filter((name) => !Object.prototype.hasOwnProperty.call(vars, name));
  const extra = given.filter((name) => !template.names.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [missing.length ? `missing ${missing.map((name) => `{${name}}`).join(', ')}` : '',
      extra.length ? `not in the text ${extra.map((name) => `{${name}}`).join(', ')}` : ''].filter(Boolean);
    throw new Error(`Companion prompt ${key}: ${parts.join('; ')}`);
  }
  return template.parts.map((part) => {
    if (typeof part === 'string') return part;
    const value = vars[part.name];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new Error(`Companion prompt ${key}: {${part.name}} must be text or a number`);
  }).join('');
}

/**
 * The opening instructions of the conversation the user talks to the agent
 * in (V, purpose main: DESIGN-v2 §2.2): instructions.main, then the Spaces
 * assistant's Pages, tasks and conversations clauses and the Scheduled
 * window's job clauses, after MICHI_ASSISTANT_MARKER. Stable, with no name,
 * time or data in them (R2.13), and part of the session's profile hash.
 */
export function companionMainInstructions(): string {
  return `${MICHI_ASSISTANT_MARKER}. ${[fill('instructions.main'), fill('instructions.mainPages'), fill('instructions.mainJobs')].join('\n\n')}`;
}

/**
 * The opening instructions of a check-in's throwaway session (S, purpose
 * checkin: DESIGN-v2 §2.2): the MVP's hidden-turn rules for a session that
 * sees one note, then the rules for writing Pages in a check-in, after
 * MICHI_ASSISTANT_MARKER. Stable, with no name, time or data in them.
 */
export function companionCheckinInstructions(): string {
  return `${MICHI_ASSISTANT_MARKER}. ${[fill('instructions.checkin'), fill('instructions.checkinPages')].join('\n\n')}`;
}

// ── Material: scrubbing and fencing ─────────────────────────────────────────

/**
 * Text from outside, safe to show inside Michi's structure: the same
 * scrubber the deep reads' untrusted blocks use (sources/common.ts
 * inertText), so no hidden characters, no compatibility lookalikes, no
 * fences and no forged labels, whatever the path. Line breaks are kept (see
 * materialLine for one-line fields).
 */
export function scrubMaterial(text: string): string {
  return inertText(text);
}

/** `text` cut to `max` characters with an ellipsis, never inside a surrogate pair. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

/** Outside text for a one-line field: scrubbed, every run of whitespace one space, at most `max` characters. */
export function materialLine(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  return clip(scrubMaterial(text).replace(/\s+/g, ' ').trim(), max);
}

/** Outside text for a multi-line block: scrubbed, blank runs folded, at most `max` characters. */
export function materialBlock(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const lines = scrubMaterial(text).split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  return clip(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), max);
}

/** Lines inside the collector-data fence. */
export function collectorData(lines: readonly string[]): string {
  return fill('block.collector', { data: lines.length > 0 ? lines.join('\n') : fill('section.nothing') });
}

// ── Time ────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * `2026-11-05T09:12+09:00, Thursday (local time)`: [CURRENT RUN TIME], ISO
 * 8601 with this computer's UTC offset (conv-2), so a local time the agent
 * writes for a tool ("YYYY-MM-DD HH:MM") is read in a zone it knows.
 */
export function formatRunTime(now: number): string {
  return `${localIsoMinuteText(now)}, ${WEEKDAYS[new Date(now).getDay()]} (local time)`;
}

/** `09:12` today, else `2026-11-03 17:40`. */
export function stampText(now: number, at: number): string {
  return localDateKey(at) === localDateKey(now) ? localClockText(at) : `${localDateKey(at)} ${localClockText(at)}`;
}

/** `5 min`, `3 h`, `2 days` (at least a minute). */
function spanText(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function ageText(now: number, at: number): string {
  return now - at < 60_000 ? 'just now' : `${spanText(now - at)} ago`;
}

/** `2 h ago (07:10)`, or `in 25 min (09:40)` for a time still ahead. */
function whenText(now: number, at: number): string {
  const relative = at - now >= 60_000 ? `in ${spanText(at - now)}` : ageText(now, at);
  return `${relative} (${stampText(now, at)})`;
}

/** A heartbeat interval in words: `30 minutes`, `hour`, `2 hours`. */
export function everyText(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} minutes`;
  return minutes === 60 ? 'hour' : `${minutes / 60} hours`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ── Lines ───────────────────────────────────────────────────────────────────

const BUCKET_WORDS: Record<CompanionBucket, string> = { needs_you: 'needs you', update: 'update', stalled: 'stalled', fyi: 'fyi' };
const BUCKET_ORDER: Record<CompanionBucket, number> = { needs_you: 0, stalled: 1, update: 2, fyi: 3 };
const SEVERITY_ORDER = { now: 0, digest: 1, silent: 2 } as const;
const SOURCE_WORDS: Record<CompanionSourceKind, string> = {
  michi: 'Michi', cr: 'CR', pipeline: 'pipeline', email: 'email', calendar: 'calendar', system: 'Michi health',
};
const EVENT_WORDS: Record<CompanionEventRecord['kind'], string> = {
  created: 'new', changed: 'changed', reopened: 'back', resolved: 'resolved', baseline: 'already there',
};
const MAX_FACTS = 8;

/**
 * The system items that say Michi could not check a source (Auth expired,
 * a source failing): the only ones under [SOURCES MICHI COULD NOT CHECK].
 * A due reminder is a system item too, but it is an ordinary thing that
 * waits on the user, listed with the other open items.
 */
const SOURCE_TROUBLE: ReadonlySet<CompanionItemSubtype> = new Set<CompanionItemSubtype>(['system_auth', 'system_source_error']);
const isSourceTrouble = (item: CompanionItemDto) => SOURCE_TROUBLE.has(item.subtype);

/** Where an item comes from, in the note's words: a due reminder is the user's reminder, not "Michi health". */
function sourceWord(item: CompanionItemDto): string {
  return item.subtype === 'reminder_due' ? 'reminder' : SOURCE_WORDS[item.source] ?? item.source;
}

/** Where an item's link points, when it has one the Companion may give. */
export function targetLink(target: CompanionTarget | null): string | null {
  if (!target) return null;
  if (target.kind === 'node') return `michi://node/${target.nodeId}`;
  if (target.kind === 'url') return target.url;
  return null;
}

/** A fact that holds a moment: `at`, a key ending in At or Since, or a start or an end. */
const MOMENT_FACT = /^(?:at|start|end)$|(?:At|Since|Start|End)$/;
/** Epoch milliseconds between 2000 and 2100: a moment, not a count. */
const isEpochMs = (value: number) => Number.isFinite(value) && value >= 946_684_800_000 && value < 4_102_444_800_000;

/** Small facts, `key=value`; a moment reads as its age or how far ahead it is (`lastTouchedAt=3 days ago (2026-11-02 16:10)`), never as epoch ms. */
function factsText(facts: CompanionItemDto['facts'], now: number): string {
  const entries = Object.entries(facts)
    .filter(([key, value]) => value !== null && value !== '' && !/url$/i.test(key))
    .slice(0, MAX_FACTS)
    .map(([key, value]) => {
      const shown = typeof value === 'string' ? materialLine(value, 80)
        : typeof value === 'number' && MOMENT_FACT.test(key) && isEpochMs(value) ? whenText(now, value)
          : String(value);
      return `${materialLine(key, 40)}=${shown}`;
    });
  return entries.join(', ');
}

/**
 * Where an item stands for the user, when that says something: `new` (it
 * changed since the user last looked at Today), a snooze, or how it left the
 * feed. Nothing for the rest, since "seen" may only mean it was already
 * there at Michi's first look, which the user never saw.
 */
function statusWords(item: CompanionItemDto, now: number): string | null {
  switch (item.status) {
    case 'new': return 'new';
    case 'snoozed': return item.snoozedUntil ? `snoozed until ${stampText(now, item.snoozedUntil)}` : 'snoozed';
    case 'dismissed': return 'dismissed by the user';
    case 'muted': return 'muted by the user';
    case 'resolved': return 'resolved';
    default: return null;
  }
}

/** One item: `- <id> · needs you · now · CR · "title" — summary · new · changed 2 h ago (07:10) · <link> · facts: …`. */
export function itemLine(item: CompanionItemDto, now: number): string {
  const parts = [
    item.id,
    BUCKET_WORDS[item.bucket] ?? item.bucket,
    item.severity,
    sourceWord(item),
    `"${materialLine(item.title, 160)}"${item.summary ? ` — ${materialLine(item.summary, 240)}` : ''}`,
  ];
  const status = statusWords(item, now);
  if (status) parts.push(status);
  parts.push(item.changedAt > item.firstSeenAt ? `changed ${whenText(now, item.changedAt)}` : `first seen ${whenText(now, item.firstSeenAt)}`);
  const link = targetLink(item.target);
  if (link) parts.push(materialLine(link, 300));
  const facts = factsText(item.facts, now);
  if (facts) parts.push(`facts: ${facts}`);
  if (item.feedback === 'down') parts.push(`the user marked it not useful${item.feedbackReason ? ` (${item.feedbackReason})` : ''}`);
  if (item.feedback === 'up') parts.push('the user marked it useful');
  return `- ${parts.join(' · ')}`;
}

/**
 * One event: when, what happened, and the item's title and summary as that
 * version had them (the event's own record), with the item's bucket, source
 * and link when the item is known.
 */
export function eventLine(event: CompanionEventRecord, item: CompanionItemDto | undefined, now: number): string {
  const text = materialLine(event.summary, 300) || (item ? materialLine(item.title, 160) : '') || 'an item';
  const where = item
    ? `${BUCKET_WORDS[item.bucket] ?? item.bucket} · ${event.severity} · ${sourceWord(item)}`
    : event.severity;
  const link = item ? targetLink(item.target) : null;
  return `- ${stampText(now, event.createdAt)} ${EVENT_WORDS[event.kind] ?? event.kind} · ${where} · "${text}"`
    + ` (item ${event.itemId}${link ? ` · ${materialLine(link, 300)}` : ''})`;
}

function focusLine(entry: CompanionFocusEntry, now: number): string {
  return `- "${materialLine(entry.title, 120)}" in ${materialLine(entry.workspaceName, 80) || 'a workspace'} · ${entry.state}`
    + ` · last active ${whenText(now, entry.lastActiveAt)} · michi://node/${entry.nodeId}`;
}

function reminderLine(reminder: CompanionReminderDto, now: number): string {
  const when = reminder.kind === 'watch' ? `until the item ${reminder.until ?? 'changes'}`
    : reminder.dailyAt ? `every workday at ${reminder.dailyAt}`
      : reminder.at ? `at ${stampText(now, reminder.at)}` : 'unscheduled';
  return `- "${materialLine(reminder.text, 200)}" · ${when}${reminder.itemId ? ` · item ${reminder.itemId}` : ''}${reminder.status === 'paused' ? ' · paused' : ''}`;
}

const CARD_OUTCOMES: Record<CompanionCardDto['status'], string> = {
  pending: 'Still waiting',
  applied: 'Applied by the user',
  dismissed: 'Dismissed by the user',
  expired: 'Expired without an answer',
  failed: 'Failed',
};

/** One card result for [CARD RESULTS]: its outcome, Michi's summary, and any error. */
export function cardResultLine(card: CompanionCardDto): string {
  const error = card.status === 'failed' && card.error ? ` — ${materialLine(card.error, 200)}` : '';
  return `- ${CARD_OUTCOMES[card.status] ?? card.status}: ${materialLine(card.summary, 300)}${error}`;
}

function goalLine(goal: CompanionGoalDto, now: number): string {
  const progress = goal.progress ? ` — latest reading: "${materialLine(goal.progress, 200)}"${goal.progressAt ? ` (${stampText(now, goal.progressAt)})` : ''}` : '';
  return `- ${goal.id}: ${materialLine(goal.text, 500)}${progress}`;
}

/** At most `max` lines, then "… and N more". */
function capped(lines: string[], max: number): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), fill('section.more', { count: lines.length - max })];
}

function byUrgency(a: CompanionItemDto, b: CompanionItemDto): number {
  return (BUCKET_ORDER[a.bucket] ?? 9) - (BUCKET_ORDER[b.bucket] ?? 9)
    || (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    || b.changedAt - a.changedAt;
}

// ── Standing blocks ─────────────────────────────────────────────────────────

/** What every turn carries before its data: the user's rules first, then goals, notes and card results. */
interface StandingInput {
  now: number;
  rules: string;
  goals: readonly CompanionGoalDto[];
  notes: string;
  notesRevision: number;
  cardResults: readonly CompanionCardDto[];
  /** The Companion's cards still waiting for the user (hidden notes), so it does not propose them again. */
  waitingCards?: readonly CompanionCardDto[];
}

const MAX_WAITING_CARD_LINES = 8;

function waitingCardLine(card: CompanionCardDto, now: number): string {
  return `- ${materialLine(card.summary, 300)} (${card.kind}, proposed ${whenText(now, card.createdAt)})`;
}

function standingBlocks(input: StandingInput): string[] {
  const blocks: string[] = [];
  const rules = materialBlock(input.rules, COMPANION_LIMITS.maxRulesChars + 100);
  if (rules) blocks.push(fill('block.rules', { rules }));
  if (input.goals.length > 0) {
    blocks.push(fill('block.goals', { goals: input.goals.map((goal) => goalLine(goal, input.now)).join('\n') }));
  }
  const notes = materialBlock(input.notes, COMPANION_LIMITS.maxNotesChars + 100);
  blocks.push(notes
    ? fill('block.notes', { revision: input.notesRevision, notes })
    : fill('block.notesEmpty', { revision: input.notesRevision }));
  if (input.cardResults.length > 0) {
    blocks.push(fill('block.cardResults', { results: input.cardResults.map(cardResultLine).join('\n') }));
  }
  const waiting = input.waitingCards ?? [];
  if (waiting.length > 0) {
    blocks.push(fill('block.waitingCards', { cards: capped(waiting.map((card) => waitingCardLine(card, input.now)), MAX_WAITING_CARD_LINES).join('\n') }));
  }
  return blocks;
}

// ── Hidden turns ────────────────────────────────────────────────────────────

/**
 * How the user rated the items of one kind (thumbs on items in Today). Only
 * the thumbs up reach the brief, as "keep giving these" (conv-1): a thumbs
 * down is about one item or one version (R2.7: already_handled dismisses it,
 * not_relevant mutes it), and the one kind-wide signal is the deterministic
 * demotion (demotedSubtypes), so `down` and `reasons` are not shown.
 */
export interface CompanionItemFeedback {
  subtype: CompanionItemSubtype;
  up: number;
  down: number;
  /** How often each thumbs-down reason was given. */
  reasons: Readonly<Record<string, number>>;
}

/** Everything a hidden turn's note is made of; the kind decides which parts it shows. */
export interface CompanionTurnView {
  kind: CompanionTurnKind;
  material: CompanionMaterial;
  /** Items the changes or past brief cards name that are not in material.open any more (resolved, dismissed, muted), by id. */
  otherItems?: ReadonlyMap<string, CompanionItemDto>;
  /** settings.heartbeat.intervalMinutes, for the heartbeat's own words. */
  heartbeatMinutes?: number;
  /** Subtypes the user's feedback demoted to digest (the brief leaves their kind out). */
  demotedSubtypes?: readonly CompanionItemSubtype[];
  /** Delegated conversations' workspace names, by workspace id (worker reports). */
  workspaceNames?: ReadonlyMap<string, string>;
  /** The brief: the briefs of the days before, newest first, with the user's thumbs on their cards; the first is YOUR LAST BRIEF. */
  pastBriefs?: readonly CompanionBriefDto[];
  /** The brief: the user's thumbs on items, by kind. */
  itemFeedback?: readonly CompanionItemFeedback[];
  /** The Companion's cards still waiting for the user, so it does not propose them again. */
  waitingCards?: readonly CompanionCardDto[];
  /** DESIGN-v2 §3.6: the user's conversation lately (turnContext.ts recentConversationExcerpt), oldest first. */
  recentConversation?: readonly CompanionConversationLine[];
  /** conv-3: the sources Michi does not watch now (settings.ts companionSourcesOff). */
  offSources?: readonly CompanionConfigurableSource[];
}

const MAX_CHANGES = 40;
const MAX_STILL_OPEN = 25;
const MAX_OPEN = 40;
const MAX_WELCOME_ITEMS = 20;
const MAX_FOCUS = 5;
const MAX_REMINDERS = 10;

function sourcesSection(open: readonly CompanionItemDto[], now: number): string[] {
  const failing = open.filter(isSourceTrouble);
  return failing.length > 0 ? [fill('section.sources'), ...failing.map((item) => itemLine(item, now))] : [];
}

/** A source by its name in a sentence (the first look's lines). */
const FIRST_LOOK_WORDS: Record<CompanionConfigurableSource, string> = {
  michi: 'Michi conversations', cr: 'CRs', pipeline: 'pipelines', email: 'email', calendar: 'calendar',
};

/**
 * [NOT READ YET]: the sources whose first look had not landed when the
 * welcome began (B23): still running, or failed with Michi's short reason.
 * Without it a welcome written before the CR baseline came in names no CR
 * and may say nothing stands out.
 */
function firstLookSection(firstLook: CompanionMaterial['firstLook']): string[] {
  const entries = firstLook ?? [];
  const named = (entry: (typeof entries)[number]) => FIRST_LOOK_WORDS[entry.source] ?? materialLine(entry.source, 40);
  const running = entries.filter((entry) => entry.state === 'running').map(named);
  const failed = entries.filter((entry) => entry.state === 'failed').map((entry) => {
    const reason = materialLine(entry.detail, 160);
    return reason ? `${named(entry)} (${reason})` : named(entry);
  });
  if (running.length === 0 && failed.length === 0) return [];
  return [
    fill('section.firstLook'),
    ...(running.length > 0 ? [fill('section.firstLookRunning', { sources: [...new Set(running)].join(', ') })] : []),
    ...(failed.length > 0 ? [fill('section.firstLookFailed', { sources: [...new Set(failed)].join(', ') })] : []),
  ];
}

function focusSection(focus: readonly CompanionFocusEntry[], now: number): string[] {
  return focus.length > 0 ? [fill('section.focus'), ...focus.slice(0, MAX_FOCUS).map((entry) => focusLine(entry, now))] : [];
}

function remindersSection(reminders: readonly CompanionReminderDto[], now: number): string[] {
  const active = reminders.filter((reminder) => reminder.status === 'active' || reminder.status === 'paused');
  return active.length > 0 ? [fill('section.reminders'), ...capped(active.map((reminder) => reminderLine(reminder, now)), MAX_REMINDERS)] : [];
}

function changesSection(view: CompanionTurnView, items: ReadonlyMap<string, CompanionItemDto>): string[] {
  const { material } = view;
  const since = material.lastLookAt !== null ? `your last look: ${stampText(material.now, material.lastLookAt)}` : 'this is your first look';
  const changes = material.changes.filter((event) => event.kind !== 'baseline');
  const lines = changes.map((event) => eventLine(event, items.get(event.itemId), material.now));
  return [fill('section.changes', { since }), ...(lines.length > 0 ? capped(lines, MAX_CHANGES) : [fill('section.nothing')])];
}

function openSection(open: readonly CompanionItemDto[], now: number, max: number): string[] {
  const sorted = open.filter((item) => !isSourceTrouble(item)).sort(byUrgency);
  return [fill('section.openItems', { count: sorted.length }),
    ...(sorted.length > 0 ? capped(sorted.map((item) => itemLine(item, now)), max) : [fill('section.nothing')])];
}

function stillOpenSection(open: readonly CompanionItemDto[], now: number, max: number, except: ReadonlySet<string> = new Set()): string[] {
  const waiting = open.filter((item) => (item.bucket === 'needs_you' || item.bucket === 'stalled') && !isSourceTrouble(item) && !except.has(item.id))
    .sort(byUrgency);
  return waiting.length > 0 ? [fill('section.stillOpen'), ...capped(waiting.map((item) => itemLine(item, now)), max)] : [];
}

const MAX_FEEDBACK_LINES = 20;
const OPEN_STATUSES: ReadonlySet<CompanionItemDto['status']> = new Set(['new', 'seen', 'snoozed']);

/** A brief card's items as the note knows them (open, or gone since). */
function briefCardItems(itemIds: readonly string[], items: ReadonlyMap<string, CompanionItemDto>): CompanionItemDto[] {
  return itemIds.map((id) => items.get(id)).filter((item): item is CompanionItemDto => item !== undefined);
}

/** What became of a past brief card's items: they left the feed, changed, or stayed as they were. */
function sinceBrief(brief: CompanionBriefDto, known: readonly CompanionItemDto[]): string | null {
  if (known.length === 0) return null;
  if (known.every((item) => !OPEN_STATUSES.has(item.status))) return 'no longer open';
  return known.some((item) => item.changedAt > brief.createdAt) ? 'changed since' : 'unchanged since';
}

const RATINGS = { up: 'rated up', down: 'rated down' } as const;

/**
 * [YOUR LAST BRIEF]: the brief before this one, card by card: the user's
 * thumb on it, the ids of the items it was about and what became of them
 * since, so the agent does not repeat a card nothing changed for. A thumb is
 * about the card, never about its items' kinds (conv-1), so no kind is named.
 */
function lastBriefSection(view: CompanionTurnView, items: ReadonlyMap<string, CompanionItemDto>): string[] {
  const brief = view.pastBriefs?.[0];
  if (!brief) return [];
  const lines = [`- headline: "${materialLine(brief.headline, 200)}"`, ...brief.cards.map((card, index) => {
    const known = briefCardItems(card.itemIds, items);
    const rating = brief.cardFeedback[index];
    const parts: string[] = [rating ? RATINGS[rating] : 'not rated', `"${materialLine(card.title, 120)}"`];
    if (known.length > 0) parts.push(`items ${known.map((item) => item.id).join(', ')}`);
    const since = sinceBrief(brief, known);
    if (since) parts.push(since);
    return `- ${parts.join(' · ')}`;
  })];
  return [fill('section.lastBrief', { date: brief.date, origin: brief.origin === 'fallback' ? ', which Michi wrote when you could not' : '' }), ...lines];
}

/**
 * [FEEDBACK]: what tunes the brief (conv-1): the kinds the user's feedback
 * demoted, the one kind-wide signal (they get one short line, not a card);
 * the kinds they rated useful; their thumbs on the cards of earlier briefs
 * (the last one has its own section), each about that card alone; and the
 * open items they rated down, each by its id.
 */
function feedbackSection(view: CompanionTurnView): string[] {
  const lines: string[] = [];
  for (const subtype of view.demotedSubtypes ?? []) lines.push(fill('section.feedbackDemoted', { subtype }));
  for (const entry of view.itemFeedback ?? []) {
    if (entry.up > 0) lines.push(`- ${entry.subtype} items: ${entry.up} rated useful`);
  }
  for (const brief of (view.pastBriefs ?? []).slice(1)) {
    brief.cards.forEach((card, index) => {
      const rating = brief.cardFeedback[index];
      if (!rating) return;
      lines.push(`- ${brief.date} brief, card ${RATINGS[rating]}: "${materialLine(card.title, 120)}"`);
    });
  }
  for (const item of view.material.open) {
    if (item.feedback === 'down') lines.push(`- item ${item.id} "${materialLine(item.title, 120)}": rated not useful${item.feedbackReason ? ` (${item.feedbackReason})` : ''}`);
  }
  return lines.length > 0 ? [fill('section.feedback'), ...capped(lines, MAX_FEEDBACK_LINES)] : [];
}

function workerReportBlock(report: CompanionWorkerReport, view: CompanionTurnView): string {
  const workspace = view.workspaceNames?.get(report.delegation.workspaceId);
  return fill('block.workerReply', {
    title: materialLine(report.delegation.title, 120) || 'Conversation',
    workspace: workspace ? `"${materialLine(workspace, 80)}"` : 'one of the user\'s workspaces',
    link: `michi://node/${report.delegation.nodeId}`,
    status: materialLine(report.status, 80) || 'completed',
    excerpt: materialBlock(report.excerpt, COMPANION_LIMITS.maxReportChars) || '(no text)',
  });
}

/** The collector data a kind shows (worker reports have their own fences). */
function dataLines(view: CompanionTurnView): string[] {
  const { material } = view;
  const now = material.now;
  const items = new Map<string, CompanionItemDto>(view.otherItems ?? []);
  for (const item of material.open) items.set(item.id, item);
  switch (view.kind) {
    case 'welcome':
      return [...openSection(material.open, now, MAX_WELCOME_ITEMS), ...sourcesSection(material.open, now), ...firstLookSection(material.firstLook),
        ...focusSection(material.focus, now)];
    case 'heartbeat':
      return [...changesSection(view, items), ...stillOpenSection(material.open, now, MAX_STILL_OPEN), ...sourcesSection(material.open, now),
        ...remindersSection(material.reminders, now), ...focusSection(material.focus, now)];
    case 'wake': {
      const changed = material.changes.filter((event) => event.kind !== 'baseline');
      const ids = new Set(changed.map((event) => event.itemId));
      const happened = changed.map((event) => {
        const item = items.get(event.itemId);
        return item ? itemLine(item, now) : eventLine(event, undefined, now);
      });
      return [fill('section.justHappened'), ...(happened.length > 0 ? capped([...new Set(happened)], MAX_CHANGES) : [fill('section.nothing')]),
        ...stillOpenSection(material.open, now, 10, ids), ...sourcesSection(material.open, now)];
    }
    case 'brief':
      return [...openSection(material.open, now, MAX_OPEN), ...changesSection(view, items), ...sourcesSection(material.open, now),
        ...remindersSection(material.reminders, now), ...focusSection(material.focus, now), ...lastBriefSection(view, items), ...feedbackSection(view)];
    default:
      return [];
  }
}

function body(view: CompanionTurnView): string {
  const { material } = view;
  switch (view.kind) {
    case 'welcome': return fill('turn.welcome');
    case 'heartbeat': return fill('turn.heartbeat', { every: everyText(view.heartbeatMinutes ?? 60), notesRevision: material.notesRevision });
    case 'wake': return fill('turn.wake');
    case 'brief': return fill('turn.brief', { date: localDateKey(material.now), maxCards: COMPANION_LIMITS.maxBriefCards });
    case 'worker_report': return fill('turn.worker_report');
    default: throw new Error(`no Companion note for a ${String(view.kind)} turn`);
  }
}

const LABELS = {
  welcome: 'label.welcome', heartbeat: 'label.heartbeat', wake: 'label.wake', brief: 'label.brief', worker_report: 'label.worker_report',
} as const satisfies Partial<Record<CompanionTurnKind, CompanionPromptKey>>;

/**
 * The note a check-in sends (DESIGN §7.4 with R2.9, R2.13, R2.15; DESIGN-v2
 * §3.1, §3.6): its [Kind] label and wake.preamble (the agent's name),
 * [CURRENT RUN TIME], the user's rules ahead of everything else, goals,
 * notes, card results, the cards still waiting for the user, the sources off
 * in settings, [RECENT CONVERSATION], the collector data fenced as
 * untrusted, and the kind's body. A catch-up has no note: it is
 * deterministic (R2.8).
 */
export function composeCompanionTurn(view: CompanionTurnView): string {
  if (!(view.kind in LABELS)) throw new Error(`no Companion note for a ${String(view.kind)} turn`);
  const { material } = view;
  const label = fill(LABELS[view.kind as keyof typeof LABELS]);
  const displayName = materialLine(material.displayName, 40) || DEFAULT_COMPANION_NAME;
  const blocks = [
    `${label} ${fill('wake.preamble', { displayName })}`,
    fill('block.runTime', { runTime: formatRunTime(material.now) }),
    ...standingBlocks({ ...material, waitingCards: view.waitingCards ?? [] }),
  ];
  const off = offSourcesBlock(view.offSources);
  if (off) blocks.push(off);
  const recent = recentConversationBlock(view.recentConversation ?? [], material.now);
  if (recent) blocks.push(recent);
  if (view.kind === 'worker_report') {
    for (const report of material.reports) blocks.push(workerReportBlock(report, view));
  } else {
    blocks.push(collectorData(dataLines(view)));
  }
  if (view.kind === 'brief' && material.briefCurate && materialLine(material.briefCurate, 500)) {
    blocks.push(fill('block.curate', { curate: materialLine(material.briefCurate, 500) }));
  }
  blocks.push(body(view));
  return blocks.join('\n\n');
}

// ── Check-in notes: what the user's conversation said, what is off ────────

/** One message of the user's conversation with the agent, as a check-in's [RECENT CONVERSATION] quotes it (DESIGN-v2 §3.6). */
export interface CompanionConversationLine {
  role: 'user' | 'assistant';
  at: number;
  /** The message's own text: the user's words, or the agent's final reply. */
  text: string;
  /** The agent's message is one a check-in posted (companionPost), or Michi's first-look narration. */
  posted?: boolean;
}

const MAX_CONVERSATION_LINE_CHARS = 1200;

/**
 * [RECENT CONVERSATION]: the latest COMPANION_LIMITS.recentConversationMessages
 * messages, oldest first, each scrubbed and on one line, newest kept first
 * when they would pass COMPANION_LIMITS.maxRecentConversationChars together.
 * Null when there is nothing to quote.
 */
function recentConversationBlock(lines: readonly CompanionConversationLine[], now: number): string | null {
  const latest = lines.map((line) => ({ ...line, text: materialLine(line.text, MAX_CONVERSATION_LINE_CHARS) }))
    .filter((line) => line.text).slice(-COMPANION_LIMITS.recentConversationMessages);
  const kept: string[] = [];
  let used = 0;
  for (let index = latest.length - 1; index >= 0; index -= 1) {
    const line = latest[index]!;
    const text = line.text;
    const who = line.role === 'user' ? 'the user' : line.posted ? 'you, posted by a check-in' : 'you';
    const entry = `- ${stampText(now, line.at)} ${who}: ${text}`;
    if (used + entry.length + 1 > COMPANION_LIMITS.maxRecentConversationChars) break;
    kept.unshift(entry);
    used += entry.length + 1;
  }
  return kept.length > 0 ? fill('block.recentConversation', { lines: kept.join('\n') }) : null;
}

const SOURCE_NAMES: Record<CompanionConfigurableSource, string> = {
  michi: 'Michi conversations', cr: 'CRs', pipeline: 'pipelines', email: 'email', calendar: 'calendar',
};

/** The sources off in settings by name (conv-3), e.g. `email, calendar`. */
export function offSourcesText(sources: readonly CompanionConfigurableSource[]): string {
  return [...new Set(sources)].map((source) => SOURCE_NAMES[source] ?? source).join(', ');
}

/** [SOURCES OFF IN SETTINGS], or null when every source is on. */
function offSourcesBlock(sources: readonly CompanionConfigurableSource[] | undefined): string | null {
  return sources && sources.length > 0 ? fill('block.offSources', { sources: offSourcesText(sources) }) : null;
}

// ── What a check-in changed (DESIGN-v2 §3.4) ────────────────────────────────

const CHANGE_ACTION_WORDS: Record<CompanionPostChangeAction, string> = {
  snooze: 'snoozed', dismiss: 'dismissed', restore: 'restored', add: 'added', reword: 'reworded', remove: 'removed',
};

/** `"Tasks"`, `the "Bugs" database`, or `a page` / `a database` for one whose title is not Michi's to give (it is new or a check-in named it). */
function changeTarget(change: Omit<CompanionPostChange, 'reason'>): string {
  const title = materialLine(change.title, 80);
  if (change.kind === 'database') return title ? `the "${title}" database` : 'a database';
  return title ? `"${title}"` : 'a page';
}

/** "a, b and c". */
function listText(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * What a check-in changed, in a sentence's words (§3.4): each page and
 * database (`updated "Tasks" (3 changes)`, `suggested 2 changes to a page`),
 * each follow-up it sent itself (`sent a follow-up to "Fix the flaky test"`,
 * D21), then Today items and goals counted by what was done (`snoozed 2
 * items`, `reworded 1 goal`). Michi's words, the titles of pages that existed
 * before the check-in and of the conversations it sent into, and counts:
 * never a reason or a title the check-in wrote. Empty when it changed nothing.
 */
export function companionChangesText(changes: readonly Omit<CompanionPostChange, 'reason'>[]): string {
  const parts: string[] = [];
  for (const change of changes) {
    if (change.kind !== 'page' && change.kind !== 'database') continue;
    if (change.applied > 0) parts.push(`updated ${changeTarget(change)} (${plural(change.applied, 'change')})`);
    if (change.proposed > 0) parts.push(`suggested ${plural(change.proposed, 'change')} to ${changeTarget(change)}`);
  }
  // A follow-up it sent itself (Q1, D21), into a conversation the agent started.
  for (const change of changes) {
    if (change.kind !== 'send' || change.applied + change.proposed === 0) continue;
    const title = materialLine(change.title, 80);
    parts.push(`sent a follow-up to ${title ? `"${title}"` : 'a conversation'}`);
  }
  for (const [kind, actions] of [['item', ['snooze', 'dismiss', 'restore']], ['goal', ['add', 'reword', 'remove']]] as const) {
    const counts = new Map<CompanionPostChangeAction | null, number>();
    for (const change of changes) {
      if (change.kind !== kind || change.applied + change.proposed === 0) continue;
      const action = change.action && (actions as readonly string[]).includes(change.action) ? change.action : null;
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
    for (const action of [...actions, null]) {
      const count = counts.get(action) ?? 0;
      if (count > 0) parts.push(`${action ? CHANGE_ACTION_WORDS[action] : 'changed'} ${plural(count, kind)}`);
    }
  }
  return listText(parts);
}

/**
 * A check-in's deterministic post (§3.4): it changed the user's content and
 * wrote no message, so Michi says what it did, e.g. `Nova updated "Tasks" (3
 * changes), snoozed 1 item and reworded 1 goal.` With `stopped`: the boot
 * cleanup's post for a check-in that crashed after it changed something
 * (§3.7). Null when it changed nothing. W2-G1a's posts.ts posts it.
 */
export function companionPostReceipt(displayName: string, changes: readonly CompanionPostChange[], options: { stopped?: boolean } = {}): string | null {
  const text = companionChangesText(changes);
  if (!text) return null;
  return options.stopped
    ? fill('post.receiptStopped', { changes: text })
    : fill('post.receipt', { displayName: materialLine(displayName, 40) || DEFAULT_COMPANION_NAME, changes: text });
}

// ── The user's own turns ────────────────────────────────────────────────────

/**
 * A post the user's turns were not told about yet, as [COMPANION CONTEXT]
 * lists it (DESIGN-v2 §3.5; repository listUntoldPosts gives these): its
 * kind, when it was posted and what it changed. Never the post's text, its
 * changes' reasons or a title the check-in wrote.
 */
export interface CompanionPostFact {
  kind: CompanionCheckinKind;
  postedAt: number;
  changes: readonly Omit<CompanionPostChange, 'reason'>[];
}

const POST_KIND_WORDS: Record<CompanionCheckinKind, string> = {
  welcome: 'first welcome', heartbeat: 'heartbeat', wake: 'wake', brief: 'morning brief', worker_report: 'worker report', catch_up: 'catch-up',
};

/** A check-in's kind in words: `heartbeat`, `morning brief`, `worker report`. */
export function checkinKindText(kind: CompanionCheckinKind): string {
  return POST_KIND_WORDS[kind] ?? 'check-in';
}

/** Ids Michi made (items, goals, cards, pages, workspaces): anything else stays out of [COMPANION CONTEXT]. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const safeId = (value: unknown): string | null => (typeof value === 'string' && SAFE_ID.test(value) ? value : null);

/** One post as a fact: `- 08:40 heartbeat: updated page pg-1 "Tasks" (3 applied, 1 proposed); snoozed item cmi-1`. */
function postFactLine(post: CompanionPostFact, now: number): string {
  const facts = post.changes.flatMap((change) => {
    const id = safeId(change.id);
    if (!id) return [];
    if (change.kind === 'page' || change.kind === 'database') {
      const title = materialLine(change.title, 80);
      return [`changed ${change.kind} ${id}${title ? ` "${title}"` : ''} (${change.applied} applied, ${change.proposed} proposed)`];
    }
    // A follow-up it sent itself (D21): the conversation by id only.
    if (change.kind === 'send') return [`sent a follow-up to conversation ${id}`];
    return [`${change.action ? CHANGE_ACTION_WORDS[change.action] : 'changed'} ${change.kind} ${id}`];
  });
  return `- ${stampText(now, post.postedAt)} ${checkinKindText(post.kind)}: ${facts.length > 0 ? facts.join('; ') : 'posted a message, changed nothing'}`;
}

const CARD_RESULT_WORDS: Record<CompanionCardDto['status'], string> = {
  pending: 'still waiting',
  applied: 'applied by the user',
  dismissed: 'dismissed by the user',
  expired: 'expired without an answer',
  failed: 'failed',
};

/**
 * What a card is about, as a fact: `goal cmg-2`, `item cmi-1`, `source email`,
 * `conversation n-9`, `workspace p-1`. A conversation comes before its
 * workspace: a session.send card's payload names both, and it is about the
 * conversation (G2-review #6).
 */
function cardTargetText(card: CompanionCardDto): string | null {
  const payload = card.payload && typeof card.payload === 'object' && !Array.isArray(card.payload) ? card.payload as Record<string, unknown> : {};
  const pairs: Array<[string, unknown]> = [['goal', payload.goalId], ['item', payload.itemId], ['source', payload.source],
    ['conversation', payload.nodeId], ['workspace', payload.workspaceId]];
  for (const [what, value] of pairs) {
    const id = safeId(value);
    if (id) return `${what} ${id}`;
  }
  return null;
}

function cardResultFact(card: CompanionCardDto): string {
  const target = cardTargetText(card);
  return `- ${card.kind} card ${safeId(card.id) ?? 'unknown'}${target ? ` (${target})` : ''}: ${CARD_RESULT_WORDS[card.status] ?? card.status}`;
}

function waitingCardFact(card: CompanionCardDto, now: number): string {
  const target = cardTargetText(card);
  return `- ${safeId(card.id) ?? 'unknown'}: ${card.kind}${target ? ` (${target})` : ''}, proposed ${whenText(now, card.createdAt)}`;
}

/** A goal in [COMPANION CONTEXT]: its words only when the user wrote them (§2.8 T1; an absent origin counts as a check-in's). */
function goalFact(goal: CompanionGoalDto, now: number): string {
  const words = goal.textOrigin === 'user' ? materialLine(goal.text, COMPANION_LIMITS.maxGoalChars) : '';
  const progress = goal.progressAt ? `; progress recorded ${stampText(now, goal.progressAt)} (read it with companion_read)` : '';
  return `- ${goal.id}: ${words || 'worded by a check-in (read it with companion_read)'}${progress}`;
}

/**
 * What [COMPANION CONTEXT] is made of (DESIGN-v2 §3.5). The per-turn facts
 * go in every turn; the standing blocks (rules, goals, notes, the sources
 * off) only when `standing` is not false: turnContext.ts sends them on a
 * session's first turn and when they changed.
 */
export interface CompanionContextInput {
  now: number;
  displayName: string;
  /** The user's rules, as they wrote them. */
  rules: string;
  /** The user's goals: the words only of those whose textOrigin is `user`. */
  goals: readonly CompanionGoalDto[];
  notes: string;
  notesRevision: number;
  /** Who wrote the notes last; absent counts as a check-in (fail closed, §2.8 T1): only `user` notes are quoted. */
  notesOrigin?: CompanionTextOrigin;
  /** Card results not reported yet: kind, id, target and outcome only. */
  cardResults: readonly CompanionCardDto[];
  /** Cards still waiting for the user: kind, id, target and age only. */
  waitingCards?: readonly CompanionCardDto[];
  /** Open items in Needs you, and open items the user has not seen yet. */
  needsYou: number;
  newItems: number;
  /** The agent's cards waiting for the user. */
  pendingCards: number;
  /** When today's brief was published; null before it is. Never its text: the brief is check-in material. */
  briefPublishedAt: number | null;
  /** Posts the user's turns were not told about yet, newest first. */
  posts?: readonly CompanionPostFact[];
  /** The sources off in settings (conv-3). */
  offSources?: readonly CompanionConfigurableSource[];
  /** Whether the standing blocks go in; default true. */
  standing?: boolean;
}

/** The per-turn facts of [COMPANION CONTEXT], after its opening and the run time: the feed, card results, cards waiting, posts. */
function companionContextFacts(input: CompanionContextInput): string[] {
  const brief = input.briefPublishedAt === null ? 'not published yet'
    : `published at ${stampText(input.now, input.briefPublishedAt)} (read it with companion_read)`;
  const blocks = [fill('context.status', {
    needsYou: plural(input.needsYou, 'item'),
    newItems: input.newItems,
    pendingCards: plural(input.pendingCards, 'card'),
    brief,
  })];
  if (input.cardResults.length > 0) blocks.push(fill('context.cardResults', { results: input.cardResults.map(cardResultFact).join('\n') }));
  const waiting = input.waitingCards ?? [];
  if (waiting.length > 0) {
    blocks.push(fill('context.waitingCards', { cards: capped(waiting.map((card) => waitingCardFact(card, input.now)), MAX_WAITING_CARD_LINES).join('\n') }));
  }
  const posts = (input.posts ?? []).slice(0, COMPANION_LIMITS.maxUntoldPosts);
  if (posts.length > 0) blocks.push(fill('context.posts', { posts: posts.map((post) => postFactLine(post, input.now)).join('\n') }));
  return blocks;
}

/**
 * The standing blocks of [COMPANION CONTEXT] (§3.5): the user's rules, the
 * goals (the user's words only), the notes when the user wrote them last
 * (else their revision and who wrote them), and the sources off in settings.
 * turnContext.ts compares them to what the session already holds.
 */
export function companionContextStanding(input: Pick<CompanionContextInput, 'now' | 'rules' | 'goals' | 'notes' | 'notesRevision' | 'notesOrigin' | 'offSources'>): string[] {
  const blocks: string[] = [];
  const rules = materialBlock(input.rules, COMPANION_LIMITS.maxRulesChars + 100);
  if (rules) blocks.push(fill('block.rules', { rules }));
  if (input.goals.length > 0) blocks.push(fill('context.goals', { goals: input.goals.map((goal) => goalFact(goal, input.now)).join('\n') }));
  const notes = materialBlock(input.notes, COMPANION_LIMITS.maxNotesChars + 100);
  blocks.push(!notes ? fill('context.notesEmpty', { revision: input.notesRevision })
    : input.notesOrigin === 'user' ? fill('context.notes', { revision: input.notesRevision, notes })
      : fill('context.notesByCheckin', { revision: input.notesRevision }));
  const off = offSourcesBlock(input.offSources);
  if (off) blocks.push(off);
  return blocks;
}

/**
 * [COMPANION CONTEXT]: what the agent knows ahead of the user's own message
 * (DESIGN-v2 §3.5, §2.8 T1): its name and the run time; the feed in one
 * line (today's brief: only whether it is out); the card results and the
 * cards still waiting, as kinds, ids and outcomes; Michi's record of what
 * its check-ins posted since the user's last message; and, when `standing`
 * is not false, the user's rules, their goals in their own words, the notes
 * when the user wrote them last, and the sources off in settings. Never a
 * check-in's text: no post body, card summary, brief, goal reading, goal it
 * worded, notes it wrote, reason or item title. No Spaces or Scheduled
 * context.
 */
export function companionContextText(input: CompanionContextInput): string {
  return [
    fill('context.open', { displayName: materialLine(input.displayName, 40) || DEFAULT_COMPANION_NAME }),
    fill('block.runTime', { runTime: formatRunTime(input.now) }),
    ...companionContextFacts(input),
    ...(input.standing === false ? [] : companionContextStanding(input)),
    fill('context.close'),
  ].join('\n\n');
}
