import React, { useCallback } from 'react';
import { BranchIcon } from './terminal/icons';

export interface FollowUpRowProps {
  index: number;
  question: string;
  onContinue: (question: string) => void;
  onBranch: (question: string) => void;
  disabled?: boolean;
  /** Already branched from here (phones): the button reads Branched and the
   *  row quiets; branching again still works. */
  branched?: boolean;
  /** The turn it follows ended on screen: the row pops in, 90ms after the
   *  one above it. Otherwise it renders settled (index.css). */
  arriving?: boolean;
  /** Its pop has ended. */
  onArrived?: () => void;
}

export function FollowUpRow({
  index,
  question,
  onContinue,
  onBranch,
  disabled = false,
  branched = false,
  arriving = false,
  onArrived,
}: FollowUpRowProps): React.JSX.Element {
  const ariaContinue = `Continue follow-up in current pane: ${question}. Press B to branch into a new pane.`;
  const ariaBranch = `Branch follow-up into new pane: ${question}`;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        e.stopPropagation();
        onBranch(question);
      }
    },
    [disabled, onBranch, question],
  );

  const handleBranchClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (disabled) return;
      onBranch(question);
    },
    [disabled, onBranch, question],
  );

  return (
    <div
      className="t-followup-row"
      role="group"
      style={{ '--followup-delay': `${index * 90}ms` } as React.CSSProperties}
      data-disabled={disabled ? 'true' : undefined}
      data-branched={branched ? 'true' : undefined}
      data-arriving={arriving ? '' : undefined}
      onAnimationEnd={onArrived ? (e) => { if (e.target === e.currentTarget) onArrived(); } : undefined}
    >
      <button
        type="button"
        className="t-followup-text"
        aria-label={ariaContinue}
        disabled={disabled}
        onClick={() => onContinue(question)}
        onKeyDown={handleKeyDown}
      >
        {question}
      </button>
      <button
        type="button"
        className="t-followup-branch"
        aria-label={ariaBranch}
        title="Branch into new pane"
        disabled={disabled}
        onClick={handleBranchClick}
      >
        <span className="t-followup-branch-glyph" aria-hidden>
          <BranchIcon />
        </span>
        <span className="t-followup-branch-label">{branched ? 'Branched' : 'Branch'}</span>
      </button>
    </div>
  );
}
