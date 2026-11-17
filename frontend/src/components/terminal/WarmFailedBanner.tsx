import { useEffect, useState } from 'react';
import { useChatProjects } from '../../state/chatStore';
import { BusyLabel } from '../ui/controls';

/**
 * Cold-start banner shown when /api/ready reports `failed` (e.g. kiro-cli
 * ENOENT) and we have no agentStatus yet. Retry dispatches the same reload
 * event chatStore already listens to; chatStore's reload-handler skips the
 * ready poll and re-fetches /agent/status directly.
 *
 * Renders nothing once agentStatus is populated, so a successful retry
 * removes the banner without extra plumbing.
 */
export default function WarmFailedBanner() {
  const { agentStatus, agentStatusUnreachable, warmFailedError } = useChatProjects();
  // From Retry until a status arrives, which removes the banner, or the reload
  // gives up again (every reload first clears the unreachable flag).
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { if (agentStatusUnreachable) setRetrying(false); }, [agentStatusUnreachable]);
  useEffect(() => { setRetrying(false); }, [agentStatus]);
  if (agentStatus || !warmFailedError) return null;
  return (
    <div className="boot-warm-failed" role="alert" aria-busy={retrying || undefined}>
      Runtime failed to start: {warmFailedError}.{' '}
      <button
        type="button"
        aria-disabled={retrying || undefined}
        onClick={() => {
          if (retrying) return;
          setRetrying(true);
          window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
        }}
      >
        <BusyLabel busy={retrying} label="Retrying…">Retry</BusyLabel>
      </button>
    </div>
  );
}
