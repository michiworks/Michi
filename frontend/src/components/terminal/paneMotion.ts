import { EASE } from '../../motion/tokens';

export const PANE_ENTER_MS = 220;
export const PANE_EXIT_MS = 160;
export const PANE_EASE = `cubic-bezier(${EASE.drawer.join(', ')})`;

/** Closing down to one pane (TR-20): the leaving pane fades, then the survivor expands. */
export const SINGLE_PANE_EXIT = { exit: 110, exitLayout: 180 } as const;

/**
 * How a new pane's content settles inside its entry surface while the pane
 * track slides it in: it rises 4px over the track's time. Reveal populated
 * content, never a white wrapper behind transparent text: it moves, never
 * fades.
 */
export function paneEntrance(): { frames: Keyframe[]; duration: number } {
  return {
    frames: [{ opacity: 1, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translate(0px, 0px)' }],
    duration: PANE_ENTER_MS,
  };
}
