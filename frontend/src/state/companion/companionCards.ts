import { DEFAULT_COMPANION_NAME, companionCardButtonLabel, parseCompanionSessionSendCardPayload } from 'michi-shared';
import type {
  ChatPermissionChoice,
  CompanionCardDto,
  CompanionConfigurableSource,
  CompanionGoalDto,
  CompanionItemDto,
  CompanionSettings,
} from 'michi-shared';

/**
 * What a proposal card's Apply will do, from its stored payload: exactly what
 * the backend re-validates and runs on Apply (cards.ts), in plain words, so
 * the user reads the whole change before approving it (DESIGN R2.1). The
 * summary is Michi's headline and clips long text (a conversation's brief,
 * new rules, a goal); this shows all of it. Pure: the card strip renders it.
 */

export type CompanionCardPart =
  /** A sentence saying what Apply does. */
  | { kind: 'lead'; text: string }
  /** Exact text Apply writes or sends, shown in full. */
  | { kind: 'text'; label: string | null; text: string }
  /** Short facts (a time, a workspace, before → after). */
  | { kind: 'fields'; rows: ReadonlyArray<{ label: string; value: string }> }
  /** The user's rules now against the rules after Apply, line by line. */
  | { kind: 'diff'; lines: readonly CompanionDiffLine[] }
  | { kind: 'note'; text: string };

export interface CompanionDiffLine {
  change: 'same' | 'added' | 'removed';
  text: string;
}

export interface CompanionCardPreview {
  parts: CompanionCardPart[];
  /** The Apply button's words. */
  applyLabel: string;
}

/** What the window knows to word a card with: the snapshot, and the workspace names it has. */
export interface CompanionCardContext {
  goals: readonly Pick<CompanionGoalDto, 'id' | 'text'>[];
  items: readonly Pick<CompanionItemDto, 'id' | 'title'>[];
  rules: string;
  /** `displayName` names the agent in the leads (DESIGN-v2 §1.5); the default name without it. */
  settings: Pick<CompanionSettings, 'heartbeat' | 'brief' | 'quietHours' | 'sources'> & Partial<Pick<CompanionSettings, 'displayName'>>;
  workspaceName(id: string): string | null;
}

const agentName = (context: CompanionCardContext): string => context.settings.displayName?.trim() || DEFAULT_COMPANION_NAME;

const SOURCE_NAMES: ReadonlyMap<string, string> = new Map<CompanionConfigurableSource, string>([
  ['michi', 'Michi conversations'], ['cr', 'Code reviews'], ['pipeline', 'Pipelines'], ['email', 'Email'], ['calendar', 'Calendar'],
]);

/**
 * What a conversation's permission choice means for a follow-up sent into it
 * (DESIGN-v2 §4: "Runs in Trust: its tools run without asking"), in the
 * words of the approval Michi asks for in the user's own turn
 * (backend services/companion/sessionSend.ts companionTargetPermissionLine).
 */
const RUNS_IN: Readonly<Record<ChatPermissionChoice, string>> = {
  ask: 'Ask: its tools ask you before they run',
  approve: 'Ask with Approve for me: its classifier approves some tools without asking you',
  trust: 'Trust: its tools run without asking',
  yolo: 'YOLO: everything it does runs without asking',
};

const WATCH_PHRASES: ReadonlyMap<string, string> = new Map([
  ['approved', 'is approved'], ['merged', 'is merged'], ['recovered', 'recovers'], ['read', 'is read'], ['answered', 'is answered'],
]);

type Payload = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
/** Each field present has the type it must have. */
const typed = (value: Payload, types: Record<string, 'boolean' | 'number' | 'string'>): boolean => (
  Object.entries(types).every(([key, type]) => value[key] === undefined || typeof value[key] === type)
);

function everyMinutes(minutes: number): string {
  if (minutes % 60 !== 0) return `Every ${minutes} min`;
  return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
}

function checkIns(value: { enabled: boolean; intervalMinutes: number }): string {
  return value.enabled ? everyMinutes(value.intervalMinutes) : 'Off';
}

function briefAt(value: { enabled: boolean; time: string }): string {
  return value.enabled ? `At ${value.time}` : 'Off';
}

function quietHours(value: { enabled: boolean; start: string; end: string }): string {
  return value.enabled ? `${value.start} to ${value.end}` : 'Off';
}

/** A one-off reminder's moment, as a date and a time in this window's locale. */
function moment(at: number): string {
  const date = new Date(at);
  const day = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `${day} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function itemTitle(context: CompanionCardContext, id: string): string {
  return context.items.find((item) => item.id === id)?.title ?? `An item no longer in your feed (${id})`;
}

function goalText(context: CompanionCardContext, id: string): string | null {
  return context.goals.find((goal) => goal.id === id)?.text ?? null;
}

const MAX_DIFF_CELLS = 250_000;

function lines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n');
}

/** A line diff (longest common subsequence): what stays, what goes, what comes in. */
export function companionLineDiff(before: string, after: string): CompanionDiffLine[] {
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [...a.map((text) => ({ change: 'removed' as const, text })), ...b.map((text) => ({ change: 'added' as const, text }))];
  }
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const out: CompanionDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ change: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      out.push({ change: 'removed', text: a[i] });
      i += 1;
    } else {
      out.push({ change: 'added', text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ change: 'removed', text: a[i] });
  for (; j < b.length; j += 1) out.push({ change: 'added', text: b[j] });
  return out;
}

/** A payload this window cannot word (a kind it does not know, or a shape it does not expect): shown as it is. */
function raw(payload: Payload): CompanionCardPreview {
  return {
    parts: [{ kind: 'lead', text: 'Apply sends this change as it is:' }, { kind: 'text', label: null, text: JSON.stringify(payload, null, 2) }],
    applyLabel: 'Apply',
  };
}

function preview(parts: CompanionCardPart[], applyLabel = 'Apply'): CompanionCardPreview {
  return { parts, applyLabel };
}

export function companionCardPreview(card: Pick<CompanionCardDto, 'kind' | 'payload'>, context: CompanionCardContext): CompanionCardPreview {
  const payload = isRecord(card.payload) ? card.payload : {};
  switch (card.kind) {
    case 'conversation.start': {
      const { workspaceId, title, text } = payload;
      if (!isString(workspaceId) || !isString(title) || !isString(text)) return raw(payload);
      const workspace = context.workspaceName(workspaceId) ?? workspaceId;
      return preview([
        { kind: 'lead', text: `Starts a new conversation in “${workspace}” titled “${title}” and sends this as your first message:` },
        { kind: 'text', label: null, text },
        { kind: 'note', text: 'It runs with your usual runtime and permission settings, like a conversation you start yourself.' },
      ], companionCardButtonLabel('conversation.start'));
    }
    case 'rules.update': {
      const { rules } = payload;
      if (!isString(rules)) return raw(payload);
      if (rules === '') {
        return preview(context.rules === ''
          ? [{ kind: 'lead', text: 'Clears your rules. You have none now.' }]
          : [{ kind: 'lead', text: 'Clears your rules. All of these go:' }, { kind: 'diff', lines: companionLineDiff(context.rules, '') }]);
      }
      if (context.rules === '') return preview([{ kind: 'lead', text: 'Sets your rules (you have none now) to:' }, { kind: 'text', label: null, text: rules }]);
      return preview([
        { kind: 'lead', text: 'Replaces all of your rules. − lines go, + lines come in:' },
        { kind: 'diff', lines: companionLineDiff(context.rules, rules) },
      ]);
    }
    case 'goal.add': {
      if (!isString(payload.text)) return raw(payload);
      return preview([{ kind: 'lead', text: 'Adds this goal:' }, { kind: 'text', label: null, text: payload.text }]);
    }
    case 'goal.update': {
      const { goalId, text } = payload;
      if (!isString(goalId) || !isString(text)) return raw(payload);
      const current = goalText(context, goalId);
      return preview([
        { kind: 'lead', text: 'Changes one of your goals.' },
        { kind: 'text', label: 'Now', text: current ?? 'That goal no longer exists: Apply will fail.' },
        { kind: 'text', label: 'After', text },
      ]);
    }
    case 'goal.remove': {
      if (!isString(payload.goalId)) return raw(payload);
      const current = goalText(context, payload.goalId);
      return preview(current === null
        ? [{ kind: 'lead', text: 'Removes a goal that no longer exists: Apply will fail.' }]
        : [{ kind: 'lead', text: 'Removes this goal:' }, { kind: 'text', label: null, text: current }]);
    }
    case 'reminder.add': {
      const { text, at, dailyAt, itemId } = payload;
      if (!isString(text) || (typeof at !== 'number' && !isString(dailyAt)) || (itemId !== undefined && !isString(itemId))) return raw(payload);
      const rows = [{ label: 'When', value: typeof at === 'number' ? moment(at) : `Every workday at ${dailyAt as string}` }];
      if (isString(itemId)) rows.push({ label: 'About', value: itemTitle(context, itemId) });
      return preview([
        { kind: 'lead', text: 'Adds a reminder.' },
        { kind: 'fields', rows },
        { kind: 'text', label: 'Reminder', text },
      ]);
    }
    case 'watch.add': {
      const { itemId, until } = payload;
      const phrase = isString(until) ? WATCH_PHRASES.get(until) : undefined;
      if (!isString(itemId) || !phrase) return raw(payload);
      return preview([
        { kind: 'lead', text: `Watches this item and tells you when it ${phrase}:` },
        { kind: 'text', label: null, text: itemTitle(context, itemId) },
      ]);
    }
    case 'checkins.update': {
      const { heartbeat, brief } = payload;
      if ((heartbeat !== undefined && !(isRecord(heartbeat) && typed(heartbeat, { enabled: 'boolean', intervalMinutes: 'number' })))
        || (brief !== undefined && !(isRecord(brief) && typed(brief, { enabled: 'boolean', time: 'string' })))
        || (!heartbeat && !brief)) return raw(payload);
      const rows: Array<{ label: string; value: string }> = [];
      if (heartbeat) {
        const now = context.settings.heartbeat;
        const after = { ...now, ...heartbeat } as typeof now;
        rows.push({ label: 'Check-ins', value: `${checkIns(now)} → ${checkIns(after)}` });
      }
      if (brief) {
        const now = context.settings.brief;
        const after = { ...now, ...brief } as typeof now;
        rows.push({ label: 'Morning brief', value: `${briefAt(now)} → ${briefAt(after)}` });
      }
      return preview([{ kind: 'lead', text: `Changes when ${agentName(context)} speaks:` }, { kind: 'fields', rows }]);
    }
    case 'source.update': {
      const { source, enabled } = payload;
      const name = isString(source) ? SOURCE_NAMES.get(source) : undefined;
      if (!name || typeof enabled !== 'boolean') return raw(payload);
      const word = (on: boolean) => (on ? 'Watched' : 'Not watched');
      const now = context.settings.sources[source as CompanionConfigurableSource]?.enabled === true;
      return preview([
        { kind: 'lead', text: enabled ? 'Starts watching a source:' : 'Stops watching a source:' },
        { kind: 'fields', rows: [{ label: name, value: `${word(now)} → ${word(enabled)}` }] },
      ]);
    }
    case 'pipeline.watch': {
      const { add, remove } = payload;
      if ((add !== undefined && !isStringList(add)) || (remove !== undefined && !isStringList(remove))) return raw(payload);
      const rows: Array<{ label: string; value: string }> = [];
      if (add && add.length > 0) rows.push({ label: 'Starts watching', value: add.join(', ') });
      if (remove && remove.length > 0) rows.push({ label: 'Stops watching', value: remove.join(', ') });
      if (rows.length === 0) return raw(payload);
      return preview([{ kind: 'lead', text: `Changes the pipelines ${agentName(context)} watches:` }, { kind: 'fields', rows }]);
    }
    case 'session.send': {
      // DESIGN-v2 §4: the target as it was when proposed (title, workspace, how its tools run) and the
      // exact text, as the worker gets it under the agent's header; Apply re-checks the target.
      const send = parseCompanionSessionSendCardPayload(payload);
      if (!send) return raw(payload);
      const name = agentName(context);
      return preview([
        { kind: 'lead', text: `Sends this follow-up to a conversation ${name} started:` },
        { kind: 'fields', rows: [
          { label: 'Conversation', value: send.title.trim() || 'Untitled conversation' },
          { label: 'Workspace', value: context.workspaceName(send.workspaceId) ?? send.workspaceId },
          { label: 'Runs in', value: RUNS_IN[send.permissionWhenProposed] },
        ] },
        { kind: 'text', label: 'Message', text: send.text },
        { kind: 'note', text: `It arrives marked as from ${name}, with your approval. Nothing is sent if the conversation has moved on or now runs with wider permissions.` },
      ], companionCardButtonLabel('session.send'));
    }
    case 'quiet_hours.update': {
      const { enabled, start, end } = payload;
      if (typeof enabled !== 'boolean' || !typed(payload, { start: 'string', end: 'string' })) return raw(payload);
      const now = context.settings.quietHours;
      const after = { ...now, enabled, ...(isString(start) ? { start } : {}), ...(isString(end) ? { end } : {}) };
      return preview([
        { kind: 'lead', text: 'Changes your quiet hours:' },
        { kind: 'fields', rows: [{ label: 'Quiet hours', value: `${quietHours(now)} → ${quietHours(after)}` }] },
      ]);
    }
    default:
      return raw(payload);
  }
}

// ── Characters the screen does not show ────────────────────────────────────

/**
 * Characters that render as nothing, or reorder what is around them, but
 * that a model reading the text still gets: bidirectional controls,
 * zero-width and other invisible format characters, tag characters (which
 * spell out text no one sees) and the variation selectors of the
 * supplement. Joiners and the emoji variation selectors stay (emoji use them).
 */
const HIDDEN_CHARACTER = /[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

export type CompanionTextPiece =
  | { kind: 'text'; text: string }
  /** A run of characters that would not show, by code point (`U+202E`). */
  | { kind: 'hidden'; codePoints: string[] };

/** The text split so that what would not show can be marked where it is. */
export function companionVisibleText(text: string): CompanionTextPiece[] {
  const pieces: CompanionTextPiece[] = [];
  let plain = '';
  let hidden: string[] = [];
  const flushPlain = () => { if (plain) pieces.push({ kind: 'text', text: plain }); plain = ''; };
  const flushHidden = () => { if (hidden.length > 0) pieces.push({ kind: 'hidden', codePoints: hidden }); hidden = []; };
  for (const char of text) {
    if (HIDDEN_CHARACTER.test(char)) {
      flushPlain();
      hidden.push(`U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    } else {
      flushHidden();
      plain += char;
    }
  }
  flushPlain();
  flushHidden();
  return pieces;
}

/** How many characters of this text would not show. */
export function companionHiddenCharacters(text: string): number {
  let count = 0;
  for (const piece of companionVisibleText(text)) if (piece.kind === 'hidden') count += piece.codePoints.length;
  return count;
}

/** How many characters in the card's texts would not show. */
export function companionHiddenCharacterCount(card: CompanionCardPreview): number {
  let count = 0;
  for (const part of card.parts) {
    if (part.kind === 'lead' || part.kind === 'note' || part.kind === 'text') count += companionHiddenCharacters(part.text);
    else if (part.kind === 'fields') for (const row of part.rows) count += companionHiddenCharacters(row.value);
    else for (const line of part.lines) count += companionHiddenCharacters(line.text);
  }
  return count;
}
