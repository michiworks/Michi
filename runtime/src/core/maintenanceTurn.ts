import type { AgentTurnInput, MaintenanceExecutionContext, RuntimeSessionOwner } from '../contract/types';

export interface MaintenanceBinding {
  /** The session runs the host's maintenance profile (SessionProfilePort.isMaintenance). */
  maintenance: boolean;
  owner: RuntimeSessionOwner | undefined;
  workspaceId: string | null;
  /** The principal the job must belong to: host.principal.resolve of the session's owner user. */
  expectedOwnerUserId: string;
  /** Names the runtime in the errors. */
  runtimeLabel: string;
}

/**
 * The maintenance context a send runs under, stamped with the turn that
 * executes it, or null for a session that is not a maintenance one. The
 * host's maintenance writers take the result as their write authority, so
 * a send that does not match its session's binding throws before it starts.
 */
export function bindMaintenanceTurn(input: AgentTurnInput | undefined, binding: MaintenanceBinding): MaintenanceExecutionContext | null {
  if (!binding.maintenance) {
    if (input?.maintenanceContext) throw new Error(`Maintenance context supplied to a non-maintenance ${binding.runtimeLabel} session`);
    return null;
  }
  const context = input?.maintenanceContext;
  const owner = binding.owner;
  if (!context || owner?.mode !== 'interactive' || !input?.turnId || !input.assistantMessageId
    || context.workspaceId !== binding.workspaceId
    || context.ownerUserId !== binding.expectedOwnerUserId
    || !context.jobId || !context.runId || !context.claimedBy || !context.planId
    || !Number.isSafeInteger(context.configRevision) || context.configRevision < 1
    || !Array.isArray(context.sources)) {
    throw new Error(`Maintenance ${binding.runtimeLabel} send is missing a valid owner, workspace, or canonical turn binding`);
  }
  return { ...context, execution: { nodeId: owner.key, turnId: input.turnId, assistantId: input.assistantMessageId, runId: context.runId } };
}

/** The turn page edits of a send are attributed to: interactive turns only. */
export function pageAttributionFor(
  input: AgentTurnInput | undefined,
  owner: RuntimeSessionOwner | undefined,
): { turnId: string; assistantId: string } | null {
  return owner?.mode === 'interactive' && input?.turnId && input.assistantMessageId
    ? { turnId: input.turnId, assistantId: input.assistantMessageId } : null;
}
