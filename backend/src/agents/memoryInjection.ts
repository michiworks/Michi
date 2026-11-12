import { isCheckinNodeId } from 'michi-shared';
import { assistantPurposeOf, isAssistantWorkspace } from '../assistant/identity';
import { requestAgentOwnerOrNull, workspaceOwnerMatches } from '../services/agentOwner';
import { getWorkspace } from '../services/dbRepository';
import { log } from '../services/logger';
import {
  buildMemoryPack,
  conversationOffPack,
  createMemoryPackHolder,
  deliverMemoryPack,
  type MemoryPackConsumer,
  type MemoryPackHolder,
} from '../services/memory/contextBuilder';
import { readConversationMemoryMode } from '../services/memory/memoryRepository';
import { noteDelivered } from '../services/memory/replySources';
import { isRunOwner } from './ownerMapping';
import type { AgentSession } from './types';

/**
 * Michi Memory in agent turns: chatHub's adapter to the memory pack
 * (services/memory/contextBuilder.ts, which decides what a pack holds).
 *
 * chatHub asks prepare() before each turn it sends. The pack travels as
 * AgentTurnInput.memoryContext, which every adapter renders for the model
 * ahead of the Pages context and keeps out of its history: Claude, Codex,
 * Kiro, Kiro Crew and Antigravity (AcpAgentSession) and Pi. The stable system
 * prompt and the first-turn prefix are untouched.
 *
 * Delivery is tracked per live AgentSession object (a MemoryPackHolder each),
 * so a session rebuilt or resumed from history, forked or reloaded after a
 * restart (always a new object) gets the whole pack again on its first turn.
 * A pack counts as delivered only when the turn ends neither cancelled nor
 * failed; forget() drops what the session holds after a compaction or a
 * native command such as /clear, which may have taken it out of the
 * runtime's context.
 *
 * Who gets one: turns of ordinary chats whose memory setting is not off
 * (use only still reads memory, and its pack says that nothing said in the
 * conversation goes into memory, nor, unless the user explicitly asks, into
 * a file, artifact or page; a session that held notes when its
 * conversation was set to off is told once that they no longer apply),
 * including scheduled jobs (consumer
 * 'job': the job's prompt selects related notes) and cross-thread or Agent
 * Run deliveries into them. V, the user's conversation with their Michi
 * assistant (a 'main' conversation of its hidden workspace), is one of them
 * (consumer 'assistant': its own memory setting, the user scope, and recall
 * of every navigable workspace's conversations). No other conversation of
 * that workspace gets one: a Companion check-in (n-cmph- nodes) builds its
 * own resident pack (contextBuilder consumer 'checkin') and passes it with
 * its turn. Pages maintenance turns (chatHub passes no request for them),
 * Agent Runs (a headless owner; their driver sends no host context) and
 * digests (sent outside chatHub) get none.
 *
 * Owner and workspace come from the turn chatHub runs, never from the model:
 * the owner the route or server caller gave it (cloud), or the local user
 * (desktop), as routes/memories.ts resolves it; the workspace from the chat
 * node's row, which must be the owner's. Nothing here reads what the user
 * typed for intent: when to save or forget is the model's call, from the
 * memory tools' descriptions.
 */

/** One turn chatHub is about to send to a live session. */
export interface MemoryTurnRequest {
  session: AgentSession;
  /** The turn's owner as the route or server caller gave it to chatHub. */
  ownerUserId: string | null;
  /** The chat node's workspace, from its stored row. */
  workspaceId: string | null;
  /** The chat node: its own conversation is never recalled into it. Of the assistant's workspace, only V's gets a pack. */
  nodeId?: string | null;
  /** The turn the pack goes with: once delivered, what it showed is noted for the line under the reply (replySources.ts). */
  turnId?: string | null;
  /**
   * What selects related notes: what the user typed, a scheduled job's
   * prompt, or a delivered message's body; never the wire text. '' or
   * absent: none.
   */
  query?: string | null;
  /** The turn is a scheduled job's run. */
  scheduledJob?: boolean;
}

/** A block for one turn. */
export interface PreparedMemoryContext {
  text: string;
  /** The turn ended neither cancelled nor failed: the session now holds this block. */
  delivered(): void;
}

interface MemoryTarget {
  ownerUserId: string;
  workspaceId: string;
  consumer: MemoryPackConsumer;
}

interface SessionMemoryState {
  ownerUserId: string;
  workspaceId: string;
  holder: MemoryPackHolder;
  /** Bumped by forget() and by a change of owner or workspace: a turn prepared before then delivers nothing. */
  epoch: number;
}

function target({ ownerUserId, workspaceId, nodeId, scheduledJob }: MemoryTurnRequest): MemoryTarget | null {
  // A check-in passes its own pack with its turn.
  if (isCheckinNodeId(nodeId)) return null;
  const owner = requestAgentOwnerOrNull(ownerUserId);
  if (!owner || !workspaceId) return null;
  const workspace = getWorkspace(workspaceId);
  if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, owner)) return null;
  if (!isAssistantWorkspace(workspaceId)) return { ownerUserId: owner, workspaceId, consumer: scheduledJob ? 'job' : 'chat' };
  // Of the assistant's workspace, only V (a 'main' conversation) reads memory here.
  return assistantPurposeOf(nodeId) === 'main' ? { ownerUserId: owner, workspaceId, consumer: 'assistant' } : null;
}

export class MemoryInjector {
  private readonly sessions = new WeakMap<AgentSession, SessionMemoryState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The pack this turn should carry, or null. Never throws: a failure only skips memory. */
  prepare(request: MemoryTurnRequest): PreparedMemoryContext | null {
    try {
      return this.prepareTurn(request);
    } catch (error) {
      log.warn('chat', 'Michi Memory block skipped', {
        sessionId: request.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The session may have lost its notes (compaction, /clear): send them all again next turn. */
  forget(session: AgentSession): void {
    const state = this.sessions.get(session);
    if (!state) return;
    state.holder = createMemoryPackHolder();
    state.epoch += 1;
  }

  private prepareTurn(request: MemoryTurnRequest): PreparedMemoryContext | null {
    const { session } = request;
    if (isRunOwner(session.owner)) return null;
    const turn = target(request);
    if (!turn) return null;
    // A conversation whose memory setting is off reads no memory; a session that holds notes from before is told they no longer apply.
    const mode = readConversationMemoryMode(request.nodeId);
    if (mode === 'off') return this.retract(session, turn.ownerUserId, request.nodeId);
    let state = this.sessions.get(session);
    if (!state || state.ownerUserId !== turn.ownerUserId) {
      state = { ownerUserId: turn.ownerUserId, workspaceId: turn.workspaceId, holder: createMemoryPackHolder(), epoch: (state?.epoch ?? 0) + 1 };
      this.sessions.set(session, state);
    } else if (state.workspaceId !== turn.workspaceId) {
      // The thread moved: what it holds of the user scope stands; the next pack brings the new workspace's notes.
      state.workspaceId = turn.workspaceId;
      state.holder.version = null;
      state.epoch += 1;
    }
    const pack = buildMemoryPack({
      consumer: turn.consumer,
      ownerUserId: turn.ownerUserId,
      workspaceId: turn.workspaceId,
      nodeId: request.nodeId ?? null,
      query: request.query ?? '',
      now: this.now(),
      holder: state.holder,
      mode: mode === 'use_only' ? 'use_only' : 'learn',
    });
    if (!pack.text) {
      // Nothing to send: what it records (the version seen) holds at once.
      deliverMemoryPack(state.holder, pack);
      return null;
    }
    const prepared = state;
    const epoch = state.epoch;
    const ownerUserId = turn.ownerUserId;
    return {
      text: pack.text,
      delivered: () => {
        // What a reply under it may be based on (replySources.ts): never shown to the model.
        noteDelivered({ ownerUserId, nodeId: request.nodeId, turnId: request.turnId, pack });
        if (this.sessions.get(session) !== prepared || prepared.epoch !== epoch) return;
        deliverMemoryPack(prepared.holder, pack);
      },
    };
  }

  /** A turn of a conversation whose memory setting is off: the retraction its session needs, once (contextBuilder.conversationOffPack). */
  private retract(session: AgentSession, ownerUserId: string, nodeId: string | null | undefined): PreparedMemoryContext | null {
    const state = this.sessions.get(session);
    if (!state || state.ownerUserId !== ownerUserId) return null;
    const pack = conversationOffPack(state.holder);
    // Nothing a reply in an Off conversation says is based on memory (replySources.ts).
    noteDelivered({ ownerUserId, nodeId, turnId: null, pack });
    if (!pack.text) return null;
    const epoch = state.epoch;
    return {
      text: pack.text,
      delivered: () => {
        if (this.sessions.get(session) !== state || state.epoch !== epoch) return;
        deliverMemoryPack(state.holder, pack);
      },
    };
  }
}

/** The process-wide injector chatHub uses. */
export const memoryInjector = new MemoryInjector();
