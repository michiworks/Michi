import { patchCompanionSettings } from '../../src/services/companion/settings';
/** Synthetic sources used by coordinator tests; public production has no external collectors. */
export function enableSyntheticCompanionSources(): void {
  patchCompanionSettings({ sources: {
    cr: { enabled: true }, pipeline: { enabled: true }, email: { enabled: true }, calendar: { enabled: true },
  } });
}
