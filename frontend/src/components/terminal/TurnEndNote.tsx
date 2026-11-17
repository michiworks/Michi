import { turnEndNote, type TurnEndMark } from 'michi-shared';

/**
 * The line at the end of an answer whose turn did not finish it: "Stopped"
 * for a Stop the server confirmed, or why it ended early. Neutral, not an
 * error: a Stop is not a failure. The latest turn's line offers Continue,
 * which sends the continuation prompt through the normal send path.
 */
export function TurnEndNote({ mark, onContinue }: { mark: TurnEndMark; onContinue?: () => void }) {
  return (
    <div
      data-testid="turn-end-note"
      data-turn-end={mark}
      style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
    >
      <span style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>
        {turnEndNote(mark)}
      </span>
      {onContinue && (
        <button
          type="button"
          className="t-text-btn is-bordered"
          onClick={(event) => { event.stopPropagation(); onContinue(); }}
        >
          Continue
        </button>
      )}
    </div>
  );
}
