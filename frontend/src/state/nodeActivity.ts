import { useStructuralSelector } from './chatStore';
import type { ChatNodeState } from './chatTypes';

/** Two id sets with the same members. */
function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// Module-level: a selector made per render clears useStructuralSelector's
// cache, so every render would return a new set.
function selectStreamingNodeIds(nodes: Record<string, ChatNodeState>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.status === 'streaming') out.add(id);
  }
  return out;
}

/** The nodes whose status is 'streaming', as one set until that changes. */
export function useStreamingNodeIds(): ReadonlySet<string> {
  return useStructuralSelector(selectStreamingNodeIds, sameIdSet);
}
