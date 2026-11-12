/** Public Companion watches local Michi activity; external collectors are not bundled. */
import type { CompanionSettings } from 'michi-shared';
import type { CompanionDeepReads, CompanionSource } from '../types';
import type { CompanionAuthChecker } from './auth';
export interface CompanionExternalSources {
  sources: CompanionSource[];
  auth: CompanionAuthChecker | null;
  deepReads: CompanionDeepReads;
  dispose(): Promise<void>;
}
export function createExternalSources(_options: { settings?: () => CompanionSettings } = {}): CompanionExternalSources {
  const unavailable = async () => ({ ok: false, text: 'External sources are not configured in this build.' });
  return { sources: [], auth: null, deepReads: { crDetail: unavailable, pipelineDetail: unavailable, emailSearch: unavailable }, dispose: async () => {} };
}
