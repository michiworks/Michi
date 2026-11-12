import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import dagre from '@dagrejs/dagre';
import { useChatStore, useChatNodesSnapshot } from '../../../state/chatStore';
import { useStreamingNodeIds } from '../../../state/nodeActivity';
import ContextMenu, { menuOpenKey } from '../../ContextMenu';
import { isMapGraphEdge, mapGraphNodeIds, visibleMapNodeIds } from './mapVisibility';
import { buildTreeContextMenu, selectionActionState, type SelectionActionState, type SelectionRules } from '../../../lib/treeContextMenu';
import { requestDigest } from '../../../lib/digestPrompt';
import { requestDigestFocus } from '../../../state/digestFocus';
import { useDigestEnabled } from '../../../state/prefs';
import { MapTimeline } from '../map/MapTimeline';
import { MapCard } from '../map/MapCard';
import { autoCamera, boundsOf, focusIds, FOCUS_BRANCHES, type Camera } from '../map/mapCamera';
import { useCameraSnapshot, useMapCamera, type MapCameraController } from '../map/useMapCamera';
import { CARD_H, CARD_W, mapCardHeight } from '../map/mapCardMetrics';
import { branchRibbonText } from '../../../state/mapOverviewSelectors';
import { isNodeUnread } from '../../../state/sidebarSelectors';
import { isBranchEdge } from '../../../state/tree';
import Branches from './Branches';
import { MAP_VIEWS, MAP_VIEW_LABELS, type MapView } from './mapView';
import { useElkLayout, elkEdgePathD } from './useElkLayout';
import type { PageId } from '../../../state/commands';
import type { Tree } from '../../../state/chatTypes';
import { DUR } from '../../../motion/tokens';
import { exportPanelEvent } from '../../../state/appEvents';

// MapCard boxes fed to the layout engines use measured DOM heights (see
// cardHeights below). Expanding a card reflows the graph so neighbors slide
// to make room; both animate to their new positions (wrapper top/left
// transition).
const NODE_SEP = 48;         // gap between sibling cards (cross-axis, vertical in LR)
const RANK_SEP = 110;        // gap between ranks (main-axis, horizontal in LR)
const FIT_PADDING = 72;
// A grown-in card keeps its grow flag until map-card-in and map-edge-draw
// (both var(--t-slow) = DUR.slow, index.css) have finished, plus a hair.
const GROW_IN_MS = Math.round(DUR.slow * 1000) + 120;

// Glass material shared by the floating zoom pill. Token-based so it stays
// legible across palettes (translucent white on light, dark on dark).
const GLASS_BG = 'color-mix(in srgb, var(--term-surface) 82%, transparent)';
const GLASS_BORDER = '1px solid color-mix(in srgb, var(--term-fg) 8%, transparent)';
const GLASS_SHADOW = '0 12px 36px -18px color-mix(in srgb, var(--term-fg) 35%, transparent)';

const EMPTY_TREES: readonly Tree[] = [];
// The bar and the context menu share these, so both refuse the same merges.
const MAP_SELECTION_RULES: SelectionRules = { requireIdle: true, requireSingleThread: true };

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function useStableStringArray(value: string[]): readonly string[] {
  const ref = useRef<readonly string[]>(value);
  if (!sameStringArray(ref.current, value)) ref.current = value;
  return ref.current;
}

function sameLayoutTrees(a: readonly Tree[], b: readonly Tree[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.rootNodeId !== right.rootNodeId ||
      left.createdAt !== right.createdAt ||
      left.archivedAt !== right.archivedAt
    ) {
      return false;
    }
  }
  return true;
}

/** Keep lastActiveAt/name-only tree updates from invalidating graph geometry. */
function useStableLayoutTrees(value: readonly Tree[]): readonly Tree[] {
  const ref = useRef<readonly Tree[]>(value);
  if (!sameLayoutTrees(ref.current, value)) ref.current = value;
  return ref.current;
}

export default function TerminalMap({
  onNav,
  initialView = 'graph',
}: { onNav?: (p: PageId) => void; initialView?: MapView } = {}) {
  const {
    activeProject,
    edges,
    openPane,
    toggleSelection,
    clearSelection,
    selection,
    createBlankChild,
    deleteNode,
    trimNode,
    extractNodeTree,
    archiveNode,
    createMergedChat,
    createDigest,
    archiveTree,
    pinNode,
    unpinNode,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const digestEnabled = useDigestEnabled();
  const streamingIds = useStreamingNodeIds();
  // Top-level view (graph / timeline / doc). Session-only; opens on graph unless
  // the shell asks for another (the old Overview route opens Doc).
  // The switcher floats top-right on the canvas, under the Topbar's icon row.
  const [view, setView] = useState<MapView>(initialView);
  // Which graph cards are expanded (in-place, pushes neighbors via dagre). Session-only.
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Measured DOM heights feed the layout so boxes match the real
  // cards. `headHeights` is the collapsed part of each card (stable while the
  // expand area animates); `measuredHeights` is the whole card, recorded only
  // while it is expanded.
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(new Map());
  const [headHeights, setHeadHeights] = useState<Map<string, number>>(new Map());
  const cardRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const expandedSetRef = useRef(expandedSet);
  expandedSetRef.current = expandedSet;
  const roRef = useRef<ResizeObserver | null>(null);
  if (!roRef.current) {
    const mergeHeights = (prev: Map<string, number>, updates: [string, number][]) => {
      let changed = false;
      const next = new Map(prev);
      for (const [nid, h] of updates) {
        if (prev.get(nid) !== h) { next.set(nid, h); changed = true; }
      }
      return changed ? next : prev;
    };
    roRef.current = new ResizeObserver((entries) => {
      const full: [string, number][] = [];
      const heads: [string, number][] = [];
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const h = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
        if (h <= 0) continue;
        const headId = el.getAttribute('data-map-card-head');
        if (headId) { heads.push([headId, h]); continue; }
        const nodeId = el.getAttribute('data-map-node');
        if (nodeId && expandedSetRef.current.has(nodeId)) full.push([nodeId, h]);
      }
      if (heads.length > 0) setHeadHeights((prev) => mergeHeights(prev, heads));
      if (full.length > 0) setMeasuredHeights((prev) => mergeHeights(prev, full));
    });
  }
  // Cleanup the ResizeObserver on unmount.
  useEffect(() => () => { roRef.current?.disconnect(); }, []);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // fanout grow-in: ids that appeared since the last render play the grow
  // animation once. `seenIdsRef` is the StrictMode-safe ledger of ids already
  // mounted; the FIRST effect run seeds it with every current node so opening
  // the map never animates the existing tree — only nodes that show up
  // afterwards (agent spawn / branch) grow in.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const growTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [growIds, setGrowIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });

  const hasActiveProject = activeProject !== null;
  const projectTrees = activeProject?.trees ?? EMPTY_TREES;
  const layoutTrees = useStableLayoutTrees(projectTrees);
  const activeTreeId = activeProject?.activeTreeId ?? null;

  // The public Map is thread-scoped: only live chats reachable from the
  // active tree root participate in layout, selection, and actions.
  const computedLiveIds = useMemo(
    () => visibleMapNodeIds(activeProject, nodesSnapshot),
    [activeProject, nodesSnapshot],
  );
  const liveIds = useStableStringArray(computedLiveIds);
  const computedGraphIds = useMemo(
    () => mapGraphNodeIds(activeProject, nodesSnapshot),
    [activeProject, nodesSnapshot],
  );
  const graphIds = useStableStringArray(computedGraphIds);

  const liveSet = useMemo(() => new Set(liveIds), [liveIds]);

  // Layout height of every live card (measured, with estimates as fallback).
  const cardHeights = useMemo(() => {
    const out = new Map<string, number>();
    for (const id of liveIds) {
      out.set(id, mapCardHeight(expandedSet.has(id), headHeights.get(id), measuredHeights.get(id)));
    }
    return out;
  }, [liveIds, expandedSet, headHeights, measuredHeights]);

  // 'link' (cross-tree reference) and 'digest-source' (digest fan-in) edges
  // are decorative: feeding them to a layout yanks roots sideways and pulls
  // digests into the middle of the tree. 'merge' edges keep the synthesize
  // node anchored near its sources.
  const graphEdges = useMemo(
    () => edges.filter((e) => isMapGraphEdge(e) && liveSet.has(e.source) && liveSet.has(e.target)),
    [edges, liveSet],
  );

  const graphChildren = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const e of graphEdges) {
      const arr = children.get(e.source) ?? [];
      arr.push(e.target);
      children.set(e.source, arr);
    }
    return children;
  }, [graphEdges]);

  // child -> parent (branch edges only), for the hover-ancestor-chain highlight.
  const parentOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of edges) {
      if (!isBranchEdge(e)) continue;
      if (!liveSet.has(e.source) || !liveSet.has(e.target)) continue;
      m.set(e.target, e.source);
    }
    return m;
  }, [edges, liveSet]);

  // Hovered node's ancestor chain (itself + every parent up to the root).
  // null when nothing is hovered — no dimming in that case.
  const ancestorSet = useMemo(() => {
    if (!hoveredId) return null;
    const set = new Set<string>();
    let cur: string | undefined = hoveredId;
    while (cur && !set.has(cur)) {
      set.add(cur);
      cur = parentOf.get(cur);
    }
    return set;
  }, [hoveredId, parentOf]);

  // Merge-source highlight: when hovering a merge node, light up all its
  // source nodes + the merge edges flowing into it.
  const mergeHighlightSet = useMemo(() => {
    if (!hoveredId) return null;
    const node = nodesSnapshot[hoveredId];
    if (!node?.mergeSources?.length) return null;
    return new Set([hoveredId, ...node.mergeSources]);
  }, [hoveredId, nodesSnapshot]);

  const activeTree = useMemo(() => {
    if (!activeTreeId) return null;
    const tree = layoutTrees.find((item) => item.id === activeTreeId) ?? null;
    return tree && !tree.archivedAt ? tree : null;
  }, [activeTreeId, layoutTrees]);

  const dagreLayout = useMemo(() => {
    if (!hasActiveProject) return null;

    const PAD = 36;
    const ids = graphIds;
    if (ids.length === 0) {
      return {
        ids: [],
        positions: new Map<string, { x: number; y: number }>(),
        width: CARD_W + PAD * 2,
        height: CARD_H + PAD * 2,
      };
    }
    // rankdir LR: root on the left, children fan right.
    const g = new dagre.graphlib.Graph();
    // align UL: a parent lines up with its first child, so the root sits at
    // the top-left and later branches continue downward.
    g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, align: 'UL' });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of ids) {
      g.setNode(id, { width: CARD_W, height: cardHeights.get(id) ?? CARD_H });
    }
    for (const e of graphEdges) {
      g.setEdge(e.source, e.target, { kind: e.kind ?? 'branch' });
    }
    dagre.layout(g);

    const nodeLocal = new Map<string, { x: number; y: number }>();
    let minX = Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const p = g.node(id);
      if (!p) continue;
      nodeLocal.set(id, { x: p.x, y: p.y });
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const leftX = PAD + CARD_W / 2;
    const positions = new Map<string, { x: number; y: number }>();
    const laidIds: string[] = [];
    let maxX = -Infinity;
    for (const id of ids) {
      const local = nodeLocal.get(id);
      if (!local) continue;
      laidIds.push(id);
      const x = local.x - minX + leftX;
      positions.set(id, { x, y: local.y - minY + PAD });
      if (x > maxX) maxX = x;
    }

    return {
      ids: laidIds,
      positions,
      width: maxX + CARD_W / 2 + PAD,
      height: (maxY - minY) + CARD_H + PAD * 2,
    };
    // cardHeights changes on expand/collapse and when DOM measurements land,
    // so neighbors slide to make room.
  }, [hasActiveProject, graphIds, graphEdges, cardHeights]);

  // The Map's one layout: ELK layered, orthogonal edge routing. ELK loads and
  // lays out asynchronously, so the synchronous dagre pass above stands in
  // until its first result lands (and keeps the Map usable if it never does).
  const elkResult = useElkLayout({
    enabled: view === 'graph',
    ids: graphIds,
    edges: graphEdges,
    cardHeights,
  });

  const layout = elkResult ?? dagreLayout;

  // Detect freshly-appeared graph nodes → play grow-in once, then drop the flag.
  const layoutIds = layout?.ids;
  useEffect(() => {
    if (!layoutIds) return;
    const current = new Set(layoutIds);
    const seen = seenIdsRef.current;
    if (seen === null) {
      // First pass: adopt the existing tree without animating it.
      seenIdsRef.current = current;
      return;
    }
    const fresh = layoutIds.filter((id) => !seen.has(id));
    for (const id of current) seen.add(id);
    if (fresh.length === 0) return;
    setGrowIds((prev) => {
      const next = new Set(prev);
      for (const id of fresh) next.add(id);
      return next;
    });
    const timers = growTimersRef.current;
    for (const id of fresh) {
      const existing = timers.get(id);
      if (existing) clearTimeout(existing);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        setGrowIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, GROW_IN_MS));
    }
  }, [layoutIds]);

  useEffect(() => {
    const timers = growTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  // Layout effect so the first paint is already framed (no flash at 1x).
  useLayoutEffect(() => {
    if (view !== 'graph') return;
    const surface = surfaceRef.current;
    if (!surface) return;

    let frame = 0;
    const update = () => {
      const next = {
        width: surface.clientWidth,
        height: surface.clientHeight,
      };
      setSurfaceSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    });
    observer.observe(surface);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [layout?.height, layout?.width, view]);

  // Auto framing target: the root and its first FOCUS_BRANCHES branches
  // (the whole graph when it has no more than that). Everything else is
  // reached by panning.
  const autoTarget = useMemo<Camera | null>(() => {
    if (!layout || layout.ids.length === 0) return null;
    if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return null;
    const sizeOf = (id: string) => ({ width: CARD_W, height: cardHeights.get(id) ?? CARD_H });
    const rootId = activeTree?.rootNodeId;
    const ids = rootId ? focusIds(rootId, graphChildren, layout.positions, FOCUS_BRANCHES) : [];
    const focus = boundsOf(ids.length > 0 ? ids : layout.ids, layout.positions, sizeOf);
    if (!focus) return null;
    const anchor = (rootId ? layout.positions.get(rootId) : undefined)
      ?? { x: (focus.minX + focus.maxX) / 2, y: (focus.minY + focus.maxY) / 2 };
    return autoCamera({ focus, anchor, viewport: surfaceSize, padding: FIT_PADDING });
  }, [layout, surfaceSize, cardHeights, activeTree, graphChildren]);

  const camera = useMapCamera({
    viewport: surfaceSize,
    content: { width: layout?.width ?? 0, height: layout?.height ?? 0 },
    autoTarget,
  });
  const bindCameraSurface = camera.bindSurface;
  const bindSurface = useCallback((el: HTMLDivElement | null) => {
    surfaceRef.current = el;
    bindCameraSurface(el);
  }, [bindCameraSurface]);
  // Switching thread starts from the default framing again.
  const resetCameraToAuto = camera.resetToAuto;
  useEffect(() => {
    resetCameraToAuto();
  }, [activeTreeId, resetCameraToAuto]);
  const closeMenuFromMapPointerDown = (event: React.PointerEvent) => {
    if (event.button === 0 && menu) setMenu(null);
  };

  if (!activeProject || !layout) {
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

  // Selection is global store state, but the Map's action bar and context
  // menu must only operate on live nodes visible in this map. This prevents a
  // stale selection from another thread, or a digest/archived surface, from
  // silently joining a merge, export, archive or delete.
  const selectedMapIds = liveIds.filter((id) => selection.has(id));
  const selectionState = selectionActionState({
    ids: selectedMapIds,
    project: activeProject,
    nodes: nodesSnapshot,
    ...MAP_SELECTION_RULES,
  });

  const mergeSelection = async () => {
    if (!selectionState.canWeave) return;
    try {
      await createMergedChat(selectedMapIds);
      clearSelection();
      onNav?.('dashboard');
    } catch {
      // createMergedChat already surfaces its validation error as a toast.
    }
  };

  const digestSelection = () => {
    if (!selectionState.canDigest) return;
    requestDigest(activeProject.id, selectedMapIds);
    clearSelection();
  };

  const exportNodes = (nodeIds: string[]) => {
    exportPanelEvent.dispatch({ projectId: activeProject.id, nodeIds });
  };

  const strokeFor = (
    kind: string | undefined,
  ): { stroke: string; dasharray?: string; opacity: number } => {
    switch (kind) {
      case 'merge':
        return { stroke: 'var(--term-mauve)', dasharray: '6 4', opacity: 0.65 };
      case 'link':
        return { stroke: 'var(--term-accent)', dasharray: '2 6', opacity: 0.7 };
      default:
        return { stroke: 'color-mix(in srgb, var(--term-fg) 25%, transparent)', opacity: 1 };
    }
  };

  const nowTs = Date.now();
  const rootNodeId = activeTree?.rootNodeId ?? null;

  return (
    <MapFrame view={view} setView={setView}>
      {view === 'timeline' && (
        <MapTimeline
          nodes={liveIds.map((id) => nodesSnapshot[id]).filter(Boolean)}
          now={Date.now()}
          parentOf={parentOf}
          onOpenPane={(id) => {
            openPane(id);
            onNav?.('dashboard');
          }}
          onFocus={(id) => {
            openPane(id);
            onNav?.('dashboard');
          }}
        />
      )}
      {view === 'doc' && <Branches onNav={onNav} />}
      {view === 'graph' && (
      <div
        onPointerDownCapture={closeMenuFromMapPointerDown}
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
      >
        {/* map surface: clips the camera-transformed world and owns input
            (wheel / pinch / drag-pan, see useMapCamera). */}
        <div
          ref={bindSurface}
          data-map-surface=""
          style={{
            width: '100%',
            height: '100%',
            position: 'relative',
            overflow: 'hidden',
            // The camera handles touch/trackpad gestures itself.
            touchAction: 'none',
            backgroundImage: 'radial-gradient(color-mix(in srgb, var(--term-line) 55%, var(--term-bg)) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            cursor: 'grab',
          }}
        >
            {/* World: SVG draws edges, DOM layer draws MapCards. Both share
                the camera transform (written imperatively, never by React). */}
            <div
              ref={camera.bindWorld}
              data-map-world=""
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: layout.width,
                height: layout.height,
              }}
            >
            <svg
              width={layout.width}
              height={layout.height}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
            >
              {edges.map((e, i) => {
                const src = layout.positions.get(e.source);
                const tgt = layout.positions.get(e.target);
                // Digest endpoints are absent from `positions` (digests are
                // hidden from the map), so digest-source edges drop out here.
                if (!src || !tgt) return null;
                // Card width is fixed (expansion only grows height, as an
                // overlay), so edges anchor to the constant collapsed box.
                // LR: leave the parent's right edge, enter the child's left edge.
                const sx = src.x + CARD_W / 2;
                const sy = src.y;
                const tx = tgt.x - CARD_W / 2;
                const ty = tgt.y;
                const dx = Math.max(42, (tx - sx) * 0.5);

                // ELK edge routing: use computed bend points when available.
                const elkRoute = elkResult?.edgeRoutes.get(`${e.source}->${e.target}`);
                const pathD = elkRoute
                  ? elkEdgePathD(elkRoute.sections, src, tgt)
                  : `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;

                const streamingEdge = streamingIds.has(e.target);
                const growEdge = isBranchEdge(e) && growIds.has(e.target);
                // Ancestor-chain highlight: an edge lights only when BOTH its
                // endpoints are on the hovered node's chain.
                const ancEdge = ancestorSet != null
                  && ancestorSet.has(e.source) && ancestorSet.has(e.target);
                // Merge-source highlight: a merge edge lights when hovering
                // the merge target and its source is in the highlight set.
                const mergeEdge = e.kind === 'merge'
                  && mergeHighlightSet != null
                  && mergeHighlightSet.has(e.source) && mergeHighlightSet.has(e.target);
                const dimEdge = ancestorSet != null && !ancEdge && !mergeEdge;
                const { stroke, dasharray, opacity } = strokeFor(e.kind);
                const litStroke = streamingEdge || ancEdge || mergeEdge;
                const edgeClass = [
                  streamingEdge ? 'map-edge--flow' : '',
                  growEdge ? 'map-edge--draw' : '',
                ].filter(Boolean).join(' ') || undefined;
                return (
                  <path
                    key={i}
                    className={edgeClass}
                    d={pathD}
                    stroke={mergeEdge ? 'var(--term-mauve)' : litStroke ? 'var(--term-accent)' : stroke}
                    strokeWidth={litStroke ? 1.8 : 1.4}
                    strokeLinecap="round"
                    strokeDasharray={streamingEdge || mergeEdge ? undefined : growEdge ? undefined : dasharray}
                    fill="none"
                    opacity={dimEdge ? opacity * 0.3 : opacity}
                    style={{ transition: 'opacity var(--t-soft), stroke var(--t-soft)' }}
                  />
                );
              })}
            </svg>
            {layout.ids.map((id) => {
              const n = nodesSnapshot[id];
              if (!n) return null;
              const pos = layout.positions.get(id);
              if (!pos) return null;
              const exp = expandedSet.has(id);
              // Wrapper uses the same height the layout engine was given, so
              // the card stays centered on pos.y.
              const w = CARD_W;
              const h = cardHeights.get(id) ?? CARD_H;
              const sel = selection.has(id);
              const onMap = view === 'graph';
              return (
                <div
                  key={id}
                  data-map-node={id}
                  data-context-target=""
                  ref={(el) => {
                    const ro = roRef.current!;
                    const prev = cardRefsMap.current.get(id);
                    if (prev && prev !== el) {
                      ro.unobserve(prev);
                      const prevHead = prev.querySelector('[data-map-card-head]');
                      if (prevHead) ro.unobserve(prevHead);
                    }
                    if (el) {
                      cardRefsMap.current.set(id, el);
                      ro.observe(el);
                      const head = el.querySelector('[data-map-card-head]');
                      if (head) ro.observe(head);
                    } else {
                      cardRefsMap.current.delete(id);
                    }
                  }}
                  onMouseEnter={onMap ? () => setHoveredId(id) : undefined}
                  onMouseLeave={onMap ? () => setHoveredId((h) => (h === id ? null : h)) : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) {
                      toggleSelection(id);
                    } else {
                      toggleExpanded(id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, targetId: id });
                  }}
                  style={{
                    position: 'absolute',
                    left: pos.x - w / 2,
                    top: pos.y - h / 2,
                    width: w,
                    // Animation #2: when expand/collapse reflows the layout, each
                    // card slides to its new position instead of jumping. Keep
                    // the expanded card (and the hovered one) above neighbors so
                    // any transient overlap during the slide reads cleanly.
                    // Hover/expand raises above neighbors so content reads
                    // cleanly during animated reflows.
                    zIndex: exp ? 'var(--z-sticky)' : hoveredId === id ? 'var(--z-raised)' : undefined,
                    transition: 'top var(--t-enter) cubic-bezier(.4,0,.2,1), left var(--t-enter) cubic-bezier(.4,0,.2,1)',
                    outline: sel ? '2px solid var(--term-select)' : undefined,
                    outlineOffset: 2,
                  }}
                >
                  <MapCard
                    node={n}
                    ribbon={branchRibbonText(n)}
                    now={nowTs}
                    expanded={exp}
                    unread={isNodeUnread(n, null)}
                    anc={ancestorSet != null && ancestorSet.has(id)}
                    dim={ancestorSet != null && !ancestorSet.has(id) && !(mergeHighlightSet != null && mergeHighlightSet.has(id))}
                    grow={growIds.has(id)}
                    isMain={id === rootNodeId}
                    isMerge={!!(n.mergeSources && n.mergeSources.length > 0)}
                    mergeSource={mergeHighlightSet != null && mergeHighlightSet.has(id) && id !== hoveredId}
                    onOpenPane={() => {
                      openPane(id);
                      if (n.kind === 'digest' && digestEnabled) {
                        requestDigestFocus(id);
                        onNav?.('digest');
                      } else {
                        onNav?.('dashboard');
                      }
                    }}
                  />
                </div>
              );
            })}
            </div>
        </div>

        {/* Floating zoom pill — graph view only, bottom-right. */}
        <ZoomPill camera={camera} />

        {selectedMapIds.length > 0 && (
          <MapSelectionBar
            count={selectedMapIds.length}
            names={selectedMapIds.map((id) => nodesSnapshot[id]?.title || id)}
            state={selectionState}
            onMerge={mergeSelection}
            onDigest={digestEnabled ? digestSelection : undefined}
            onExport={() => exportNodes(selectedMapIds)}
            onClear={clearSelection}
          />
        )}
      </div>
      )}
      <AnimatePresence>{menu && view === 'graph' && activeProject && (
        <ContextMenu
          key={menuOpenKey(menu)}
          x={menu.x}
          y={menu.y}
          sections={buildTreeContextMenu({
            project: activeProject,
            nodes: nodesSnapshot,
            targetId: menu.targetId,
            selection: new Set(selectedMapIds),
            rules: MAP_SELECTION_RULES,
            digestEnabled,
            actions: {
              openPane,
              createBlankChild,
              toggleSelection,
              clearSelection,
              deleteNode,
              trimNode,
              extractNodeTree: async (id) => {
                if (await extractNodeTree(id)) onNav?.('dashboard');
              },
              archiveNode,
              createMergedChat,
              createDigest,
              openExportPanel: exportNodes,
              archiveTree,
              focusOrOpen: (id) => {
                openPane(id);
                // After Weave / digest creation we want to land in the chat
                // view, not stay on the map — the user just kicked off a new
                // thread and the next action belongs in dashboard.
                onNav?.('dashboard');
              },
              pinNode,
              unpinNode,
            },
          })}
          onClose={() => setMenu(null)}
        />
      )}</AnimatePresence>
    </MapFrame>
  );
}

function ZoomPill({ camera }: { camera: MapCameraController }) {
  // Subscribes to the camera store so pinching re-renders only this pill.
  const { k: zoom, auto } = useCameraSnapshot(camera);
  const onZoomIn = camera.zoomIn;
  const onZoomOut = camera.zoomOut;
  const onFit = camera.fit;
  const btn = 't-icon-btn';
  const btnStyle: React.CSSProperties = {
    width: 28, height: 28, display: 'grid', placeItems: 'center',
    fontSize: 'var(--fs-xl)', fontFamily: 'var(--message-code-font)', color: 'var(--term-mid)',
  };
  return (
    <div
      style={{
        position: 'absolute', right: 18, bottom: 18,
        display: 'flex', alignItems: 'center',
        background: GLASS_BG,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: GLASS_BORDER,
        boxShadow: GLASS_SHADOW,
      }}
    >
      <button type="button" className={btn} style={btnStyle} onClick={onZoomOut} title="zoom out">−</button>
      <span style={{
        fontFamily: 'var(--message-code-font)', fontSize: 'var(--fs-sm)', color: 'var(--term-fg)',
        minWidth: 40, textAlign: 'center',
      }}>{Math.round(zoom * 100)}%</span>
      <button type="button" className={btn} style={btnStyle} onClick={onZoomIn} title="zoom in">+</button>
      <button
        type="button"
        className={`t-text-btn${auto ? ' is-active' : ''}`}
        onClick={onFit}
        title="fit map to the visible area"
        style={{
          borderLeft: GLASS_BORDER, borderRadius: 0,
          fontFamily: 'var(--message-code-font)', fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps)',
        }}
      >FIT</button>
    </div>
  );
}

export function MapSelectionBar({
  count,
  names,
  state,
  onMerge,
  onDigest,
  onExport,
  onClear,
}: {
  count: number;
  names: string[];
  state: SelectionActionState;
  onMerge: () => void;
  /** Absent while Settings › Digest is off; the Digest action is not shown. */
  onDigest?: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const actionStyle = (enabled: boolean): React.CSSProperties => ({
    border: '1px solid color-mix(in srgb, var(--term-surface) 42%, transparent)',
    background: enabled ? 'var(--term-surface)' : 'transparent',
    color: enabled ? 'var(--term-fg)' : 'var(--term-faint)',
    padding: '3px 9px',
    font: 'inherit',
    fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.62,
  });
  const { canWeave: canMerge, canDigest } = state;
  const digestTitle = state.digestReason ?? 'Create a digest from the selected nodes.';
  const mergeTitle = state.weaveReason ?? 'Merge selected nodes into a new thread.';

  return (
    <div
      role="toolbar"
      aria-label="Map selection actions"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 14,
        background: 'var(--term-fg)',
        color: 'var(--term-surface)',
        padding: '8px 10px 8px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 'var(--fs-md)',
        boxShadow: '0 8px 24px color-mix(in srgb, var(--term-fg) 22%, transparent)',
      }}
    >
      <span
        style={{
          background: 'var(--term-select)',
          color: 'var(--term-fg)',
          padding: '2px 8px',
          fontWeight: 700,
        }}
      >
        {count}
      </span>
      <span style={{ letterSpacing: 'var(--ls-wide)' }}>SELECTED</span>
      <span style={{ color: 'var(--term-faint)' }}>·</span>
      <span
        title={names.join(', ')}
        style={{
          fontFamily: 'var(--ui-font)',
          color: 'var(--term-alt)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {names.join(', ')}
      </span>
      <button type="button" disabled={!canMerge} title={mergeTitle} onClick={onMerge} style={actionStyle(canMerge)}>
        Merge
      </button>
      {onDigest && (
        <button type="button" disabled={!canDigest} title={digestTitle} onClick={onDigest} style={actionStyle(canDigest)}>
          Digest
        </button>
      )}
      <button type="button" onClick={onExport} style={actionStyle(true)}>
        Export
      </button>
      <button type="button" onClick={onClear} style={actionStyle(true)}>
        Clear
      </button>
    </div>
  );
}

/** The Map page canvas frame: the paper field behind whichever view is active,
 *  plus the floating Graph/Timeline/Doc switcher anchored top-right — sitting
 *  just under the Topbar's icon row (back / MAP / title stay in the Topbar). */
function MapFrame({
  children,
  view,
  setView,
}: {
  children: React.ReactNode;
  view: MapView;
  setView: (view: MapView) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        background: 'color-mix(in srgb, var(--term-bg) 60%, var(--term-surface))',
        overflow: 'hidden',
      }}
    >
      <div
        role="tablist"
        aria-label="Map views"
        style={{
          position: 'absolute',
          top: 8,
          right: 14,
          zIndex: 'var(--z-pane-overlay)',
          display: 'flex',
          background: GLASS_BG,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: GLASS_BORDER,
          boxShadow: GLASS_SHADOW,
          padding: 2,
        }}
      >
        {MAP_VIEWS.map((v) => {
          const active = v === view;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(v)}
              style={{
                border: 'none',
                padding: '4px 14px',
                fontFamily: 'var(--ui-font)',
                fontSize: 'var(--fs-md)',
                color: active ? 'var(--term-bg)' : 'var(--term-mid)',
                background: active ? 'var(--term-fg)' : 'transparent',
                fontWeight: active ? 600 : 450,
                cursor: active ? 'default' : 'pointer',
                transition: 'background var(--t-enter)',
              }}
            >
              {MAP_VIEW_LABELS[v]}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}
