import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { companionStatusLine, type CompanionItemDto, type CompanionTab } from 'michi-shared';
import { escapeTakenBefore } from '../../composerEscape';
import { isImeComposing } from '../../../lib/ime';
import { MENU_LAYER_SELECTOR } from '../escapeLayers';
import { useBackLayer } from '../../../lib/backStack';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { useStructuralSelector } from '../../../state/chatStore';
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
  useCompanion,
  useCompanionAssistant,
} from '../../../state/companion/companionStore';
import {
  closeCompanionPanel,
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
import { ensureCompanionTurnSource } from '../../../state/companion/companionTurnSource';
import { companionBriefPostId, itemsInBucket } from '../../../state/companion/companionView';
import { MetaChatRevealPageContext } from '../spaces/metaChat/metaChatRevealPage';
import { PAGE_HELPER_DRAFT_EVENT, type PageHelperDraftRequest } from '../../../state/pages/pageHelperDraft';
import { AssistantApiError, MICHI_ASSISTANT_RESET_EVENT, resetAssistant, type AssistantInfo } from '../../../services/api/assistant';
import type { CompanionSnapshot } from '../../../services/api/companion';
import { AssistantHistory } from '../spaces/AssistantHistory';
import { CompanionChatTab } from './CompanionChatTab';
import { CompanionToday } from './CompanionToday';
import { openCompanionSettings, useOpenCompanionTarget } from './companionTargets';
import './companion.css';

// What each message to V carries is read when the user sends it, panel shown or not (F1a-review #1).
ensureCompanionTurnSource();

export const COMPANION_PANEL_WIDTH_KEY = 'michi:companion:panel-width';
/** How long the first open waits for the backend before the panel shows. */
const FIRST_PROBE_GRACE_MS = 250;
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
const KEY_STEP = 24;

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

/**
 * The header's menu. It takes focus when it opens, so Esc reaches it (the
 * panel leaves Esc to any `[data-escape-layer]`); Esc or a press outside
 * closes it and gives focus back to the More button (F1a-review #15).
 */
function PanelMenu({ nodeId, answering, onHistory, onClose, anchorRef }: {
  nodeId: string | null;
  answering: boolean;
  onHistory(): void;
  onClose(options?: { refocus?: boolean }): void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const [starting, setStarting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onCloseRef.current({ refocus: false });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [anchorRef]);
  const newConversation = async () => {
    if (!nodeId || starting) return;
    setStarting(true);
    try { await startNewConversation(nodeId); } finally { setStarting(false); onClose(); }
  };
  return (
    <div ref={menuRef} className="companion-menu" role="menu" data-escape-layer=""
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose({ refocus: true }); } }}>
      <button type="button" role="menuitem" className="companion-menu__item" disabled={!nodeId || answering || starting}
        aria-busy={starting || undefined} onClick={() => { void newConversation(); }}>New conversation</button>
      <button type="button" role="menuitem" className="companion-menu__item" disabled={!nodeId} onClick={() => { onHistory(); onClose(); }}>History…</button>
      <button type="button" role="menuitem" className="companion-menu__item" onClick={() => { openCompanionSettings(); onClose(); }}>Settings</button>
    </div>
  );
}

function CompanionHeader({ snapshot, tab, nodeId, onClose, onHistory, todayRef }: {
  snapshot: CompanionSnapshot | null;
  tab: CompanionTab;
  nodeId: string | null;
  onClose(): void;
  onHistory(): void;
  todayRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const clock = useMinuteClock(true);
  const name = useCompanionName();
  // One status line for the panel, the Topbar and the tray (DESIGN-v2 §3.8, §5.1): "Checking in… ·
  // Stop" for a check-in, "Saying hello…" without Stop for the welcome (F4), "Taking a first look…".
  const line = snapshot ? companionStatusLine(snapshot, clock) : null;
  const needsYou = snapshot ? itemsInBucket(snapshot.items, 'needs_you').filter((item) => item.status === 'new').length : 0;
  const unread = snapshot?.counts.unreadMessages ?? 0;
  const answering = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => !!nodeId && nodes[nodeId]?.status === 'streaming', [nodeId]));
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback((options: { refocus?: boolean } = {}) => {
    setMenuOpen(false);
    if (options.refocus) moreRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="companion-head">
      <div className="companion-head__top">
        <span className="companion-avatar" data-tone={line?.tone ?? 'off'} aria-hidden="true" />
        <span className="companion-head__name" title={name}>{name}</span>
        {line && (
          <span className="companion-head__status" data-tone={line.tone} title={line.text} role="status">
            {line.text}
            {line.stoppable && (
              <>
                <span aria-hidden="true"> · </span>
                <button type="button" className="companion-link-btn" onClick={() => preemptCompanionTurn()}>Stop</button>
              </>
            )}
          </span>
        )}
        <span className="companion-head__menu">
          <button ref={moreRef} type="button" className="companion-icon-btn" aria-label={`${name} menu`} aria-haspopup="menu" aria-expanded={menuOpen}
            title="More" onClick={() => setMenuOpen((open) => !open)}>
            <MoreHorizontal size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
          {menuOpen && <PanelMenu nodeId={nodeId} answering={answering} onHistory={onHistory} onClose={closeMenu} anchorRef={moreRef} />}
        </span>
        <button type="button" className="companion-icon-btn" aria-label={`Close ${name}`} title="Close" onClick={onClose}>×</button>
      </div>
      <div className="companion-tabs" role="tablist" aria-label={`${name} views`}>
        <button type="button" role="tab" className="companion-tab" aria-selected={tab === 'chat'} onClick={() => setCompanionPanelTab('chat')}>
          Chat{unread > 0 && <span className="companion-tab__count" aria-label={`${unread} new`}>{unread}</span>}
        </button>
        <button ref={todayRef} type="button" role="tab" className="companion-tab" aria-selected={tab === 'today'} onClick={() => setCompanionPanelTab('today')}>
          Today{needsYou > 0 && <span className="companion-tab__count" aria-label={`${needsYou} need you`}>{needsYou}</span>}
        </button>
      </div>
    </header>
  );
}

function CompanionPanel({ narrow, page }: { narrow: boolean; page?: PageId }) {
  const { snapshot, stale, catchUp, arrivals } = useCompanion();
  const assistant = useCompanionAssistant();
  const panel = useCompanionPanel();
  const name = useCompanionName();
  const rootRef = useRef<HTMLElement>(null);
  const todayRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(readWidth);
  // History is panel state, so Settings can open it (openCompanionPanel({ history: true })).
  const historyOpen = panel.historyOpen;
  const setHistoryOpen = setCompanionHistoryOpen;
  const openTarget = useOpenCompanionTarget();
  const nodeId = assistant.info?.nodeId ?? null;
  // Over the page in a narrow window the panel is a layer: Back closes it, as Esc does
  // (History first, when it is open).
  useBackLayer(narrow, { back: () => (historyOpen ? setHistoryOpen(false) : closeCompanionPanel()) });

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
  // A brief card's action prompt is check-in text: the message it drafts replies to the brief's post (D9, §2.8 T3/T4).
  const brief = snapshot?.brief ?? null;
  const activity = snapshot?.activity;
  const onAction = useCallback((prompt: string) => openCompanionPanel({
    draft: prompt,
    ...(brief ? { replyToPost: companionBriefPostId(brief, activity ?? []) } : {}),
  }), [brief, activity]);

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

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    handle.setAttribute('data-dragging', '');
    const move = (next: PointerEvent) => {
      latest = clampWidth(startWidth + (startX - next.clientX));
      setWidth(latest);
    };
    const end = () => {
      handle.removeAttribute('data-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      writeWidth(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const resizeByKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    const next = clampWidth(width + step);
    setWidth(next);
    writeWidth(next);
  };
  // A double-click on the edge goes back to the default width.
  const resetWidth = () => {
    setWidth(DEFAULT_WIDTH);
    clearWidth();
  };

  let body: React.ReactNode;
  if (panel.tab === 'chat') {
    body = <CompanionChatTab snapshot={snapshot} page={page} />;
  } else if (!snapshot) {
    // Today needs the Companion snapshot; the Chat does not (§1.3).
    body = <p className="companion-status-msg" role="status">Today isn’t available right now.</p>;
  } else {
    body = <CompanionToday snapshot={snapshot} catchUp={catchUp} arrivals={arrivals} onOpenItem={onOpenItem} onAsk={onAsk}
      onAction={onAction} onOpenSettings={openCompanionSettings} />;
  }

  return (
    <aside
      ref={rootRef}
      className="companion-panel"
      aria-label={name}
      data-companion-panel=""
      data-assistant-panel=""
      data-layout={narrow ? 'overlay' : 'docked'}
      style={narrow ? undefined : { '--companion-panel-width': `${width}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      {!narrow && (
        <button type="button" className="companion-panel__resize" aria-label={`Resize the ${name} panel`}
          title="Drag to resize · Double-click to reset" onPointerDown={startResize} onKeyDown={resizeByKey} onDoubleClick={resetWidth} />
      )}
      <CompanionHeader snapshot={snapshot} tab={panel.tab} nodeId={nodeId} onClose={closeCompanionPanel}
        onHistory={() => setHistoryOpen(true)} todayRef={todayRef} />
      {historyOpen && (
        <div className="companion-history" data-escape-layer="" role="dialog" aria-label="History"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setHistoryOpen(false); } }}>
          <div className="companion-history__head">
            <span>History</span>
            <button type="button" className="companion-icon-btn" aria-label="Close history" onClick={() => setHistoryOpen(false)}>×</button>
          </div>
          <AssistantHistory visible onOpenAssistant={() => { setHistoryOpen(false); setCompanionPanelTab('chat'); }} />
        </div>
      )}
      {stale && snapshot && <p className="companion-stale" role="status">Can’t reach {name} right now — this is what it last showed.</p>}
      {/* Over the page in a narrow window, a page something in the panel opens (View, a page link) closes it (F1a-review #6). */}
      <MetaChatRevealPageContext.Provider value={narrow ? closeCompanionPanel : null}>
        <div className="companion-body">{body}</div>
      </MetaChatRevealPageContext.Provider>
    </aside>
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
export function CompanionPanelHost({ narrow, page }: { narrow: boolean; page?: PageId }) {
  const { availability, snapshot } = useCompanion();
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

  return shown ? <CompanionPanel narrow={narrow} page={page} /> : null;
}
