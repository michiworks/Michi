import React from 'react';
import { toast } from 'sonner';
import type { DesktopBootstrapParam } from 'michi-shared';
import { getElectron, type ScheduledRunTarget } from '../../../lib/electronBridge';
import { onOpenScheduledRunRequest } from '../../../state/attentionOpenRequests';
import { useChatActions } from '../../../state/chatStore';
import type { PageId } from '../../../state/commands';
import { getScheduledJobRun } from '../../../services/api/scheduledJobs';
import { requestScheduledJobDetail, requestScheduledRun } from './scheduledNav';

const OPEN_RUN_PARAMS: readonly DesktopBootstrapParam[] = ['michiOpenRun', 'michiOpenJob', 'michiOpenWorkspace', 'michiOpenNode'];

/** Drop the one-shot "open this run" params so a reload does not reopen it. */
function clearOpenRunParams(): void {
  try {
    const url = new URL(window.location.href);
    if (!OPEN_RUN_PARAMS.some((key) => url.searchParams.has(key))) return;
    for (const key of OPEN_RUN_PARAMS) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Non-fatal: the worst case is reopening the same thread on reload.
  }
}

/**
 * Opens the run behind a scheduled run's notification (an attention record,
 * services/attention on the backend): from a click on Electron main's banner
 * (IPC, or the URL of the window it opened) and from the toasts and OS
 * notifications this window raised (attentionOpenRequests.ts). A
 * Scheduled-only run's thread opens on the Scheduled page.
 */
export function useScheduledRunOpening({ hydrated, onNav }: { hydrated: boolean; onNav: (page: PageId) => void }): void {
  const { revealBackendNode } = useChatActions();
  const pending = React.useRef<ScheduledRunTarget | null>(getElectron()?.initialScheduledRun ?? null);
  const hydratedRef = React.useRef(hydrated);
  hydratedRef.current = hydrated;

  const open = React.useCallback(async (target: ScheduledRunTarget) => {
    if (target.nodeId) {
      // The run says where its thread shows now (it may have been moved to the workspace).
      const run = await getScheduledJobRun(target.runId).catch(() => null);
      if (run?.scheduledOnly) {
        requestScheduledRun(target.jobId, target.runId);
        onNav('scheduled');
        return;
      }
    }
    if (target.nodeId && await revealBackendNode(target.workspaceId, target.nodeId)) return;
    // No thread (failed before it started, or since deleted): show the job.
    if (target.nodeId) toast.error('That thread is no longer available');
    requestScheduledJobDetail(target.jobId);
    onNav('scheduled');
  }, [onNav, revealBackendNode]);

  React.useEffect(() => {
    if (!hydrated || !pending.current) return;
    const target = pending.current;
    pending.current = null;
    clearOpenRunParams();
    void open(target);
  }, [hydrated, open]);

  React.useEffect(() => {
    const electron = getElectron();
    const request = (target: ScheduledRunTarget) => {
      if (hydratedRef.current) void open(target);
      else pending.current = target;
    };
    const detachOpen = electron?.onScheduledRunOpen?.(request);
    const detachRequest = onOpenScheduledRunRequest(request);
    return () => {
      detachOpen?.();
      detachRequest();
    };
  }, [open]);
}
