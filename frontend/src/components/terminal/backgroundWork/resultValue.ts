/**
 * A workflow's or an agent's JSON result, read for display. The stored copy
 * is often cut short (a run keeps the first WORKFLOW_LIMITS.result
 * characters of its result; Claude sends a preview of each agent's), so the
 * reader keeps what the text holds: a string cut mid-way ends in "…", and
 * numbers, literals and keys cut mid-way are left out.
 */
export interface ResultValue {
  value: unknown;
  /** The innermost object or array still open where the text ends; absent when the text is whole. */
  cut?: object;
  /** Every object and array the text ends inside: their item counts are lower bounds. */
  open: ReadonlySet<object>;
}

const NONE: ReadonlySet<object> = new Set();
const ABSENT = Symbol('absent');
const MAX_DEPTH = 64;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** A number the text may end inside: "-", "1.", "1.5e-", or "12" that may have been 1234. */
const NUMBER_AT_END = /^-?(?:\d+(?:\.\d*)?(?:[eE][+-]?\d*)?)?$/;
const LITERALS = ['true', 'false', 'null'];

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

/** A cut string's text: its escapes decoded, a half-written escape at the end dropped. */
function decodeCut(body: string): string {
  const trailing = /\\+$/.exec(body)?.[0].length ?? 0;
  const whole = (trailing % 2 === 1 ? body.slice(0, -1) : body).replace(/(?<!\\)((?:\\\\)*)\\u[0-9a-fA-F]{0,3}$/, '$1');
  try {
    return JSON.parse(`"${whole}"`) as string;
  } catch {
    return whole;
  }
}

/** Undefined for prose, for a JSON scalar and for text that is not JSON even where it was cut. */
export function readResultValue(text: string | undefined): ResultValue | undefined {
  const trimmed = text?.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null ? { value, open: NONE } : undefined;
  } catch {
    // Cut short, or not JSON: read what there is.
  }
  // clampText ends a cut text with "…".
  const src = trimmed.endsWith('…') ? trimmed.slice(0, -1) : trimmed;
  let pos = 0;
  let cut: object | undefined;
  const open = new Set<object>();
  const fail = (): never => {
    throw new SyntaxError('not JSON');
  };
  const atEnd = () => {
    while (pos < src.length && isSpace(src.charCodeAt(pos))) pos += 1;
    return pos >= src.length;
  };
  const ended = <T extends object>(container: T): T => {
    cut ??= container;
    open.add(container);
    return container;
  };

  function string(): { text: string; whole: boolean } {
    const start = pos;
    pos += 1;
    while (pos < src.length) {
      const ch = src.charCodeAt(pos);
      if (ch === 92) pos += 2;
      else if (ch === 34) {
        pos += 1;
        return { text: JSON.parse(src.slice(start, pos)) as string, whole: true };
      } else pos += 1;
    }
    pos = src.length;
    return { text: decodeCut(src.slice(start + 1)), whole: false };
  }

  function value(depth: number): unknown {
    if (depth > MAX_DEPTH) fail();
    if (atEnd()) return ABSENT;
    const ch = src[pos];
    if (ch === '{') return object(depth);
    if (ch === '[') return array(depth);
    if (ch === '"') {
      const read = string();
      return read.whole ? read.text : `${read.text}…`;
    }
    // The text ends inside a number or a literal: leave it out.
    if (src.length - pos <= 32) {
      const tail = src.slice(pos);
      if (NUMBER_AT_END.test(tail) || LITERALS.some((word) => word.startsWith(tail))) {
        pos = src.length;
        return ABSENT;
      }
    }
    NUMBER.lastIndex = pos;
    const token = NUMBER.exec(src)?.[0] ?? LITERALS.find((word) => src.startsWith(word, pos));
    if (token === undefined) return fail();
    pos += token.length;
    return JSON.parse(token) as unknown;
  }

  function object(depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    pos += 1;
    for (;;) {
      if (atEnd()) return ended(out);
      if (src[pos] === '}') {
        pos += 1;
        return out;
      }
      if (src[pos] !== '"') fail();
      const key = string();
      if (!key.whole || atEnd()) return ended(out);
      if (src[pos] !== ':') fail();
      pos += 1;
      const item = value(depth + 1);
      // defineProperty: a "__proto__" key stays an ordinary field, as JSON.parse keeps it.
      if (item !== ABSENT) Object.defineProperty(out, key.text, { value: item, enumerable: true, writable: true, configurable: true });
      if (atEnd()) return ended(out);
      if (src[pos] === ',') pos += 1;
      else if (src[pos] === '}') {
        pos += 1;
        return out;
      } else fail();
    }
  }

  function array(depth: number): unknown[] {
    const out: unknown[] = [];
    pos += 1;
    for (;;) {
      if (atEnd()) return ended(out);
      if (src[pos] === ']') {
        pos += 1;
        return out;
      }
      const item = value(depth + 1);
      if (item !== ABSENT) out.push(item);
      if (atEnd()) return ended(out);
      if (src[pos] === ',') pos += 1;
      else if (src[pos] === ']') {
        pos += 1;
        return out;
      } else fail();
    }
  }

  try {
    const root = value(0);
    if (root === ABSENT || typeof root !== 'object' || root === null || !atEnd()) return undefined;
    return cut ? { value: root, cut, open } : { value: root, open: NONE };
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ACRONYMS: Record<string, string> = {
  id: 'ID', ids: 'IDs', url: 'URL', urls: 'URLs', sha: 'SHA', cr: 'CR', crs: 'CRs', pr: 'PR', prs: 'PRs', api: 'API',
  ui: 'UI', json: 'JSON', html: 'HTML', css: 'CSS', sdk: 'SDK', cli: 'CLI', mcp: 'MCP', db: 'DB', acp: 'ACP', e2e: 'E2E', llm: 'LLM', ai: 'AI',
};

function words(key: string): string[] {
  return key.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1 $2').split(/[\s_.-]+/).filter(Boolean);
}

/** A field's key as a label: "verifiedTotals" → "Verified totals", "dev_sha" → "Dev SHA". */
export function fieldLabel(key: string): string {
  const parts = words(key);
  if (parts.length === 0) return key;
  return parts.map((word, index) => {
    const lower = word.toLowerCase();
    if (ACRONYMS[lower]) return ACRONYMS[lower];
    return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(' ');
}

/** A count's key as the noun after it: "prodDiffLines" → "prod diff lines", as in "57 prod diff lines". */
export function countNoun(key: string): string {
  const parts = words(key);
  if (parts.length === 0) return key;
  return parts.map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase()).join(' ');
}

/** Keys that name a record, best first; the value must be one short line. */
const TITLE_KEYS = [
  'title', 'name', 'heading', 'label', 'subject', 'file', 'path', 'filename', 'slug', 'dimension', 'lens', 'group',
  'topic', 'area', 'harness', 'component', 'package', 'repo', 'section', 'key', 'id',
];
/** Keys shown before the title, in mono, when the record has both: "F1 · Stale cache". */
const REF_KEYS = ['id', 'key', 'ref', 'code'];
/** Keys whose short value is a category: shown as a chip after the title. */
const CHIP_KEYS = new Set([
  'status', 'state', 'severity', 'priority', 'verdict', 'outcome', 'decision', 'risk', 'confidence', 'level',
  'grade', 'rating', 'kind', 'type', 'category', 'tier', 'impact', 'effort',
]);
/** Numbers that are names, not counts: kept as fields, not "123 ports". */
const NOT_A_COUNT = /(?:^|[_-])(?:id|port|pid|year|version|number|no|pr|cr)$|[a-z](?:Id|Port|Pid|Year|Version|Number|No|Pr|Cr)$|^(?:ID|PR|CR)$/;

export function isOneLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\n');
}

export function titleKey(record: Record<string, unknown>): string | undefined {
  return TITLE_KEYS.find((key) => isOneLine(record[key], 160) || (key === 'id' && typeof record[key] === 'number'));
}

export function refKey(record: Record<string, unknown>, title: string | undefined): string | undefined {
  if (!title || REF_KEYS.includes(title)) return undefined;
  return REF_KEYS.find((key) => isOneLine(record[key], 24) || typeof record[key] === 'number');
}

export function isChipField(key: string, value: unknown): value is string {
  return CHIP_KEYS.has(key) && isOneLine(value, 32);
}

export function isCountField(key: string, value: unknown): value is number {
  return typeof value === 'number' && !NOT_A_COUNT.test(key);
}

export type ChipTone = 'danger' | 'warn' | 'neutral';

/** Only words that plainly mean "bad" or "watch out" get a colour; the rest stay neutral. */
export function chipTone(value: string): ChipTone {
  const word = value.trim().toLowerCase();
  if (/^(?:critical|blocker|blocking|high|severe|sev[-_ ]?[0-2]|p0|fail|failed|failure|error|broken)$/.test(word)) return 'danger';
  if (/^(?:medium|moderate|warn|warning|partial|partially|p1|sev[-_ ]?3)$/.test(word)) return 'warn';
  return 'neutral';
}

/** A path or a commit: shown in mono. */
export function isCodeLike(value: string): boolean {
  return /^(?:[~.]?\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\/?$/.test(value) || /^[0-9a-f]{7,40}$/i.test(value) || /^\/[\w@.+-]+$/.test(value);
}

/**
 * Whether a string is written in Markdown. Plain text stays plain: a lone
 * "*" in "--term-sidebar-*" must not start emphasis.
 */
export function looksMarkdown(value: string): boolean {
  return /`|\]\(|\*\*|__|https?:\/\/|\|.*\||^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/m.test(value);
}

/** Items alike enough for a table: two or more records of a few short scalar fields. */
export function tableColumns(items: readonly unknown[]): string[] | undefined {
  if (items.length < 2) return undefined;
  const columns: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) return undefined;
    for (const [key, cell] of Object.entries(item)) {
      const scalar = cell === null || typeof cell === 'number' || typeof cell === 'boolean' || (typeof cell === 'string' && cell.length <= 48 && !cell.includes('\n'));
      if (!scalar) return undefined;
      if (!columns.includes(key)) columns.push(key);
    }
    if (columns.length > 6) return undefined;
  }
  return columns.length > 0 ? columns : undefined;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/** A path's last part, the name a reader knows it by. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}
