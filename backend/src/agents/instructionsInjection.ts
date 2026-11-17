import { createHash } from 'node:crypto';
import { isAssistantWorkspace } from '../assistant/identity';
import { getWorkspaceInstructions, hasOtherTurn } from '../services/dbRepository';
import { log } from '../services/logger';
import { isRunOwner } from './ownerMapping';
import type { AgentSession } from './types';

/**
 * Workspace Instructions after a session's first turn: chatHub's adapter for
 * sending them again when the session may not hold the current ones.
 *
 * A session gets the instructions once, in its first-turn prefix
 * (preamble.buildFirstTurnPrefix; Pi puts them in its system prompt). That
 * prefix stays as it is: Claude's warm pool needs it byte-identical. So
 * chatHub asks prepare() before each turn it sends, and when the workspace's
 * instructions are not the ones the session holds, the turn carries them
 * whole as AgentTurnInput.instructionsContext, which every adapter renders
 * for the model ahead of the memory block and keeps out of its history.
 * Instructions the user removed are withdrawn once instead.
 *
 * What a session holds is tracked per live AgentSession object, as for the
 * memory block (memoryInjection.ts), by a hash of the text. The first turn
 * chatHub sends on a session object decides where it starts:
 * - on a node with no other turn, the session is new: the turn sends its
 *   first-turn prefix, taken to hold the instructions as they are now;
 * - otherwise the session was resumed natively (its prefix went out with an
 *   older session, perhaps with older instructions), rebuilt from history or
 *   reloaded after a restart. Nothing here knows which, nor what the old
 *   prefix said, so the turn sends the instructions once. A rebuilt session,
 *   or a resumed Pi session (whose system prompt is built again), then has
 *   them twice, the same text both times.
 * Nothing is persisted. A delivered hash per node would spare a resumed
 * session that copy, at the cost of a migration, and still could not say
 * what a compaction in an earlier process left of them. A resumed session in
 * a workspace without instructions is told nothing (most never had any), so
 * instructions removed while a session was released are not withdrawn from it.
 *
 * Instructions count as delivered only when the turn ends neither cancelled
 * nor failed; forget() marks them possibly lost after a compaction or a
 * native command such as /clear, and the next turn sends them again.
 *
 * Who gets them: turns of ordinary chats, scheduled jobs and cross-thread
 * deliveries, whose sessions' prefixes carry the instructions. Pages
 * maintenance sessions get none in their prefix and chatHub asks nothing for
 * their turns; Agent Runs (a headless owner) bring their own context; the
 * assistant's workspace (V and the Companion's check-ins) has no workspace
 * instructions of its own.
 */

/** One turn chatHub is about to send to a live session. */
export interface InstructionsTurnRequest {
  session: AgentSession;
  /** The chat node's workspace, from its stored row. */
  workspaceId: string | null;
  nodeId: string;
  turnId: string;
}

/** What the turn carries: `text` null when it carries nothing but its first-turn prefix. */
export interface PreparedInstructionsContext {
  text: string | null;
  /** The turn ended neither cancelled nor failed: the session now holds what it was sent. */
  delivered(): void;
}

interface SessionInstructionsState {
  /** Hash of the instructions the session holds; null for none; undefined while unknown (a resumed session). */
  held: string | null | undefined;
  /** forget() ran since: the session may have lost what it held. */
  stale: boolean;
  /** Bumped by forget(): a turn prepared before then delivers nothing. */
  epoch: number;
}

export const INSTRUCTIONS_REMOVED = 'Workspace instructions: this workspace has none now. '
  + 'The workspace instructions given earlier in this conversation no longer apply.';

/** The instructions as a turn carries them, worded as the first-turn prefix words them. */
function instructionsBlock(instructions: string): string {
  return 'Workspace instructions as they are now (these replace any given earlier in this conversation and apply to '
    + `every reply from here on — treat as if part of the system prompt):\n\n${instructions}`;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class InstructionsInjector {
  private readonly sessions = new WeakMap<AgentSession, SessionInstructionsState>();
  private readonly instructionsFor: (workspaceId: string) => string | null;
  private readonly nodeHasOtherTurn: (nodeId: string, turnId: string) => boolean;

  constructor(options: {
    instructionsFor?: (workspaceId: string) => string | null;
    nodeHasOtherTurn?: (nodeId: string, turnId: string) => boolean;
  } = {}) {
    this.instructionsFor = options.instructionsFor ?? getWorkspaceInstructions;
    this.nodeHasOtherTurn = options.nodeHasOtherTurn ?? hasOtherTurn;
  }

  /** What this turn carries, or null. Never throws: a failure only skips the instructions. */
  prepare(request: InstructionsTurnRequest): PreparedInstructionsContext | null {
    try {
      return this.prepareTurn(request);
    } catch (error) {
      log.warn('chat', 'Workspace instructions block skipped', {
        sessionId: request.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The session may have lost its instructions (compaction, /clear): send them again next turn. */
  forget(session: AgentSession): void {
    const state = this.sessions.get(session);
    if (!state) return;
    state.stale = true;
    state.epoch += 1;
  }

  private prepareTurn({ session, workspaceId, nodeId, turnId }: InstructionsTurnRequest): PreparedInstructionsContext | null {
    if (isRunOwner(session.owner) || !workspaceId || isAssistantWorkspace(workspaceId)) return null;
    // The first-turn prefix sends them trimmed.
    const current = this.instructionsFor(workspaceId)?.trim() || null;
    const hash = current === null ? null : digest(current);
    let state = this.sessions.get(session);
    if (!state) {
      state = { held: undefined, stale: false, epoch: 0 };
      this.sessions.set(session, state);
      // A new session: this turn sends its first-turn prefix.
      if (!this.nodeHasOtherTurn(nodeId, turnId)) return this.prepared(session, state, null, hash);
    }
    if (!state.stale && state.held === hash) return null;
    if (current !== null) return this.prepared(session, state, instructionsBlock(current), hash);
    if (typeof state.held === 'string') return this.prepared(session, state, INSTRUCTIONS_REMOVED, null);
    return null;
  }

  private prepared(session: AgentSession, state: SessionInstructionsState, text: string | null, hash: string | null): PreparedInstructionsContext {
    const epoch = state.epoch;
    return {
      text,
      delivered: () => {
        if (this.sessions.get(session) !== state || state.epoch !== epoch) return;
        state.held = hash;
        state.stale = false;
      },
    };
  }
}

/** The process-wide injector chatHub uses. */
export const instructionsInjector = new InstructionsInjector();
