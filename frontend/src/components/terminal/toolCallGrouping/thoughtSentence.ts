/* ── Thought sentences ── */

interface Clause { end: number; sentence: boolean }

/** Clause boundaries. CJK punctuation counts at once; Latin punctuation only
 *  before whitespace (or at the end of a finished text), so "3.5" and a
 *  half-streamed "e.g" never split. A newline ends a sentence. */
function clausesOf(text: string, finished: boolean): Clause[] {
  const out: Clause[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if ('。！？'.includes(c)) out.push({ end: i + 1, sentence: true });
    else if ('，；：、'.includes(c)) out.push({ end: i + 1, sentence: false });
    else if (c === '—' && next === '—') { out.push({ end: i + 2, sentence: false }); i++; }
    else if (c === '\n') {
      const from = out.length ? out[out.length - 1].end : 0;
      if (text.slice(from, i).trim()) out.push({ end: i, sentence: true });
      else if (out.length) out[out.length - 1].sentence = true;
    }
    else if ('.!?,;:'.includes(c) && (next === undefined ? finished : /\s/.test(next))) {
      out.push({ end: i + 1, sentence: '.!?'.includes(c) });
    }
  }
  if (finished && text.slice(out[out.length - 1]?.end ?? 0).trim()) out.push({ end: text.length, sentence: true });
  return out;
}

function cleanSentence(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*(?:#+|[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Start of the sentence that clause `k` belongs to. */
function sentenceStart(clauses: readonly Clause[], k: number): number {
  for (let i = k - 1; i >= 0; i--) if (clauses[i].sentence) return clauses[i].end;
  return 0;
}

/**
 * The sentence being written, up to its last finished clause; changes only
 * when a clause completes, never per token. Undefined before any clause.
 */
export function thoughtPreview(text: string): string | undefined {
  const clauses = clausesOf(text, false);
  const last = clauses.length - 1;
  if (last < 0) return undefined;
  const sentence = cleanSentence(text.slice(sentenceStart(clauses, last), clauses[last].end)).replace(/(?:——|[，；：、,;:])$/, '');
  return sentence || undefined;
}

/** A finished thought's conclusion: its last sentence, unless that is a question. */
export function thoughtConclusion(text: string): string | undefined {
  const clauses = clausesOf(text, true).filter((c) => c.sentence);
  for (let k = clauses.length - 1; k >= 0; k--) {
    const sentence = cleanSentence(text.slice(k > 0 ? clauses[k - 1].end : 0, clauses[k].end));
    if (!sentence) continue;
    return /[?？]$/.test(sentence) ? undefined : sentence;
  }
  return undefined;
}
