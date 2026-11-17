import { describe, expect, it } from 'vitest';
import { AgentRunCompletionMode, AgentRunInvocationMode, AgentRunStatus, AgentRunWaitingReason, type AgentRunDtoV1 } from 'michi-shared';
import type { LocatedAgentResource } from '../../../state/agentIdentity';
import { groupParentRunCards, selectAgentRunActivityGroups } from './agentRunSelectors';

const HASH = 'c'.repeat(64);
function located(backendConnectionId: string, id: string, status: AgentRunStatus, parentMessageId: string | null = null): LocatedAgentResource<AgentRunDtoV1> {
  const terminal = [AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled].includes(status);
  return { backendConnectionId, value: {
    version: 1, id, ownerUserId: 'owner', workspaceId: 'ws', definitionId: null, definitionRevision: null,
    effectiveDefinition: { version: 1, name: id, description: id, instructions: id, runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] }, permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 1000, maxAttempts: 1 }, contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100 } },
    invocationMode: parentMessageId ? AgentRunInvocationMode.Delegated : AgentRunInvocationMode.Manual,
    completionMode: AgentRunCompletionMode.Detach, parentRunId: null, parentAttemptId: null,
    parentNodeId: parentMessageId ? 'node' : null, parentTurnId: parentMessageId ? 'turn' : null,
    parentMessageId, parentToolCallId: parentMessageId ? 'tool' : null, task: id,
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'ws', snapshotHash: HASH, createdAt: 1 },
    status, waitingReason: status === AgentRunStatus.Waiting ? AgentRunWaitingReason.UserInput : null, activeAttemptId: null, resultBundle: null,
    latestEventSeq: 0, createdAt: 100, startedAt: 100, completedAt: terminal ? 200 : null, archivedAt: null, expiresAt: null,
  } };
}

describe('agentRunSelectors', () => {
  it('groups attention, active, failed, and recent completed Runs', () => {
    const groups = selectAgentRunActivityGroups([
      located('a', 'waiting', AgentRunStatus.Waiting), located('a', 'running', AgentRunStatus.Running),
      located('a', 'failed', AgentRunStatus.Failed), located('a', 'done', AgentRunStatus.Completed),
    ], 300, 1000);
    expect(groups.needsAttention.map((run) => run.value.id)).toEqual(['waiting']);
    expect(groups.running.map((run) => run.value.id)).toEqual(['running']);
    expect(groups.failed.map((run) => run.value.id)).toEqual(['failed']);
    expect(groups.recentlyCompleted.map((run) => run.value.id)).toEqual(['done']);
  });

  it('groups Parent cards by Backend and message, in creation order', () => {
    const earlier = located('remote-a', 'earlier', AgentRunStatus.Running, 'message-1');
    const runs = [
      located('remote-a', 'same-id', AgentRunStatus.Running, 'message-1'),
      located('remote-b', 'same-id', AgentRunStatus.Running, 'message-1'),
      { ...earlier, value: { ...earlier.value, createdAt: 50 } },
      located('remote-a', 'other', AgentRunStatus.Running, 'message-2'),
      located('remote-a', 'manual', AgentRunStatus.Running),
    ];
    const ids = (byMessage: Map<string, typeof runs>) => Object.fromEntries([...byMessage].map(([id, cards]) => [id, cards.map((run) => run.value.id)]));
    expect(ids(groupParentRunCards(runs, 'remote-a'))).toEqual({ 'message-1': ['earlier', 'same-id'], 'message-2': ['other'] });
    expect(ids(groupParentRunCards(runs, 'remote-b'))).toEqual({ 'message-1': ['same-id'] });
  });
});
