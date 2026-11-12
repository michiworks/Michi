import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunDtoV1, AgentRunEventV1 } from 'michi-shared';
import { AgentRunEventType, AgentRunStatus } from 'michi-shared';
import type { AgentRunSubscriptionOptions } from '../services/api/agentRuns';
import { SseHttpError } from '../services/api/sseParser';
import { HttpResponseError } from '../services/api/httpError';
import {
  type AgentDomainApi, AgentDomainProvider, agentDomainReducer,
  initialAgentDomainState, useAgentDomain,
} from './agentDomain';
import { knownAgentRunName } from './agentRunNotifications';
import { agentResourceKey, locatedAgentResource } from './agentIdentity';

const hash = 'a'.repeat(64);
const runFixture = (backend: string, overrides: Partial<AgentRunDtoV1> = {}) => locatedAgentResource(backend, {
  version: 1, id: 'same-run', ownerUserId: 'owner', workspaceId: `workspace-${backend}`, definitionId: null,
  definitionRevision: null,
  effectiveDefinition: { version: 1, name: 'Worker', description: 'Does work.', instructions: 'Do work.', runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] }, permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 }, contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: false, allowArtifactContext: false, maxEstimatedChars: 10_000 } },
  invocationMode: 'delegated', completionMode: 'notify', parentRunId: null, parentNodeId: 'node-1', parentTurnId: 'turn-1', parentMessageId: 'message-1', parentToolCallId: null,
  task: 'Task', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
  executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: `workspace-${backend}`, snapshotHash: hash, createdAt: 1 },
  status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: 'attempt-1', resultBundle: null,
  latestEventSeq: -1, createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null,
  ...overrides,
} as AgentRunDtoV1);

const statusEvent = (seq: number, from: AgentRunStatus, to: AgentRunStatus): AgentRunEventV1 => ({
  version: 1, runId: 'same-run', seq, attemptId: 'attempt-1', type: AgentRunEventType.RunStatusChanged,
  payload: { version: 1, from, to, waitingReason: null }, createdAt: 100 + seq,
});

describe('Agent domain reducer', () => {
  it('dedupes sequence numbers, rejects out-of-order events, and keeps terminal state idempotent', () => {
    const resource = runFixture('remote-a');
    let state = agentDomainReducer(initialAgentDomainState, { type: 'upsert-runs', resources: [resource] });
    state = agentDomainReducer(state, { type: 'apply-event', backendConnectionId: 'remote-a', event: statusEvent(0, AgentRunStatus.Running, AgentRunStatus.Completed) });
    const completed = state;
    expect(Object.values(state.runs)[0].value.status).toBe(AgentRunStatus.Completed);
    expect(state.cursors[agentResourceKey({ backendConnectionId: 'remote-a', id: 'same-run' })]).toBe(0);
    expect(agentDomainReducer(state, { type: 'apply-event', backendConnectionId: 'remote-a', event: statusEvent(0, AgentRunStatus.Running, AgentRunStatus.Completed) })).toBe(state);
    expect(agentDomainReducer(state, { type: 'apply-event', backendConnectionId: 'remote-a', event: statusEvent(2, AgentRunStatus.Completed, AgentRunStatus.Running) })).toBe(state);
    state = agentDomainReducer(state, { type: 'apply-event', backendConnectionId: 'remote-a', event: statusEvent(1, AgentRunStatus.Completed, AgentRunStatus.Running) });
    expect(Object.values(state.runs)[0].value.status).toBe(AgentRunStatus.Completed);
    expect(state.eventsByRun[agentResourceKey({ backendConnectionId: 'remote-a', id: 'same-run' })]).toHaveLength(2);
    expect(completed.runs).not.toBe(state.runs);
  });

  it('updates parent/workspace indexes after create, archive projection, and delete', () => {
    const resource = runFixture('remote-a');
    let state = agentDomainReducer(initialAgentDomainState, { type: 'upsert-runs', resources: [resource] });
    state = agentDomainReducer(state, { type: 'upsert-runs', resources: [runFixture('remote-a', { archivedAt: 50 })] });
    expect(state.runs[agentResourceKey({ backendConnectionId: 'remote-a', id: 'same-run' })].value.archivedAt).toBe(50);
    state = agentDomainReducer(state, { type: 'remove-run', identity: { backendConnectionId: 'remote-a', id: 'same-run' } });
    expect(state.workspaceRunKeys).toEqual({});
    expect(state.parentRunKeys).toEqual({});
    expect(state.parentTurnRunKeys).toEqual({});
  });
});

describe('AgentDomainProvider subscriptions', () => {
  it('reconciles a sequence gap authoritatively and reports malformed frames without corrupting state', async () => {
    let subscription: AgentRunSubscriptionOptions | null = null;
    const authoritative = runFixture('local', { latestEventSeq: 2 });
    const getRun = vi.fn(async () => authoritative);
    const getEvents = vi.fn(async () => [statusEvent(0, AgentRunStatus.Running, AgentRunStatus.Completed)]);
    const api: AgentDomainApi = {
      listDefinitions: async () => [], listRuns: async () => [runFixture('local')], spawnRun: async () => runFixture('local'),
      getRun, getEvents,
      subscribe: (_workspaceId, options) => { subscription = options; return () => {}; },
      sendInput: async () => {}, cancelRun: async () => {},
    };
    const wrapper = ({ children }: { children: React.ReactNode }) => <AgentDomainProvider api={api}>{children}</AgentDomainProvider>;
    const { result } = renderHook(() => useAgentDomain(), { wrapper });
    await act(async () => { await result.current.loadRuns({ version: 1, workspaceId: 'workspace-local' }); });
    act(() => { result.current.subscribeWorkspace('workspace-local'); });
    await act(async () => { await subscription!.onEnvelope({ version: 1, event: 'agent_run_event', runId: 'same-run', seq: 2, eventData: statusEvent(2, AgentRunStatus.Running, AgentRunStatus.Completed), gapAfterSeq: null, emittedAt: 10 }); });
    expect(getRun).toHaveBeenCalledWith({ backendConnectionId: 'local', id: 'same-run' });
    expect(getEvents).toHaveBeenCalledWith({ backendConnectionId: 'local', id: 'same-run' }, -1);
    await waitFor(() => expect(result.current.state.cursors[agentResourceKey({ backendConnectionId: 'local', id: 'same-run' })]).toBe(0));
    const before = result.current.state.runs;
    act(() => { subscription!.onMalformed?.(new Error('wrong version'), '{}'); });
    expect(result.current.state.runs).toBe(before);
    expect(result.current.state.errors.at(-1)).toBe('wrong version');
  });

  it('reconnects with backoff from the cursors applied since, until the workspace is refused or released', async () => {
    vi.useFakeTimers();
    try {
      const feeds: AgentRunSubscriptionOptions[] = [];
      const api: AgentDomainApi = {
        listDefinitions: async () => [], listRuns: async () => [runFixture('local')], spawnRun: async () => runFixture('local'),
        getRun: async () => runFixture('local'), getEvents: async () => [],
        subscribe: (_workspaceId, options) => { feeds.push(options); return () => {}; },
        sendInput: async () => {}, cancelRun: async () => {},
      };
      const wrapper = ({ children }: { children: React.ReactNode }) => <AgentDomainProvider api={api}>{children}</AgentDomainProvider>;
      const { result } = renderHook(() => useAgentDomain(), { wrapper });
      await act(async () => { await result.current.loadRuns({ version: 1, workspaceId: 'workspace-local' }); });
      let release = () => {};
      act(() => { release = result.current.subscribeWorkspace('workspace-local'); });
      await act(async () => { await feeds[0].onEnvelope({ version: 1, event: 'agent_run_event', runId: 'same-run', seq: 0, eventData: statusEvent(0, AgentRunStatus.Running, AgentRunStatus.Running), gapAfterSeq: null, emittedAt: 10 }); });

      act(() => feeds[0].onDisconnect?.(new Error('backend restarted')));
      act(() => { vi.advanceTimersByTime(999); });
      expect(feeds).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(1); });
      expect(feeds).toHaveLength(2);
      expect(feeds[1].cursors).toEqual({ 'same-run': 0 });
      expect(result.current.subscribeWorkspace('workspace-local'), 'one feed per workspace while it reconnects').toBe(release);

      act(() => feeds[1].onDisconnect?.());
      act(() => { vi.advanceTimersByTime(1_999); });
      expect(feeds, 'the delay doubles').toHaveLength(2);
      act(() => { vi.advanceTimersByTime(1); });
      expect(feeds).toHaveLength(3);
      act(() => { feeds[2].onOpen?.(); feeds[2].onDisconnect?.(); });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(feeds, 'an open feed starts the delay over').toHaveLength(4);

      act(() => feeds[3].onDisconnect?.(new SseHttpError(403)));
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(feeds, 'a refused workspace is not retried').toHaveLength(4);

      act(() => { release = result.current.subscribeWorkspace('workspace-local'); });
      expect(feeds).toHaveLength(5);
      act(() => { feeds[4].onDisconnect?.(); release(); });
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(feeds, 'a released feed is not retried').toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a Run deleted on the server from the cursors after a 404, and stops when nothing was dropped', async () => {
    vi.useFakeTimers();
    try {
      const feeds: AgentRunSubscriptionOptions[] = [];
      const getRun = vi.fn(async () => { throw new HttpResponseError('not_found', 404); });
      const api: AgentDomainApi = {
        listDefinitions: async () => [], listRuns: async () => [runFixture('local')], spawnRun: async () => runFixture('local'),
        getRun, getEvents: async () => [],
        subscribe: (_workspaceId, options) => { feeds.push(options); return () => {}; },
        sendInput: async () => {}, cancelRun: async () => {},
      };
      const wrapper = ({ children }: { children: React.ReactNode }) => <AgentDomainProvider api={api}>{children}</AgentDomainProvider>;
      const { result } = renderHook(() => useAgentDomain(), { wrapper });
      await act(async () => { await result.current.loadRuns({ version: 1, workspaceId: 'workspace-local' }); });
      act(() => { result.current.subscribeWorkspace('workspace-local'); });
      await act(async () => { await feeds[0].onEnvelope({ version: 1, event: 'agent_run_event', runId: 'same-run', seq: 0, eventData: statusEvent(0, AgentRunStatus.Running, AgentRunStatus.Running), gapAfterSeq: null, emittedAt: 10 }); });

      act(() => feeds[0].onDisconnect?.(new Error('backend restarted')));
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(feeds[1].cursors).toEqual({ 'same-run': 0 });

      await act(async () => { feeds[1].onDisconnect?.(new SseHttpError(404)); await Promise.resolve(); await Promise.resolve(); });
      expect(getRun).toHaveBeenCalledWith({ backendConnectionId: 'local', id: 'same-run' });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(feeds).toHaveLength(3);
      expect(feeds[2].cursors, 'the deleted Run is no longer resumed').toEqual({});

      await act(async () => { feeds[2].onDisconnect?.(new SseHttpError(404)); await Promise.resolve(); await Promise.resolve(); });
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(feeds, 'a 404 with nothing left to drop is not retried').toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('knownAgentRunName', () => {
  it('names a Run the mounted provider has loaded, for readers above it, and nothing once it unmounts', async () => {
    const api: AgentDomainApi = {
      listDefinitions: async () => [], listRuns: async () => [runFixture('remote-a')], spawnRun: async () => runFixture('remote-a'),
      getRun: async () => runFixture('remote-a'), getEvents: async () => [], subscribe: () => () => {},
      sendInput: async () => {}, cancelRun: async () => {},
    };
    const wrapper = ({ children }: { children: React.ReactNode }) => <AgentDomainProvider api={api}>{children}</AgentDomainProvider>;
    const { result, unmount } = renderHook(() => useAgentDomain(), { wrapper });
    const identity = { backendConnectionId: 'remote-a', id: 'same-run' };
    expect(knownAgentRunName(identity)).toBeUndefined();
    await act(async () => { await result.current.loadRuns({ version: 1, workspaceId: 'workspace-remote-a' }); });
    expect(knownAgentRunName(identity)).toBe('Worker');
    expect(knownAgentRunName({ backendConnectionId: 'remote-b', id: 'same-run' }), 'another backend').toBeUndefined();
    unmount();
    expect(knownAgentRunName(identity)).toBeUndefined();
  });
});
