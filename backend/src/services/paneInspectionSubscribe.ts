/**
 * Pane Inspection API — the one-shot change listener behind `wait_pane` (design §7.4, §8).
 *
 * `PaneFeed.oncePerObject` re-inspects one object whenever one of its notification sources
 * fires, and reports the first content change relative to the caller's baseline:
 *  - Chat (`node` targets): a `chatHub.subscribe(chatId, ...)` listener. A raw ChatHub event is
 *    only a wake-up signal; the fresh `inspect()` alone decides what changed (design §8:
 *    "changed... 客户端按 cursor 替换，不自行重算状态机").
 *  - Run (`agent_run` targets): `AgentRunEventBus.subscribe`, which only fires for
 *    repository-committed events (`publishCommitted`'s own contract). The bus is installed once
 *    at boot through `configurePaneInspectionEventBus`.
 *  - A coarse poll for every kind, for changes neither source reports (presence, metadata, and
 *    a `surface` target's only content).
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §7.4, §8. COMMON.md decisions 8, 9, 10.
 */

import { PaneInspectionError, type PaneDescriptorV1 } from 'michi-shared';
import { authorizeCaller, inspect, paneContentSnapshot, resolvePaneTarget, type PaneInspectionCaller } from './paneInspection';
import { contentEquals } from './paneInspectionRing';
import type { AgentRunEventBus } from '../agents/runs/agentRunEventBus';
import { chatHub as systemChatHub, type ChatObservationSnapshot, type HubSubscriber } from '../agents/chatHub';

/**
 * Narrow read-only slice of `ChatHub`'s public surface this module actually needs — deliberately
 * NOT the full class, so a unit test can inject an in-memory fake with zero persistence/DB
 * dependency instead of driving the real process-wide `chatHub` singleton (which defaults to
 * `repositoryTurnPersistence`, i.e. real SQLite writes on `startTurn`). Defaults to the real
 * singleton in `PaneFeedDeps` below, so production callers need no change.
 */
export interface ChatHubObservationPort {
  getSnapshot(nodeId: string): ChatObservationSnapshot | null;
  subscribe(chatId: string, sub: HubSubscriber, opts?: { fromTurnId?: string; fromSeq?: number }): () => void;
}

// ---------------------------------------------------------------------------
// Injected clock/timer ports — mirrors PaneInspectionRing's own "no Date.now() inside" contract
// so this module is exhaustively testable with fake timers (brief step 3).
// ---------------------------------------------------------------------------

export interface PaneSubscribeClock {
  now(): number;
  /** Node's `setTimeout`, injected so tests can use `node:timers` fake timers.
   *  Returns an opaque handle for `clearTimeout`. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemPaneSubscribeClock: PaneSubscribeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface PaneFeedDeps {
  clock: PaneSubscribeClock;
  /** The ChatHub slice this feed observes, per `ChatHubObservationPort` above. Defaults to the
   *  real process-wide singleton, so production callers need no change; a unit test injects
   *  an in-memory fake and avoids the real singleton's SQLite-backed persistence entirely. */
  chatHub?: ChatHubObservationPort;
  /** Optional — absent when `agentRunAssembly.enabled` is false at boot (design: AgentRun
   *  support is conditional on that assembly). Defaults to the bus installed through
   *  `configurePaneInspectionEventBus`; without one, AgentRun targets rely on the coarse poll. */
  agentRunEvents?: AgentRunEventBus;
  /** How often `oncePerObject` re-inspects as its coarse fallback, for changes no live source
   *  reports. Default 2 seconds. */
  pollIntervalMs?: number;
}

let processAgentRunEvents: AgentRunEventBus | undefined;

/** Installed once at boot; tool waits observe the same committed bus. */
export function configurePaneInspectionEventBus(events: AgentRunEventBus | undefined): void {
  processAgentRunEvents = events;
}

/** The notification sources one `wait_pane` call listens on; see `oncePerObject`. */
export class PaneFeed {
  private readonly clock: PaneSubscribeClock;

  /** Defaults to the real process-wide ChatHub singleton; injectable so tests need no SQLite. */
  private readonly chatHub: ChatHubObservationPort;
  private readonly agentRunEvents?: AgentRunEventBus;
  private readonly pollIntervalMs: number;

  constructor(deps: PaneFeedDeps) {
    this.clock = deps.clock;
    this.chatHub = deps.chatHub ?? systemChatHub;
    this.agentRunEvents = deps.agentRunEvents ?? processAgentRunEvents;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2_000;
  }

  /**
   * One-shot change listener for `wait_pane`: resolves as soon as a content change relative to
   * `baselineContent` is detected, or reports the object unavailable, WITHOUT a poll loop that
   * outlives the call — the returned function tears down whatever this call armed. Does not
   * replay retained events: a wait's cursor answers exactly one boolean, it does not resume a
   * feed (design §7.4: "订阅 cursor 和正文 pageCursor 是两种不同的游标，不能互换").
   */
  oncePerObject(
    caller: PaneInspectionCaller,
    paneId: string,
    baselineContent: unknown,
    onChange: (descriptor: PaneDescriptorV1) => void,
    onUnavailable: () => void,
    executionRef?: import('michi-shared').ExecutionRef,
  ): () => void {
    const target = safeResolveTarget(paneId);
    if (!target) { onUnavailable(); return () => {}; }

    let done = false;
    let chatHubUnsub: (() => void) | undefined;
    let runUnsub: (() => void) | undefined;
    let pollTimer: unknown;

    const stop = (): void => {
      if (chatHubUnsub) { chatHubUnsub(); chatHubUnsub = undefined; }
      if (runUnsub) { runUnsub(); runUnsub = undefined; }
      if (pollTimer !== undefined) { this.clock.clearInterval(pollTimer); pollTimer = undefined; }
    };

    /** Re-inspects once and reports a change relative to `baselineContent` (the check the caller
     *  already performed before arming this listener — this method never re-derives its own
     *  baseline, so it agrees exactly with whatever the caller compared against). Never
     *  coalesces: `wait_pane` has no output-only throttling window (design §7.4 only speaks of
     *  changed/terminal/timed_out/unavailable, none of which are a coalescing target). Its inspect()
     *  does publish to the ring, as it must: wait_pane returns the descriptor's cursor, which has
     *  to be a ring token. When
     *  `executionRef` is supplied, the re-inspect is scoped to it (design §7.4's `until:
     *  'terminal'` needs T1's OWN status, not whatever the object's current/latest attempt is —
     *  the plain unscoped read a caller with no executionRef gets is exactly what `until:
     *  'changed'` wants instead). */
    const checkOnce = (): void => {
      if (done) return;
      let descriptor: PaneDescriptorV1;
      try {
        authorizeCaller(caller, target);
        descriptor = inspect(caller, { locator: paneIdLocator(paneId), executionRef });
      } catch (err) {
        if (err instanceof PaneInspectionError && (err.code === 'NOT_FOUND' || err.code === 'NAVIGATION_DISABLED')) {
          done = true;
          stop();
          onUnavailable();
        }
        // Any other error (e.g. SOURCE_UNAVAILABLE) is transient — try again on the next trigger.
        return;
      }
      if (contentEquals(baselineContent, paneContentSnapshot(descriptor))) return; // unchanged — keep waiting.
      done = true;
      stop();
      onChange(descriptor);
    };

    if (target.kind === 'agent_run' && this.agentRunEvents) {
      runUnsub = this.agentRunEvents.subscribe(target.runId, () => checkOnce());
    } else if (target.kind === 'node') {
      const observation = this.chatHub.getSnapshot(target.nodeId);
      const chatId = observation?.chatId ?? target.nodeId;
      chatHubUnsub = this.chatHub.subscribe(chatId, { send: () => checkOnce(), close: () => {} });
    }
    // Coarse poll fallback for every kind (surface/agent_run-without-bus/node): a change whose
    // only cause is outside the live-event source (presence, metadata, or — for `surface` — the
    // only content it ever has) must still eventually be observed rather than silently missed
    // for the whole timeout window.
    pollTimer = this.clock.setInterval(() => checkOnce(), this.pollIntervalMs);

    return () => { done = true; stop(); };
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function safeResolveTarget(paneId: string) {
  try {
    return resolvePaneTarget({ paneId });
  } catch {
    return null;
  }
}

function paneIdLocator(paneId: string) {
  return { paneId };
}
