import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ContextMenu, { MenuPresence, menuOpenKey } from '../ContextMenu';
import {
  activeTreeRootNodeId,
  chatLabel,
  useChatActions,
  useChatPanes,
  useChatProjects,
  useStructuralSelector,
  shallowArrayEqual,
} from '../../state/chatStore';
import { paneScopeKey } from '../../state/paneState';
import { paneTitle } from '../../state/paneLabels';
import { useCloseOtherPanes } from '../../state/closeOtherPanes';
import { usePrefs } from '../../state/prefs';
import { IconBtn } from './primitives';
import { getElectron } from '../../lib/electronBridge';
import type { AppUpdateState } from '../../lib/electronBridge';
import SidebarToggleButton from './SidebarToggleButton';
import { AREA_RAIL_WIDTH } from './rail/AreaRail';
import PaneCaption from './PaneCaption';
import PaneLauncher from './PaneLauncher';
import PaneTabStrip from './PaneTabStrip';
import { MobilePaneSwitcher } from './MobilePaneSwitcher';
import { ResponsiveToolbar } from './ResponsiveToolbar';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useThemeColorSync } from '../../hooks/useThemeColorSync';
import BrowserLauncher from './BrowserLauncher';
import { TOPBAR_BUTTON_W, TOPBAR_TIP_DELAY_MS, TopbarIconButton } from './TopbarIconButton';
import { confirmDialog } from '../ui/ConfirmDialog';
import { findTreeIdForNode } from '../../state/tree';
import { activeBackendApiBase, getKnownBackendConnections } from '../../config/backendConnections';
import { backendConnectionIdFromApiBase } from '../../state/agentIdentity';
import { useManageAgentRoute } from '../../state/manageRoute';
import { usePaneLayout } from './usePaneLayout';
import { usePaneDragWidth, withPaneDragWidth } from './paneDragWidth';
import { usePresentedPanes, usePresentedPaneFocus } from './PanePresentation';

import type { PageId } from '../../state/commands';
import { kbd } from '../../lib/platform';
import { pageBackground } from '../../lib/pageBackground';
import { ArtifactsIcon, ChevronLeftIcon, ChevronRightIcon, DigestIcon, MapIcon } from './icons';
import { Columns2, Plus } from 'lucide-react';
import { useSpaceTopbar } from '../../state/pages/spaceTopbar';
import { openNewChatSheet, useCurrentSpaceScope } from '../../state/spaceConversations/store';
import { Button } from '../ui/controls';
import { HoverTip } from '../ui/Popover';
import './spaces/conversation/conversation.css';
import { usePaneBackgroundWorkCounts } from './backgroundWork/usePaneBackgroundWork';
import BackgroundWorkButton from './backgroundWork/BackgroundWorkButton';
import { CompanionTopbarButton } from './companion/CompanionTopbarButton';
import { isSystemWorkspace } from '../../state/assistant/systemWorkspace';
import { useCompanionName } from '../../state/companion/companionName';
import { DARK_PALETTES } from './tokens';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';
import { resetTemporaryChatDraft, setTemporaryChatDraft, useTemporaryChatDraft } from '../../state/temporaryChatDraft';
import { TemporaryChatGlyph } from './TemporaryChat';

export const TOPBAR_HEIGHT = 44;
/** The breadcrumb's bold title (active thread, Michi project). */
const BREADCRUMB_TITLE_STYLE: React.CSSProperties = {
  // Phones set --topbar-title-size from the text-size preset (mobile.css).
  fontSize: 'var(--topbar-title-size, var(--fs-lg))',
  fontWeight: 600,
  color: 'var(--term-fg)',
  letterSpacing: 'var(--ls-tight)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};
// Traffic-light cluster ends at ~x=66 (start 14 + 3×12 + 2×8 = 66). Pushing
// our icon cluster to x=96 leaves a ~30px breathing gap so the chrome (dots)
// and our chrome (sidebar/+/search) read as two distinct groups.
const TRAFFIC_LIGHT_PAD = 96;
// 26px hit targets give a comfortable click area; the cluster is vertically
// centered in the 44px topbar (y=22), which matches the traffic-light center
// (pos 16 + 6 radius). Horizontal rhythm intentionally differs from the dots.
const ZONE1_BUTTON_W = TOPBAR_BUTTON_W;
const ZONE1_BUTTON_GAP = 4;
// toggle + back + forward, then New chat + Search (a phone shows only its +).
const ZONE1_BASE_BUTTONS = 3;
const ZONE1_ENTRY_BUTTONS = 2;
const ZONE1_RIGHT_PAD = 8;
const BROWSER_BRAND_WIDTH = 76;
function zone1WidthFor(buttons: number, browserBrand: boolean): number {
  const cluster = buttons * ZONE1_BUTTON_W + (buttons - 1) * ZONE1_BUTTON_GAP;
  return (browserBrand ? 14 + BROWSER_BRAND_WIDTH + 4 : TRAFFIC_LIGHT_PAD) + cluster + ZONE1_RIGHT_PAD;
}
// Zone 1 hosts toggle + back + forward + new-chat + search past the
// traffic-light pad.
// When collapsed, zone-2 still starts directly after zone-1 — no extra pad.
const COLLAPSED_LEFT_PAD = 0;
// The backdrop beneath the right cluster removes caption text with an SVG
// filter (CaptionEraseFilter). Chromium, the desktop app's engine, renders SVG
// filters in backdrop-filter and alone exposes navigator.userAgentData; other
// browsers, Safari among them, keep a blur.
const CAPTION_ERASE = getElectron() !== null
  || (typeof navigator !== 'undefined' && 'userAgentData' in navigator);
const CAPTION_ERASE_FILTER_ID = 'topbar-caption-erase';
const CAPTION_BACKDROP_FILTER = CAPTION_ERASE ? `url(#${CAPTION_ERASE_FILTER_ID})` : 'blur(12px)';
const INVERT_MATRIX = '-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0';

export default function TerminalTopbar({
  page,
  onNav: _onNav,
  sidebarCollapsed,
  sidebarRail = false,
  onToggleSidebar,
  onNewThread,
  onOpenPalette,
  artifactsOpen = false,
  workspaceReady = true,
  remoteRecoveryControl,
  spacesCrumb,
  areaCrumb,
  onAreaHome,
  navigation,
  phoneBack,
}: {
  navigation: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void };
  /** A phone's page Back (TerminalShell's phone history), while it has somewhere to go. */
  phoneBack?: () => void;
  page: PageId;
  onNav: (p: PageId) => void;
  sidebarCollapsed: boolean;
  /** Wide-layout collapsed state leaves only the area rail; narrow/profile do not. */
  sidebarRail?: boolean;
  onToggleSidebar: () => void;
  onNewThread?: () => void;
  onOpenPalette?: () => void;
  artifactsOpen?: boolean;
  workspaceReady?: boolean;
  remoteRecoveryControl?: React.ReactNode;
  /** ‹ back on a Michi workspace document: return to the page that opened it (default Home). */
  /** What a Pages home shows after `PAGES ›`: Home or the workspace's name. */
  spacesCrumb?: string;
  /** What Settings and Scheduled show after their label: the open section or page; none on the job list. */
  areaCrumb?: string;
  /** Direct parent navigation, independent of back/forward history. */
  onAreaHome?: () => void;
}) {
  const {
    activeProject,
  } = useChatProjects();
  const { openPanes: activePanes, tabPanes, pagePane, focusedPane, zoomedPane, paneItems: activeItems = {} } = useChatPanes();
  const phone = usePhoneLayout();
  const paneScope = paneScopeKey(activeProject, pagePane);
  const { focusedPane: visualFocus } = usePresentedPaneFocus(focusedPane);
  const { paneIds: presentedPanes, paneItems, exitingIds: allExitingIds } = usePresentedPanes(activePanes, activeItems);
  const openPanes = useMemo(() => presentedPanes.filter(id => paneItems[id]?.kind !== 'browser'), [presentedPanes, paneItems]);
  const exitingIds = useMemo(() => new Set([...allExitingIds].filter(id => openPanes.includes(id))), [allExitingIds, openPanes]);
  const {
    focusPane,
    zoomPane,
    closePane,
    reorderPane,
  } = useChatActions();
  const { prefs } = usePrefs();
  const manageAgentRoute = useManageAgentRoute();

  // A phone has no pane captions; its title is the pane's, and a long press
  // on it offers what a caption's menu would.
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);
  const { closeOtherPanes, canCloseOtherPanes } = useCloseOtherPanes();

  // Per-pane data we need to render captions: title, status, kind. Uses
  // useStructuralSelector so HIGH_FREQ streaming dispatches don't re-render the topbar.
  // The assistant's hidden workspace active (a pane left from before the
  // conversation moved into the panel): the topbar names it by the agent's
  // name (never the workspace or a generated title) and drops launchers that
  // would act on that workspace.
  const inAssistant = isSystemWorkspace(activeProject);
  const assistantTitle = useCompanionName();
  const paneTitles = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => paneTitle(nodesMap[id], paneItems[id], { override: inAssistant ? assistantTitle : undefined })),
    shallowArrayEqual,
  );
  const paneStatuses = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => {
      const node = nodesMap[id];
      if (paneItems[id]) return 'idle';
      return node?.status === 'streaming' && node.visibleResponseComplete
        ? 'idle'
        : node?.status ?? 'idle';
    }),
    shallowArrayEqual,
  );
  const paneKinds = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => paneItems[id]?.kind ?? nodesMap[id]?.kind ?? 'chat'),
    shallowArrayEqual,
  );
  const paneTemporary = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => !paneItems[id] && nodesMap[id]?.temporary === true),
    shallowArrayEqual,
  );
  // Running subagents and workflows per chat pane (the caption badge);
  // changes only when a count does, not on every stream chunk.
  const paneBackgroundWork = usePaneBackgroundWorkCounts(openPanes, paneItems);
  // Pane widths drive the cell grid template — keep zone-2 cells aligned with
  // the Dashboard's pane columns so caption ↔ pane is a single visual stack.
  const savedPaneWidths = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => paneItems[id]?.width ?? nodesMap[id]?.paneWidth),
    shallowArrayEqual,
  );
  // While a pane edge is dragged its live width comes from the drag, not the store.
  const paneDragWidth = usePaneDragWidth();
  const paneWidths = useMemo(
    () => withPaneDragWidth(savedPaneWidths, openPanes, paneDragWidth),
    [savedPaneWidths, openPanes, paneDragWidth],
  );

  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null);

  // The Artifacts button is a plain toggle for the right-side drawer
  // (owned by TerminalShell). It reflects no open/close state of its own.

  // Dashboard drives this grid's translation. It has no independent scroll
  // position, so title gestures cannot race the pane's scroll momentum.
  const cellsStripRef = useRef<HTMLDivElement>(null);
  const retainedCaptionFocus = useRef(new Map<string, string | null>());
  const captionFocus = new Map(openPanes.map(id => [id,
    exitingIds.has(id) && retainedCaptionFocus.current.has(id)
      ? retainedCaptionFocus.current.get(id)!
      : visualFocus,
  ]));
  retainedCaptionFocus.current = captionFocus;
  // Single-page mode swaps the caption cells for a browser-style tab bar.
  const showTabs = !phone && workspaceReady && page === 'dashboard' && !!tabPanes?.length;
  const showPaneCells = !phone && workspaceReady && page === 'dashboard' && openPanes.length > 0 && !tabPanes;
  const paneLayout = usePaneLayout(cellsStripRef, {
    paneIds: openPanes, customWidths: paneWidths, mode: prefs.paneWidthMode, exitingIds,
    defaultPaneWidth: prefs.defaultPaneWidth, enabled: showPaneCells,
    scope: paneScope,
    zoomedId: zoomedPane ?? null,
    appReduceMotion: prefs.reduceMotion,
  });
  const zoomedCaption = paneLayout.zoomed ? zoomedPane ?? null : null;
  const zoomablePanes = openPanes.length - exitingIds.size;

  // Mirror Sidebar's isResizing so Zone 1's width transition can be suppressed
  // during drag-resize — otherwise the topbar lags the sidebar by 200ms.
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarSpacerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResizing = (e: Event) => {
      const { resizing, width } = (e as CustomEvent<{ resizing: boolean; width?: number }>).detail;
      setSidebarResizing(resizing);
      // A drag sets Zone 1's width on the spacer, the one element that reads
      // it, until Sidebar writes the final width to the root on release.
      const spacer = sidebarSpacerRef.current;
      if (!spacer) return;
      if (!resizing) spacer.style.removeProperty('--term-sidebar-width');
      else if (width != null) spacer.style.setProperty('--term-sidebar-width', `${width}px`);
    };
    window.addEventListener('michi:sidebar-resizing', onResizing as EventListener);
    return () => window.removeEventListener('michi:sidebar-resizing', onResizing as EventListener);
  }, []);

  const toggleArtifacts = useCallback(() => {
    window.dispatchEvent(new CustomEvent('michi:toggle-artifacts'));
  }, []);

  // Packaged Electron builds check GitHub Releases via the main-process updater.
  const electron = getElectron();
  const updateChannelEnabled =
    electron?.isPackaged === true && !!electron.onAppUpdate;

  useEffect(() => {
    if (!updateChannelEnabled) return;
    const api = getElectron();
    if (!api?.onAppUpdate) return;
    const apply = (next: AppUpdateState) => {
      setUpdateState(next);
      if (next.status === 'available' || next.status === 'downloading' || next.status === 'ready' || next.status === 'installing') {
        setUpdateAvailable(true);
      }
      setUpdating(next.status === 'downloading' || next.status === 'installing');
      if (next.status === 'error') setUpdating(false);
    };
    const unsub = api.onAppUpdate(apply);
    void api.getUpdateState?.().then(apply).catch(() => {});
    return unsub;
  }, [updateChannelEnabled]);

  const handleUpdate = async () => {
    // "Updating…" is still the trigger: a click on it must not start another update.
    if (updating) return;
    const api = getElectron();
    if (!api?.downloadUpdate || !api.installUpdate) return;
    if (updateState?.status === 'downloading' || updateState?.status === 'installing') return;
    const latest = updateState?.latestVersion;
    if (updateState?.status === 'ready') {
      if (!(await confirmDialog({
        title: 'Install update and restart?',
        message: latest
          ? `Michi ${latest} is downloaded. Install it now and restart?`
          : 'Install the downloaded update and restart Michi?',
        confirmLabel: 'Install and Restart',
        danger: false,
      }))) {
        return;
      }
      setUpdating(true);
      try {
        await api.installUpdate();
      } catch (err) {
        alert(`Update failed: ${err}`);
        setUpdating(false);
      }
      return;
    }
    setUpdating(true);
    try {
      const next = await api.downloadUpdate();
      setUpdateState(next);
      if (next.status === 'error') {
        alert(`Update failed: ${next.error ?? 'download failed'}`);
        setUpdating(false);
        return;
      }
      if (!(await confirmDialog({
        title: 'Install update and restart?',
        message: next.latestVersion
          ? `Michi ${next.latestVersion} finished downloading. Install it now and restart?`
          : 'The update finished downloading. Install it now and restart Michi?',
        confirmLabel: 'Install and Restart',
        danger: false,
      }))) {
        setUpdating(false);
        return;
      }
      await api.installUpdate();
    } catch (err) {
      alert(`Update failed: ${err}`);
      setUpdating(false);
    }
  };

  // Map / Digest are thread-scoped views: the topbar labels them
  // with the active thread (not just the workspace) and offers a ‹ back crumb
  // to the conversation, so the fullscreen page can't read as global.
  const threadPage = page === 'map' || page === 'digest';
  // A phone's ‹ beside ≡ while there is a page to go back to, unless the
  // breadcrumb already offers its own ‹ (a thread page, an editor).
  const showPhoneBack = phone && !!phoneBack && !threadPage && page !== 'workspace-manage' && page !== 'agent-manage';
  // Dashboard reuses Home once the shared presentation layer has finished
  // removing the last pane; this mirrors Dashboard's condition (no presented
  // chat pane and no browser pane).
  const dashboardShowsHome = page === 'dashboard'
    && activeProject != null
    && activeProject.activeTreeId !== null
    && openPanes.length === 0
    && !activePanes.some((id) => activeItems[id]?.kind === 'browser');
  // Home starts conversations; it shows none. The pane, browser, thread-view
  // and Artifacts controls act on the conversations on screen, so they wait
  // until one is.
  const showsHome = page === 'home' || dashboardShowsHome;
  const showWorkspaceControls = page !== 'scheduled' && page !== 'spaces' && page !== 'space' && !showsHome;
  // Home's temporary-chat switch is for the chat Home starts next: leaving
  // Home turns it off, so a later chat is never temporary by accident.
  const temporaryChat = useTemporaryChatDraft();
  useEffect(() => { if (!showsHome) resetTemporaryChatDraft(); }, [showsHome]);
  // The pane a phone's title names.
  const phoneTitlePane = Math.max(0, openPanes.indexOf(focusedPane ?? ''));
  // Michi pages are global, not thread-scoped: All threads is a bare label, a
  // workspace document gets a ‹ back crumb plus the Michi project's title
  // (MichiProjectCrumb, the only part of the topbar that follows Michi data).
  const activeTree =
    activeProject?.trees.find((t) => t.id === activeProject.activeTreeId) ?? null;
  const threadRootId = activeTreeRootNodeId(activeProject);
  const threadRootTitle = useStructuralSelector((nodesMap) => {
    if (!threadRootId) return '';
    const n = nodesMap[threadRootId];
    return n ? n.title || chatLabel(n) : '';
  });
  const threadTitle = inAssistant
    ? assistantTitle
    : activeTree
      ? activeTree.name?.trim() || threadRootTitle || 'Untitled thread'
      : activeProject?.name ?? '';
  // The Digest toggle carries the unread dot that used to live on the
  // sidebar's Digest row.
  const hasUnreadDigest = useStructuralSelector((nodesMap) => {
    if (!activeProject?.activeTreeId) return false;
    return activeProject.chatIds.some((id) => {
      const n = nodesMap[id];
      if (!n || n.kind !== 'digest' || n.deletedAt || !n.digest) return false;
      const belongsToActiveThread = n.digest.sources.some(
        (sourceId) => findTreeIdForNode(sourceId, activeProject) === activeProject.activeTreeId,
      );
      return belongsToActiveThread
        && n.digest.generatedAt > 0
        && n.digest.generatedAt > n.digest.viewedAt;
    });
  });

  const showWorkspaceTitle =
    page === 'workspaces' || page === 'scheduled' ||
    page === 'workspace-manage' || page === 'agents' || page === 'agent-manage' ||
    page === 'threads' || page === 'spaces' || page === 'space' || page === 'settings' ||
    (!!activeProject && threadPage);
  // Without a docked sidebar, the topbar follows the page background. Docked
  // layouts override this fallback with the shared outer-frame material.
  // Match the surface Dashboard renders; using the raw route kept the pane
  // surface white above Home's gray canvas.
  const topbarBg = pageBackground(dashboardShowsHome ? 'home' : page);
  const barRef = useRef<HTMLDivElement>(null);
  useThemeColorSync(barRef, [topbarBg, prefs.terminalPalette, prefs.terminalAccentOverrides]);
  const pageLabel =
    page === 'map' ? 'MAP'
    : page === 'digest' ? 'DIGEST'
    : page === 'workspaces' ? 'WORKSPACES'
    : page === 'scheduled' ? 'SCHEDULED'
    : page === 'settings' ? 'SETTINGS'
    : page === 'agents' ? 'AGENTS'
    : page === 'threads' ? 'ALL THREADS'
    : page === 'spaces' || page === 'space' ? 'PAGES'
    : '';
  const agentBackendConnectionId = page === 'agent-manage' && manageAgentRoute
    ? manageAgentRoute.backendConnectionId
    : backendConnectionIdFromApiBase(activeBackendApiBase());
  const agentBackendName = getKnownBackendConnections().find((connection) => connection.id === agentBackendConnectionId)?.name ?? agentBackendConnectionId;
  const showBrowserBrand = getElectron() === null;
  // New chat and Search stay in the cluster whether the sidebar is open or
  // closed, so they never move. A phone hides Search in mobile.css; its
  // drawer has its own New chat + Search row (Sidebar).
  const showNewChat = !!onNewThread;
  const showSearch = !!onOpenPalette;
  const zone1Width = zone1WidthFor(
    ZONE1_BASE_BUTTONS + (phone ? 0 : ZONE1_ENTRY_BUTTONS),
    showBrowserBrand,
  );

  // ── New-pane entrance tracking ──────────────────────────────
  // When a pane is added to activePanes but NOT focused, mark it as "new"
  // for the entrance animation. The transient set lives in state so caption
  // cells can read it; cleared on animation-end or when the pane receives
  // focus. Scope resets (workspace/tree change) clear all marks.
  const [newPaneIds, setNewPaneIds] = useState<ReadonlySet<string>>(new Set());
  const prevActivePanesRef = useRef<{ scope: string; ids: string[] }>({
    scope: '',
    ids: [],
  });
  const prevReduceMotion = useRef(prefs.reduceMotion);
  useEffect(() => {
    const scope = paneScope;
    const prev = prevActivePanesRef.current;
    prevActivePanesRef.current = { scope, ids: activePanes };
    prevReduceMotion.current = prefs.reduceMotion;

    // Scope changed — clear all marks, no entrance animation for hydration.
    if (prev.scope !== scope) {
      setNewPaneIds((s) => s.size > 0 ? new Set() : s);
      return;
    }

    // Respect reduced motion.
    if (prefersReducedMotion(prefs.reduceMotion)) return;

    // Diff: find panes that appeared and are NOT the focused pane.
    const added = activePanes.filter(
      (id) => !prev.ids.includes(id) && id !== focusedPane,
    );
    if (added.length === 0) return;

    setNewPaneIds((s) => {
      const next = new Set(s);
      for (const id of added) next.add(id);
      return next;
    });

    // Notify sidebar components so they can pulse the indicator bar.
    window.dispatchEvent(new CustomEvent('michi:new-background-panes', {
      detail: { nodeIds: added },
    }));

    // Safety timeout: clear marks after 1.2s in case animationend doesn't fire
    // (element not in viewport, etc.)
    const timer = window.setTimeout(() => {
      setNewPaneIds((s) => {
        if (added.every((id) => !s.has(id))) return s;
        const next = new Set(s);
        for (const id of added) next.delete(id);
        return next;
      });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [activePanes, paneScope, focusedPane, prefs.reduceMotion]);

  // When a new pane gets focused, clear its "new" mark immediately.
  useEffect(() => {
    if (!focusedPane) return;
    setNewPaneIds((s) => {
      if (!s.has(focusedPane)) return s;
      const next = new Set(s);
      next.delete(focusedPane);
      return next;
    });
  }, [focusedPane]);

  const clearNewMark = useCallback((id: string) => {
    setNewPaneIds((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);
  // On dashboard, zone 2 hosts per-pane caption cells aligned to Dashboard's
  // column template. The shared layout hook also coordinates track animation.
  const cellsTemplateColumns = paneLayout.gridTemplateColumns;
  return (
    <div
      ref={barRef}
      className="terminal-topbar"
      data-page={page}
      data-phone-back={showPhoneBack ? '' : undefined}
      data-drawer-open={phone && !sidebarCollapsed ? '' : undefined}
      style={{
        height: TOPBAR_HEIGHT,
        flexShrink: 0,
        background: `var(--term-chrome-bg, ${topbarBg})`,
        display: 'flex',
        alignItems: 'stretch',
        position: 'relative',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Zone 1: chrome region. The icon strip (toggle, new-chat, search) is
          always absolutely positioned over the topbar's left edge so it can
          stay visually fixed regardless of sidebar state. A separate in-flow
          spacer below it animates its width in lockstep with the sidebar — that
          way captions don't snap left when the sidebar collapses; they slide
          along with it. */}
      <div
        ref={sidebarSpacerRef}
        aria-hidden
        className="terminal-topbar-sidebar-spacer"
        style={{
          // The phone drawer overlays the shell instead of docking, so the bar
          // keeps its layout (and its title) while it is open.
          width: phone
            ? 0
            : sidebarRail
              ? AREA_RAIL_WIDTH
              : sidebarCollapsed
                ? 0
                : 'var(--term-sidebar-width, 280px)',
          flexShrink: 0,
          // Layout only: a painted edge here crosses the native traffic-light
          // cluster when this track shrinks to the 56px navigation rail.
          overflow: 'hidden',
          transition: sidebarResizing
            ? 'none'
            : sidebarCollapsed
              ? 'width var(--t-enter) cubic-bezier(.4,0,1,1)'
              : 'width var(--t-enter) cubic-bezier(0,0,.2,1)',
        }}
      />
      <div
        className="terminal-topbar-controls"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 2,
          width: zone1Width,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          background: 'transparent',
          boxSizing: 'border-box',
          paddingLeft: showBrowserBrand ? 10 : TRAFFIC_LIGHT_PAD,
          paddingRight: ZONE1_RIGHT_PAD,
          gap: ZONE1_BUTTON_GAP,
          minWidth: 0,
          // Pixel-snap match with traffic-light center: screenshot diff at 2x
          // DPR was 2px (icons rendered 1 logical px above the dots). A 1px
          // bottom pad pushes the centered cluster down to y=22 exactly.
          paddingTop: 1,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {showBrowserBrand && (
          <BrandHomeButton onClick={() => _onNav('home')} />
        )}
        {page !== 'profile' && (
          <SidebarToggleButton collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
        )}
        {showPhoneBack && (
          <TopbarIconButton onClick={phoneBack} tooltip="Back" label="Go back">
            <ChevronLeftIcon strokeWidth={1.8} />
          </TopbarIconButton>
        )}
        <TopbarIconButton
          onClick={navigation.onBack}
          disabled={!workspaceReady || !navigation.canBack}
          tooltip="Back"
          tooltipKbd={kbd('mod', '[')}
          label="Navigate back"
        >
          <ChevronLeftIcon strokeWidth={1.8} />
        </TopbarIconButton>
        <TopbarIconButton
          onClick={navigation.onForward}
          disabled={!workspaceReady || !navigation.canForward}
          tooltip="Forward"
          tooltipKbd={kbd('mod', ']')}
          label="Navigate forward"
        >
          <ChevronRightIcon strokeWidth={1.8} />
        </TopbarIconButton>
        {/* After back/forward, in the same place with the sidebar open or closed. */}
        {showNewChat && (
          <TopbarIconButton onClick={onNewThread!} tooltip="new chat" tooltipKbd={kbd('mod', 'T')} label="New chat">
            <PlusIcon />
          </TopbarIconButton>
        )}
        {showSearch && (
          <TopbarIconButton onClick={onOpenPalette!} disabled={!workspaceReady} tooltip="search" tooltipKbd={kbd('mod', 'K')} label="Search" className="t-search-trigger">
            <SearchGlyph />
          </TopbarIconButton>
        )}
      </div>

      {/* Zone 2: main surface. When collapsed, this zone owns the traffic-light
          pad plus space for the absolutely-positioned sidebar toggle button. */}
      <div
        className="terminal-topbar-main"
        data-pane-caption-viewport={showPaneCells ? '' : undefined}
        style={{
          marginRight: page === 'dashboard' ? 'var(--browser-dock-width, 0px)' : 0,
          flex: 1,
          // Docked layouts share one chrome surface across the entire topbar.
          // Narrow/profile layouts retain the page's own background.
          background: `var(--term-topbar-zone-bg, ${showPaneCells ? 'var(--term-bg)' : topbarBg})`,
          display: 'flex',
          alignItems: 'stretch',
          minWidth: 0,
          overflow: showPaneCells ? 'clip' : 'visible',
          paddingLeft: sidebarCollapsed ? COLLAPSED_LEFT_PAD : 0,
          transition: sidebarCollapsed
            ? 'padding-left var(--t-enter) cubic-bezier(.4,0,1,1)'
            : 'padding-left var(--t-enter) cubic-bezier(0,0,.2,1)',
        }}
      >
        {phone && workspaceReady && page === 'dashboard' && (
          <div
            className="mobile-pane-title"
            data-context-target={openPanes.length ? '' : undefined}
            onContextMenu={(event) => {
              event.preventDefault();
              if (openPanes.length) setTitleMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            {/* Another pane's name only when the focused one is not open here. */}
            {paneTemporary[phoneTitlePane] && <TemporaryChatGlyph size={16} inline />}
            {paneTitles[phoneTitlePane] || 'Michi'}
          </div>
        )}
        <MenuPresence>{titleMenu && phone && (() => {
          const paneId = focusedPane && openPanes.includes(focusedPane) ? focusedPane : openPanes[0];
          if (!paneId) return null;
          return (
            <ContextMenu
              key={menuOpenKey(titleMenu)}
              x={titleMenu.x}
              y={titleMenu.y}
              onClose={() => setTitleMenu(null)}
              sections={[{
                items: [
                  { id: 'close', label: 'Close', run: () => closePane(paneId) },
                  { id: 'close-others', label: 'Close Others', disabled: !canCloseOtherPanes(paneId), run: () => closeOtherPanes(paneId) },
                ],
              }]}
            />
          );
        })()}</MenuPresence>
        {showPaneCells && (
          <div
            ref={cellsStripRef}
            data-pane-captions
            style={{
              flex: 1,
              display: 'grid',
              position: 'relative',
              gridTemplateColumns: cellsTemplateColumns,
              gap: 'var(--term-dashboard-gap, 0px)',
              padding: 'var(--term-dashboard-padding, 0px)',
              minWidth: 0,
              boxSizing: 'border-box',
              // The outer viewport clips; this grid must stay non-scrollable
              // so translated captions remain visible beyond its own width.
              overflow: 'visible',
              paddingRight: paneLayout.paddingRight,
              // No mask on cells strip — masking also fades cell backgrounds,
              // revealing Zone 2's undimmed bg (the white-bleed bug). Cells
              // extend fully under the right cluster; their bg + dim is correct.
              // Text overflow is handled by PaneCaption's own ellipsis.
            } as React.CSSProperties}
          >
            {openPanes.map((id, i) => {
              const zoomHidden = paneLayout.zoomHiddenIds.has(id);
              const isFirst = zoomedCaption ? id === zoomedCaption
                : exitingIds.has(id) ? i === 0 : id === activePanes.find(paneId => activeItems[paneId]?.kind !== 'browser');
              const status = paneStatuses[i] ?? 'idle';
              const cellFocus = captionFocus.get(id);
              const isCellFocused = cellFocus === id;
              const isCellNew = newPaneIds.has(id);
              // First cell needs to clear the floating Zone 1 (traffic lights
              // + 3 icons) when sidebar is collapsed; otherwise the title would
              // sit under it.
              const firstCellLeftPad = isFirst && sidebarCollapsed
                ? zone1Width - (sidebarRail ? AREA_RAIL_WIDTH : 0)
                : 0;
              return (
                <div
                  key={id}
                  data-pane-caption-id={id}
                  data-pane-exiting={exitingIds.has(id) ? '' : undefined}
                  aria-hidden={exitingIds.has(id) || zoomHidden || undefined}
                  inert={exitingIds.has(id) || zoomHidden}
                  onClick={() => focusPane(id)}
                  onAnimationEnd={isCellNew ? () => clearNewMark(id) : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    overflow: 'hidden',
                    minWidth: 0,
                    pointerEvents: exitingIds.has(id) ? 'none' : undefined,
                    // 12px baseline so the chip never hugs the cell's left
                    // edge; first cell when sidebar is collapsed adds the
                    // traffic-light + zone-1 icon clearance on top.
                    paddingLeft: firstCellLeftPad + 12,
                    paddingRight: 0,
                    // First cell's left pad shrinks/grows opposite the sidebar
                    // spacer (zone1Width → 0 as the spacer grows back to sidebar width).
                    // Without a matching transition, padding flips instantly
                    // while spacer eases, so the title snaps to ~12px and then
                    // slides right — visible as a flicker on toggle.
                    // Dim/bright transition must match TPane's pane body
                    // (same --t-soft + --t-ease) so the caption cell fades in
                    // lockstep with the pane below — otherwise the title
                    // strip snaps while the pane crossfades, which reads as
                    // jank on focus changes. First cell additionally eases
                    // its left-pad to match the sidebar spacer animation.
                    transition: [
                      (isFirst && !sidebarResizing)
                        ? sidebarCollapsed
                          ? 'padding-left var(--t-enter) cubic-bezier(.4,0,1,1)'
                          : 'padding-left var(--t-enter) cubic-bezier(0,0,.2,1)'
                        : null,
                      'filter var(--t-soft) var(--t-ease)',
                    ].filter(Boolean).join(', '),
                    borderRight: !prefs.paneRules ? 'none' : '1px solid var(--term-line)',
                    // Docked captions leave the frame visible; narrow layouts
                    // retain the pane's surface behind the title.
                    background: 'var(--term-topbar-zone-bg, var(--term-pane-bg, var(--term-surface)))',
                    // Match the pane's focus dimming without changing opacity
                    // or adding another tint layer to the shared frame.
                    filter: cellFocus == null || isCellFocused ? 'none' : `brightness(${1 - prefs.focusDim / 100 * 0.6})`,
                    // Layer 1: entrance animation — accent bg highlight fade-out.
                    ...(isCellNew ? { animation: 'pane-entrance-bg var(--t-slow) ease-out forwards' } : {}),
                    ...paneLayout.paneStyles[i],
                    ...(zoomHidden ? { visibility: 'hidden' as const } : {}),
                  }}
                >
                  <PaneCaption
                    nodeId={id}
                    title={paneTitles[i] || 'thread'}
                    focused={isCellFocused}
                    streaming={status === 'streaming'}
                    error={status === 'error'}
                    isNew={isCellNew}
                    backgroundWork={paneBackgroundWork(i)}
                    kind={paneKinds[i]}
                    temporary={paneTemporary[i]}
                    onFocus={focusPane}
                    onClose={closePane}
                    onCloseOthers={closeOtherPanes}
                    canCloseOthers={canCloseOtherPanes(id)}
                    onReorder={reorderPane}
                    zoomed={zoomedCaption === id}
                    canZoom={zoomablePanes > 1}
                    hiddenPaneCount={zoomablePanes - 1}
                    onZoom={zoomPane}
                  />
                </div>
              );
            })}
          </div>
        )}
        {showTabs && (
          <PaneTabStrip
            titleOverride={inAssistant ? assistantTitle : undefined}
            leftInset={sidebarCollapsed ? zone1Width - (sidebarRail ? AREA_RAIL_WIDTH : 0) : 0}
          />
        )}
        {workspaceReady && showWorkspaceTitle && (
          <div
            className="terminal-topbar-breadcrumb"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              // When the sidebar is collapsed, the floating Zone 1 (traffic
              // lights / brand + toggle + new + search) is absolutely
              // positioned over zone 2's left edge. Use marginLeft (not
              // paddingLeft) so this div's box starts AFTER the Zone 1
              // cluster — otherwise its -webkit-app-region: drag covers
              // Zone 1's no-drag buttons and swallows their clicks.
              marginLeft: sidebarCollapsed
                ? zone1Width - (sidebarRail ? AREA_RAIL_WIDTH : 0)
                : 0,
              paddingLeft: 14,
              // Extra right padding clears the absolutely-positioned right
              // cluster so the title/breadcrumb text doesn't run under icons.
              paddingRight: 160,
              minWidth: 0,
              flex: 1,
              fontFamily: 'var(--ui-font)',
              // Inherit the topbar's drag region so the empty space to the
              // right of the breadcrumb stays window-draggable. Interactive
              // children (BreadcrumbBackButton) opt out individually.
              WebkitAppRegion: 'drag',
              transition: sidebarResizing
                ? undefined
                : sidebarCollapsed
                  ? 'margin-left var(--t-enter) cubic-bezier(.4,0,1,1)'
                  : 'margin-left var(--t-enter) cubic-bezier(0,0,.2,1)',
            } as React.CSSProperties}
          >
            {threadPage && (
              <BreadcrumbBackButton onClick={() => _onNav('dashboard')} title="Back to thread (esc)">
                ‹ back
              </BreadcrumbBackButton>
            )}
            {page !== 'workspace-manage' && page !== 'agent-manage' && (
              areaCrumb && onAreaHome ? <BreadcrumbBackButton onClick={onAreaHome} title="Back to Scheduled">{pageLabel}</BreadcrumbBackButton> : <span
                style={{
                  fontSize: 'var(--fs-xs)',
                  letterSpacing: 'var(--ls-caps-wide)',
                  color: 'var(--term-muted)',
                }}
              >
                {pageLabel}
              </span>
            )}
            {page !== 'workspace-manage' && page !== 'agent-manage' && page !== 'workspaces'
              && page !== 'threads' && page !== 'spaces' && page !== 'space'
              && page !== 'scheduled' && page !== 'settings' && (
              <span style={{ color: 'var(--term-faint)', fontSize: 'var(--fs-sm)' }}>·</span>
            )}
            {page === 'agent-manage' ? (
              <BreadcrumbBackButton onClick={() => _onNav('agents')}>
                ‹ Agent Library
              </BreadcrumbBackButton>
            ) : page === 'workspace-manage' ? (
              <BreadcrumbBackButton onClick={() => _onNav('workspaces')}>
                ‹ all workspaces
              </BreadcrumbBackButton>
            ) : page === 'workspaces' ? null : page === 'agents' ? (
              <span style={{ fontSize: 'var(--fs-md)', color: 'var(--term-mid)', whiteSpace: 'nowrap' }}>
                control plane · {agentBackendName}
              </span>
            ) : page === 'scheduled' || page === 'settings' ? (
              areaCrumb ? <CrumbTitle title={areaCrumb} /> : null
            ) : page === 'spaces' ? (
              spacesCrumb ? <CrumbTitle title={spacesCrumb} /> : null
            ) : page === 'space' ? (
              <SpaceCrumb />
            ) : (
              <span title={threadTitle} style={BREADCRUMB_TITLE_STYLE}>
                {threadTitle}
              </span>
            )}
          </div>
        )}
      </div>

      {page === 'dashboard' && <div data-browser-caption-host style={{
        position: 'absolute', right: 0, top: 0, bottom: 0,
        width: 'var(--browser-dock-width, 0px)', overflow: 'hidden',
        display: 'flex', alignItems: 'stretch', background: 'var(--term-pane-bg)',
      }} />}

      {/* Right cluster: Update banner (when available) + thread-view toggles
          (Branches / Map / Digest) + Artifacts drawer trigger. Absolutely
          positioned so it doesn't shrink zone-2 — that would make the caption
          grid narrower than the Dashboard grid below and dividers would no
          longer line up. On Dashboard a backdrop (first child) clears
          scrolling caption text from beneath the icons while preserving the
          cell's own color — including its focus-dim state, which no painted
          color could track (the cell under the cluster changes with scroll
          position and focus). Elsewhere the cluster stays transparent over
          Zone 2's topbarBg. */}
      <div
        className="terminal-topbar-right"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 14px 0 14px',
          background: 'transparent',
        } as React.CSSProperties}
      >
        {showPaneCells && CAPTION_ERASE && <CaptionEraseFilter dark={DARK_PALETTES.has(prefs.terminalPalette)} />}
        {showPaneCells && (
          <div
            aria-hidden
            style={{
              // Caption cells scroll horizontally beneath the cluster. The
              // backdrop filter removes their text so the icons stay legible,
              // while keeping the cell's *composited* color — an opaque
              // backdrop can't work here because the cell bg dims with pane
              // focus (brightness filter) and which cell sits under the
              // cluster changes with scroll, so any painted color is wrong
              // some of the time. Requires opaque content beneath (cells +
              // Zone 2's topbarBg — guaranteed on Dashboard even under
              // vibrancy). No tint overlay — even a faint one shifts the
              // backdrop away from the true cell color, creating a visible
              // band on unfocused panes. The left mask fades the text out so
              // there's no hard vertical seam where the backdrop starts.
              // Negative z-index keeps it below the in-flow icons within the
              // cluster's stacking context.
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: -16,
              zIndex: -1,
              WebkitBackdropFilter: CAPTION_BACKDROP_FILTER,
              backdropFilter: CAPTION_BACKDROP_FILTER,
              background: 'transparent',
              WebkitMaskImage: 'linear-gradient(to right, transparent, black 16px)',
              maskImage: 'linear-gradient(to right, transparent, black 16px)',
            } as React.CSSProperties}
          />
        )}
        {remoteRecoveryControl}
        {updateAvailable && !updateDismissed && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                background: 'var(--term-accent)',
                color: 'var(--term-bg)',
                fontWeight: 700,
                borderRadius: 'var(--ui-radius-sm)',
                fontSize: 'var(--fs-sm)',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              <span
                onClick={handleUpdate}
                style={{ cursor: updating ? 'wait' : 'pointer' }}
              >
                {updateState?.status === 'downloading'
                  ? (typeof updateState.percent === 'number'
                    ? `⟳ Downloading ${updateState.percent}%`
                    : '⟳ Downloading…')
                  : updateState?.status === 'installing'
                    ? '⟳ Installing…'
                    : updateState?.status === 'ready'
                      ? (updateState.latestVersion
                        ? `↑ Install ${updateState.latestVersion} & Restart`
                        : '↑ Install & Restart')
                      : updateState?.latestVersion
                        ? `↑ Update to ${updateState.latestVersion}`
                        : '↑ Update & Restart'}
              </span>
              {!updating && (
                <IconBtn
                  onClick={() => setUpdateDismissed(true)}
                  style={{ opacity: 0.7, marginLeft: 4 }}
                >
                  ×
                </IconBtn>
              )}
            </span>
          )}
          {(page === 'space' || page === 'spaces') && <SpaceTopbarActions page={page} />}
          {showWorkspaceControls && workspaceReady && !!activeProject && !inAssistant && (
            <BackgroundWorkButton paneIds={activePanes} paneItems={activeItems} focusedId={focusedPane} />
          )}
          {showWorkspaceControls && <ResponsiveToolbar>
          {showWorkspaceControls && workspaceReady && !!activeProject && !inAssistant && (
            <>
              {!showTabs && <PaneLauncher />}
              <BrowserLauncher />
              <TopbarIconButton
                onClick={() => _onNav('map')}
                active={page === 'map'}
                label="Map"
                tooltip="Map"
                tooltipKbd={kbd('mod', 'M')}
              >
                <MapIcon size={14} />
              </TopbarIconButton>
              {prefs.digestEnabled && (
                <TopbarIconButton
                  onClick={() => _onNav('digest')}
                  active={page === 'digest'}
                  label="Digest"
                  tooltip="Digest"
                  tooltipKbd={kbd('mod', 'D')}
                  dot={hasUnreadDigest}
                >
                  <DigestIcon size={14} />
                </TopbarIconButton>
              )}
            </>
          )}
          {showWorkspaceControls && (
            <TopbarIconButton
              onClick={toggleArtifacts}
              disabled={!workspaceReady}
              active={artifactsOpen}
              label="Artifacts"
              tooltip="Artifacts"
            >
              <ArtifactsIcon size={14} />
            </TopbarIconButton>
          )}
          </ResponsiveToolbar>}
          {/* Every area: a machine's sign-in is not a workspace's. Hidden until a session has an hour left. */}
          {/* Home only: the chat it starts next is temporary (memory off), chosen before its first message. */}
          {showsHome && (
            <TopbarIconButton
              onClick={() => setTemporaryChatDraft(!temporaryChat)}
              active={temporaryChat}
              label={temporaryChat ? 'Turn off temporary chat' : 'Temporary chat'}
              tooltip={temporaryChat ? 'Turn off temporary chat' : 'Temporary chat'}
              className="topbar-temporary-chat"
            >
              <TemporaryChatGlyph size={14} />
            </TopbarIconButton>
          )}
          {/* Every area, with or without a workspace: the Companion is global. */}
          <CompanionTopbarButton />
          {phone && workspaceReady && page === 'dashboard' && <MobilePaneSwitcher />}
      </div>
    </div>
  );
}

/**
 * The caption backdrop's filter: a morphological opening (erode, then dilate)
 * removes marks narrower than 13px, such as caption text, dots and badges,
 * and leaves larger areas (the cell's color with its focus dim, a hover fill)
 * exactly as they were. A blur averaged light text into a lighter wash.
 * An opening removes marks lighter than their surroundings, so a light
 * palette's backdrop is inverted around it; closing (dilate, then erode)
 * would let the unfiltered caption show along the backdrop's edges.
 */
function CaptionEraseFilter({ dark }: { dark: boolean }) {
  return (
    <svg aria-hidden width={0} height={0} style={{ position: 'absolute' }}>
      <filter id={CAPTION_ERASE_FILTER_ID} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        {!dark && <feColorMatrix type="matrix" values={INVERT_MATRIX} />}
        <feMorphology operator="erode" radius={6} />
        <feMorphology operator="dilate" radius={6} />
        {!dark && <feColorMatrix type="matrix" values={INVERT_MATRIX} />}
      </filter>
    </svg>
  );
}

function BrandHomeButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  return (
    <HoverTip label="Home" delayMs={TOPBAR_TIP_DELAY_MS}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-label="Go home"
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--term-fg)',
          fontFamily: 'inherit',
          fontSize: 'var(--fs-3xl)',
          fontWeight: 700,
          letterSpacing: 'var(--ls-tight)',
          opacity: hover ? 1 : 0.85,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          transition: 'opacity var(--t-quick) var(--t-ease)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <img
          src="/favicon.png"
          alt=""
          width={26}
          height={26}
          style={{ display: 'block', flexShrink: 0, borderRadius: 'var(--ui-radius)' }}
        />
        Michi
      </button>
    </HoverTip>
  );
}

/** `› <workspace> › <Space page title>` after SPACES, published by the open Space page. */
function SpaceCrumb() {
  const space = useSpaceTopbar();
  const scope = useCurrentSpaceScope();
  if (!space?.title) return null;
  return <>
    {scope?.workspaceName && <CrumbSegment title={scope.workspaceName} />}
    <CrumbTitle title={space.title} />
  </>;
}

function CrumbSeparator() {
  return <span aria-hidden="true" style={{ color: 'var(--term-faint)', fontSize: 'var(--fs-sm)' }}>›</span>;
}

/** A crumb between SPACES and the title. */
function CrumbSegment({ title }: { title: string }) {
  return (
    <>
      <CrumbSeparator />
      <span title={title} style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-md)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 }}>{title}</span>
    </>
  );
}

function CrumbTitle({ title }: { title: string }) {
  return (
    <>
      <CrumbSeparator />
      <span title={title} style={BREADCRUMB_TITLE_STYLE}>{title}</span>
    </>
  );
}

/**
 * Spaces actions: Start a task opens the sheet on the page on screen, and a
 * page (not a home) opens beside the chat. A phone shows one pane at a time,
 * so it has no beside. The agent is the Topbar's one <name> button, as in
 * every area (DESIGN-v2 §1.2).
 */
function SpaceTopbarActions({ page }: { page: PageId }) {
  const space = useSpaceTopbar();
  const scope = useCurrentSpaceScope();
  const phone = usePhoneLayout();
  const beside = page === 'space' && !phone ? space?.onOpenBeside : undefined;
  if (!scope && !beside) return null;
  return (
    <>
      {scope && (phone ? (
        <TopbarIconButton onClick={() => openNewChatSheet()} active={false} label="Start a task from this page" tooltip="Start a task">
          <Plus size={16} strokeWidth={1.7} />
        </TopbarIconButton>
      ) : (
        <TopbarTextButton onClick={() => openNewChatSheet()} label="Start a task" ariaLabel="Start a task from this page" icon={<Plus size={13} strokeWidth={1.7} aria-hidden="true" />} />
      ))}
      {beside && (
        <TopbarTextButton onClick={beside} label="Open beside chat" icon={<Columns2 size={13} strokeWidth={1.6} aria-hidden="true" />} />
      )}
    </>
  );
}

function TopbarTextButton({ onClick, label, ariaLabel, icon }: { onClick: () => void; label: string; ariaLabel?: string; icon: React.ReactNode }) {
  return (
    <Button size="sm" className="space-topbar-btn" aria-label={ariaLabel} onClick={onClick} style={{ height: ZONE1_BUTTON_W }}>
      {icon}{label}
    </Button>
  );
}

function BreadcrumbBackButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="t-text-btn"
      style={{
        fontFamily: 'var(--font-mono, var(--ui-font))',
        fontSize: 'var(--fs-md)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 2v12M2 8h12" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" />
    </svg>
  );
}
