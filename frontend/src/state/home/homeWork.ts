import type { CompanionSnapshot } from '../../services/api/companion';

/** Home's work strip (Q44): what Michi is doing, what waits for the user, what it finished today. */
export interface HomeWorkCounts {
  working: number;
  waiting: number;
  doneToday: number;
}

/**
 * Until Today has its three groups (P8): the conversations Michi started and
 * still follows, what needs the user, and today's finished conversations.
 */
export function homeWorkCounts(snapshot: Pick<CompanionSnapshot, 'delegations' | 'counts' | 'items'>, now: number): HomeWorkCounts {
  const day = new Date(now);
  const startOfToday = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  return {
    working: (snapshot.delegations ?? []).filter((delegation) => delegation.state === 'following').length,
    waiting: snapshot.counts.needsYou,
    doneToday: snapshot.items.filter((item) => item.subtype === 'michi_done' && item.changedAt >= startOfToday).length,
  };
}
