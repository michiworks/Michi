export interface LineDelta {
  added: number;
  removed: number;
}

function textLines(s: unknown): string[] {
  if (typeof s !== 'string' || !s.length) return [];
  const lines = s.split('\n');
  // A final newline ends the last line rather than starting another.
  if (s.endsWith('\n')) lines.pop();
  return lines;
}

/** Lines an edit added and removed: the shared head and tail aside, the rest by longest common subsequence. */
export function lineDiff(before: unknown, after: unknown): LineDelta {
  const a = textLines(before);
  const b = textLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  // Beyond this size a count of the changed lines is close enough and costs nothing.
  if (!x.length || !y.length || x.length * y.length > 250_000) return { added: y.length, removed: x.length };
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const row = [0];
    for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  const common = prev[y.length];
  return { added: y.length - common, removed: x.length - common };
}

/**
 * The lines an edit or write tool call added and removed, summed over a multi-edit's `edits`.
 * Reads Claude's old_string/new_string/content and Kiro's oldStr/newStr/text; null when the
 * input carries no text to count.
 */
export function editLineDelta(input: Record<string, unknown>): LineDelta | null {
  const edits = (Array.isArray(input.edits) ? input.edits : [input]) as Array<Record<string, unknown> | null>;
  let known = false;
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    const before = e.old_string ?? e.oldStr;
    const after = e.new_string ?? e.newStr ?? e.content ?? e.text;
    if (typeof before !== 'string' && typeof after !== 'string') continue;
    known = true;
    const d = lineDiff(before, after);
    added += d.added;
    removed += d.removed;
  }
  return known ? { added, removed } : null;
}
