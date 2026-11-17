import React from 'react';
import type { RowAttention } from '../../state/sidebarSelectors';
import { WORKFLOW_CHIP, WORKFLOW_NEEDS_YOU_CHIP } from './workflows/workflowPresentation';

/**
 * The word and the hue per state are the workflow surfaces' own
 * (workflowPresentation), so "Needs you" and "Failed" read the same in a
 * sidebar row as on a run card.
 */
const ATTENTION_CHIP: Record<Exclude<RowAttention, 'none'>, { label: string; color: string; fill: string }> = {
  waiting: WORKFLOW_NEEDS_YOU_CHIP,
  failed: WORKFLOW_CHIP.failed,
};

/**
 * What the state adds to the row's name for a screen reader. The chip itself
 * is `aria-hidden`: a row carries one `aria-label` (its title), which would
 * hide the chip's words anyway.
 */
const ATTENTION_LABEL: Record<Exclude<RowAttention, 'none'>, string> = {
  waiting: 'needs you',
  failed: 'last turn failed',
};

/** The row's name plus its state, for `aria-label`. */
export function attentionLabel(parts: ReadonlyArray<string | false | undefined>, attention: RowAttention): string {
  return [...parts, attention !== 'none' && ATTENTION_LABEL[attention]].filter(Boolean).join(', ');
}

/**
 * A sidebar row's state chip, after its title: a turn waiting on you, or a
 * last turn that failed (R2, see RowAttention). Nothing in every other state —
 * running, open and unread stay the rail's and the dot's job.
 */
export function RowAttentionChip({ attention }: { attention: RowAttention }) {
  if (attention === 'none') return null;
  const chip = ATTENTION_CHIP[attention];
  return (
    <span
      aria-hidden
      className="sb-attn"
      data-attn={attention}
      style={{ ['--sb-attn-fg' as string]: chip.color, ['--sb-attn-bg' as string]: chip.fill }}
    >
      {chip.label}
    </span>
  );
}
