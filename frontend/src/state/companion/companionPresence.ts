import type { CompanionPresenceInput } from 'michi-shared';
import { WINDOW_ID } from '../../config/windowIdentity';
import { CompanionApiError, postCompanionPresence } from '../../services/api/companion';
import { getCompanionPanelState, subscribeCompanionPanel } from './companionPanel';
import { getCompanionState } from './companionStore';

/**
 * The renderer's activity beacon (POST /api/companion/presence): whether
 * the window is in use, whether the Companion panel has focus, the last
 * input, and whether the user is writing to the Companion, under this
 * window's id (the backend hears every window on its own, DESIGN §3.2). The backend uses
 * it for "Since you left", away mode and to keep hidden turns out of the
 * user's way: `composing` goes out at once (the user goes first), every
 * other change at most every 5s, and while the user is active a beacon
 * every 60s.
 */

/** Input this recent counts as "the user acted recently". */
const ACTIVE_INPUT_MS = 5 * 60_000;
const KEEPALIVE_MS = 60_000;
const MIN_GAP_MS = 5_000;
/** While the user keeps typing, `composing` is repeated this often. */
const COMPOSING_REPEAT_MS = 10_000;
const PANEL_SELECTOR = '[data-companion-panel]';

let users = 0;
let lastInputAt: number | null = null;
/** The last click or tap landed in the panel: reading V there, focus on nothing focusable, still counts as in the panel. */
let pointerInPanel = false;
let composing = false;
let lastSent: { key: string; at: number; composing: boolean } | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribePanel: (() => void) | null = null;
/** This backend refused the beacon outright (no route): stop sending. */
let refused = false;

function currentInput(now: number, composingNow = composing): CompanionPresenceInput {
  const focused = !document.hidden && document.hasFocus();
  const recent = lastInputAt !== null && now - lastInputAt < ACTIVE_INPUT_MS;
  const active = document.activeElement;
  const onNothing = !active || active === document.body;
  const inPanel = getCompanionPanelState().open && focused && (onNothing ? pointerInPanel : !!active.closest(PANEL_SELECTOR));
  return { active: focused && recent, companionFocused: inPanel, lastInputAt, composing: composingNow && inPanel, ...(WINDOW_ID ? { windowId: WINDOW_ID } : {}) };
}

const keyOf = (input: CompanionPresenceInput) => `${input.active}|${input.companionFocused}|${input.composing}`;

function post(input: CompanionPresenceInput, now: number): void {
  lastSent = { key: keyOf(input), at: now, composing: input.composing };
  postCompanionPresence(input).catch((error: unknown) => {
    if (error instanceof CompanionApiError && (error.status === 404 || error.unavailable)) refused = true;
  });
}

function send(reason: 'change' | 'keepalive'): void {
  if (users === 0 || refused || getCompanionState().availability !== 'available') return;
  const now = Date.now();
  const input = currentInput(now);
  const composingEdge = input.composing && (!lastSent?.composing || now - lastSent.at >= COMPOSING_REPEAT_MS);
  if (!composingEdge) {
    if (reason === 'change' && lastSent?.key === keyOf(input)) return;
    if (reason === 'keepalive' && !input.active) return;
    if (lastSent && now - lastSent.at < MIN_GAP_MS) {
      throttleTimer ??= setTimeout(() => { throttleTimer = null; send('change'); }, MIN_GAP_MS - (now - lastSent.at));
      return;
    }
  }
  post(input, now);
}

const onChange = () => send('change');
const onInput = (event: Event) => {
  const wasActive = lastInputAt !== null && Date.now() - lastInputAt < ACTIVE_INPUT_MS;
  lastInputAt = Date.now();
  const wasInPanel = pointerInPanel;
  if (event.type === 'pointerdown') pointerInPanel = event.target instanceof Element && !!event.target.closest(PANEL_SELECTOR);
  if (!wasActive || wasInPanel !== pointerInPanel) send('change');
};

/**
 * The Companion composer got focus or input (true), or lost it (false).
 * True goes to the backend right away.
 */
export function noteCompanionComposing(on: boolean): void {
  if (on) lastInputAt = Date.now();
  if (composing === on && !on) return;
  composing = on;
  send('change');
}

/** Stop in the "Checking in…" row: tell the backend the user goes first, now. */
export function preemptCompanionTurn(): void {
  if (users === 0 || refused || getCompanionState().availability !== 'available') return;
  const now = Date.now();
  lastInputAt = now;
  post({ ...currentInput(now, true), composing: true }, now);
}

/** Send beacons while the caller is mounted (the shell, once the workspaces loaded). Returns release. */
export function startCompanionPresence(): () => void {
  users += 1;
  if (users === 1) {
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    document.addEventListener('visibilitychange', onChange);
    document.addEventListener('focusin', onChange);
    window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
    window.addEventListener('keydown', onInput, { capture: true, passive: true });
    unsubscribePanel = subscribeCompanionPanel(onChange);
    keepaliveTimer = setInterval(() => send('keepalive'), KEEPALIVE_MS);
    if (document.hasFocus()) lastInputAt ??= Date.now();
    send('change');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0) detach();
  };
}

function detach(): void {
  window.removeEventListener('focus', onChange);
  window.removeEventListener('blur', onChange);
  document.removeEventListener('visibilitychange', onChange);
  document.removeEventListener('focusin', onChange);
  window.removeEventListener('pointerdown', onInput, { capture: true });
  window.removeEventListener('keydown', onInput, { capture: true });
  unsubscribePanel?.();
  unsubscribePanel = null;
  if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  if (throttleTimer !== null) clearTimeout(throttleTimer);
  throttleTimer = null;
}

/**
 * Forget beacons between test cases.
 * @testonly
 */
export function resetCompanionPresenceForTests(): void {
  if (typeof window !== 'undefined') detach();
  users = 0;
  lastInputAt = null;
  pointerInPanel = false;
  composing = false;
  lastSent = null;
  refused = false;
}
