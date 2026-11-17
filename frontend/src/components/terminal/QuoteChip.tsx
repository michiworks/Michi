import { useId, useRef, useState } from 'react';
import type { AnyQuoteSource } from '../../lib/quoteFormat';
import { attachedQuoteHasSelection, quoteSourceOf } from '../../state/assistant/assistantContext';
import { useInAssistantScope } from './assistant/assistantScope';
import { ContextGlyph, CtxExpandButton, oneLine, ReplyGlyph, sourceMeta, useClipped } from './ContextItem';

interface Props {
  text: string;
  /** Where the quote came from (ChatMessage.quoteSource). */
  source?: AnyQuoteSource;
}

/**
 * The passage a sent user message replied to, as the composer's quote row
 * showed it: the reply arrow, then the passage on one line. It can no
 * longer be dismissed, only unfolded, and offers that only when the line
 * cuts text. A quote of attached context only (the ⌘J assistant's page and
 * chips, no selection) is marked as that, not as a reply to a selection.
 */
export function QuoteChip({ text, source }: Props) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const excerptRef = useRef<HTMLSpanElement>(null);
  const clipped = useClipped(expanded, text, excerptRef);
  // The source isn't stored: after a reload the assistant's own messages read it from the quote's opening.
  const inAssistant = useInAssistantScope();
  const resolved = source ?? (inAssistant ? quoteSourceOf(text) : undefined);
  const contextOnly = resolved?.type === 'attached' && !attachedQuoteHasSelection(text);
  const meta = sourceMeta(resolved, false);

  return (
    <div
      className={[
        't-ctx is-quote is-msg',
        contextOnly ? 'is-context' : '',
        expanded ? 'is-expanded' : '',
      ].filter(Boolean).join(' ')}
    >
      <span className="t-ctx-mark">
        {contextOnly ? <ContextGlyph /> : <ReplyGlyph />}
        <span className="t-ctx-label sr-only">{contextOnly ? 'Attached context' : 'Replying to selection'}</span>
      </span>
      <div className="t-ctx-line" id={textId}>
        <span ref={excerptRef} data-testid="quote-preview" className="t-ctx-excerpt">
          {expanded ? text.trim() : oneLine(text)}
        </span>
        {meta && <span className="t-ctx-meta">{meta}</span>}
      </div>
      {(clipped || expanded) && (
        <CtxExpandButton
          label={contextOnly ? 'Show full context' : 'Show full quote'}
          expanded={expanded}
          controls={textId}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
    </div>
  );
}
