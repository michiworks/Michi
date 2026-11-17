import type { DeferredToolCallsStatus } from '../../state/deferredToolCalls';

/**
 * What a deferred call's payload says where its output goes while the output
 * is read (state/deferredToolCalls.ts): undefined when there is nothing to say.
 */
export function deferredOutputNote(status: DeferredToolCallsStatus | undefined, hasOutput: boolean): string | undefined {
  if (status === 'failed') return 'Couldn’t load the output.';
  if (status === 'loading') return 'Loading output…';
  return hasOutput ? 'The output isn’t available.' : undefined;
}
