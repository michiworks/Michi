import React, { useEffect, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { joinAnd, type MetaAgentGuardStatus, type MetaAgentToolset } from 'michi-shared';
import { Button } from '../../../ui/controls';
import { useCompanionName } from '../../../../state/companion/companionName';
import { formatMichiClock } from '../../content/michiFormat';
import { metaAgentRuntimeLabel } from './runtimeCopy';
import './metaAgentSettings.css';

/** What each restricted toolset runs for (DESIGN-v2 §2.2: check-ins use the `chat` toolset). */
const TOOLSET_LABELS: Record<MetaAgentToolset, string> = {
  maintenance: 'Pages upkeep',
  chat: 'Check-ins',
  memory: 'Automatic memory',
};

/** What stops while each toolset's check fails (the `chat` toolset is the check-ins'). */
const TOOLSET_STOPS: Record<MetaAgentToolset, string> = {
  maintenance: 'pages won’t update',
  chat: 'check-ins won’t run',
  memory: 'automatic memory won’t suggest anything',
};

/** The red box shown while one of the agent's own runs (Pages upkeep, check-ins, memory) is stopped by its restriction check. */
export function MetaAgentGuardAlert({ failures, onRetry, onChangeRuntime }: {
  failures: readonly MetaAgentGuardStatus[];
  onRetry: () => Promise<void> | void;
  onChangeRuntime: () => void;
}) {
  const name = useCompanionName();
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const detailsId = useId();
  if (failures.length === 0) return null;
  const runtimes = joinAnd([...new Set(failures.map((failure) => metaAgentRuntimeLabel(failure.runtimeId)))]);
  const tools = [...new Set(failures.flatMap((failure) => failure.unexpectedTools))];
  const stops = joinAnd([...new Set(failures.map((failure) => TOOLSET_STOPS[failure.toolset] ?? 'it won’t run'))]);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? `Couldn’t retry: ${err.message}` : 'Couldn’t retry the tool check');
    } finally {
      if (mounted.current) setRetrying(false);
    }
  };

  return (
    <div className="meta-set__alert" role="alert">
      <TriangleAlert className="meta-set__alert-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <div className="meta-set__alert-body">
        <b>
          {tools.length > 0
            ? `${name} stopped: ${runtimes} started with extra tools`
            : `${name} stopped: ${runtimes} did not pass its tool check`}
        </b>
        <p>
          {tools.length > 0 && <>Extra tools: {tools.map((tool, index) => (
            <React.Fragment key={tool}>{index > 0 && ', '}<code>{tool}</code></React.Fragment>
          ))}. </>}
          On its own, {name} may only read and edit inside Michi, so {failures.length === 1 ? 'this run' : 'these runs'} did not start and {stops}.
        </p>
      </div>
      <div className="meta-set__alert-actions">
        <Button variant="primary" size="sm" disabled={retrying} onClick={() => { void retry(); }}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
        <Button size="sm" onClick={onChangeRuntime}>Change runtime</Button>
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
          Details
        </Button>
      </div>
      {open && (
        <dl className="meta-set__alert-details" id={detailsId}>
          {failures.map((failure) => (
            <div key={failure.toolset}>
              <dt>{TOOLSET_LABELS[failure.toolset] ?? failure.toolset}</dt>
              <dd>
                {metaAgentRuntimeLabel(failure.runtimeId)} · checked {formatMichiClock(failure.checkedAt)}
                {failure.unexpectedTools.length > 0 && <> · extra: <code>{failure.unexpectedTools.join(', ')}</code></>}
                {failure.detail && <div className="meta-set__alert-detail">{failure.detail}</div>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
