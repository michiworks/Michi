import { useSyncExternalStore } from 'react';
import { DEFAULT_COMPANION_NAME } from 'michi-shared';
import type { CompanionSnapshot } from '../../services/api/companion';
import { getCompanionState, subscribeCompanion } from './companionStore';

/**
 * The agent's name for every label in this window (DESIGN-v2 §1.5): the
 * Topbar button and its tooltip, the panel header, speakers ("<name> ·
 * check-in"), commands ("Ask <name>"), Settings › <name>, notification
 * titles, "Created by <name>", "<name> · Pages upkeep". It is the name the
 * user gave it (`settings.displayName` in the Companion snapshot) and
 * DEFAULT_COMPANION_NAME ("Michi", DESIGN-v2 Q4) until a snapshot has
 * arrived, including on backends with no Companion. Added in W0; W2-F1a,
 * W2-F1b and W2-F2 switch their labels to it.
 */

/** The name a snapshot gives, or the default when there is none or its name is blank. */
export function companionNameOf(snapshot: Pick<CompanionSnapshot, 'settings'> | null | undefined): string {
  const name = snapshot?.settings.displayName.trim();
  return name || DEFAULT_COMPANION_NAME;
}

/** The name now, for code outside React (notification titles, commands built on demand). */
export function companionNameNow(): string {
  return companionNameOf(getCompanionState().snapshot);
}

/** The name, re-rendering only when it changes (not on every Companion snapshot). */
export function useCompanionName(): string {
  return useSyncExternalStore(subscribeCompanion, companionNameNow, companionNameNow);
}
