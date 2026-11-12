import type { PageChangeDto } from 'michi-shared';

export interface PageChangeIndex {
  byTarget: ReadonlyMap<string, readonly PageChangeDto[]>;
  byBatch: ReadonlyMap<string, readonly PageChangeDto[]>;
}

export function changeTargetKey(change: PageChangeDto): string {
  switch (change.target.kind) {
    case 'block': return `block:${change.target.pageId}:${change.target.blockId}`;
    case 'row': return `row:${change.target.databaseId}:${change.target.rowId}`;
    case 'database': return `database:${change.target.databaseId}`;
  }
}

export function buildPageChangeIndex(changes: readonly PageChangeDto[]): PageChangeIndex {
  const byTarget = new Map<string, PageChangeDto[]>();
  const byBatch = new Map<string, PageChangeDto[]>();
  for (const change of changes) {
    const targetKey = changeTargetKey(change);
    const targetChanges = byTarget.get(targetKey) ?? [];
    targetChanges.push(change);
    byTarget.set(targetKey, targetChanges);
    const batchChanges = byBatch.get(change.batchId) ?? [];
    batchChanges.push(change);
    byBatch.set(change.batchId, batchChanges);
  }
  return { byTarget, byBatch };
}
