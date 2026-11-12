/**
 * A Michi tool's own approval card: single-use, asked by the tool itself
 * rather than by the runtime, so it reaches the user on every runtime (Codex
 * approves Michi's MCP tools itself) and in every permission mode. Trust and
 * YOLO, "always allow" grants and session trust never answer it; only the
 * approving choice approves, and no user to ask, or no answer, approves
 * nothing. Every runtime asks through its ask_user channel, Pi included
 * (agents/pi/piAskUser.ts). The scheduled job changes
 * (agents/scheduledJobTools.ts) and delete_artifact (agents/artifactTools.ts)
 * ask through it.
 *
 * The runtime's own prompt for such a tool would be a second card for the
 * same call, so permissionPolicy.ts lets delete_artifact through at the
 * runtime level.
 */

import { askUserSingleUseApproval, type AskUser, type SingleUseApprovalResult } from "./singleUseApproval";

export interface HostApprovalRequest {
  /** The tool asking. */
  toolName: string;
  title: string;
  /** One fact per line; a long text, when shown, comes last. */
  lines: string[];
  /** Label of the approving choice ("Delete", "Run now"…). */
  approveLabel: string;
}

export type HostApprovalResult = SingleUseApprovalResult;

export type HostApprover<Request extends HostApprovalRequest = HostApprovalRequest> = (request: Request) => Promise<HostApprovalResult>;

/** The label of the declining choice on every card. */
const DECLINE_LABEL = "Cancel";

/**
 * Approval through the runtime's Michi-owned ask_user channel, under
 * `header`; askUserSingleUseApproval decides what the answer means.
 */
export function askUserApprover<Request extends HostApprovalRequest>(askUser: AskUser | undefined, header: string): HostApprover<Request> {
  return (request) => askUserSingleUseApproval(askUser, {
    question: `${request.title}\n${request.lines.join("\n")}`,
    header,
    // The labels say what each choice does; the card needs no notes under them.
    approve: { label: request.approveLabel },
    decline: { label: DECLINE_LABEL },
  });
}
