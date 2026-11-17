import { useId, useRef, useState } from 'react';
import type { PendingComment } from '../../state/chatTypes';
import { CommentGlyph, CtxExpandButton, oneLine, sourceMeta, useClipped } from './ContextItem';

interface Props {
  comments: PendingComment[];
}

/**
 * The comments a sent user message carried, as the rows the composer's
 * card showed (ContextTray): the passage, then the note. They
 * can no longer be removed or edited, only unfolded, so a row offers its
 * expand toggle where the composer put its ×, and only when it cuts text.
 */
export function CommentChips({ comments }: Props) {
  if (comments.length === 0) return null;
  return (
    <ol className="t-ctx-list is-msg" aria-label="Comments">
      {comments.map((c) => (
        <CommentChip key={c.id} comment={c} />
      ))}
    </ol>
  );
}

function CommentChip({ comment }: { comment: PendingComment }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const excerptRef = useRef<HTMLSpanElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const clipped = useClipped(expanded, `${comment.quotedText}\n${comment.body}`, excerptRef, noteRef);
  const meta = sourceMeta(comment.source, false);
  const body = expanded ? comment.body.trim() : oneLine(comment.body);

  return (
    <li className={expanded ? 't-ctx is-comment is-expanded' : 't-ctx is-comment'}>
      <span className="t-ctx-mark" aria-hidden><CommentGlyph /></span>
      <div className="t-ctx-line" id={`${id}-quote`}>
        <span ref={excerptRef} data-testid="comment-quote" className="t-ctx-excerpt">
          {expanded ? comment.quotedText.trim() : oneLine(comment.quotedText)}
        </span>
        {meta && <span className="t-ctx-meta">{meta}</span>}
      </div>
      {(clipped || expanded) && (
        <CtxExpandButton
          label="Show full comment"
          expanded={expanded}
          controls={body ? `${id}-quote ${id}-note` : `${id}-quote`}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
      {body && (
        <div ref={noteRef} id={`${id}-note`} data-testid="comment-body" className="t-ctx-note">
          {body}
        </div>
      )}
    </li>
  );
}
