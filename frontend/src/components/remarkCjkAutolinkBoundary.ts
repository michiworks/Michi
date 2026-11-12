/**
 * remark plugin: end bare URLs where CJK punctuation begins.
 *
 * GFM's autolink literal runs a URL up to the next whitespace. Chinese and
 * Japanese prose puts no space after a URL, so the link swallows the full-width
 * punctuation and the rest of the sentence:
 *
 *   **https://x.dev**。截图脚本是  →  one link "https://x.dev**。截图脚本是"
 *
 * and because the link ate the closing `**`, the bold never closes either.
 *
 * After parsing, this finds each literal autolink that runs into a boundary
 * (CJK or full-width punctuation, curly quotes, or GFM trailing punctuation
 * followed by a CJK character), wraps the real URL in an explicit autolink
 * (`<https://x.dev>`; `www.` URLs become `[www…](<http://www…>)`) and parses
 * the edited source again, so emphasis around the URL pairs up as written.
 * Edits are placed by the first parse's positions, so code spans, code blocks,
 * explicit links and `<…>` autolinks are never touched.
 */

interface MdastNode {
  type: string;
  url?: string;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface Parser {
  parse(value: string): MdastNode;
}

/** Characters no bare URL runs through: CJK and full-width punctuation, curly quotes. */
export const CJK_URL_STOP_CHARS =
  '\\u3000-\\u303F\\uFE10-\\uFE1F\\uFE30-\\uFE4F\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65\\u2018\\u2019\\u201C\\u201D\\u2026';

// GFM's trailing punctuation (micromark-extension-gfm-autolink-literal `trail`).
const TRAIL = new Set(['!', '"', "'", ')', '*', ',', '.', ':', ';', '?', '_', '~', ']']);
const TRAIL_CLASS = `!"'),*.:;?_~\\]`;
const CJK_LETTER = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
// A stop character, or a CJK letter right after trailing punctuation
// (`https://x.dev**看` ends before the `**`; `wiki/北京` stays one URL).
const BOUNDARY_RE = new RegExp(`[${CJK_URL_STOP_CHARS}]|(?<=[${TRAIL_CLASS}])[${CJK_LETTER}]`, 'u');
const URL_START_RE = /https?:\/\/|www\./i;
const MAX_PASSES = 8;

function count(value: string, ch: string): number {
  let n = 0;
  for (const c of value) if (c === ch) n++;
  return n;
}

/** Drop trailing punctuation the way GFM does, keeping a `)` that closes a `(`. */
function trimTrail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (!TRAIL.has(ch)) break;
    if (ch === ')') {
      const head = url.slice(0, end);
      if (count(head, '(') >= count(head, ')')) break;
    }
    end--;
  }
  return url.slice(0, end);
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

function editFor(node: MdastNode, source: string): Edit | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || typeof node.url !== 'string') return null;
  const raw = source.slice(start, end);
  const www = /^www\./i.test(raw);
  // Only literal autolinks: their URL is their source text.
  if (!www && !/^https?:\/\//i.test(raw)) return null;
  if (node.url !== (www ? `http://${raw}` : raw)) return null;
  const boundary = BOUNDARY_RE.exec(raw);
  if (!boundary) return null;
  const kept = trimTrail(raw.slice(0, boundary.index));
  if (/[<>]/.test(kept) || !/^(?:https?:\/\/|www\.)[^/?#]*[\p{L}\p{N}]/iu.test(kept)) return null;
  const replacement = www
    ? `[${kept.replace(/[!-/:-@[-`{-~]/g, '\\$&')}](<http://${kept}>)`
    : `<${kept}>`;
  return { start, end: start + kept.length, replacement };
}

function collectEdits(node: MdastNode, source: string, edits: Edit[]): void {
  if (node.type === 'link') {
    const edit = editFor(node, source);
    if (edit) edits.push(edit);
    return;
  }
  node.children?.forEach(child => collectEdits(child, source, edits));
}

export function remarkCjkAutolinkBoundary(this: Parser) {
  // An arrow keeps `this`, the processor, whose parser has every extension.
  return (tree: MdastNode, file: { value?: unknown }): MdastNode | undefined => {
    let source = String(file.value ?? '');
    if (!URL_START_RE.test(source) || !BOUNDARY_RE.test(source)) return undefined;
    let current = tree;
    let changed = false;
    // A cut can expose the next URL in the same run ("a.com/x，b.com/y，…"),
    // which only the next parse links, so repeat until nothing is left.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const edits: Edit[] = [];
      collectEdits(current, source, edits);
      if (!edits.length) break;
      edits.sort((a, b) => b.start - a.start);
      for (const { start, end, replacement } of edits) {
        source = source.slice(0, start) + replacement + source.slice(end);
      }
      current = this.parse(source);
      changed = true;
    }
    if (!changed) return undefined;
    // Keep positions in the new tree consistent with the file they point into.
    file.value = source;
    return current;
  };
}
