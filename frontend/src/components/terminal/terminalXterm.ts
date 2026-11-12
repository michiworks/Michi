import { Terminal } from '@xterm/xterm';

function cssVar(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

/** The xterm every terminal pane uses, Electron's PTY or a backend's. */
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
    smoothScrollDuration: 80,
    // CLI ANSI/256-color/truecolor output must remain readable in light themes.
    minimumContrastRatio: 4.5,
  });
}
