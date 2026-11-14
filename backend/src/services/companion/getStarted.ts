/**
 * The Get started card (unification design D17, §3.1): the first time the
 * panel opens, V shows a model-free introduction and a card, and nothing
 * starts before its Start. Michi is off until then (michiPause.ts: paused
 * until resumed). Start is the opt-in: it resumes Michi, applies the card's
 * two choices (workspace homes, watching local conversations), starts the
 * Pages first run, and counts as the welcome: the check-ins may begin, and
 * what the sources held before is not news. Automatic memory is not the
 * card's: it stays as Settings › Memory has it. There is no welcome turn any more. Not now starts
 * nothing; the card can still be started from V. The answer is kept in
 * `meta` (`companion:get_started`).
 *
 * Someone who met Michi before the card existed (a welcome, or a message of
 * theirs in V) gets no card and keeps their settings; opening Spaces still
 * starts their first run if it never ran (spacesVisitMayStartFirstRun).
 */

import type { CompanionGetStartedDto, CompanionGetStartedInput } from 'michi-shared';
import { currentAssistantNodeId } from '../../assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getMetaAgentSettings, resolveMetaAgentBehaviour, updateMetaAgentSettings } from '../metaAgent/settings';
import { resumeMichi } from '../michiPause';
import { CompanionError, invalidRequest } from './errors';
import {
  companionWelcomeState,
  getCompanionMeta,
  getCompanionMetaNumber,
  isCompanionWelcomeDone,
  latestEventSeq,
  markCompanionWelcomeDone,
  setCompanionMeta,
  setCompanionMetaNumber,
  userWroteInConversation,
} from './repository';
import { patchCompanionSettings, settleCompanionSourceDefaults } from './settings';

const KEY = 'companion:get_started';
/** What Watch turns on or off: local Michi conversations. */
const WATCHED = ['michi'] as const;

interface Answer {
  state: 'later' | 'started';
  at: number;
  nodeId: string | null;
  homes?: boolean;
  watch?: boolean | null;
}

function readAnswer(): Answer | null {
  const raw = getCompanionMeta(KEY);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Answer>;
    if ((value.state !== 'later' && value.state !== 'started') || typeof value.at !== 'number') return null;
    return { state: value.state, at: value.at, nodeId: typeof value.nodeId === 'string' ? value.nodeId : null,
      homes: typeof value.homes === 'boolean' ? value.homes : undefined,
      watch: typeof value.watch === 'boolean' ? value.watch : null };
  } catch {
    return null;
  }
}

/** The card V `nodeId` shows; null for someone who met Michi before it, and in another conversation after Start. */
export function companionGetStarted(nodeId: string | null): CompanionGetStartedDto | null {
  const answer = readAnswer();
  let base: Pick<CompanionGetStartedDto, 'state' | 'at' | 'nodeId' | 'homes' | 'watch'>;
  if (answer?.state === 'started') {
    if (nodeId !== null && answer.nodeId !== nodeId) return null;
    base = { state: 'started', at: answer.at, nodeId: answer.nodeId, homes: answer.homes ?? null, watch: answer.watch ?? null };
  } else if (answer?.state === 'later') {
    base = { state: 'later', at: answer.at, nodeId: answer.nodeId, homes: null, watch: null };
  } else if (companionWelcomeState(nodeId).wanted) {
    base = { state: 'offer', at: null, nodeId, homes: null, watch: null };
  } else {
    return null;
  }
  const behaviour = resolveMetaAgentBehaviour(LOCAL_AGENT_OWNER_ID);
  return { ...base, homesOn: behaviour.writeWorkspaceHomes, firstRunDays: behaviour.firstRunDays };
}

/** The body of POST /companion/get-started; anything else is refused. */
export function parseGetStartedInput(body: Record<string, unknown>): CompanionGetStartedInput {
  if (typeof body.homes !== 'boolean') throw invalidRequest('homes must be true or false');
  if (body.watch !== undefined && typeof body.watch !== 'boolean') throw invalidRequest('watch must be true or false');
  return body.watch === undefined ? { homes: body.homes } : { homes: body.homes, watch: body.watch };
}

/**
 * What the welcome did (coordinator markWelcome) without its turn: from now
 * on the cursors start here, so what came in before is not news.
 */
function markMet(now: number): void {
  markCompanionWelcomeDone(now);
  const seq = latestEventSeq();
  for (const key of ['companion:wake_cursor', 'companion:heartbeat_cursor', 'companion:brief_cursor'] as const) {
    if (seq > (getCompanionMetaNumber(key) ?? -1)) setCompanionMetaNumber(key, seq);
  }
  setCompanionMetaNumber('companion:last_heartbeat_at', Math.floor(now));
}

export interface StartGetStartedDeps {
  /** Starts the Pages first run (metaAgent/firstRun.ts startSpacesFirstRun); null without scheduled jobs here. */
  startFirstRun: (() => void) | null;
  nodeId: string | null;
  now: number;
}

/**
 * Start: Michi resumes, Watch turns local conversations on or off (left out: as they are),
 * the homes choice becomes Settings' "Keep workspace homes up to date", and
 * the first run starts. Pressing it again (another window) changes only what
 * the card says now. Without scheduled jobs here, homes cannot run, so Start
 * with homes is refused before anything changes.
 */
export function startCompanionGetStarted(input: CompanionGetStartedInput, deps: StartGetStartedDeps): void {
  if (input.homes && !deps.startFirstRun) {
    throw new CompanionError(409, 'scheduler_off', 'Workspace homes need scheduled jobs, which are off in this Michi');
  }
  resumeMichi(LOCAL_AGENT_OWNER_ID);
  if (input.watch !== undefined) {
    const watch = input.watch;
    patchCompanionSettings({ sources: Object.fromEntries(WATCHED.map((kind) => [kind, { enabled: watch }])) }, deps.now);
  }
  const stored = getMetaAgentSettings(LOCAL_AGENT_OWNER_ID).writeWorkspaceHomes;
  // Null already means on; only a choice that differs is written.
  if (input.homes ? stored === false : stored !== false) updateMetaAgentSettings({ writeWorkspaceHomes: input.homes }, LOCAL_AGENT_OWNER_ID);
  // With homes off it still runs: only the upkeep jobs are enrolled, and turning homes on later queues the first read.
  deps.startFirstRun?.();
  markMet(deps.now);
  const answer: Answer = { state: 'started', at: deps.now, nodeId: deps.nodeId, homes: input.homes, watch: input.watch ?? null };
  setCompanionMeta(KEY, JSON.stringify(answer));
}

/** Not now: nothing starts and nothing changes; the card stays in V, folded, until Start. A started card stays started. */
export function postponeCompanionGetStarted(nodeId: string | null, now: number): void {
  if (readAnswer()?.state === 'started') return;
  setCompanionMeta(KEY, JSON.stringify({ state: 'later', at: now, nodeId } satisfies Answer));
}

/**
 * Whether opening Spaces may start the first run that never ran: only for
 * someone who met Michi before the card (no card to start it from) or who
 * pressed Start. While the card is offered or put off, it waits for Start.
 */
export function spacesVisitMayStartFirstRun(): boolean {
  const state = companionGetStarted(currentNodeId())?.state;
  return state === undefined || state === 'started';
}

function currentNodeId(): string | null {
  try {
    return currentAssistantNodeId();
  } catch {
    return null;
  }
}

/** At boot, once (server.ts): local conversations start off for someone who has not met Michi (settings.ts). */
export function settleNewUserSourceDefaults(): void {
  settleCompanionSourceDefaults(isCompanionWelcomeDone() || userWroteInConversation(currentNodeId()));
}
