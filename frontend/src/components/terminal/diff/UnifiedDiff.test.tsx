import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnifiedDiff } from './UnifiedDiff';

const DIFF = ['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '+added', '-removed', ' context', ''].join('\n');

function lines(wrap?: boolean) {
  const { container } = render(<UnifiedDiff diff={DIFF} wrap={wrap} />);
  const pre = container.querySelector('pre')!;
  return { pre, spans: [...pre.querySelectorAll('span')] };
}

describe('UnifiedDiff', () => {
  it('tints added, removed and hunk lines and mutes the file headers', () => {
    const { spans } = lines();
    expect(spans.map((span) => [span.textContent, span.style.color, span.style.background])).toEqual([
      ['diff --git a/x b/x', 'var(--term-muted)', ''],
      ['index 1..2', 'var(--term-muted)', ''],
      ['--- a/x', 'var(--term-muted)', ''],
      ['+++ b/x', 'var(--term-muted)', ''],
      ['@@ -1 +1 @@', 'var(--term-accent)', 'color-mix(in srgb, var(--term-accent) 7%, transparent)'],
      ['+added', 'var(--term-digest)', 'color-mix(in srgb, var(--term-digest) 8%, transparent)'],
      ['-removed', 'var(--term-danger-text)', 'color-mix(in srgb, var(--term-danger) 8%, transparent)'],
      [' context', 'var(--term-mid)', ''],
      [' ', 'var(--term-mid)', ''],
    ]);
  });

  it('keeps long lines whole unless asked to wrap', () => {
    expect(lines().pre.style.whiteSpace).toBe('pre');
    const wrapped = lines(true).pre;
    expect(wrapped.style.whiteSpace).toBe('pre-wrap');
    expect(wrapped.style.wordBreak).toBe('break-all');
  });
});
