/**
 * A check-in's throwaway node S (DESIGN-v2 §2.2, §3.1): `n-cmph-<runId>`, a
 * tree of its own in the assistant's hidden workspace, made for one run and
 * hard-deleted after it. Only createCheckinNode makes one: clients cannot
 * (the save and restore routes refuse the prefix, §2.5), and the prefix alone
 * gives S the closed profile. No UI event is sent for it, and its turn is
 * private (chatHub), so no window ever learns of it.
 *
 * purgeCheckinNode deletes every row that names S, in one transaction: its
 * messages, turns, trust and permission rows, edit leases, FTS entries,
 * native-session ledger and `assistant*` meta, then its edges, the node and
 * its tree. What S wrote into Pages keeps S as its source (page_changes,
 * page_revisions, block sources): those resolve by the id's prefix, never by
 * S's row (§2.7). No tombstone is left: S's id is never used again, and SQLite
 * here has no secure_delete, so the copy says "not kept", never "erased".
 *
 * The Michi Memory a check-in reads (D5) is S's too: its resident pack
 * (startCheckinMemory), whose signature stays under S until S's purge, so a
 * restart can still check it (checkinMemoryHolds) before what the check-in
 * left goes out.
 */

import { checkinNodeId, isCheckinNodeId } from 'michi-shared';
import { assistantPurposeKey } from '../../assistant/identity';
import { requestAgentOwnerOrNull } from '../agentOwner';
import { getDb } from '../db';
import { log } from '../logger';
import { buildMemoryPack, memoryPackSignature, type BuildMemoryPackInput } from '../memory/contextBuilder';
import { companionTransaction, setRunCheckinNode } from './repository';

export interface CheckinNode {
  workspaceId: string;
  nodeId: string;
  treeId: string;
}

/**
 * The meta value S's purpose is recorded as: `companion`, the MVP's closed
 * purpose, so a revert to the MVP code still binds S closed (§2.2). The id's
 * prefix decides it in v2, whatever the row says.
 */
const CHECKIN_PURPOSE_META = 'companion';

/**
 * Makes S for run `runId` in the assistant workspace `workspaceId`: its
 * purpose meta and the run's checkin_node_id first, then its tree and node,
 * in one transaction (§3.1 step 2). The tree is not archived and never the
 * workspace's active one: S is a live chat while its turn runs (its page
 * writes need that, pages/core.ts requireChatChangeSource).
 */
export function createCheckinNode(runId: string, workspaceId: string, now: number): CheckinNode {
  const nodeId = checkinNodeId(runId);
  const treeId = `t-cmph-${runId}`;
  return companionTransaction(() => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(nodeId), CHECKIN_PURPOSE_META);
    setRunCheckinNode(runId, nodeId);
    db.prepare(`INSERT INTO trees (id, workspace_id, root_node_id, name, last_active_at, created_at) VALUES (?, ?, ?, NULL, ?, ?)`)
      .run(treeId, workspaceId, nodeId, now, now);
    db.prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, created_at) VALUES (?, ?, ?, 'chat', 'idle', ?)`)
      .run(nodeId, workspaceId, treeId, now);
    return { workspaceId, nodeId, treeId };
  });
}

/** Whether S's node row is still there (cleanup purges it only once its session let go). */
export function checkinNodeExists(nodeId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
}

/** The tables with a `node_id` column: each row of one names a chat node. Read from the schema, so a new such table is covered too. */
function tablesWithNodeId(): string[] {
  const db = getDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
  return tables
    .map((table) => table.name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name)
      && (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).some((column) => column.name === 'node_id'));
}

/**
 * Hard-deletes S and every row that names it (see the module comment); only
 * a check-in node, never any other. Its tree's other nodes, if anything ever
 * put one there, go too. Returns whether S's row was there.
 */
export function purgeCheckinNode(nodeId: string): boolean {
  if (!isCheckinNodeId(nodeId)) throw new Error(`${nodeId} is not a check-in node`);
  const tables = tablesWithNodeId();
  return companionTransaction(() => {
    const db = getDb();
    const node = db.prepare('SELECT tree_id FROM nodes WHERE id = ?').get(nodeId) as { tree_id: string | null } | undefined;
    const treeIds = new Set<string>(node?.tree_id ? [node.tree_id] : []);
    for (const row of db.prepare('SELECT id FROM trees WHERE root_node_id = ?').all(nodeId) as Array<{ id: string }>) treeIds.add(row.id);
    const nodeIds = new Set<string>([nodeId]);
    for (const treeId of treeIds) {
      for (const row of db.prepare('SELECT id FROM nodes WHERE tree_id = ?').all(treeId) as Array<{ id: string }>) nodeIds.add(row.id);
    }
    for (const id of nodeIds) {
      // messages_fts follows messages (its trigger); every other table keyed by node goes by name.
      for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE node_id = ?`).run(id);
      db.prepare('DELETE FROM edges WHERE source_node_id = ? OR target_node_id = ?').run(id, id);
      // The purpose and the conversation's runtime pick: `assistant:purpose:<id>`, `assistant_conversation_runtime:<id>`, ….
      db.prepare(`DELETE FROM meta WHERE key LIKE 'assistant%' AND substr(key, -length(?) - 1) = ':' || ?`).run(id, id);
    }
    // nodes_fts follows the node rows (its trigger); trust and grants also cascade.
    for (const id of nodeIds) db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    for (const treeId of treeIds) db.prepare('DELETE FROM trees WHERE id = ?').run(treeId);
    return !!node;
  });
}

/** Where S keeps the signature of the memory pack its check-in started with: an `assistant…:<S>` key, which S's purge takes. */
const memoryKey = (runId: string) => `assistant:checkin-memory:${checkinNodeId(runId)}`;

/** What check-in run `runId` reads of Michi Memory: the resident pack (contextBuilder consumer 'checkin'), never recall. */
function memoryInput(runId: string): BuildMemoryPackInput {
  return { consumer: 'checkin', ownerUserId: requestAgentOwnerOrNull(null) ?? '', workspaceId: null, nodeId: checkinNodeId(runId), query: '' };
}

/** What a check-in's tool hears once its results are withdrawn (checkinMemoryHolds). */
export const CHECKIN_WITHDRAWN_MESSAGE = 'Michi Memory changed while this check-in ran, so nothing from it goes out.';

/**
 * The Michi Memory check-in run `runId` starts with (D5): its resident pack,
 * built now, whose text (null: nothing to show, or memory off) is its turn's
 * memory context, and whose signature S keeps. Throws when memory cannot be
 * read.
 */
export function startCheckinMemory(runId: string): string | null {
  const pack = buildMemoryPack(memoryInput(runId));
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(memoryKey(runId), pack.signature ?? '');
  return pack.text;
}

/**
 * Whether what check-in run `runId`'s pack showed when it started still
 * holds, asked before each of its results goes out (its post into V, its
 * brief, a follow-up it sends itself). False once it changed, and from then
 * on (the signature S kept goes); false too when S kept none or memory
 * cannot be read (fail closed).
 */
export function checkinMemoryHolds(runId: string): boolean {
  try {
    const kept = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(memoryKey(runId)) as { value: string } | undefined;
    if (!kept) return false;
    if ((memoryPackSignature(memoryInput(runId)) ?? '') === kept.value) return true;
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(memoryKey(runId));
    log.info('chat', 'companion check-in withdrawn: Michi Memory changed while it ran', { runId });
    return false;
  } catch (error) {
    log.warn('chat', 'companion check-in memory not checked; its results are withdrawn', { runId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
