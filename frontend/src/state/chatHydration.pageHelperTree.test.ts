import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';

function workspace(activeTreeId: string | null) {
  return {
    workspace: { id: 'ws1', name: 'Test', created_at: 1, active_tree_id: activeTreeId },
    trees: [
      { id: 't-chat', root_node_id: 'n-chat', created_at: 1, last_active_at: 10 },
      // Created after the chat, so it is the most recently active tree.
      { id: 't-helper', root_node_id: 'n-helper', created_at: 2, last_active_at: 20 },
    ],
    nodes: [
      { id: 'n-chat', created_at: 1, kind: 'chat' },
      { id: 'n-helper', created_at: 2, kind: 'chat', page_id: 'pg-1' },
    ],
    edges: [],
    messages: [],
    artifacts: [],
  };
}

describe('hydrateBackendWorkspaces — page helper trees', () => {
  it('does not land on a newer page helper tree when no tree is requested', () => {
    const state = hydrateBackendWorkspaces([workspace(null)]);
    expect(state.projects[0].activeTreeId).toBe('t-chat');
  });

  it('does not keep a page helper tree as the requested active tree', () => {
    const state = hydrateBackendWorkspaces([workspace('t-helper')]);
    expect(state.projects[0].activeTreeId).toBe('t-chat');
  });

  it('keeps a requested ordinary tree', () => {
    const state = hydrateBackendWorkspaces([workspace('t-chat')]);
    expect(state.projects[0].activeTreeId).toBe('t-chat');
  });
});

describe('hydrateBackendWorkspaces — maintenance trees', () => {
  const withRun = (activeTreeId: string | null) => ({
    ...workspace(activeTreeId),
    trees: [
      { id: 't-chat', root_node_id: 'n-chat', created_at: 1, last_active_at: 10 },
      { id: 't-run', root_node_id: 'n-run', created_at: 3, last_active_at: 30 },
    ],
    nodes: [
      { id: 'n-chat', created_at: 1, kind: 'chat' },
      { id: 'n-run', created_at: 3, kind: 'chat', maintenance_job_id: 'job-maint', message_count: 2 },
    ],
  });

  it('keeps the newer maintenance run in state without landing on it', () => {
    for (const requested of [null, 't-run']) {
      const state = hydrateBackendWorkspaces([withRun(requested)]);
      expect(state.projects[0].activeTreeId).toBe('t-chat');
      expect(state.projects[0].chatIds).toContain('n-run');
      expect(state.nodes['n-run']?.maintenanceJobId).toBe('job-maint');
    }
  });
});

describe('hydrateBackendWorkspaces — Scheduled-only runs, Trash and the archive', () => {
  const withRest = (activeTreeId: string | null) => ({
    ...workspace(activeTreeId),
    trees: [
      { id: 't-chat', root_node_id: 'n-chat', created_at: 1, last_active_at: 10 },
      { id: 't-old', root_node_id: 'n-old', created_at: 1, last_active_at: 15, archived_at: 16 },
      { id: 't-binned', root_node_id: 'n-binned', created_at: 2, last_active_at: 20 },
      { id: 't-sched', root_node_id: 'n-sched', created_at: 3, last_active_at: 30 },
    ],
    nodes: [
      { id: 'n-chat', created_at: 1, kind: 'chat' },
      { id: 'n-old', created_at: 1, kind: 'chat' },
      { id: 'n-binned', created_at: 2, kind: 'chat', deleted_at: 25, deletion_group_id: 'del-1' },
      { id: 'n-sched', created_at: 3, kind: 'chat', scheduled_only_job_id: 'job-hidden' },
    ],
  });

  it('lands on the newest listed thread, past a newer thread in Trash or a Scheduled-only run', () => {
    for (const requested of [null, 't-binned', 't-sched', 't-gone']) {
      expect(hydrateBackendWorkspaces([withRest(requested)]).projects[0].activeTreeId).toBe('t-chat');
    }
  });

  it('keeps a requested archived thread, which the archive opens', () => {
    expect(hydrateBackendWorkspaces([withRest('t-old')]).projects[0].activeTreeId).toBe('t-old');
  });

  it('lands nowhere when every thread is in Trash', () => {
    const binned = withRest(null);
    binned.trees = binned.trees.filter((tree) => tree.id === 't-binned');
    expect(hydrateBackendWorkspaces([binned]).projects[0].activeTreeId).toBeNull();
  });
});
