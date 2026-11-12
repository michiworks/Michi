/**
 * The morning brief Michi writes itself when the Companion's own cannot be
 * had (DESIGN §6.6, R2.8): its turn failed, timed out, was cut short too
 * often or published nothing, or the day's turn budget is used up.
 *
 * Deterministic and short, like the Companion's: at most seven cards, one
 * open item each, Needs you first, then Stalled, then Updates (FYI never;
 * within a group the interrupting ones, then the newest change); headline
 * "<n> things need you today" (n = every open Needs you item); closing
 * "That's all for today.". One brief a day: a day that has one (either
 * origin) keeps it.
 */

import {
  COMPANION_LIMITS,
  type CompanionBriefCard,
  type CompanionBriefDto,
  type CompanionBucket,
  type CompanionItemDto,
  type CompanionSeverity,
} from 'michi-shared';
import { localDateKey } from './clock';
import { briefForDate, insertBrief, listOpenItems } from './repository';

export const COMPANION_BRIEF_CLOSING = "That's all for today.";

const BUCKET_ORDER: Partial<Record<CompanionBucket, number>> = { needs_you: 0, stalled: 1, update: 2 };
const SEVERITY_ORDER: Record<CompanionSeverity, number> = { now: 0, digest: 1, silent: 2 };
const CARD_TITLE_MAX = 120;
const CARD_BODY_MAX = 800;

const DEFAULT_BODY: Partial<Record<CompanionBucket, string>> = {
  needs_you: 'This needs you.',
  stalled: 'This has not moved for a while.',
  update: 'This changed since you last looked.',
};

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export interface CompanionBriefContent {
  headline: string;
  cards: CompanionBriefCard[];
  closing: string;
}

export function fallbackHeadline(needsYou: number): string {
  if (needsYou === 0) return 'Nothing needs you today';
  return needsYou === 1 ? '1 thing needs you today' : `${needsYou} things need you today`;
}

/** The fallback brief of these open items. */
export function fallbackBriefContent(open: readonly CompanionItemDto[]): CompanionBriefContent {
  const ranked = open
    .filter((item) => BUCKET_ORDER[item.bucket] !== undefined)
    .sort((a, b) => (BUCKET_ORDER[a.bucket]! - BUCKET_ORDER[b.bucket]!)
      || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      || (b.changedAt - a.changedAt)
      || a.id.localeCompare(b.id));
  const cards = ranked.slice(0, COMPANION_LIMITS.maxBriefCards).map((item): CompanionBriefCard => ({
    title: clip(item.title, CARD_TITLE_MAX) || 'Item',
    body: clip(item.summary ?? '', CARD_BODY_MAX) || DEFAULT_BODY[item.bucket] || 'See the feed.',
    itemIds: [item.id],
    action: null,
  }));
  return {
    headline: fallbackHeadline(open.filter((item) => item.bucket === 'needs_you').length),
    cards,
    closing: COMPANION_BRIEF_CLOSING,
  };
}

/** Writes today's fallback brief unless today already has a brief; returns today's brief either way. */
export function writeFallbackBrief(now: number): CompanionBriefDto | null {
  const date = localDateKey(now);
  const existing = briefForDate(date);
  if (existing) return existing;
  const content = fallbackBriefContent(listOpenItems(now, { limit: 500 }));
  return insertBrief({ date, ...content, origin: 'fallback', now }) ?? briefForDate(date);
}
