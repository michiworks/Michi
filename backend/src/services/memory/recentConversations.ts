import { isSystemWorkspaceSettings } from 'michi-shared';
import { prepareCached } from '../db';
import { getAiGlobalContext } from '../dbRepository';
import { recallableWorkspaces, turnUserWords } from './recallIndex';

/**
 * The memory pack's "Recent conversations" (contextBuilder.ts), as ChatGPT's
 * recent conversation content and Gemini's recent turns: what the user typed
 * in their most recent other conversations, newest conversation first,
 * whether or not automatic extraction has read it. It spans the user's
 * workspaces, as ChatGPT's projects and Gemini share recent chats by default:
 * every workspace recall may read (recallIndex.recallableWorkspaces: this one,
 * and every other one neither in Trash, nor a system workspace but the
 * assistant's, nor with AI navigation off), each conversation naming its
 * workspace. A workspace whose
 * AI navigation is off keeps to itself, as a ChatGPT project with
 * project-only memory: its chats see only its own conversations here, as its
 * thread tools refuse the rest (services/globalContext.ts), and no other
 * workspace sees its. A conversation started seconds after the user left
 * another one, here or in another workspace, sees what was just said there,
 * without waiting for extraction or a word match. Nothing here reads the
 * words for meaning: the section's header says they are past conversation,
 * not requests, and to leave out of the answer what the user asked there to
 * forget or not to keep.
 *
 * Only what recall indexed is shown (recallIndex.indexTurn): completed turns
 * a person typed, in ordinary chats that learn and in V, the user's
 * conversation with their Michi assistant, which shows under its title (the
 * assistant's hidden workspace is never named). So never a turn of a
 * conversation whose memory setting is Use only or Off, of a page, digest,
 * maintenance or Scheduled-only thread or a check-in, a turn
 * nobody typed (self-turns, thread messages, scheduled runs), nor one recall
 * hides (the reply footer's Don't recall, a conversation that stopped
 * learning, Delete all memories). Nor a conversation in Trash, nor a turn
 * that read outside content (web pages, shell or another MCP server's output:
 * services/turnTrust.ts; its document's read_outside, migration 0080). A
 * conversation ranks by the newest turn it may show, so one whose newest
 * turns ran tools takes no place from the others. The current conversation
 * and what a branch inherited are left out too: they are in its context
 * already.
 */

export interface RecentTurn {
  /** memory_recall_docs.id: the turn's c: ref. */
  docId: number;
  turnId: string;
  /** When the user sent it (ms). */
  at: number;
  /** What the user typed (the turn document's user words: head and tail past its limit). */
  text: string;
}

export interface RecentConversation {
  nodeId: string;
  title: string | null;
  /** The conversation's workspace, and its name (none for the assistant's hidden one). */
  workspaceId: string;
  workspaceName: string | null;
  /** Its newest shown turn's time: conversations come newest first. */
  latestAt: number;
  /** Its newest turns, at most RECENT_LIMITS.turnsPerConversation, oldest first. */
  turns: RecentTurn[];
}

export const RECENT_LIMITS = Object.freeze({
  conversations: 8,
  turnsPerConversation: 6,
  /** Conversations read at most, newest message first: a branch's parent may have nothing to show from after the branch began. */
  candidates: 24,
});

/** The turn documents Recent may show: visible ones whose turn read nothing from outside (idx_memory_recall_docs_node_shown, migration 0080). */
const SHOWN = "d.doc_kind = 'turn' AND d.hidden = 0 AND d.read_outside = 0";

/**
 * The ordinary chats that learn, in these workspaces (the owner's:
 * recallableWorkspaces), other than the current one, by the newest message a
 * person typed in them that Recent may show (its turn document's time), so
 * turns nobody typed (thread messages, scheduled runs, branches an agent
 * opened) and turns that read outside content, which are never shown, rank
 * nothing: one index-only lookup of idx_memory_recall_docs_node_shown per
 * conversation (migration 0080: hidden documents and those of turns that read
 * outside content are not in it), a microsecond or two each (5,000
 * conversations: about 7 ms).
 */
const CONVERSATIONS_SQL = `SELECT nodeId, title, workspaceId, workspaceName, workspaceSettings FROM (
    SELECT n.id AS nodeId, n.title AS title, n.workspace_id AS workspaceId, w.name AS workspaceName, w.settings AS workspaceSettings,
      (SELECT MAX(d.at) FROM memory_recall_docs d WHERE d.node_id = n.id AND ${SHOWN}) AS lastAt
    FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
    WHERE n.workspace_id IN (SELECT value FROM json_each(?)) AND n.id <> ?
      AND n.kind = 'chat' AND n.memory_mode IS NULL AND n.page_id IS NULL AND n.maintenance_job_id IS NULL
      AND n.scheduled_only_job_id IS NULL AND n.purged_at IS NULL AND n.deleted_at IS NULL)
  WHERE lastAt IS NOT NULL ORDER BY lastAt DESC LIMIT ?`;

/**
 * One conversation's newest turn documents of the owner's that Recent may show: the same index, read newest first and
 * stopping after `limit`, however long the conversation and however many of its turns ran tools (the + keeps SQLite off
 * the owner's index, which walks all of their history).
 */
const TURNS_SQL = `SELECT d.id AS docId, d.ref_id AS turnId, d.at AS at, d.snippet AS snippet FROM memory_recall_docs d
  WHERE d.node_id = ? AND ${SHOWN} AND +d.owner_user_id = ? AND +d.workspace_id = ? AND +d.snippet <> ''
  ORDER BY d.at DESC, d.id DESC LIMIT ?`;

/**
 * How SQLite reads the recent conversations and one conversation's turns (EXPLAIN QUERY PLAN's details).
 * @testonly
 */
export function recentQueryPlan(): { conversations: string[]; turns: string[] } {
  const details = (sql: string, ...params: Array<string | number>) => (prepareCached(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail);
  return {
    conversations: details(CONVERSATIONS_SQL, JSON.stringify(['ws', 'ws-2']), '', RECENT_LIMITS.candidates),
    turns: details(TURNS_SQL, 'n', 'owner', 'ws', RECENT_LIMITS.turnsPerConversation),
  };
}

/**
 * The user's most recent other conversations, in this workspace and every
 * other one recall may read (only this one when its AI navigation is off),
 * with what the user typed in them, newest first (see the module comment).
 * `inherited`: the conversations above the current one (a branch) and when it
 * began; what they said before then is the branch's own history.
 */
export function recentConversations(input: {
  ownerUserId: string; workspaceId: string; nodeId: string | null;
  inherited?: { above: ReadonlySet<string>; since: number } | null;
}): RecentConversation[] {
  const workspaces = getAiGlobalContext(input.workspaceId, input.ownerUserId)
    ? recallableWorkspaces(input.ownerUserId, input.workspaceId) : [input.workspaceId];
  if (workspaces.length === 0) return [];
  const candidates = prepareCached(CONVERSATIONS_SQL).all(JSON.stringify(workspaces), input.nodeId ?? '', RECENT_LIMITS.candidates) as Array<{
    nodeId: string; title: string | null; workspaceId: string; workspaceName: string | null; workspaceSettings: string | null;
  }>;
  const conversations: RecentConversation[] = [];
  for (const candidate of candidates) {
    if (conversations.length >= RECENT_LIMITS.conversations) break;
    const rows = prepareCached(TURNS_SQL).all(candidate.nodeId, input.ownerUserId, candidate.workspaceId, RECENT_LIMITS.turnsPerConversation) as Array<{
      docId: number; turnId: string; at: number; snippet: string;
    }>;
    const inherited = input.inherited?.above.has(candidate.nodeId) ? input.inherited.since : null;
    const turns = rows
      .filter((row) => inherited === null || row.at >= inherited)
      .map((row) => ({ docId: row.docId, turnId: row.turnId, at: row.at, text: turnUserWords(row.snippet).trim() }))
      .filter((turn) => turn.text);
    if (turns.length === 0) continue;
    conversations.push({
      nodeId: candidate.nodeId, title: candidate.title, workspaceId: candidate.workspaceId,
      workspaceName: isSystemWorkspaceSettings(candidate.workspaceSettings) ? null : candidate.workspaceName,
      latestAt: turns[0]!.at, turns: turns.reverse(),
    });
  }
  // Newest first by the shown turns' times (a branch's parent shows only what was said there after the branch began).
  return conversations.sort((a, b) => b.latestAt - a.latestAt);
}
