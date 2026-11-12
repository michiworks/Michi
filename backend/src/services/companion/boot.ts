/**
 * The Companion as the backend runs it (DESIGN §4 and §6, R2.14; DESIGN-v2
 * §3): the outside sources over their whitelisted MCP pool and the Auth
 * check, the check-in runner (each check-in in its own throwaway node and
 * ephemeral session, posting into the conversation V), the coordinator, and
 * the live parts the Companion's own tools reach. Before its first tick, the
 * coordinator cleans up what a stopped Michi left of its check-ins and the
 * MVP's Companion transcripts (cleanup.ts); before anything polls, CR items
 * stored under an older version formula move to the current one
 * (sources/cr.ts upgradeCrItemVersions, D19). server.ts starts it in the
 * desktop app once the backend listens and its scheduler started (never in
 * cloud mode or with MICHI_DISABLE_COMPANION=1); the coordinator then ticks
 * only while this process holds the scheduler lease.
 */

import { currentAssistantNodeId } from '../../assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { log } from '../logger';
import { firstRunEndPosted } from '../metaAgent/firstRunNarration';
import { firstRunClosed, firstRunWriting } from '../metaAgent/firstRunHold';
import { cleanUpCheckins, discardMvpCompanionSessions, type CompanionMvpDiscard } from './cleanup';
import { systemCompanionClock } from './clock';
import { createCompanionTurnRunner, type CompanionTurnChatHub, type CompanionTurnChatManager } from './conversation';
import { startCompanion, type CompanionCoordinatorDeps } from './coordinator';
import { getCompanionSettings } from './settings';
import { createExternalSources, type CompanionExternalSources } from './sources';
import { setCompanionToolDeps } from './tools';
import type { CompanionService } from './types';

export interface CompanionBootDeps {
  chatHub: CompanionTurnChatHub;
  chatManager: CompanionTurnChatManager;
  /** This process holds the scheduler lease and so runs the Companion (scheduledJobScheduler.status().active). */
  isLeaseHolder(): boolean;
  /** The outside sources (default: createExternalSources over the real MCP pool and Auth check). */
  external?: CompanionExternalSources;
  /** How an MVP Companion session is discarded (default: by its runtime, cleanup.ts). */
  discardMvpSession?: CompanionMvpDiscard;
  /** More coordinator options, e.g. a clock and no timers (tests). */
  coordinator?: Omit<CompanionCoordinatorDeps, 'sources' | 'auth' | 'turnRunner' | 'isLeaseHolder' | 'conversationBusy' | 'turnActive' | 'cleanUpCheckins'>;
}

export interface RunningCompanion {
  /** The live CompanionService the routes use (routes/companion.ts). */
  service: CompanionService;
  /** Stops the engine and closes the MCP connections; once it resolves, the database may close. */
  stop(): Promise<void>;
}

/**
 * The Pages upkeep's first run still narrates into V (firstRunNarration.ts):
 * it reads or writes, or it closed and its closing message is still to come.
 * The welcome waits for it (DESIGN-v2 §3.8).
 */
function firstRunNarrating(): boolean {
  if (firstRunWriting(LOCAL_AGENT_OWNER_ID) !== null) return true;
  return firstRunClosed(LOCAL_AGENT_OWNER_ID) && !firstRunEndPosted(LOCAL_AGENT_OWNER_ID);
}

export function bootCompanion(deps: CompanionBootDeps): RunningCompanion {
  const { chatHub, chatManager } = deps;
  const external = deps.external ?? createExternalSources({ settings: getCompanionSettings });
  const clock = deps.coordinator?.clock ?? systemCompanionClock;
  let mvpSessions: Promise<unknown> | null = null;
  const coordinator = startCompanion({
    firstRunPending: firstRunNarrating,
    ...deps.coordinator,
    sources: external.sources,
    auth: external.auth,
    // Check-ins go through the runner, which reports every post to the coordinator's notice gate.
    turnRunner: (notifier) => createCompanionTurnRunner({ chatHub, chatManager, notifier, clock }),
    isLeaseHolder: deps.isLeaseHolder,
    // Busy while it answers and while its runtime still cleans up after the answer.
    conversationBusy: (nodeId) => chatHub.isActive(nodeId) || chatHub.isOwnerTurnActive(nodeId) || chatHub.hasPendingSelfTurn(nodeId),
    // After a restart, a run whose chat turn still runs is re-attached instead of cleaned up (R2.3). The durable row,
    // not this process's turns: another backend on the data directory (R2.14) may still be running it. A process
    // that died mid-turn leaves the row active for good; the coordinator stops waiting once no turn could run so long.
    turnActive: (turnId) => chatHub.requestedTurnStatus(turnId) === 'active',
    // What a stopped Michi left (DESIGN-v2 §3.7): its check-ins every time, the MVP's transcripts once per start.
    cleanUpCheckins: async (skip) => {
      const result = await cleanUpCheckins({
        chatHub, chatManager, clock, notifier: coordinator.notifier, skip,
        conversationNodeId: deps.coordinator?.conversationNodeId ?? currentAssistantNodeId,
      });
      mvpSessions ??= discardMvpCompanionSessions(deps.discardMvpSession).catch(() => {});
      await mvpSessions;
      return result;
    },
  });
  const { service } = coordinator;
  setCompanionToolDeps({
    // companion_check_now waits for the check: Check now (notOwner() without the lease), then the tick that polls.
    checkNow: async (kinds) => {
      service.checkNow(kinds);
      await coordinator.tick();
    },
    status: service.status,
    deepReads: external.deepReads,
  });
  let stopping: Promise<void> | null = null;
  return {
    service,
    stop: () => stopping ??= (async () => {
      setCompanionToolDeps({});
      try {
        await coordinator.stop();
      } finally {
        await external.dispose();
      }
    })(),
  };
}
