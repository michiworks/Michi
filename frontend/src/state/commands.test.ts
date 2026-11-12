import { vi } from 'vitest';
import { buildCommands, CommandContext, filterCommands, selectRecentThreads } from './commands';
import type { Project, Tree } from './chatTypes';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    activePage: 'dashboard',
    selection: new Set<string>(),
    allChats: [],
    hasActiveProject: false,
    setPage: vi.fn(),
    fanoutFromSelection: vi.fn(),
    digestFromSelection: vi.fn(),
    exportSelection: vi.fn(),
    clearSelection: vi.fn(),
    openChat: vi.fn(),
    switchProject: vi.fn(),
    workspaces: [],
    switchWorkspace: vi.fn(),
    createThread: vi.fn(),
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    activeTreeId: null,
    liveTrees: [],
    archivedTrees: [],
    customAgentsEnabled: true,
    ...overrides,
  };
}

const baseCtx: CommandContext = makeCtx({ hasActiveProject: true });

describe('buildCommands', () => {
  it('offers Go to all tasks right after Pages, when the shell can open it', () => {
    const openAllTasks = vi.fn();
    const cmds = buildCommands(makeCtx({ hasActiveProject: true, openAllTasks }));
    const navIds = cmds.filter((c) => c.group === 'nav').map((c) => c.id);
    expect(navIds[navIds.indexOf('nav.spaces') + 1]).toBe('nav.all-tasks');
    const allTasks = cmds.find((c) => c.id === 'nav.all-tasks')!;
    expect(allTasks.label).toBe('Go to all tasks');
    allTasks.run();
    expect(openAllTasks).toHaveBeenCalledOnce();
    expect(buildCommands(makeCtx({ hasActiveProject: true })).some((c) => c.id === 'nav.all-tasks')).toBe(false);
  });

  it('offers Open Skills, which opens Settings › Skills, with or without a workspace, after the other actions', () => {
    const setPage = vi.fn();
    const alone = buildCommands(makeCtx({ customAgentsEnabled: false, setPage }));
    expect(alone.map((c) => c.id)).toEqual(['skills.open']);
    alone[0].run();
    expect(setPage).toHaveBeenCalledWith('skills');
    const companion = { name: 'Robin', ask: vi.fn(), today: vi.fn(), newConversation: vi.fn(), settings: vi.fn() };
    const actions = buildCommands(makeCtx({ hasActiveProject: true, companion })).filter((c) => c.group === 'action').map((c) => c.id);
    expect(actions.slice(0, 5)).toEqual(['agents.open', 'companion.ask', 'companion.today', 'companion.new', 'companion.settings']);
    expect(actions.indexOf('skills.open')).toBeGreaterThan(actions.indexOf('action.permissions'));
  });

  it('does not offer the removed All threads page', () => {
    const cmds = buildCommands(makeCtx({ hasActiveProject: true }));
    expect(cmds.some(c => c.id === 'nav.threads')).toBe(false);
    expect(cmds.find(c => c.group === 'nav')?.id).toBe('nav.home');
  });

  it('adds weave/digest/export/clear when selection has ≥2 items', () => {
    const cmds = buildCommands(makeCtx({ hasActiveProject: true, digestEnabled: true, selection: new Set(['n1', 'n2']) }));
    const actionIds = cmds.filter((c) => c.group === 'action').map((c) => c.id);
    expect(actionIds).toEqual(expect.arrayContaining([
      'action.weave', 'action.digest', 'action.export', 'action.clear',
    ]));
    expect(actionIds).not.toContain('action.summary');
    expect(actionIds).not.toContain('action.synthesize');
  });

  it('offers no Digest command while Settings › Digest is off', () => {
    const ids = buildCommands(makeCtx({ hasActiveProject: true, selection: new Set(['n1', 'n2']) })).map((c) => c.id);
    expect(ids).not.toContain('nav.digest');
    expect(ids).not.toContain('action.digest');
    expect(ids).toEqual(expect.arrayContaining(['nav.map', 'action.weave', 'action.export']));
    expect(buildCommands(makeCtx({ hasActiveProject: true, digestEnabled: true })).map((c) => c.id)).toContain('nav.digest');
  });
});

describe('the agent’s commands (DESIGN-v2 §1.2)', () => {
  const companion = () => ({
    name: 'Robin', ask: vi.fn(), today: vi.fn(), newConversation: vi.fn(), settings: vi.fn(),
    checkIns: { checkNow: vi.fn(), paused: false, togglePause: vi.fn() },
  });

  it('lists them under its name, in order, with ⌘J and ⇧⌘J', () => {
    const c = companion();
    const rows = buildCommands(makeCtx({ companion: c })).filter((cmd) => cmd.id.startsWith('companion.'));
    expect(rows.map((cmd) => [cmd.label, cmd.keys])).toEqual([
      ['Ask Robin', expect.stringMatching(/J$/)],
      ['Robin: Today', expect.stringMatching(/J$/)],
      ['Robin: Check now', undefined],
      ['Robin: Pause check-ins', undefined],
      ['Robin: New conversation', undefined],
      ['Robin: Settings', undefined],
    ]);
    expect(rows[1].keys).not.toBe(rows[0].keys);
    for (const [id, fn] of [['companion.ask', c.ask], ['companion.today', c.today], ['companion.check', c.checkIns.checkNow],
      ['companion.pause', c.checkIns.togglePause], ['companion.new', c.newConversation], ['companion.settings', c.settings]] as const) {
      rows.find((cmd) => cmd.id === id)!.run();
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it('says Resume check-ins while paused and leaves check-ins out until they can act', () => {
    const paused = { ...companion(), checkIns: { checkNow: vi.fn(), paused: true, togglePause: vi.fn() } };
    expect(buildCommands(makeCtx({ companion: paused })).find((cmd) => cmd.id === 'companion.pause')?.label).toBe('Robin: Resume check-ins');
    const { checkIns: _none, ...chatOnly } = companion();
    const ids = buildCommands(makeCtx({ companion: chatOnly })).map((cmd) => cmd.id);
    expect(ids).toEqual(expect.arrayContaining(['companion.ask', 'companion.today', 'companion.new', 'companion.settings']));
    expect(ids).not.toContain('companion.check');
    expect(ids).not.toContain('companion.pause');
  });

  it('has none without the agent, and never the old "Ask the assistant" row', () => {
    const cmds = buildCommands(makeCtx({ hasActiveProject: true }));
    expect(cmds.some((cmd) => cmd.id.startsWith('companion.') || cmd.id === 'assistant.open')).toBe(false);
    expect(buildCommands(makeCtx({ companion: companion() })).some((cmd) => cmd.label === 'Ask the assistant')).toBe(false);
  });
});

describe('thread commands', () => {
  const base = makeCtx({
    hasActiveProject: true,
    activeTreeId: 't1',
    liveTrees: [{ id: 't1', name: 'Research' }, { id: 't2', name: 'Planning' }],
    archivedTrees: [{ id: 't3', name: 'Old' }],
  });

  it('includes archived switches that do not unarchive', () => {
    const cmds = buildCommands(base);
    const archived = cmds.find((c) => c.label === 'Switch to archived thread ▸ Old')!;
    archived.run();
    expect(base.activateTree).toHaveBeenCalledWith('t3');
    expect(base.unarchiveTree).not.toHaveBeenCalled();
  });
});

describe('workspace commands', () => {
  it('notes the remote backend of remote workspaces and finds them by it', () => {
    const cmds = buildCommands(makeCtx({
      workspaces: [{ id: 'w1', name: 'Stocks' }, { id: 'w2', name: 'Bonds', remoteNote: 'Remote · Dev desktop' }],
    }));
    const rows = cmds.filter((c) => c.group === 'workspace');
    expect(rows.map((c) => [c.label, c.meta])).toEqual([
      ['Switch to workspace ▸ Stocks', undefined],
      ['Switch to workspace ▸ Bonds', 'Remote · Dev desktop'],
    ]);
    expect(filterCommands(rows, 'dev desktop').map((c) => c.id)).toEqual(['workspace.switch.w2']);
  });
});

describe('recent threads', () => {
  const tree = (id: string, lastActiveAt: number, extra: Partial<Tree> = {}): Tree =>
    ({ id, rootNodeId: `n-${id}`, createdAt: 1, lastActiveAt, ...extra });
  const project = (id: string, trees: Tree[], extra: Partial<Project> = {}) =>
    ({ id, name: `Workspace ${id}`, trees, ...extra }) as Pick<Project, 'id' | 'name' | 'trees' | 'deletedAt' | 'archivedAt'>;

  it('picks the latest live threads across workspaces, newest first, named as the sidebar names them', () => {
    const recent = selectRecentThreads([
      project('a', [tree('t1', 10, { name: 'Named' }), tree('t2', 40), tree('t3', 90, { archivedAt: 1 })]),
      project('b', [tree('t4', 30), tree('t5', 50)]),
      project('c', [tree('t6', 99)], { deletedAt: 1 }),
    ], { 'n-t2': { title: 'Root title' }, 'n-t5': { title: 'Gone', deletedAt: 2 }, 'n-t4': { pageId: 'page-1' } });
    expect(recent.map((t) => [t.treeId, t.name, t.projectName])).toEqual([
      ['t2', 'Root title', 'Workspace a'],
      ['t1', 'Named', 'Workspace a'],
    ]);
  });

  it('stops at the limit and leaves out the thread on screen', () => {
    const trees = [tree('t1', 1), tree('t2', 2), tree('t3', 3), tree('t4', 4), tree('t5', 5), tree('t6', 6), tree('t7', 7)];
    const ids = (exclude?: { projectId: string; treeId: string }) =>
      selectRecentThreads([project('a', trees)], {}, { exclude }).map((t) => t.treeId);
    expect(ids()).toEqual(['t7', 't6', 't5', 't4', 't3']);
    expect(ids({ projectId: 'a', treeId: 't7' })).toEqual(['t6', 't5', 't4', 't3', 't2']);
    expect(ids({ projectId: 'other', treeId: 't7' })[0]).toBe('t7');
  });

  it('builds Recent rows that open their thread and name its workspace', () => {
    const openThread = vi.fn();
    const cmds = buildCommands(makeCtx({
      openThread,
      recentThreads: [{ treeId: 't1', projectId: 'w1', rootNodeId: 'n1', name: 'Fireworks', projectName: 'Tokyo trip' }],
    }));
    const row = cmds.find((c) => c.group === 'recent')!;
    expect([row.label, row.meta, row.prefetchNodeId]).toEqual(['Fireworks', 'Tokyo trip', 'n1']);
    row.run();
    expect(openThread).toHaveBeenCalledWith('w1', 't1');
    expect(buildCommands(makeCtx({ recentThreads: [] })).some((c) => c.group === 'recent')).toBe(false);
  });
});
