/**
 * TEMPORARY re-export barrel. The repository code lives in ./repository/, one file per
 * aggregate (cleanup audit STR-17, tracker F380). This file keeps exactly the exported
 * surface the single dbRepository.ts had, so none of its importers changed.
 * Follow-up: point the importers at ./repository/<aggregate> and delete this file.
 *
 * Values are re-exported as `export const name = module.name`, not `export { name } from`:
 * CommonJS getters would make them read-only, and tests replace getNode, getWorkspace,
 * getWorkspaceInstructions, listEdges, getNodeSessionBinding and setNodeExternalSessionId
 * here with t.mock.method or by assignment. TOMBSTONE_TTL_MS and runTombstoneGc are the
 * exception: only tests import them from here, so knip (ignoreExportsUsedInFile) would
 * report their const forms, and no test replaces them.
 *
 * updateNodeResumeBinding stays here: backend/test/fixtures/runtimeBoundary/runtime-ids.txt
 * keys its 'claude', 'codex' and 'kiro' comparisons to this file. It moves to
 * ./repository/runtimeBindings.ts when those entries can move with it.
 */
import { getDb } from './db';
import * as workspaces from './repository/workspaces';
import * as workspaceSettings from './repository/workspaceSettings';
import * as trees from './repository/trees';
import * as nodes from './repository/nodes';
import * as nodeTrash from './repository/nodeTrash';
import * as edges from './repository/edges';
import * as messages from './repository/messages';
import * as turns from './repository/turns';
import * as contexts from './repository/contexts';
import * as loaders from './repository/loaders';
import * as runtimeBindings from './repository/runtimeBindings';
import * as userAgentConfigs from './repository/userAgentConfigs';
import * as ownership from './repository/ownership';

export { TOMBSTONE_TTL_MS, runTombstoneGc } from './repository/tombstones';

export type { FolderEntry, WorkspaceRow } from './repository/workspaces';
export const listWorkspaces = workspaces.listWorkspaces;
export const getWorkspace = workspaces.getWorkspace;
export const parseFolders = workspaces.parseFolders;
export const MAX_FOLDERS = workspaces.MAX_FOLDERS;
export const validateNoNesting = workspaces.validateNoNesting;
export const saveWorkspace = workspaces.saveWorkspace;
export const deleteWorkspace = workspaces.deleteWorkspace;
export const purgeWorkspaceInTransaction = workspaces.purgeWorkspaceInTransaction;
export const setWorkspaceBackend = workspaces.setWorkspaceBackend;
export const getWorkspaceBackend = workspaces.getWorkspaceBackend;

export type { PermissionGrant } from './repository/workspaceSettings';
export const getAiGlobalContext = workspaceSettings.getAiGlobalContext;
export const setAiGlobalContext = workspaceSettings.setAiGlobalContext;
export const getWorkspaceInstructions = workspaceSettings.getWorkspaceInstructions;
export const listGrants = workspaceSettings.listGrants;
export const revokePermission = workspaceSettings.revokePermission;

export type { TreeRow } from './repository/trees';
export const listTrees = trees.listTrees;
export const saveTree = trees.saveTree;
export const deleteTree = trees.deleteTree;
export const moveTreeToWorkspace = trees.moveTreeToWorkspace;
export const isTreeArchived = trees.isTreeArchived;

export type { NodeRow } from './repository/nodes';
export const listNodes = nodes.listNodes;
export const getNode = nodes.getNode;
export const saveNode = nodes.saveNode;
export const markNodeViewed = nodes.markNodeViewed;
export const markNodeCompletionSeen = nodes.markNodeCompletionSeen;
export const markNodeMaintenanceJob = nodes.markNodeMaintenanceJob;
export const updateNodeTitle = nodes.updateNodeTitle;
export const updateNodeBranchOverview = nodes.updateNodeBranchOverview;
export const setNodeForkProvenance = nodes.setNodeForkProvenance;
export const restoreNodeMemoryMode = nodes.restoreNodeMemoryMode;

export type { TrimSnapshot } from './repository/nodeTrash';
export const softDeleteNode = nodeTrash.softDeleteNode;
export const restoreNode = nodeTrash.restoreNode;
export const emptyWorkspaceTrash = nodeTrash.emptyWorkspaceTrash;
export const purgeWorkspaceNodes = nodeTrash.purgeWorkspaceNodes;
export const trimNode = nodeTrash.trimNode;
export const restoreTrimmedNode = nodeTrash.restoreTrimmedNode;

export type { EdgeRow } from './repository/edges';
export const listEdges = edges.listEdges;
export const saveEdge = edges.saveEdge;
export const setEdgeForkProvenance = edges.setEdgeForkProvenance;
export const deleteEdge = edges.deleteEdge;

export type { MessageRow, TurnHistoryCoverage } from './repository/messages';
export const listMessages = messages.listMessages;
export const saveMessage = messages.saveMessage;
export const getMessageCount = messages.getMessageCount;
export const getMessageCountsByNode = messages.getMessageCountsByNode;
export const getCompletedTurnCount = messages.getCompletedTurnCount;

export type { TurnRow } from './repository/turns';
export const beginTurn = turns.beginTurn;
export const checkpointTurn = turns.checkpointTurn;
export const finalizeTurn = turns.finalizeTurn;
export const getSavedTurn = turns.getSavedTurn;
export const getLatestTurn = turns.getLatestTurn;
export const recoverInterruptedTurns = turns.recoverInterruptedTurns;

export type { ContextRow } from './repository/contexts';
export const listContexts = contexts.listContexts;
export const saveContext = contexts.saveContext;
export const upsertAgentContextMetadata = contexts.upsertAgentContextMetadata;
export const deleteContext = contexts.deleteContext;

export type {
  FullWorkspaceData,
  LatestTurnRow,
  MessagePageCursor,
  MetaWorkspaceData,
  NodeRowWithCount,
  TreeMessagePageEntry,
  TreePageNodeFields,
} from './repository/loaders';
export const loadFullWorkspace = loaders.loadFullWorkspace;
export const loadAllWorkspaces = loaders.loadAllWorkspaces;
export const loadWorkspaceMeta = loaders.loadWorkspaceMeta;
export const loadAllWorkspacesMeta = loaders.loadAllWorkspacesMeta;
export const loadTreeMessageSnapshot = loaders.loadTreeMessageSnapshot;
export const loadTreeMessagePage = loaders.loadTreeMessagePage;

export const setNodeExternalSessionId = runtimeBindings.setNodeExternalSessionId;
/** @testonly */
export const getNodeExternalSessionId = runtimeBindings.getNodeExternalSessionId;

export type { UserAgentConfigRow } from './repository/userAgentConfigs';
export const getUserAgentConfig = userAgentConfigs.getUserAgentConfig;
export const upsertUserAgentConfig = userAgentConfigs.upsertUserAgentConfig;

export type { NodeSessionBinding } from './repository/ownership';
export const getNodeWorkspaceId = ownership.getNodeWorkspaceId;
export const getNodeSessionBinding = ownership.getNodeSessionBinding;

export function updateNodeResumeBinding(
  nodeId: string,
  fields: {
    acp_session_id: string;
    runtime_id: string;
    runtime_engine?: string | null;
    provider_id?: string | null;
    model_id?: string | null;
    reasoning?: string | null;
    resume_fingerprint?: string | null;
    current_mode_id?: string | null;
  },
): void {
  // current_mode_id uses COALESCE(?, current_mode_id): a freshly (re)bound
  // kiro session doesn't report its agent (session.currentModeId is null on
  // resume), so a plain assignment would wipe the user's persisted agent on
  // every ensure-session. Passing null here means "unknown — keep the stored
  // mode"; only a non-null mode (e.g. after an explicit switch) overwrites it.
  // The other columns are authoritative from the resume signature and assign
  // unconditionally.
  const result = getDb().prepare(`
    UPDATE nodes
       SET acp_session_id = ?,
           external_session_id = ?,
           runtime_id = ?,
           runtime_engine = ?,
           provider_id = ?,
           model_id = ?,
           reasoning = ?,
           resume_fingerprint = ?,
           current_mode_id = COALESCE(?, current_mode_id)
     WHERE id = ?
  `).run(
    fields.acp_session_id,
    (fields.runtime_id === 'codex' || fields.runtime_id === 'claude') && fields.acp_session_id !== nodeId
      ? fields.acp_session_id : null,
    fields.runtime_id,
    fields.runtime_id === 'kiro' ? fields.runtime_engine ?? 'v2' : null,
    fields.provider_id ?? null,
    fields.model_id ?? null,
    fields.reasoning ?? null,
    fields.resume_fingerprint ?? null,
    fields.current_mode_id ?? null,
    nodeId,
  );
  if (!result.changes) throw new Error(`Cannot persist resume binding: node ${nodeId} does not exist`);
}

export { deleteContextAtomically, isContextTombstoned, contextTombstoneWorkspace } from "./repository/contexts";
