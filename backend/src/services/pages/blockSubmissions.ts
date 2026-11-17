import {
  BLOCK_SUBMISSION_LIMITS, blockSubmissionHostKey, isBlockSubmissionBlockId,
  type BlockSubmission, type BlockSubmissionHost,
} from 'michi-shared';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError, pageTimestamp, requirePagesWorkspace } from './core';

/**
 * Interactive block submissions (migration 0096): what a person sent through
 * a form, poll or choice on a page or in a chat message. Every read and write
 * first finds the host in the owner's workspace; a write also needs the host
 * to be writable (not archived, trashed or gone). The first write for a
 * block and signature wins; a second answers with the stored one.
 */

const SIGNATURE = /^[A-Za-z0-9_-]+$/;

/** A write refused because the block already has a submission for this signature; it carries the stored one. */
export class BlockSubmissionExistsError extends Error {
  constructor(public readonly submission: BlockSubmission) { super('Block already submitted'); this.name = 'BlockSubmissionExistsError'; }
}

interface SubmissionRow { block_id: string; signature: string; value: string; text: string; submitted_at: number }

const toSubmission = (row: SubmissionRow): BlockSubmission => ({
  blockId: row.block_id, signature: row.signature, value: JSON.parse(row.value) as unknown, text: row.text, submittedAt: row.submitted_at,
});

const notFound = (what: string): never => { throw new PageWriteError(404, 'not_found', `${what} not found`); };
const invalid = (message: string): never => { throw new PageWriteError(400, 'invalid', message); };

/** The page in the owner's workspace. Reads may see a page in the trash; writes need a live page in a writable workspace. */
function requirePageHost(workspaceId: string, ownerUserId: string, pageId: string, write: boolean): void {
  requirePagesWorkspace(workspaceId, ownerUserId, write);
  const page = getDb().prepare('SELECT deleted_at FROM pages WHERE id=? AND workspace_id=? AND owner_user_id=?')
    .get(pageId, workspaceId, ownerUserId) as { deleted_at: number | null } | undefined;
  if (!page || (write && page.deleted_at !== null)) notFound('Page');
}

/**
 * The assistant message of a chat in the owner's workspace. A chat's
 * workspace need not hold Pages (the assistant's own one does not), so this
 * checks the workspace itself. Writes need the chat live and not archived.
 */
function requireChatHost(workspaceId: string, ownerUserId: string, nodeId: string, messageId: string, write: boolean): void {
  const row = getDb().prepare(`SELECT w.owner_user_id AS workspace_owner, w.deleted_at AS workspace_deleted, w.purged_at AS workspace_purged,
      w.archived_at AS workspace_archived, n.kind, n.status, n.deleted_at, n.purged_at, tr.archived_at AS tree_archived
    FROM messages m JOIN nodes n ON n.id=m.node_id JOIN workspaces w ON w.id=n.workspace_id LEFT JOIN trees tr ON tr.id=n.tree_id
    WHERE m.id=? AND m.node_id=? AND m.role='assistant' AND n.workspace_id=?`).get(messageId, nodeId, workspaceId) as {
      workspace_owner: string | null; workspace_deleted: number | null; workspace_purged: number | null; workspace_archived: number | null;
      kind: string; status: string; deleted_at: number | null; purged_at: number | null; tree_archived: number | null;
    } | undefined;
  if (!row || !workspaceOwnerMatches(row.workspace_owner, ownerUserId) || row.workspace_deleted !== null || row.workspace_purged !== null ||
    row.kind !== 'chat' || row.purged_at !== null || (write && row.deleted_at !== null)) notFound('Message');
  if (write && (row!.workspace_archived !== null || row!.tree_archived !== null || row!.status === 'archived')) {
    throw new PageWriteError(409, 'invalid', 'Archived conversation is read-only');
  }
}

function requireHost(workspaceId: string, ownerUserId: string, host: BlockSubmissionHost, write: boolean): void {
  if (!ownerUserId) notFound('Workspace');
  if (host.kind === 'page') requirePageHost(workspaceId, ownerUserId, host.pageId, write);
  else requireChatHost(workspaceId, ownerUserId, host.nodeId, host.messageId, write);
}

/** A page block a submission may name: a top-level block of the page, or a child of one (`<id>.<position>`). */
function requirePageBlock(pageId: string, blockId: string): void {
  const top = blockId.split('.')[0];
  const found = getDb().prepare("SELECT 1 FROM pages p, json_each(p.blocks) b WHERE p.id=? AND json_extract(b.value,'$.id')=?").get(pageId, top);
  if (!found) notFound('Block');
}

export function listBlockSubmissions(workspaceId: string, ownerUserId: string, host: BlockSubmissionHost): BlockSubmission[] {
  requireHost(workspaceId, ownerUserId, host, false);
  const rows = getDb().prepare(`SELECT block_id,signature,value,text,submitted_at FROM block_submissions
    WHERE owner_user_id=? AND workspace_id=? AND host_key=? ORDER BY submitted_at,block_id`)
    .all(ownerUserId, workspaceId, blockSubmissionHostKey(host)) as unknown as SubmissionRow[];
  return rows.map(toSubmission);
}

export interface BlockSubmissionInput {
  workspaceId: string;
  ownerUserId: string;
  host: BlockSubmissionHost;
  blockId: unknown;
  signature: unknown;
  value: unknown;
  text: unknown;
  now?: number;
}

/** Stores a submission, or throws BlockSubmissionExistsError with the one already stored for this block and signature. */
export function recordBlockSubmission(input: BlockSubmissionInput): BlockSubmission {
  const { workspaceId, ownerUserId, host } = input;
  if (!isBlockSubmissionBlockId(input.blockId)) invalid('Invalid blockId');
  if (typeof input.signature !== 'string' || !input.signature || input.signature.length > BLOCK_SUBMISSION_LIMITS.signatureLength ||
    !SIGNATURE.test(input.signature)) invalid('Invalid signature');
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > BLOCK_SUBMISSION_LIMITS.textBytes) invalid('Invalid text');
  let value: string | undefined;
  try { value = input.value === undefined ? undefined : JSON.stringify(input.value); } catch { value = undefined; }
  if (value === undefined) return invalid('Invalid value');
  if (Buffer.byteLength(value, 'utf8') > BLOCK_SUBMISSION_LIMITS.valueBytes) invalid('Value exceeds 16 KB');
  const blockId = input.blockId as string;
  const signature = input.signature as string;
  const text = input.text as string;
  const now = pageTimestamp(input.now);
  requireHost(workspaceId, ownerUserId, host, true);
  if (host.kind === 'page') requirePageBlock(host.pageId, blockId);
  const hostKey = blockSubmissionHostKey(host);
  const db = getDb();
  const inserted = db.prepare(`INSERT INTO block_submissions
    (owner_user_id,workspace_id,host_key,page_id,node_id,message_id,block_id,signature,value,text,submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(
    ownerUserId, workspaceId, hostKey,
    host.kind === 'page' ? host.pageId : null, host.kind === 'chat' ? host.nodeId : null, host.kind === 'chat' ? host.messageId : null,
    blockId, signature, value, text, now,
  );
  const stored = db.prepare(`SELECT block_id,signature,value,text,submitted_at FROM block_submissions
    WHERE owner_user_id=? AND workspace_id=? AND host_key=? AND block_id=? AND signature=?`)
    .get(ownerUserId, workspaceId, hostKey, blockId, signature) as unknown as SubmissionRow;
  if (Number(inserted.changes) === 0) throw new BlockSubmissionExistsError(toSubmission(stored));
  return toSubmission(stored);
}
