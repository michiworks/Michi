import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { MetaAgentGuardStatus, MetaAgentSettingsPatch } from 'michi-shared';
import {
  decideMetaAgentToolApproval, fetchMetaAgent, isMetaAgentUnavailable, retryMetaAgentGuard as retryGuard, updateMetaAgentSettings, type MetaAgentInfo,
} from '../../services/api/metaAgent';
import { companionNameNow } from '../companion/companionName';
import { showPendingReviewNotice, withdrawPendingReviewNotice } from '../../services/attention/pendingReviewNotice';

/** `unavailable`: this backend has no Meta agent routes yet. */
export type MetaAgentStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface MetaAgentSnapshot {
  status: MetaAgentStatus;
  info: MetaAgentInfo | null;
  error: string | null;
}

const INITIAL: MetaAgentSnapshot = { status: 'loading', info: null, error: null };
const GUARD_POLL_MS = 60_000;

const APPROVALS_NOTICE_ID = 'meta-agent:approvals';
const notifiedApprovals = new Set<string>();
// The first read of the status only records what already waits: the Settings badge shows it, and a reload must not announce it again.
let approvalsRead = false;
let approvalsNoticeShown = false;
let reviewApprovals: (() => void) | null = null;
let snapshot = INITIAL;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let readGeneration = 0;
let pollers = 0;
let pollTimer: number | null = null;

/** One notice for the tool requests waiting for approval, when a new one arrives; withdrawn once none waits. */
function noticeApprovals(info: MetaAgentInfo | null): void {
  if (!info) return;
  const pending = (info.toolApprovals ?? []).filter((request) => request.state === 'pending');
  const fresh = pending.filter((request) => !notifiedApprovals.has(request.id));
  for (const request of fresh) notifiedApprovals.add(request.id);
  const firstRead = !approvalsRead;
  approvalsRead = true;
  if (pending.length === 0) {
    if (approvalsNoticeShown) withdrawPendingReviewNotice(APPROVALS_NOTICE_ID);
    approvalsNoticeShown = false;
    return;
  }
  if (firstRead || fresh.length === 0) return;
  const shown = showPendingReviewNotice({
    id: APPROVALS_NOTICE_ID,
    title: pending.length === 1
      ? `Pages upkeep needs approval for ${pending[0].server} / ${pending[0].tool}`
      : `Pages upkeep needs approval for ${pending.length} tools`,
    description: `Review them in Settings › ${companionNameNow()} › Pages upkeep › Tool approvals. Other permitted tools can still be used.`,
    onReview: reviewApprovals ? () => reviewApprovals?.() : null,
    onClose: () => { approvalsNoticeShown = false; },
  });
  approvalsNoticeShown ||= shown;
}

function publish(next: MetaAgentSnapshot): void {
  noticeApprovals(next.info);
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readMetaAgent(): MetaAgentSnapshot {
  return snapshot;
}

/** One read at a time; every caller of a read in flight shares it. */
export function refreshMetaAgent(): Promise<void> {
  if (inflight) return inflight;
  const generation = ++readGeneration;
  inflight = fetchMetaAgent().then(
    (info) => { if (generation === readGeneration) publish({ status: 'ready', info, error: null }); },
    (err: unknown) => {
      if (generation !== readGeneration) return;
      if (isMetaAgentUnavailable(err)) { publish({ status: 'unavailable', info: null, error: null }); return; }
      const message = err instanceof Error ? err.message : 'Couldn’t load Pages upkeep';
      publish({ status: snapshot.info ? 'ready' : 'error', info: snapshot.info, error: message });
    },
  ).finally(() => { inflight = null; });
  return inflight;
}

export async function saveMetaAgentSettings(patch: MetaAgentSettingsPatch): Promise<MetaAgentInfo> {
  const info = await updateMetaAgentSettings(patch);
  // A read that started before this save must not overwrite its answer.
  readGeneration += 1;
  publish({ status: 'ready', info, error: null });
  return info;
}

/**
 * Retry after a failed restriction check: clears the failed toolset's check
 * (both when both failed) and shows the answer. With no failure on record it
 * only re-reads the status.
 */
export async function retryMetaAgentGuard(): Promise<void> {
  const failed = metaAgentGuardFailures(snapshot.info).map((status) => status.toolset);
  if (failed.length === 0) { await refreshMetaAgent(); return; }
  const info = await retryGuard(failed.length === 1 ? failed[0] : undefined);
  // A read that started before this retry must not overwrite its answer.
  readGeneration += 1;
  publish({ status: 'ready', info, error: null });
}

export function metaAgentGuardFailures(info: MetaAgentInfo | null): MetaAgentGuardStatus[] {
  if (!info) return [];
  return [info.guard.maintenance, info.guard.chat].filter((status): status is MetaAgentGuardStatus => status?.state === 'failed');
}

/** The Meta agent settings and status as last read, without reading them again. */
export function useMetaAgentSnapshot(): MetaAgentSnapshot {
  return useSyncExternalStore(subscribe, readMetaAgent, readMetaAgent);
}

/** The Meta agent settings and status, read fresh when the caller mounts. */
export function useMetaAgent(): MetaAgentSnapshot {
  const current = useMetaAgentSnapshot();
  useEffect(() => { void refreshMetaAgent(); }, []);
  return current;
}

const refreshOnFocus = () => { void refreshMetaAgent(); };

function startGuardPolling(): () => void {
  pollers += 1;
  if (pollers === 1) {
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && snapshot.status !== 'unavailable') void refreshMetaAgent();
    }, GUARD_POLL_MS);
    window.addEventListener('focus', refreshOnFocus);
  }
  return () => {
    pollers -= 1;
    if (pollers > 0) return;
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
    window.removeEventListener('focus', refreshOnFocus);
  };
}

/** True while the last restriction check of either Meta agent run failed (the Settings red dot). */
export function useMetaAgentGuardFailed(): boolean {
  const current = useMetaAgentSnapshot();
  useEffect(() => {
    void refreshMetaAgent();
    return startGuardPolling();
  }, []);
  return metaAgentGuardFailures(current.info).length > 0;
}

/**
 * Lets the tool approval notice's Review open Settings › Meta agent: the
 * opener lives with the shell's components, which state code cannot import.
 */
export function useMetaAgentApprovalReview(onReview: () => void): void {
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  useEffect(() => {
    const handler = () => reviewRef.current();
    reviewApprovals = handler;
    return () => { if (reviewApprovals === handler) reviewApprovals = null; };
  }, []);
}

/** @testonly */
export function resetMetaAgentStore(): void {
  notifiedApprovals.clear();
  approvalsRead = false;
  approvalsNoticeShown = false;
  snapshot = INITIAL;
  inflight = null;
  readGeneration = 0;
  for (const listener of listeners) listener();
}

export async function saveMetaAgentToolApproval(id: string, state: 'approved' | 'denied' | 'revoked'): Promise<void> {
  const info = await decideMetaAgentToolApproval(id, state);
  readGeneration += 1;
  publish({ status: 'ready', info, error: null });
}
