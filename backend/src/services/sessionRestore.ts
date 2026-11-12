/**
 * Rules shared by the paths that rebuild a node's runtime session: the
 * ensure-session and load routes (routes/michi.ts) and the backend's own
 * restore (ChatManager.ensureParentSession).
 */
import * as sessionRegistry from '../agents/sessionRegistry';
import { sessionReplayHistory } from '../agents/sessionReplayView';
import { BranchBoundaryError, renderBranchBoundary, resolveBranchBoundary, type BranchBoundary } from './branchBoundary';
import { getNode, getNodeSessionBinding, listMessages, type NodeRow } from './dbRepository';
import { log } from './logger';
import { buildCompatibleResumeContext } from './resumeStrategy';
import { getCompanionSettings } from './companion/settings';

/**
 * What a session rebuilt from its own transcript inherits from above it.
 * A fresh multi-model branch inherits nothing, and a session seeded with a
 * branch context only its parent. A multi-model fork branch gets its cut
 * of the caller instead of a parent session. Any other branch gets its
 * parent, plus the parent's stored transcript when no live parent session
 * can supply that history.
 */
export function rebuildInheritance(input: {
    nodeId: string;
    row: NodeRow | null | undefined;
    parentChatId: string | undefined;
    hasBranchContext: boolean;
    userId: string | undefined;
}): { parentChatId: string | undefined; context: string | null } {
    const { nodeId, row, parentChatId, userId } = input;
    if (row?.fresh_context === 1) return { parentChatId: undefined, context: null };
    if (input.hasBranchContext) return { parentChatId, context: null };
    if (row?.multi_model_run_id) {
        return { parentChatId: undefined, context: multiModelForkContext(nodeId, row.parent_node_id ?? undefined, userId) };
    }
    const parentNodeId = !parentChatId ? row?.parent_node_id ?? null
        : sessionRegistry.getSession(parentChatId) ? null
            : getNodeSessionBinding(parentChatId, userId)?.nodeId ?? parentChatId;
    const parent = parentNodeId ? getNode(parentNodeId) : null;
    if (!parent) return { parentChatId, context: null };
    // Posted check-ins replay as one-line facts, never their text (DESIGN-v2 §2.8 T2): a branch of V too.
    const messages = sessionReplayHistory(listMessages(parent.id, userId), { name: () => getCompanionSettings().displayName });
    return { parentChatId, context: buildCompatibleResumeContext(messages, { nodeId: parent.id, title: parent.title ?? null }) };
}

/**
 * A multi-model fork branch's cut of its caller, rendered as a merge
 * context for a rebuild from its own transcript. Null when the cut is gone
 * (logged; the rebuild goes on without it rather than inheriting the
 * caller's current tail).
 */
function multiModelForkContext(nodeId: string, parentNodeId: string | undefined, userId: string | undefined): string | null {
    const boundary = multiModelForkBoundary(nodeId, parentNodeId, userId);
    return boundary ? renderBranchBoundary(boundary, getNode(boundary.parentNodeId)?.title ?? null) : null;
}

export function multiModelForkBoundary(nodeId: string, parentNodeId: string | undefined, userId: string | undefined): BranchBoundary | null {
    try {
        return resolveBranchBoundary({ childNodeId: nodeId, parentNodeId, userId }) ?? null;
    } catch (error) {
        if (!(error instanceof BranchBoundaryError)) throw error;
        log.warn('chat', 'multi-model branch cut unavailable; rebuilt without it', { nodeId, code: error.code });
        return null;
    }
}
