import type { CSSProperties } from 'react';

/**
 * Palette colours for an agent's or a run's Markdown result. Each
 * MarkdownContent passes them itself: its `.prose` element declares the
 * typography plugin's light-theme grays, which win over the theme block
 * index.css keeps in `@layer base`. Without `--tw-prose-code`, inline code
 * is near-black on a dark palette.
 */
export const resultProseVars = {
  '--tw-prose-body': 'var(--term-mid)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent)',
  '--tw-prose-counters': 'var(--term-muted)',
  '--tw-prose-bullets': 'var(--term-muted)',
} as CSSProperties;
