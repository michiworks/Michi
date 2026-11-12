/**
 * Check-in provenance at read time (DESIGN-v2 §2.7, §2.8 T5).
 *
 * A check-in writes Pages and databases with its own node as the source
 * (`{kind:'chat', nodeId:'n-cmph-<runId>', turnId:'cmp-<runId>', …}`), and
 * that node is purged once the run ends. Storage keeps that source for good.
 * What the user is shown is resolved here, at the outer edge of a DTO, after
 * every parser has run:
 * - a source opens the message the run posted into the conversation
 *   (`cmp-post-<runId>`), else the current conversation without a message
 *   (`turnId`/`assistantId` null), else it is dropped: no response names the
 *   purged node (W2 fix decision D12). A block's own sources carry
 *   `checkin: true` (BlockSource.checkin), a passage's segment sources do not
 *   (their parser refuses the field). A change's source cannot be dropped:
 *   with nowhere to open it keeps its kind and `checkin`, its ids emptied;
 * - who wrote it is the user's agent: a CompanionActor, decided from the node
 *   id prefix first, so it holds after the node row is gone;
 * - what a check-in wrote taints the turn that reads it: a block by its
 *   sources, a database as a whole by its change records.
 * Never write a resolved DTO back: parsePageBlock and parseChangeSource
 * refuse the flag, and the rewritten ids name the conversation.
 */
import {
  CHECKIN_NODE_PREFIX, checkinRunId, companionPostId, isAssistantWorkspaceSettings, isCheckinBlockSource, isCheckinNodeId,
  pageSegmentSources,
  type BlockSource, type ChangeSource, type CompanionActor, type CompanionTaintDetail, type PageBlock, type PageBlockContent,
  type PageChangeDto, type PageDto, type TargetMutation, type TargetSnapshot,
} from 'michi-shared';
import { workspaceOwnerMatches } from '../agentOwner';
import { getDb } from '../db';

/**
 * Where a check-in's source opens: the conversation's node and the post the
 * run made in it, or the current conversation with no message (null ids)
 * when the run posted nothing (D12).
 */
export interface CheckinSourceTarget { nodeId: string; turnId: string | null; assistantId: string | null }

/** Looks each check-in run up once per response. */
export interface CheckinSourceResolver {
  /** The target of a check-in node, or null for any other node and when there is nowhere to open. */
  target(nodeId: string): CheckinSourceTarget | null;
}

export function checkinSourceResolver(ownerUserId: string): CheckinSourceResolver {
  const runs = new Map<string, CheckinSourceTarget | null>();
  let conversation: string | null | undefined;
  const currentConversation = (): string | null => {
    if (conversation === undefined) conversation = ownedAssistantNode(currentConversationNodeId(), ownerUserId);
    return conversation;
  };
  return {
    target(nodeId) {
      const runId = checkinRunId(nodeId);
      if (!runId) return null;
      if (!runs.has(runId)) {
        const postId = companionPostId(runId);
        const holder = postedIn(postId, ownerUserId);
        const current = holder ? null : currentConversation();
        runs.set(runId, holder ? { nodeId: holder, turnId: postId, assistantId: postId }
          : current ? { nodeId: current, turnId: null, assistantId: null } : null);
      }
      return runs.get(runId) ?? null;
    },
  };
}

/** The live assistant conversation that holds a post, owned by this owner. */
function postedIn(postId: string, ownerUserId: string): string | null {
  const row = getDb().prepare(`SELECT m.node_id,w.owner_user_id,w.settings FROM messages m JOIN nodes n ON n.id=m.node_id
    JOIN workspaces w ON w.id=n.workspace_id
    WHERE m.id=? AND m.role='assistant' AND n.kind='chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL
      AND w.deleted_at IS NULL AND w.purged_at IS NULL`).get(postId) as { node_id: string; owner_user_id: string | null; settings: string | null } | undefined;
  return row && !isCheckinNodeId(row.node_id) && isAssistantWorkspaceSettings(row.settings) && workspaceOwnerMatches(row.owner_user_id, ownerUserId)
    ? row.node_id : null;
}

/**
 * The conversation the user talks to, as assistant/store.ts
 * currentAssistantNodeId finds it (the newest live assistant workspace's
 * `assistant.nodeId`, a live chat in it whose tree is not archived), read
 * straight from the database: importing the store would put the agent
 * registry and runtimes under every Pages module and close an import cycle
 * (store → dbRepository → pages/repository → here). The test holds the two equal.
 */
function currentConversationNodeId(): string | null {
  const workspaces = getDb().prepare('SELECT id,settings FROM workspaces WHERE purged_at IS NULL AND deleted_at IS NULL ORDER BY created_at DESC,updated_at DESC')
    .all() as Array<{ id: string; settings: string | null }>;
  const workspace = workspaces.find((row) => isAssistantWorkspaceSettings(row.settings));
  if (!workspace) return null;
  let nodeId: unknown;
  try { nodeId = (JSON.parse(workspace.settings ?? '{}') as { assistant?: { nodeId?: unknown } } | null)?.assistant?.nodeId; } catch { return null; }
  if (typeof nodeId !== 'string') return null;
  const node = getDb().prepare(`SELECT n.workspace_id,n.kind,n.status,n.deleted_at,t.id AS tree,t.archived_at FROM nodes n
    LEFT JOIN trees t ON t.id=n.tree_id WHERE n.id=? AND n.purged_at IS NULL`).get(nodeId) as
    { workspace_id: string; kind: string; status: string; deleted_at: number | null; tree: string | null; archived_at: number | null } | undefined;
  return node && node.workspace_id === workspace.id && node.kind === 'chat' && node.deleted_at === null && node.status !== 'archived'
    && node.tree !== null && node.archived_at === null ? nodeId : null;
}

function ownedAssistantNode(nodeId: string | null, ownerUserId: string): string | null {
  if (!nodeId || isCheckinNodeId(nodeId)) return null;
  const row = getDb().prepare('SELECT w.owner_user_id FROM nodes n JOIN workspaces w ON w.id=n.workspace_id WHERE n.id=?')
    .get(nodeId) as { owner_user_id: string | null } | undefined;
  return row && workspaceOwnerMatches(row.owner_user_id, ownerUserId) ? nodeId : null;
}

/**
 * A source as shown: a check-in's opens its target, marked `checkin` when
 * `flag`; null (drop it) when there is nowhere to open; any other source is
 * returned as it is. BlockSource types turnId/assistantId as strings, which
 * every stored source has; only this response form carries null ("no
 * message", D12), and the frontend's source popover takes a null message.
 */
function shownSource<T extends BlockSource>(source: T, resolver: CheckinSourceResolver, flag: boolean): T | null {
  if (!isCheckinNodeId(source.nodeId)) return source;
  const target = resolver.target(source.nodeId);
  if (!target) return null;
  return { ...source, ...target, ...(flag ? { checkin: true as const } : {}) } as T;
}

function shownSources(sources: readonly BlockSource[], resolver: CheckinSourceResolver, flag: boolean): BlockSource[] | null {
  let changed = false;
  const next: BlockSource[] = [];
  for (const source of sources) {
    const shown = shownSource(source, resolver, flag);
    changed ||= shown !== source;
    if (shown) next.push(shown);
  }
  return changed ? next : null;
}

/** A block's content with each passage's segment sources resolved, unflagged; the same object when none is a check-in's. */
function shownContent<T extends PageBlockContent>(content: T, resolver: CheckinSourceResolver): T {
  if (!pageSegmentSources(content).some((source) => isCheckinNodeId(source.nodeId))) return content;
  const nested = <B extends PageBlockContent>(blocks: readonly B[]): B[] => blocks.map((block) => shownContent(block, resolver));
  const value: PageBlockContent = content;
  switch (value.type) {
    case 'markdown':
      return { ...value, segmentSources: value.segmentSources?.map((segment) => ({ ...segment, sources: shownSources(segment.sources, resolver, false) ?? segment.sources })) } as T;
    case 'toggle': return { ...value, blocks: nested(value.blocks) } as T;
    case 'columns': return { ...value, columns: value.columns.map((column) => nested(column)) } as T;
    case 'tabs': return { ...value, tabs: value.tabs.map((tab) => ({ ...tab, blocks: nested(tab.blocks) })) } as T;
    case 'grid': return { ...value, regions: value.regions.map((region) => ({ ...region, blocks: nested(region.blocks) })) } as T;
    default: return content;
  }
}

/** A stored block as shown; the same object when nothing in it came from a check-in. Its sources go when all are dropped. */
export function shownBlock(block: PageBlock, resolver: CheckinSourceResolver): PageBlock {
  const content = shownContent(block, resolver);
  const sources = block.sources ? shownSources(block.sources, resolver, true) : null;
  if (content === block && !sources) return block;
  const shown = { ...content, ...(sources ? { sources } : {}) } as PageBlock;
  if (sources && sources.length === 0) delete shown.sources;
  return shown;
}

/** A page as its owner is shown it (GET /pages/:id, the page an edit returns, the Homes and the Home content page). */
export function presentPage(page: PageDto, ownerUserId: string, resolver = checkinSourceResolver(ownerUserId)): PageDto {
  let changed = false;
  const blocks = page.blocks.map((block) => {
    const shown = shownBlock(block, resolver);
    changed ||= shown !== block;
    return shown;
  });
  return changed ? { ...page, blocks } : page;
}

function shownSnapshot(snapshot: TargetSnapshot | null, resolver: CheckinSourceResolver): TargetSnapshot | null {
  if (snapshot?.kind !== 'block' || !snapshot.exists) return snapshot;
  const block = shownBlock(snapshot.block, resolver);
  return block === snapshot.block ? snapshot : { ...snapshot, block };
}

function shownMutation(mutation: TargetMutation, resolver: CheckinSourceResolver): TargetMutation {
  if (mutation.kind !== 'block' || mutation.op !== 'upsert') return mutation;
  const block = shownBlock(mutation.block, resolver);
  return block === mutation.block ? mutation : { ...mutation, block };
}

/**
 * A change's source as shown: a check-in's opens its post and says so
 * (`checkin: true`). A change always has a source, so with nowhere to open
 * (D12) it keeps its kind and the mark, with no conversation (`nodeId` '')
 * and no message: the person still sees their agent made it, and nothing
 * names the purged node.
 */
export function shownChangeSource(source: ChangeSource, resolver: CheckinSourceResolver): ChangeSource {
  if (source.kind !== 'chat' && source.kind !== 'helper') return source;
  return shownSource(source, resolver, true)
    ?? { ...source, nodeId: '', turnId: null, assistantId: null, checkin: true } as unknown as ChangeSource;
}

/** A change record as the owner is shown it (history, suggestions, and what a review action returns). */
export function presentChange(change: PageChangeDto, ownerUserId: string, resolver = checkinSourceResolver(ownerUserId)): PageChangeDto {
  const source = shownChangeSource(change.source, resolver);
  const before = shownSnapshot(change.before, resolver);
  const after = shownSnapshot(change.after, resolver);
  const forward = shownMutation(change.forward, resolver);
  const inverse = shownMutation(change.inverse, resolver);
  if (source === change.source && before === change.before && after === change.after && forward === change.forward && inverse === change.inverse) return change;
  return { ...change, source, before, after, forward, inverse };
}

export function presentChanges(changes: readonly PageChangeDto[], ownerUserId: string): PageChangeDto[] {
  const resolver = checkinSourceResolver(ownerUserId);
  return changes.map((change) => presentChange(change, ownerUserId, resolver));
}

/** The settings of a node's workspace; undefined when the node is gone. */
export function nodeWorkspaceSettings(nodeId: string): string | null | undefined {
  const row = getDb().prepare('SELECT w.settings FROM nodes n JOIN workspaces w ON w.id=n.workspace_id WHERE n.id=?')
    .get(nodeId) as { settings: string | null } | undefined;
  return row ? row.settings : undefined;
}

/**
 * The user's own agent as the writer of a change (DESIGN-v2 §2.7), or null
 * for anyone else: background maintenance is `upkeep`; a check-in (by its
 * node id, whether or not the node still exists) is `checkin`; any other
 * conversation in the assistant's workspace (the one the user talks to, the
 * archived ⌘J and Scheduled ones) is `conversation`.
 */
export function companionActorOf(
  source: Pick<ChangeSource, 'kind'> & { nodeId?: unknown } | null | undefined,
  settingsOf: (nodeId: string) => string | null | undefined = nodeWorkspaceSettings,
): CompanionActor | null {
  if (!source) return null;
  if (source.kind === 'maintenance') return { kind: 'companion', via: 'upkeep' };
  if ((source.kind !== 'chat' && source.kind !== 'helper') || typeof source.nodeId !== 'string') return null;
  if (isCheckinNodeId(source.nodeId)) return { kind: 'companion', via: 'checkin' };
  // Only the assistant's workspace holds the agent's conversations (dev 018d4efe1).
  return isAssistantWorkspaceSettings(settingsOf(source.nodeId)) ? { kind: 'companion', via: 'conversation' } : null;
}

/**
 * 'checkin' when any of these blocks, or a passage in one, came from a
 * check-in (stored or resolved form), else null. Reading them taints the
 * turn (§2.8 T5); a target or attachment pointing at them taints it from
 * the start (T4).
 */
export function blocksCheckinTaint(blocks: ReadonlyArray<PageBlockContent & { sources?: readonly BlockSource[] }>): CompanionTaintDetail | null {
  return blocks.some((block) => (block.sources ?? []).some(isCheckinBlockSource) || pageSegmentSources(block).some(isCheckinBlockSource))
    ? 'checkin' : null;
}

/** The taint of reading a page: all its blocks, or the ones named. */
export function pageCheckinTaint(page: Pick<PageDto, 'blocks'>, blockIds?: readonly string[]): CompanionTaintDetail | null {
  const named = blockIds ? new Set(blockIds) : null;
  return blocksCheckinTaint(named ? page.blocks.filter((block) => named.has(block.id)) : page.blocks);
}

/**
 * The taint of reading these databases, each as a whole: 'checkin' when a
 * check-in's change to one of them still stands (applied, or a suggestion
 * waiting for review), whatever row or column it touched, or when a check-in
 * made the database (its title is the check-in's) and it is still there; else null.
 * A check-in makes a database (databaseWrites.ts createAgentDatabase) with its
 * first change in the same write: that change starts from revision 1 at the
 * moment the database was created.
 */
export function databasesCheckinTaint(databaseIds: Iterable<string>, ownerUserId: string): CompanionTaintDetail | null {
  const ids = [...new Set(databaseIds)].filter((id) => typeof id === 'string' && id.length > 0);
  if (!ids.length) return null;
  const found = getDb().prepare(`SELECT 1 FROM page_changes c WHERE c.owner_user_id=? AND c.database_id IN (${ids.map(() => '?').join(',')})
    AND substr(c.source_node_id,1,?)=? AND (c.application_state='applied' OR c.proposal_state='pending'
      OR (json_extract(c.before_json,'$.kind')='database' AND json_extract(c.before_json,'$.database.revision')=1
        AND c.created_at=(SELECT d.created_at FROM page_databases d WHERE d.id=c.database_id AND d.owner_user_id=c.owner_user_id AND d.deleted_at IS NULL))) LIMIT 1`)
    .get(ownerUserId, ...ids, CHECKIN_NODE_PREFIX.length, CHECKIN_NODE_PREFIX);
  return found ? 'checkin' : null;
}

/** The taint of reading one database (read_database, a Conversations-cell ref at turn start). */
export function databaseCheckinTaint(databaseId: string, ownerUserId: string): CompanionTaintDetail | null {
  return databasesCheckinTaint([databaseId], ownerUserId);
}
