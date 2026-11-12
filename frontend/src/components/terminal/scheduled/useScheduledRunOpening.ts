import React from 'react';
import { toast } from 'sonner';
import type { DesktopBootstrapParam, ScheduledJobRunEvent } from 'michi-shared';
import { getElectron, type ScheduledRunTarget } from '../../../lib/electronBridge';
import { notify } from '../../../services/notifications';
import { useChatActions } from '../../../state/chatStore';
import type { PageId } from '../../../state/commands';
import { usePrefs } from '../../../state/prefs';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT, describeScheduledRunNotice } from '../../../state/scheduledRunNotice';
import { getScheduledJobRun } from '../../../services/api/scheduledJobs';
import { requestScheduledJobDetail, requestScheduledRun } from './scheduledNav';
import { closeMetaAgentDetail } from './metaAgent/metaAgentNav';

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
 * Opens the thread behind a scheduled-run notification: from a click on an
 * OS notification (Electron IPC or the URL of a window it opened) and from
 * in-app toasts for notices delivered while Michi is focused. A
 * Scheduled-only run's thread opens on the Scheduled page. In a browser,
 * where no Electron main delivers notices, it also raises them.
 */
export function useScheduledRunOpening({ hydrated, onNav }: { hydrated: boolean; onNav: (page: PageId) => void }): void {
  const { revealBackendNode } = useChatActions();
  const notificationLevel = usePrefs().prefs.notifications;
  const notificationLevelRef = React.useRef(notificationLevel);
  notificationLevelRef.current = notificationLevel;
  const pending = React.useRef<ScheduledRunTarget | null>(getElectron()?.initialScheduledRun ?? null);
  const hydratedRef = React.useRef(hydrated);
  hydratedRef.current = hydrated;

  const open = React.useCallback(async (target: ScheduledRunTarget) => {
    if (target.nodeId) {
      // The run says where its thread shows now (it may have been moved to the workspace).
      const run = await getScheduledJobRun(target.runId).catch(() => null);
      if (run?.scheduledOnly) {
        closeMetaAgentDetail();
        requestScheduledRun(target.jobId, target.runId);
        onNav('scheduled');
        return;
      }
    }
    if (target.nodeId && await revealBackendNode(target.workspaceId, target.nodeId)) return;
    // No thread (failed before it started, or since deleted): show the job.
    if (target.nodeId) toast.error('That thread is no longer available');
    closeMetaAgentDetail();
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
    const detachNotice = electron?.onScheduledNotice?.((notice) => {
      notify({
        title: `${notice.title} · ${notice.subtitle}`,
        body: notice.body,
        key: `scheduled:${notice.target.runId}`,
        onClick: () => request(notice.target),
      });
    });
    // Without Electron main (a browser), this window is the notifier.
    const onRun = (event: Event) => {
      const run = (event as CustomEvent<ScheduledJobRunEvent>).detail;
      if (!run || notificationLevelRef.current === 'off') return;
      const notice = describeScheduledRunNotice(run);
      if (!notice) return;
      notify({
        title: `${notice.title} · ${notice.subtitle}`,
        body: notice.body,
        key: `scheduled:${run.runId}`,
        onClick: () => request({ runId: run.runId, jobId: run.jobId, workspaceId: run.workspaceId, nodeId: run.nodeId }),
      });
    };
    if (!electron?.onScheduledNotice) window.addEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    return () => {
      detachOpen?.();
      detachNotice?.();
      window.removeEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    };
  }, [open]);
}
