/** Keys the phone keyboard lacks, as the bytes a terminal expects (xterm's encoding). */

export type TerminalKeyName = 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'ArrowLeft';

const ARROWS: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

/** `applicationCursor`: DECCKM, set by full-screen programs (vim, less, top). */
export function terminalKeySequence(key: TerminalKeyName, applicationCursor: boolean): string {
  if (key === 'Escape') return '\x1b';
  if (key === 'Tab') return '\t';
  return `${applicationCursor ? '\x1bO' : '\x1b['}${ARROWS[key]}`;
}

/** Ctrl applied to the first character typed after it: ctrl c is ETX, ctrl ? is DEL. */
export function withControl(data: string): string {
  if (!data) return data;
  const first = data[0];
  const rest = data.slice(1);
  if (first === '?') return `\x7f${rest}`;
  if (first === ' ' || first === '@' || first === '2') return `\x00${rest}`;
  const code = first.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return `${String.fromCharCode(code - 64)}${rest}`;
  return data;
}
