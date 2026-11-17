import type { CSSProperties } from 'react';

/**
 * Palette colours for an agent's or a run's Markdown result, the transcript's
 * set: body text in --term-fg, list markers a step dimmer. Each
 * MarkdownContent passes them itself: its `.prose` element declares the
 * typography plugin's light-theme grays, which win over the theme block
 * index.css keeps in `@layer base`. Without `--tw-prose-code`, inline code
 * is near-black on a dark palette.
 */
export const resultProseVars = {
  '--tw-prose-body': 'var(--term-fg)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent-text)',
  '--tw-prose-counters': 'var(--term-mid)',
  '--tw-prose-bullets': 'var(--term-mid)',
} as CSSProperties;
