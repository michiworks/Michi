import { Terminal } from '@xterm/xterm';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';

function cssVar(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

/** xterm's own scroll glide, which neither reduced-motion trigger reaches:
 *  off under either one. Panes keep an open terminal in step (options apply live). */
export function paneSmoothScrollDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 80;
}

/** The xterm every terminal pane uses, Electron's PTY or a backend's. Its
 *  caret blink is a CSS animation, which the reduced-motion catch-all stops. */
export function createPaneTerminal(host: HTMLElement): Terminal {
  return new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    fontFamily: cssVar(host, '--font-mono', 'ui-monospace, SFMono-Regular, monospace'),
    // xterm takes px as a number; matches --fs-lg.
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 10_000,
    smoothScrollDuration: paneSmoothScrollDuration(prefersReducedMotion()),
    // CLI ANSI/256-color/truecolor output must remain readable in light themes.
    minimumContrastRatio: 4.5,
  });
}
