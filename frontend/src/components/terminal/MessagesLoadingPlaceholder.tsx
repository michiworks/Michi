import React from 'react';
import { BACKEND_CONNECTION_READY, BACKEND_CONNECTION_UNAVAILABLE, backendConnectionUnavailable } from '../../config/backendConnectionState';
import { getKnownBackendConnections } from '../../config/backendConnections';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { noteSkeletonHidden, noteSkeletonShown } from '../../state/messageLoadDiagnostics';
import { NodeMessagesContext, SKELETON_SELF_HEAL_MS, SKELETON_STILL_LOADING_MS } from '../../state/nodeMessagesSelfHeal';
import { useRemoteRecoveryIssues } from '../../state/remoteRecovery';
import { Button } from '../ui/controls';

function subscribeConnectionState(listener: () => void) {
  window.addEventListener(BACKEND_CONNECTION_UNAVAILABLE, listener);
  window.addEventListener(BACKEND_CONNECTION_READY, listener);
  return () => {
    window.removeEventListener(BACKEND_CONNECTION_UNAVAILABLE, listener);
    window.removeEventListener(BACKEND_CONNECTION_READY, listener);
  };
}

/** The connection's name while it is unreachable or its service is being brought back, else null. */
function useRecoveringConnectionName(connectionId: string): string | null {
  const unavailable = React.useSyncExternalStore(subscribeConnectionState,
    () => backendConnectionUnavailable(connectionId), () => false);
  const issue = useRemoteRecoveryIssues().find((item) => item.connectionId === connectionId);
  if (!unavailable && !issue) return null;
  return issue?.name ?? getKnownBackendConnections().find((item) => item.id === connectionId)?.name ?? 'the remote machine';
}

const BAR_STYLE: React.CSSProperties = { height: 12, borderRadius: 'var(--ui-radius-sm)', background: 'var(--term-line)' };

/**
 * The skeleton a conversation shows while its history loads. It asks for its
 * own node after SKELETON_SELF_HEAL_MS (the tree loader may not cover it),
 * says when the connection is being recovered, and after
 * SKELETON_STILL_LOADING_MS says it is still loading, with a Retry.
 */
export function MessagesLoadingPlaceholder({ nodeId, connectionId, reduceMotion }: {
  nodeId: string;
  connectionId: string;
  reduceMotion?: boolean;
}) {
  const ensureNodeMessages = React.useContext(NodeMessagesContext);
  const reconnectingTo = useRecoveringConnectionName(connectionId);
  const still = useReducedMotion(reduceMotion);
  const [stillLoading, setStillLoading] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const signalRef = React.useRef<AbortSignal | null>(null);

  React.useEffect(() => {
    noteSkeletonShown(nodeId, connectionId);
    return () => noteSkeletonHidden(nodeId);
  }, [nodeId, connectionId]);

  React.useEffect(() => {
    const controller = new AbortController();
    signalRef.current = controller.signal;
    const heal = setTimeout(() => { void ensureNodeMessages?.(nodeId, { signal: controller.signal }); }, SKELETON_SELF_HEAL_MS);
    const slow = setTimeout(() => setStillLoading(true), SKELETON_STILL_LOADING_MS);
    return () => {
      controller.abort();
      clearTimeout(heal);
      clearTimeout(slow);
    };
  }, [nodeId, ensureNodeMessages]);

  const retry = () => {
    const signal = signalRef.current;
    if (!ensureNodeMessages || !signal || retrying) return;
    setRetrying(true);
    void ensureNodeMessages(nodeId, { signal, immediate: true })
      .finally(() => { if (!signal.aborted) setRetrying(false); });
  };

  const status = reconnectingTo ? `Reconnecting to ${reconnectingTo}…` : stillLoading ? 'Still loading…' : '';
  const pulse = still ? undefined : 't-skeleton-pulse';
  return (
    <div aria-busy="true" data-testid="messages-loading" style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span className="sr-only">Loading conversation…</span>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={pulse} style={{ ...BAR_STYLE, width: i === 0 ? '60%' : '80%', opacity: 0.5 }} />
          <div className={pulse} style={{ ...BAR_STYLE, width: i === 0 ? '90%' : '45%', opacity: 0.4 }} />
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, color: 'var(--term-mid)', fontSize: 'var(--fs-sm)' }}>
        <span role="status" aria-live="polite">{status}</span>
        {stillLoading && !reconnectingTo && ensureNodeMessages && (
          <Button variant="ghost" size="sm" aria-disabled={retrying || undefined} onClick={retry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        )}
      </div>
    </div>
  );
}
