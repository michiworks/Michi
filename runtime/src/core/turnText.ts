import type { AgentTurnInput } from '../contract/types';

/**
 * The host's per-turn context ahead of the user's text, in the order every
 * runtime sends it: maintenance, then the standing instructions, then
 * memory, then the page context.
 */
export function turnContextPrefix(
  maintenancePrefix: string,
  input: Pick<AgentTurnInput, 'instructionsContext' | 'memoryContext' | 'pageContext'> | undefined,
): string {
  return maintenancePrefix
    + (input?.instructionsContext ? `${input.instructionsContext}\n\n---\n\n` : '')
    + (input?.memoryContext ? `${input.memoryContext}\n\n---\n\n` : '')
    + (input?.pageContext ? `${input.pageContext}\n\n---\n\n` : '');
}
