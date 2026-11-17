import { ellipsize } from './text';

/**
 * A workflow's or a step's result kept within `max` characters. Cutting the
 * serialized text keeps only its start (one item of four, say); cutting by
 * structure keeps every key and, where it can, every item: long strings are
 * shortened to one shared length and end in "…", and only when that is not
 * enough do lists keep their first items, followed by an omitted-items
 * marker ("… 12 more"). Text that is not JSON, or JSON too wide to fit even
 * then, is cut at `max` as before.
 */

/** Strings are not shortened below this before lists lose items. */
const MIN_TEXT = 80;
const MORE = /^… (\d+) more$/;
const OVER = Symbol('over');

function omittedItemsMarker(count: number): string {
  return `… ${count} more`;
}

/** The count an omitted-items marker stands for; undefined for any other item. */
export function omittedItemsCount(item: unknown): number | undefined {
  const match = typeof item === 'string' ? MORE.exec(item) : null;
  return match ? Number(match[1]) : undefined;
}

/** A list's items and how many it stands for: a marker it ends with counts for what it left out. */
function listSize(list: readonly unknown[]): { present: number; total: number } {
  const omitted = omittedItemsCount(list[list.length - 1]);
  return omitted === undefined ? { present: list.length, total: list.length } : { present: list.length - 1, total: list.length - 1 + omitted };
}

function measure(value: unknown, out: { longest: number; widest: number }): void {
  if (typeof value === 'string') out.longest = Math.max(out.longest, value.length);
  else if (Array.isArray(value)) {
    out.widest = Math.max(out.widest, listSize(value).present);
    for (const item of value) measure(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) measure(item, out);
  }
}

/** Compact JSON with strings cut at `text` and lists at `items`; undefined past `max`. */
function write(value: unknown, text: number, items: number, max: number): string | undefined {
  const parts: string[] = [];
  let size = 0;
  const push = (part: string) => {
    size += part.length;
    if (size > max) throw OVER;
    parts.push(part);
  };
  const visit = (node: unknown): void => {
    if (typeof node === 'string') push(JSON.stringify(node.length > text ? ellipsize(node, text) : node));
    else if (Array.isArray(node)) {
      push('[');
      // A list cut before keeps counting what it left out then.
      const { present, total } = listSize(node);
      const kept = Math.min(present, items);
      for (let index = 0; index < kept; index += 1) {
        if (index > 0) push(',');
        // As JSON.stringify writes them in a list.
        visit(node[index] === undefined || typeof node[index] === 'function' ? null : node[index]);
      }
      if (kept < total) push(`${kept > 0 ? ',' : ''}${JSON.stringify(omittedItemsMarker(total - kept))}`);
      push(']');
    } else if (node && typeof node === 'object') {
      push('{');
      let first = true;
      for (const [key, item] of Object.entries(node)) {
        if (item === undefined || typeof item === 'function') continue;
        push(`${first ? '' : ','}${JSON.stringify(key)}:`);
        first = false;
        visit(item);
      }
      push('}');
    } else push(JSON.stringify(node) ?? 'null');
  };
  try {
    visit(value);
    return parts.join('');
  } catch (error) {
    if (error === OVER) return undefined;
    throw error;
  }
}

/** The largest n in [low, high] for which `fits(n)` holds, given that it holds at `low`. */
function largest(low: number, high: number, fits: (n: number) => boolean): number {
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function byStructure(value: object, max: number): string | undefined {
  const size = { longest: 0, widest: 0 };
  measure(value, size);
  const { longest, widest } = size;
  const floor = Math.min(MIN_TEXT, longest);
  let items = widest;
  if (write(value, floor, items, max) === undefined) {
    // Short text alone does not fit: lists keep their first items.
    if (widest <= 1 || write(value, floor, 1, max) === undefined) return undefined;
    items = largest(1, widest - 1, (n) => write(value, floor, n, max) !== undefined);
  }
  const text = largest(floor, Math.min(longest, max), (n) => write(value, n, items, max) !== undefined);
  return write(value, text, items, max);
}

function jsonContainer(text: string): object | undefined {
  if (text[0] !== '{' && text[0] !== '[') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `value` as a JSON value or text, within `max` characters. A value that
 * fits whole keeps its form: indented with `pretty`, compact otherwise;
 * one cut by structure is compact, to keep as much as it can.
 */
export function clampWorkflowResult(value: unknown, max: number, options: { pretty?: boolean } = {}): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    if (text.length <= max) return text;
    const parsed = jsonContainer(text);
    return (parsed && byStructure(parsed, max)) ?? ellipsize(text, max);
  }
  if (value === null || typeof value !== 'object') return ellipsize(JSON.stringify(value) ?? 'null', max);
  const whole = JSON.stringify(value, null, options.pretty ? 2 : undefined);
  if (whole.length <= max) return whole;
  return byStructure(value, max) ?? ellipsize(whole, max);
}
