import type { AgentTurnInput } from '../contract/types';

/**
 * The host's per-turn context ahead of the user's text, in the order every
 * runtime sends it: maintenance, then memory, then the page context.
 */
export function turnContextPrefix(
  maintenancePrefix: string,
  input: Pick<AgentTurnInput, 'memoryContext' | 'pageContext'> | undefined,
): string {
  return maintenancePrefix
    + (input?.memoryContext ? `${input.memoryContext}\n\n---\n\n` : '')
    + (input?.pageContext ? `${input.pageContext}\n\n---\n\n` : '');
}
