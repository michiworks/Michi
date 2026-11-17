import {
  COMPANION_CHECKIN_KINDS,
  companionAgo,
  companionItemRaise,
  type CompanionCheckinKind,
  type CompanionConfigurableSource,
  type CompanionItemDto,
  type CompanionItemSubtype,
  type CompanionRunDto,
  type CompanionSettings,
} from 'michi-shared';
import { companionClock, companionItemTime } from './companionView';

/**
 * Where everything Michi watches goes on Today, whatever source it came from.
 * The question a row answers is who waits on whom:
 *
 *   waiting  someone or something is blocked until the user acts. At most
 *            three rows; items of one kind share one row, and the rest fold
 *            as the same rows.
 *   mine     the user's own work, nobody else is blocked: one folded line
 *            per kind.
 *   aside    news, nothing to do: one fold.
 *   health   Michi cannot see, or cannot think: one line per cause, on top.
 *
 * There is no brief: the header counts what waits, and the rows are the same
 * data, so the two can never disagree (the brief's headline was written once
 * and then went stale). What the brief used to say in prose a check-in now
 * says on the item itself, by raising it with a reason (CompanionItemRaise):
 * a raised item waits on the user today whatever its kind. Pure: the Today
 * tab and its tests share it.
 */

const WAITING = 'waiting';
const MINE = 'mine';
const ASIDE = 'aside';
const HEALTH = 'health';

type CompanionTodayPlace = typeof WAITING | typeof MINE | typeof ASIDE | typeof HEALTH;

/** How many rows of "Waiting on you" stand open; the rest fold. */
export const COMPANION_TODAY_ROWS = 3;

/**
 * What a row's primary button does: open the item (its target), or finish it
 * (a reminder is done by being acknowledged, not by going anywhere).
 */
type CompanionTodayAction =
  | { kind: 'open'; label: string; item: CompanionItemDto }
  | { kind: 'done'; label: string };

/** One row: a single item, or several of one kind that read as one line. */
export interface CompanionTodayEntry {
  /** Stable across renders and snapshots: the fold and group state is kept by it. */
  key: string;
  kind: string;
  /** Oldest change first, so "Start with the oldest" is the first member. */
  items: CompanionItemDto[];
  title: string;
  summary: string | null;
  /** The age or clock time on the right. */
  meta: string;
  action: CompanionTodayAction | null;
  /** A member interrupts (severity now): the row's icon says so. */
  now: boolean;
  /** Several items of one kind: the rows behind the summary line. */
  members: CompanionTodayEntry[] | null;
}

export interface CompanionTodayFold {
  key: string;
  summary: string;
  meta: string;
  entries: CompanionTodayEntry[];
  count: number;
}

/** What a health line offers: everything it can actually reach from here. */
type CompanionTodayRemedy =
  | { kind: 'check'; label: string; sources?: readonly CompanionConfigurableSource[] }
  | { kind: 'settings'; label: string };

export interface CompanionTodayHealth {
  key: string;
  text: string;
  remedy: CompanionTodayRemedy;
}

export interface CompanionTodayView {
  health: CompanionTodayHealth[];
  waiting: { count: number; rows: CompanionTodayEntry[]; spill: CompanionTodayEntry[]; spillCount: number };
  mine: { count: number; folds: CompanionTodayFold[] };
  aside: { count: number; entries: CompanionTodayEntry[] };
  /** When a check-in last really looked (it ran and said something or stayed quiet); null when none did. */
  lastLookAt: number | null;
}

// ── words ───────────────────────────────────────────────────────────────────

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "3 days", or "1–4 days" when the items differ. */
function spanText(values: readonly (number | null)[], word: string): string {
  const numbers = values.filter((value): value is number => value !== null).map((value) => Math.floor(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return '';
  const low = numbers[0];
  const high = numbers[numbers.length - 1];
  return low === high ? plural(low, word) : `${low}–${high} ${word}s`;
}

const list = (parts: readonly string[]): string => parts.join(', ');

/** "CRs, pipelines, mail and calendar". */
function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function factNumber(item: CompanionItemDto, key: string): number | null {
  const value = item.facts[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function factText(item: CompanionItemDto, key: string): string | null {
  const value = item.facts[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The CR's id, from the facts the collector wrote (its title's first word otherwise). */
const crOf = (item: CompanionItemDto): string => factText(item, 'cr') ?? item.title.split(' ')[0];
const pipelineOf = (item: CompanionItemDto): string => factText(item, 'pipeline') ?? item.title.replace(/^Pipeline (\S+).*$/, '$1');
/** sources/email.ts writes the sender into the title and the topic into the summary. */
const mailSender = (item: CompanionItemDto): string => item.title.replace(/^Email from /, '');
const mailTopic = (item: CompanionItemDto): string => (item.summary ?? '').split(' — ')[0] || item.title;
/** A CR item's summary ends with the CR's own title; the compact rows show only that. */
const lastClause = (item: CompanionItemDto): string | null => {
  const parts = (item.summary ?? '').split(' · ');
  return parts.length > 1 ? parts[parts.length - 1] : item.summary;
};

// ── placement ───────────────────────────────────────────────────────────────

interface Placement {
  place: CompanionTodayPlace;
  /** Orders the rows of "Waiting on you"; a group takes its smallest. */
  rank: number;
  /** Items of one kind share a row. */
  kind: string;
}

/**
 * Every subtype's place. A kind's rank is about who is blocked, not about
 * which source it came from: a production deployment that failed and a
 * meeting clash in the next two hours come before a review request.
 * Mail (and anything else Michi only read) enters "Waiting on you" solely
 * when a check-in raised it and said why (companionTodayPlace).
 */
const PLACE: Readonly<Record<CompanionItemSubtype, (item: CompanionItemDto) => Placement>> = {
  // What is wrong with it comes from the collector's facts, not from its severity:
  // the backend calls a disabled pipeline urgent too, and that is not a production failure.
  pipeline_blocked: (item) => {
    if (item.facts.failingProd === true) return { place: WAITING, rank: 0, kind: 'pipeline-prod' };
    if (item.facts.disabled === true) return { place: WAITING, rank: 0, kind: 'pipeline-disabled' };
    if (item.facts.approvalsWaiting === true && item.facts.failing !== true) return { place: WAITING, rank: 6, kind: 'pipeline-approve' };
    return { place: WAITING, rank: 6, kind: 'pipeline-fail' };
  },
  calendar_conflict: (item) => ({ place: WAITING, rank: item.severity === 'now' ? 1 : 7, kind: 'conflict' }),
  michi_waiting: () => ({ place: WAITING, rank: 2, kind: 'michi-waiting' }),
  michi_scheduled_failed: () => ({ place: WAITING, rank: 3, kind: 'job-failed' }),
  reminder_due: () => ({ place: WAITING, rank: 3, kind: 'reminder' }),
  cr_needs_attention: () => ({ place: WAITING, rank: 4, kind: 'cr-reply' }),
  email_unread: () => ({ place: ASIDE, rank: 0, kind: 'mail' }),
  cr_review_requested: () => ({ place: WAITING, rank: 8, kind: 'cr-review' }),
  cr_review_stale: () => ({ place: WAITING, rank: 8, kind: 'cr-review' }),
  cr_approved: () => ({ place: MINE, rank: 0, kind: 'cr-approved' }),
  cr_unpublished: () => ({ place: MINE, rank: 1, kind: 'cr-draft' }),
  michi_stalled: () => ({ place: MINE, rank: 2, kind: 'michi-stalled' }),
  cr_stale: () => ({ place: MINE, rank: 3, kind: 'cr-idle' }),
  michi_done: () => ({ place: ASIDE, rank: 1, kind: 'michi-done' }),
  cr_merged: () => ({ place: ASIDE, rank: 2, kind: 'cr-merged' }),
  pipeline_recovered: () => ({ place: ASIDE, rank: 3, kind: 'pipeline-recovered' }),
  meeting_soon: () => ({ place: ASIDE, rank: 4, kind: 'meeting-soon' }),
  system_auth: () => ({ place: HEALTH, rank: 0, kind: 'auth' }),
  system_source_error: () => ({ place: HEALTH, rank: 1, kind: 'source-error' }),
};

/** The items that wait on the user at `now`, without wording their rows: the panel's "Needs you" pill counts the same as Today's header. */
export function companionWaitingItems(items: readonly CompanionItemDto[], now: number): CompanionItemDto[] {
  return items.filter((item) => companionTodayPlace(item, now)?.place === WAITING);
}

/** The rank a raise gives an item: under what is plainly blocked, over the review queue. */
const RAISED_RANK = 5;

/**
 * Where this kind of item goes at `now`; unknown to this window (a newer
 * backend): out of sight, like a muted one. An item a check-in raised today
 * waits on the user whatever its kind, with the reason it gave beside it:
 * that is how anything Michi merely read (mail, a merged CR) reaches "Waiting
 * on you", and it never pushes something plainly blocked down. One that
 * already waits keeps its own kind and row, so a raised production failure
 * still shares the production failures' row, and only climbs. A raise is
 * gone at the local midnight after it (companionItemRaise). A health line is
 * never raised: Michi's own trouble is not the user's work.
 */
export function companionTodayPlace(item: CompanionItemDto, now: number): Placement | null {
  const placement = PLACE[item.subtype]?.(item) ?? null;
  if (!placement || placement.place === HEALTH || !companionItemRaise(item, now)) return placement;
  // Ranks are only comparable inside a place: one from elsewhere takes the raise's own.
  if (placement.place === WAITING) return { ...placement, rank: Math.min(placement.rank, RAISED_RANK) };
  return { place: WAITING, rank: RAISED_RANK, kind: 'raised' };
}

// ── rows ────────────────────────────────────────────────────────────────────

interface Row {
  title: string;
  summary: string | null;
  action: CompanionTodayAction | null;
  meta?: string;
}

interface RowSpec {
  /** One item of this kind. `name` is the agent's, for the rows that quote it. */
  one(item: CompanionItemDto, now: number, name: string): Row;
  /** Several, as one line; absent for a kind that never groups. */
  many?(items: readonly CompanionItemDto[], now: number, name: string): Row;
}

const open = (label: string, item: CompanionItemDto): CompanionTodayAction | null => (item.target ? { kind: 'open', label, item } : null);
const first = (label: string, items: readonly CompanionItemDto[]): CompanionTodayAction | null => {
  const target = items.find((item) => item.target !== null);
  return target ? { kind: 'open', label, item: target } : null;
};
const threadsOf = (item: CompanionItemDto): number => factNumber(item, 'threadsAwaitingYou') ?? 1;

/** What each row of "Waiting on you" says, and the one step it offers. */
const WAITING_ROWS: Readonly<Record<string, RowSpec>> = {
  'pipeline-prod': {
    one: (item) => ({ title: `${pipelineOf(item)} failed in production`, summary: item.summary, action: open('See the failure', item) }),
    many: (items) => ({ title: `${items.length} pipelines failed in production`, summary: list(items.map(pipelineOf)), action: first('See the first', items) }),
  },
  'pipeline-disabled': {
    one: (item) => ({ title: `${pipelineOf(item)} is disabled`, summary: item.summary, action: open('Open the pipeline', item) }),
    many: (items) => ({ title: `${items.length} pipelines are disabled`, summary: list(items.map(pipelineOf)), action: first('Open the first', items) }),
  },
  'pipeline-fail': {
    one: (item) => ({ title: `${pipelineOf(item)} is stuck`, summary: item.summary, action: open('See the failure', item) }),
    many: (items) => ({ title: `${items.length} pipelines are stuck`, summary: list(items.map(pipelineOf)), action: first('See the first', items) }),
  },
  'pipeline-approve': {
    one: (item) => ({ title: `${pipelineOf(item)} waits for a manual approval`, summary: item.summary, action: open('Go approve', item) }),
    many: (items) => ({ title: `${items.length} pipelines wait for a manual approval`, summary: list(items.map(pipelineOf)), action: first('Go approve', items) }),
  },
  conflict: {
    one: (item) => ({
      title: `Two meetings clash at ${item.title.replace(/^Calendar conflict at /, '')}`,
      summary: item.summary,
      action: open('Open the calendar', item),
    }),
    many: (items) => ({
      title: `${items.length} meetings clash in your calendar`,
      summary: list(items.map((item) => item.title.replace(/^Calendar conflict at /, ''))),
      action: first('Open the calendar', items),
    }),
  },
  'michi-waiting': {
    one: (item) => ({ title: item.title, summary: item.summary, action: open(item.facts.wait === 'approval' ? 'Go approve' : 'Go answer', item) }),
    many: (items) => ({
      title: `${items.length} conversations are waiting on you`,
      summary: list(items.map((item) => `${item.title} (${item.facts.wait === 'approval' ? 'approval' : 'answer'})`)),
      action: first('Start with the oldest', items),
    }),
  },
  'job-failed': {
    one: (item) => ({ title: item.title, summary: item.summary, action: open('See the error', item) }),
    many: (items) => ({
      title: `${items.length} scheduled jobs failed`,
      summary: list(items.map((item) => item.title.replace(/^Scheduled job "(.+)" (failed|timed out)$/, '$1'))),
      action: first('See the first error', items),
    }),
  },
  reminder: {
    // A reminder is finished by being acknowledged: Done is the step, not a place to go.
    one: (item) => ({ title: item.title, summary: item.summary, action: { kind: 'done', label: 'Done' } }),
    many: (items) => ({ title: `${items.length} reminders came due`, summary: list(items.map((item) => item.title)), action: null }),
  },
  'cr-reply': {
    one: (item) => ({
      title: item.facts.unresolvedCritical !== null && (factNumber(item, 'unresolvedCritical') ?? 0) > 0 || item.facts.analyzerFailed === true
        ? `${crOf(item)} can’t merge yet`
        : `${crOf(item)} has ${plural(threadsOf(item), 'comment')} waiting for your reply`,
      summary: item.summary,
      action: open('Open the CR', item),
    }),
    many: (items) => ({ title: `${items.length} of your CRs need an answer`, summary: list(items.map(crOf)), action: first('Start with the oldest', items) }),
  },
  // What a check-in raised from elsewhere, in the words its kind already has (waitingEntry puts the reason underneath).
  raised: {
    one: (item, now) => raisedLine(item, now),
    many: (items, now, name) => ({
      title: `${items.length} things ${name} raised`,
      summary: list(items.map((item) => raisedLine(item, now).title)),
      action: first('Open the first', items),
    }),
  },
  'cr-review': {
    one: (item) => ({ title: `${crOf(item)} is waiting for your review`, summary: item.summary, action: open('Review it', item) }),
    many: (items) => ({
      title: `${items.length} of other people’s CRs wait for your review`,
      summary: list(items.map(crOf)),
      meta: spanText(items.map((item) => factNumber(item, 'idleWorkdays')), 'workday'),
      action: first('Start with the oldest', items),
    }),
  },
};

/**
 * A raised item's own words: the compact line its kind gets in "On your
 * plate" or "Everything else", so a raise changes where it sits and why,
 * never what it is called.
 */
function raisedLine(item: CompanionItemDto, now: number): Row {
  const placement = PLACE[item.subtype]?.(item) ?? null;
  const compact = placement ? COMPACT[placement.kind] : undefined;
  if (compact) return compact(item, now);
  return { title: item.title, summary: item.summary, action: open('Open it', item) };
}

/** An item's row with the reason the check-in raised it today in place of its summary, when one holds. */
function withRaise(row: Row, item: CompanionItemDto, now: number, name: string): Row {
  const raise = companionItemRaise(item, now);
  return raise ? { ...row, summary: `${name} raised this — ${raise.reason}` } : row;
}

/** One item of "On your plate" or "Everything else", compact: what it is, and its one step. */
const COMPACT: Readonly<Record<string, (item: CompanionItemDto, now: number) => { title: string; summary: string | null; meta: string; action: CompanionTodayAction | null }>> = {
  'cr-approved': (item, now) => ({ title: crOf(item), summary: lastClause(item), meta: companionAgo(item.changedAt, now), action: open('Merge it', item) }),
  'cr-draft': (item, now) => ({ title: crOf(item), summary: lastClause(item), meta: companionAgo(item.changedAt, now), action: open('Publish it', item) }),
  'michi-stalled': (item) => ({
    title: item.title,
    summary: (item.summary ?? '').split(' · ').slice(1).join(' · ') || item.summary,
    meta: spanText([factNumber(item, 'waitingDays')], 'day'),
    action: open('Back to it', item),
  }),
  'cr-idle': (item) => ({
    title: crOf(item),
    summary: lastClause(item),
    meta: spanText([factNumber(item, 'idleWorkdays')], 'workday'),
    action: open('Open the CR', item),
  }),
  mail: (item, now) => ({ title: mailTopic(item), summary: mailSender(item), meta: companionAgo(item.changedAt, now), action: open('Open the mail', item) }),
  'michi-done': (item, now) => ({ title: item.title, summary: item.summary, meta: companionAgo(item.changedAt, now), action: open('See the result', item) }),
  'cr-merged': (item, now) => ({ title: crOf(item), summary: lastClause(item), meta: companionAgo(item.changedAt, now), action: open('Open the CR', item) }),
  'pipeline-recovered': (item, now) => ({ title: pipelineOf(item), summary: item.summary, meta: companionAgo(item.changedAt, now), action: open('Open the pipeline', item) }),
  'meeting-soon': (item, now) => ({ title: item.title, summary: item.summary, meta: companionItemTime(item, now), action: open('Open the calendar', item) }),
};

/** The folded line each kind of "On your plate" gets. */
const MINE_FOLDS: Readonly<Record<string, (items: readonly CompanionItemDto[], now: number) => { summary: string; meta: string }>> = {
  'cr-approved': (items, now) => ({
    summary: `${items.length} of your CRs ${items.length === 1 ? 'is' : 'are'} approved and not merged`,
    meta: companionAgo(Math.min(...items.map((item) => item.changedAt)), now),
  }),
  'cr-draft': (items) => ({
    summary: `${plural(items.length, 'draft')} of your own ${items.length === 1 ? 'is' : 'are'} not published`,
    meta: '',
  }),
  'michi-stalled': (items) => ({
    summary: `${plural(items.length, 'conversation')} you haven’t answered`,
    meta: spanText(items.map((item) => factNumber(item, 'waitingDays')), 'day'),
  }),
  'cr-idle': (items) => ({
    summary: `${items.length} of your CRs ${items.length === 1 ? 'has' : 'have'} had no activity`,
    meta: spanText(items.map((item) => factNumber(item, 'idleWorkdays')), 'workday'),
  }),
};

/** The line a group of "Everything else" gets when more than one item shares a kind. */
const ASIDE_GROUPS: Readonly<Record<string, (items: readonly CompanionItemDto[]) => string>> = {
  'michi-done': (items) => `${items.length} conversations finished`,
  'cr-merged': (items) => `${items.length} CRs merged`,
  'pipeline-recovered': (items) => `${items.length} pipelines recovered`,
  'meeting-soon': (items) => `${items.length} meetings start soon`,
};

// ── health ──────────────────────────────────────────────────────────────────

const SOURCE_WORDS: Readonly<Record<CompanionConfigurableSource, string>> = Object.freeze({
  michi: 'Michi conversations', cr: 'CRs', pipeline: 'pipelines', email: 'mail', calendar: 'calendar',
});

/** The sources Auth's session stands in front of (the local conversations need none). */
const AUTH_SOURCES: readonly CompanionConfigurableSource[] = Object.freeze(['cr', 'pipeline', 'email', 'calendar']);

const CHECKIN_KINDS: ReadonlySet<CompanionCheckinKind> = new Set(COMPANION_CHECKIN_KINDS);
const isCheckin = (run: CompanionRunDto): boolean => CHECKIN_KINDS.has(run.kind as CompanionCheckinKind);

/** The first sentence of a run's detail, so a health line stays one line. */
function firstSentence(detail: string): string {
  const text = detail.replace(/\s+/g, ' ').trim();
  const end = text.search(/[.!?](\s|$)/);
  return end > 0 ? text.slice(0, end) : text;
}

/**
 * Michi could not think: the latest check-in that finished ended in an error,
 * and so did the ones before it. The count and the time come from the
 * activity the snapshot carries (its latest runs), so a window that covers
 * every run it has says "at least".
 */
function cannotThink(activity: readonly CompanionRunDto[], now: number): CompanionTodayHealth | null {
  const checkins = activity.filter((run) => isCheckin(run) && run.finishedAt !== null)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (checkins.length === 0 || checkins[0].outcome !== 'error') return null;
  const failed = [];
  for (const run of checkins) {
    if (run.outcome !== 'error') break;
    failed.push(run);
  }
  const oldest = failed[failed.length - 1];
  const since = new Date(oldest.startedAt).toDateString() === new Date(now).toDateString()
    ? companionClock(oldest.startedAt)
    : companionAgo(oldest.startedAt, now);
  const count = failed.length === checkins.length ? `at least ${plural(failed.length, 'check-in')}` : plural(failed.length, 'check-in');
  const why = oldest.detail ? `: ${firstSentence(oldest.detail)}` : '';
  return {
    key: 'cannot-think',
    text: `Michi hasn’t been able to think since ${since} — ${count} failed${why}. What follows is ranked by rule, not chosen by Michi.`,
    remedy: { kind: 'settings', label: 'Open settings' },
  };
}

/** Which source a trouble item is about, and why it is in trouble, in a few words. */
function sourceTrouble(item: CompanionItemDto): { kind: CompanionConfigurableSource | null; word: string; why: string } {
  const raw = factText(item, 'source');
  const kind = raw !== null && raw in SOURCE_WORDS ? raw as CompanionConfigurableSource : null;
  const error = factText(item, 'error');
  const why = error === 'timeout' ? 'it took too long'
    : item.summary ? firstSentence(item.summary).replace(/^[A-Z]/, (letter) => letter.toLowerCase())
      : 'the reason is unclear';
  return { kind, word: kind ? SOURCE_WORDS[kind] : item.title.replace(/^Couldn’t check your /, ''), why };
}

function healthLines(items: readonly CompanionItemDto[], settings: CompanionSettings, activity: readonly CompanionRunDto[], now: number): CompanionTodayHealth[] {
  const lines: CompanionTodayHealth[] = [];
  if (items.some((item) => item.subtype === 'system_auth')) {
    const blocked = AUTH_SOURCES.filter((kind) => settings.sources[kind].enabled).map((kind) => SOURCE_WORDS[kind]);
    lines.push({
      key: 'auth',
      text: `Auth expired, so Michi can’t see your ${andList(blocked)}. Refresh your credentials, then check again.`,
      remedy: { kind: 'check', label: 'Check again' },
    });
  }
  const think = cannotThink(activity, now);
  if (think) lines.push(think);
  const troubles = items.filter((item) => item.subtype === 'system_source_error').map(sourceTrouble);
  if (troubles.length === 1) {
    lines.push({
      key: 'source-error',
      text: `Michi can’t check your ${troubles[0].word} right now: ${troubles[0].why}.`,
      remedy: { kind: 'check', label: 'Try again', ...(troubles[0].kind ? { sources: [troubles[0].kind] } : {}) },
    });
  } else if (troubles.length > 1) {
    lines.push({
      key: 'source-error',
      text: `Michi can’t check ${troubles.length} sources right now: ${list(troubles.map((trouble) => `${trouble.word} (${trouble.why})`))}.`,
      remedy: { kind: 'check', label: 'Try them all', sources: troubles.map((trouble) => trouble.kind).filter((kind): kind is CompanionConfigurableSource => kind !== null) },
    });
  }
  return lines;
}

// ── the view ────────────────────────────────────────────────────────────────

const byAge = (a: CompanionItemDto, b: CompanionItemDto) => a.changedAt - b.changedAt;

function group(items: readonly CompanionItemDto[], now: number): Map<CompanionTodayPlace, Map<string, { rank: number; items: CompanionItemDto[] }>> {
  const places = new Map<CompanionTodayPlace, Map<string, { rank: number; items: CompanionItemDto[] }>>();
  for (const item of items) {
    const placement = companionTodayPlace(item, now);
    if (!placement) continue;
    const kinds = places.get(placement.place) ?? new Map();
    places.set(placement.place, kinds);
    const kind = kinds.get(placement.kind) ?? { rank: placement.rank, items: [] };
    // A kind's rank is the most urgent of its items (a clash in two hours pulls its row up).
    kind.rank = Math.min(kind.rank, placement.rank);
    kind.items.push(item);
    kinds.set(placement.kind, kind);
  }
  for (const kinds of places.values()) for (const kind of kinds.values()) kind.items.sort(byAge);
  return places;
}

function compactEntry(kind: string, item: CompanionItemDto, now: number): CompanionTodayEntry {
  const spec = COMPACT[kind](item, now);
  return { key: `${kind}:${item.id}`, kind, items: [item], title: spec.title, summary: spec.summary, meta: spec.meta, action: spec.action, now: item.severity === 'now', members: null };
}

function waitingEntry(kind: string, items: readonly CompanionItemDto[], now: number, name: string): CompanionTodayEntry | null {
  const spec = WAITING_ROWS[kind];
  if (!spec) return null;
  const one = (item: CompanionItemDto) => withRaise(spec.one(item, now, name), item, now, name);
  const single = items.length === 1;
  const row = single ? one(items[0]) : spec.many?.(items, now, name);
  if (!row) return null;
  return {
    key: kind,
    kind,
    items: [...items],
    title: row.title,
    summary: row.summary,
    meta: row.meta ?? (single ? companionItemTime(items[0], now) : companionAgo(Math.max(...items.map((item) => item.changedAt)), now)),
    action: row.action,
    now: items.some((item) => item.severity === 'now'),
    members: single ? null : items.map((item) => {
      const member = one(item);
      return { key: `${kind}:${item.id}`, kind, items: [item], title: member.title, summary: member.summary, meta: companionItemTime(item, now), action: member.action, now: item.severity === 'now', members: null };
    }),
  };
}

/** One sender's mail, or (for a single mail) that mail's own row. */
function mailEntries(items: readonly CompanionItemDto[], now: number): CompanionTodayEntry[] {
  const bySender = new Map<string, CompanionItemDto[]>();
  for (const item of items) {
    const sender = mailSender(item);
    bySender.set(sender, [...(bySender.get(sender) ?? []), item]);
  }
  const senders = [...bySender.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const entries: CompanionTodayEntry[] = [];
  const singles: CompanionItemDto[] = [];
  for (const [sender, mail] of senders) {
    if (mail.length === 1) {
      singles.push(mail[0]);
      continue;
    }
    entries.push({
      key: `mail:${sender}`,
      kind: 'mail',
      items: [...mail],
      title: sender,
      summary: list([...new Set(mail.map(mailTopic))].slice(0, 3)),
      meta: plural(mail.length, 'mail'),
      action: { kind: 'done', label: 'Clear them all' },
      now: false,
      members: mail.map((item) => compactEntry('mail', item, now)),
    });
  }
  // Mail from one person each: one line together, so a single human sender is not a group of one.
  if (singles.length === 1) entries.push({ ...compactEntry('mail', singles[0], now), title: mailSender(singles[0]), summary: mailTopic(singles[0]) });
  else if (singles.length > 1) {
    entries.push({
      key: 'mail:single-senders',
      kind: 'mail',
      items: singles,
      title: `${singles.length} mails, one from each sender`,
      summary: list(singles.map(mailSender)),
      meta: plural(singles.length, 'mail'),
      action: { kind: 'done', label: 'Clear them all' },
      now: false,
      members: singles.map((item) => ({ ...compactEntry('mail', item, now), title: mailSender(item), summary: mailTopic(item) })),
    });
  }
  return entries;
}

export interface CompanionTodayInput {
  items: readonly CompanionItemDto[];
  settings: CompanionSettings;
  activity: readonly CompanionRunDto[];
}

/** Everything Today draws, from the snapshot it already has. */
export function companionTodayView(input: CompanionTodayInput, now: number): CompanionTodayView {
  const places = group(input.items, now);
  const name = input.settings.displayName;

  const waitingKinds = [...(places.get(WAITING)?.entries() ?? [])]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => a.rank - b.rank || Math.max(...b.items.map((item) => item.changedAt)) - Math.max(...a.items.map((item) => item.changedAt)));
  const waitingRows = waitingKinds.map((kind) => waitingEntry(kind.kind, kind.items, now, name)).filter((entry): entry is CompanionTodayEntry => entry !== null);
  const rows = waitingRows.slice(0, COMPANION_TODAY_ROWS);
  const spill = waitingRows.slice(COMPANION_TODAY_ROWS);
  const count = (entries: readonly CompanionTodayEntry[]) => entries.reduce((total, entry) => total + entry.items.length, 0);

  const mineKinds = [...(places.get(MINE)?.entries() ?? [])]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => a.rank - b.rank);
  const folds = mineKinds.map((kind): CompanionTodayFold => {
    const line = MINE_FOLDS[kind.kind](kind.items, now);
    return { key: `mine:${kind.kind}`, summary: line.summary, meta: line.meta, count: kind.items.length, entries: kind.items.map((item) => compactEntry(kind.kind, item, now)) };
  });

  const asideKinds = [...(places.get(ASIDE)?.entries() ?? [])]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => a.rank - b.rank);
  const aside: CompanionTodayEntry[] = [];
  for (const kind of asideKinds) {
    if (kind.kind === 'mail') {
      aside.push(...mailEntries(kind.items, now));
      continue;
    }
    if (kind.items.length === 1) {
      aside.push(compactEntry(kind.kind, kind.items[0], now));
      continue;
    }
    aside.push({
      key: `aside:${kind.kind}`,
      kind: kind.kind,
      items: [...kind.items],
      title: ASIDE_GROUPS[kind.kind](kind.items),
      summary: list(kind.items.map((item) => COMPACT[kind.kind](item, now).title)),
      meta: '',
      action: { kind: 'done', label: 'Clear them all' },
      now: false,
      members: kind.items.map((item) => compactEntry(kind.kind, item, now)),
    });
  }

  const looks = input.activity.filter((run) => isCheckin(run) && (run.outcome === 'spoke' || run.outcome === 'quiet'));
  return {
    health: healthLines(input.items, input.settings, input.activity, now),
    waiting: { count: count(waitingRows), rows, spill, spillCount: count(spill) },
    mine: { count: folds.reduce((total, fold) => total + fold.count, 0), folds },
    aside: { count: count(aside), entries: aside },
    lastLookAt: looks.length > 0 ? Math.max(...looks.map((run) => run.finishedAt ?? run.startedAt)) : null,
  };
}

/** The header over the rows: what waits, counted from the rows themselves. */
export function companionTodayHeadline(waiting: number): string {
  if (waiting === 0) return 'Nothing is waiting on you';
  return `${waiting} ${waiting === 1 ? 'thing' : 'things'} waiting on you`;
}
