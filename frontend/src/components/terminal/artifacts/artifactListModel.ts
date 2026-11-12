import type { ArtifactEntry } from '../../../state/chatTypes';

/**
 * The Artifacts drawer's list: favorites first, then everything else by when
 * it was last touched, in calendar groups (Today, Yesterday, the weekdays of
 * the past week, then months). An artifact is found the way it is remembered,
 * "the mocks from Friday", and its type rides on the row instead of a group.
 */

export interface ArtifactGroup {
  key: string;
  label: string;
  /** Rows in a day group show a clock time; the others show a date. */
  byDay: boolean;
  rows: ArtifactEntry[];
}

const DAY_GROUPS = 7;

/** Created, or updated since: the moment the artifact was last touched. */
export function artifactTouchedAt(c: ArtifactEntry): number {
  return Math.max(c.createdAt ?? 0, c.updatedAt ?? 0);
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `at` to `now`; Math.round absorbs DST's 23/25h days. */
function daysAgo(at: number, now: number): number {
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000));
}

function dayLabel(at: number, now: number): string {
  const days = daysAgo(at, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function monthLabel(at: number, now: number): string {
  const d = new Date(at);
  const month = d.toLocaleDateString('en-US', { month: 'long' });
  return d.getFullYear() === new Date(now).getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

export function groupArtifactsByTime(rows: readonly ArtifactEntry[], now: number): ArtifactGroup[] {
  const newestFirst = [...rows].sort((a, b) => artifactTouchedAt(b) - artifactTouchedAt(a));
  const groups: ArtifactGroup[] = [];
  const favorites = newestFirst.filter((c) => c.pinnedAt);
  if (favorites.length) groups.push({ key: 'favorites', label: 'Favorites', byDay: false, rows: favorites });
  for (const c of newestFirst) {
    if (c.pinnedAt) continue;
    const at = artifactTouchedAt(c);
    const byDay = daysAgo(at, now) < DAY_GROUPS;
    const d = new Date(at);
    const key = byDay ? `day:${startOfDay(at)}` : `month:${d.getFullYear()}-${d.getMonth()}`;
    let group = groups[groups.length - 1];
    if (group?.key !== key) {
      group = { key, label: byDay ? dayLabel(at, now) : monthLabel(at, now), byDay, rows: [] };
      groups.push(group);
    }
    group.rows.push(c);
  }
  return groups;
}

/** The row's time: a clock time under a day header, otherwise a short date. */
export function artifactRowTime(at: number, now: number, byDay: boolean): string {
  const days = daysAgo(at, now);
  // 24-hour, so the time column stays five characters wide.
  if (byDay || days === 0) return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** HTML a sandboxed preview can show in place of a download. */
export function artifactHasWebPreview(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** A file whose first bytes carry a human title worth reading. */
export function artifactTitleSource(path: string): 'html' | 'markdown' | null {
  if (artifactHasWebPreview(path)) return 'html';
  if (/\.(md|mdx|markdown)$/i.test(path)) return 'markdown';
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref.toLowerCase()] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const MAX_TITLE = 160;

/**
 * The page's <title>, or a markdown file's first level-one heading, from the
 * start of the file. The result is plain text for a React text node.
 */
export function artifactTitleFromHead(head: string, source: 'html' | 'markdown'): string | null {
  let raw: string | undefined;
  if (source === 'html') {
    raw = head.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
    if (raw !== undefined) raw = decodeEntities(raw);
  } else {
    const body = head.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    raw = body.match(/^#[ \t]+(.+?)[ \t#]*$/m)?.[1];
  }
  const title = raw?.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

/** The short type word on a row's second line. */
export function artifactTypeLabel(c: ArtifactEntry, type: 'doc' | 'file' | 'image' | 'link'): string {
  if (type === 'link') return 'Link';
  if (type === 'doc') return 'Doc';
  if (type === 'image') return 'Image';
  if (artifactHasWebPreview(c.filePath)) return 'HTML';
  const ext = c.filePath.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return ext ? ext.toUpperCase() : 'File';
}
