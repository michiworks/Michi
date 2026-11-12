import {
  PROGRESS_CARD_TTL_MS, RESTART_INTERRUPTION, conversationEnding, isSystemWorkspaceSettings, parseBranchOverviewEntries, progressCardStatusLine,
  oneLine as oneLineText, progressReplyConclusion, progressReplyText, progressTurnSummary,
  type ConversationEndingOutcome, type ProgressCardAwaiting, type ProgressCardDto, type ProgressCardStatus, type ProgressReplyShape,
} from 'michi-shared';
import { getDb } from '../db';
import type { ChatHub } from '../../agents/chatHub';
import { chatHubAwaitingUser } from '../chatAwaitingUser';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError, pagesTransaction } from './core';
import { pageRecord } from './repository';
import { homeHiddenJoin, workspaceShownOnHome } from './homeVisibility';

type CardRow = {
  owner_user_id: string; thread_node_id: string; started_from_page_id: string;
  created_at: number; seen_at: number | null; dismissed_at: number | null;
};
type NodeRow = {
  id: string; title: string | null; status: string; runtime_id: string | null; tree_id: string | null; workspace_id: string;
  deleted_at: number | null; purged_at: number | null; workspace_name: string; workspace_owner: string | null;
  workspace_settings: string | null; workspace_deleted_at: number | null; workspace_purged_at: number | null;
  workspace_archived_at: number | null; home_hidden_at: number | null;
  turn_status: string | null; turn_completed_at: number | null; turn_stop_reason: string | null; turn_error: string | null;
  turn_started_at: number | null; branch_overview: string | null;
};

/** A conversation's turn as it runs in this process: whether it waits for you (and for what), and its reply so far. */
export interface ProgressCardLiveTurn {
  awaiting: ProgressCardAwaiting | null;
  /** The pending request's title, or the question it asks. */
  awaitingDetail?: string | null;
  reply: ProgressReplyShape | null;
}
type LiveTurnReader = (nodeId: string) => ProgressCardLiveTurn | null;
let liveTurn: LiveTurnReader = () => null;
/** server.ts reads live turns from ChatHub; without a reader a running card says only "Working…". */
export function configureProgressCardLiveTurns(reader: LiveTurnReader | null): void { liveTurn = reader ?? (() => null); }

/** The thread's active turn in ChatHub, or null when this process is not running one for it. */
export function chatHubLiveTurn(hub: Pick<ChatHub, 'getSnapshot' | 'getPendingPermission' | 'getPendingUserInput'>, nodeId: string): ProgressCardLiveTurn | null {
  const observation = hub.getSnapshot(nodeId);
  if (!observation || observation.durableStatus !== 'active') return null;
  const pending = chatHubAwaitingUser(hub, observation.chatId);
  const awaiting: ProgressCardAwaiting | null = pending?.kind ?? (observation.pendingInteraction.waiting ? 'approval' : null);
  return { awaiting, awaitingDetail: oneLine(pending?.detail, DETAIL_MAX), reply: observation.snapshot.assistantMessage };
}

function oneLine(text: string | null | undefined, max: number): string | null {
  return text ? oneLineText(text, max) || null : null;
}

const LIST_LIMIT = 50;
const TITLE_MAX = 120;
const DETAIL_MAX = 160;
const ERROR_MAX = 200;
const db = () => getDb();

/** A turn the runtime ended early is not done, though its status reads completed. */
const CARD_STATUS: Record<ConversationEndingOutcome, ProgressCardStatus> = {
  done: 'done', stopped_early: 'failed', cancelled: 'cancelled', interrupted: 'failed', failed: 'failed',
};
const ABNORMAL_STOP: Record<string, string> = {
  max_tokens: 'The reply reached its length limit before it finished.',
  max_turn_requests: 'The chat reached its step limit before it finished.',
  refusal: 'The model declined to continue.',
};

const nodeEnding = (node: NodeRow) => conversationEnding({ status: node.turn_status, stopReason: node.turn_stop_reason, error: node.turn_error });

function cardStatus(node: NodeRow): ProgressCardStatus {
  if (node.turn_status === 'active') return 'running';
  const ending = nodeEnding(node);
  return ending ? CARD_STATUS[ending.outcome] : 'idle';
}

function cardError(node: NodeRow, status: ProgressCardStatus): string | null {
  if (status !== 'failed') return null;
  const ending = nodeEnding(node);
  if (ending?.outcome === 'stopped_early') return ABNORMAL_STOP[node.turn_stop_reason!] ?? null;
  if (ending?.outcome === 'interrupted') return `${RESTART_INTERRUPTION}.`;
  return oneLine(ending?.note, ERROR_MAX);
}

function threadNode(nodeId: string, ownerUserId: string): NodeRow | undefined {
  return db().prepare(`SELECT n.id,n.title,n.status,n.runtime_id,n.tree_id,n.workspace_id,n.deleted_at,n.purged_at,n.branch_overview,
      w.name AS workspace_name,w.owner_user_id AS workspace_owner,w.settings AS workspace_settings,
      w.deleted_at AS workspace_deleted_at,w.purged_at AS workspace_purged_at,w.archived_at AS workspace_archived_at,hp.hidden_at AS home_hidden_at,t.status AS turn_status,t.completed_at AS turn_completed_at,
      t.stop_reason AS turn_stop_reason,t.error AS turn_error,t.started_at AS turn_started_at
    FROM nodes n JOIN workspaces w ON w.id=n.workspace_id ${homeHiddenJoin('w')}
    LEFT JOIN turns t ON t.turn_id=(SELECT l.turn_id FROM turns l WHERE l.node_id=n.id ORDER BY l.started_at DESC,l.rowid DESC LIMIT 1)
    WHERE n.id=? AND n.kind='chat'`).get(ownerUserId, nodeId) as NodeRow | undefined;
}

function liveFor(node: NodeRow | undefined, ownerUserId: string): node is NodeRow {
  return !!node && node.deleted_at === null && node.purged_at === null && node.workspace_deleted_at === null &&
    node.workspace_purged_at === null && workspaceOwnerMatches(node.workspace_owner, ownerUserId);
}

/** What the latest turn concluded: the summary it ended with, else what the last reply concluded, on one line. */
function replySummary(node: NodeRow): string | null {
  const ended = progressTurnSummary(parseBranchOverviewEntries(node.branch_overview), node.turn_started_at);
  if (ended) return ended;
  const row = db().prepare("SELECT content,blocks FROM messages WHERE node_id=? AND role='assistant' AND trim(content)<>'' ORDER BY seq DESC LIMIT 1")
    .get(node.id) as { content: string; blocks: string | null } | undefined;
  if (!row) return null;
  let blocks: Array<{ kind: string; rawText?: unknown }> | null = null;
  try {
    const parsed: unknown = row.blocks ? JSON.parse(row.blocks) : null;
    if (Array.isArray(parsed)) blocks = parsed.filter((block): block is { kind: string } => !!block && typeof block.kind === 'string');
  } catch { blocks = null; }
  return progressReplyConclusion(progressReplyText({ blocks, text: row.content }));
}

/** An untitled thread is named by the first line of its first message. */
function threadTitle(node: NodeRow): string {
  const title = node.title?.trim();
  if (title) return title;
  const row = db().prepare("SELECT content FROM messages WHERE node_id=? AND role='user' AND trim(content)<>'' ORDER BY seq LIMIT 1")
    .get(node.id) as { content: string } | undefined;
  const line = row?.content.trim().split('\n')[0]?.trim() ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function dto(card: CardRow, node: NodeRow): ProgressCardDto {
  const status = cardStatus(node);
  const live = status === 'running' ? liveTurn(node.id) : null;
  return {
    threadNodeId: card.thread_node_id, startedFromPageId: card.started_from_page_id,
    workspaceId: node.workspace_id, workspaceName: node.workspace_name, treeId: node.tree_id,
    title: threadTitle(node), runtimeId: node.runtime_id, status,
    // Only a finished conversation shows what it said; a running one shows its status alone.
    summary: status === 'running' ? null : replySummary(node),
    error: cardError(node, status),
    finishedAt: status === 'running' || status === 'idle' ? null : node.turn_completed_at,
    statusLine: status === 'running' ? (live ? progressCardStatusLine({ awaiting: live.awaiting, reply: live.reply }) : 'Working…') : null,
    awaiting: live?.awaiting ?? null,
    awaitingDetail: live?.awaiting ? live.awaitingDetail ?? null : null,
    createdAt: card.created_at, seenAt: card.seen_at, dismissedAt: card.dismissed_at,
    expiresAt: card.seen_at === null ? null : card.seen_at + PROGRESS_CARD_TTL_MS,
  };
}

function cardRow(ownerUserId: string, threadNodeId: string): CardRow | undefined {
  return db().prepare('SELECT * FROM page_progress_cards WHERE owner_user_id=? AND thread_node_id=?').get(ownerUserId, threadNodeId) as CardRow | undefined;
}

export interface CreateProgressCardInput { ownerUserId: string; threadNodeId: string; startedFromPageId: string; now?: number }

/** Records that a conversation was started from a page. Repeating it for the same page is a no-op. */
export function createProgressCard(input: CreateProgressCardInput): ProgressCardDto {
  const now = input.now ?? Date.now();
  return pagesTransaction(() => {
    pageRecord(input.startedFromPageId, input.ownerUserId);
    const node = threadNode(input.threadNodeId, input.ownerUserId);
    if (!liveFor(node, input.ownerUserId) || isSystemWorkspaceSettings(node.workspace_settings)) {
      throw new PageWriteError(404, 'not_found', 'Conversation not found');
    }
    const existing = cardRow(input.ownerUserId, input.threadNodeId);
    if (existing && existing.started_from_page_id !== input.startedFromPageId) {
      throw new PageWriteError(409, 'invalid', 'This conversation was started from another page');
    }
    if (!existing) {
      db().prepare('INSERT INTO page_progress_cards(owner_user_id,thread_node_id,started_from_page_id,created_at) VALUES(?,?,?,?)')
        .run(input.ownerUserId, input.threadNodeId, input.startedFromPageId, now);
    }
    return dto(cardRow(input.ownerUserId, input.threadNodeId)!, node);
  });
}

function shownCards(ownerUserId: string, now: number, pageId: string | null): ProgressCardDto[] {
  const rows = db().prepare(`SELECT * FROM page_progress_cards WHERE owner_user_id=? AND (? IS NULL OR started_from_page_id=?)
      AND dismissed_at IS NULL AND (seen_at IS NULL OR seen_at>?) ORDER BY created_at DESC,thread_node_id LIMIT ?`)
    .all(ownerUserId, pageId, pageId, now - PROGRESS_CARD_TTL_MS, LIST_LIMIT) as unknown as CardRow[];
  const cards: ProgressCardDto[] = [];
  for (const row of rows) {
    const node = threadNode(row.thread_node_id, ownerUserId);
    if (liveFor(node, ownerUserId)) cards.push(dto(row, node));
  }
  return cards;
}

/** Cards on the page they were started from: neither dismissed nor seen more than 24 hours ago. */
export function listPageProgressCards(pageId: string, ownerUserId: string, now = Date.now()): ProgressCardDto[] {
  pageRecord(pageId, ownerUserId);
  return shownCards(ownerUserId, now, pageId);
}

/** Home shows every card the owner still has, whichever page started it. */
export function listHomeProgressCards(ownerUserId: string, now = Date.now()): ProgressCardDto[] {
  return shownCards(ownerUserId, now, null);
}

function stamp(ownerUserId: string, threadNodeId: string, column: 'seen_at' | 'dismissed_at', now: number): ProgressCardDto {
  return pagesTransaction(() => {
    const node = threadNode(threadNodeId, ownerUserId);
    if (!cardRow(ownerUserId, threadNodeId) || !node || !workspaceOwnerMatches(node.workspace_owner, ownerUserId)) {
      throw new PageWriteError(404, 'not_found', 'Progress card not found');
    }
    // The first time counts: seeing a card again does not push back its expiry.
    db().prepare(`UPDATE page_progress_cards SET ${column}=COALESCE(${column},?) WHERE owner_user_id=? AND thread_node_id=?`)
      .run(now, ownerUserId, threadNodeId);
    return dto(cardRow(ownerUserId, threadNodeId)!, node);
  });
}

/** The user opened the conversation; the card goes 24 hours later. */
export function markProgressCardSeen(ownerUserId: string, threadNodeId: string, now = Date.now()): ProgressCardDto {
  return stamp(ownerUserId, threadNodeId, 'seen_at', now);
}

export function dismissProgressCard(ownerUserId: string, threadNodeId: string, now = Date.now()): ProgressCardDto {
  return stamp(ownerUserId, threadNodeId, 'dismissed_at', now);
}

/** Conversations started from a page, newest first, for Space activity (dismissed and expired ones included). */
export function startedConversations(ownerUserId: string, limit: number): Array<{ card: CardRow; node: NodeRow; pageTitle: string | null }> {
  const rows = db().prepare(`SELECT c.*,p.title AS page_title FROM page_progress_cards c LEFT JOIN pages p ON p.id=c.started_from_page_id AND p.deleted_at IS NULL
      WHERE c.owner_user_id=? ORDER BY c.created_at DESC,c.thread_node_id LIMIT ?`)
    .all(ownerUserId, limit) as unknown as Array<CardRow & { page_title: string | null }>;
  const result: Array<{ card: CardRow; node: NodeRow; pageTitle: string | null }> = [];
  for (const row of rows) {
    const node = threadNode(row.thread_node_id, ownerUserId);
    if (node && node.deleted_at === null && node.purged_at === null && workspaceShownOnHome({ owner_user_id: node.workspace_owner,
      settings: node.workspace_settings, deleted_at: node.workspace_deleted_at, archived_at: node.workspace_archived_at,
      purged_at: node.workspace_purged_at, home_hidden_at: node.home_hidden_at }, ownerUserId)) {
      result.push({ card: row, node, pageTitle: row.page_title });
    }
  }
  return result;
}
