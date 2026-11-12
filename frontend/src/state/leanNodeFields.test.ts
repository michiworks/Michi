import { describe, expect, it } from 'vitest';
import { LEAN_NODE_FIELDS } from 'michi-shared';
import { applyTreeMessages, buildMessagesByNode, hydrateBackendWorkspaces, mergeDeferredNodeFields } from './chatHydration';
import { reduceNodes } from './chatReducers';
import { installBackendWorkspaceNode } from './backgroundGapReconcile';
import { quietStructureRead } from '../test/structureGuardsStub';
import { installMatchingPage, mergeFreshOverCached, pageShowable } from './remoteCacheMerge';
import {
  buildExplicitWorkspaceCommands,
  emptyWorkspaceDirtyDelta,
  serializeNodeRow,
} from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

const OVERVIEW = JSON.stringify([{ at: 1, text: 'Looked at the flaky test.' }, { at: 2, text: 'Fixed the race.' }]);
const FOLLOW_UPS = JSON.stringify(['Why did it race?', 'Add a test?']);
const DRAFT = JSON.stringify({ value: 'half typed', mentions: [] });
const HEAVY = { branch_overview: OVERVIEW, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: 'a-1', composer_draft: DRAFT };

function row(id: string, fields: Record<string, unknown> = {}) {
  return { id, workspace_id: 'ws', tree_id: 'tree', parent_node_id: id === 'root' ? null : 'root', kind: 'chat',
    title: id, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: id === 'root' ? 1 : 2, message_count: 2,
    // A stored row carries every column, null or not.
    branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null, ...fields };
}

/** A workspace payload as fetchAllWorkspacesMeta returns it; `lean` mimics a lean-capable backend. */
function workspace(nodes: Array<Record<string, unknown>>, lean: boolean) {
  return {
    workspace: { id: 'ws', name: 'Workspace', created_at: 1, active_tree_id: 'tree' },
    trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'root', last_active_at: 1, created_at: 1 }],
    nodes,
    edges: [{ id: 'branch-root-child', workspace_id: 'ws', source_node_id: 'root', target_node_id: 'child', kind: 'branch' }],
    messages: [],
    contexts: [],
    ...(lean ? { leanNodeFields: [...LEAN_NODE_FIELDS] } : {}),
  };
}

/** A lean-capable backend leaves out the lean fields that hold a value. */
function leanRow(id: string, fields: Record<string, unknown>) {
  const full = row(id, fields) as Record<string, unknown>;
  for (const key of Object.keys(HEAVY)) if (full[key] != null) delete full[key];
  return full;
}

function hydrate(lean: boolean) {
  const rows = lean
    ? [leanRow('root', HEAVY), leanRow('child', { branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null })]
    : [row('root', HEAVY), row('child', { branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null })];
  const hydrated = hydrateBackendWorkspaces([workspace(rows, lean)]);
  return { project: hydrated.projects[0], nodes: hydrated.nodes };
}

/** The tree page a current backend sends: each node's lean fields as stored. */
function page() {
  return {
    messages: [
      { id: 'm-0', node_id: 'root', role: 'user', content: 'hi', seq: 0 },
      { id: 'a-1', node_id: 'root', role: 'assistant', content: 'hello', seq: 1 },
    ],
    pages: [
      { nodeId: 'root', total: 2, before: null, node: HEAVY },
      // A node without bodies still gets its fields.
      { nodeId: 'child', total: 0, before: null, node: { branch_overview: null, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: null, composer_draft: null } },
    ],
  };
}

function nodeDelta(...ids: string[]) {
  const delta = emptyWorkspaceDirtyDelta();
  for (const id of ids) delta.nodeIds.add(id);
  return delta;
}

const commandKeys = (project: Project, nodes: Record<string, ChatNodeState>, ids: string[]) =>
  buildExplicitWorkspaceCommands(project, nodes, nodeDelta(...ids), new Map(), 'window-a').commands
    .map((command) => [command.type, Object.keys(command.payload).filter((key) => key.includes('overview') || key.includes('follow') || key.includes('draft'))]);

describe('lean node fields', () => {
  it('marks exactly the fields a lean row left out; null values are the row\'s own', () => {
    const { nodes } = hydrate(true);
    expect(nodes.root.deferredNodeFields).toEqual(['branch_overview', 'follow_ups', 'composer_draft']);
    expect(nodes.root.branchOverviewEntries).toBeUndefined();
    expect(nodes.root.followUps).toEqual([]);
    expect(nodes.root.composerDraft).toBeUndefined();
    expect(nodes.child.deferredNodeFields).toBeUndefined();
  });

  it('an older backend (no marker) defers nothing, even for rows without the keys', () => {
    const { nodes } = hydrate(false);
    expect(nodes.root.deferredNodeFields).toBeUndefined();
    expect(nodes.root.branchOverview).toBe('Fixed the race.');
    expect(nodes.root.composerDraft?.value).toBe('half typed');
    const bare = hydrateBackendWorkspaces([workspace([{ id: 'root', kind: 'chat', message_count: 0 }], false)]).nodes.root;
    expect(bare.deferredNodeFields).toBeUndefined();
  });

  it('never writes a deferred field: rows and commands leave those keys out', () => {
    const { project, nodes } = hydrate(true);
    const root = serializeNodeRow(project, nodes, 'root')!;
    for (const key of ['branch_overview', 'follow_ups', 'follow_ups_source_message_id', 'composer_draft']) expect(key in root).toBe(false);
    expect(commandKeys(project, nodes, ['root'])).toEqual([['node.upsert', []], ['node.patch', []]]);
    // The draft-only path has nothing to write either.
    const drafts = emptyWorkspaceDirtyDelta();
    drafts.draftNodeIds.add('root');
    expect(buildExplicitWorkspaceCommands(project, nodes, drafts, new Map(), 'window-a').commands).toEqual([]);
    // A node whose values arrived whole writes them as before.
    expect(commandKeys(project, nodes, ['child'])).toEqual([
      ['node.upsert', ['branch_overview', 'follow_ups', 'follow_ups_source_message_id', 'composer_draft', 'composer_draft_window_id']],
      ['node.patch', ['composer_draft', 'composer_draft_window_id']],
    ]);
  });

  it('a tree page fills the deferred fields, empty nodes included, and nothing becomes dirty', () => {
    const { project, nodes } = hydrate(true);
    // The baseline the dirty tracker seeds at hydration.
    const known = buildExplicitWorkspaceCommands(project, nodes, nodeDelta('root', 'child'), new Map(), 'window-a').nodeProjectionUpdates;
    const tree = page();
    const loaded = applyTreeMessages(nodes, buildMessagesByNode(tree.messages), tree.pages);
    expect(loaded.root.deferredNodeFields).toBeUndefined();
    expect('deferredNodeFields' in loaded.root).toBe(false);
    expect(loaded.root.branchOverviewEntries?.map((entry) => entry.text)).toEqual(['Looked at the flaky test.', 'Fixed the race.']);
    expect(loaded.root.followUps).toEqual(['Why did it race?', 'Add a test?']);
    expect(loaded.root.followUpsSourceMessageId).toBe('a-1');
    expect(loaded.root.composerDraft?.value).toBe('half typed');
    expect(loaded.root.messages).toHaveLength(2);
    // Not deferred: a page never overwrites what the window already holds.
    expect(loaded.child).toBe(nodes.child);
    expect(buildExplicitWorkspaceCommands(project, loaded, nodeDelta('root', 'child'), known, 'window-a').commands).toEqual([]);
    // A later local change writes the draft the page brought, as for any loaded node.
    const moved = { ...loaded, root: { ...loaded.root, paneWidth: 480 } };
    const patch = buildExplicitWorkspaceCommands(project, moved, nodeDelta('root'), known, 'window-a').commands
      .find((command) => command.type === 'node.patch')!;
    expect(patch.payload.pane_width).toBe(480);
    expect(patch.payload.composer_draft).toBe(JSON.stringify({ value: 'half typed', mentions: [] }));
  });

  it('fills a zero-message node from its page entry', () => {
    const lean = hydrateBackendWorkspaces([workspace([leanRow('root', {}), leanRow('child', { follow_ups: FOLLOW_UPS })], true)]).nodes;
    expect(lean.child.deferredNodeFields).toEqual(['follow_ups']);
    const loaded = applyTreeMessages(lean, {}, page().pages);
    expect(loaded.child.followUps).toEqual(['Why did it race?', 'Add a test?']);
    expect(loaded.child.deferredNodeFields).toBeUndefined();
    expect(loaded.child.messages).toBe(lean.child.messages);
    expect(loaded.root).toBe(lean.root);
  });

  it('fills only the fields a row carries and keeps the others deferred', () => {
    const { nodes } = hydrate(true);
    const merged = mergeDeferredNodeFields(nodes.root, { follow_ups: FOLLOW_UPS, follow_ups_source_message_id: 'a-1' });
    expect(merged.followUps).toHaveLength(2);
    expect(merged.deferredNodeFields).toEqual(['branch_overview', 'composer_draft']);
    expect(mergeDeferredNodeFields(merged, null)).toBe(merged);
    expect(mergeDeferredNodeFields(merged, { unrelated: 1 })).toBe(merged);
  });

  describe('live updates', () => {
    it('new follow-ups take over that field only', () => {
      const { nodes } = hydrate(true);
      const next = reduceNodes(nodes, { type: 'set-follow-ups', nodeId: 'root', followUps: ['Ship it?'] });
      expect(next.root.followUps).toEqual(['Ship it?']);
      expect(next.root.deferredNodeFields).toEqual(['branch_overview', 'composer_draft']);
      // The page fills the rest and leaves the live follow-ups alone.
      const tree = page();
      const loaded = applyTreeMessages(next, buildMessagesByNode(tree.messages), tree.pages);
      expect(loaded.root.followUps).toEqual(['Ship it?']);
      expect(loaded.root.composerDraft?.value).toBe('half typed');
    });

    it('typing takes over the draft, and the draft is then written', () => {
      const { project, nodes } = hydrate(true);
      const next = reduceNodes(nodes, { type: 'set-composer-draft', nodeId: 'root', draft: { value: 'new text', mentions: [] } });
      expect(next.root.deferredNodeFields).toEqual(['branch_overview', 'follow_ups']);
      const drafts = emptyWorkspaceDirtyDelta();
      drafts.draftNodeIds.add('root');
      expect(buildExplicitWorkspaceCommands(project, next, drafts, new Map(), 'window-a').commands).toEqual([{
        type: 'node.patch',
        payload: { id: 'root', composer_draft: JSON.stringify({ value: 'new text', mentions: [] }), composer_draft_window_id: 'window-a' },
      }]);
      const tree = page();
      expect(applyTreeMessages(next, buildMessagesByNode(tree.messages), tree.pages).root.composerDraft?.value).toBe('new text');
    });

    it('an overview entry that streams in keeps the field deferred and joins the stored entries', () => {
      const { project, nodes } = hydrate(true);
      const next = reduceNodes(nodes, { type: 'set-branch-overview', nodeId: 'root', overview: 'Merged the fix.' });
      expect(next.root.branchOverview).toBe('Merged the fix.');
      expect(next.root.deferredNodeFields).toEqual(['branch_overview', 'follow_ups', 'composer_draft']);
      expect('branch_overview' in serializeNodeRow(project, next, 'root')!).toBe(false);
      const tree = page();
      const loaded = applyTreeMessages(next, buildMessagesByNode(tree.messages), tree.pages);
      expect(loaded.root.branchOverviewEntries?.map((entry) => entry.text))
        .toEqual(['Looked at the flaky test.', 'Fixed the race.', 'Merged the fix.']);
      expect(loaded.root.branchOverview).toBe('Merged the fix.');
    });

    it('a send settles follow-ups and the composer\'s draft', () => {
      const { nodes } = hydrate(true);
      const next = reduceNodes(nodes, { type: 'user-send', nodeId: 'root', userText: 'go', assistantId: 'a-2' } as Parameters<typeof reduceNodes>[1]);
      expect(next.root.deferredNodeFields).toEqual(['branch_overview']);
      const kept = reduceNodes(nodes, { type: 'user-send', nodeId: 'root', userText: 'go', assistantId: 'a-2', keepDraft: true } as Parameters<typeof reduceNodes>[1]);
      expect(kept.root.deferredNodeFields).toEqual(['branch_overview', 'composer_draft']);
    });
  });

  it('a gap reconcile keeps the draft and its deferral from the same source', () => {
    const { project, nodes } = hydrate(true);
    const rawWorkspace = workspace([row('root', HEAVY), row('child')], false);
    const install = (currentNodes: Record<string, ChatNodeState>) =>
      installBackendWorkspaceNode({ ...quietStructureRead, currentProjects: [project], currentNodes, rawWorkspace, nodeId: 'root' })!.nodes.root;
    // A deferred draft is not unsent work: the full read's draft is taken.
    const fromServer = install(nodes);
    expect(fromServer.composerDraft?.value).toBe('half typed');
    expect(fromServer.branchOverview).toBe('Fixed the race.');
    expect(fromServer.deferredNodeFields).toBeUndefined();
    // A draft typed here stays, and stays this window's.
    const typed = reduceNodes(nodes, { type: 'set-composer-draft', nodeId: 'root', draft: { value: 'mine', mentions: [] } });
    const local = install(typed);
    expect(local.composerDraft?.value).toBe('mine');
    expect(local.deferredNodeFields).toBeUndefined();
  });

  describe('over a cached copy, when the remote answers (remoteCacheMerge)', () => {
    /** A lean copy whose cached page filled the thread's fields, as installCachedBoot shows it. */
    function cachedBoot() {
      const cached = hydrate(true);
      const cachedPage = page();
      const nodes = installMatchingPage(cached.nodes, cachedPage, ['root'], (id, node) => pageShowable(cachedPage, id, node)).nodes;
      expect(nodes.root.deferredNodeFields).toBeUndefined();
      const origin = { projects: new Map([[cached.project.id, cached.project]]), nodes: new Map(Object.entries(nodes)) };
      return { project: cached.project, nodes, origin };
    }
    const answer = (held: { projects: Project[]; nodes: Record<string, ChatNodeState> }, origin: ReturnType<typeof cachedBoot>['origin']) => {
      const fresh = hydrate(true);
      return mergeFreshOverCached(origin, held, { projects: [fresh.project], nodes: fresh.nodes });
    };

    it('keeps the copy\'s draft and follow-ups up, never written, until the thread\'s page brings the remote\'s', () => {
      const { project, nodes, origin } = cachedBoot();
      const merged = answer({ projects: [project], nodes }, origin);
      const root = merged.nodes.root;
      expect(root.deferredNodeFields).toEqual(['branch_overview', 'follow_ups', 'composer_draft']);
      expect(root.composerDraft?.value).toBe('half typed');
      expect(root.followUps).toEqual(['Why did it race?', 'Add a test?']);
      expect(merged.editedNodeIds.size).toBe(0);
      expect(Object.keys(serializeNodeRow(merged.projects[0], merged.nodes, 'root')!).filter((key) => key in HEAVY)).toEqual([]);
      // Read again for them, the cached messages up meanwhile.
      expect(merged.rereadNodeIds).toEqual(new Set(['root']));
      expect(root.messagesLoaded).toBe(false);
      expect(root.messages.map((message) => message.id)).toEqual(['m-0', 'a-1']);
      // The page read beside the metadata brings the remote's values.
      const remotePage = page();
      remotePage.pages[0].node = { ...HEAVY, composer_draft: JSON.stringify({ value: 'typed elsewhere', mentions: [] }) };
      const loaded = installMatchingPage(merged.nodes, remotePage, ['root']).nodes.root;
      expect(loaded.deferredNodeFields).toBeUndefined();
      expect(loaded.messagesLoaded).toBe(true);
      expect(loaded.composerDraft?.value).toBe('typed elsewhere');
      expect(loaded.branchOverviewEntries?.map((entry) => entry.text)).toEqual(['Looked at the flaky test.', 'Fixed the race.']);
    });

    it('writes a draft typed over the copy; the page fills the rest around it', () => {
      const { project, nodes, origin } = cachedBoot();
      const typed = reduceNodes(nodes, { type: 'set-composer-draft', nodeId: 'root', draft: { value: 'typed meanwhile', mentions: [] } });
      const merged = answer({ projects: [project], nodes: typed }, origin);
      const root = merged.nodes.root;
      expect(root.composerDraft?.value).toBe('typed meanwhile');
      expect(root.deferredNodeFields).toEqual(['branch_overview', 'follow_ups']);
      expect(merged.editedNodeIds).toEqual(new Set(['root']));
      const delta = emptyWorkspaceDirtyDelta();
      delta.draftNodeIds.add('root');
      const draftWrites = buildExplicitWorkspaceCommands(merged.projects[0], merged.nodes, delta, new Map(), 'window-a').commands
        .filter((command) => command.type === 'node.patch' && 'composer_draft' in command.payload);
      expect(draftWrites.map((command) => JSON.parse(String(command.payload.composer_draft)).value)).toEqual(['typed meanwhile']);
      const loaded = installMatchingPage(merged.nodes, page(), ['root']).nodes.root;
      expect(loaded.composerDraft?.value).toBe('typed meanwhile');
      expect(loaded.followUps).toEqual(['Why did it race?', 'Add a test?']);
      expect(loaded.deferredNodeFields).toBeUndefined();
    });
  });
});
