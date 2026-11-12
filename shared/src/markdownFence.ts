export interface MarkdownFence {
  char: '`' | '~';
  length: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fence a whole line opens: a backtick fence's info string may not hold a backtick. */
export function openingFence(line: string): MarkdownFence | null {
  const match = FENCE.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0] as MarkdownFence['char'], length: match[1].length };
}

/** Whether a whole line closes `open`. Any indent is allowed, so a fence in a list item closes too. */
export function closesFence(line: string, open: MarkdownFence): boolean {
  const trimmed = line.trim();
  return trimmed.length >= open.length && trimmed === open.char.repeat(trimmed.length);
}
