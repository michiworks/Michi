/**
 * What the user's own turns in their conversation with the agent (V) know
 * about the agent's state (DESIGN-v2 §3.5, §2.8 T1), and what a check-in's
 * note quotes of that conversation (§3.6).
 *
 * withCompanionContext puts [COMPANION CONTEXT] (prompts.ts
 * companionContextText) ahead of a user message; the route calls it
 * (routes/michi.ts through metaAgent/chatTurnContext.ts, W2-E):
 * - every turn carries Michi's facts only: the name and the run time, the
 *   feed in a line, card results and the cards still waiting (kinds, ids,
 *   outcomes), and the record of what check-ins posted since the user's
 *   last message (the repository's untold posts, at most
 *   COMPANION_LIMITS.maxUntoldPosts, marked told once the turn began);
 * - the standing blocks (the user's rules, the goals in the user's own
 *   words, the notes when the user wrote them last, the sources off in
 *   settings) go only on a live session's first turn and when they changed,
 *   the way agents/memoryInjection.ts delivers Michi Memory: tracked per
 *   live AgentSession object (a rebuilt or resumed session is a new object),
 *   delivered only when the turn settles `completed`
 *   (chatHub.whenTurnSettled), and sent again after a compaction in a turn
 *   (or forgetCompanionContext, for a compaction or a command outside one);
 * - when the rules cannot be read, the user's message goes as it is, with
 *   no [COMPANION CONTEXT] (§1.3) and `rulesUnavailable`: the route marks the
 *   message (userMetadata.companionTurn) and the agent's action tools refuse
 *   the turn (tools.ts). Only check-ins fail closed on it.
 * Never a check-in's text: what a check-in wrote reaches a user turn only
 * through the user's eyes or a read that marks the turn untrusted
 * (companion_read, companion_items, companion_item).
 */

import { createHash } from 'node:crypto';
import {
  CHAT_STREAM_EVENTS,
  COMPANION_LIMITS,
  companionPostRunId,
  parseCompanionPostMetadata,
} from 'michi-shared';
import { chatHub, type HubSubscriber, type SettledTurnStatus } from '../../agents/chatHub';
import type { AgentSession } from '../../agents/types';
import { getDb } from '../db';
import { log } from '../logger';
import { readConversationMemoryMode } from '../memory/memoryRepository';
import { withoutCredentials } from '../memory/secrets';
import { getTurnTrust, isCompanionMaterial } from '../turnTrust';
import { localDateKey } from './clock';
import { companionContextStanding, companionContextText, type CompanionContextInput, type CompanionConversationLine } from './prompts';
import * as repository from './repository';
import { companionSourcesOff, getCompanionSettings } from './settings';

// ── What the route gets ─────────────────────────────────────────────────────

export interface CompanionContextOptions {
  /** The conversation the message is for (V). */
  nodeId: string;
  /** The live runtime session the turn runs on; without one the standing blocks go every turn. */
  session?: AgentSession | null;
  now?: number;
}

export interface CompanionTurnContext {
  /** What the runtime receives: [COMPANION CONTEXT], then the text it was given; just that text when the rules could not be read. */
  text: string;
  /** The user's rules could not be read: no [COMPANION CONTEXT], and the action tools refuse this turn (§1.3). */
  rulesUnavailable: boolean;
  /** Call once the turn began: the card results it carried count as told. */
  reportCards(): void;
  /** Call once the turn began: the posts it listed count as told (repository markPostsTold). */
  markPostsTold(): void;
  /**
   * Call once the turn began, with its id: when it settles `completed`
   * (chatHub.whenTurnSettled) the standing blocks it carried count as held
   * by the session, and a compaction during it makes the next turn send
   * them again. Without a turn id: the caller says the turn completed now.
   * Resolves once that is recorded; never rejects.
   */
  delivered(turnId?: string): Promise<void>;
}

// ── Dependencies (tests set fakes) ──────────────────────────────────────────

export interface CompanionTurnContextDeps {
  /** chatHub's turn settling and replay (default: the process's chatHub). */
  hub?: Pick<typeof chatHub, 'whenTurnSettled' | 'subscribeTurn'>;
}

let deps: CompanionTurnContextDeps = {};

/**
 * Tests set fakes; replaces what was set.
 * @testonly
 */
export function setCompanionTurnContextDeps(next: CompanionTurnContextDeps): void {
  deps = { ...next };
}

function hub(): Pick<typeof chatHub, 'whenTurnSettled' | 'subscribeTurn'> {
  return deps.hub ?? chatHub;
}

// ── Standing blocks per live session ────────────────────────────────────────

interface SessionStanding {
  /** The standing blocks the session holds (their hash); null: none, or they may be gone. */
  held: string | null;
  /** Bumped by forgetCompanionContext: a turn begun before then delivers nothing. */
  epoch: number;
}

const sessions = new WeakMap<object, SessionStanding>();

/** The session may no longer hold the standing blocks (a compaction, /clear): its next turn sends them again. */
export function forgetCompanionContext(session: AgentSession): void {
  const state = sessions.get(session);
  if (!state) return;
  state.held = null;
  state.epoch += 1;
}

const COMPACTION_EVENTS: ReadonlySet<string> = new Set([CHAT_STREAM_EVENTS.compactionStart, CHAT_STREAM_EVENTS.compactionEnd]);

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

// ── The context ─────────────────────────────────────────────────────────────

const NOOP_CONTEXT = { reportCards() {}, markPostsTold() {}, delivered: async () => {} };

/**
 * A user's own message to the agent with [COMPANION CONTEXT] ahead of it
 * (see the module comment). Never throws for the rules: when they cannot be
 * read the text goes as it is, with rulesUnavailable.
 */
export function withCompanionContext(text: string, options: CompanionContextOptions): CompanionTurnContext {
  const now = options.now ?? Date.now();
  const rules = repository.readCompanionRules();
  if (!rules.ok) return { text, rulesUnavailable: true, ...NOOP_CONTEXT };
  const settings = getCompanionSettings();
  const notes = repository.getCompanionNotesState();
  const standingInput = {
    now,
    rules: rules.rules,
    goals: repository.listGoals(),
    notes: notes.notes,
    notesRevision: notes.notesRevision,
    notesOrigin: notes.origin,
    offSources: companionSourcesOff(settings),
  } satisfies Partial<CompanionContextInput>;
  const fingerprint = hashOf(companionContextStanding(standingInput).join('\n\n'));
  const session = options.session ?? null;
  const state = session ? sessions.get(session) : undefined;
  const standing = !state || state.held !== fingerprint;

  const cards = repository.listUnreportedCards();
  const waiting = repository.listPendingCards(now).map(repository.cardDto);
  const posts = repository.listUntoldPosts(COMPANION_LIMITS.maxUntoldPosts).slice(0, COMPANION_LIMITS.maxUntoldPosts);
  const counts = repository.countOpenItems(now);
  const brief = repository.briefForDate(localDateKey(now));
  const prefix = companionContextText({
    ...standingInput,
    displayName: settings.displayName,
    cardResults: cards.map(repository.cardDto),
    waitingCards: waiting,
    needsYou: counts.needsYou,
    newItems: counts.newItems,
    pendingCards: waiting.length,
    briefPublishedAt: brief?.createdAt ?? null,
    posts,
    standing,
  });

  let reported = false;
  let told = false;
  let watched = false;
  return {
    text: `${prefix}\n\n${text}`,
    rulesUnavailable: false,
    reportCards: () => {
      if (reported || cards.length === 0) return;
      reported = true;
      repository.markCardsReported(cards.map((card) => card.id), now);
    },
    markPostsTold: () => {
      if (told || posts.length === 0) return;
      told = true;
      repository.markPostsTold(posts.map((post) => post.runId), now);
    },
    delivered: async (turnId) => {
      if (!session || watched) return;
      watched = true;
      let current = sessions.get(session);
      if (!current) {
        current = { held: null, epoch: 0 };
        sessions.set(session, current);
      }
      const epoch = current.epoch;
      const target = current;
      const commit = () => {
        if (standing && sessions.get(session) === target && target.epoch === epoch) target.held = fingerprint;
      };
      if (!turnId) return commit();
      try {
        let compacted = false;
        const subscriber: HubSubscriber = {
          send: (event) => { if (COMPACTION_EVENTS.has(event.event)) compacted = true; },
          close: () => {},
        };
        const stop = hub().subscribeTurn(options.nodeId, turnId, subscriber);
        let status: SettledTurnStatus | null;
        try {
          status = await hub().whenTurnSettled(turnId);
        } finally {
          stop?.();
        }
        if (compacted) forgetCompanionContext(session);
        else if (status === 'completed') commit();
      } catch (error) {
        log.warn('chat', 'Companion context delivery not recorded', { turnId, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

// ── A check-in's view of the conversation (§3.6) ────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

interface MessageRow {
  id: string;
  role: string;
  content: string | null;
  metadata: string | null;
  created_at: number;
  turnId: string | null;
  hidden: number | null;
}

function metadataOf(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The conversation's latest messages for a check-in's [RECENT CONVERSATION]
 * (§3.6), oldest first: the user's words (a message's own text, never its
 * quote or attachments, which live in metadata) and the agent's final
 * replies (a message's text, never its tool calls and tool output, which
 * live in blocks and tool_calls), the posted ones and Michi's narration
 * marked. At most COMPANION_LIMITS.recentConversationMessages; the note
 * caps their length (prompts.ts). W2-G1a passes it to composeCompanionTurn.
 *
 * It follows Michi Memory's Recent conversations: nothing while the
 * conversation does not learn (Use only, Off), nothing from a turn the user
 * kept out of recall (Don't recall, leaving learn, Delete all), no reply of a
 * turn that read outside content other than Companion material (the user's
 * words stay), and no credentials.
 */
export function recentConversationExcerpt(nodeId: string, limit: number = COMPANION_LIMITS.recentConversationMessages): CompanionConversationLine[] {
  if (readConversationMemoryMode(nodeId) !== 'learn') return [];
  const rows = getDb().prepare(`SELECT m.id, m.role, m.content, m.metadata, m.created_at, t.turn_id AS turnId,
      (SELECT MAX(d.hidden) FROM memory_recall_docs d WHERE d.node_id = m.node_id AND d.turn_id = t.turn_id AND d.doc_kind = 'turn') AS hidden
    FROM messages m LEFT JOIN turns t ON t.node_id = m.node_id AND (t.user_message_id = m.id OR t.assistant_message_id = m.id)
    WHERE m.node_id = ? AND m.role IN ('user', 'assistant') ORDER BY m.seq DESC LIMIT ?`)
    .all(nodeId, Math.max(1, limit) * 4) as unknown as MessageRow[];
  const lines: CompanionConversationLine[] = [];
  for (const row of rows) {
    if (lines.length >= limit) break;
    if (row.hidden === 1) continue;
    const text = withoutCredentials((row.content ?? '').trim()).trim();
    if (!text) continue;
    const role = row.role === 'user' ? 'user' : 'assistant';
    const metadata = metadataOf(row.metadata);
    const posted = role === 'assistant' && (parseCompanionPostMetadata(metadata.companionPost) !== undefined
      || companionPostRunId(row.id) !== null || metadata.metaAgentNarration !== undefined || row.id.startsWith('mna-'));
    if (role === 'assistant' && !posted && row.turnId && readOutsideContent({ nodeId, turnId: row.turnId })) continue;
    lines.push({ role, at: row.created_at, text, ...(posted ? { posted: true } : {}) });
  }
  return lines.reverse();
}

/** The turn took in untrusted content that is not Companion material (the web, shell output, other tools). */
function readOutsideContent(ref: { nodeId: string; turnId: string }): boolean {
  return getTurnTrust(ref).sources.some((source) => !isCompanionMaterial(source));
}
