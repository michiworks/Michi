import type { ChatNodeState } from '../../../state/chatTypes';
import { nodeDisplayLabel } from '../../../state/displayTitle';

export interface RowLabel {
  text: string;
  /** No title yet: the text is an excerpt of the first message, shown until a title arrives. */
  provisional: boolean;
}

/**
 * What a sidebar row calls a conversation: its user-set name, else
 * nodeDisplayLabel's title or first-message excerpt (cut at `max`), the
 * excerpt marked provisional; else "Untitled". The excerpt is display only
 * and never becomes the node's title, so the first reply can still supply one.
 */
export function rowLabel(name: string | undefined, node: ChatNodeState | null | undefined, max?: number): RowLabel {
  const settled = name?.trim();
  if (settled) return { text: settled, provisional: false };
  const { text, excerpt } = nodeDisplayLabel(node, 'Untitled', max);
  return { text, provisional: excerpt };
}

/** Text style of a provisional label: italic and muted, so it reads as temporary. */
export const PROVISIONAL_LABEL_STYLE = { fontStyle: 'italic', color: 'var(--term-muted)' } as const;
