import type { CompanionSnapshot } from '../../services/api/companion';
import { companionWaitingItems } from '../companion/companionToday';

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
    // The same items Today's header counts (companionToday.ts), so Home and Today never say a different number.
    waiting: companionWaitingItems(snapshot.items, now).length,
    doneToday: snapshot.items.filter((item) => item.subtype === 'michi_done' && item.changedAt >= startOfToday).length,
  };
}
