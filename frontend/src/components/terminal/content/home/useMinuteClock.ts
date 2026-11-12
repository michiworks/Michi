import { useNow } from '../../../../hooks/useNow';

export const MICHI_HOME_CLOCK_MS = 60_000;

/**
 * `Date.now()` that moves on once a minute while `enabled`, so relative
 * times ("3h", "last looked 2h ago") stay true on a Home left open.
 */
export function useMinuteClock(enabled: boolean): number {
  return useNow(MICHI_HOME_CLOCK_MS, enabled);
}
