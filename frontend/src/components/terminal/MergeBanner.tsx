import { useEffect, useState } from 'react';
import { useChatActions, useChatStore, useChatNodesSnapshot } from '../../state/chatStore';
import {
  estimateMergePreambleTokens,
  MERGE_PREAMBLE_TOKEN_WARN,
  mergeContextNodeIds,
} from '../../state/mergePreamble';

export default function MergeBanner({ nodeId }: { nodeId: string }) {
  const { activeProject } = useChatStore();
  const { ensureCompleteHistory } = useChatActions();
  const nodes = useChatNodesSnapshot();
  const [dismissed, setDismissed] = useState(false);
  const [failedLoad, setFailedLoad] = useState('');

  const node = nodes[nodeId];
  // Before the first send only.
  const sources = node && node.messages.length === 0 && !dismissed ? node.mergeSources ?? [] : [];
  const edges = activeProject?.edges;
  const isAlive = (id: string) => !nodes[id]?.deletedAt;
  // The send loads every merged history before it renders the preamble;
  // a placeholder or a recent page alone would undercount it.
  const unloaded = sources.length > 0 && edges
    ? mergeContextNodeIds(sources, nodes, edges, isAlive).filter((id) => nodes[id]?.messagesLoaded === false).join('\n')
    : '';
  useEffect(() => {
    if (!unloaded) return;
    ensureCompleteHistory(unloaded.split('\n')).catch(() => setFailedLoad(unloaded));
  }, [unloaded, ensureCompleteHistory]);

  if (sources.length === 0 || !edges) return null;
  if (unloaded && unloaded !== failedLoad) return null;
  const tokens = estimateMergePreambleTokens(sources, nodes, edges, isAlive);
  if (tokens <= MERGE_PREAMBLE_TOKEN_WARN) return null;

  const sourceTitles = sources
    .map((s) => nodes[s]?.title ?? 'Untitled')
    .join(' + ');

  return (
    <div
      role="alert"
      style={{
        padding: '8px 12px',
        background: 'var(--term-alt)',
        borderBottom: '1px solid var(--term-line)',
        color: 'var(--term-fg)',
        fontSize: 'var(--fs-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span>⚠</span>
      <span style={{ flex: 1 }}>
        Merging from {sourceTitles}. Will inject ~{tokens.toLocaleString()} tokens. May exceed model context.
      </span>
      <button
        role="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          cursor: 'pointer',
          color: 'var(--term-muted)',
          background: 'none',
          border: 'none',
          padding: '0 2px',
          font: 'inherit',
          fontSize: 'var(--fs-sm)',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
