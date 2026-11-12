import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunCompletionMode, AgentRunStatus, AgentRunWaitingReason } from 'michi-shared';
import type { AgentRunDtoV1 } from 'michi-shared';

import {
  collectAgentRunNotifications, createAgentRunNotificationTracker, isAgentRunNotificationCurrent,
  isAgentRunNotificationServerDecided,
} from './agentRunNotifications';
import { agentResourceKey } from './agentIdentity';
import { noteServerAttentionCapabilities, resetServerAttentionStore } from '../services/serverAttentionStore';

function located(status: AgentRunStatus, waitingReason: AgentRunWaitingReason | null = null) {
  return {
    backendConnectionId: 'backend-a',
    value: {
      id: 'run-1', status, waitingReason, task: 'Inspect the change',
      effectiveDefinition: { name: 'Reviewer' }, resultBundle: null,
    } as AgentRunDtoV1,
  };
}

describe('collectAgentRunNotifications', () => {
  it('notifies waiting, failure, and completion transitions once across replay', () => {
    let state = {};
    let result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission)], previous: state });
    expect(result.notifications.map((item) => item.kind)).toEqual(['permission']);
    state = result.state;
    result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission)], previous: state });
    expect(result.notifications).toEqual([]);
    result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Failed)], previous: result.state });
    expect(result.notifications.map((item) => item.kind)).toEqual(['failed']);
    result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Completed)], previous: result.state });
    expect(result.notifications.map((item) => item.kind)).toEqual(['completed']);
  });

  it('tells the attention policy what kind of notice each one is', () => {
    const runs = [
      located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission),
      { ...located(AgentRunStatus.Waiting), backendConnectionId: 'backend-b' },
      { ...located(AgentRunStatus.Failed), backendConnectionId: 'backend-c' },
      { ...located(AgentRunStatus.Completed), backendConnectionId: 'backend-d' },
    ];
    const { notifications } = collectAgentRunNotifications({ runs, previous: {} });
    expect(notifications.map((item) => [item.kind, item.attention])).toEqual([
      ['permission', 'needs_input'], ['waiting', 'needs_input'], ['failed', 'failed'], ['completed', 'finished'],
    ]);
  });

  it('retains replay dedupe in a per-window tracker', () => {
    const tracker = createAgentRunNotificationTracker();
    expect(tracker.collect({ runs: [located(AgentRunStatus.Completed)] })).toHaveLength(1);
    expect(tracker.collect({ runs: [located(AgentRunStatus.Completed)] })).toEqual([]);
  });

  it('is current only while the Run is still in the state that raised it', () => {
    const [waiting] = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission)], previous: {} }).notifications;
    const key = agentResourceKey({ backendConnectionId: 'backend-a', id: 'run-1' });
    expect(isAgentRunNotificationCurrent(waiting!, { [key]: located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission) })).toBe(true);
    expect(isAgentRunNotificationCurrent(waiting!, { [key]: located(AgentRunStatus.Running) })).toBe(false);
    expect(isAgentRunNotificationCurrent(waiting!, {})).toBe(false);
  });
});

describe('isAgentRunNotificationServerDecided', () => {
  afterEach(() => resetServerAttentionStore());

  const notice = (status: AgentRunStatus, completionMode: AgentRunCompletionMode, waitingReason: AgentRunWaitingReason | null = null) => {
    const run = located(status, waitingReason);
    return collectAgentRunNotifications({ runs: [{ ...run, value: { ...run.value, completionMode } }], previous: {} }).notifications[0]!;
  };

  it('leaves a notify-mode Run that ended to a backend that decides attention', () => {
    expect(isAgentRunNotificationServerDecided(notice(AgentRunStatus.Completed, AgentRunCompletionMode.Notify)), 'an older backend').toBe(false);
    noteServerAttentionCapabilities('backend-a', { attention: 'v1' });
    expect(isAgentRunNotificationServerDecided(notice(AgentRunStatus.Completed, AgentRunCompletionMode.Notify))).toBe(true);
    expect(isAgentRunNotificationServerDecided(notice(AgentRunStatus.Failed, AgentRunCompletionMode.Notify))).toBe(true);
    // The server announces neither a Run waiting on the user nor one it is not asked to notify about.
    expect(isAgentRunNotificationServerDecided(notice(AgentRunStatus.Waiting, AgentRunCompletionMode.Notify, AgentRunWaitingReason.Permission))).toBe(false);
    for (const mode of [AgentRunCompletionMode.Wait, AgentRunCompletionMode.Wake, AgentRunCompletionMode.Detach]) {
      expect(isAgentRunNotificationServerDecided(notice(AgentRunStatus.Completed, mode)), mode).toBe(false);
    }
  });
});
