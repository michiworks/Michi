import type { CSSProperties } from 'react';
import type { MetaChatSuggestion } from '../../../../state/metaChat/suggestions';
import './metaChat.css';

/**
 * The starter questions above an empty conversation's composer in Pages
 * (DESIGN-v2 §1.4 "起手建议保留"): picking one fills the composer, it never
 * sends. Moved out of the retired Spaces window chrome (F1a-review #6).
 */
export function MetaChatSuggestions({ suggestions, busy, onSuggestion }: {
  suggestions: readonly MetaChatSuggestion[];
  busy?: boolean;
  onSuggestion(suggestion: MetaChatSuggestion): void;
}) {
  if (!suggestions.length) return null;
  return (
    <div className="meta-chat-panel__suggestions" role="group" aria-label="Suggested questions">
      {suggestions.map((suggestion, index) => (
        <div key={suggestion.id} className="t-followup-row" data-disabled={busy ? 'true' : undefined}
          style={{ '--followup-delay': `${index * 90}ms` } as CSSProperties}>
          <button type="button" className="t-followup-text" disabled={busy} title={suggestion.label} onClick={() => onSuggestion(suggestion)}>
            {suggestion.label}
          </button>
        </div>
      ))}
    </div>
  );
}
