import { type PageBlock, type PageChangeDto, type SpaceActivityItem } from 'michi-shared';
import { michiHomeEyebrow } from '../../content/home/michiHomeFormat';

/** Today as Michi Home writes it, `Fri, Oct 23`, whatever the browser's locale. */
export function homeDateLabel(now: Date): string {
  return michiHomeEyebrow(now.getTime(), null);
}

/** Who a block belongs to: a person edited it, an agent wrote it, or neither has claimed it. */
export function blockAuthor(block: PageBlock): 'human' | 'agent' | null {
  if (block.edit) return 'human';
  return block.sources?.length ? 'agent' : null;
}

/** The changes a home marks on its blocks: suggestions still waiting, and whatever changed after `lastSeenSeq`. */
export function homeChangesShown(changes: readonly PageChangeDto[], lastSeenSeq: number): PageChangeDto[] {
  return changes.filter((change) => change.proposalState === 'pending' || change.seq > lastSeenSeq);
}

/**
 * Where the counted sections sit among a home page's own blocks. The page
 * reads top to bottom as: lead, today (agenda, cards, Waiting), the longer-
 * lived blocks, Space activity, the per-workspace block, Stalled and Done,
 * then whatever follows. Positions count top-level blocks, so a short page
 * keeps the same order with fewer blocks between the sections. A heading
 * counts together with the block under it, so a section never lands between
 * a heading and what it introduces.
 */
export const HOME_SLOTS = { today: 1, activity: 3, threads: 4 } as const;

export interface HomeBlockSegments<T> {
  lead: T[];
  middle: T[];
  beforeThreads: T[];
  rest: T[];
}

export function splitHomeBlocks<T extends { type: string }>(blocks: readonly T[]): HomeBlockSegments<T> {
  const units: T[][] = [];
  let open: T[] = [];
  for (const block of blocks) {
    if (block.type === 'home-section' && !open.length && units.length) { units[units.length - 1].push(block); continue; }
    open.push(block);
    if (block.type !== 'heading') { units.push(open); open = []; }
  }
  if (open.length) units.push(open);
  const slice = (from: number, to?: number) => units.slice(from, to).flat();
  return {
    lead: slice(0, HOME_SLOTS.today),
    middle: slice(HOME_SLOTS.today, HOME_SLOTS.activity),
    beforeThreads: slice(HOME_SLOTS.activity, HOME_SLOTS.threads),
    rest: slice(HOME_SLOTS.threads),
  };
}

/** The newest page an agent wrote, from Space activity (newest first): where and when. */
export function latestAgentWrite(items: readonly SpaceActivityItem[] | null): { workspaceName: string; at: number } | null {
  const write = items?.find((item) => item.kind === 'page-change' && item.actor === 'agent');
  if (!write || write.kind !== 'page-change') return null;
  return { workspaceName: write.workspaceName || write.pageTitle || 'Home', at: write.at };
}
