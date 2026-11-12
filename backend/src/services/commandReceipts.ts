import { createHash } from 'node:crypto';
import { getDb } from './db';
import { DomainError } from './domainErrors';
import { canonical } from './pages/canonicalJson';

export interface CommandReceiptKey {
  /** The ledger the operation id is unique in: a workspace id, or a caller's own namespace. */
  ledgerId: string;
  operationId: string;
  /** What the caller asked for; a repeat must ask for the same thing. */
  request: unknown;
  now: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Runs a command once per operation id. A repeat with the same request gets
 * the first result back; a different request under that id is a conflict.
 * Call it inside runInTransaction, so the receipt commits with the command.
 */
export function withCommandReceipt<T>(key: CommandReceiptKey, run: () => T): T {
  const hash = sha256(JSON.stringify(canonical(key.request)));
  const prior = getDb().prepare('SELECT payload_hash, result_json FROM command_receipts WHERE workspace_id = ? AND operation_id = ?')
    .get(key.ledgerId, key.operationId) as { payload_hash: string; result_json: string } | undefined;
  if (prior) {
    // Receipts written before 2026-11-10 hashed the request with its key order.
    if (prior.payload_hash !== hash && prior.payload_hash !== sha256(JSON.stringify(key.request))) {
      throw new DomainError('conflict', 'operation_id_reused', `operation ${key.operationId} was reused with a different payload`);
    }
    return JSON.parse(prior.result_json) as T;
  }
  const result = run();
  getDb().prepare('INSERT INTO command_receipts (workspace_id, operation_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(key.ledgerId, key.operationId, hash, JSON.stringify(result), key.now);
  return result;
}

/** Receipts keep each command's result, so they go when their owner's data does. */
export function deleteCommandReceipts(ledgerIds: readonly string[]): void {
  for (let start = 0; start < ledgerIds.length; start += 500) {
    const chunk = ledgerIds.slice(start, start + 500);
    getDb().prepare(`DELETE FROM command_receipts WHERE workspace_id IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
  }
}
