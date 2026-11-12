import { useSyncExternalStore } from 'react';
import {
  isOpenCompanionItem,
  type CompanionCatchUpDto,
  type CompanionChangedEvent,
  type CompanionItemAction,
  type CompanionItemDto,
  type CompanionSettings,
} from 'michi-shared';
import {
  fetchCompanion,
  isCompanionUnavailable,
  postCompanionItemAction,
  postCompanionItemsSeen,
  postCompanionView,
  requestCompanionWelcome,
  type CompanionSnapshot,
} from '../../services/api/companion';
import {
  AssistantApiError,
  fetchAssistant,
  isAssistantInfo,
  isAssistantMissing,
  type AssistantInfo,
} from '../../services/api/assistant';
import type { AssistantConversationSource } from '../assistant/assistantSource';

/**
 * Window-wide state of the Companion (DESIGN §9, R2.12): the last snapshot
 * the backend confirmed, with this window's item actions applied while they
 * are on their way. The change feed (companionFeed.ts) asks for a fresh read
 * 150ms after the backend says something changed; while the panel is on
 * screen a 60s read backs it up.
 *
 * Hydration barrier: a backend that cannot be reached keeps the last snapshot
 * on screen (marked stale), never an empty one. `unavailable` (a 404 or an
 * answer of another shape before any snapshot arrived) means this backend has
 * no Companion: no button, no panel, no feed.
 */

export type CompanionAvailability = 'unknown' | 'available' | 'unavailable';

export interface CompanionStoreState {
  availability: CompanionAvailability;
  /** What the window shows: the confirmed snapshot plus pending item actions; open items only. */
  snapshot: CompanionSnapshot | null;
  /** The last read failed: the snapshot may be out of date. */
  stale: boolean;
  /**
   * When this window first saw each item that arrived after its first
   * snapshot (epoch ms); items it hydrated with are absent and never play an
   * entrance.
   */
  arrivals: Readonly<Record<string, number>>;
  /** The latest "Since you left" the panel was given (POST /companion/view). */
  catchUp: CompanionCatchUpDto | null;
}

const REFRESH_DEBOUNCE_MS = 150;
const POLL_MS = 60_000;
const VIEW_THROTTLE_MS = 30_000;
/** Between welcome asks for a conversation that stays empty: 30s, doubling to 10 minutes. */
const WELCOME_RETRY_MIN_MS = 30_000;
const WELCOME_RETRY_MAX_MS = 10 * 60_000;
/** POST /companion/items/seen takes at most this many ids. */
const SEEN_BATCH = 100;
/** After a failed seen mark, the next waits 5s, doubling to 1 minute. */
const SEEN_RETRY_MIN_MS = 5_000;
const SEEN_RETRY_MAX_MS = 60_000;

const INITIAL: CompanionStoreState = { availability: 'unknown', snapshot: null, stale: false, arrivals: {}, catchUp: null };

let state: CompanionStoreState = INITIAL;
/** The last snapshot the backend confirmed, with the answers of actions merged in. */
let confirmed: CompanionSnapshot | null = null;
const listeners = new Set<() => void>();

interface PendingAction { seq: number; apply: (item: CompanionItemDto) => CompanionItemDto }
const pending = new Map<string, PendingAction>();
let actionSeq = 0;
/** Bumps whenever an action's answer lands: a read that started before it is out of date. */
let actionEpoch = 0;

/** Seen marks that failed in a row, and when the next may go out. */
let seenFailures = 0;
let seenRetryAt = 0;

/** Item ids this window has seen in a snapshot; null before the first. */
let seenItemIds: Set<string> | null = null;
let arrivals: Record<string, number> = {};
/** Every conversation the Companion has had in this window (a reset makes a new one). */
const nodeIds = new Set<string>();

/** The welcome asks for one conversation (wantCompanionWelcome). */
interface WelcomeAsk {
  /** Chat tabs showing nothing of it, the user not having written, while the Companion may speak. */
  wanted: number;
  inFlight: boolean;
  /** Asks answered so far; still being wanted means none of them led anywhere. */
  attempts: number;
  /** The next ask may go out from then. */
  nextAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const welcomeAsks = new Map<string, WelcomeAsk>();

let generation = 0;
let inflight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let panelVisible = false;
let lastViewAt = 0;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function set(patch: Partial<CompanionStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

/** The confirmed snapshot with pending actions applied, open items only, counts to match. */
function view(base: CompanionSnapshot | null, now = Date.now()): CompanionSnapshot | null {
  if (!base) return null;
  const items = base.items
    .map((item) => pending.get(item.id)?.apply(item) ?? item)
    .filter((item) => isOpenCompanionItem(item, now));
  return {
    ...base,
    items,
    counts: {
      ...base.counts,
      needsYou: items.filter((item) => item.bucket === 'needs_you').length,
      newItems: items.filter((item) => item.status === 'new').length,
    },
  };
}

function publish(patch: Partial<CompanionStoreState> = {}): void {
  set({ ...patch, snapshot: view(confirmed), arrivals });
}

function noteArrivals(snapshot: CompanionSnapshot): void {
  const ids = snapshot.items.map((item) => item.id);
  if (seenItemIds === null) {
    seenItemIds = new Set(ids);
    return;
  }
  const now = Date.now();
  let next: Record<string, number> | null = null;
  for (const id of ids) {
    if (seenItemIds.has(id)) continue;
    seenItemIds.add(id);
    next ??= { ...arrivals };
    next[id] = now;
  }
  if (next) arrivals = next;
}

/**
 * Per machine (small UI state, localStorage): a brief has reached this
 * machine before, so Today announces the next one as "Next brief", not as
 * the first.
 */
const BRIEF_SEEN_KEY = 'michi:companion:brief-seen';
let briefSeen: boolean | null = null;

function noteBriefSeen(): void {
  if (briefSeen === true) return;
  briefSeen = true;
  try {
    window.localStorage.setItem(BRIEF_SEEN_KEY, '1');
  } catch {
    // Storage unavailable: a later window may word the next brief as the first.
  }
}

/** Some window on this machine has had a brief from the Companion. */
export function companionBriefSeenBefore(): boolean {
  if (briefSeen === null) {
    try {
      briefSeen = window.localStorage.getItem(BRIEF_SEEN_KEY) === '1';
    } catch {
      briefSeen = true;
    }
  }
  return briefSeen;
}

/**
 * Where the agent's one conversation V lives (`GET /api/assistant`):
 * `unsupported` (a 404 or an answer of another shape) is final, the button
 * and the panel's Chat then never show. The Companion snapshot is not needed:
 * without it only Today and the badge go without (§1.3).
 */
export type CompanionAssistantStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

export interface CompanionAssistantState {
  status: CompanionAssistantStatus;
  info: AssistantInfo | null;
  error: string | null;
}

let assistant: CompanionAssistantState = { status: 'idle', info: null, error: null };
let assistantInflight: Promise<void> | null = null;

/**
 * Bumps whenever this window adopts a conversation it was answered with (New
 * conversation, History's activate, a 409, a fresh /assistant read): a
 * snapshot read that started before it names the conversation as it was
 * then, so it must not switch the panel back (F1a-review #11).
 */
let assistantEpoch = 0;

function adopt(snapshot: CompanionSnapshot, readAtAssistantEpoch = assistantEpoch): void {
  if (snapshot.conversation) nodeIds.add(snapshot.conversation.nodeId);
  // The snapshot's conversation is the same one (DESIGN-v2 §1.3); a newer one (New conversation elsewhere) is followed,
  // unless this window adopted another conversation after the read began.
  const viaSnapshot = snapshot.conversation?.assistant;
  if (viaSnapshot && assistant.status !== 'unsupported' && assistant.info?.nodeId !== viaSnapshot.nodeId
    && readAtAssistantEpoch === assistantEpoch) {
    setAssistant({ status: 'ready', info: viaSnapshot, error: null });
  }
  if (snapshot.brief) noteBriefSeen();
  noteArrivals(snapshot);
  confirmed = snapshot;
  publish({ availability: 'available', stale: false });
}

export function getCompanionState(): CompanionStoreState {
  return state;
}

export function subscribeCompanion(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCompanion(): CompanionStoreState {
  return useSyncExternalStore(subscribeCompanion, getCompanionState, getCompanionState);
}

/**
 * Reads the snapshot now (shared while one read is on its way). A read that
 * an item action's answer overtook may predate it: it is dropped, not shown,
 * and runs again.
 */
export function refreshCompanion(): Promise<void> {
  if (state.availability === 'unavailable') return Promise.resolve();
  if (inflight) return inflight;
  const mine = ++generation;
  const epoch = actionEpoch;
  const conversationEpoch = assistantEpoch;
  inflight = fetchCompanion()
    .then((snapshot) => {
      if (mine !== generation) return;
      if (epoch !== actionEpoch && confirmed) return;
      adopt(snapshot, conversationEpoch);
    })
    .catch((error: unknown) => {
      if (mine !== generation) return;
      // Nothing seen yet: this backend has no Companion. Once one answered,
      // a wrong answer is a hiccup like any failure: keep what is shown.
      if (isCompanionUnavailable(error) && !confirmed) set({ availability: 'unavailable' });
      else set({ stale: true });
    })
    .finally(() => {
      if (mine === generation) inflight = null;
      if (mine === generation && epoch !== actionEpoch && state.availability === 'available') scheduleCompanionRefresh(0);
    });
  return inflight;
}

/** The first read, once; later calls are no-ops while a snapshot is in. */
export function loadCompanion(): Promise<void> {
  if (confirmed || state.availability === 'unavailable') return Promise.resolve();
  return refreshCompanion();
}

export function scheduleCompanionRefresh(delayMs = REFRESH_DEBOUNCE_MS): void {
  if (state.availability === 'unavailable') return;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshCompanion();
  }, delayMs);
}

/** A `companion_changed` frame: read again (debounced) unless this window already has that revision. */
export function noteCompanionChanged(event: Pick<CompanionChangedEvent, 'revision'>): void {
  if (confirmed && event.revision === confirmed.revision && !state.stale) return;
  scheduleCompanionRefresh();
}

/**
 * A snapshot another call answered with (settings, a reset). A read already
 * on its way began before that change: it is dropped and runs again.
 */
export function adoptCompanionSnapshot(snapshot: CompanionSnapshot): void {
  actionEpoch += 1;
  adopt(snapshot);
}

/**
 * Applies a local change to the confirmed snapshot (an answer that carries
 * one record: saved notes or rules, a decided card), until the next read. A
 * read already on its way predates it and would put the old record back: it
 * is dropped and runs again.
 */
export function updateCompanionSnapshot(recipe: (snapshot: CompanionSnapshot) => CompanionSnapshot): void {
  if (!confirmed) return;
  actionEpoch += 1;
  confirmed = recipe(confirmed);
  publish();
}

function applyAction(item: CompanionItemDto, action: CompanionItemAction, now: number): CompanionItemDto {
  switch (action.action) {
    case 'seen': return item.status === 'new' ? { ...item, status: 'seen' } : item;
    case 'snooze': return { ...item, status: 'snoozed', snoozedUntil: action.until, updatedAt: now };
    case 'dismiss': return { ...item, status: 'dismissed', updatedAt: now };
    case 'mute': return { ...item, status: 'muted', updatedAt: now };
    case 'restore': return { ...item, status: 'seen', snoozedUntil: null, updatedAt: now };
    case 'feedback': return { ...item, feedback: action.feedback, feedbackReason: action.feedback === 'down' ? action.reason ?? null : null, updatedAt: now };
  }
}

function settle(id: string, seq: number, answer: CompanionItemDto | null): void {
  if (pending.get(id)?.seq === seq) pending.delete(id);
  if (answer && confirmed) {
    const known = confirmed.items.some((item) => item.id === id);
    // An item the snapshot no longer lists (restored after the panel left it) comes back on the next read.
    confirmed = { ...confirmed, items: known ? confirmed.items.map((item) => (item.id === id ? answer : item)) : confirmed.items };
  }
  actionEpoch += 1;
  publish();
}

/** `system:source:<kind>`: a source's trouble item, out of sight while that source is off. */
const SOURCE_TROUBLE_KEY_PREFIX = 'system:source:';

/**
 * The item shows on Today: it is open, and its source is on. The backend
 * keeps an off source's items, and that source's trouble item, out of the
 * snapshot (repository hiddenItems), so a restore of one is not "back on
 * Today" (W3-F3-review #1).
 */
export function companionItemShowsOnToday(
  item: Pick<CompanionItemDto, 'status' | 'snoozedUntil' | 'source' | 'itemKey'>,
  settings: Pick<CompanionSettings, 'sources'> | null | undefined,
  now = Date.now(),
): boolean {
  if (!isOpenCompanionItem(item, now)) return false;
  const kind = item.itemKey.startsWith(SOURCE_TROUBLE_KEY_PREFIX) ? item.itemKey.slice(SOURCE_TROUBLE_KEY_PREFIX.length) : item.source;
  const sources = settings?.sources as Readonly<Record<string, { enabled?: boolean } | undefined>> | undefined;
  return sources?.[kind]?.enabled !== false;
}

/**
 * An item action, shown at once and confirmed by the backend's answer. A
 * refusal rolls it back and rejects so the caller can say so.
 */
export async function actOnCompanionItem(id: string, action: CompanionItemAction): Promise<CompanionItemDto> {
  const seq = ++actionSeq;
  const now = Date.now();
  // A restore must also bring back an item the window no longer lists (Undo), when Today would show
  // it: one that resolved meanwhile, or whose source is off, stays off the list.
  if (action.action === 'restore' && confirmed && !confirmed.items.some((item) => item.id === id)) {
    const answer = await postCompanionItemAction(id, action);
    if (confirmed && companionItemShowsOnToday(answer, confirmed.settings)) confirmed = { ...confirmed, items: [answer, ...confirmed.items] };
    actionEpoch += 1;
    publish();
    scheduleCompanionRefresh();
    return answer;
  }
  pending.set(id, { seq, apply: (item) => applyAction(item, action, now) });
  publish();
  try {
    const answer = await postCompanionItemAction(id, action);
    settle(id, seq, answer);
    scheduleCompanionRefresh();
    return answer;
  } catch (error) {
    settle(id, seq, null);
    throw error;
  }
}

/** The confirmed snapshot shows these items seen (until a read says otherwise). */
function keepSeen(ids: readonly string[]): void {
  if (!confirmed) return;
  const marked = new Set(ids);
  confirmed = { ...confirmed, items: confirmed.items.map((item) => (marked.has(item.id) && item.status === 'new' ? { ...item, status: 'seen' } : item)) };
}

/**
 * Marks these items seen (the user has them on screen), at most
 * SEEN_BATCH a request. The mark stays on screen whether or not the backend
 * took it: a failed one is tried again only when a later snapshot still
 * says new, and not before the backoff after the last failure ends, so a
 * backend that is down or refuses is never asked in a loop. (Reverting the
 * mark would re-trigger whoever made it: Today marks what it shows.)
 */
export function markCompanionItemsSeen(ids: readonly string[], now = Date.now()): void {
  const fresh = ids.filter((id) => {
    const item = state.snapshot?.items.find((entry) => entry.id === id);
    return item?.status === 'new' && !pending.has(id);
  }).slice(0, SEEN_BATCH);
  if (fresh.length === 0) return;
  if (now < seenRetryAt) {
    keepSeen(fresh);
    publish();
    return;
  }
  const seq = ++actionSeq;
  for (const id of fresh) pending.set(id, { seq, apply: (item) => (item.status === 'new' ? { ...item, status: 'seen' } : item) });
  publish();
  postCompanionItemsSeen(fresh)
    .then(() => {
      seenFailures = 0;
      seenRetryAt = 0;
      keepSeen(fresh);
      // Only an answer that changed the backend outdates a read on its way.
      actionEpoch += 1;
    }, () => {
      seenFailures += 1;
      seenRetryAt = Date.now() + Math.min(SEEN_RETRY_MAX_MS, SEEN_RETRY_MIN_MS * 2 ** Math.min(seenFailures - 1, 10));
      keepSeen(fresh);
    })
    .finally(() => {
      for (const id of fresh) if (pending.get(id)?.seq === seq) pending.delete(id);
      publish();
    });
}

/**
 * The panel came on screen or got focus (POST /companion/view): the backend
 * notes the view and clears the unread count, and answers "Since you left"
 * when the user was away long enough. At most once per 30s.
 */
export function noteCompanionViewed(now = Date.now()): void {
  if (state.availability !== 'available' || now - lastViewAt < VIEW_THROTTLE_MS) return;
  lastViewAt = now;
  if (confirmed && confirmed.counts.unreadMessages > 0) {
    confirmed = { ...confirmed, counts: { ...confirmed.counts, unreadMessages: 0 } };
    publish();
  }
  postCompanionView().then((catchUp) => {
    if (catchUp) set({ catchUp });
  }, () => {});
}

function welcomeRetryDelay(attempts: number): number {
  return Math.min(WELCOME_RETRY_MAX_MS, WELCOME_RETRY_MIN_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

function askWelcome(nodeId: string, ask: WelcomeAsk): void {
  if (welcomeAsks.get(nodeId) !== ask || ask.wanted === 0 || ask.inFlight || ask.timer !== null) return;
  const wait = ask.nextAt - Date.now();
  if (wait > 0) {
    ask.timer = setTimeout(() => { ask.timer = null; askWelcome(nodeId, ask); }, wait);
    return;
  }
  ask.inFlight = true;
  requestCompanionWelcome()
    .then((started) => { if (started) scheduleCompanionRefresh(); }, () => {})
    .finally(() => {
      ask.inFlight = false;
      ask.attempts += 1;
      ask.nextAt = Date.now() + welcomeRetryDelay(ask.attempts);
      // Still wanted means nothing shows yet: refused (paused, busy, not
      // ready yet), failed, or a welcome that never spoke. Ask again later.
      askWelcome(nodeId, ask);
    });
}

/**
 * The Chat tab shows nothing of this conversation, the user has not written
 * in it, and the Companion may speak (on, not paused): ask for its welcome
 * (R2.6). The backend decides. While that lasts the ask repeats, never two
 * at once, the wait between asks starting at 30s and doubling to 10 minutes.
 * A welcome that spoke shows, the user writing shows too, and the tab lets
 * go; one that ended quiet, stopped or failed leaves only rows the tab hides,
 * and the asks go on (the backend also tries again by itself). Returns the
 * release: the tab left, something shows, a hidden turn runs, or the
 * Companion was paused or turned off.
 */
export function wantCompanionWelcome(nodeId: string): () => void {
  let ask = welcomeAsks.get(nodeId);
  if (!ask) {
    ask = { wanted: 0, inFlight: false, attempts: 0, nextAt: 0, timer: null };
    welcomeAsks.set(nodeId, ask);
  }
  const mine = ask;
  mine.wanted += 1;
  askWelcome(nodeId, mine);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.wanted = Math.max(0, mine.wanted - 1);
    if (mine.wanted === 0 && mine.timer !== null) {
      clearTimeout(mine.timer);
      mine.timer = null;
    }
  };
}

/**
 * True for the Companion's conversation (this one or one it started over
 * from): its notices come from the backend's notice pipeline, and revealing it
 * opens the Companion panel.
 */
export function isCompanionNodeId(nodeId: string): boolean {
  return nodeIds.has(nodeId);
}

/**
 * isCompanionNodeId for a component: it renders again once the store learns
 * the conversation (a message drawn before /assistant answered, W3-F3-review #6).
 */
export function useIsCompanionNodeId(nodeId: string): boolean {
  const read = () => nodeIds.has(nodeId);
  return useSyncExternalStore(subscribeCompanion, read, read);
}

// ── the conversation (DESIGN-v2 §1.3: Chat needs only /assistant, never the snapshot) ──

function setAssistant(next: CompanionAssistantState): void {
  assistant = next;
  if (next.info) nodeIds.add(next.info.nodeId);
  emit();
}

export function getCompanionAssistant(): CompanionAssistantState {
  return assistant;
}

export function useCompanionAssistant(): CompanionAssistantState {
  return useSyncExternalStore(subscribeCompanion, getCompanionAssistant, getCompanionAssistant);
}

const getCompanionAssistantInfo = (): AssistantInfo | null => assistant.info;

/** Just where the conversation lives: re-renders only when that changes (every pane reads it). */
export function useCompanionAssistantInfo(): AssistantInfo | null {
  return useSyncExternalStore(subscribeCompanion, getCompanionAssistantInfo, getCompanionAssistantInfo);
}

/** Fetch (and on the first call provision) the conversation; shared while in flight. */
export function loadCompanionAssistant(): Promise<void> {
  if (assistant.status === 'unsupported' || assistant.status === 'ready') return Promise.resolve();
  if (assistantInflight) return assistantInflight;
  setAssistant({ ...assistant, status: 'loading', error: null });
  assistantInflight = fetchAssistant()
    .then((info) => {
      if (!isAssistantInfo(info)) throw new AssistantApiError(200, 'Unexpected assistant response', true);
      assistantEpoch += 1;
      setAssistant({ status: 'ready', info, error: null });
    })
    .catch((error: unknown) => {
      if (isAssistantMissing(error)) setAssistant({ status: 'unsupported', info: null, error: null });
      else setAssistant({ ...assistant, status: 'error', error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => { assistantInflight = null; });
  return assistantInflight;
}

/**
 * The backend answered with the conversation (a composer pick, New
 * conversation, History's activate, a 409 naming the current one): the panel
 * follows it. Ignored once this backend is known to have none.
 */
export function adoptCompanionAssistant(info: unknown): void {
  if (assistant.status === 'unsupported' || !isAssistantInfo(info)) return;
  assistantEpoch += 1;
  setAssistant({ status: 'ready', info, error: null });
  if (confirmed?.conversation && confirmed.conversation.nodeId === info.nodeId) {
    confirmed = { ...confirmed, conversation: { ...confirmed.conversation, assistant: info } };
    publish();
  }
}

const turnEndListeners = new Set<() => void>();

/**
 * Called after each turn of the agent's conversation ends (the old Spaces
 * window's after-turn effect, F1a-review #7): its info is read again, so a
 * runtime switch the turn made shows ("From here on: <runtime>"), and pages
 * listening for the turn's end (layout rules) refresh. A conversation that
 * changed meanwhile is left as it is. The chat store also re-reads the Pages
 * upkeep's state then (refreshMetaAgent), which imports this store's name.
 */
export function noteCompanionTurnEnded(nodeId: string): void {
  if (!nodeId || assistant.info?.nodeId !== nodeId) return;
  const epoch = assistantEpoch;
  fetchAssistant().then((next) => {
    if (assistantEpoch === epoch && isAssistantInfo(next) && next.nodeId === nodeId) adoptCompanionAssistant(next);
  }, () => { /* the next turn's end reads it again */ });
  for (const listener of [...turnEndListeners]) listener();
}

/** A turn of the agent's conversation ended (noteCompanionTurnEnded); returns the unsubscribe. */
export function subscribeCompanionTurnEnd(listener: () => void): () => void {
  turnEndListeners.add(listener);
  return () => { turnEndListeners.delete(listener); };
}

/** What the Chat tab's TPane needs as its assistantSource. */
export function companionAssistantSource(info: AssistantInfo | null): AssistantConversationSource {
  return {
    info,
    current: () => assistant.info,
    adopt: adoptCompanionAssistant,
    refetch: async () => {
      const next = await fetchAssistant();
      adoptCompanionAssistant(next);
      if (!isAssistantInfo(next)) throw new Error('The conversation is not available');
      return next;
    },
  };
}

function syncPoll(): void {
  const wanted = panelVisible && state.availability !== 'unavailable' && !(typeof document !== 'undefined' && document.hidden);
  if (wanted && pollTimer === null) pollTimer = setInterval(() => { void refreshCompanion(); }, POLL_MS);
  if (!wanted && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

const onVisibility = () => syncPoll();

/** The panel is on screen (or not): only then does a 60s read back the change feed up. */
export function setCompanionPanelVisible(visible: boolean): void {
  if (panelVisible === visible) return;
  panelVisible = visible;
  if (typeof document !== 'undefined') {
    if (visible) document.addEventListener('visibilitychange', onVisibility);
    else document.removeEventListener('visibilitychange', onVisibility);
  }
  syncPoll();
}

/**
 * Forget the snapshot, actions, timers and conversations between test cases.
 * @testonly
 */
export function resetCompanionStoreForTests(patch: Partial<CompanionStoreState> & { assistant?: CompanionAssistantState } = {}): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  if (pollTimer !== null) clearInterval(pollTimer);
  refreshTimer = null;
  pollTimer = null;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  panelVisible = false;
  generation += 1;
  inflight = null;
  pending.clear();
  actionSeq = 0;
  actionEpoch = 0;
  seenFailures = 0;
  seenRetryAt = 0;
  seenItemIds = null;
  arrivals = {};
  nodeIds.clear();
  for (const ask of welcomeAsks.values()) if (ask.timer !== null) clearTimeout(ask.timer);
  welcomeAsks.clear();
  lastViewAt = 0;
  briefSeen = null;
  assistantInflight = null;
  assistantEpoch = 0;
  assistant = patch.assistant ?? { status: 'idle', info: null, error: null };
  if (assistant.info) nodeIds.add(assistant.info.nodeId);
  confirmed = patch.snapshot ?? null;
  if (confirmed) {
    if (confirmed.conversation) nodeIds.add(confirmed.conversation.nodeId);
    seenItemIds = new Set(confirmed.items.map((item) => item.id));
  }
  const { assistant: _assistant, ...rest } = patch;
  void _assistant;
  state = { ...INITIAL, ...(confirmed ? { availability: 'available' as const } : {}), ...rest, snapshot: view(confirmed), arrivals: {} };
  emit();
}
