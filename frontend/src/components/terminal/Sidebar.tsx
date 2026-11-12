import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, type MotionValue } from 'motion/react';
import { SidebarContentPrefsProvider, usePrefs } from '../../state/prefs';
import { DUR, EASE, TRANSITION } from '../../motion/tokens';
import { PROFILE_PAGE_ENABLED } from '../../state/featureFlags';
import { Row } from './primitives';
import WorkspaceTree from './WorkspaceTree';
import ActivityView from './ActivityView';
import TreeSelectionBar from './TreeSelectionBar';
import ResizeHandle from '../ResizeHandle';
import { rowGeom, rowPadding, spinePadding, WORKSPACE_ICON_SIZE, WORKSPACE_ICON_GAP, type RowGeom } from './sidebarRowStyle';
import './sidebar.css';
import { AgentIcon, UserIcon } from './icons';
import {
  SidebarConnectionChip,
  SidebarNewChatRow,
  SidebarViewPanel,
  SidebarViewTabs,
  useSidebarViewTabsId,
} from './sidebar/SidebarChrome';
import type { PageId } from '../../state/commands';
import { AREA_RAIL_WIDTH } from './rail/AreaRail';

// Rail + sidebar must cover the Topbar Zone 1 button cluster so drag-resizing
// can't push the left chrome narrower than its header icons (Topbar.tsx
// zone1WidthFor: 250px for its five buttons). 280px held the old six-button
// cluster.
const MIN_SIDEBAR_WIDTH = 280 - AREA_RAIL_WIDTH;
const MAX_SIDEBAR_WIDTH = 400;
const DEFAULT_SIDEBAR_WIDTH = 252;
const OVERLAY_WIDTH = 'min(85vw, 340px)';

/** The Topbar's Zone 1 width: the area rail plus the sidebar. */
function setRootSidebarWidth(sidebarWidth: number) {
  document.documentElement.style.setProperty('--term-sidebar-width', `${sidebarWidth + AREA_RAIL_WIDTH}px`);
}

/** OVERLAY_WIDTH in px, for a drag that starts before the drawer is on screen. */
export function narrowOverlayWidth(): number {
  return Math.min(window.innerWidth * 0.85, 340);
}

/**
 * A swipe moving the phone drawer: while `active`, the drawer and its scrim
 * sit where these values put them (the finger), not where their own
 * animation would. The values drive both at all times.
 */
interface NarrowOverlayDrag {
  x: MotionValue<number | string>;
  scrim: MotionValue<number>;
  active: boolean;
}

/** Sidebar scrollbars appear on pointer/focus entry, then linger this long. */
const SCROLLBAR_LINGER_MS = 2000;
/** Fallback settle if the width transitionend never fires (reduced motion,
 *  an interrupted transition, or a browser that skips the event). The
 *  authoritative clock is the transition itself (`--t-enter`, 180ms). */
const SIDEBAR_SETTLE_FALLBACK_MS = 260;
/** The phone drawer slides back out a little faster than it came in; the scrim
 *  clears just before the panel is gone. */
const OVERLAY_PANEL_EXIT = TRANSITION.collapse;
const OVERLAY_SCRIM_EXIT = { duration: DUR.scrimExit, ease: EASE.out };

/** Sidebar row density → the `--sb-*` CSS vars consumed by WorkspaceRow /
 *  ThreadRow / BranchRow / merge rows / BottomNav. `compact` reproduces the
 *  historical hardcoded values, so those live on as the var fallbacks too. */
const SIDEBAR_DENSITY: Record<
  'compact' | 'comfortable' | 'airy',
  { fs: string; rowPy: number; wsGap: number; tsFs: string; navPy: number }
> = {
  compact: { fs: 'var(--fs-xl)', rowPy: 4, wsGap: 6, tsFs: 'var(--fs-sm)', navPy: 6 },
  comfortable: { fs: 'var(--fs-xl)', rowPy: 6, wsGap: 10, tsFs: 'var(--fs-sm)', navPy: 7 },
  airy: { fs: 'var(--fs-xl)', rowPy: 8, wsGap: 14, tsFs: 'var(--fs-md)', navPy: 8 },
};

export default function TerminalSidebar({
  activePage,
  workspaceReady = true,
  customAgentsEnabled = false,
  onNav,
  onOpenPalette,
  onNewThread,
  areaContent,
  narrowMode = false,
  narrowOverlayOpen = false,
  onCloseOverlay,
  overlayHeader,
  overlayDrag,
  onOverlayChoice,
}: {
  activePage: PageId;
  workspaceReady?: boolean;
  customAgentsEnabled?: boolean;
  onNav: (p: PageId) => void;
  /** The narrow drawer's Search button (⌘K). Wide windows keep it in the Topbar. */
  onOpenPalette?: () => void;
  /** The narrow drawer's New chat button (⌘T): opens Home. Wide windows keep it in the Topbar. */
  onNewThread?: () => void;
  /** Sidebar body for the Spaces, Scheduled and Settings areas; the conversation tree when omitted. */
  areaContent?: React.ReactNode;
  narrowMode?: boolean;
  narrowOverlayOpen?: boolean;
  onCloseOverlay?: () => void;
  /** First row of the narrow overlay; narrow windows have no area rail. */
  overlayHeader?: React.ReactNode;
  overlayDrag?: NarrowOverlayDrag;
  /** A click or Enter/Space inside the phone drawer: what it opens is a root (TerminalShell). */
  onOverlayChoice?: () => void;
}) {
  const { prefs, setPref } = usePrefs();
  const asideRef = useRef<HTMLElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  // Scrollbars are a pointer affordance: quiet while the pointer is elsewhere,
  // visible on entry, and held for a short linger after leaving so crossing the
  // sidebar edge (or a portalled menu) does not make the bar blink.
  const [scrollbarsQuiet, setScrollbarsQuiet] = useState(true);
  const scrollbarTimer = useRef<number | undefined>(undefined);
  const showScrollbars = useCallback(() => {
    if (scrollbarTimer.current !== undefined) {
      window.clearTimeout(scrollbarTimer.current);
      scrollbarTimer.current = undefined;
    }
    setScrollbarsQuiet(false);
  }, []);
  const quietScrollbarsSoon = useCallback(() => {
    if (scrollbarTimer.current !== undefined) window.clearTimeout(scrollbarTimer.current);
    scrollbarTimer.current = window.setTimeout(() => {
      scrollbarTimer.current = undefined;
      setScrollbarsQuiet(true);
    }, SCROLLBAR_LINGER_MS);
  }, []);
  useEffect(() => () => {
    if (scrollbarTimer.current !== undefined) window.clearTimeout(scrollbarTimer.current);
  }, []);
  // The shell passes fresh handlers on every render; the rows hold stable ones
  // so the memoised contents below are not rebuilt by a render that changed nothing.
  const newThreadRef = useRef(onNewThread);
  newThreadRef.current = onNewThread;
  const openPaletteRef = useRef(onOpenPalette);
  openPaletteRef.current = onOpenPalette;
  const closeOverlayRef = useRef(onCloseOverlay);
  closeOverlayRef.current = onCloseOverlay;
  const hasNewThread = !!onNewThread;
  const hasPalette = !!onOpenPalette;
  const newThread = useCallback(() => newThreadRef.current?.(), []);
  // Only the drawer shows this Search, and it closes itself first.
  const openPalette = useCallback(() => { closeOverlayRef.current?.(); openPaletteRef.current?.(); }, []);
  const contents = useMemo(
    () => <>
      {/* The drawer's scrim covers the Topbar's New chat and Search, so the
          drawer carries its own. A wide sidebar leaves them to the Topbar. */}
      {narrowMode && (
        <SidebarNewChatRow
          onNewChat={hasNewThread ? newThread : undefined}
          onOpenPalette={hasPalette ? openPalette : undefined}
          searchDisabled={!workspaceReady}
        />
      )}
      {areaContent ?? <SidebarContents activePage={activePage} workspaceReady={workspaceReady} customAgentsEnabled={customAgentsEnabled} onNav={onNav} />}
      <SidebarConnectionChip />
    </>,
    [areaContent, activePage, workspaceReady, customAgentsEnabled, onNav, narrowMode, hasNewThread, hasPalette, newThread, openPalette],
  );

  // A drag keeps its width here and saves it to prefs once, on release: a pref
  // write re-renders every prefs consumer (the chat store, every sidebar row),
  // which is far too much work for every frame of a drag.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  // Clamp persisted width to current MIN so legacy narrower values auto-correct.
  const effectiveWidth = dragWidth ?? Math.max(prefs.terminalSidebarWidth, MIN_SIDEBAR_WIDTH);
  useEffect(() => {
    // During a drag the width goes to the Topbar's spacer alone (onResize): a
    // custom property set on the root restyles the whole document.
    if (dragWidth != null) return;
    // The Topbar's Zone 1 spans the area rail and the sidebar.
    setRootSidebarWidth(effectiveWidth);
    // Persist the correction so we don't recompute every render.
    if (prefs.terminalSidebarWidth < MIN_SIDEBAR_WIDTH) {
      setPref('terminalSidebarWidth', MIN_SIDEBAR_WIDTH);
    }
  }, [dragWidth, effectiveWidth, prefs.terminalSidebarWidth, setPref]);

  // Broadcast the width animation window so panes can pause ResizeObserver
  // reflows. The width transition itself is the clock; a fallback timer only
  // covers a skipped transitionend. Skip the very first render so mount does
  // not look like a toggle.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    if (narrowMode) return; // the overlay slides over the panes; they don't reflow
    const el = asideRef.current;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.dispatchEvent(
        new CustomEvent('michi:sidebar-animating', { detail: { animating: false } }),
      );
    };
    window.dispatchEvent(
      new CustomEvent('michi:sidebar-animating', { detail: { animating: true } }),
    );
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === el && event.propertyName === 'width') finish();
    };
    el?.addEventListener('transitionend', onTransitionEnd);
    const fallback = window.setTimeout(finish, SIDEBAR_SETTLE_FALLBACK_MS);
    return () => {
      el?.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(fallback);
    };
  }, [prefs.sidebarCollapsed, narrowMode]);

  // A destination chosen inside the phone drawer (a thread, a page, an area)
  // closes it at once: what it opens takes the screen, and a drawer sliding
  // out over it would leave a second copy of the list for the length of the
  // slide. Dismissing it (scrim, Esc, swipe, the ≡ button) slides it out.
  // The shell closes the drawer within the choosing click or key, so a mark
  // that lasts until the next task covers exactly that close.
  const choseInDrawerRef = useRef(false);
  const onOverlayChoiceRef = useRef(onOverlayChoice);
  onOverlayChoiceRef.current = onOverlayChoice;
  const noteChoice = useCallback(() => {
    choseInDrawerRef.current = true;
    onOverlayChoiceRef.current?.();
    window.setTimeout(() => { choseInDrawerRef.current = false; }, 0);
  }, []);
  const noteKeyChoice = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') noteChoice();
  }, [noteChoice]);

  // In narrow mode the sidebar is an overlay drawer, or nothing at all while it
  // is closed: no sliver, no hit target. The Topbar's ≡ button drives
  // narrowOverlayOpen; closing slides the drawer out (NarrowSidebarOverlay).
  const overlayMode = narrowMode;
  // Wide mode + collapsed: keep mounted at width 0 so the open/close transition
  // can actually play. Suppress border + interactivity while collapsed so it
  // behaves like the previous unmounted state visually.
  const collapsed = !narrowMode && prefs.sidebarCollapsed;

  const d = SIDEBAR_DENSITY[prefs.sidebarDensity];
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);
  const densityVars = {
    '--sb-fs': d.fs,
    '--sb-row-py': `${d.rowPy}px`,
    '--sb-ws-gap': `${d.wsGap}px`,
    '--sb-ts-fs': d.tsFs,
    '--sb-nav-py': `${d.navPy}px`,
    // Area sidebars use the same text/icon columns and density as Chat.
    '--sb-icon-size': `${WORKSPACE_ICON_SIZE}px`,
    '--sb-icon-gap': `${WORKSPACE_ICON_GAP}px`,
    '--sb-area-left': geom.isCard ? rowPadding(geom).paddingLeft : `calc(6px + var(--sb-inset))`,
    '--sb-area-right': geom.isCard ? rowPadding(geom).paddingRight : `calc(10px + var(--sb-inset))`,
    '--sb-row-pb': geom.isCard ? 'calc(var(--sb-row-py) + 1px)' : 'var(--sb-row-py)',
    '--sb-indent-step': `${geom.indentStep}px`,
    '--sb-workspace-weight': geom.workspaceAsHeader ? 500 : 450,
    '--sb-nav-left': geom.isCard ? rowPadding(geom).paddingLeft : 'calc(12px + var(--sb-inset))',
    '--sb-nav-right': geom.isCard ? rowPadding(geom).paddingRight : 'calc(12px + var(--sb-inset))',
    '--sb-nav-gap': geom.isCard ? '9px' : '11px',
    '--sb-nav-weight': geom.isCard ? 500 : 400,
    '--sb-section-padding': geom.isCard
      ? `0 ${spinePadding(geom, geom.rightGap)} 5px ${spinePadding(geom, geom.titleX)}`
      : 'var(--sb-row-py, 5px) 10px var(--sb-row-py, 4px) 6px',
    '--sb-section-top': geom.isCard ? '18px' : '8px',
    // Where a section label's text starts and ends, measured from the
    // sidebar's own edges: the sidebar's first row and view tabs sit outside
    // the list's inset container and line up on these.
    '--sb-spine-left': geom.isCard ? `${geom.titleX}px` : 'calc(6px + var(--sb-inset))',
    '--sb-spine-right': geom.isCard ? `${geom.rightGap}px` : 'calc(10px + var(--sb-inset))',
    // Horizontal gutter between sidebar content and its edges. Applied as
    // padding on the scrollable tree + bottom nav (below), so it stacks on
    // top of each row's own left/right padding. 0 = flush (original look).
    // Comes from `geom` so the card modes can pin their own value.
    '--sb-inset': `${geom.inset}px`,
    // How far each row's box is pulled back OUT past that gutter. `classic`
    // cancels it entirely (full-bleed, so its left accent bar hugs the true
    // edge); the card modes keep rows inside the gutter. index.css's
    // `.terminal-sidebar .t-row-hover` negative margin reads this, NOT
    // --sb-inset — that's what makes one rule serve both looks.
    '--sb-bleed': `${geom.bleed}px`,
    // Card rows round with the Corner radius pref (--ui-radius-lg); flat modes stay 0.
    '--sb-radius': geom.radius > 0 ? 'var(--ui-radius-lg)' : '0px',
  } as React.CSSProperties;

  const asideStyle: React.CSSProperties = {
    ...densityVars,
    // A phone drawer is a share of the screen, not the desktop column width.
    width: overlayMode ? OVERLAY_WIDTH : (collapsed ? 0 : effectiveWidth),
    flexShrink: 0,
    background: 'var(--term-sidebar-body-bg, var(--term-sidebar-bg, var(--term-surface)))',
    border: 'var(--term-sidebar-outline, none)',
    borderRight: overlayMode
      ? '1px solid var(--term-line)'
      : 'var(--term-sidebar-edge, 1px solid color-mix(in srgb, var(--term-line) 50%, transparent))',
    borderRadius: 'var(--term-sidebar-radius, 0px)',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'var(--ui-font)',
    color: 'var(--term-fg)',
    position: overlayMode ? 'absolute' : 'relative',
    left: overlayMode ? 0 : undefined,
    top: overlayMode ? 0 : undefined,
    bottom: overlayMode ? 0 : undefined,
    // z-index 1 in non-overlay mode lifts the sidebar (and its right-edge
    // box-shadow) above sibling pane content, which otherwise paints its
    // own surface bg over the 8px shadow extension and hides the glow.
    zIndex: overlayMode ? 'var(--z-sidebar-overlay)' : 'var(--z-raised)',
    boxShadow: overlayMode
      ? '4px 0 24px rgba(0,0,0,0.18)'
      : 'var(--term-sidebar-shadow, 2px 0 6px rgba(0,0,0,0.025))',
    // Clip the box-shadow's upward feather (top: 0) so it doesn't bleed
    // into the Topbar Zone 1 spacer above and create a visible horizontal
    // joint. Right/bottom are extended past the element so the right glow
    // and bottom feather still render. Overlay mode keeps its own halo.
    clipPath: overlayMode ? undefined : 'inset(0 -8px -8px 0)',
    height: '100%',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    overflow: 'hidden',
    // The overlay's slide is NarrowSidebarOverlay's (motion), not a CSS one.
    transition: overlayMode || isResizing
      ? 'none'
      : collapsed
        ? 'width var(--t-enter) cubic-bezier(.4,0,1,1)'
        : 'width var(--t-enter) cubic-bezier(0,0,.2,1)',
  };
  const scrollbarHandlers = {
    onPointerEnter: showScrollbars,
    onPointerLeave: quietScrollbarsSoon,
    onFocusCapture: showScrollbars,
    onBlurCapture: quietScrollbarsSoon,
  };
  const body = (
    <div
      className="terminal-sidebar-content"
      aria-hidden={collapsed || undefined}
      inert={collapsed}
      style={{
        // Only the shell changes width during a toggle; rows never squeeze.
        width: overlayMode ? '100%' : effectiveWidth,
        flex: '1 0 0',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {overlayMode && overlayHeader}
      <SidebarContentPrefsProvider>{contents}</SidebarContentPrefsProvider>
    </div>
  );

  if (overlayMode) {
    // Closed by a choice inside it: unmount now, with no exit (see choseInDrawerRef).
    if (!narrowOverlayOpen && choseInDrawerRef.current) return null;
    return (
      <AnimatePresence>
        {narrowOverlayOpen && (
          <NarrowSidebarOverlay
            key="overlay"
            asideRef={asideRef}
            rowStyle={geom.style}
            scrollbars={scrollbarsQuiet ? 'quiet' : 'visible'}
            style={asideStyle}
            handlers={{ ...scrollbarHandlers, onClickCapture: noteChoice, onKeyDownCapture: noteKeyChoice }}
            onClose={onCloseOverlay}
            drag={overlayDrag}
          >
            {body}
          </NarrowSidebarOverlay>
        )}
      </AnimatePresence>
    );
  }

  return (
    <aside
      ref={asideRef}
      className="terminal-sidebar"
      data-row-style={geom.style}
      data-scrollbars={scrollbarsQuiet ? 'quiet' : 'visible'}
      data-collapsed={collapsed || undefined}
      style={asideStyle}
      {...scrollbarHandlers}
    >
      {body}
      {!collapsed && (
        <ResizeHandle
          paneRef={asideRef}
          min={MIN_SIDEBAR_WIDTH}
          onResize={(w) => {
            const next = Math.min(MAX_SIDEBAR_WIDTH, w);
            dragWidthRef.current = next;
            setDragWidth(next);
            window.dispatchEvent(
              new CustomEvent('michi:sidebar-resizing', {
                detail: { resizing: true, width: next + AREA_RAIL_WIDTH },
              }),
            );
          }}
          onReset={() => setPref('terminalSidebarWidth', DEFAULT_SIDEBAR_WIDTH)}
          onResizeStart={() => {
            setIsResizing(true);
            window.dispatchEvent(
              new CustomEvent('michi:sidebar-resizing', { detail: { resizing: true } }),
            );
          }}
          onResizeEnd={() => {
            // Same batch as clearing dragWidth, so the width never flashes back.
            // The root value is set first: the Topbar drops its own copy below.
            const final = dragWidthRef.current;
            if (final != null) {
              setRootSidebarWidth(final);
              setPref('terminalSidebarWidth', final);
            }
            dragWidthRef.current = null;
            setDragWidth(null);
            setIsResizing(false);
            window.dispatchEvent(
              new CustomEvent('michi:sidebar-resizing', { detail: { resizing: false } }),
            );
          }}
        />
      )}
    </aside>
  );
}

/** What a drag from `target` scrolls in the drawer: the nearest element that scrolls and has more than it shows. */
function drawerScroller(target: EventTarget | null, drawer: HTMLElement): HTMLElement | null {
  for (let el = target instanceof Element ? target : null; el && drawer.contains(el); el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const style = getComputedStyle(el);
    if ((/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight)
      || (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth)) return el;
  }
  return null;
}

/** A touch on selected text, or on a rename field with a selection, is dragging the selection's handles. */
function adjustsSelection(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.containsNode(target, true)) return true;
  return (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && document.activeElement === target
    && (target.selectionStart ?? 0) < (target.selectionEnd ?? 0);
}

/**
 * The phone drawer and its scrim. Opening slides the panel in from the left
 * edge; a dismissal slides it back out while the scrim clears (a destination
 * chosen inside it unmounts it at once, TerminalSidebar). A drawer on its
 * way out is no longer a layer: it drops `data-escape-layer` (Esc routing,
 * escapeLayers.ts), leaves the accessibility tree, takes no focus or taps, and
 * its scrim no longer closes anything. Reopening mid-exit turns it around.
 */
function NarrowSidebarOverlay({
  asideRef,
  rowStyle,
  scrollbars,
  style,
  handlers,
  onClose,
  drag,
  children,
}: {
  asideRef: React.RefObject<HTMLElement | null>;
  rowStyle: string;
  scrollbars: 'quiet' | 'visible';
  style: React.CSSProperties;
  handlers: Pick<React.HTMLAttributes<HTMLElement>, 'onPointerEnter' | 'onPointerLeave' | 'onFocusCapture' | 'onBlurCapture' | 'onClickCapture' | 'onKeyDownCapture'>;
  onClose?: () => void;
  drag?: NarrowOverlayDrag;
  children: React.ReactNode;
}) {
  const present = useIsPresent();
  const dragging = !!drag?.active;
  // A drag in the drawer layer scrolls only a drawer list with more than it
  // shows. One anywhere else (the scrim, the area tabs, the bottom rows, a
  // list too short to scroll) is cancelled, so nothing behind it moves; iOS
  // would otherwise scroll what is under the drawer. React Aria's
  // usePreventScroll uses the same rule. Native and non-passive: React's
  // touch listeners are passive and cannot cancel a scroll. The shell's
  // swipe-to-close listens on window and still sees every move.
  const scrimRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scrim = scrimRef.current;
    const aside = asideRef.current;
    if (!scrim || !aside) return;
    let scroller: HTMLElement | null = null;
    let keepMove = false;
    const onStart = (event: TouchEvent) => {
      scroller = drawerScroller(event.target, aside);
      keepMove = adjustsSelection(event.target);
    };
    const onMove = (event: TouchEvent) => {
      if (keepMove || event.touches.length > 1 || !event.cancelable) return; // pinch zoom stays
      // overscroll-behavior does not hold a list that does not overflow
      // (https://bugs.webkit.org/show_bug.cgi?id=243452), so check again here.
      if (!scroller || (scroller.scrollHeight <= scroller.clientHeight && scroller.scrollWidth <= scroller.clientWidth)) {
        event.preventDefault();
      }
    };
    const options = { passive: false } as const;
    for (const layer of [scrim, aside]) {
      layer.addEventListener('touchstart', onStart, options);
      layer.addEventListener('touchmove', onMove, options);
    }
    return () => {
      for (const layer of [scrim, aside]) {
        layer.removeEventListener('touchstart', onStart);
        layer.removeEventListener('touchmove', onMove);
      }
    };
  }, [asideRef]);
  return (
    <>
      <motion.div
        ref={scrimRef}
        onMouseDown={present ? onClose : undefined}
        initial={{ opacity: 0 }}
        animate={dragging ? undefined : { opacity: 1 }}
        exit={{ opacity: 0, transition: OVERLAY_SCRIM_EXIT }}
        transition={TRANSITION.enter}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.32)',
          zIndex: 'var(--z-sidebar-scrim)',
          pointerEvents: present ? undefined : 'none',
          opacity: drag?.scrim,
        }}
      />
      <motion.aside
        ref={asideRef}
        className="terminal-sidebar"
        data-row-style={rowStyle}
        // The narrow overlay closes on any Esc: a layer under the ⌘J panel
        // ("shell"), which its Esc yields to when the page has focus.
        data-escape-layer={present ? 'shell' : undefined}
        data-scrollbars={scrollbars}
        aria-hidden={present ? undefined : true}
        inert={!present}
        initial={{ x: '-100%' }}
        animate={dragging ? undefined : { x: 0 }}
        exit={{ x: '-100%', transition: OVERLAY_PANEL_EXIT }}
        transition={TRANSITION.enter}
        style={{ ...style, pointerEvents: present ? undefined : 'none', x: drag?.x }}
        {...handlers}
      >
        {children}
      </motion.aside>
    </>
  );
}

function SidebarContents({ activePage, workspaceReady, customAgentsEnabled, onNav }: {
  activePage: PageId;
  workspaceReady: boolean;
  customAgentsEnabled: boolean;
  onNav: (p: PageId) => void;
}) {
  const { prefs } = usePrefs();
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);
  const tabsId = useSidebarViewTabsId();
  const onActivate = React.useCallback(() => onNav('dashboard'), [onNav]);
  const onOpenWorkspaces = React.useCallback(() => onNav('workspaces'), [onNav]);
  return <>
    {!workspaceReady ? (
      <div aria-hidden="true" style={{ flex: 1, padding: '18px 16px' }}>
        {[72, 88, 60].map((width) => (
          <div key={width} style={{ width: `${width}%`, height: 12, marginBottom: 18, borderRadius: 'var(--ui-radius-sm)', background: 'var(--term-line)' }} />
        ))}
      </div>
    ) : <>
    {/* Above the list's scroller, so the tabs stay put while the list scrolls. */}
    <SidebarViewTabs id={tabsId} />
    <TreeSelectionBar />
    <SidebarViewPanel tabsId={tabsId}>
      {prefs.sidebarView === 'activity' ? (
        <ActivityView onActivate={onActivate} chatViewActive={activePage === 'dashboard'} />
      ) : (
        <WorkspaceTree
          onActivate={onActivate}
          chatViewActive={activePage === 'dashboard'}
          onOpenWorkspaces={onOpenWorkspaces}
          workspacesPageOpen={activePage === 'workspaces'}
        />
      )}
    </SidebarViewPanel>
    </>}
    <BottomNav activePage={activePage} customAgentsEnabled={customAgentsEnabled} onNav={onNav} geom={geom} />
  </>;
}

interface BottomNavItemProps {
  activePage: PageId;
  onNav: (p: PageId) => void;
  geom: RowGeom;
  /** Page this row navigates to. Omit for action rows (drawers) that use onClick. */
  id?: PageId;
  glyph: React.ReactNode;
  label: string;
  kbd?: string;
  badge?: number;
  /** `pill` is the filled count chip; `count` / `accent` are bare mono numbers (Michi totals). */
  badgeVariant?: 'pill' | 'count' | 'accent';
  /** Overrides page-nav; used by drawer toggles (e.g. Artifacts). */
  onClick?: () => void;
}

/** One BottomNav row. Module-scoped so rows keep their identity across re-renders. */
function BottomNavItem({
  activePage,
  onNav,
  geom,
  id,
  glyph,
  label,
  kbd,
  badge,
  badgeVariant = 'pill',
  onClick,
}: BottomNavItemProps) {
  const active = id !== undefined && activePage === id;
  const go = () => (onClick ? onClick() : id !== undefined && onNav(id));
  return (
    // A button to the keyboard and screen readers (Tab, Enter, Space), with the row's look.
    <Row
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      className="t-row-focus"
      onClick={go}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        go();
      }}
      active={active}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: geom.isCard ? 9 : 11,
        // Classic: text/icons indent by --sb-inset while the row box stays
        // full-bleed (its negative margin cancels the container padding), so
        // the active background reads as a full-width highlight. See index.css.
        // Card modes: geometry comes from rowGeom so the glyph lands on the
        // same icon column the thread rows use.
        padding: geom.isCard
          ? `var(--sb-nav-py, 6px) ${rowPadding(geom).paddingRight} var(--sb-nav-py, 6px) ${rowPadding(geom).paddingLeft}`
          : 'var(--sb-nav-py, 6px) calc(12px + var(--sb-inset, 0px))',
        color: active ? 'var(--term-fg)' : 'var(--term-mid)',
        background: active ? 'var(--term-alt)' : 'transparent',
        fontSize: geom.isCard ? 'var(--sb-fs, var(--fs-xl))' : 14,
        fontWeight: geom.isCard ? 500 : undefined,
        fontFamily: 'var(--ui-font)',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          color: active ? 'var(--term-accent)' : 'var(--term-muted)',
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {glyph}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && badge > 0 && badgeVariant !== 'pill' && (
        <span
          data-badge={badgeVariant}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-sm)',
            fontVariantNumeric: 'tabular-nums',
            color: badgeVariant === 'accent' ? 'var(--term-accent)' : 'var(--term-muted)',
          }}
        >
          {badge}
        </span>
      )}
      {badge !== undefined && badge > 0 && badgeVariant === 'pill' && (
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--term-surface)',
            background: 'var(--term-muted)',
            padding: '0 5px',
            minWidth: 16,
            textAlign: 'center',
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      )}
      {kbd && (
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--term-muted)',
          }}
        >
          {kbd}
        </span>
      )}
    </Row>
  );
}

function BottomNav({
  activePage,
  customAgentsEnabled,
  onNav,
  geom,
}: {
  activePage: PageId;
  customAgentsEnabled: boolean;
  onNav: (p: PageId) => void;
  geom: RowGeom;
}) {
  // Home is the logo, ⌘0 and New chat; Workspaces is By project's "All N ›"
  // and ⌘O. What is left here are the optional pages.
  const nav = { activePage, onNav, geom };
  if (!customAgentsEnabled && !PROFILE_PAGE_ENABLED) return null;

  return (
    // The phone drawer draws a hairline over it and fades the list into it (sidebar.css).
    <div
      className="sidebar-bottom-nav"
      style={{
        padding: '6px var(--sb-inset, 0px)',
        flexShrink: 0,
      }}
    >
      {customAgentsEnabled && (
        <BottomNavItem {...nav} id="agents" glyph={<AgentIcon size={15} />} label="Agents" />
      )}
      {PROFILE_PAGE_ENABLED && (
        <BottomNavItem {...nav} id="profile" glyph={<UserIcon size={15} />} label="Profile" />
      )}
    </div>
  );
}
