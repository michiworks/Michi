import { LOCAL_AGENT_OWNER_ID } from '../../src/services/agentOwner';
import { setExtractionPaused } from '../../src/services/memory/extractionRepository';
import { resumeMichi } from '../../src/services/michiPause';

/**
 * Michi and its background work are off until the user turns them on
 * (services/backgroundWorkOff.ts): Pause Michi holds check-ins, watching and
 * Pages upkeep until Resume, and automatic memory is paused until Settings ›
 * Memory turns it on. Tests that exercise them turn them on after initDb.
 */

/** Resume in Settings › Michi: check-ins, watching and Pages upkeep. */
export function turnCompanionOn(owner: string = LOCAL_AGENT_OWNER_ID): void {
  resumeMichi(owner);
}

/** For each owner: Resume (Pages upkeep's background updates with it) and automatic memory on. */
export function turnBackgroundWorkOn(owners: readonly string[] = [LOCAL_AGENT_OWNER_ID], now = Date.now()): void {
  for (const owner of owners) {
    resumeMichi(owner);
    setExtractionPaused(owner, false, now);
  }
}
