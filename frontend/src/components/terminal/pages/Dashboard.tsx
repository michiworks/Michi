import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import { prefersReducedMotion } from '../../../hooks/useReducedMotion';
import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useChatActions, useChatPanes, useChatProjects, useStructuralSelector, shallowArrayEqual } from '../../../state/chatStore';
import { paneScopeKey } from '../../../state/paneState';
import type { ChatNodeState } from '../../../state/chatTypes';
import type { AgentRunPaneItem } from '../../../state/paneItems';
import type { PagePaneItem } from '../../../state/paneItems';
import { agentRunPaneId } from '../../../state/paneItems';
import { agentResourceKey, identityOf } from '../../../state/agentIdentity';
import type { WorkflowRunPaneItem } from '../../../state/paneItems';
import { useOptionalWorkflowDomain, useWorkflowRunDetail } from '../../../state/workflowDomain';
import { useAgentDomain } from '../../../state/agentDomain';
import {
  createAgentRunNotificationTracker, isAgentRunNotificationCurrent, isAgentRunNotificationServerDecided,
} from '../../../state/agentRunNotifications';
import { isPaneShownInWindow } from '../../../state/attention/targetVisibility';
import { usePrefs } from '../../../state/prefs';
import EmptyThreads from '../../EmptyThreads';
import ResizeHandle from '../../ResizeHandle';
import TPane from '../TPane';
import { setPaneDragWidth, usePaneDragWidth, withPaneDragWidth, type PaneDragWidth } from '../paneDragWidth';
import DigestPane from '../DigestPane';
import PaneErrorBoundary from '../PaneErrorBoundary';
import BrowserDock from '../BrowserDock';
import TerminalHome from './Home';
import { attentionTargetKey, presentAttention } from '../../../services/attention/policy';
import { toast } from 'sonner';
import { paneFileDropTarget } from '../paneFileDropTargets';
import { isFileDrag, useFileDropZone } from '../useFileDropZone';
import { FileDropOverlay } from '../PaneDragOverlays';
import { usePaneLayout } from '../usePaneLayout';
import { bindPaneCaptionScroll } from '../paneCaptionScroll';
import { afterPaneMotion, scrollWithPaneLayout } from '../paneReveal';
import { paneEntrance, PANE_EASE } from '../paneMotion';
import { isFreshBranch, playBranchPush } from '../branchMotion';
import { PaneArrivalTabs, usePaneArrivals } from '../PaneArrivals';
import { RetainedPaneContent, usePresentedPanes, usePresentedPaneFocus } from '../PanePresentation';

const PANE_ZOOM_FADE_MS = 180;

const FilePane = lazy(() => import('../FilePane'));
const TerminalPane = lazy(() => import('../TerminalPane'));
const PaneChooser = lazy(() => import('../PaneChooser'));
const FilesPane = lazy(() => import('../FilesPane'));
const ReviewPane = lazy(() => import('../ReviewPane'));
const PagePane = lazy(() => import('../spaces/PagePane'));
const AgentRunPaneSurface = lazy(() => import('../agentRuns/AgentRunPaneSurface'));
const WorkflowRunPane = lazy(() => import('../workflows/WorkflowRunPane').then((module) => ({ default: module.WorkflowRunPane })));
const notificationTracker = createAgentRunNotificationTracker();

function WorkflowRunPaneSurface({ item }: { item: WorkflowRunPaneItem }) {
  const { closePane, openPane } = useChatActions();
  const workflows = useOptionalWorkflowDomain();
  const identity = useMemo(() => ({ backendConnectionId: item.backendConnectionId, id: item.runId }), [item.backendConnectionId, item.runId]);
  const { resource, pending, error, missing } = useWorkflowRunDetail(identity);
  if (!workflows || !resource) {
    return <div style={{ padding: 16, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>{missing ? 'This workflow is no longer available.' : 'loading workflow…'}</div>;
  }
  const parentNodeId = resource.value.nodeId;
  return (
    <WorkflowRunPane
      run={resource.value}
      pending={pending}
      error={error}
      onClose={() => closePane(item.id)}
      onAction={(action) => { void workflows.act(identity, action); }}
      onAnswer={(approvalId, optionId) => { void workflows.answer(identity, approvalId, optionId); }}
      onOpenParent={parentNodeId ? () => openPane(parentNodeId) : undefined}
    />
  );
}

/**
 * Center a pane using the coordinates that are actually painted in the
 * dashboard strip. `offsetLeft` is relative to an offset parent and can drift
 * when the shell changes pages; viewport-relative rectangles do not.
 */
export function centeredPaneScrollLeft({
  paneLeft,
  paneWidth,
  stripLeft,
  stripWidth,
  currentScrollLeft,
  maxScrollLeft,
}: {
  paneLeft: number;
  paneWidth: number;
  stripLeft: number;
  stripWidth: number;
  currentScrollLeft: number;
  maxScrollLeft: number;
}): number {
  const paneDocumentLeft = paneLeft - stripLeft + currentScrollLeft;
  const desired = paneDocumentLeft + paneWidth / 2 - stripWidth / 2;
  return Math.max(0, Math.min(desired, maxScrollLeft));
}

// A chat pane takes a drop inside it itself (its root does not stop the
// event, so the strip's handlers see it too).
function insideChatPane(e: React.DragEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.('.terminal-pane');
}

export default function TerminalDashboard() {
  const { activeProject, agentStatus } = useChatProjects();
  const { openPanes: activePanes, pagePane, focusedPane, zoomedPane, paneItems: activeItems = {} } = useChatPanes();
  const phone = usePhoneLayout();
  // A phone already shows one pane at a time.
  const zoomedId = phone ? null : zoomedPane ?? null;
  const visiblePhonePane = activePanes.includes(focusedPane ?? '') && activeItems[focusedPane ?? '']?.kind !== 'browser' ? focusedPane : activePanes.find(id => activeItems[id]?.kind !== 'browser');
  const paneScope = paneScopeKey(activeProject, pagePane);
  const { settleFocus } = usePresentedPaneFocus(focusedPane);
  const { paneIds: presentedPanes, paneItems, exitingIds: allExitingIds, holdExits, finishExit } = usePresentedPanes(activePanes, activeItems);
  const openPanes = useMemo(() => presentedPanes.filter(id => paneItems[id]?.kind !== 'browser'), [presentedPanes, paneItems]);
  const exitingIds = useMemo(() => new Set([...allExitingIds].filter(id => openPanes.includes(id))), [allExitingIds, openPanes]);
  const browserItems = activePanes.flatMap(id => { const item = activeItems[id]; return item?.kind === 'browser' ? [item] : []; });
  const { setPaneWidth, openAgentRunPane, focusPane } = useChatActions();
  const agentDomain = useAgentDomain();
  const workflowDomain = useOptionalWorkflowDomain();
  const subscribeWorkflows = workflowDomain?.subscribeWorkspace;
  const { prefs } = usePrefs();

  const selectPaneWidths = useCallback(
    (nodesMap: Record<string, ChatNodeState>) =>
      openPanes.map((id) => paneItems[id]?.width ?? nodesMap[id]?.paneWidth),
    [openPanes, paneItems],
  );
  const selectPaneKinds = useCallback(
    (nodesMap: Record<string, ChatNodeState>) =>
      openPanes.map((id) => nodesMap[id]?.kind ?? 'chat'),
    [openPanes],
  );
  const savedWidths = useStructuralSelector(selectPaneWidths, shallowArrayEqual);
  const paneKinds = useStructuralSelector(selectPaneKinds, shallowArrayEqual);
  // A drag lays out from its live width (shared with the topbar's caption
  // strip) and saves it once on release.
  const dragWidth = usePaneDragWidth();
  const dragWidthRef = useRef<PaneDragWidth>(null);
  const widths = useMemo(() => withPaneDragWidth(savedWidths, openPanes, dragWidth), [savedWidths, openPanes, dragWidth]);
  const stripRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const layout = usePaneLayout(stripRef, {
    paneIds: openPanes, customWidths: phone ? [] : widths, mode: phone ? 'fixed' : prefs.paneWidthMode, exitingIds,
    defaultPaneWidth: phone ? 100_000 : prefs.defaultPaneWidth,
    enabled: !!activeProject && openPanes.length > 0,
    scope: paneScope,
    zoomedId,
    appReduceMotion: phone || prefs.reduceMotion,
    onExitStart: holdExits,
    onExitComplete: finishExit,
  });
  const paneOnScreen = (id: string) => {
    const strip = stripRef.current;
    const index = openPanes.indexOf(id);
    if (!strip || index < 0 || !layout.ready) return true;
    const left = layout.positions[index] - strip.scrollLeft;
    const width = layout.widths[index];
    // Hidden behind a zoomed pane.
    if (width <= 0) return false;
    return Math.min(left + width, strip.clientWidth) - Math.max(left, 0) >= width * 0.6;
  };
  const chatPanes = useMemo(() => activePanes.filter(id => activeItems[id]?.kind !== 'browser'), [activePanes, activeItems]);
  const { arrivals, recheck: recheckArrivals } = usePaneArrivals({
    scope: paneScope, panes: chatPanes, focusedPane, edges: activeProject?.edges, enabled: !phone, isOnScreen: paneOnScreen,
  });
  // Overlay scrollbar — native scrollbar is hidden via .hide-sb on the
  // strip; we render our own thumb as a sibling and reposition it from the
  // strip's onScroll. Idle thumb is opacity 0; we set opacity 1 while the
  // user is actively scrolling, then fade out 600ms after the last event.
  const thumbRef = useRef<HTMLDivElement>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  // Pane-scoped selection isolation. On mousedown inside a pane we mark the
  // strip `.selecting` and that pane's wrapper `.sel-source`; CSS then makes
  // every OTHER pane `user-select: none` so a drag can't sweep the native
  // selection across DOM order into a neighbor pane / follow-up row (the
  // flash the user reported). Toggled through classList — never React state —
  // so it stays off the streaming render path. See index.css `.selecting`.
  const selectionSourceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!activeProject?.id || !agentStatus?.customAgentsEnabled) return;
    void agentDomain.loadRuns({ version: 1, workspaceId: activeProject.id }).catch(() => {});
    return agentDomain.subscribeWorkspace(activeProject.id);
  }, [activeProject?.id, agentStatus?.customAgentsEnabled, agentDomain.loadRuns, agentDomain.subscribeWorkspace]);

  // Workflow runs are independent of custom agents: any Claude or Kiro chat
  // can launch one.
  useEffect(() => {
    if (!activeProject?.id || !subscribeWorkflows) return;
    return subscribeWorkflows(activeProject.id);
  }, [activeProject?.id, subscribeWorkflows]);

  // Read when a notification is due, after the attention policy's delay.
  const latestRunsRef = useRef(agentDomain.state.runs);
  latestRunsRef.current = agentDomain.state.runs;
  const latestPanesRef = useRef(activePanes);
  latestPanesRef.current = activePanes;
  useEffect(() => {
    const runs = Object.values(agentDomain.state.runs).filter((resource) => resource.value.workspaceId === activeProject?.id);
    for (const item of notificationTracker.collect({ runs })) {
      // Its backend announces it to every window once (chatStore presents server notices).
      if (isAgentRunNotificationServerDecided(item)) continue;
      const identity = identityOf(item.run);
      const { workspaceId, effectiveDefinition } = item.run.value;
      const target = { type: 'agent_run' as const, runId: identity.id, workspaceId, backendConnectionId: identity.backendConnectionId };
      const paneId = agentRunPaneId(identity.backendConnectionId, identity.id);
      presentAttention({
        key: attentionTargetKey(target),
        kind: item.attention,
        title: item.title,
        body: item.body,
        target,
        isTargetVisible: () => isPaneShownInWindow(paneId, latestPanesRef.current),
        isStillCurrent: () => isAgentRunNotificationCurrent(item, latestRunsRef.current),
        onOpen: () => openAgentRunPane(identity, workspaceId, effectiveDefinition.name),
      });
    }
  }, [activeProject?.id, agentDomain.state.runs, openAgentRunPane]);

  const clearPaneSelectionIsolation = useCallback(() => {
    stripRef.current?.classList.remove('selecting');
    const src = selectionSourceRef.current;
    if (src) {
      src.classList.remove('sel-source');
      selectionSourceRef.current = null;
    }
  }, []);

  const handlePaneSelectionMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // primary button only — ignore right/middle
      const strip = stripRef.current;
      if (!strip) return;
      // Resolve the strip's DIRECT child — the pane wrapper the CSS `> *` rule
      // targets. NOT closest('[data-node-id]'): TPane's own root (TPane.tsx)
      // and mention-chip spans (MessageBlock.tsx) also carry data-node-id, so
      // closest matched a nested element. The real wrapper then stayed
      // un-exempted, its inherited user-select:none cascaded through the whole
      // pane, and selection died in every pane — the regression being fixed.
      let n = e.target as HTMLElement | null;
      while (n && n.parentElement !== strip) n = n.parentElement;
      const paneEl = n && n.parentElement === strip ? n : null;
      if (!paneEl || !paneEl.hasAttribute('data-node-id')) return;
      clearPaneSelectionIsolation(); // drop any stale source before re-marking
      strip.classList.add('selecting');
      paneEl.classList.add('sel-source');
      selectionSourceRef.current = paneEl;
      // Release on the next mouseup anywhere (pointer may leave the pane).
      window.addEventListener('mouseup', clearPaneSelectionIsolation, { once: true });
    },
    [clearPaneSelectionIsolation],
  );

  useEffect(
    () => () => {
      window.removeEventListener('mouseup', clearPaneSelectionIsolation);
      clearPaneSelectionIsolation();
    },
    [clearPaneSelectionIsolation],
  );

  const updateThumbGeometry = useCallback(() => {
    const strip = stripRef.current;
    const thumb = thumbRef.current;
    if (!strip || !thumb) return;
    const { clientWidth, scrollWidth, scrollLeft } = strip;
    if (scrollWidth <= clientWidth) {
      thumb.style.opacity = '0';
      return;
    }
    const trackInset = 8; // matches paddingLeft/Right of the thumb track region
    const trackSize = clientWidth - trackInset * 2;
    const thumbSize = Math.max(24, Math.floor((clientWidth / scrollWidth) * trackSize));
    const maxScroll = scrollWidth - clientWidth;
    const thumbPos = trackInset + (scrollLeft / maxScroll) * (trackSize - thumbSize);
    thumb.style.width = `${thumbSize}px`;
    thumb.style.transform = `translateX(${thumbPos}px)`;
  }, []);

  useEffect(() => {
    updateThumbGeometry();
    const onResize = () => updateThumbGeometry();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateThumbGeometry, openPanes.length, layout.gridTemplateColumns, layout.settledVersion]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const captions = strip?.closest('.terminal-shell')?.querySelector<HTMLElement>('[data-pane-captions]');
    if (!strip || !captions) return;
    // Translated wrappers can temporarily extend scrollWidth. Clamp to the
    // final extent once so closing at the right edge cannot drift each frame.
    const finalExtent = layout.padding + layout.contentWidth + layout.paddingRight;
    const maxScroll = Math.max(0, finalExtent - strip.clientWidth);
    if (exitingIds.size === 0 && strip.scrollLeft > maxScroll) strip.scrollLeft = maxScroll;
    return bindPaneCaptionScroll(strip, captions, !!layout.animationRef.current);
  }, [openPanes, exitingIds, activeProject?.id, activeProject?.activeTreeId, layout.gridTemplateColumns, layout.paddingRight, layout.settledVersion, layout.animationRef, layout.contentWidth, layout.padding]);

  const {
    visible: dashDropzoneVisible,
    fileCount: dashDroppedFileCount,
    onDragEnter: handleDashDragEnter,
    onDragOver: handleDashDragOver,
    onDragLeave: handleDashDragLeave,
    endDrag: endDashDrag,
  } = useFileDropZone({ ignore: insideChatPane });

  const handleDashDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e) || insideChatPane(e)) return;
    e.preventDefault();
    endDashDrag();

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // The chat pane under the cursor (its edge, outside its root), else the
    // focused one. The pane imports the files as its own drop would.
    const target = e.target as Node | null;
    const underCursor = Object.keys(paneRefs.current).find((id) => paneRefs.current[id]?.contains(target));
    const attach = paneFileDropTarget(underCursor) ?? paneFileDropTarget(focusedPane);
    if (!attach || !(await attach(files))) toast.error('Drop files on a chat pane to attach them');
  }, [endDashDrag, focusedPane]);

  const revealRef = useRef<(() => void) | null>(null);
  const lastReveal = useRef<{ scope: string; focused: string | null; zoomed: string | null; mode: string; ready: boolean; ids: string[]; width: number } | null>(null);
  useLayoutEffect(() => {
    if (layout.waitingForExit) {
      revealRef.current?.();
      return;
    }
    const scope = paneScope;
    const previous = lastReveal.current;
    lastReveal.current = { scope, focused: focusedPane, zoomed: zoomedId, mode: phone ? 'phone' : prefs.paneWidthMode, ready: layout.ready, ids: activePanes, width: stripRef.current?.clientWidth ?? 0 };
    const strip = stripRef.current;
    const revealPane = phone ? visiblePhonePane : focusedPane;
    const index = revealPane ? openPanes.indexOf(revealPane) : -1;
    if (!strip || index < 0 || !layout.ready) return;
    // Leaving a zoom brings the pane that was zoomed back to the middle.
    const requested = !previous || previous.scope !== scope || previous.focused !== focusedPane
      || previous.zoomed !== zoomedId
      || previous.mode !== (phone ? 'phone' : prefs.paneWidthMode) || !previous.ready
      || (phone && previous.width !== strip.clientWidth);
    // Closing the focused pane reveals its predecessor on the same clock as
    // the covering boundaries. Background closes preserve the current view.
    const closing = previous?.scope === scope && previous.ids.some(id => !activePanes.includes(id));
    if (!requested && !closing) return;
    revealRef.current?.();
    const left = layout.positions[index];
    const total = layout.padding + layout.contentWidth + layout.paddingRight;
    const keepPosition = closing && previous?.focused === focusedPane;
    const target = Math.max(0, Math.min(keepPosition ? strip.scrollLeft : left + layout.widths[index] / 2 - strip.clientWidth / 2, total - strip.clientWidth));
    const captions = strip.closest('.terminal-shell')?.querySelector<HTMLElement>('[data-pane-captions]');
    const mirror = (left: number) => { if (captions) captions.style.transform = `translateX(${-left}px)`; };
    if (layout.animationRef.current) {
      const stop = scrollWithPaneLayout(strip, layout.animationRef.current, target, mirror);
      const viewport = captions?.parentElement;
      viewport?.addEventListener('wheel', stop, { passive: true });
      revealRef.current = () => { stop(); viewport?.removeEventListener('wheel', stop); };
    } else {
      strip.scrollTo({ left: target, behavior: 'instant' });
      mirror(strip.scrollLeft);
    }
  }, [paneScope, focusedPane, zoomedId, openPanes, activePanes, prefs.paneWidthMode, phone, visiblePhonePane, layout]);

  useLayoutEffect(() => () => { revealRef.current?.(); }, []);

  useLayoutEffect(() => {
    if (!layout.ready || layout.waitingForExit) return;
    return afterPaneMotion(layout.animationRef.current, settleFocus);
  }, [layout, settleFocus]);

  const previousEntrance = useRef({ scope: '', ids: openPanes });
  const entrances = useRef(new Map<string, Animation>());
  const previousExits = useRef<ReadonlySet<string>>(new Set());
  const focusBeforeRef = useRef(focusedPane);
  useLayoutEffect(() => {
    const scope = paneScope;
    const previous = previousEntrance.current;
    previousEntrance.current = { scope, ids: openPanes };
    const reduced = phone || prefersReducedMotion(prefs.reduceMotion);
    for (const [id, animation] of entrances.current) {
      if (!openPanes.includes(id) || previous.scope !== scope || reduced) {
        animation.cancel(); entrances.current.delete(id);
      }
    }
    if (previous.scope !== scope || reduced) {
      previousExits.current = exitingIds;
      return;
    }
    for (const id of openPanes) {
      const exiting = exitingIds.has(id);
      const reopening = previousExits.current.has(id) && !exiting;
      if (exiting === previousExits.current.has(id) && previous.ids.includes(id)) continue;
      const surface = paneRefs.current[id]?.querySelector<HTMLElement>('.pane-entry-surface');
      if (!surface || typeof surface.animate !== 'function') continue;
      if (exiting) {
        // Freeze an interrupted entrance. Closing is only the outer covering
        // motion, never an independent fade with a separate removal callback.
        const entrance = entrances.current.get(id);
        entrance?.pause();
        continue;
      }
      // A branch just made from a pane here is pulled out of its parent; the
      // content comes in from the side of the pane the user was on.
      const branch = !reopening && isFreshBranch(activeProject?.edges, id);
      const anchor = focusBeforeRef.current ? openPanes.indexOf(focusBeforeRef.current) : -1;
      const side = anchor >= 0 && openPanes.indexOf(id) < anchor ? 'left' : 'right';
      const { frames, duration } = paneEntrance(prefs.paneSpawnAnimation, { branch, from: side });
      const current = reopening ? getComputedStyle(surface) : null;
      const from = current ? { opacity: current.opacity, transform: current.transform } : frames[0];
      entrances.current.get(id)?.cancel();
      const animation = surface.animate([from, frames[1]], {
        duration, easing: PANE_EASE, fill: 'both',
      });
      entrances.current.set(id, animation);
      animation.onfinish = () => {
        if (entrances.current.get(id) !== animation) return;
        animation.cancel(); entrances.current.delete(id);
      };
    }
    previousExits.current = exitingIds;
  }, [openPanes, exitingIds, paneScope, prefs.paneSpawnAnimation, phone, prefs.reduceMotion, activeProject?.edges]);
  // After the entrance above: it reads the focus of the commit before.
  useLayoutEffect(() => { focusBeforeRef.current = focusedPane; });
  useLayoutEffect(() => {
    const running = entrances.current;
    return () => { for (const animation of running.values()) animation.cancel(); running.clear(); };
  }, []);

  // Zooming in or out swaps the tracks at once; the panes that take the new
  // tracks fade up from the dim focus level instead of snapping.
  const previousZoom = useRef({ scope: paneScope, id: zoomedId });
  useLayoutEffect(() => {
    const previous = previousZoom.current;
    previousZoom.current = { scope: paneScope, id: zoomedId };
    if (previous.scope !== paneScope || previous.id === zoomedId) return;
    if (phone || prefersReducedMotion(prefs.reduceMotion)) return;
    // Zoom moving between panes, or a zoom ending: every pane on screen is new.
    const shown = zoomedId ? [zoomedId] : openPanes;
    for (const id of shown) {
      const surface = paneRefs.current[id]?.querySelector<HTMLElement>('.pane-entry-surface');
      if (!surface || typeof surface.animate !== 'function' || entrances.current.has(id)) continue;
      surface.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: PANE_ZOOM_FADE_MS, easing: PANE_EASE });
    }
  }, [paneScope, zoomedId, openPanes, phone, prefs.reduceMotion]);

  // A resize or settled layout can bring an off-screen branch into view.
  useLayoutEffect(() => { recheckArrivals(); }, [layout.settledVersion, layout.contentWidth, recheckArrivals]);

  // Runs after the reveal above has scrolled the strip to the new pane.
  const previousPhonePane = useRef({ scope: paneScope, id: visiblePhonePane, ids: activePanes });
  const stopBranchPush = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const previous = previousPhonePane.current;
    previousPhonePane.current = { scope: paneScope, id: visiblePhonePane, ids: activePanes };
    if (phone && previous.scope === paneScope && previous.id === visiblePhonePane) return;
    stopBranchPush.current?.();
    stopBranchPush.current = null;
    if (!phone || !layout.ready || previous.scope !== paneScope || !previous.id || !visiblePhonePane) return;
    if (previous.ids.includes(visiblePhonePane) || !isFreshBranch(activeProject?.edges, visiblePhonePane)) return;
    // A launcher becomes the new chat in place; there is no parent to leave.
    if (activeItems[previous.id]?.kind === 'launcher') return;
    const incoming = paneRefs.current[visiblePhonePane];
    const outgoing = paneRefs.current[previous.id];
    if (!incoming || !outgoing) return;
    const title = incoming.closest('.terminal-shell')?.querySelector('.mobile-pane-title');
    stopBranchPush.current = playBranchPush(incoming, outgoing, title);
  }, [paneScope, visiblePhonePane, activePanes, phone, layout.ready, activeProject?.edges, activeItems]);
  useLayoutEffect(() => () => { stopBranchPush.current?.(); }, []);

  if (!activeProject) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-lg)',
        }}
      >
        — no workspace —
      </div>
    );
  }
  if (activeProject.activeTreeId === null && openPanes.length === 0 && browserItems.length === 0) {
    return <EmptyThreads />;
  }
  if (openPanes.length === 0 && browserItems.length === 0) {
    return <TerminalHome onSubmitted={() => {}} />;
  }
  const effContentWidth =
    (layout.zoomed || (activePanes.length - browserItems.length === 1 && !layout.waitingForExit)) && prefs.singlePaneContentWidth !== null
      ? prefs.singlePaneContentWidth
      : null;
  const { overflow, gridTemplateColumns } = layout;
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
    <div
      style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0, minWidth: 0 }}
    >
    <div
      ref={stripRef}
      // state/attention/targetVisibility.ts measures panes against this strip.
      data-pane-strip=""
      data-pane-width-mode={prefs.paneWidthMode}
      data-pane-zoomed={layout.zoomed ? zoomedId ?? '' : undefined}
      data-phone-panes={phone || undefined}
      className={['terminal-dashboard', 'hide-sb'].join(' ')}
      onScroll={() => {
        const thumb = thumbRef.current;
        updateThumbGeometry();
        if (thumb) thumb.style.opacity = '1';
        if (scrollIdleTimerRef.current !== null) {
          window.clearTimeout(scrollIdleTimerRef.current);
        }
        scrollIdleTimerRef.current = window.setTimeout(() => {
          if (thumb) thumb.style.opacity = '0';
          scrollIdleTimerRef.current = null;
        }, 600);
        // Notify native overlay surfaces (BrowserPane) that the strip
        // scrolled so they can re-sync their bounds. The DOM scroll event
        // on this container does not bubble to `window`.
        window.dispatchEvent(new Event('michi:dashboard-scroll'));
        recheckArrivals();
      }}
      onMouseDown={handlePaneSelectionMouseDown}
      onDragEnter={handleDashDragEnter}
      onDragOver={handleDashDragOver}
      onDragLeave={handleDashDragLeave}
      onDrop={(e) => { void handleDashDrop(e); }}
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns,
        gap: 'var(--term-dashboard-gap, 0px)',
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        overflowX: !phone && (overflow || exitingIds.size > 0) ? 'auto' : 'hidden',
        overflowY: 'hidden',
        position: 'relative', /* anchor offsetLeft for scrollToPane */
        padding: 'var(--term-dashboard-padding, 0px)',
        boxSizing: 'border-box',
        // Extra right padding so the last pane can be scrolled to center
        // rather than stuck at the viewport's right edge.
        paddingRight: layout.paddingRight,
      }}
    >
      {openPanes.map((id, i) => {
        const zoomHidden = layout.zoomHiddenIds.has(id);
        const wrapStyle: React.CSSProperties = {
          position: 'relative',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          // Pane wrapper needs pane bg so TPane's opacity-dim composites against
          // the same color the caption cell composites against (Topbar zone 2
          // is also pane-bg). Without this, unfocused TPane shows through to
          // shell-bg while the caption shows through to pane-bg — same dim
          // formula yields visibly different colors.
          background: 'var(--term-pane-bg)',
          overflow: 'clip',
          ...layout.paneStyles[i],
          visibility: (phone && id !== visiblePhonePane) || zoomHidden ? 'hidden' : undefined,
        };
        return (
          <div
            key={id}
            ref={(el) => { paneRefs.current[id] = el; }}
            data-node-id={id}
            data-pane-exiting={exitingIds.has(id) ? '' : undefined}
            aria-hidden={exitingIds.has(id) || (phone && id !== visiblePhonePane) || zoomHidden || undefined}
            inert={exitingIds.has(id) || (phone && id !== visiblePhonePane) || zoomHidden}
            style={wrapStyle}
          >
            <div className="pane-entry-surface" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
            <RetainedPaneContent exiting={exitingIds.has(id)}>
            <PaneErrorBoundary paneId={id}>
              {paneItems[id] ? (
                <Suspense fallback={<div style={{ padding: 16, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>loading {paneItems[id].kind}…</div>}>
                  {paneItems[id].kind === 'launcher' ? <PaneChooser item={paneItems[id]} />
                    : paneItems[id].kind === 'files' ? <FilesPane item={paneItems[id]} />
                    : paneItems[id].kind === 'review' ? <ReviewPane item={paneItems[id]} />
                    : paneItems[id].kind === 'file' ? <FilePane item={paneItems[id]} />
                    : paneItems[id].kind === 'terminal' ? <TerminalPane item={paneItems[id]} />
                    : paneItems[id].kind === 'agent-run' ? <AgentRunPaneSurface item={paneItems[id]} />
                    : paneItems[id].kind === 'page' ? <PagePane item={paneItems[id] as PagePaneItem} />
                    : paneItems[id].kind === 'workflow-run' ? <WorkflowRunPaneSurface item={paneItems[id]} />
                    : null}
                </Suspense>
              ) : paneKinds[i] === 'digest' ? (
                <DigestPane nodeId={id} contentMaxWidth={effContentWidth} />
              ) : (
                <TPane nodeId={id} contentMaxWidth={effContentWidth} />
              )}
            </PaneErrorBoundary>
            </RetainedPaneContent>
            </div>
            {!phone && !layout.zoomed && <ResizeHandle
                paneRef={{ current: paneRefs.current[id] ?? null }}
                onResize={(w) => { dragWidthRef.current = { id, width: w }; setPaneDragWidth(dragWidthRef.current); }}
                onResizeEnd={() => {
                  const committed = dragWidthRef.current;
                  dragWidthRef.current = null;
                  // Save first, then drop the drag width: both land in one
                  // render, with no frame at the old width in between.
                  if (committed) setPaneWidth(committed.id, committed.width);
                  setPaneDragWidth(null);
                }}
                onReset={() => setPaneWidth(id, undefined)}
              />}
          </div>
        );
      })}
      {exitingIds.size > 0 && (
        <div aria-hidden data-pane-scroll-extent style={{ position: 'absolute', left: Math.max(0, layout.scrollExtent - 1), top: 0, width: 1, height: 1, pointerEvents: 'none' }} />
      )}
      <FileDropOverlay visible={dashDropzoneVisible} fileCount={dashDroppedFileCount} />
    </div>
      {!phone && <PaneArrivalTabs ids={arrivals} onOpen={focusPane} />}
      {!phone && overflow && (
        <div
          ref={thumbRef}
          className="dashboard-hscroll-thumb"
          style={{ opacity: 0 }}
          aria-hidden
        />
      )}
    </div>
    {browserItems.length > 0 && <BrowserDock key={`${activeProject.id}::${activeProject.activeTreeId ?? ''}`} items={browserItems} focusedPane={focusedPane} />}
    </div>
  );
}
