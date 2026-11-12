/**
 * Appearance shows focus dimming as a switch (Dim unfocused panes) and keeps
 * its strength under Advanced. The pref stays one number, focusDim 0–100:
 * off is 0, on is the strength. While it is off, the strength to come back to
 * is kept here, in this browser's localStorage, so turning it off and on
 * again keeps a strength someone chose.
 */
export const DEFAULT_DIM_STRENGTH = 20;
export const DIM_STRENGTH_MIN = 5;
const KEY = 'michi:focusDimStrength';

/** Where storage is unavailable, the strength lasts until the page reloads. */
let fallback: number | null = null;

const valid = (value: number) => Number.isFinite(value) && value >= DIM_STRENGTH_MIN && value <= 100;

/** The strength to turn dimming back on with. */
export function rememberedDimStrength(): number {
  let stored: number | null;
  try { stored = Number(window.localStorage.getItem(KEY)); } catch { stored = fallback; }
  return stored !== null && valid(stored) ? stored : DEFAULT_DIM_STRENGTH;
}

export function rememberDimStrength(value: number): void {
  if (!valid(value)) return;
  try { window.localStorage.setItem(KEY, String(value)); } catch { fallback = value; }
}

/** The strength the Advanced slider shows: the current one, or the one dimming comes back with. */
export function dimStrength(focusDim: number): number {
  return focusDim > 0 ? focusDim : rememberedDimStrength();
}

/** focusDim after the switch is flipped from `focusDim`. */
export function toggleFocusDim(focusDim: number, on: boolean): number {
  if (!on) {
    if (focusDim > 0) rememberDimStrength(focusDim);
    return 0;
  }
  return focusDim > 0 ? focusDim : rememberedDimStrength();
}
