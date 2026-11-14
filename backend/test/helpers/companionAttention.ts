import type { CompanionTarget } from 'michi-shared';
import type { AgentAttentionProposal } from '../../src/services/attention/attentionService';
import { setCompanionAttention } from '../../src/services/companion/notices';

/** One of Michi's facts as the attention service would have been handed it, with where it opens and the item it is about. */
export interface CapturedCompanionNotice extends AgentAttentionProposal {
  target: CompanionTarget;
  itemIds: string[];
}

export interface CompanionAttentionCapture {
  /** Every proposal, oldest first. */
  notices: CapturedCompanionNotice[];
  /** The keys proposed and not resolved since, with their facts. */
  active: Map<string, string>;
  /** The keys resolved, in order. */
  resolved: string[];
  restore(): void;
}

/** Stands in for the attention service behind Michi's notices (notices.ts setCompanionAttention) until restore(). */
export function captureCompanionAttention(): CompanionAttentionCapture {
  const capture: CompanionAttentionCapture = {
    notices: [],
    active: new Map(),
    resolved: [],
    restore: () => setCompanionAttention(null),
  };
  setCompanionAttention({
    propose: (proposal) => {
      const itemIds = proposal.key.startsWith('agent:item:') ? [proposal.key.slice('agent:item:'.length)] : [];
      capture.notices.push({ ...proposal, target: proposal.open, itemIds });
      capture.active.set(proposal.key, proposal.fact);
    },
    active: (prefix) => [...capture.active].filter(([key]) => key.startsWith(prefix)).map(([key, fact]) => ({ key, fact })),
    resolve: (key) => {
      if (capture.active.delete(key)) capture.resolved.push(key);
    },
  });
  return capture;
}
