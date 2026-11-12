import type { PrincipalResolver, WorkflowRunContext } from '../contract/host';
import type { RuntimeSessionOwner } from '../contract/types';

/**
 * Who sees a session's workflow runs and background subagents. Null for a
 * session without a user when the host enforces user ownership (Michi:
 * cloud mode): there is nobody to show them to.
 */
export function sessionOwnerContext(
  principal: PrincipalResolver,
  ownerUserId: string | null | undefined,
  workspaceId: string | null,
  owner: RuntimeSessionOwner,
): WorkflowRunContext | null {
  if (!ownerUserId && principal.enforceUserOwnership()) return null;
  return { ownerUserId: principal.resolve(ownerUserId), workspaceId, owner };
}
