import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { parseMultiModelProposalResult, type MultiModelProposalResult } from 'michi-shared';
import type { ToolCallState } from '../../../state/chatTypes';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import {
  useOptionalWorkflowDomain,
  useRefetchPartialWorkflowRun,
  useWorkflowRun,
  workflowRunKey,
} from '../../../state/workflowDomain';
import { michiToolNamed, normalizeToolResultEnvelope } from '../../../lib/turnPageReceipt';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';
import { openWorkflowRunDrawer } from '../backgroundWork/backgroundWorkEvents';
import { ForkIcon } from '../icons';
import { MultiModelRunCard, type DrawerFocus } from './MultiModelRunCard';

/**
 * Under a reply: the card of each multi-model plan its tool calls proposed.
 * A proposal is known by the call's output, never its input: Crew's
 * michi_call_tool input with five long prompts is past ACP's 16 KB cut and
 * no longer parses, while the result stays short and whole.
 */

const TOOL_NAMES = ['propose_multi_model_plan', 'michi_call_tool'] as const;

/**
 * The workspace feed's first snapshot normally brings the run; a run it left
 * out is fetched after the first delay, and a failed fetch is tried again
 * after each next one (backing off, then a Retry link).
 */
const MISSING_RUN_LOAD_DELAYS_MS = [1_500, 3_000, 6_000, 12_000] as const;

/** The missing run's fetch: waiting for attempt `n`, failed every attempt, or a Retry in flight. */
type MissingRunLoad = { attempt: number } | 'failed' | 'retrying';

/** The proposals among a reply's completed tool calls, in call order. */
function parseProposals(tools: readonly ToolCallState[]): MultiModelProposalResult[] {
  return tools.flatMap((tool) => {
    if (tool.status !== 'completed' || !michiToolNamed(tool, TOOL_NAMES)) return [];
    const values = normalizeToolResultEnvelope(tool.output);
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const proposal = parseMultiModelProposalResult(values[i]);
      if (proposal) return [proposal];
    }
    return [];
  });
}

/** A run that could not be fetched: one line, not an empty space under the reply. */
function MultiModelLoadError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <article className="mm-card is-compact" data-testid="multi-model-card-error" aria-label="Multi-model plan, couldn't load">
      <span className="eb"><span className="ic"><ForkIcon /></span>Multi-model plan</span>
      <span className="msg">Couldn&apos;t load it</span>
      <button type="button" className="linkbtn" disabled={retrying} onClick={onRetry}>{retrying ? 'Loading…' : 'Retry'}</button>
    </article>
  );
}

/** One card, subscribed to its own run. */
const ConnectedMultiModelRunCard = React.memo(function ConnectedMultiModelRunCard({ identity, readOnly }: {
  identity: AgentResourceIdentity;
  readOnly?: boolean;
}) {
  const domain = useOptionalWorkflowDomain();
  const runKey = workflowRunKey(identity);
  const { resource, pending, error } = useWorkflowRun(runKey);
  useRefetchPartialWorkflowRun(identity, resource);
  const present = !!resource;
  const [load, setLoad] = useState<MissingRunLoad>({ attempt: 0 });
  const attempt = typeof load === 'object' ? load.attempt : null;
  useEffect(() => {
    if (present || !domain || attempt === null) return;
    let active = true;
    const timer = setTimeout(() => {
      domain.load(identity).catch(() => {
        if (!active) return;
        setLoad(attempt + 1 < MISSING_RUN_LOAD_DELAYS_MS.length ? { attempt: attempt + 1 } : 'failed');
      });
    }, MISSING_RUN_LOAD_DELAYS_MS[attempt]);
    return () => { active = false; clearTimeout(timer); };
  }, [present, domain, identity, attempt]);
  const retryLoad = useCallback(() => {
    if (!domain) return;
    setLoad('retrying');
    domain.load(identity).then(() => setLoad({ attempt: 0 }), () => setLoad('failed'));
  }, [domain, identity]);
  // The run's owner is its caller chat; read it from the run, as workflow cards do.
  const ownerNodeId = resource?.value.nodeId;
  const onOpenDrawer = useMemo(() => (ownerNodeId
    ? (focus?: DrawerFocus) => openWorkflowRunDrawer(ownerNodeId, runKey, focus)
    : undefined), [ownerNodeId, runKey]);
  if (!resource) {
    return load === 'failed' || load === 'retrying' ? <MultiModelLoadError retrying={load === 'retrying'} onRetry={retryLoad} /> : null;
  }
  return (
    <MultiModelRunCard run={resource.value} identity={identity} pending={pending} error={error} readOnly={readOnly} onOpenDrawer={onOpenDrawer} />
  );
});

export function MultiModelReceipt({ tools, backendConnectionId, readOnly }: {
  tools: readonly ToolCallState[];
  backendConnectionId?: string;
  readOnly?: boolean;
}) {
  // Every tool event replaces `tools`; the identities change only with the run
  // ids, so each card's memo holds and its missing-run timer keeps running.
  const runIds = useMemo(() => [...new Set(parseProposals(tools).map((proposal) => proposal.runId))].join('\u0000'), [tools]);
  const runs = useMemo(() => {
    const conn = backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID;
    return runIds ? runIds.split('\u0000').map((id): AgentResourceIdentity => ({ backendConnectionId: conn, id })) : [];
  }, [runIds, backendConnectionId]);
  if (runs.length === 0) return null;
  return <>{runs.map((identity) => <ConnectedMultiModelRunCard key={identity.id} identity={identity} readOnly={readOnly} />)}</>;
}
