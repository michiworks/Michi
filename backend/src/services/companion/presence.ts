/**
 * Where the user is, as the renderer's beacons (POST /companion/presence)
 * report it. In memory only, like panePresence: a restart knows nothing
 * until the next beacon, and counts as "here" until away mode says otherwise.
 *
 * The coordinator reads it to keep hidden turns out of the user's way
 * (DESIGN R2.8): no hidden turn starts while the user types to the
 * Companion, a `composing` beacon stops a running one, and two hours without
 * an active beacon is away mode (polling only, no heartbeat or wake; a brief
 * that came due waits for the user's return). The notice gate reads whether
 * the Companion panel is focused (what it shows needs no desktop notice), and
 * so does automatic memory, through an instance server.ts feeds the same
 * beacons: V, which the panel shows and which reports no pane presence,
 * counts as shown while the panel has focus, and as left once it loses it.
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
  /** The Companion panel had focus and no longer has: the user left the conversation it shows (V). */
  leftPanel: boolean;
}

export interface CompanionPresenceState {
  active: boolean;
  companionFocused: boolean;
  composing: boolean;
  lastInputAt: number | null;
  lastBeaconAt: number | null;
  /** The last time the user was known to be here (an active beacon, or the start). */
  lastActiveAt: number;
  /** Since when the user is away; null when not in away mode. */
  awaySince: number | null;
}

export class CompanionPresence {
  private beacon: CompanionPresenceInput | null = null;
  private beaconAt: number | null = null;
  private lastActiveAt: number;

  /** `startedAt` counts as a moment the user was here, so a fresh start is not away mode. */
  constructor(startedAt: number) {
    this.lastActiveAt = startedAt;
  }

  update(input: CompanionPresenceInput, now: number): CompanionPresenceUpdate {
    const wasAway = this.isAway(now);
    const wasFocused = this.isPanelFocused(now);
    this.beacon = {
      active: input.active === true,
      companionFocused: input.companionFocused === true,
      lastInputAt: typeof input.lastInputAt === 'number' && Number.isFinite(input.lastInputAt) ? input.lastInputAt : null,
      composing: input.composing === true,
    };
    this.beaconAt = now;
    const here = this.beacon.active || this.beacon.companionFocused || this.beacon.composing;
    if (here) this.lastActiveAt = Math.max(this.lastActiveAt, now);
    return { composing: this.beacon.composing, returned: wasAway && here, leftPanel: wasFocused && !this.beacon.companionFocused };
  }

  private current(now: number): CompanionPresenceInput | null {
    if (this.beacon === null || this.beaconAt === null) return null;
    return now - this.beaconAt <= COMPANION_BEACON_TTL_MS ? this.beacon : null;
  }

  /** The Michi window is focused and the user acted recently. */
  isActive(now: number): boolean {
    return this.current(now)?.active === true;
  }

  /** The Companion panel is open and focused. */
  isPanelFocused(now: number): boolean {
    return this.current(now)?.companionFocused === true;
  }

  isComposing(now: number): boolean {
    return this.current(now)?.composing === true;
  }

  /** The user is typing to the Companion: composing, or input in its focused panel within the last minute. */
  isUserTyping(now: number): boolean {
    const beacon = this.current(now);
    if (!beacon) return false;
    if (beacon.composing) return true;
    return beacon.companionFocused && beacon.lastInputAt !== null && now - beacon.lastInputAt < COMPANION_TYPING_WINDOW_MS;
  }

  /** Away mode: no active beacon for COMPANION_LIMITS.awayModeAfterMinutes. */
  isAway(now: number): boolean {
    const beacon = this.current(now);
    if (beacon && (beacon.active || beacon.companionFocused || beacon.composing)) return false;
    return now - this.lastActiveAt >= COMPANION_AWAY_AFTER_MS;
  }

  state(now: number): CompanionPresenceState {
    const beacon = this.current(now);
    return {
      active: beacon?.active === true,
      companionFocused: beacon?.companionFocused === true,
      composing: beacon?.composing === true,
      lastInputAt: this.beacon?.lastInputAt ?? null,
      lastBeaconAt: this.beaconAt,
      lastActiveAt: this.lastActiveAt,
      awaySince: this.isAway(now) ? this.lastActiveAt : null,
    };
  }
}
