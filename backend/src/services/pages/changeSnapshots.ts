import { rowLocation, type BlockLocation, type PageDatabase, type PageDto, type TargetSnapshot } from 'michi-shared';

/**
 * The before/after snapshots change history stores. Writers record them and undo, redo and accept rebuild
 * them to check the target is still as recorded, so both sides must build them here.
 */
export type BlockSnapshot = Extract<TargetSnapshot, { kind: 'block' }>;

export function blockSnapshot(block: PageDto['blocks'][number] | undefined, location: BlockLocation | null, id: string): BlockSnapshot {
  return block && location
    ? { kind: 'block', exists: true, block, location }
    : { kind: 'block', exists: false, id, location: null };
}

export function rowSnapshot(database: PageDatabase, rowId: string): TargetSnapshot {
  const row = database.rows.find((item) => item.id === rowId);
  return row ? { kind: 'row', exists: true, row: structuredClone(row), location: rowLocation(database, rowId) }
    : { kind: 'row', exists: false, id: rowId, location: null };
}

export function dbSnapshot(database: PageDatabase): TargetSnapshot {
  return { kind: 'database', exists: true, database: {
    id: database.id, workspaceId: database.workspaceId, title: database.title,
    columns: structuredClone(database.columns), views: structuredClone(database.views),
    revision: database.revision, updatedAt: database.updatedAt,
  } };
}
