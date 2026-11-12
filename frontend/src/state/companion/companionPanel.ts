import { useMemo, useSyncExternalStore } from 'react';
import type { CompanionTab, MichiContextItem } from 'michi-shared';
import type { ShellArea } from '../shellArea';
import type { AssistantLink } from '../assistant/assistantLinks';
import { getCompanionAssistant, subscribeCompanion } from './companionStore';

/**
 * The one panel (DESIGN-v2 §1): whether it is open, which tab it shows, and
 * what the callers that open it asked for. ⌘J, ⇧⌘J, the Topbar button, the
 * palette, a block's Ask, a notification and the "agent is asking" bar all
 * open it through here (§1.2, §1.3); nothing else is ever open beside it.
 *
 * Open state and tab are per window (sessionStorage); "opened before" (the
 * button's New dot) is per machine (localStorage). Both are small UI state,
 * written only by these actions. Requests (a draft, a send, chips, a target)
 * belong to the moment they were made: closing the panel drops the ones the
 * Chat tab has not taken yet (§1.3), and so does a conversation that fails
 * to load (dropCompanionRequests).
 */

/** The block (or page) a message is about: sent with the Spaces fields in any area (§1.3, "target 不分区域"). */
export interface CompanionPanelTarget {
  pageId: string;
  blockId?: string;
  /** One checklist item of the block (0-based). */
  itemIndex?: number;
  /** The item's text, sent with its index (MetaAgentChatBlockItem). */
  itemText?: string;
  /** One row of the database the block shows (MetaAgentChatBlockRow: ids and title); never set with itemIndex. */
  row?: { databaseId: string; rowId: string; text: string };
  workspaceId?: string;
  backendConnectionId?: string;
  /** What the "Targeting: …" chip says. */
  title?: string;
  /** The block's text, for the page’s own Ask surfaces (useCompanionTargeting). */
  content?: string;
}

/** `openCompanionPanel(req)` (DESIGN-v2 §1.3). */
export interface OpenCompanionPanelRequest {
  tab?: CompanionTab;
  /** A Today item to bring into view (opens Today). */
  focusItem?: string;
  /** Text to leave in the Chat composer for the user to review (cleared if untouched once its moment is over). */
  draft?: string;
  /** Text the caller asks to send right away, through the composer's own send path. */
  send?: string;
  /** Chips above the composer: thread, node, block, row, companion_item. */
  attachments?: MichiContextItem[];
  /** The block the message is about, in any area. */
  target?: CompanionPanelTarget;
  /** Give the Chat composer focus; an explicit open does by default. */
  focusComposer?: boolean;
  /**
   * A message of the conversation to show: opens Chat, scrolls to it and
   * briefly highlights it (Activity's "View", a source jump into V).
   */
  focusMessageId?: string;
  /** Open Chat's History view (Settings › <name> › Conversation › History). */
  history?: true;
  /**
   * The `draft` is check-in material from this posted message (a brief
   * card's action, DESIGN-v2 D9): the message the user sends next replies to
   * it, so its turn starts in Ask (§2.8 T4), as a post's chip does (T3).
   */
  replyToPost?: string;
}

/** What one open asked the Chat tab to do once the conversation is in. */
export interface CompanionPanelRequest {
  draft?: string;
  send?: string;
  attachments?: MichiContextItem[];
  /** The post `draft` came from (OpenCompanionPanelRequest.replyToPost). */
  replyToPost?: string;
}

export interface CompanionPanelState {
  open: boolean;
  tab: CompanionTab;
  /** An item to bring into view on Today; `seq` bumps per request. Today takes it once (takeCompanionFocusItem). */
  focusItem: { id: string; seq: number } | null;
  /** Bumped by opens that should give the Chat composer focus. */
  composerFocusSeq: number;
  /** Bumped by opens that move focus into the panel without the composer (⇧⌘J to Today). */
  panelFocusSeq: number;
  /** Bumped when a request is queued; the Chat tab takes them (takeCompanionRequests). */
  requestSeq: number;
  /** The block the next messages are about ("Targeting: …"), until cleared, the panel closes or the area moves on. */
  target: CompanionPanelTarget | null;
  /** A message the Chat tab is asked to bring into view and highlight; `seq` bumps per request. Taken once (takeCompanionFocusMessage). */
  focusMessage: { id: string; seq: number } | null;
  /** Whether Chat's History view is open. */
  historyOpen: boolean;
  /** The user has opened the panel on this machine before; until then the button shows a New dot. */
  openedBefore: boolean;
}

const SESSION_KEY = 'michi:companion-panel';
const OPENED_KEY = 'michi:companion:opened';
/** The panel's root; Esc, ⌘W and the focus checks find it by this attribute. */
const COMPANION_PANEL_SELECTOR = '[data-companion-panel]';

function readSession(): { open: boolean; tab: CompanionTab } {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) as { open?: unknown; tab?: unknown } : null;
    return { open: parsed?.open === true, tab: parsed?.tab === 'today' ? 'today' : 'chat' };
  } catch {
    return { open: false, tab: 'chat' };
  }
}

function writeSession(open: boolean, tab: CompanionTab): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ open, tab }));
  } catch {
    // Storage unavailable: the panel just doesn't come back after a reload.
  }
}

function readOpenedBefore(): boolean {
  try {
    return window.localStorage.getItem(OPENED_KEY) === '1';
  } catch {
    return true;
  }
}

const CLOSED: Omit<CompanionPanelState, 'open' | 'tab' | 'openedBefore'> = {
  focusItem: null, composerFocusSeq: 0, panelFocusSeq: 0, requestSeq: 0, target: null, focusMessage: null, historyOpen: false,
};

function initialState(): CompanionPanelState {
  if (typeof window === 'undefined') return { open: false, tab: 'chat', openedBefore: true, ...CLOSED };
  return { ...readSession(), openedBefore: readOpenedBefore(), ...CLOSED };
}

let state: CompanionPanelState = initialState();
const listeners = new Set<() => void>();
let focusSeq = 0;
let requests: CompanionPanelRequest[] = [];
/** Where focus was when the panel opened (not inside it): closing hands it back (§1.2). */
let returnFocusTo: HTMLElement | null = null;
/** What the shell shows now (an area, Pages' view), as noteCompanionScreen was told. */
let screen: string | null = null;
/** What the shell showed when the target was set: the target is about that screen only (F1a-review #9). */
let targetScreen: string | null = null;

function noteTargetScreen(): void {
  targetScreen = screen;
}

function set(patch: Partial<CompanionPanelState>): void {
  const next = { ...state, ...patch };
  if (next.open !== state.open || next.tab !== state.tab) writeSession(next.open, next.tab);
  state = next;
  for (const listener of [...listeners]) listener();
}

export function getCompanionPanelState(): CompanionPanelState {
  return state;
}

export function subscribeCompanionPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCompanionPanel(): CompanionPanelState {
  return useSyncExternalStore(subscribeCompanionPanel, getCompanionPanelState, getCompanionPanelState);
}

/** The element is in the panel (its composer, a menu of its own, a tab). */
function isInCompanionPanel(element: Element | null | undefined): boolean {
  return !!element?.closest?.(COMPANION_PANEL_SELECTOR);
}

function focusIsInPanel(): boolean {
  return typeof document !== 'undefined' && isInCompanionPanel(document.activeElement);
}

function noteReturnFocus(): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  returnFocusTo = active instanceof HTMLElement && active !== document.body && !isInCompanionPanel(active) ? active : null;
}

/**
 * Open the panel (DESIGN-v2 §1.3). Without a tab it opens where it was last
 * (Chat the first time ever); a draft, a send, chips or a target open Chat,
 * an item to bring into view opens Today. An explicit open gives the Chat
 * composer focus unless the caller says not to.
 */
export function openCompanionPanel(req: OpenCompanionPanelRequest = {}): void {
  const wantsChat = req.draft !== undefined || req.send !== undefined || !!req.attachments?.length || !!req.target
    || !!req.focusMessageId || req.history === true;
  const tab: CompanionTab = wantsChat ? 'chat'
    : req.focusItem ? 'today'
    : req.tab ?? (state.openedBefore ? state.tab : 'chat');
  if (!state.openedBefore) {
    try { window.localStorage.setItem(OPENED_KEY, '1'); } catch { /* the dot shows again next time */ }
  }
  if (!state.open) noteReturnFocus();
  const request: CompanionPanelRequest = {
    ...(req.draft !== undefined ? { draft: req.draft } : {}),
    ...(req.send !== undefined ? { send: req.send } : {}),
    ...(req.attachments?.length ? { attachments: [...req.attachments] } : {}),
    ...(req.draft !== undefined && req.replyToPost ? { replyToPost: req.replyToPost } : {}),
  };
  const queued = Object.keys(request).length > 0;
  if (queued) requests.push(request);
  // Bringing a message into view (or opening History) keeps focus off the composer unless asked.
  const focusComposer = tab === 'chat' && (req.focusComposer ?? (!req.focusMessageId && req.history !== true));
  if (req.target) noteTargetScreen();
  set({
    open: true,
    tab,
    openedBefore: true,
    ...(req.focusItem ? { focusItem: { id: req.focusItem, seq: ++focusSeq } } : {}),
    ...(req.focusMessageId ? { focusMessage: { id: req.focusMessageId, seq: ++focusSeq } } : {}),
    ...(req.history === true ? { historyOpen: true } : {}),
    ...(req.target ? { target: { ...req.target } } : {}),
    ...(queued ? { requestSeq: state.requestSeq + 1 } : {}),
    ...(focusComposer ? { composerFocusSeq: state.composerFocusSeq + 1 } : {}),
    ...(tab === 'today' && req.focusComposer !== false ? { panelFocusSeq: state.panelFocusSeq + 1 } : {}),
  });
}

/**
 * Close the panel. Focus goes back to where it was when the panel opened
 * when it is still there, else to the Topbar button; a focus the user
 * already moved out of the panel stays where it is (§1.2).
 */
export function closeCompanionPanel(): void {
  if (!state.open) return;
  requests = [];
  if (typeof document !== 'undefined') {
    const active = document.activeElement;
    if (!active || active === document.body || isInCompanionPanel(active)) {
      const back = returnFocusTo?.isConnected ? returnFocusTo : document.querySelector<HTMLElement>('[data-companion-button]');
      back?.focus({ preventScroll: true });
    }
  }
  returnFocusTo = null;
  // A target belongs to the moment it was set (F1a-review #9): the next open starts without one.
  set({ open: false, focusItem: null, focusMessage: null, historyOpen: false, target: null });
}

/**
 * ⌘J (`chat`) and ⇧⌘J (`today`), DESIGN-v2 §1.2. ⌘J: closed → open on Chat
 * with the composer focused; open with focus elsewhere → focus the composer
 * (switching to Chat); focus already in the panel → close. ⇧⌘J: open on
 * Today; already on Today with focus in the panel → close.
 */
export function toggleCompanionPanel(tab: CompanionTab): void {
  const inPanel = state.open && focusIsInPanel();
  if (tab === 'chat') {
    if (inPanel) closeCompanionPanel();
    else openCompanionPanel({ tab: 'chat' });
    return;
  }
  if (inPanel && state.tab === 'today') closeCompanionPanel();
  else openCompanionPanel({ tab: 'today' });
}

export function setCompanionPanelTab(tab: CompanionTab): void {
  if (state.tab !== tab) set({ tab });
}

/** The Chat tab applies what the opens since it last looked asked for. */
export function takeCompanionRequests(): CompanionPanelRequest[] {
  const taken = requests;
  requests = [];
  return taken;
}

/** The conversation could not load: the requests made for it are dropped, not sent later. */
export function dropCompanionRequests(): void {
  requests = [];
}

/** Set or clear the block the next messages are about (for the screen on show now). */
export function setCompanionTarget(target: CompanionPanelTarget | null): void {
  if (target === state.target) return;
  if (target) noteTargetScreen();
  set({ target: target ? { ...target } : null });
}

/**
 * What the shell shows now: an area, and in Pages the view (CompanionPanelHost
 * tells it on every change). A target set on another screen lets go (F1a-review
 * #9): a block's Ask in Pages never rides along with "Create with agent" in
 * Scheduled, or a message from Conversations.
 */
export function noteCompanionScreen(next: string): void {
  if (next === screen) return;
  const first = screen === null;
  screen = next;
  // The first screen the shell names is the one a target set before it was set on.
  if (first) {
    targetScreen ??= next;
    return;
  }
  if (state.target && targetScreen !== next) set({ target: null });
}

/**
 * Today handled the focus request `seq` (brought the item into view, or
 * found it no longer open): coming back to Today later does not jump again.
 */
export function takeCompanionFocusItem(seq: number): void {
  if (state.focusItem?.seq === seq) set({ focusItem: null });
}

/** The Chat tab brought the message of request `seq` into view: going back to Chat later does not jump again. */
export function takeCompanionFocusMessage(seq: number): void {
  if (state.focusMessage?.seq === seq) set({ focusMessage: null });
}

/** Show or leave Chat's History view. */
export function setCompanionHistoryOpen(open: boolean): void {
  if (state.historyOpen !== open) set({ historyOpen: open, ...(open ? { tab: 'chat' as const } : {}) });
}

/** The conversation the panel shows now (open on Chat), or '' when it shows none. */
function shownNodeId(): string {
  const nodeId = getCompanionAssistant().info?.nodeId;
  return state.open && state.tab === 'chat' && nodeId ? nodeId : '';
}

/**
 * The panel shows this conversation now: open on Chat with it in view.
 * Replaces isShownInAssistantPanel (notifications count it as seen, §1.4).
 */
export function isCompanionPanelShowing(nodeId: string): boolean {
  return !!nodeId && shownNodeId() === nodeId;
}

/** The shown conversation changes with the panel (open, tab) and with the conversation the store has. */
function subscribeShown(listener: () => void): () => void {
  const unsubscribePanel = subscribeCompanionPanel(listener);
  const unsubscribeStore = subscribeCompanion(listener);
  return () => {
    unsubscribePanel();
    unsubscribeStore();
  };
}

/**
 * The conversations isCompanionPanelShowing answers true for (none, or V).
 * The window records their completions as seen while it is in front, as it
 * does the focused pane's (useShownNodesSeen): presence does not report the
 * panel, so the server cannot see it.
 */
export function useCompanionPanelShownNodeIds(): readonly string[] {
  const nodeId = useSyncExternalStore(subscribeShown, shownNodeId, shownNodeId);
  return useMemo(() => (nodeId ? [nodeId] : []), [nodeId]);
}

/** A link in the panel's conversation the area on screen may show its own way (§1.4). */
export type AssistantLinkTarget = AssistantLink;

interface OpenSource { area: ShellArea; open: (target: AssistantLinkTarget) => boolean }
let openSources: OpenSource[] = [];

/**
 * The area on screen shows a conversation link from the panel its own way
 * (Pages: the source popover over the page, so the user stays there).
 * The latest registration still in place wins; returns the unregister.
 */
export function registerCompanionOpenSource(area: ShellArea, open: (target: AssistantLinkTarget) => boolean): () => void {
  const entry: OpenSource = { area, open };
  openSources = [...openSources, entry];
  return () => { openSources = openSources.filter((candidate) => candidate !== entry); };
}

/** A link in the panel was clicked: true when the area showed it (the link then does nothing else). */
export function openCompanionSource(target: AssistantLinkTarget): boolean {
  for (let index = openSources.length - 1; index >= 0; index -= 1) {
    if (openSources[index].open(target)) return true;
  }
  return false;
}

/**
 * Start each test case closed, on Chat, as a machine that opened it before.
 * @testonly
 */
export function resetCompanionPanelForTests(patch: Partial<CompanionPanelState> = {}): void {
  focusSeq = 0;
  requests = [];
  returnFocusTo = null;
  openSources = [];
  screen = null;
  targetScreen = null;
  state = { open: false, tab: 'chat', openedBefore: true, ...CLOSED, ...patch };
  for (const listener of [...listeners]) listener();
}
