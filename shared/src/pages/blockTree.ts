import type { PageBlock } from './blocks';
import type { BlockLocation, RowLocation } from './types';

export interface BlockSnapshot {
  exists: boolean;
  block: PageBlock | null;
  location: BlockLocation | null;
}

export function blockLocation(blocks: readonly PageBlock[], index: number): BlockLocation {
  return {
    parentId: null,
    slot: null,
    previousId: index > 0 ? blocks[index - 1].id : null,
    nextId: index + 1 < blocks.length ? blocks[index + 1].id : null,
  };
}

/** A missing row's location is the end of the table. */
export function rowLocation(database: { readonly rows: readonly { id: string }[] }, rowId: string): RowLocation {
  const position = database.rows.findIndex((row) => row.id === rowId);
  if (position < 0) return { position: database.rows.length, after: database.rows[database.rows.length - 1]?.id ?? null };
  return { position, after: database.rows[position - 1]?.id ?? null };
}

export function snapshotBlock(blocks: readonly PageBlock[], index: number): BlockSnapshot {
  return { exists: true, block: blocks[index], location: blockLocation(blocks, index) };
}

export function missingBlockSnapshot(): BlockSnapshot {
  return { exists: false, block: null, location: null };
}

/** Return the target index for an `after` anchor. Null means the beginning. */
export function insertionIndex(blocks: readonly PageBlock[], after: string | null): number | null {
  if (after === null) return 0;
  const index = blocks.findIndex((block) => block.id === after);
  return index < 0 ? null : index + 1;
}
