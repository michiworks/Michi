/** Availability at public user/tool boundaries; storage and injected sources stay provider-neutral. */
import { invalidRequest } from './errors';

const unavailable = () => invalidRequest('External Companion sources are not available in this build. Michi can watch local conversations.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Old external settings may be switched off or cleared, but never enabled. */
export function assertPublicCompanionSettingsPatch(raw: unknown): void {
  if (!record(raw) || !record(raw.sources)) return;
  for (const [source, patch] of Object.entries(raw.sources)) {
    if (source === 'michi' || !record(patch)) continue;
    if (patch.enabled === true || patch.includeReviews === true || patch.includeFavorites === true) throw unavailable();
    if (source === 'pipeline' && Array.isArray(patch.watch) && patch.watch.length > 0) throw unavailable();
  }
}

export function assertPublicCompanionCheckSources(sources: readonly string[] | undefined): void {
  if (sources?.some((source) => source !== 'michi')) throw unavailable();
}

/** The only watch that can progress without external collectors is a local conversation reply. */
export function assertPublicCompanionWatch(raw: unknown): void {
  if (record(raw) && raw.until !== undefined && raw.until !== null && raw.until !== 'answered') throw unavailable();
}

export function assertPublicCompanionCard(kind: unknown, payload: unknown): void {
  if (!record(payload)) return; // The ordinary card parser reports malformed payloads.
  if (kind === 'source.update' && payload.source !== 'michi' && payload.enabled === true) throw unavailable();
  if (kind === 'pipeline.watch' && Array.isArray(payload.add) && payload.add.length > 0) throw unavailable();
  if (kind === 'watch.add') assertPublicCompanionWatch(payload);
}
