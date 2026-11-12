import React from 'react';

function diffLineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return { color: 'var(--term-muted)' };
  if (line.startsWith('+')) return { color: 'var(--term-digest)', background: 'color-mix(in srgb, var(--term-digest) 8%, transparent)' };
  if (line.startsWith('-')) return { color: 'var(--term-danger-text)', background: 'color-mix(in srgb, var(--term-danger) 8%, transparent)' };
  if (line.startsWith('@@')) return { color: 'var(--term-accent)', background: 'color-mix(in srgb, var(--term-accent) 7%, transparent)' };
  if (line.startsWith('diff ') || line.startsWith('index ')) return { color: 'var(--term-muted)' };
  return { color: 'var(--term-mid)' };
}

/**
 * A unified diff, one tinted block per line. `wrap` suits a scroller that
 * only scrolls vertically; unwrapped, the lines grow to the longest so the
 * tints run under a horizontal scroll.
 */
export function UnifiedDiff({ diff, wrap = false }: { diff: string; wrap?: boolean }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'var(--message-code-font, monospace)',
        fontSize: 'var(--fs-sm)',
        lineHeight: 1.55,
        ...(wrap ? { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } : { whiteSpace: 'pre', minWidth: 'max-content' }),
      }}
    >
      {diff.split('\n').map((line, index) => (
        <span key={index} style={{ display: 'block', padding: '0 14px', ...diffLineStyle(line) }}>{line || ' '}</span>
      ))}
    </pre>
  );
}
