import { useState } from 'react';
import type { ChangeSource } from 'michi-shared';
import { changeOrigin, readLabel } from '../../../state/pages/changeOrigin';
import type { ExactPageSource } from '../../../state/pages/revealSource';

export type { ExactPageSource };

export interface SourceTraceProps {
  source: ChangeSource;
  onOpenSource: (source: ExactPageSource) => void | boolean | Promise<void | boolean>;
}

const sourceKey = (item: ExactPageSource) => `${item.nodeId}:${item.turnId}:${item.assistantId}`;

/** Source links carry the complete trusted tuple so the caller can navigate to
 * the exact assistant message in its owning backend/workspace. */
export function SourceTrace({ source, onOpenSource }: SourceTraceProps) {
  const [unavailable, setUnavailable] = useState<Set<string>>(() => new Set());
  const open = (item: ExactPageSource) => {
    const key = sourceKey(item);
    void Promise.resolve(onOpenSource(item)).then((opened) => {
      if (opened === false) setUnavailable((current) => new Set(current).add(key));
    }).catch(() => setUnavailable((current) => new Set(current).add(key)));
  };
  if (source.kind === 'user') return null;

  if (source.kind === 'chat' || source.kind === 'helper') {
    return (
      <div className="page-change-source">
        <span>Source · {source.kind === 'helper' ? 'Page helper' : 'Chat'}</span>
        {unavailable.has(sourceKey(source))
          ? <span role="status">Source unavailable</span>
          : <button type="button" className="page-change-link" onClick={() => open(source)}>Open exact message</button>}
      </div>
    );
  }

  if (source.kind === 'maintenance') {
    const runSource: ExactPageSource = { kind: 'chat', nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId };
    const { cited, read } = changeOrigin(source);
    return (
      <div className="page-change-source">
        <span>Maintenance run</span>
        {unavailable.has(sourceKey(runSource))
          ? <span role="status">Run unavailable</span>
          : <button type="button" className="page-change-link" onClick={() => open(runSource)}>Open maintenance run</button>}
        {cited.map((item) => (
          unavailable.has(sourceKey(item)) ? <span key={sourceKey(item)} role="status">Source unavailable</span> : <button
            key={sourceKey(item)}
            type="button"
            className="page-change-link"
            onClick={() => open(item)}
          >
            Source · Open exact message
          </button>
        ))}
        {!cited.length && read && read.count > 0 && <span>Read {readLabel(read)}</span>}
      </div>
    );
  }

  if (source.kind === 'component') {
    return (
      <div className="page-change-source">
        <span>Component · v{source.version}</span>
        {'pageId' in source
          ? <span>Page component</span>
          : <span>Custom database view</span>}
      </div>
    );
  }
  return null;
}
