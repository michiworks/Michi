import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Reveal, RevealList, type RevealRow } from './agentBlockMotion';
import { CheckIcon, ChevronRightIcon } from './icons';
import './ReceiptLedger.css';

/** A row's growing boxes stay in the list's columns, so verbs and Views still line up. */
const LEDGER_ROW: CSSProperties = { gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid' };

/**
 * Under a reply: everything it changed, one row per thing, in one list. A row
 * that arrives while the reply is on screen grows in; `enter` false (a reply
 * that came with history) shows later rows settled too.
 */
export function ReceiptLedger({ rows, enter }: { rows: readonly RevealRow[]; enter: boolean }) {
  return (
    <div className="receipt-ledger">
      <div role="list" className="receipt-ledger__list" aria-label="What this reply changed">
        <RevealList rows={rows} enter={enter} rowStyle={LEDGER_ROW} />
      </div>
    </div>
  );
}

/**
 * One thing a reply changed: verb, name, a short note and its own View.
 * The verbs line up in a column; details, when given, open behind a chevron.
 */
export function ReceiptRow({ kind, verb, object, meta, action, details, detailsName = 'details' }: {
  kind: 'page' | 'scheduled-job';
  verb: string;
  object: string;
  meta?: string | null;
  action?: { label: string; onClick: () => void } | null;
  details?: ReactNode;
  /** What the chevron opens, for its label. */
  detailsName?: string;
}) {
  const [open, setOpen] = useState(false);
  const openedByClickRef = useRef(false);
  const detailsId = useId();
  const line = meta ? `${verb} ${object} · ${meta}` : `${verb} ${object}`;
  // The spaces between the cells keep the row's text readable as one line; a grid ignores them.
  return (
    <div role="listitem" className="receipt-row" data-receipt={kind}>
      <CheckIcon size="sm" className="receipt-row__glyph" />
      <span className="receipt-row__verb">{verb}</span>{' '}
      <span className="receipt-row__object" title={line}>{object}</span>{' '}
      {meta && <span className="receipt-row__meta">{meta}</span>}
      {(action || details) && <>{' '}<span className="receipt-row__actions">
        {action && <button type="button" className="receipt-row__link" onClick={action.onClick}>{action.label}</button>}
        {details && (
          <button
            type="button"
            className="receipt-row__toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? 'Hide' : 'Show'} ${detailsName}`}
            onClick={() => { openedByClickRef.current = !open; setOpen(!open); }}
          >
            <ChevronRightIcon />
          </button>
        )}
      </span></>}
      {details && <div className="receipt-row__details" id={detailsId}><Reveal show={open} scrollOnOpen={openedByClickRef}>{details}</Reveal></div>}
    </div>
  );
}
