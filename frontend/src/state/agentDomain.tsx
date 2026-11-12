import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AgentDefinitionDtoV1, AgentRunDtoV1, AgentRunEventV1, AgentRunInputRequestV1, AgentRunInteractionDtoV1,
  AgentRunListQueryV1, AgentRunWatchDtoV1, CancelAgentRunRequestV1, SpawnAgentRunRequestV1,
} from 'michi-shared';
import { AgentRunEventType, AgentRunStatus, isAgentRunTerminal } from 'michi-shared';
import {
  cancelAgentRun, getAgentRun, getAgentRunEvents, listAgentDefinitions, listAgentRuns,
  sendAgentRunInput, spawnAgentRun, subscribeAgentRuns, type AgentRunRouteTarget,
} from '../services/api';
import { SseHttpError } from '../services/api/sseParser';
import { HttpResponseError } from '../services/api/httpError';
import { backendConnectionIdForWorkspace } from '../config/backendConnections';
import {
  type AgentResourceIdentity, type LocatedAgentResource, agentResourceKey,
  identityOf, parentAgentIndexKey, parentTurnAgentIndexKey, workspaceAgentIndexKey,
} from './agentIdentity';
import { forgetKnownAgentRuns, noteKnownAgentRuns } from './agentRunNotifications';

export interface AgentDomainState {
  definitions: Record<string, LocatedAgentResource<AgentDefinitionDtoV1>>;
  runs: Record<string, LocatedAgentResource<AgentRunDtoV1>>;
  watches: Record<string, LocatedAgentResource<AgentRunWatchDtoV1>>;
  eventsByRun: Record<string, AgentRunEventV1[]>;
  interactionsByRun: Record<string, AgentRunInteractionDtoV1[]>;
  cursors: Record<string, number>;
  workspaceRunKeys: Record<string, string[]>;
  parentRunKeys: Record<string, string[]>;
  parentTurnRunKeys: Record<string, string[]>;
  subscribedWorkspaces: Record<string, boolean>;
  optimisticInput: Record<string, boolean>;
  optimisticCancel: Record<string, boolean>;
  errors: string[];
}

export const initialAgentDomainState: AgentDomainState = {
  definitions: {}, runs: {}, watches: {}, eventsByRun: {}, interactionsByRun: {}, cursors: {},
  workspaceRunKeys: {}, parentRunKeys: {}, parentTurnRunKeys: {}, subscribedWorkspaces: {}, optimisticInput: {}, optimisticCancel: {}, errors: [],
};

export type AgentDomainAction =
  | { type: 'upsert-definitions'; resources: Array<LocatedAgentResource<AgentDefinitionDtoV1>> }
  | { type: 'remove-definition'; identity: AgentResourceIdentity }
  | { type: 'upsert-runs'; resources: Array<LocatedAgentResource<AgentRunDtoV1>> }
  | { type: 'remove-run'; identity: AgentResourceIdentity }
  | { type: 'upsert-watch'; resource: LocatedAgentResource<AgentRunWatchDtoV1> }
  | { type: 'replace-run-feed'; resource: LocatedAgentResource<AgentRunDtoV1>; events: AgentRunEventV1[]; interactions?: AgentRunInteractionDtoV1[] }
  | { type: 'apply-event'; backendConnectionId: string; event: AgentRunEventV1 }
  | { type: 'subscription'; workspaceKey: string; active: boolean }
  | { type: 'optimistic-input'; runKey: string; active: boolean }
  | { type: 'optimistic-cancel'; runKey: string; active: boolean }
  | { type: 'error'; message: string };

function withIndexes(state: AgentDomainState, runs: AgentDomainState['runs']): AgentDomainState {
  const workspaceRunKeys: Record<string, string[]> = {};
  const parentRunKeys: Record<string, string[]> = {};
  const parentTurnRunKeys: Record<string, string[]> = {};
  for (const [runKey, resource] of Object.entries(runs)) {
    const run = resource.value;
    const workspaceKey = workspaceAgentIndexKey(resource.backendConnectionId, run.workspaceId);
    (workspaceRunKeys[workspaceKey] ??= []).push(runKey);
    if (run.parentMessageId) {
      const parentKey = parentAgentIndexKey(resource.backendConnectionId, run.parentMessageId, run.parentToolCallId);
      (parentRunKeys[parentKey] ??= []).push(runKey);
    }
    if (run.parentTurnId) (parentTurnRunKeys[parentTurnAgentIndexKey(resource.backendConnectionId, run.parentTurnId)] ??= []).push(runKey);
  }
  return { ...state, runs, workspaceRunKeys, parentRunKeys, parentTurnRunKeys };
}

function applyStatusEvent(run: AgentRunDtoV1, event: AgentRunEventV1): AgentRunDtoV1 {
  if (event.type !== AgentRunEventType.RunStatusChanged || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return run;
  const to = event.payload.to;
  const from = event.payload.from;
  if (typeof to !== 'string' || !Object.values(AgentRunStatus).includes(to as AgentRunStatus)) return run;
  if (isAgentRunTerminal(run.status)) return run;
  if (from !== run.status) return run;
  const next = to as AgentRunStatus;
  return {
    ...run,
    status: next,
    waitingReason: next === AgentRunStatus.Waiting && typeof event.payload.waitingReason === 'string'
      ? event.payload.waitingReason as AgentRunDtoV1['waitingReason'] : null,
    completedAt: isAgentRunTerminal(next) ? event.createdAt : run.completedAt,
    latestEventSeq: event.seq,
  };
}

export function agentDomainReducer(state: AgentDomainState, action: AgentDomainAction): AgentDomainState {
  switch (action.type) {
    case 'upsert-definitions': {
      const definitions = { ...state.definitions };
      for (const resource of action.resources) definitions[agentResourceKey(identityOf(resource))] = resource;
      return { ...state, definitions };
    }
    case 'remove-definition': {
      const definitions = { ...state.definitions }; delete definitions[agentResourceKey(action.identity)];
      return { ...state, definitions };
    }
    case 'upsert-runs': {
      const runs = { ...state.runs };
      for (const resource of action.resources) runs[agentResourceKey(identityOf(resource))] = resource;
      return withIndexes(state, runs);
    }
    case 'remove-run': {
      const key = agentResourceKey(action.identity); const runs = { ...state.runs }; delete runs[key];
      const eventsByRun = { ...state.eventsByRun }; delete eventsByRun[key];
      const interactionsByRun = { ...state.interactionsByRun }; delete interactionsByRun[key];
      const cursors = { ...state.cursors }; delete cursors[key];
      return withIndexes({ ...state, eventsByRun, interactionsByRun, cursors }, runs);
    }
    case 'upsert-watch': return { ...state, watches: { ...state.watches, [agentResourceKey(identityOf(action.resource))]: action.resource } };
    case 'replace-run-feed': {
      const runKey = agentResourceKey(identityOf(action.resource));
      const ordered = [...action.events].sort((a, b) => a.seq - b.seq).filter((event, index, all) => index === 0 || all[index - 1].seq !== event.seq);
      const cursor = ordered.at(-1)?.seq ?? action.resource.value.latestEventSeq ?? -1;
      const base = withIndexes(state, { ...state.runs, [runKey]: action.resource });
      return { ...base, eventsByRun: { ...base.eventsByRun, [runKey]: ordered }, interactionsByRun: action.interactions ? { ...base.interactionsByRun, [runKey]: action.interactions } : base.interactionsByRun, cursors: { ...base.cursors, [runKey]: cursor } };
    }
    case 'apply-event': {
      const runKey = agentResourceKey({ backendConnectionId: action.backendConnectionId, id: action.event.runId });
      const cursor = state.cursors[runKey] ?? -1;
      if (action.event.seq <= cursor || action.event.seq !== cursor + 1) return state;
      const resource = state.runs[runKey];
      if (!resource) return state;
      const updated = { ...resource, value: applyStatusEvent(resource.value, action.event) };
      const base = withIndexes(state, { ...state.runs, [runKey]: updated });
      return { ...base, eventsByRun: { ...base.eventsByRun, [runKey]: [...(base.eventsByRun[runKey] ?? []), action.event] }, cursors: { ...base.cursors, [runKey]: action.event.seq } };
    }
    case 'subscription': return { ...state, subscribedWorkspaces: { ...state.subscribedWorkspaces, [action.workspaceKey]: action.active } };
    case 'optimistic-input': return { ...state, optimisticInput: { ...state.optimisticInput, [action.runKey]: action.active } };
    case 'optimistic-cancel': return { ...state, optimisticCancel: { ...state.optimisticCancel, [action.runKey]: action.active } };
    case 'error': return { ...state, errors: [...state.errors.slice(-49), action.message] };
  }
}

export interface AgentDomainApi {
  listDefinitions: typeof listAgentDefinitions;
  listRuns: typeof listAgentRuns;
  spawnRun: typeof spawnAgentRun;
  getRun: typeof getAgentRun;
  getEvents: typeof getAgentRunEvents;
  subscribe: typeof subscribeAgentRuns;
  sendInput: typeof sendAgentRunInput;
  cancelRun: typeof cancelAgentRun;
}

const defaultApi: AgentDomainApi = { listDefinitions: listAgentDefinitions, listRuns: listAgentRuns, spawnRun: spawnAgentRun, getRun: getAgentRun, getEvents: getAgentRunEvents, subscribe: subscribeAgentRuns, sendInput: sendAgentRunInput, cancelRun: cancelAgentRun };

export interface AgentDomainContextValue {
  state: AgentDomainState;
  loadDefinitions(workspaceId?: string | null): Promise<void>;
  loadRuns(query: AgentRunListQueryV1): Promise<void>;
  spawn(request: SpawnAgentRunRequestV1): Promise<LocatedAgentResource<AgentRunDtoV1>>;
  reconcileRun(identity: AgentResourceIdentity): Promise<void>;
  subscribeWorkspace(workspaceId: string): () => void;
  sendInput(target: AgentRunRouteTarget, request: AgentRunInputRequestV1): Promise<void>;
  cancel(target: AgentRunRouteTarget, request: CancelAgentRunRequestV1): Promise<void>;
  dispatch: React.Dispatch<AgentDomainAction>;
}

const AgentDomainContext = createContext<AgentDomainContextValue | null>(null);

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** The workspace is not ours (403) or the request can never be valid (400): retrying cannot help. */
const FATAL_STATUSES = new Set([400, 403]);

export function AgentDomainProvider({ children, api = defaultApi }: { children: React.ReactNode; api?: AgentDomainApi }) {
  const [state, baseDispatch] = useReducer(agentDomainReducer, initialAgentDomainState);
  const stateRef = useRef(state); stateRef.current = state;
  const subscriptions = useRef(new Map<string, () => void>());
  const dispatch = useCallback<React.Dispatch<AgentDomainAction>>((action) => {
    stateRef.current = agentDomainReducer(stateRef.current, action);
    baseDispatch(action);
  }, []);

  useEffect(() => () => { for (const unsubscribe of subscriptions.current.values()) unsubscribe(); subscriptions.current.clear(); }, []);
  // Readers above this provider (the chat store opens a server notice's Run pane) look names up there.
  useEffect(() => {
    noteKnownAgentRuns(state.runs);
    return () => forgetKnownAgentRuns(state.runs);
  }, [state.runs]);

  const loadDefinitions = useCallback(async (workspaceId?: string | null) => {
    dispatch({ type: 'upsert-definitions', resources: await api.listDefinitions(workspaceId) });
  }, [api]);
  const loadRuns = useCallback(async (query: AgentRunListQueryV1) => {
    dispatch({ type: 'upsert-runs', resources: await api.listRuns(query) });
  }, [api]);
  const spawn = useCallback(async (request: SpawnAgentRunRequestV1) => {
    const resource = await api.spawnRun(request); dispatch({ type: 'upsert-runs', resources: [resource] }); return resource;
  }, [api]);
  const reconcileRun = useCallback(async (identity: AgentResourceIdentity) => {
    const [resource, events] = await Promise.all([api.getRun(identity), api.getEvents(identity, -1)]);
    dispatch({ type: 'replace-run-feed', resource, events });
  }, [api]);
  const sendInput = useCallback(async (target: AgentRunRouteTarget, request: AgentRunInputRequestV1) => {
    const runKey = agentResourceKey(target.identity); dispatch({ type: 'optimistic-input', runKey, active: true });
    try { await api.sendInput(target, request); } finally { dispatch({ type: 'optimistic-input', runKey, active: false }); }
  }, [api, dispatch]);
  const cancel = useCallback(async (target: AgentRunRouteTarget, request: CancelAgentRunRequestV1) => {
    const runKey = agentResourceKey(target.identity); dispatch({ type: 'optimistic-cancel', runKey, active: true });
    try { await api.cancelRun(target, request); } finally { dispatch({ type: 'optimistic-cancel', runKey, active: false }); }
  }, [api, dispatch]);
  const subscribeWorkspace = useCallback((workspaceId: string) => {
    const backendConnectionId = backendConnectionIdForWorkspace(workspaceId);
    const workspaceKey = workspaceAgentIndexKey(backendConnectionId, workspaceId);
    const existing = subscriptions.current.get(workspaceKey); if (existing) return existing;
    let stopped = false;
    let unsubscribeTransport: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN_MS;
    // Runs deleted on the server: resuming them would answer every reconnect with 404.
    const gone = new Set<string>();
    const dropDeletedRuns = async (runIds: string[]): Promise<boolean> => {
      const missing = await Promise.all(runIds.map((id) => api.getRun({ backendConnectionId, id }).then(
        () => false,
        (error: unknown) => error instanceof HttpResponseError && error.status === 404,
      )));
      runIds.forEach((id, index) => { if (missing[index]) gone.add(id); });
      return missing.some(Boolean);
    };
    const connect = () => {
      // Each connection resumes from the cursors applied so far.
      const cursors: Record<string, number> = {};
      for (const [key, cursor] of Object.entries(stateRef.current.cursors)) {
        const resource = stateRef.current.runs[key];
        if (resource?.backendConnectionId === backendConnectionId && resource.value.workspaceId === workspaceId && !gone.has(resource.value.id)) cursors[resource.value.id] = cursor;
      }
      unsubscribeTransport = api.subscribe(workspaceId, {
        cursors,
        onOpen: () => { delay = RETRY_MIN_MS; },
        onEnvelope: async (envelope) => {
          if (envelope.event === 'heartbeat') return;
          if (envelope.event === 'agent_run_gap' && envelope.runId) {
            await reconcileRun({ backendConnectionId, id: envelope.runId }); return;
          }
          const event = envelope.eventData; if (!event) return;
          const runKey = agentResourceKey({ backendConnectionId, id: event.runId });
          const cursor = stateRef.current.cursors[runKey] ?? -1;
          if (event.seq > cursor + 1) { await reconcileRun({ backendConnectionId, id: event.runId }); return; }
          dispatch({ type: 'apply-event', backendConnectionId, event });
        },
        onMalformed: (error) => dispatch({ type: 'error', message: error.message }),
        onDisconnect: (error) => {
          if (stopped) return;
          if (error) dispatch({ type: 'error', message: error.message });
          dispatch({ type: 'subscription', workspaceKey, active: false });
          const giveUp = () => { if (subscriptions.current.get(workspaceKey) === unsubscribe) subscriptions.current.delete(workspaceKey); };
          if (error instanceof SseHttpError && FATAL_STATUSES.has(error.status)) { giveUp(); return; }
          if (error instanceof SseHttpError && error.status === 404) {
            // A resumed Run was deleted, or the workspace is gone: retry only without the deleted Runs.
            void dropDeletedRuns(Object.keys(cursors)).then((dropped) => {
              if (stopped) return;
              if (!dropped) { giveUp(); return; }
              delay = RETRY_MIN_MS;
              timer = setTimeout(connect, delay);
            });
            return;
          }
          // A restarted or briefly unreachable backend, or one that cut a slow
          // feed: the reconnect's replay brings the Runs back to their cursors.
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        },
      });
      dispatch({ type: 'subscription', workspaceKey, active: true });
    };
    const unsubscribe = () => {
      stopped = true; if (timer) clearTimeout(timer); unsubscribeTransport?.();
      if (subscriptions.current.get(workspaceKey) === unsubscribe) subscriptions.current.delete(workspaceKey);
      dispatch({ type: 'subscription', workspaceKey, active: false });
    };
    subscriptions.current.set(workspaceKey, unsubscribe); connect(); return unsubscribe;
  }, [api, reconcileRun]);

  const value = useMemo<AgentDomainContextValue>(() => ({ state, loadDefinitions, loadRuns, spawn, reconcileRun, subscribeWorkspace, sendInput, cancel, dispatch }), [state, loadDefinitions, loadRuns, spawn, reconcileRun, subscribeWorkspace, sendInput, cancel, dispatch]);
  return <AgentDomainContext.Provider value={value}>{children}</AgentDomainContext.Provider>;
}

export function useOptionalAgentDomain(): AgentDomainContextValue | null {
  return useContext(AgentDomainContext);
}

export function useAgentDomain(): AgentDomainContextValue {
  const value = useOptionalAgentDomain();
  if (!value) throw new Error('useAgentDomain must be used within AgentDomainProvider');
  return value;
}
