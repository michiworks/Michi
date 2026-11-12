import { useOptionalChatActions } from '../../state/chatStore';
import {
  putsTaskBoard, receiptPageId, receiptRevealTarget, resetTurnPageReceiptInvalidationForTests, taskWriteLine, type TaskWriteCounts, type TurnPageReceipt,
} from '../../lib/turnPageReceipt';
import { ReceiptRow } from './ReceiptLedger';
import { revealPageTarget } from '../../state/pages/revealPageTarget';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const joined = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;
const sum = (writes: readonly TurnPageReceipt[], pick: (write: TurnPageReceipt) => number) =>
  writes.reduce((total, write) => total + pick(write), 0);

function taskTotals(writes: readonly TurnPageReceipt[]): TaskWriteCounts | null {
  const counted = writes.filter((write) => write.tasks);
  if (!counted.length) return null;
  return {
    added: sum(counted, (write) => write.tasks!.added),
    updated: sum(counted, (write) => write.tasks!.updated),
    removed: sum(counted, (write) => write.tasks!.removed),
  };
}

/** A reply's writes to one page or database, in order, read as one: its row opens it once. */
function mergePageWrites(writes: readonly TurnPageReceipt[]): TurnPageReceipt {
  const first = writes[0]!;
  const last = writes[writes.length - 1]!;
  const tasks = taskTotals(writes);
  const workspaceId = writes.find((write) => write.workspaceId)?.workspaceId;
  const originatingPageId = writes.find((write) => write.originatingPageId)?.originatingPageId;
  return {
    ...first,
    title: last.title,
    ...(workspaceId ? { workspaceId } : {}),
    ...(originatingPageId ? { originatingPageId } : {}),
    originatingPageIds: [...new Set(writes.flatMap((write) => write.originatingPageIds))],
    created: writes.some((write) => write.created),
    appliedCount: sum(writes, (write) => write.appliedCount),
    proposedCount: sum(writes, (write) => write.proposedCount),
    affectedTargetIds: writes.flatMap((write) => write.affectedTargetIds),
    changes: writes.flatMap((write) => write.changes),
    ...(tasks ? { tasks } : {}),
    ...(writes.some((write) => write.taskBoard) ? { taskBoard: true as const } : {}),
  };
}

/** The row's verb and note. A page made and then filled in by the same reply is one Created. */
function pageReceiptLine(writes: readonly TurnPageReceipt[]): { verb: string; meta: string | null } {
  const merged = mergePageWrites(writes);
  const waiting = merged.proposedCount ? `${merged.proposedCount} waiting for you` : null;
  const tasks = merged.tasks ? taskWriteLine(merged.tasks) : null;
  const taskNote = tasks && tasks[0]!.toLowerCase() + tasks.slice(1);
  if (merged.created) {
    const edits = sum(writes.filter((write) => !write.created), (write) => write.appliedCount);
    return { verb: 'Created', meta: joined(merged.resourceKind === 'database' ? 'Database' : 'Page', taskNote ?? (edits ? count(edits, 'edit') : null), waiting) };
  }
  if (taskNote) return { verb: 'Updated', meta: joined(taskNote, waiting) };
  if (putsTaskBoard(merged)) {
    const more = merged.appliedCount - 1;
    return { verb: 'Updated', meta: joined('added a task board', more > 0 ? count(more, 'more change') : null, waiting) };
  }
  return { verb: 'Updated', meta: joined(count(merged.appliedCount + merged.proposedCount, 'place'), waiting) };
}

export function PageReceiptRow({ writes, workspaceId, backendConnectionId, boardPageId }: {
  /** This reply's writes to one resource, in order. */
  writes: readonly TurnPageReceipt[];
  workspaceId: string;
  backendConnectionId: string;
  /** The page this reply put a task board on: where a task write opens while no page showed its tasks yet. */
  boardPageId: string | null;
}) {
  const openPagePane = useOptionalChatActions()?.openPagePane;
  const receipt = mergePageWrites(writes);
  const { verb, meta } = pageReceiptLine(writes);
  const ownWorkspaceId = receipt.workspaceId ?? workspaceId;
  const pageId = receiptPageId(receipt, boardPageId);
  const openPage = (pageId: string) => {
    openPagePane?.({ pageId, workspaceId: ownWorkspaceId, backendConnectionId, title: receipt.title });
    const target = receiptRevealTarget(receipt);
    if (target) revealPageTarget({ ...target, pane: { pageId, workspaceId: ownWorkspaceId, backendConnectionId } });
  };
  return (
    <ReceiptRow
      kind="page"
      verb={verb}
      object={receipt.title}
      meta={meta}
      action={openPagePane && pageId ? { label: 'View', onClick: () => openPage(pageId) } : null}
    />
  );
}

/** @testonly */
export function resetPageReceiptInvalidationForTests(): void { resetTurnPageReceiptInvalidationForTests(); }
