/**
 * ChatProvider end to end: a node install from the backend (a scheduled run
 * starting or finishing, a background replay gap) re-reads its workspace's
 * structure. That read can predate this window's latest edits, which have
 * not been saved yet: it must not take them back, nor have them written back
 * to the backend in their old form.
 */
import React from 'react';
import { vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => {
  const workspace = (overrides: { name?: string; archived?: boolean } = {}) => ({
    workspace: { id: 'ws-1', name: overrides.name ?? 'Workspace', created_at: 1, updated_at: 1, settings: null, active_tree_id: 't1', deleted_at: null, archived_at: null },
    trees: [
      { id: 't1', workspace_id: 'ws-1', root_node_id: 'n1', last_active_at: 10, created_at: 1, archived_at: null },
      { id: 't2', workspace_id: 'ws-1', root_node_id: 'n2', last_active_at: 9, created_at: 1, archived_at: overrides.archived ? 5 : null },
    ],
    nodes: [
      { id: 'n1', workspace_id: 'ws-1', tree_id: 't1', parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, message_count: 0, acp_session_id: 'n1' },
      { id: 'n2', workspace_id: 'ws-1', tree_id: 't2', parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 2, message_count: 0, acp_session_id: 'n2' },
    ],
    edges: [],
    messages: [],
    contexts: [
      { id: 'ctx-1', workspace_id: 'ws-1', name: 'notes', file_path: '.artifacts/notes.md', source: 'user', type: 'doc', created_at: 1, updated_at: 1 },
    ],
  });
  return {
    workspace,
    applyWorkspaceCommands: vi.fn(async (..._args: unknown[]) => {}),
    fetchWorkspaceStructure: vi.fn(async (..._args: unknown[]): Promise<unknown> => workspace()),
    subscribeBackground: vi.fn((..._args: unknown[]) => () => {}),
  };
});

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  postArtifactWatchPaths: async () => ({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeBackground: api.subscribeBackground,
  fetchPersistenceCapabilities: () => Promise.resolve({
    protocolVersion: 2, authoritativeTurnPersistence: true, durableNodePrerequisite: true,
    explicitCommands: true, backgroundWorkspaceSync: false, legacySyncAccepted: true,
  }),
  fetchAllWorkspacesMeta: () => Promise.resolve([api.workspace()]),
  fetchWorkspaceStructure: api.fetchWorkspaceStructure,
  fetchTreeMessages: () => Promise.resolve([]),
  fetchTreeMessagePage: (_workspaceId: string, _treeId: string, _connectionId?: string, _signal?: AbortSignal, page?: { nodeId?: string }) =>
    Promise.resolve({ messages: [], pages: [{ nodeId: page?.nodeId, total: 0, before: null }], turns: [] }),
  listBackendConnections: () => Promise.resolve([]),
  applyWorkspaceCommands: api.applyWorkspaceCommands,
  takeHydrationStructureCursor: () => ({ epoch: 'e1', seq: 0 }),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import { ChatProvider, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';
import type { SubscribeBackgroundOptions } from '../services/api/stream';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

type SentCommand = { type: string; payload: Record<string, unknown> };
const sentCommands = () => api.applyWorkspaceCommands.mock.calls.flatMap(([, , commands]) => commands as SentCommand[]);
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
const backgroundOptions = () => api.subscribeBackground.mock.calls.at(-1)![1] as SubscribeBackgroundOptions;

/** The two installs that re-read a workspace's structure for one node. */
const installs: Array<[string, () => Promise<unknown>]> = [
  ['a scheduled run finishing', async () => {
    backgroundOptions().onScheduledJobRun!({
      phase: 'finished', runId: 'run-1', jobId: 'job-1', jobName: 'Job', workspaceId: 'ws-1', nodeId: 'n1',
      treeId: 't1', status: 'succeeded', summary: null, error: null, notify: false, at: 1,
    });
    await waitFor(() => expect(api.fetchWorkspaceStructure).toHaveBeenCalled());
  }],
  ['a background replay gap', () => Promise.resolve(backgroundOptions().onReplayGap!(
    { chatId: 'n1', nodeId: 'n1', turnId: 'gap-turn', seq: 1 }, new AbortController().signal,
  ))],
];

async function hydrated() {
  const hook = renderHook(() => useChatStore(), { wrapper });
  await waitFor(() => expect(hook.result.current.projects.map((project) => project.id)).toEqual(['ws-1']));
  await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalled());
  // Let the hydration baseline settle before acting.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  return hook;
}

describe('ChatProvider installing a node from the backend', () => {
  beforeEach(() => {
    localStorage.clear();
    api.applyWorkspaceCommands.mockClear();
    api.subscribeBackground.mockClear();
    api.fetchWorkspaceStructure.mockReset().mockImplementation(async () => api.workspace());
  });

  it.each(installs)('keeps a thread archived just before %s', async (_name, install) => {
    const { result } = await hydrated();
    act(() => result.current.archiveTree('t2'));
    expect(result.current.projects[0].trees.find((tree) => tree.id === 't2')?.archivedAt).toBeTruthy();

    await act(async () => { await install(); });
    await waitFor(() => expect(api.fetchWorkspaceStructure).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.projects[0].trees.find((tree) => tree.id === 't2')?.archivedAt).toBeTruthy();

    await flush();
    const upserts = sentCommands().filter((command) => command.type === 'tree.upsert' && command.payload.id === 't2');
    expect(upserts.length).toBeGreaterThan(0);
    for (const upsert of upserts) expect(upsert.payload.archived_at).not.toBeNull();
  });

  it.each(installs)('keeps a workspace renamed just before %s', async (_name, install) => {
    const { result } = await hydrated();
    act(() => result.current.renameProject('ws-1', 'Renamed'));

    await act(async () => { await install(); });
    await act(async () => {});
    expect(result.current.projects[0].name).toBe('Renamed');

    await flush();
    const upserts = sentCommands().filter((command) => command.type === 'workspace.upsert');
    expect(upserts.length).toBeGreaterThan(0);
    for (const upsert of upserts) expect(upsert.payload.name).toBe('Renamed');
  });

  it.each(installs)('keeps an artifact deleted just before %s', async (_name, install) => {
    const { result } = await hydrated();
    expect(result.current.projects[0].artifacts?.map((artifact) => artifact.id)).toEqual(['ctx-1']);
    act(() => result.current.deleteContext('ctx-1'));

    await act(async () => { await install(); });
    await act(async () => {});
    expect(result.current.projects[0].artifacts ?? []).toEqual([]);

    await flush();
    expect(sentCommands().filter((command) => command.type === 'context.upsert')).toEqual([]);
    expect(sentCommands().filter((command) => command.type === 'context.delete').map((command) => command.payload.id)).toEqual(['ctx-1']);
  });

  it.each(installs)('takes another device\'s archive from %s as the backend\'s, not as an edit to send', async (_name, install) => {
    const { result } = await hydrated();
    api.fetchWorkspaceStructure.mockImplementation(async () => api.workspace({ archived: true }));

    await act(async () => { await install(); });
    await waitFor(() => expect(result.current.projects[0].trees.find((tree) => tree.id === 't2')?.archivedAt).toBe(5));

    await flush();
    expect(sentCommands().filter((command) => command.type === 'tree.upsert')).toEqual([]);
  });
});
