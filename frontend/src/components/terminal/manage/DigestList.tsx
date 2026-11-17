import type { DigestSummary } from './derive';
import ManageListEmpty from './ManageListEmpty';

interface Props {
  digests: DigestSummary[];
  filter: string;
  onClearFilter?: () => void;
  onOpen: (nodeId: string) => void;
  onRebuild: (nodeId: string) => void;
  onExport: (nodeId: string) => void;
}

function relative(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

export default function DigestList({ digests, filter, onClearFilter, onOpen, onRebuild, onExport }: Props) {
  const norm = filter.trim().toLowerCase();
  const filtered = norm ? digests.filter((d) => d.title.toLowerCase().includes(norm)) : digests;

  if (filtered.length === 0) {
    return <ManageListEmpty query={filter.trim()} empty="no digests yet" onClearFilter={onClearFilter} />;
  }

  return (
    <div>
      {filtered.map((d) => (
        <article
          key={d.nodeId}
          style={{
            background: 'var(--term-surface)',
            border: '1px solid var(--term-line)',
            padding: '20px 22px',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--term-digest)',
                background: 'var(--term-digest-f)',
                padding: '2px 7px',
                letterSpacing: 'var(--ls-caps)',
                fontWeight: 600,
                fontFamily: 'var(--ui-font)',
              }}
            >
              DIGEST
            </span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontSize: 'var(--fs-md)',
                color: 'var(--term-muted)',
                fontFamily: 'var(--ui-font)',
              }}
            >
              {d.sourceCount} sources · {relative(d.updatedAt)}
            </span>
          </div>
          <div
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-3xl)',
              lineHeight: 1.3,
              fontWeight: 500,
              marginTop: 8,
              color: 'var(--term-fg)',
            }}
          >
            {d.title}
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-xl)',
              lineHeight: 1.6,
              color: 'var(--term-mid, var(--term-fg))',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {d.excerpt || '(empty)'}
          </div>
          {/* Text buttons; the row starts at their labels, not their padding. */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, marginLeft: -8 }}>
            <button type="button" className="t-text-btn" onClick={() => onOpen(d.nodeId)}>→ open</button>
            <button type="button" className="t-text-btn" onClick={() => onRebuild(d.nodeId)}>↻ rebuild</button>
            <button type="button" className="t-text-btn" onClick={() => onExport(d.nodeId)}>⤓ export</button>
          </div>
        </article>
      ))}
    </div>
  );
}
