import { useEffect, useMemo } from 'react';
import type { ToolCallState } from '../../state/chatTypes';
import { invalidateTurnPageReceipt, parseTurnPageReceipt, receiptShows, taskBoardPageId, type TurnPageReceipt } from '../../lib/turnPageReceipt';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import { PageReceiptRow } from './PageReceipt';
import { ReceiptLedger } from './ReceiptLedger';
import { ScheduledJobRow, parseCreatedScheduledJob, type CreatedScheduledJob } from './ScheduledJobReceipt';

type Item =
  | { kind: 'page'; id: string; writes: TurnPageReceipt[] }
  | { kind: 'job'; id: string; job: CreatedScheduledJob };

const NO_WRITES: readonly { id: string; receipt: TurnPageReceipt }[] = [];

/**
 * Under a reply: what its tool calls changed, as one list in the order they
 * ran. Writes to the same page or database share a row at its first write.
 * Page rows need the conversation's workspace; without one only jobs show.
 */
export function TurnReceipts({ tools, workspaceId, backendConnectionId }: {
  tools: readonly ToolCallState[];
  workspaceId?: string;
  backendConnectionId?: string;
}) {
  const scope = useMemo(() => (workspaceId && backendConnectionId ? { workspaceId, backendConnectionId } : null), [backendConnectionId, workspaceId]);
  const writes = useMemo(() => (scope ? tools.flatMap((tool) => {
    const receipt = parseTurnPageReceipt(tool, scope.backendConnectionId);
    return receipt && receiptShows(receipt) ? [{ id: tool.id, receipt }] : [];
  }) : NO_WRITES), [scope, tools]);

  useEffect(() => {
    if (!scope) return;
    for (const { id, receipt } of writes) invalidateTurnPageReceipt(receipt, scope, id);
  }, [scope, writes]);

  // The Meta agent window shows its own cards (with Undo) for the page writes.
  const cards = useMetaChatDecorations()?.toolCards;
  const items = useMemo(() => {
    const out: Item[] = [];
    const pageWrites = new Map(cards ? [] : writes.map(({ id, receipt }) => [id, receipt]));
    const byResource = new Map<string, TurnPageReceipt[]>();
    for (const tool of tools) {
      const receipt = pageWrites.get(tool.id);
      if (receipt) {
        const key = `${receipt.resourceKind}:${receipt.resourceId}`;
        const group = byResource.get(key);
        if (group) group.push(receipt);
        else {
          byResource.set(key, [receipt]);
          out.push({ kind: 'page', id: tool.id, writes: byResource.get(key)! });
        }
        continue;
      }
      const job = parseCreatedScheduledJob(tool);
      if (job) out.push({ kind: 'job', id: tool.id, job });
    }
    return out;
  }, [cards, tools, writes]);
  const boards = useMemo(() => writes.map(({ receipt }) => receipt), [writes]);

  const ledger = items.length > 0 && (
    <ReceiptLedger>
      {items.map((item) => (item.kind === 'job'
        ? <ScheduledJobRow key={item.id} job={item.job} backendConnectionId={backendConnectionId} />
        : scope && <PageReceiptRow key={item.id} writes={item.writes} {...scope} boardPageId={taskBoardPageId(boards, item.writes[0]!.workspaceId)} />))}
    </ReceiptLedger>
  );
  if (!cards || !scope) return ledger || null;
  return <>{cards(tools)}{ledger}</>;
}
