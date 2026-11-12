import { describe, expect, it } from 'vitest';
import { mapNodeRowScalars } from './chatHydration';
import { isListedThread, isVisibleConversationNode, pickLandingTreeId } from './conversationVisibility';
import landingCases from '../../../backend/test/fixtures/landingTree/cases.json';
import { serializeNodeRow } from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

describe('page helper visibility metadata', () => {
  it('hydrates server page binding and keeps it out of ordinary surfaces until promotion', () => {
    const helper = mapNodeRowScalars({ id: 'helper-node', page_id: 'native-page' });
    expect(helper.pageId).toBe('native-page');
    expect(isVisibleConversationNode(helper)).toBe(false);
    expect(isVisibleConversationNode({ pageId: null })).toBe(true);
    expect(isVisibleConversationNode({})).toBe(true);
  });

  it('does not send page binding metadata back in stale workspace sync rows', () => {
    const project: Project = { id: 'workspace', name: 'Workspace', chatIds: ['helper'], trees: [], edges: [], activeTreeId: null, createdAt: 1 };
    const helper = { nodeId: 'helper', projectId: 'workspace', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', pageId: 'page-1' } as ChatNodeState;
    const row = serializeNodeRow(project, { helper }, 'helper');
    expect(row).not.toHaveProperty('page_id');
    expect(row).not.toHaveProperty('pageId');
  });
});

describe('Meta agent maintenance transcripts', () => {
  it('hydrate their job marker and stay out of ordinary surfaces', () => {
    const run = mapNodeRowScalars({ id: 'run-node', maintenance_job_id: 'job-maint' });
    expect(run.maintenanceJobId).toBe('job-maint');
    expect(isVisibleConversationNode(run)).toBe(false);
    expect(isVisibleConversationNode(mapNodeRowScalars({ id: 'user-node' }))).toBe(true);
  });

  it('do not send the marker back in workspace sync rows', () => {
    const project: Project = { id: 'workspace', name: 'Workspace', chatIds: ['run'], trees: [], edges: [], activeTreeId: null, createdAt: 1 };
    const run = { nodeId: 'run', projectId: 'workspace', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', maintenanceJobId: 'job-maint' } as ChatNodeState;
    const row = serializeNodeRow(project, { run }, 'run');
    expect(row).not.toHaveProperty('maintenance_job_id');
    expect(row).not.toHaveProperty('maintenanceJobId');
  });
});

describe('Scheduled-only run threads', () => {
  it('stay out of ordinary surfaces until moved to the workspace, and never write the mark back', () => {
    const run = mapNodeRowScalars({ id: 'run-node', scheduled_only_job_id: 'job-hidden' });
    expect(run.scheduledOnlyJobId).toBe('job-hidden');
    expect(isVisibleConversationNode(run)).toBe(false);
    expect(isVisibleConversationNode(mapNodeRowScalars({ id: 'run-node', scheduled_only_job_id: null }))).toBe(true);
    const project: Project = { id: 'workspace', name: 'Workspace', chatIds: ['run'], trees: [], edges: [], activeTreeId: null, createdAt: 1 };
    const node = { nodeId: 'run', projectId: 'workspace', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', scheduledOnlyJobId: 'job-hidden' } as ChatNodeState;
    expect(serializeNodeRow(project, { run: node }, 'run')).not.toHaveProperty('scheduled_only_job_id');
  });
});

describe('isListedThread', () => {
  const tree = { archivedAt: undefined };
  it('lists an unarchived thread whose root is a live, visible conversation', () => {
    expect(isListedThread(tree, {})).toBe(true);
  });
  it('leaves out archived threads, roots in Trash, hidden roots and roots not loaded', () => {
    expect(isListedThread({ archivedAt: 5 }, {})).toBe(false);
    expect(isListedThread(tree, { deletedAt: 5 })).toBe(false);
    expect(isListedThread(tree, { pageId: 'pg' })).toBe(false);
    expect(isListedThread(tree, { maintenanceJobId: 'job' })).toBe(false);
    expect(isListedThread(tree, { scheduledOnlyJobId: 'job' })).toBe(false);
    expect(isListedThread(tree, undefined)).toBe(false);
  });
});

describe('pickLandingTreeId', () => {
  type CaseRoot = { deleted?: boolean; purged?: boolean; pageId?: string; maintenanceJobId?: string; scheduledOnlyJobId?: string };
  it('lands where the backend does: the newest listed thread, ties by lowest id', () => {
    // The table backend/test/moveTreeActiveTree.test.ts runs through moveTreeToWorkspace's SQL.
    const trees = landingCases.trees.filter((t) => t.id !== landingCases.leaving).map((t) => ({
      id: t.id, rootNodeId: `root-${t.id}`, lastActiveAt: t.lastActiveAt, archivedAt: t.archived ? 5 : undefined,
    }));
    // A purged node is gone from the renderer's state.
    const nodes = Object.fromEntries(landingCases.trees.flatMap((t) => {
      const root: CaseRoot = (t as { root?: CaseRoot }).root ?? {};
      return root.purged ? [] : [[`root-${t.id}`, {
        deletedAt: root.deleted ? 5 : undefined,
        pageId: root.pageId, maintenanceJobId: root.maintenanceJobId, scheduledOnlyJobId: root.scheduledOnlyJobId,
      }]];
    }));
    expect(pickLandingTreeId(trees, nodes)).toBe(landingCases.lands);
  });

  it('lands nowhere when no thread is listed', () => {
    expect(pickLandingTreeId([{ id: 't', rootNodeId: 'r', lastActiveAt: 1 }], { r: { deletedAt: 2 } })).toBeNull();
    expect(pickLandingTreeId([], {})).toBeNull();
  });
});
