import { memoryDay } from './memoryRefs';

/**
 * How long a memory holds (migration 0091), as Zep's invalid_at and GitHub
 * Copilot's unused-memory decay do it, without deleting anything:
 *
 *  - valid_until: when the memory stops being true, as the user said it
 *    (memory_save, memory_update, extraction's valid_until) or set it in
 *    Settings › Memory. A memory past it is left out of every memory pack
 *    (contextBuilder.ts: pinned sections, About the user, Related) and of
 *    recall without history; memory_search with history still finds it.
 *  - Michi's own workspace notes (origin extracted, not imported, not edited
 *    by the user) that were not written, used by a reply (last_used_at, from
 *    reply sources) or confirmed by the user (last_confirmed_at) for
 *    STALE_AFTER_MS rank after the other notes of a pack. The user's own,
 *    imported and edited notes, and user-scope notes, never go stale.
 *
 * Pure: no database. The SQL expressions take the memories table as `m`.
 */

/** Michi's own workspace notes unused and unconfirmed this long rank last. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60_000;

/**
 * When one of Michi's own workspace notes was last written, used or
 * confirmed (ms); NULL for every other note, which never goes stale.
 */
export const IDLE_SINCE_SQL = `CASE WHEN m.scope = 'workspace' AND m.origin = 'extracted' AND m.import_source IS NULL
  AND m.user_edited_at IS NULL THEN MAX(m.created_at, COALESCE(m.last_used_at, 0), COALESCE(m.last_confirmed_at, 0)) END`;

/** The memory is not past its end at `now` (a parameter after the SQL's place). */
export const NOT_EXPIRED_SQL = '(m.valid_until IS NULL OR m.valid_until > ?)';

/** Past its end. */
export function isExpired(validUntil: number | null | undefined, now: number): boolean {
  return typeof validUntil === 'number' && validUntil <= now;
}

/** One of Michi's own workspace notes left unused and unconfirmed for STALE_AFTER_MS (idleSince from IDLE_SINCE_SQL). */
export function isStale(idleSince: number | null | undefined, now: number): boolean {
  return typeof idleSince === 'number' && now - idleSince >= STALE_AFTER_MS;
}

/** Ones that are not stale first, each part in its order. */
export function freshFirst<T>(items: readonly T[], stale: (item: T) => boolean): T[] {
  return [...items.filter((item) => !stale(item)), ...items.filter(stale)];
}

/**
 * When a memory whose last true day is `day` (YYYY-MM-DD, local) stops being
 * true: the next local midnight. Null for an impossible date.
 */
export function endOfDay(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day.trim());
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const start = new Date(0);
  start.setFullYear(year, month, date);
  start.setHours(0, 0, 0, 0);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== date) return null;
  start.setDate(start.getDate() + 1);
  return start.getTime();
}

/** The last day (YYYY-MM-DD, local) a memory is true: the day just before validUntil. */
export function lastValidDay(validUntil: number): string {
  return memoryDay(validUntil - 1);
}
