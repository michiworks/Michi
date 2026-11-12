/**
 * Cutting text short for display. The budget is in UTF-16 units, as the
 * length limits that validate these fields count; a cut never splits a
 * surrogate pair. Imports nothing, so any shared module can use it.
 */

/** `text`, cut to at most `max` units with a trailing ellipsis when it is longer. */
export function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** `text` on one line: whitespace runs collapsed to a space, trimmed, then cut to `max`. */
export function oneLine(text: string, max: number): string {
  return ellipsize(text.replace(/\s+/g, ' ').trim(), max);
}

/** A trimmed string cut to `max`; undefined for a non-string or blank value. */
export function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? ellipsize(text, max) : undefined;
}

/** "1 thread", "2 threads"; pass `many` for a noun that does not just add s ("branches"). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function joinAnd(items: readonly string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
