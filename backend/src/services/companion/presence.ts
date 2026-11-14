/**
 * Where the user is (DESIGN §3.2): every window's beacon
 * (POST /companion/presence, a remote window's included, each heard on its
 * own by its windowId), and the system's idle time that Electron main reports
 * (`systemIdleSeconds`), so working in another app counts as here. In memory
 * only, like panePresence: a restart knows nothing until the next beacon, and
 * counts as "here" until away mode says otherwise.
 *
 * The coordinator reads it to keep hidden turns out of the user's way
 * (DESIGN R2.8): no hidden turn starts while the user types to the
 * Companion, a `composing` beacon stops a running one, and two hours with no
 * window active and no input on the computer is away mode (polling only, no
 * heartbeat or wake; a brief that came due waits for the user's return).
 * Michi's notices read whether the Companion panel is focused in some window
 * (a reply it shows needs no notice), and so does automatic memory, through
 * an instance server.ts feeds the same beacons: V, which the panel shows and
 * which reports no pane presence, counts as shown while the panel has focus,
 * and as left once it loses it.
 *
 * A beacon is believed for a short while only (COMPANION_BEACON_TTL_MS):
 * beacons come on every change and every 60 s while the user is active, so
 * a window that quit without a last word must not keep the Companion
 * "focused" or the user "typing" forever.
 *
 * The deterministic "Since you left" is not built here: POST /companion/view
 * builds it from the feed and keeps it for the snapshot
 * (repository.recordCompanionView, latestCatchUp).
 */

import { COMPANION_LIMITS, type CompanionPresenceInput } from 'michi-shared';

const MINUTE_MS = 60_000;

/** How long one beacon is believed. */
export const COMPANION_BEACON_TTL_MS = 150_000;
/** Input in the focused Companion panel this recent means the user is typing to it. */
export const COMPANION_TYPING_WINDOW_MS = 60_000;
/** No active beacon for this long: away mode (R2.8). */
export const COMPANION_AWAY_AFTER_MS = COMPANION_LIMITS.awayModeAfterMinutes * MINUTE_MS;

export interface CompanionPresenceUpdate {
  /** The beacon says the user is composing to the Companion: a running hidden turn should yield. */
  composing: boolean;
  /** The user is back from away mode: what waited for them (a brief) may go now. */
  returned: boolean;
  /** The Companion panel had focus in some window and now has it in none: the user left the conversation it shows (V). */
  leftPanel: boolean;
  /** The Companion panel had focus in no window and now has it in one. */
  enteredPanel: boolean;
}

export interface CompanionPresenceState {
  active: boolean;
  companionFocused: boolean;
  composing: boolean;
  lastInputAt: number | null;
  lastBeaconAt: number | null;
  /** The last time the user was known to be here (an active beacon, input on the computer, or the start). */
  lastActiveAt: number;
  /** Since when the user is away; null when not in away mode. */
  awaySince: number | null;
}

type WindowBeacon = Omit<CompanionPresenceInput, 'windowId' | 'systemIdleSeconds'>;

/** Windows heard at once; the one heard least recently goes first past it. */
const MAX_WINDOWS = 20;
const UNNAMED_WINDOW = '';
const WINDOW_ID_MAX = 200;

export class CompanionPresence {
  /** Each window's last beacon and when it came, least recent first. */
  private readonly windows = new Map<string, { beacon: WindowBeacon; at: number }>();
  private lastBeaconAt: number | null = null;
  private lastActiveAt: number;

  /** `startedAt` counts as a moment the user was here, so a fresh start is not away mode. */
  constructor(startedAt: number) {
    this.lastActiveAt = startedAt;
  }

  update(input: CompanionPresenceInput, now: number): CompanionPresenceUpdate {
    const wasAway = this.isAway(now);
    const wasFocused = this.isPanelFocused(now);
    this.lastBeaconAt = now;
    let composing = false;
    if (typeof input.systemIdleSeconds === 'number' && Number.isFinite(input.systemIdleSeconds) && input.systemIdleSeconds >= 0) {
      // The computer's last input: the user is here as of then, whichever app they used.
      this.lastActiveAt = Math.max(this.lastActiveAt, Math.min(now, now - input.systemIdleSeconds * 1000));
    } else {
      const beacon: WindowBeacon = {
        active: input.active === true,
        companionFocused: input.companionFocused === true,
        lastInputAt: typeof input.lastInputAt === 'number' && Number.isFinite(input.lastInputAt) ? input.lastInputAt : null,
        composing: input.composing === true,
      };
      const windowId = typeof input.windowId === 'string' && input.windowId.length <= WINDOW_ID_MAX ? input.windowId : UNNAMED_WINDOW;
      this.windows.delete(windowId);
      this.windows.set(windowId, { beacon, at: now });
      while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value as string);
      if (beacon.active || beacon.companionFocused || beacon.composing) this.lastActiveAt = Math.max(this.lastActiveAt, now);
      composing = beacon.composing;
    }
    const focused = this.isPanelFocused(now);
    return { composing, returned: wasAway && !this.isAway(now), leftPanel: wasFocused && !focused, enteredPanel: !wasFocused && focused };
  }

  /** The beacons still believed. */
  private current(now: number): WindowBeacon[] {
    const beacons: WindowBeacon[] = [];
    for (const { beacon, at } of this.windows.values()) if (now - at <= COMPANION_BEACON_TTL_MS) beacons.push(beacon);
    return beacons;
  }

  /** A Michi window is focused and the user acted recently. */
  isActive(now: number): boolean {
    return this.current(now).some((beacon) => beacon.active);
  }

  /** The Companion panel is open and focused in some window. */
  isPanelFocused(now: number): boolean {
    return this.current(now).some((beacon) => beacon.companionFocused);
  }

  isComposing(now: number): boolean {
    return this.current(now).some((beacon) => beacon.composing);
  }

  /** The user is typing to the Companion: composing, or input in its focused panel within the last minute. */
  isUserTyping(now: number): boolean {
    return this.current(now).some((beacon) => beacon.composing
      || (beacon.companionFocused && beacon.lastInputAt !== null && now - beacon.lastInputAt < COMPANION_TYPING_WINDOW_MS));
  }

  /** Away mode: no window active and no input on the computer for COMPANION_LIMITS.awayModeAfterMinutes. */
  isAway(now: number): boolean {
    if (this.current(now).some((beacon) => beacon.active || beacon.companionFocused || beacon.composing)) return false;
    return now - this.lastActiveAt >= COMPANION_AWAY_AFTER_MS;
  }

  state(now: number): CompanionPresenceState {
    const beacons = this.current(now);
    const inputs = [...this.windows.values()].map(({ beacon }) => beacon.lastInputAt).filter((at): at is number => at !== null);
    return {
      active: beacons.some((beacon) => beacon.active),
      companionFocused: beacons.some((beacon) => beacon.companionFocused),
      composing: beacons.some((beacon) => beacon.composing),
      lastInputAt: inputs.length > 0 ? Math.max(...inputs) : null,
      lastBeaconAt: this.lastBeaconAt,
      lastActiveAt: this.lastActiveAt,
      awaySince: this.isAway(now) ? this.lastActiveAt : null,
    };
  }
}
