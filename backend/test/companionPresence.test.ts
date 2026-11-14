/**
 * Where the user is (presence.ts, DESIGN §3.2): every window's beacon on its
 * own, a remote one's too, and the computer's idle time from Electron main,
 * so working in another app is not away; a beacon is believed for a short
 * while only. Pure: no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_AWAY_AFTER_MS, COMPANION_BEACON_TTL_MS, CompanionPresence } from '../src/services/companion/presence';

const T0 = 1_000_000_000;
const beacon = (windowId: string | undefined, fields: Partial<{ active: boolean; companionFocused: boolean; composing: boolean; lastInputAt: number | null }>) => ({
  active: false, companionFocused: false, composing: false, lastInputAt: null, ...(windowId ? { windowId } : {}), ...fields,
});

test('each window is heard on its own: one blurred window does not hide another that is in use', () => {
  const presence = new CompanionPresence(T0);
  presence.update(beacon('w-panel', { active: true, companionFocused: true }), T0);
  const blurred = presence.update(beacon('w-other', {}), T0 + 1_000);
  assert.deepEqual([presence.isActive(T0 + 1_000), presence.isPanelFocused(T0 + 1_000)], [true, true], 'the panel window still says so');
  assert.equal(blurred.leftPanel, false);
  const left = presence.update(beacon('w-panel', { active: true }), T0 + 2_000);
  assert.deepEqual([left.leftPanel, left.enteredPanel], [true, false]);
  const entered = presence.update(beacon('w-remote', { companionFocused: true }), T0 + 3_000);
  assert.deepEqual([entered.enteredPanel, presence.isPanelFocused(T0 + 3_000)], [true, true], 'a remote window counts');
  assert.equal(presence.isPanelFocused(T0 + 3_000 + COMPANION_BEACON_TTL_MS + 1), false, 'a beacon is believed for a while only');
});

test('composing and typing in any window; a beacon without a window id is one unnamed window', () => {
  const presence = new CompanionPresence(T0);
  assert.equal(presence.update(beacon(undefined, { companionFocused: true, composing: true }), T0).composing, true);
  presence.update(beacon('w-2', {}), T0 + 1);
  assert.equal(presence.isUserTyping(T0 + 2), true);
  presence.update(beacon(undefined, { companionFocused: true, lastInputAt: T0 + 10 }), T0 + 20);
  assert.deepEqual([presence.isComposing(T0 + 20), presence.isUserTyping(T0 + 20)], [false, true], 'input in the focused panel within the minute');
});

test('input anywhere on the computer is here: away only after two hours without it, and back with it', () => {
  const presence = new CompanionPresence(T0);
  presence.update(beacon('w-1', {}), T0 + COMPANION_AWAY_AFTER_MS - 1);
  // The user works in another app: Electron main reports a short idle time.
  const system = presence.update({ ...beacon(undefined, {}), systemIdleSeconds: 30 }, T0 + COMPANION_AWAY_AFTER_MS);
  assert.equal(system.composing, false);
  assert.equal(presence.isAway(T0 + COMPANION_AWAY_AFTER_MS + 60_000), false, 'here 30 s ago');
  assert.equal(presence.isPanelFocused(T0 + COMPANION_AWAY_AFTER_MS), false, 'a system beacon says nothing about any window');
  const idleSince = T0 + COMPANION_AWAY_AFTER_MS - 30_000;
  presence.update({ ...beacon(undefined, {}), systemIdleSeconds: COMPANION_AWAY_AFTER_MS / 1000 }, idleSince + COMPANION_AWAY_AFTER_MS);
  assert.equal(presence.isAway(idleSince + COMPANION_AWAY_AFTER_MS), true, 'two hours without input');
  const back = presence.update({ ...beacon(undefined, {}), systemIdleSeconds: 2 }, idleSince + COMPANION_AWAY_AFTER_MS + 10_000);
  assert.equal(back.returned, true, 'input on the computer brings the user back');
  assert.equal(presence.state(idleSince + COMPANION_AWAY_AFTER_MS + 10_000).awaySince, null);
});
