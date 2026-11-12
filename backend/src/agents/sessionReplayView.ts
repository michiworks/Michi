/**
 * The conversation as a rebuilt session replays it (DESIGN-v2 §2.8 T2,
 * §9 risk 11): stored user and assistant messages in order, each posted
 * check-in as Michi's one-line fact instead of its text. Every path that
 * rebuilds a session from stored rows reads this view: chatManager's
 * restore, Pi's restore and its settled-turn checkpoint (the same view, so
 * their hashes line up), and the session registry's ancestor history stubs.
 *
 * Pure and dependency-free: no database, no settings, no clock. The agent's
 * name comes in through `name`, the time format through `formatTime`.
 */

import {
    DEFAULT_COMPANION_NAME,
    companionPostRunId,
    parseCompanionPostMetadata,
    type CompanionPostChange,
    type CompanionPostMetadata,
} from 'michi-shared';

/** A stored message as the view reads it; `id` and `metadata` tell a posted check-in apart. */
export interface ReplayRow {
    id?: string | null;
    role: string;
    content: string | null;
    /** The stored metadata JSON (or an already parsed object). */
    metadata?: string | Record<string, unknown> | null;
    created_at: number;
}

export interface ReplayEntry { role: 'user' | 'assistant'; content: string }

/** A replay entry with the time of the first stored message it holds. */
export interface TimedReplayEntry extends ReplayEntry { created_at: number }

export interface ReplayViewOptions {
    /**
     * Reads the agent's display name. Called at most once per view, and only
     * when a post is replayed; a throw or an empty name gives
     * DEFAULT_COMPANION_NAME. The name is flattened like a title (factText).
     */
    name: () => string | null | undefined;
    formatTime?: (ms: number) => string;
}

function storedMetadata(raw: ReplayRow['metadata']): Record<string, unknown> | null {
    if (!raw) return null;
    if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

const POST_LABEL: Record<CompanionPostMetadata['kind'], string> = {
    heartbeat: 'a check-in',
    wake: 'a check-in',
    catch_up: 'a catch-up',
    brief: 'a morning brief',
    worker_report: 'a worker update',
    welcome: 'a welcome',
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A title for a fact line: no brackets, quotes or line breaks, at most 60 characters. */
function factText(value: string): string {
    const flat = value.replace(/[[\]"\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

const ITEM_VERB: Record<string, string> = { snooze: 'snoozed', dismiss: 'dismissed', restore: 'restored' };
const GOAL_VERB: Record<string, string> = { add: 'added', reword: 'reworded', remove: 'removed' };

/**
 * What a post changed, as Michi's own words: counts, kinds and the titles of
 * pages and databases that existed before the check-in (the metadata
 * carries no other), and the ids of conversations it sent follow-ups to.
 * Never a reason, an item's or goal's text, a conversation's title, or the post's.
 */
function postChangeFacts(changes: readonly CompanionPostChange[]): string {
    const facts: string[] = [];
    const counts = new Map<string, number>();
    const sends = new Map<string, number>();
    for (const change of changes) {
        if (change.kind === 'send') {
            // A follow-up the check-in sent itself (D21): the conversation by id only, as the agent's post facts name it.
            const id = factText(change.id);
            if (id && change.applied > 0) sends.set(id, (sends.get(id) ?? 0) + change.applied);
        } else if (change.kind === 'page' || change.kind === 'database') {
            const unit = change.kind === 'page' ? 'block' : 'row';
            const done = [
                ...(change.applied > 0 ? [`changed ${plural(change.applied, unit)}`] : []),
                ...(change.proposed > 0 ? [`proposed ${plural(change.proposed, 'change')}`] : []),
            ];
            if (!done.length) continue;
            const title = change.title ? factText(change.title) : '';
            const where = change.kind === 'page'
                ? (title ? `on "${title}"` : 'on a page')
                : (title ? `in "${title}"` : 'in a database');
            facts.push(`${done.join(' and ')} ${where}`);
        } else {
            const verb = (change.kind === 'item' ? ITEM_VERB : GOAL_VERB)[change.action ?? ''] ?? 'changed';
            const key = `${verb}\u0000${change.kind}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    for (const [key, count] of counts) {
        const [verb, kind] = key.split('\u0000');
        facts.push(`${verb} ${plural(count, kind === 'item' ? 'Today item' : 'goal')}`);
    }
    for (const [id, count] of sends) facts.push(`sent ${plural(count, 'follow-up')} to conversation ${id}`);
    return facts.join(', ');
}

function localMinute(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The one-line fact a rebuilt session sees instead of a posted check-in
 * (§2.8 T2): its text is check-in material, never replayed. A `cmp-post-`
 * message whose metadata is unreadable is still a post (fail closed).
 */
function postReplayFact(post: CompanionPostMetadata | undefined, createdAt: number, name: string, formatTime: (ms: number) => string = localMinute): string {
    const facts = post ? postChangeFacts(post.changes) : '';
    const what = post ? POST_LABEL[post.kind] ?? 'a check-in' : 'a check-in';
    return `[${name} posted ${what} here at ${formatTime(createdAt)}${facts ? `: ${facts}` : ''}. Read it with companion_read.]`;
}

/** A posted check-in: a `cmp-post-` id or companionPost metadata on an assistant message. */
function isPostedCheckin(row: ReplayRow, metadata: Record<string, unknown> | null): boolean {
    return row.role === 'assistant'
        && (companionPostRunId(row.id ?? null) !== null || (metadata?.companionPost !== undefined && metadata.companionPost !== null));
}

/**
 * The view, with the time of each entry's first stored message. Rows that
 * are neither user nor assistant, and messages with no text, are left out,
 * as every replay path did before. A fact joins the assistant entry before
 * it, and an assistant message joins a fact-only entry before it, so posts
 * never put two assistant entries in a row (Pi replays these as its own
 * turns).
 */
export function sessionReplayRows(rows: readonly ReplayRow[], opts: ReplayViewOptions): TimedReplayEntry[] {
    let name: string | null = null;
    const nameOnce = () => {
        if (name !== null) return name;
        let read: string | null | undefined;
        try { read = opts.name(); } catch { read = null; }
        name = (typeof read === 'string' ? factText(read) : '') || DEFAULT_COMPANION_NAME;
        return name;
    };
    // factOnly: the entry is facts alone; endsWithFact: its last line is one (facts stack line by line).
    const out: Array<TimedReplayEntry & { factOnly?: boolean; endsWithFact?: boolean }> = [];
    for (const row of rows) {
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        const last = out[out.length - 1];
        const metadata = row.role === 'assistant' ? storedMetadata(row.metadata) : null;
        if (isPostedCheckin(row, metadata)) {
            const fact = postReplayFact(parseCompanionPostMetadata(metadata?.companionPost), row.created_at, nameOnce(), opts.formatTime);
            if (last?.role === 'assistant') {
                last.content = [last.content, fact].filter(Boolean).join(last.endsWithFact ? '\n' : '\n\n');
                last.endsWithFact = true;
            } else {
                out.push({ role: 'assistant', content: fact, created_at: row.created_at, factOnly: true, endsWithFact: true });
            }
            continue;
        }
        const content = row.content ?? '';
        if (content.length === 0) continue;
        if (row.role === 'assistant' && last?.role === 'assistant' && last.factOnly) {
            last.content = [last.content, content].filter(Boolean).join('\n\n');
            last.factOnly = false;
            last.endsWithFact = false;
            continue;
        }
        out.push({ role: row.role, content, created_at: row.created_at });
    }
    return out.map(({ role, content, created_at }) => ({ role, content, created_at }));
}

/** The view as a session's replay history (NewAgentSessionOptions.replayHistory). */
export function sessionReplayHistory(rows: readonly ReplayRow[], opts: ReplayViewOptions): ReplayEntry[] {
    return sessionReplayRows(rows, opts).map(({ role, content }) => ({ role, content }));
}
