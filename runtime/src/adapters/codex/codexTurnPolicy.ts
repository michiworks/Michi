import type { ChatPermissionMode } from 'michi-shared';
import type { HostTurnGuard } from '../../contract/host';

const workspaceWrite = (cwd: string) => ({
    type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
});

/**
 * turn/start approval and sandbox policy of an ordinary chat in each
 * permission mode. A guarded turn (HostTurnGuard: the host drove it, or it
 * holds outside content) never runs unsandboxed: in Trust or YOLO, or
 * whatever the mode in a host-driven work conversation, it runs in the
 * workspace with network off and `on-request`, so a command that needs
 * more (the network, a push) asks for escalation, which reaches the host's
 * policy instead of failing or running unasked. A guarded turn in Ask keeps
 * Ask's policy.
 */
export function codexChatTurnPolicy(mode: ChatPermissionMode, cwd: string, guard: HostTurnGuard = 'none') {
    if (guard === 'work' || (guard === 'egress' && mode !== 'ask')) return { approvalPolicy: 'on-request', sandboxPolicy: workspaceWrite(cwd) };
    if (mode === 'yolo') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    if (mode === 'trust') return { approvalPolicy: 'never', sandboxPolicy: workspaceWrite(cwd) };
    // Unlike on-request, untrusted asks before non-read-only commands without
    // relying on the model to request escalation after a sandbox failure.
    return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}
