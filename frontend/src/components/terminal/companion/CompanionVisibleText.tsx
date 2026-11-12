import React from 'react';
import { companionVisibleText } from '../../../state/companion/companionCards';

/**
 * Text the agent or a source wrote (a card, a receipt's reason, Today's
 * "Dismissed by <name> — <reason>"), as it is: plain text, never Markdown or
 * links, with what the screen would not show marked where it is.
 */
export function CompanionVisibleText({ text }: { text: string }) {
  return (
    <>
      {companionVisibleText(text).map((piece, index) => (piece.kind === 'text'
        ? <React.Fragment key={index}>{piece.text}</React.Fragment>
        : (
          <span key={index} className="companion-hidden-chars" title={`Not shown on screen: ${piece.codePoints.join(' ')}`}>
            ⟨{piece.codePoints.length === 1 ? 'hidden character' : `${piece.codePoints.length} hidden characters`}⟩
          </span>
        )))}
    </>
  );
}
