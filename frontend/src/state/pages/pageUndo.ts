import type { PageEditOp } from 'michi-shared';
import { revertPageBatch } from '../../services/api/pages';
import { notifyPageChanged, type PageEventIdentity } from './pageEvents';

export interface PageBatchToUndo {
  batchId: string;
  workspaceId: string;
  /** The events that tell the views showing what the batch changed to read it again. */
  changed: readonly PageEventIdentity[];
}

/** How many changes a batch action put back, and how many it left because they changed again since. */
export interface BatchOutcome {
  done: number;
  conflicts: number;
}

export const UNDO_FAILED = "Couldn't undo that just now.";

/**
 * Undoes the batches, newest first, each against what the one after it left.
 * The backend undoes each change that still applies and reports the others
 * as conflicts, so a batch can come back partly undone.
 */
export async function revertPageBatches(backendConnectionId: string, batches: readonly PageBatchToUndo[]): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { done: 0, conflicts: 0 };
  for (const batch of [...batches].reverse()) {
    const answer = await revertPageBatch(batch.batchId, { backendConnectionId, workspaceId: batch.workspaceId });
    outcome.done += answer.reverted.length;
    outcome.conflicts += answer.conflicts.length;
    for (const identity of batch.changed) notifyPageChanged(identity);
  }
  return outcome;
}

/** What to tell the user when a batch Undo or Restore left changes in place; null when nothing was left. */
export function batchOutcomeNotice(outcome: BatchOutcome, verb: 'undone' | 'restored', hint?: string): string | null {
  if (outcome.conflicts === 0) return null;
  if (outcome.done > 0) return `Not all of it was ${verb}: some of it changed again since.`;
  return `Not ${verb}: it changed again since.${hint ? ` ${hint}` : ''}`;
}

const PAGE_OP_LABEL: Record<PageEditOp['op'], string> = {
  insert: 'Added a block',
  update: 'Edited a block',
  delete: 'Deleted a block',
  move: 'Moved a block',
  release: 'Changed a block',
};

/** What a user's page edit did, for its undo entry: `Edited a block in “Plan”`. */
export function pageEditLabel(ops: readonly PageEditOp[], pageTitle?: string): string {
  const kinds = new Set(ops.map((op) => op.op));
  const [only] = kinds;
  const what = kinds.size === 1 && ops.length === 1 ? PAGE_OP_LABEL[only] : 'Changed blocks';
  const title = pageTitle?.trim();
  return title ? `${what} in “${title}”` : what;
}

/** The batch ids a user write made, each once. */
export function writtenBatchIds(changes: { applied?: ReadonlyArray<{ batchId?: string | null }> } | null | undefined): string[] {
  return [...new Set((changes?.applied ?? []).flatMap((change) => change.batchId ? [change.batchId] : []))];
}

/**
 * The undo-history reversal of a user write (state/undoStack.ts): its
 * batches put back, or the notice for what changed again since and stayed.
 */
export function undoPageBatches(backendConnectionId: string, batches: readonly PageBatchToUndo[], hint?: string): () => Promise<true | string> {
  return async () => batchOutcomeNotice(await revertPageBatches(backendConnectionId, batches), 'undone', hint) ?? true;
}
