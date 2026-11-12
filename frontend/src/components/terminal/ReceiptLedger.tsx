import { useId, useState, type ReactNode } from 'react';
import { Reveal } from './agentBlockMotion';
import { ChevronRightIcon } from './icons';
import './ReceiptLedger.css';

/** Under a reply: everything it changed, one row per thing, in one list. */
export function ReceiptLedger({ children }: { children: ReactNode }) {
  return (
    <div className="receipt-ledger">
      <ul className="receipt-ledger__list" aria-label="What this reply changed">{children}</ul>
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
  const detailsId = useId();
  const line = meta ? `${verb} ${object} · ${meta}` : `${verb} ${object}`;
  // The spaces between the cells keep the row's text readable as one line; a grid ignores them.
  return (
    <li className="receipt-row" data-receipt={kind}>
      <span className="receipt-row__glyph" aria-hidden="true">✓</span>{' '}
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
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRightIcon size={12} />
          </button>
        )}
      </span></>}
      {details && <div className="receipt-row__details" id={detailsId}><Reveal show={open}>{details}</Reveal></div>}
    </li>
  );
}
