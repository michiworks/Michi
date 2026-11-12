import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useChatStore, useChatNodesSnapshot, selectAllChats } from '../../state/chatStore';
import { isVisibleConversationNode } from '../../state/conversationVisibility';
import { threadDisplayTitle } from '../../state/displayTitle';
import { buildCommands, filterCommands, selectRecentThreads, startNewCompanionConversation, Command, CommandGroup, PageId, type CompanionCommands } from '../../state/commands';
import { useNodeSearch } from '../../state/useNodeSearch';
import { type NodeGroupedResult } from '../../services/api';
import { relativeTime } from '../../lib/relativeTime';
import { requestDigest } from '../../lib/digestPrompt';
import { usePrefs } from '../../state/prefs';
import { ModalShell } from '../ui/ModalShell';
import { MenuItem } from '../ui/Popover';
import { kbd } from '../../lib/platform';
import { TreePrefetchContext, TREE_PREFETCH_INTENT_MS } from '../../state/treePrefetch';
import { CommandIconGlyph } from './commandIcons';
import { isSystemWorkspace, systemWorkspaceIds, withoutSystemWorkspaces } from '../../state/assistant/systemWorkspace';
import { adoptCompanionSnapshot, useCompanion, useCompanionAssistant } from '../../state/companion/companionStore';
import { openCompanionPanel } from '../../state/companion/companionPanel';
import { useCompanionName } from '../../state/companion/companionName';
import { CompanionApiError, checkCompanionNow, patchCompanionSettings } from '../../services/api/companion';
import { OPEN_SETTINGS_SECTION_EVENT } from './scheduled/metaAgent/metaAgentNav';
import { toast } from 'sonner';
import { requestAllTasks } from '../../state/pages/allTasksNav';
import { useBackendConnections } from '../../state/useBackendConnections';
import { backendConnectionIdForWorkspace } from '../../config/backendConnections';
import { workspaceRemoteNote } from '../WorkspaceLocation';
import { exportPanelEvent } from '../../state/appEvents';
import { isImeComposing } from '../../lib/ime';

function renderSnippetWithMark(text: string, range: [number, number]) {
  const [s, e] = range;
  return (
    <>
      {text.slice(0, s)}
      <mark style={{ background: 'var(--term-accent)', color: 'var(--on-accent)', padding: '0 2px' }}>
        {text.slice(s, e)}
      </mark>
      {text.slice(e)}
    </>
  );
}

function PaletteSearchGlyph() {
  return (
    <span
      aria-hidden
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-lg)',
        color: 'var(--term-accent)',
        flexShrink: 0,
      }}
    >
      ›_
    </span>
  );
}

const PROMPT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--term-line)',
  background: 'transparent',
  flexShrink: 0,
};

const PROMPT_INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-xl)',
  color: 'var(--term-fg)',
  padding: 0,
};

// The palette has no title bar: its keys sit in a hint row under the list.
const HINT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '8px 14px',
  borderTop: '1px solid var(--term-line)',
  flexShrink: 0,
  color: 'var(--term-muted)',
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-sm)',
};

const HINT_KEY: React.CSSProperties = {
  display: 'inline-block',
  minWidth: 16,
  marginRight: 5,
  padding: '0 4px',
  border: '1px solid var(--term-line)',
  borderRadius: 'var(--ui-radius-sm)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  lineHeight: '16px',
  textAlign: 'center',
  color: 'var(--term-mid)',
};

const PALETTE_HINTS: Array<[keys: string[], label: string]> = [
  [['↑', '↓'], 'move'],
  [['↵'], 'open'],
  [['esc'], 'close'],
];

// The palette's sections, in the order they show: render, highlight, ↑/↓,
// ⌘1–9 and Enter all follow it. An empty query shows Recent, Navigate and
// Actions; typing shows the rest and hides Recent.
const SECTIONS: ReadonlyArray<readonly [CommandGroup, string]> = [
  ['recent', 'Recent'],
  ['nav', 'Navigate'],
  ['action', 'Actions'],
  ['workspace', 'Workspaces'],
  ['chat', 'Chats'],
];

// ── Node-grouped search result styles ────────────────────────────────────

/** Render a snippet containing `<mark>…</mark>` tags from the backend. */
function renderHtmlSnippet(html: string): React.ReactNode {
  // Split on <mark>…</mark> tags to produce React elements.
  const parts: React.ReactNode[] = [];
  let remaining = html;
  let key = 0;
  while (remaining.length > 0) {
    const openIdx = remaining.indexOf('<mark>');
    if (openIdx === -1) {
      parts.push(remaining);
      break;
    }
    if (openIdx > 0) parts.push(remaining.slice(0, openIdx));
    const afterOpen = remaining.slice(openIdx + '<mark>'.length);
    const closeIdx = afterOpen.indexOf('</mark>');
    if (closeIdx === -1) {
      parts.push(remaining);
      break;
    }
    parts.push(
      <mark key={key++} style={{ background: 'var(--term-accent)', color: 'var(--on-accent)', padding: '0 2px', borderRadius: 'var(--ui-radius-sm)' }}>
        {afterOpen.slice(0, closeIdx)}
      </mark>
    );
    remaining = afterOpen.slice(closeIdx + '</mark>'.length);
  }
  return parts;
}

// Multi-line menu row: breadcrumb line stacked over its snippets.
const NODE_ROW_STYLE: React.CSSProperties = {
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 5,
  fontWeight: 400,
};

const BREADCRUMB_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 'var(--fs-md)',
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const NODE_TIME_STYLE: React.CSSProperties = {
  flexShrink: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--term-muted)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

const SNIPPET_ROW_STYLE: React.CSSProperties = {
  fontSize: 'var(--fs-sm)',
  lineHeight: '1.55',
  color: 'var(--term-mid)',
  padding: '2px 0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const SNIPPET_ROLE_STYLE: React.CSSProperties = {
  color: 'var(--term-muted)',
  fontSize: 'var(--fs-2xs)',
  marginRight: 4,
};

const OVERFLOW_HINT_STYLE: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--term-muted)',
  padding: '2px 0 0 0',
  fontStyle: 'italic',
};

export function openWorkspaceFromPalette(
  projectId: string,
  actions: {
    selectProject: (projectId: string) => void;
    setPage: (page: PageId) => void;
    onClose: () => void;
  },
) {
  actions.selectProject(projectId);
  actions.setPage('home');
  actions.onClose();
}

const OPENING_ROWS = new Set(['agents.open', 'companion.ask']);

export default function CommandPalette({
  onClose,
  setPage,
  activePage,
}: {
  onClose: () => void;
  setPage: (p: PageId) => void;
  activePage: PageId;
}) {
  const {
    activeProject,
    projects,
    agentStatus,
    selection,
    clearSelection,
    openPane,
    createDigest,
    createMergedChat,
    createThread,
    activateTree,
    archiveTree,
    unarchiveTree,
    selectProject,
    revealNode,
    setSearchHighlightTerm,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const digestEnabled = usePrefs().prefs.digestEnabled === true;
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce the query so we don't re-scan on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // The assistant's system workspace is never offered: not as a workspace,
  // a chat or a search hit. Navigation (revealNode) still resolves it.
  // The conversation's own workspace counts too: search can find its
  // messages before this window has loaded that workspace.
  const companionState = useCompanion();
  const assistant = useCompanionAssistant();
  const assistantWorkspaceId = assistant.info?.workspaceId ?? companionState.snapshot?.conversation?.workspaceId ?? null;
  const userProjects = useMemo(() => withoutSystemWorkspaces(projects), [projects]);
  const hiddenWorkspaceIds = useMemo(() => {
    const ids = systemWorkspaceIds(projects);
    return assistantWorkspaceId && !ids.has(assistantWorkspaceId) ? new Set([...ids, assistantWorkspaceId]) : ids;
  }, [projects, assistantWorkspaceId]);

  // Server-side FTS search — node-grouped, time-sorted, with breadcrumbs.
  // Each result is one unique node with up to 3 best-matching snippets.
  // Every backend whose workspaces this window shows is asked, the remote
  // ones only while connected (useNodeSearch).
  const searchBackends = useMemo(() => projects.map((p) => backendConnectionIdForWorkspace(p.id)), [projects]);
  const nodeSearch = useNodeSearch(debouncedQuery, searchBackends);
  const nodeResults = useMemo(
    () => nodeSearch.nodes.filter((r) => !hiddenWorkspaceIds.has(r.workspaceId) && isVisibleConversationNode(nodesSnapshot[r.nodeId])),
    [nodeSearch.nodes, hiddenWorkspaceIds, nodesSnapshot],
  );

  /** Navigate to a node-grouped search result (goes to the node, not a specific message). */
  const navigateToNodeResult = useCallback((r: NodeGroupedResult, messageId?: string) => {
    if (query.trim()) setSearchHighlightTerm({ term: query.trim(), nodeId: r.nodeId });
    revealNode(r.nodeId, { workspaceId: r.workspaceId, messageId });
    onClose();
  }, [revealNode, onClose, query, setSearchHighlightTerm]);

  const allChats = useMemo(() => selectAllChats({ projects: userProjects, nodes: nodesSnapshot }), [userProjects, nodesSnapshot]);

  // Live workspaces offered as direct jump targets — exclude deleted/archived
  // and the currently-active one (jumping to where you already are is a no-op).
  const connections = useBackendConnections();
  const workspaces = useMemo(
    () =>
      userProjects
        .filter((p) => !p.deletedAt && !p.archivedAt && p.id !== activeProject?.id)
        .map((p) => ({ id: p.id, name: p.name, remoteNote: workspaceRemoteNote(p.backendConnectionId, connections) })),
    [userProjects, activeProject, connections],
  );
  // The agent's rows (DESIGN-v2 §1.2). Chat needs only the conversation, not
  // the Companion's state: a backend without an assistant has none. Check-ins
  // act on that state, so they show once it has loaded.
  const name = useCompanionName();
  const snapshotLoaded = companionState.availability === 'available' && !!companionState.snapshot;
  const companionPaused = companionState.snapshot?.settings.paused ?? false;
  const conversationNodeId = assistant.info?.nodeId ?? companionState.snapshot?.conversation?.nodeId;
  const companion = useMemo<CompanionCommands | undefined>(() => (assistant.status === 'unsupported' ? undefined : {
    name,
    ask: () => { onClose(); openCompanionPanel({ tab: 'chat', focusComposer: true }); },
    today: () => { onClose(); openCompanionPanel({ tab: 'today' }); },
    newConversation: () => {
      onClose();
      startNewCompanionConversation(conversationNodeId).catch((error: unknown) => {
        toast.error(`Couldn’t start a new conversation: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
    },
    settings: () => {
      onClose();
      window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'companion' } }));
    },
    ...(snapshotLoaded ? { checkIns: {
      checkNow: () => {
        onClose();
        checkCompanionNow().then(() => { toast(`${name}: checking now`); }, (error: unknown) => {
          toast.error(error instanceof CompanionApiError && error.code === 'not_owner'
            ? 'Another Michi window is doing the checking'
            : `Couldn’t check now: ${error instanceof Error ? error.message : 'unknown error'}`);
        });
      },
      paused: companionPaused,
      togglePause: () => {
        onClose();
        patchCompanionSettings({ paused: !companionPaused }).then((snapshot) => {
          adoptCompanionSnapshot(snapshot);
          toast(snapshot.settings.paused ? `${name}: check-ins paused` : `${name}: check-ins resumed`);
        }, (error: unknown) => { toast.error(`Couldn’t ${companionPaused ? 'resume' : 'pause'} check-ins: ${error instanceof Error ? error.message : 'unknown error'}`); });
      },
    } } : {}),
  }), [assistant.status, snapshotLoaded, companionPaused, conversationNodeId, name, onClose]);

  const switchWorkspace = useCallback(
    (projectId: string) => {
      openWorkspaceFromPalette(projectId, { selectProject, setPage, onClose });
    },
    [selectProject, setPage, onClose],
  );

  // With the assistant's hidden workspace active (its conversation opened as
  // a pane) the palette offers none of that workspace's threads: archiving
  // the assistant's thread would start a new conversation behind the panel.
  const threadProject = isSystemWorkspace(activeProject) ? null : activeProject;
  const liveTrees = useMemo(
    () => (threadProject?.trees ?? []).filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: threadDisplayTitle(t, nodesSnapshot[t.rootNodeId], 'Untitled') })),
    [threadProject, nodesSnapshot],
  );
  const archivedTrees = useMemo(
    () => (threadProject?.trees ?? []).filter((t) => !!t.archivedAt).map((t) => ({ id: t.id, name: threadDisplayTitle(t, nodesSnapshot[t.rootNodeId], 'Untitled') })),
    [threadProject, nodesSnapshot],
  );

  // Recent: the latest threads across the user's workspaces, less the one on
  // screen (opening it again changes nothing).
  const shownTreeId = activePage === 'dashboard' ? threadProject?.activeTreeId ?? null : null;
  const recentThreads = useMemo(
    () => selectRecentThreads(userProjects.filter((p) => !hiddenWorkspaceIds.has(p.id)), nodesSnapshot, {
      exclude: threadProject && shownTreeId ? { projectId: threadProject.id, treeId: shownTreeId } : null,
    }),
    [userProjects, hiddenWorkspaceIds, nodesSnapshot, threadProject, shownTreeId],
  );
  // As the sidebar opens a thread: its workspace first, then the thread with
  // the panes it last had.
  const activeProjectId = activeProject?.id ?? null;
  const openThread = useCallback((projectId: string, treeId: string) => {
    if (projectId !== activeProjectId) selectProject(projectId);
    activateTree(treeId, projectId);
    setPage('dashboard');
    onClose();
  }, [activeProjectId, selectProject, activateTree, setPage, onClose]);

  const cmds = useMemo<Command[]>(
    () =>
      buildCommands({
        activePage,
        selection,
        allChats,
        switchProject: selectProject,
        workspaces,
        switchWorkspace,
        hasActiveProject: !!activeProject,
        setPage: (p) => { setPage(p); onClose(); },
        fanoutFromSelection: () => {
          if (selection.size < 2) return;
          void createMergedChat(Array.from(selection)).then((nodeId) => {
            openPane(nodeId);
            clearSelection();
            setPage('dashboard');
            onClose();
          }).catch(() => {});
        },
        digestFromSelection: () => {
          if (!activeProject) return;
          const ids = Array.from(selection);
          requestDigest(activeProject.id, ids);
          onClose();
        },
        digestEnabled,
        exportSelection: () => {
          exportPanelEvent.dispatch({});
          onClose();
        },
        clearSelection: () => { clearSelection(); onClose(); },
        openChat: (id) => {
          revealNode(id);
          onClose();
        },
        createThread: () => { setPage('home'); onClose(); },
        recentThreads,
        openThread,
        activateTree: (treeId) => { activateTree(treeId); onClose(); },
        archiveTree: (treeId) => { archiveTree(treeId); onClose(); },
        unarchiveTree: (treeId) => { unarchiveTree(treeId); onClose(); },
        activeTreeId: threadProject?.activeTreeId ?? null,
        liveTrees,
        archivedTrees,
        customAgentsEnabled: agentStatus?.customAgentsEnabled === true,
        openAllTasks: () => { requestAllTasks(); onClose(); },
        companion,
      }),
    [activePage, selection, allChats, revealNode, selectProject, activeProject, threadProject?.activeTreeId, agentStatus?.customAgentsEnabled, setPage, onClose, clearSelection, createDigest, digestEnabled, openPane, createMergedChat, createThread, recentThreads, openThread, activateTree, archiveTree, unarchiveTree, liveTrees, archivedTrees, workspaces, switchWorkspace, companion],
  );
  // In the order the rows show, section by section: the highlight, ↑/↓, the
  // ⌘1–9 numbers and Enter all index this list.
  const visible = useMemo(() => {
    const q = query.trim();
    const base = q ? filterCommands(cmds, query) : cmds;
    const shown = base.filter((c) => {
      // Suppress "Switch to thread ▸ …" rows — they overlap visually with chat rows
      // whose titles match the tree name. Tree navigation already lives in the sidebar.
      if (c.id.startsWith('thread.switch.')) return false;
      // The empty view is Recent, then Navigate and Actions. Workspace jumps
      // and chats are search-only: typing surfaces them (filtered by the
      // query) and the Chats rows then cover what Recent listed.
      if (!q && (c.group === 'workspace' || c.group === 'chat')) return false;
      if (q && c.group === 'recent') return false;
      return true;
    });
    return SECTIONS.flatMap(([group]) => shown.filter((c) => c.group === group));
  }, [cmds, query]);
  const showRecents = !query.trim();

  const totalRows = visible.length + (showRecents ? 0 : nodeResults.length);
  const prefetchTree = React.useContext(TreePrefetchContext);
  const activeCommand = visible[active];
  const prefetchNodeId = activeCommand
    ? activeCommand.prefetchNodeId ?? (activeCommand.group === 'chat' ? activeCommand.id.slice('chat.'.length) : undefined)
    : !showRecents && active >= visible.length ? nodeResults[active - visible.length]?.nodeId : undefined;
  useEffect(() => {
    if (!prefetchNodeId) return;
    const timer = setTimeout(() => prefetchTree(prefetchNodeId), TREE_PREFETCH_INTENT_MS);
    return () => clearTimeout(timer);
  }, [prefetchNodeId, prefetchTree]);

  // Reset the active highlight whenever the query changes so the user can
  // type a filter term and immediately press Enter to run the top match.
  // When the results include a workspace match, auto-focus it so Enter
  // switches workspaces without extra arrow-key navigation.
  // Keyed on the index, not on `visible`: a reply streaming in any pane gives
  // `visible` a new identity many times a second, and resetting on each one
  // put the highlight (and the list's scroll) back on the first row.
  const workspaceIdx = useMemo(() => visible.findIndex((c) => c.group === 'workspace'), [visible]);
  // The empty palette opens on the newest Recent thread; with none, on Open
  // Agent Library or Ask <name>, as it did when they came first in the
  // list. Any other row starts at the top.
  const openingIdx = useMemo(
    () => (showRecents && visible[0]?.group !== 'recent' ? Math.max(0, visible.findIndex((c) => OPENING_ROWS.has(c.id))) : 0),
    [showRecents, visible],
  );
  useEffect(() => {
    setActive(workspaceIdx >= 0 ? workspaceIdx : openingIdx);
  }, [query, workspaceIdx, openingIdx]);

  useEffect(() => {
    if (active >= totalRows) setActive(0);
  }, [totalRows, active]);

  const listRef = useRef<HTMLDivElement>(null);
  // Suppress hover-driven `setActive` for a beat after a keyboard nav so the
  // scrollIntoView doesn't immediately snap `active` back to whichever row
  // landed under the mouse pointer post-scroll.
  const kbdNavAt = useRef(0);
  const hoverSetActive = useCallback((i: number) => {
    if (Date.now() - kbdNavAt.current < 200) return;
    setActive(i);
  }, []);
  // Only the highlighted MenuItem carries data-active.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Stabilize scroll when async search results arrive (totalRows changes)
  // without the active index itself changing. Without this, the DOM reflows
  // when the MESSAGES section appears and the previously-visible active row
  // may scroll out of view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [totalRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const runRowAtIndex = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= totalRows) return;
      if (idx < visible.length) {
        const c = visible[idx];
        if (c) {
          c.run();
          onClose();
        }
        return;
      }
      const matchIdx = idx - visible.length;
      const nr = nodeResults[matchIdx];
      if (nr) navigateToNodeResult(nr);
    },
    [visible, nodeResults, totalRows, onClose, navigateToNodeResult],
  );

  const runActiveRow = useCallback(() => {
    runRowAtIndex(active);
  }, [runRowAtIndex, active]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    const isModifier = e.metaKey || e.ctrlKey;
    if (!showRecents && isModifier && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const targetIdx = parseInt(e.key, 10) - 1;
      runRowAtIndex(targetIdx);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      kbdNavAt.current = Date.now();
      setActive((i) => Math.min(totalRows - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      kbdNavAt.current = Date.now();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runActiveRow();
    }
  };

  return (
    // No title bar or close button: Esc and a click on the scrim close it.
    // The name stays for assistive tech (and the E2E specs that find it).
    <ModalShell
      open
      onClose={onClose}
      aria-label="Command palette"
      width={620}
      anchor="top"
      motion="enter"
    >
        <div style={PROMPT_ROW}>
          <PaletteSearchGlyph />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search chats, commands, messages…"
            style={PROMPT_INPUT}
          />
        </div>

        {/* Rows are the shared menu rows (MenuItem + .michi-menu-scope), so the
            palette's list reads exactly like the right-click / dropdown menus. */}
        <div
          ref={listRef}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          className="hide-sb michi-menu-scope"
          data-menu="palette"
        >
          {SECTIONS.map(([g, label]) => {
            const rows = visible.filter((c) => c.group === g);
            if (rows.length === 0) return null;
            return (
              <ul key={g} className="michi-menu-list" aria-label={label}>
                <li aria-hidden="true" className="michi-menu-section">{label}</li>
                {rows.map((c) => {
                  const idx = visible.indexOf(c);
                  const quickKey = !showRecents && idx < 9 ? kbd('mod', String(idx + 1)) : null;
                  const keys = quickKey ?? c.keys;
                  // A recent thread names its workspace at the row's end.
                  const where = g === 'recent' ? c.meta : undefined;
                  return (
                    <MenuItem
                      key={c.id}
                      active={idx === active}
                      onMouseEnter={() => hoverSetActive(idx)}
                      onClick={() => { c.run(); onClose(); }}
                    >
                      <span className="michi-menu-glyph" aria-hidden="true"><CommandIconGlyph name={c.icon} /></span>
                      <span className="michi-menu-label">
                        {c.label}
                        {c.meta && !where ? <span className="michi-menu-caption michi-menu-sublabel">{c.meta}</span> : null}
                      </span>
                      {where ? <span className="michi-menu-caption michi-menu-where">{where}</span> : null}
                      {keys ? <span className="michi-menu-keys">{keys}</span> : null}
                    </MenuItem>
                  );
                })}
              </ul>
            );
          })}
          {visible.length === 0 && nodeResults.length === 0 && (
            <div className="michi-menu-caption" style={{ padding: 'var(--m-rowY) var(--m-rowX)' }}>
              {showRecents ? 'No commands available'
                // Messages are searched once typing pauses; until they answer, nothing is known not to match.
                : debouncedQuery !== query || nodeSearch.status === 'loading' ? 'Searching…'
                  : nodeSearch.status === 'error' ? 'Couldn’t search messages' : 'No matches'}
            </div>
          )}
          {/* Node-grouped search results — deduped by node, time-sorted, with breadcrumbs */}
          {!showRecents && nodeResults.length > 0 && (
            <ul className="michi-menu-list" aria-label="Messages">
              <li aria-hidden="true" className="michi-menu-section">
                Messages · {nodeResults.length} node{nodeResults.length !== 1 ? 's' : ''}
              </li>
              {nodeResults.map((nr, ni) => {
                const rowIdx = visible.length + ni;
                const overflow = nr.totalMatches - nr.snippets.length;
                return (
                  <MenuItem
                    key={nr.nodeId}
                    active={rowIdx === active}
                    onMouseEnter={() => hoverSetActive(rowIdx)}
                    onClick={() => navigateToNodeResult(nr)}
                    style={NODE_ROW_STYLE}
                  >
                    {/* Breadcrumb + timestamp row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
                      <div style={BREADCRUMB_STYLE}>
                        <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', letterSpacing: 'var(--ls-wide)' }}>
                          {nr.workspaceName}
                        </span>
                        {nr.breadcrumb.length > 0 && (
                          <span style={{ color: 'var(--term-line-s)', margin: '0 5px', fontSize: 'var(--fs-xs)' }}>›</span>
                        )}
                        {nr.breadcrumb.map((seg, si) => {
                          const isLast = si === nr.breadcrumb.length - 1;
                          return (
                            <React.Fragment key={si}>
                              {si > 0 && (
                                <span style={{ color: 'var(--term-faint)', margin: '0 3px', fontSize: 'var(--fs-xs)' }}>/</span>
                              )}
                              <span style={isLast ? { color: 'var(--term-fg)', fontWeight: 500 } : { color: 'var(--term-muted)' }}>
                                {seg}
                              </span>
                            </React.Fragment>
                          );
                        })}
                      </div>
                      <span style={NODE_TIME_STYLE}>{relativeTime(nr.lastMessageAt)}</span>
                    </div>
                    {/* Snippets */}
                    <div>
                      {nr.snippets.map((s, si) => (
                        <div
                          key={si}
                          style={SNIPPET_ROW_STYLE}
                          onClick={(e) => { e.stopPropagation(); navigateToNodeResult(nr, s.messageId); }}
                        >
                          <span style={SNIPPET_ROLE_STYLE}>⌕</span>
                          <span>{renderHtmlSnippet(s.snippet)}</span>
                        </div>
                      ))}
                      {overflow > 0 && (
                        <div style={OVERFLOW_HINT_STYLE}>+ {overflow} more match{overflow !== 1 ? 'es' : ''}</div>
                      )}
                    </div>
                  </MenuItem>
                );
              })}
            </ul>
          )}
        </div>
        <div className="palette-hints" style={HINT_ROW}>
          {PALETTE_HINTS.map(([keys, label]) => (
            <span key={label}>
              {keys.map((k) => <kbd key={k} style={HINT_KEY}>{k}</kbd>)}
              {label}
            </span>
          ))}
        </div>
    </ModalShell>
  );
}
