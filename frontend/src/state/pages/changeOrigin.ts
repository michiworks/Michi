import type { ChangeReadScope, PageChangeDto } from 'michi-shared';
import type { ExactPageSource } from './revealSource';

/** Where a change came from: the messages it cites, else what its run read, else the run itself. */
export interface ChangeOrigin {
  cited: ExactPageSource[];
  read: ChangeReadScope | null;
  run: ExactPageSource | null;
}

export function changeOrigin(source: PageChangeDto['source']): ChangeOrigin {
  if (source.kind === 'chat' || source.kind === 'helper') return { cited: [source], read: null, run: null };
  if (source.kind !== 'maintenance') return { cited: [], read: null, run: null };
  // Background maintenance cites the conversation message it read; its own run is only the writer.
  const cited = source.evidence.map((entry): ExactPageSource => ({ kind: 'chat', nodeId: entry.nodeId, turnId: entry.turnId, assistantId: entry.messageId ?? entry.assistantId }));
  if (source.read) return { cited, read: source.read, run: null };
  // Before blocks named their sources a first run listed every conversation it read, so none of them is this block's.
  if (cited.length > 1) return { cited: [], read: { kind: 'conversations', count: cited.length }, run: null };
  const run: ExactPageSource = { kind: 'chat', nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId };
  return { cited, read: null, run: cited.length ? null : run };
}

/** "3 conversations", "1 workspace home". */
export function readLabel(read: ChangeReadScope): string {
  const noun = read.kind === 'conversations' ? 'conversation' : 'workspace home';
  return `${read.count} ${noun}${read.count === 1 ? '' : 's'}`;
}
