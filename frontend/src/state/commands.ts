import { PROFILE_PAGE_ENABLED } from './featureFlags';
import { kbd } from '../lib/platform';
import { AssistantApiError, MICHI_ASSISTANT_RESET_EVENT, resetAssistant, type AssistantInfo } from '../services/api/assistant';
import { adoptCompanionAssistant, scheduleCompanionRefresh } from './companion/companionStore';
import { openCompanionPanel, setCompanionTarget } from './companion/companionPanel';
import type { ChatNodeState, Project } from './chatTypes';
import { isVisibleConversationNode } from './conversationVisibility';
import { threadDisplayTitle } from './displayTitle';

/**
 * "<name>: New conversation" from outside the panel (the palette, Scheduled's
 * "Create with agent" after a job was made, DESIGN-v2 Q5): the assistant's
 * reset of the one conversation V, the old one going to History, then the
 * panel on Chat. The same steps as the panel menu's New conversation. A 409
 * says another window already moved on: the panel shows the one current now.
 * The panel opens either way; a failed reset rejects, for the caller to show.
 */
export async function startNewCompanionConversation(nodeId: string | undefined): Promise<void> {
  try {
    const next = await resetAssistant(nodeId);
    adoptCompanionAssistant(next);
    setCompanionTarget(null);
    window.dispatchEvent(new CustomEvent<AssistantInfo>(MICHI_ASSISTANT_RESET_EVENT, { detail: next }));
    scheduleCompanionRefresh();
  } catch (cause) {
    if (!(cause instanceof AssistantApiError && cause.current)) throw cause;
    adoptCompanionAssistant(cause.current);
  } finally {
    openCompanionPanel({ tab: 'chat', focusComposer: true });
  }
}

export type CommandGroup = 'recent' | 'nav' | 'action' | 'workspace' | 'chat' | 'search-result';

/** Leading icon for a palette row. Names map to the SVG set in
 *  components/terminal/icons.tsx (see commandIcons.tsx); this module stays
 *  JSX-free. */
export type CommandIcon =
  | 'agent' | 'home' | 'branches' | 'map' | 'digest' | 'workspace' | 'trash'
  | 'archive' | 'settings' | 'profile' | 'plus' | 'shield' | 'shield-off'
  | 'thread' | 'weave' | 'export' | 'close' | 'chat' | 'threads' | 'clock' | 'skill';

export interface Command {
  id: string;
  group: CommandGroup;
  icon: CommandIcon;
  label: string;
  keys?: string;
  meta?: string;
  /** A conversation the row opens, prefetched while the row is highlighted. */
  prefetchNodeId?: string;
  run: () => void;
}

/** A thread the palette offers under Recent: one of the user's latest, in any workspace. */
export interface RecentThread {
  treeId: string;
  projectId: string;
  rootNodeId: string;
  name: string;
  projectName: string;
}

/**
 * The threads most recently active (Tree.lastActiveAt) across the given
 * workspaces, newest first: live threads of live workspaces whose root the
 * sidebar would list. `exclude` leaves out the thread on screen, which
 * opening again would not change. Callers pass user workspaces only.
 */
export function selectRecentThreads(
  projects: readonly Pick<Project, 'id' | 'name' | 'trees' | 'deletedAt' | 'archivedAt'>[],
  nodes: Readonly<Record<string, (Pick<ChatNodeState, 'title' | 'deletedAt' | 'pageId' | 'maintenanceJobId' | 'scheduledOnlyJobId'> & Partial<Pick<ChatNodeState, 'messages'>>) | undefined>>,
  { exclude = null, limit = 5 }: { exclude?: { projectId: string; treeId: string } | null; limit?: number } = {},
): RecentThread[] {
  const found: Array<{ at: number; thread: RecentThread }> = [];
  for (const project of projects) {
    if (project.deletedAt || project.archivedAt) continue;
    for (const tree of project.trees) {
      if (tree.archivedAt) continue;
      if (exclude && exclude.projectId === project.id && exclude.treeId === tree.id) continue;
      const root = nodes[tree.rootNodeId];
      if (root?.deletedAt || !isVisibleConversationNode(root)) continue;
      found.push({
        at: tree.lastActiveAt ?? tree.createdAt ?? 0,
        thread: {
          treeId: tree.id,
          projectId: project.id,
          rootNodeId: tree.rootNodeId,
          name: threadDisplayTitle(tree, root, 'Untitled'),
          projectName: project.name,
        },
      });
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit).map((entry) => entry.thread);
}

export type PageId =
  | 'home'
  | 'dashboard'
  | 'branches'
  | 'map'
  | 'digest'
  | 'settings'
  | 'workspaces'
  | 'workspace-manage'
  /** Trash, Archived and Skills are Settings pages; navigating to one opens Settings there. */
  | 'trash'
  | 'archived'
  | 'skills'
  | 'profile'
  | 'agents'
  | 'agent-manage'
  | 'threads'
  | 'spaces'
  | 'space'
  | 'scheduled';

export interface CommandContext {
  activePage: PageId;
  selection: ReadonlySet<string>;
  /** Cross-project chat enumeration. Sourced from `selectAllChats` in chatStore. */
  allChats: Array<{ id: string; title: string; projectId: string; projectName: string }>;
  hasActiveProject: boolean;
  setPage: (p: PageId) => void;
  fanoutFromSelection: () => void;
  digestFromSelection: () => void;
  /** Settings › Digest. Off (or absent) drops the Digest nav and selection commands. */
  digestEnabled?: boolean;
  exportSelection: () => void;
  clearSelection: () => void;
  openChat: (id: string) => void;
  /** Switch the active workspace. Used by cross-project chat invocation in the palette
   *  and by global search row activation. Wired to `selectProject` in chatStore. */
  switchProject: (projectId: string) => void;
  /** Live workspaces (excludes the active one + deleted/archived) offered as
   *  direct jump targets in the palette. `remoteNote` names the remote backend
   *  of a remote workspace; local ones have none. */
  workspaces: Array<{ id: string; name: string; remoteNote?: string }>;
  /** Jump straight to a workspace: switch the active project and route to the
   *  dashboard so its active tree renders. */
  switchWorkspace: (projectId: string) => void;
  createThread: () => void;
  /** The latest threads across workspaces, newest first (selectRecentThreads). */
  recentThreads?: readonly RecentThread[];
  /** Open a thread in its workspace, switching workspace when needed. */
  openThread?: (projectId: string, treeId: string) => void;
  activateTree: (treeId: string) => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  activeTreeId: string | null;
  liveTrees: Array<{ id: string; name: string }>;
  archivedTrees: Array<{ id: string; name: string }>;
  customAgentsEnabled: boolean;
  /** Opens All tasks in Pages; absent where nothing answers it. */
  openAllTasks?: () => void;
  /** The agent (DESIGN-v2 §1.2); absent when this backend has none. */
  companion?: CompanionCommands;
}

/** What the palette can do with the agent, under its name (`settings.displayName`). */
export interface CompanionCommands {
  name: string;
  /** ⌘J: the panel on Chat. */
  ask: () => void;
  /** ⇧⌘J: the panel on Today. */
  today: () => void;
  newConversation: () => void;
  settings: () => void;
  /** Check-ins: only once the Companion's state has loaded (they act on it). */
  checkIns?: { checkNow: () => void; paused: boolean; togglePause: () => void };
}

/** The agent's palette rows: "Ask <name>", "<name>: Today", and the rest under its name. */
function companionCommands(companion: CompanionCommands): Command[] {
  const { name, checkIns } = companion;
  return [
    { id: 'companion.ask', group: 'action', icon: 'chat', label: `Ask ${name}`, keys: kbd('mod', 'J'), run: companion.ask },
    { id: 'companion.today', group: 'action', icon: 'chat', label: `${name}: Today`, keys: kbd('shift', 'mod', 'J'), run: companion.today },
    ...(checkIns ? [
      { id: 'companion.check', group: 'action', icon: 'clock', label: `${name}: Check now`, run: checkIns.checkNow },
      { id: 'companion.pause', group: 'action', icon: 'close', label: `${name}: ${checkIns.paused ? 'Resume check-ins' : 'Pause check-ins'}`, run: checkIns.togglePause },
    ] satisfies Command[] : []),
    { id: 'companion.new', group: 'action', icon: 'plus', label: `${name}: New conversation`, run: companion.newConversation },
    { id: 'companion.settings', group: 'action', icon: 'settings', label: `${name}: Settings`, run: companion.settings },
  ];
}

export function buildCommands(ctx: CommandContext): Command[] {
  const out: Command[] = [];
  const openThread = ctx.openThread;
  if (openThread) {
    for (const t of ctx.recentThreads ?? []) {
      out.push({
        id: `recent.${t.projectId}.${t.treeId}`,
        group: 'recent',
        icon: 'thread',
        label: t.name,
        meta: t.projectName,
        prefetchNodeId: t.rootNodeId,
        run: () => openThread(t.projectId, t.treeId),
      });
    }
  }
  // Kept in ACTION rather than NAV so the long-standing fixed nav-command
  // ordering/shortcut contract remains unchanged; it still routes to a page.
  if (ctx.customAgentsEnabled) {
    out.push({ id: 'agents.open', group: 'action', icon: 'agent', label: 'Open Agent Library', run: () => ctx.setPage('agents') });
  }
  if (ctx.companion) out.push(...companionCommands(ctx.companion));
  if (ctx.hasActiveProject) {
    out.push({ id: 'nav.home', group: 'nav', icon: 'home', label: 'Go to home', keys: kbd('mod', '0'), run: () => ctx.setPage('home') });
    out.push(
      // 'branches' is the retired Overview page; the shell opens Map › Doc for it.
      { id: 'nav.branches',   group: 'nav', icon: 'branches', label: 'Open branch overview (Map › Doc)',  run: () => ctx.setPage('branches') },
      { id: 'nav.map',        group: 'nav', icon: 'map', label: 'Open map',              keys: kbd('mod', 'M'), run: () => ctx.setPage('map') },
      ...(ctx.digestEnabled ? [{ id: 'nav.digest', group: 'nav', icon: 'digest', label: 'Open thread digest', keys: kbd('mod', 'D'), run: () => ctx.setPage('digest') } satisfies Command] : []),
      { id: 'nav.workspaces', group: 'nav', icon: 'workspace', label: 'Switch workspace…',     keys: kbd('mod', 'O'), run: () => ctx.setPage('workspaces') },
      { id: 'nav.spaces', group: 'nav', icon: 'digest', label: 'Open Pages', run: () => ctx.setPage('spaces') },
      ...(ctx.openAllTasks ? [{ id: 'nav.all-tasks', group: 'nav', icon: 'threads', label: 'Go to all tasks', run: ctx.openAllTasks } satisfies Command] : []),
      { id: 'nav.scheduled',  group: 'nav', icon: 'clock', label: 'Open scheduled jobs',   run: () => ctx.setPage('scheduled') },
      { id: 'nav.trash',      group: 'nav', icon: 'trash', label: 'Open trash',            run: () => ctx.setPage('trash') },
      { id: 'nav.archived',   group: 'nav', icon: 'archive', label: 'Open archived',          run: () => ctx.setPage('archived') },
      { id: 'nav.settings',   group: 'nav', icon: 'settings', label: 'Open settings',         keys: kbd('mod', ','), run: () => ctx.setPage('settings') },
    );
    if (PROFILE_PAGE_ENABLED) {
      out.push(
        { id: 'nav.profile', group: 'nav', icon: 'profile', label: 'Open profile', keys: kbd('mod', 'P'), run: () => ctx.setPage('profile') },
      );
    }
    out.push({ id: 'thread.new', group: 'action', icon: 'plus', label: 'New thread', keys: kbd('mod', 'T'), run: ctx.createThread });
    out.push({
      id: 'action.permissions',
      group: 'action',
      icon: 'shield',
      label: 'Permission settings',
      run: () => ctx.setPage('settings'),
    });
    for (const t of ctx.liveTrees) {
      out.push({ id: `thread.switch.${t.id}`, group: 'nav', icon: 'thread', label: `Switch to thread ▸ ${t.name}`, run: () => ctx.activateTree(t.id) });
    }
    for (const t of ctx.archivedTrees) {
      out.push({ id: `thread.switch.archived.${t.id}`, group: 'nav', icon: 'archive', label: `Switch to archived thread ▸ ${t.name}`, run: () => ctx.activateTree(t.id) });
    }
    if (ctx.activeTreeId) {
      out.push({ id: 'thread.archive', group: 'action', icon: 'archive', label: 'Archive current thread', run: () => ctx.archiveTree(ctx.activeTreeId!) });
    }
  }
  // Last of the Actions: rows show in push order within their section.
  out.push({ id: 'skills.open', group: 'action', icon: 'skill', label: 'Open Skills', run: () => ctx.setPage('skills') });
  if (ctx.selection.size >= 2) {
    out.push(
      { id: 'action.weave',  group: 'action', icon: 'weave', label: `Weave ${ctx.selection.size} chats`,        run: ctx.fanoutFromSelection },
      ...(ctx.digestEnabled ? [{ id: 'action.digest', group: 'action', icon: 'digest', label: `Digest from ${ctx.selection.size} chats`, keys: kbd('shift', 'mod', 'D'), run: ctx.digestFromSelection } satisfies Command] : []),
      { id: 'action.export', group: 'action', icon: 'export', label: `Export ${ctx.selection.size} selected`,                 run: ctx.exportSelection },
      { id: 'action.clear',  group: 'action', icon: 'close', label: 'Clear selection',                          keys: 'esc',  run: ctx.clearSelection },
    );
  }
  for (const w of ctx.workspaces) {
    out.push({
      id: `workspace.switch.${w.id}`,
      group: 'workspace',
      icon: 'workspace',
      label: `Switch to workspace ▸ ${w.name}`,
      ...(w.remoteNote ? { meta: w.remoteNote } : {}),
      run: () => ctx.switchWorkspace(w.id),
    });
  }
  const chatsToShow = ctx.allChats.slice(0, 50);
  for (const c of chatsToShow) {
    out.push({
      id: `chat.${c.id}`,
      group: 'chat',
      icon: 'chat',
      label: `${c.title} · ${c.projectName}`,
      run: () => {
        ctx.switchProject(c.projectId);
        ctx.openChat(c.id);
      },
    });
  }
  return out;
}

export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  return cmds.filter((c) => c.label.toLowerCase().includes(q) || !!c.meta?.toLowerCase().includes(q));
}
