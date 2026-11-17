import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import { CloseIcon, MoreIcon } from '../icons';
import { toast } from 'sonner';
import { companionStatusLine, type CompanionItemDto, type CompanionTab } from 'michi-shared';
import { escapeTakenBefore } from '../../composerEscape';
import { isImeComposing } from '../../../lib/ime';
import { MENU_LAYER_SELECTOR } from '../escapeLayers';
import { useBackLayer } from '../../../lib/backStack';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { useStructuralSelector } from '../../../state/chatStore';
import { RESIZE_CLICK_SLOP_PX, RESIZE_KEY_STEP, clickedEdgeWidth, useResizeEdgeClicks } from '../../ResizeHandle';
import { tabStripKeyTarget } from '../tabKeys';
import type { ChatNodeState } from '../../../state/chatTypes';
import type { PageId } from '../../../state/commands';
import {
  adoptCompanionAssistant,
  loadCompanion,
  loadCompanionAssistant,
  markCompanionItemsSeen,
  noteCompanionViewed,
  scheduleCompanionRefresh,
  setCompanionPanelVisible,
  companionIsOff,
  useCompanion,
  useCompanionAssistant,
} from '../../../state/companion/companionStore';
import {
  closeCompanionPanel,
  getCompanionPanelState,
  noteCompanionScreen,
  openCompanionPanel,
  setCompanionHistoryOpen,
  setCompanionPanelTab,
  setCompanionTarget,
  useCompanionPanel,
} from '../../../state/companion/companionPanel';
import { useCompanionName } from '../../../state/companion/companionName';
import { preemptCompanionTurn } from '../../../state/companion/companionPresence';
import { companionScreenKey, useCompanionSpacesScreen } from '../../../state/companion/companionScreen';
import { ActionMenu } from '../../ui/ActionMenu';
import { ensureCompanionTurnSource } from '../../../state/companion/companionTurnSource';
import { DUR, EASE } from '../../../motion/tokens';
import { companionWaitingItems } from '../../../state/companion/companionToday';
import { MetaChatRevealPageContext } from '../spaces/metaChat/metaChatRevealPage';
import { PAGE_HELPER_DRAFT_EVENT, type PageHelperDraftRequest } from '../../../state/pages/pageHelperDraft';
import { AssistantApiError, MICHI_ASSISTANT_RESET_EVENT, resetAssistant, type AssistantInfo } from '../../../services/api/assistant';
import type { CompanionSnapshot } from '../../../services/api/companion';
import { AssistantHistory } from '../spaces/AssistantHistory';
import { CompanionActivity } from './CompanionActivity';
import { CompanionChatTab } from './CompanionChatTab';
import { CompanionToday } from './CompanionToday';
import { openCompanionSettings, useOpenCompanionTarget } from './companionTargets';
import './companion.css';

// What each message to V carries is read when the user sends it, panel shown or not (F1a-review #1).
ensureCompanionTurnSource();

/** The header's tabs, in order. */
const COMPANION_TABS: readonly CompanionTab[] = ['chat', 'today'];

export const COMPANION_PANEL_WIDTH_KEY = 'michi:companion:panel-width';
/** How long the first open waits for the backend before the panel shows. */
const FIRST_PROBE_GRACE_MS = 250;
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;

/**
 * The owner's ⌘J motion: the panel rises 28px into place over 300ms while
 * it fades in over 180ms, and sinks 14px as it fades out over 160ms on an
 * accelerating curve. Only transform and opacity move, never the column's
 * width; reduced motion keeps the fades (MotionConfig).
 */
const RISE_MS = 300;
const RISE_PX = 28;
const SINK_PX = 14;
const SINK_EASE: [number, number, number, number] = [0.4, 0, 1, 1];
const PANEL_FROM: TargetAndTransition = { y: RISE_PX, opacity: 0 };
const PANEL_IN: TargetAndTransition = {
  y: 0,
  opacity: 1,
  transition: { y: { duration: RISE_MS / 1000, ease: EASE.out }, opacity: { duration: DUR.enter, ease: 'linear' } },
};
const PANEL_OUT: TargetAndTransition = { y: SINK_PX, opacity: 0, transition: { duration: DUR.collapse, ease: SINK_EASE } };

const clampWidth = (width: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));

function readWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(COMPANION_PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeWidth(width: number): void {
  try { window.localStorage.setItem(COMPANION_PANEL_WIDTH_KEY, String(width)); } catch { /* the width resets next time */ }
}

function clearWidth(): void {
  try { window.localStorage.removeItem(COMPANION_PANEL_WIDTH_KEY); } catch { /* nothing saved to clear */ }
}

/**
 * New conversation (DESIGN-v2 §1.4: the assistant's reset, the one V): the
 * old conversation goes to History. A 409 says another window already moved
 * on; the panel then shows the one that is current.
 */
async function startNewConversation(nodeId: string): Promise<void> {
  try {
    const next = await resetAssistant(nodeId);
    adoptCompanionAssistant(next);
    setCompanionTarget(null);
    window.dispatchEvent(new CustomEvent<AssistantInfo>(MICHI_ASSISTANT_RESET_EVENT, { detail: next }));
    scheduleCompanionRefresh();
    openCompanionPanel({ tab: 'chat' });
  } catch (cause) {
    if (cause instanceof AssistantApiError && cause.current) adoptCompanionAssistant(cause.current);
    else toast.error(cause instanceof Error ? cause.message : 'Could not start a new conversation');
  }
}

/** A status line's state words, and the clause after " · " that only the Watching line has. */
function statusParts(text: string): [string, string | null] {
  const at = text.indexOf(' · ');
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + ' · '.length)];
}

function CompanionHeader({ snapshot, tab, nodeId, compact, onClose, onHistory, onActivity, todayRef, moreRef }: {
  snapshot: CompanionSnapshot | null;
  tab: CompanionTab;
  nodeId: string | null;
  compact: boolean;
  onClose(): void;
  onHistory(): void;
  onActivity(): void;
  todayRef: React.RefObject<HTMLButtonElement | null>;
  /** The More button, where History and Activity give focus back. */
  moreRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const clock = useMinuteClock(true);
  const name = useCompanionName();
  // One status line for the panel, the Topbar and the tray (DESIGN-v2 §3.8, §5.1): "Checking in… ·
  // Stop" for a check-in, "Saying hello…" without Stop for the welcome (F4), "Taking a first look…".
  const line = snapshot ? companionStatusLine(snapshot, clock) : null;
  // The same items Today's header counts (companionToday.ts), so the pill and the tab never say a different number.
  const waiting = useMemo(() => (snapshot ? companionWaitingItems(snapshot.items, clock) : []), [snapshot, clock]);
  const needsYou = waiting.filter((item) => item.status === 'new').length;
  const unread = snapshot?.counts.unreadMessages ?? 0;
  const answering = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => !!nodeId && nodes[nodeId]?.status === 'streaming', [nodeId]));
  // The header's menu (ActionMenu: focus moves into it, Esc and a choice give it back to ⋯). Each
  // opening has its own key, so one reopened while the last fades out mounts afresh (TR-13).
  const openings = useRef(0);
  const [menuKey, setMenuKey] = useState<number | null>(null);
  const closeMenu = useCallback(() => setMenuKey(null), []);
  // New conversation runs once its menu has closed, so the header holds its busy state.
  const [starting, setStarting] = useState(false);
  const newConversation = async () => {
    if (!nodeId || starting) return;
    setStarting(true);
    try { await startNewConversation(nodeId); } finally { setStarting(false); }
  };
  // Only the state words are live: "checked 2m ago", which the minute clock rewrites, and Stop sit
  // beside them, so a screen reader hears a state once rather than every minute.
  const [said, clause] = line ? statusParts(line.text) : ['', null];
  const status = line && (
    <span className="companion-head__status" data-tone={line.tone} title={line.text}>
      <span role="status">{said}</span>
      {clause && ` · ${clause}`}
      {line.stoppable && (
        <>
          <span aria-hidden="true"> · </span>
          <button type="button" className="companion-link-btn" onClick={() => preemptCompanionTurn()}>Stop</button>
        </>
      )}
    </span>
  );
  // ← and → select the other tab, Home and End the ends, and the focus goes with it (ST-20).
  const chatRef = useRef<HTMLButtonElement>(null);
  const onTabKeyDown = (event: React.KeyboardEvent, from: CompanionTab) => {
    const next = tabStripKeyTarget(event, COMPANION_TABS.indexOf(from), COMPANION_TABS.length);
    if (next === null) return;
    event.preventDefault();
    setCompanionPanelTab(COMPANION_TABS[next]);
    (COMPANION_TABS[next] === 'chat' ? chatRef : todayRef).current?.focus();
  };
  const tabs = (
    <div className="companion-tabs" role="tablist" aria-label={`${name} views`}>
      <button ref={chatRef} type="button" role="tab" className="companion-tab" aria-selected={tab === 'chat'} tabIndex={tab === 'chat' ? 0 : -1}
        onClick={() => setCompanionPanelTab('chat')} onKeyDown={(event) => onTabKeyDown(event, 'chat')}>
        Chat{unread > 0 && <span className="companion-tab__count" aria-label={`${unread} new`}>{unread}</span>}
      </button>
      <button ref={todayRef} type="button" role="tab" className="companion-tab" aria-selected={tab === 'today'} tabIndex={tab === 'today' ? 0 : -1}
        onClick={() => setCompanionPanelTab('today')} onKeyDown={(event) => onTabKeyDown(event, 'today')}>
        Today{needsYou > 0 && <span className="companion-tab__count" aria-label={`${needsYou} need you`}>{needsYou}</span>}
      </button>
    </div>
  );
  // Beside the tabs rather than a row of its own above the Chat, which a phone has no height for.
  const needsPill = tab === 'chat' && waiting.length > 0 && (
    <button type="button" className="companion-needs-pill" onClick={() => setCompanionPanelTab('today')}>
      Needs you ({waiting.length})
    </button>
  );
  const actions = (
    <>
      <button ref={moreRef} type="button" className="companion-icon-btn" aria-label={`${name} menu`} aria-haspopup="menu" aria-expanded={menuKey !== null}
        aria-busy={starting || undefined} title="More" onClick={() => setMenuKey(menuKey === null ? ++openings.current : null)}>
        <MoreIcon />
      </button>
      <AnimatePresence>
        {menuKey !== null && moreRef.current && (
          <ActionMenu key={menuKey} anchor={moreRef.current} label="More" onClose={closeMenu} items={[
            { id: 'new', label: 'New conversation', disabled: !nodeId || answering || starting, onSelect: () => { void newConversation(); } },
            { id: 'history', label: 'History…', disabled: !nodeId, onSelect: onHistory },
            { id: 'activity', label: 'Activity…', onSelect: onActivity },
            { id: 'settings', label: 'Settings', onSelect: openCompanionSettings },
          ]} />
        )}
      </AnimatePresence>
      <button type="button" className="companion-icon-btn" aria-label={`Close ${name}`} title="Close" onClick={onClose}><CloseIcon size="sm" /></button>
    </>
  );
  if (compact) {
    // A phone: one row, the name then the tabs. The dot keeps the status's tone; its words show,
    // in the place of Needs you, only when they ask for something: a check-in's Stop or Auth
    // expired. A source that failed its last check (Watching, degraded) only turns the dot red.
    const notable = !!line && (!!line.stoppable || (line.tone === 'warn' && snapshot?.status.auth.valid === false));
    return (
      <header className="companion-head" data-compact="">
        <div className="companion-head__top">
          <span className="companion-avatar" data-tone={line?.tone ?? 'off'} aria-hidden="true" />
          <span className="companion-head__name" title={name}>{name}</span>
          {tabs}
          {notable ? status : needsPill}
          {line && !notable && <span className="sr-only"><span role="status">{said}</span>{clause && ` · ${clause}`}</span>}
          {actions}
        </div>
      </header>
    );
  }
  return (
    <header className="companion-head">
      <div className="companion-head__top">
        <span className="companion-avatar" data-tone={line?.tone ?? 'off'} aria-hidden="true" />
        <span className="companion-head__name" title={name}>{name}</span>
        {status}
        {actions}
      </div>
      <div className="companion-head__bar">
        {tabs}
        {needsPill}
      </div>
    </header>
  );
}

function CompanionPanel({ narrow, page, covered, settled }: {
  narrow: boolean;
  page?: PageId;
  covered: boolean;
  /** Open since the window loaded: it shows in place, without rising. */
  settled: boolean;
}) {
  // Sinking out it is a ghost: inert, hidden from assistive technology and out of Back.
  const present = useIsPresent();
  const { snapshot, stale, arrivals } = useCompanion();
  const assistant = useCompanionAssistant();
  const panel = useCompanionPanel();
  const name = useCompanionName();
  const rootRef = useRef<HTMLElement>(null);
  const todayRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(readWidth);
  // History is panel state, so Settings can open it (openCompanionPanel({ history: true })).
  const historyOpen = panel.historyOpen;
  const setHistoryOpen = setCompanionHistoryOpen;
  // Activity (Q31): what check-ins did, with Undo all, and the conversations the agent follows.
  const [activityOpen, setActivityOpen] = useState(false);
  // Chosen from the menu, History or Activity takes focus on its ×; closing the one that holds
  // focus gives it back to More (ST-10). One shows at a time, so they share the refs.
  const blockRef = useRef<HTMLDivElement>(null);
  const blockCloseRef = useRef<HTMLButtonElement>(null);
  const focusBlockClose = useRef(false);
  useEffect(() => {
    if (!focusBlockClose.current) return;
    focusBlockClose.current = false;
    blockCloseRef.current?.focus({ preventScroll: true });
  }, [historyOpen, activityOpen]);
  const openHistory = () => { focusBlockClose.current = true; setActivityOpen(false); setHistoryOpen(true); };
  const openActivity = () => { focusBlockClose.current = true; setHistoryOpen(false); setActivityOpen(true); };
  const leaveBlock = () => { if (blockRef.current?.contains(document.activeElement)) moreRef.current?.focus({ preventScroll: true }); };
  const closeHistory = () => { leaveBlock(); setHistoryOpen(false); };
  const closeActivity = () => { leaveBlock(); setActivityOpen(false); };
  const openTarget = useOpenCompanionTarget();
  const nodeId = assistant.info?.nodeId ?? null;
  // Over the page in a narrow window the panel is a layer: Back closes it, as Esc does
  // (History or Activity first, when one is open).
  useBackLayer(narrow && present, { back: () => (historyOpen ? closeHistory() : activityOpen ? closeActivity() : closeCompanionPanel()) });
  // Docked, the panel narrows the pane strip below the topbar, so the topbar's pane captions
  // leave its width too (BrowserDock's way: on the topbar, the one element that reads it).
  useLayoutEffect(() => {
    const root = rootRef.current;
    const topbar = root?.closest('.terminal-shell')?.querySelector<HTMLElement>('.terminal-topbar');
    if (narrow || !root || !topbar) return undefined;
    const sync = () => topbar.style.setProperty('--companion-dock-width', `${root.getBoundingClientRect().width}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => {
      observer.disconnect();
      topbar.style.removeProperty('--companion-dock-width');
    };
  }, [narrow]);

  // ⇧⌘J lands in the panel on Today, so a second ⇧⌘J closes it (§1.2).
  useEffect(() => {
    if (panel.panelFocusSeq > 0 && panel.tab === 'today') todayRef.current?.focus({ preventScroll: true });
  }, [panel.panelFocusSeq, panel.tab]);

  const onOpenItem = useCallback((item: CompanionItemDto) => {
    if (item.status === 'new') markCompanionItemsSeen([item.id]);
    if (item.target) void openTarget(item.target);
  }, [openTarget]);
  // Today's Ask attaches the item itself (DESIGN-v2 §1.2): its title is collector material, never typed into the draft.
  const onAsk = useCallback((item: CompanionItemDto) => openCompanionPanel({
    attachments: [{ kind: 'companion_item', id: item.id, title: item.title }],
    draft: 'Tell me more about this.',
  }), []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || isImeComposing(event)) return;
    // The composer says when it kept an Escape (its own popup, a composition).
    if (escapeTakenBefore(event.nativeEvent)) return;
    // A menu, list or modal over the panel (a row's menu, the panel's own menu) owns Esc.
    if (document.querySelector(MENU_LAYER_SELECTOR) || rootRef.current?.querySelector('[data-escape-layer]')) return;
    event.preventDefault();
    event.stopPropagation();
    closeCompanionPanel();
  };

  // A double-click on the edge goes back to the default width.
  const resetWidth = () => {
    setWidth(DEFAULT_WIDTH);
    clearWidth();
  };
  // A click switches between the narrowest and widest widths, the edge's way in without a drag.
  const edgeClicks = useResizeEdgeClicks(() => {
    const next = clickedEdgeWidth(width, MIN_WIDTH, MAX_WIDTH);
    setWidth(next);
    writeWidth(next);
  }, resetWidth);
  // A drag writes the width onto the panel once per frame, so the shell, its header and the
  // Chat do not re-render per pointer move (TR-21); the width is kept and saved on release.
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    edgeClicks.onPointerDown();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    let dragging = false;
    let frame = 0;
    const apply = () => { rootRef.current?.style.setProperty('--companion-panel-width', `${latest}px`); };
    const move = (next: PointerEvent) => {
      if (!dragging) {
        // A press that stays put is a click, not a drag.
        if (Math.abs(next.clientX - startX) < RESIZE_CLICK_SLOP_PX) return;
        dragging = true;
        edgeClicks.markDragged();
        handle.setAttribute('data-dragging', '');
      }
      latest = clampWidth(startWidth + (startX - next.clientX));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!dragging) return;
      cancelAnimationFrame(frame);
      apply();
      handle.removeAttribute('data-dragging');
      setWidth(latest);
      writeWidth(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const resizeByKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowLeft' ? RESIZE_KEY_STEP : event.key === 'ArrowRight' ? -RESIZE_KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    const next = clampWidth(width + step);
    setWidth(next);
    writeWidth(next);
  };
  let body: React.ReactNode;
  if (panel.tab === 'chat') {
    body = <CompanionChatTab snapshot={snapshot} page={page} />;
  } else if (!snapshot) {
    // Today needs the Companion snapshot; the Chat does not (§1.3).
    body = <p className="companion-status-msg" role="status">Today isn’t available right now.</p>;
  } else {
    body = <CompanionToday snapshot={snapshot} arrivals={arrivals} onOpenItem={onOpenItem} onAsk={onAsk} onOpenSettings={openCompanionSettings} />;
  }

  return (
    <motion.aside
      ref={rootRef}
      className="companion-panel"
      aria-label={name}
      data-companion-panel=""
      data-assistant-panel=""
      data-layout={narrow ? 'overlay' : 'docked'}
      initial={settled ? false : PANEL_FROM}
      animate={PANEL_IN}
      exit={PANEL_OUT}
      inert={!present}
      aria-hidden={present ? undefined : true}
      // Under the open phone drawer nothing here takes a touch, as on the page beside it (TerminalShell's content column).
      style={narrow ? (covered ? { pointerEvents: 'none' } : undefined) : { '--companion-panel-width': `${width}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      {!narrow && (
        <button type="button" className="companion-panel__resize" aria-label={`Resize the ${name} panel`}
          title="Drag or click to resize · Double-click to reset" onPointerDown={startResize} onKeyDown={resizeByKey}
          onClick={edgeClicks.onClick} onDoubleClick={edgeClicks.onDoubleClick} />
      )}
      <CompanionHeader snapshot={snapshot} tab={panel.tab} nodeId={nodeId} compact={narrow} onClose={closeCompanionPanel}
        onHistory={openHistory} onActivity={openActivity} todayRef={todayRef} moreRef={moreRef} />
      {historyOpen && (
        <div ref={blockRef} className="companion-history" data-escape-layer="" role="dialog" aria-label="History"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHistory(); } }}>
          <div className="companion-history__head">
            <span>History</span>
            <button ref={blockCloseRef} type="button" className="companion-icon-btn" aria-label="Close history" onClick={closeHistory}><CloseIcon size="sm" /></button>
          </div>
          <AssistantHistory visible onOpenAssistant={() => { closeHistory(); setCompanionPanelTab('chat'); }} />
        </div>
      )}
      {activityOpen && !historyOpen && (
        <div ref={blockRef} className="companion-history" data-escape-layer="" role="dialog" aria-label="Activity"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeActivity(); } }}>
          <div className="companion-history__head">
            <span>Activity</span>
            <button ref={blockCloseRef} type="button" className="companion-icon-btn" aria-label="Close activity" onClick={closeActivity}><CloseIcon size="sm" /></button>
          </div>
          <CompanionActivity snapshot={snapshot} name={name} />
        </div>
      )}
      {stale && snapshot && <p className="companion-stale" role="status">Can’t reach {name} right now — this is what it last showed.</p>}
      {/* Over the page in a narrow window, a page something in the panel opens (View, a page link) closes it (F1a-review #6). */}
      <MetaChatRevealPageContext.Provider value={narrow ? closeCompanionPanel : null}>
        <div className="companion-body">{body}</div>
      </MetaChatRevealPageContext.Provider>
    </motion.aside>
  );
}

/**
 * A page helper's draft (a database's or component's Ask, PagePane's Ask) in
 * any area opens the panel with it, the block as its target (§1.2, §1.3).
 */
function usePageHelperDrafts(): void {
  useEffect(() => {
    const onDraft = (event: Event) => {
      const request = (event as CustomEvent<PageHelperDraftRequest>).detail;
      if (!request) return;
      openCompanionPanel({
        draft: request.text,
        target: {
          pageId: request.pageId,
          workspaceId: request.workspaceId,
          backendConnectionId: request.backendConnectionId,
          ...(request.blockContext ? { blockId: request.blockContext.blockId, title: request.blockContext.title, content: request.blockContext.content } : {}),
        },
      });
    };
    window.addEventListener(PAGE_HELPER_DRAFT_EVENT, onDraft);
    return () => window.removeEventListener(PAGE_HELPER_DRAFT_EVENT, onDraft);
  }, []);
}

/**
 * The one panel (DESIGN-v2 §1.1): shell-level, docked right of the page in
 * every area (a narrow window shows it over the page), non-modal, two tabs
 * (Chat | Today). Renders nothing while closed, and never when this backend
 * has no assistant. `page` (the shell's page) lets the Chat follow the screen
 * ("On screen: …"); without it the panel names the focused pane, if any.
 */
export function CompanionPanelHost({ narrow, page, covered = false, onShownChange }: {
  narrow: boolean;
  page?: PageId;
  covered?: boolean;
  /** Whether the panel is on screen, which `panel.open` is not during the first probe's grace. */
  onShownChange?: (shown: boolean) => void;
}) {
  const companion = useCompanion();
  const { availability, snapshot } = companion;
  // Off (Q29), the panel opens only from Pages' Ask and the links into its conversation (its button,
  // ⌘J and notices open nothing). Turning Michi off closes an open panel; one opened while off stays.
  const off = companionIsOff(companion);
  const onOff: 'unknown' | 'on' | 'off' = !snapshot || availability !== 'available' ? 'unknown' : off ? 'off' : 'on';
  const previousOnOff = useRef(onOff);
  const assistant = useCompanionAssistant();
  const panel = useCompanionPanel();
  // Until the backend first answers, the panel waits a moment before it shows: one without an
  // assistant answers 404 well within it, so the panel never flashes there (the ⌘J card's rule).
  const probing = panel.open && !assistant.info && (assistant.status === 'idle' || assistant.status === 'loading');
  const [probeShown, setProbeShown] = useState(false);
  useEffect(() => {
    if (!probing) { setProbeShown(false); return undefined; }
    const timer = window.setTimeout(() => setProbeShown(true), FIRST_PROBE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [probing]);
  const shown = panel.open && assistant.status !== 'unsupported' && (!probing || probeShown);
  // Before paint, so the page under the phone panel is inert in the frame it shows.
  useLayoutEffect(() => {
    if (!shown) return undefined;
    onShownChange?.(true);
    return () => onShownChange?.(false);
  }, [shown, onShownChange]);
  // Open when the window loaded (the open state outlives a reload): the panel shows settled once the
  // backend answers, as restored content does. Any open after a close rises in.
  const openAtLoad = useRef(panel.open);
  useEffect(() => { if (!panel.open) openAtLoad.current = false; }, [panel.open]);
  useEffect(() => {
    const turnedOff = previousOnOff.current === 'on' && onOff === 'off';
    previousOnOff.current = onOff;
    if (turnedOff && getCompanionPanelState().open) closeCompanionPanel();
  }, [onOff]);
  usePageHelperDrafts();

  // A block target is about the screen it was set on: another area or Pages view lets it go (F1a-review #9).
  const spaces = useCompanionSpacesScreen();
  const screenKey = companionScreenKey(page, spaces);
  useEffect(() => { noteCompanionScreen(screenKey); }, [screenKey]);

  useEffect(() => {
    if (panel.open) void loadCompanionAssistant();
  }, [panel.open]);

  useEffect(() => {
    if (shown) void loadCompanion();
  }, [shown]);

  useEffect(() => {
    setCompanionPanelVisible(shown && availability !== 'unavailable');
    return () => setCompanionPanelVisible(false);
  }, [shown, availability]);

  // On screen or back in focus: the backend notes the view ("Since you left", unread).
  const available = availability === 'available' && !!snapshot;
  useEffect(() => {
    if (!shown || !available) return undefined;
    noteCompanionViewed();
    const onFocus = () => noteCompanionViewed();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [shown, available]);

  return (
    <AnimatePresence initial={false}>
      {shown && <CompanionPanel key="companion" narrow={narrow} page={page} covered={covered} settled={openAtLoad.current} />}
    </AnimatePresence>
  );
}
