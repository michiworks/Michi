import { AgentRunCompletionMode, AgentRunStatus, AgentRunWaitingReason } from 'michi-shared';
import type { AgentRunDtoV1, AttentionKind } from 'michi-shared';
import { isServerAttentionActive } from '../services/serverAttentionStore';
import type { AgentResourceIdentity, LocatedAgentResource } from './agentIdentity';
import { agentResourceKey, identityOf } from './agentIdentity';

export type AgentRunNotificationKind = 'waiting' | 'permission' | 'failed' | 'completed';

export interface AgentRunNotification {
  key: string;
  kind: AgentRunNotificationKind;
  /** How the attention policy presents it. */
  attention: AttentionKind;
  title: string;
  body: string;
  run: LocatedAgentResource<AgentRunDtoV1>;
}

export type AgentRunNotificationState = Record<string, string>;

export interface AgentRunNotificationTracker {
  collect(args: { runs: readonly LocatedAgentResource<AgentRunDtoV1>[] }): AgentRunNotification[];
  snapshot(): AgentRunNotificationState;
}

const ATTENTION_KIND: Record<AgentRunNotificationKind, AttentionKind> = {
  waiting: 'needs_input',
  permission: 'needs_input',
  failed: 'failed',
  completed: 'finished',
};

function notificationKind(run: AgentRunDtoV1): AgentRunNotificationKind | null {
  if (run.status === AgentRunStatus.Waiting) {
    return run.waitingReason === AgentRunWaitingReason.Permission ? 'permission' : 'waiting';
  }
  if (run.status === AgentRunStatus.Failed) return 'failed';
  if (run.status === AgentRunStatus.Completed) return 'completed';
  return null;
}

function transitionMarker(run: AgentRunDtoV1): string {
  return `${run.status}:${run.waitingReason ?? ''}`;
}

function copyFor(kind: AgentRunNotificationKind, run: AgentRunDtoV1): Pick<AgentRunNotification, 'title' | 'body'> {
  const name = run.effectiveDefinition.name;
  if (kind === 'permission') return { title: `${name} needs permission`, body: run.task };
  if (kind === 'waiting') return { title: `${name} is waiting`, body: run.task };
  if (kind === 'failed') return { title: `${name} failed`, body: run.resultBundle?.handoff.conclusion || run.task };
  return { title: `${name} completed`, body: run.resultBundle?.handoff.conclusion || run.task };
}

/**
 * Derive new notifications from durable Run snapshots. Every observed state is
 * recorded, so replaying that snapshot later cannot produce a stale one;
 * whether a notification is shown (its pane in view, prefs) is the attention
 * policy's call when it is presented.
 */
export function collectAgentRunNotifications({
  runs,
  previous,
}: {
  runs: readonly LocatedAgentResource<AgentRunDtoV1>[];
  previous: AgentRunNotificationState;
}): { notifications: AgentRunNotification[]; state: AgentRunNotificationState } {
  const state = { ...previous };
  const notifications: AgentRunNotification[] = [];
  for (const resource of runs) {
    const key = agentResourceKey(identityOf(resource));
    const marker = transitionMarker(resource.value);
    const changed = state[key] !== marker;
    state[key] = marker;
    const kind = notificationKind(resource.value);
    if (!changed || !kind) continue;
    notifications.push({ key: `${key}:${marker}`, kind, attention: ATTENTION_KIND[kind], run: resource, ...copyFor(kind, resource.value) });
  }
  return { notifications, state };
}

/**
 * The backend announces this one itself, so the window raises nothing of its own: a Run in
 * notify completion mode that completed or failed (the backend's Run coordinator hands it to
 * server attention), on a connection whose backend decides attention. Every window then hears it
 * through the server's record, and only the window holding its claim raises the OS
 * notification. A Run that is only a member of a notify-mode watch cannot be told from its DTO
 * (this window never loads watches), so it keeps its local notice, as does everything an older
 * backend runs.
 */
export function isAgentRunNotificationServerDecided(notification: AgentRunNotification): boolean {
  return notification.run.value.completionMode === AgentRunCompletionMode.Notify
    && (notification.kind === 'completed' || notification.kind === 'failed')
    && isServerAttentionActive(identityOf(notification.run).backendConnectionId);
}

/** The Runs the mounted agent domain holds (AgentDomainProvider keeps it current), for readers
 *  above its provider: the chat store names the pane a server notice opens. */
let knownRuns: Readonly<Record<string, LocatedAgentResource<AgentRunDtoV1>>> | null = null;

export function noteKnownAgentRuns(runs: Readonly<Record<string, LocatedAgentResource<AgentRunDtoV1>>>): void {
  knownRuns = runs;
}

export function forgetKnownAgentRuns(runs: Readonly<Record<string, LocatedAgentResource<AgentRunDtoV1>>>): void {
  if (knownRuns === runs) knownRuns = null;
}

/** The definition name of a Run this window has loaded, if it has. */
export function knownAgentRunName(identity: AgentResourceIdentity): string | undefined {
  return knownRuns?.[agentResourceKey(identity)]?.value.effectiveDefinition?.name?.trim() || undefined;
}

/** The Run is still in the state that raised `notification`. */
export function isAgentRunNotificationCurrent(
  notification: AgentRunNotification,
  runs: Readonly<Record<string, LocatedAgentResource<AgentRunDtoV1>>>,
): boolean {
  const current = runs[agentResourceKey(identityOf(notification.run))];
  return !!current && transitionMarker(current.value) === transitionMarker(notification.run.value);
}

/** Keeps replay dedupe alive for the lifetime of one browser window/module. */
export function createAgentRunNotificationTracker(
  initial: AgentRunNotificationState = {},
): AgentRunNotificationTracker {
  let state = { ...initial };
  return {
    collect({ runs }) {
      const result = collectAgentRunNotifications({ runs, previous: state });
      state = result.state;
      return result.notifications;
    },
    snapshot: () => ({ ...state }),
  };
}
