import React, { createContext, useContext, useMemo, useState } from 'react';
import { omittedItemsCount } from 'michi-shared';
import MarkdownContent from '../../MarkdownContent';
import { resultProseVars } from '../resultProseVars';
import { INNER_RADIUS } from './workCardParts';
import {
  baseName,
  chipTone,
  countNoun,
  fieldLabel,
  formatNumber,
  isChipField,
  isCodeLike,
  isCountField,
  isOneLine,
  isRecord,
  looksMarkdown,
  refKey,
  tableColumns,
  titleKey,
  type ChipTone,
  type ResultValue,
} from './resultValue';

/**
 * A JSON result laid out by its shape, so no schema is needed: a record's
 * name becomes its title, its category fields chips, its counts one line
 * ("34 rules · 8 questions") and its short fields a list; text, lists and
 * nested records follow in the order the agent wrote them. A list of
 * records is a stack of cards (rows within a card), a list of a few short
 * fields alike is a table. Where the stored text ends, the result says so.
 */

const MONO = 'var(--font-mono)';
const LIST_LIMIT = 8;
const MAX_DEPTH = 5;

interface Sizes { body: string; title: string; label: string; small: string }
const REGULAR: Sizes = { body: 'var(--fs-lg)', title: 'var(--fs-lg)', label: 'var(--fs-sm)', small: 'var(--fs-md)' };
const COMPACT: Sizes = { body: 'var(--fs-md)', title: 'var(--fs-md)', label: 'var(--fs-xs)', small: 'var(--fs-sm)' };

interface View { cut?: object; open: ReadonlySet<object>; cutNote: string; sizes: Sizes; preview: boolean }
const ViewContext = createContext<View>({ open: new Set(), cutNote: '', sizes: REGULAR, preview: false });

const CHIP: Record<ChipTone, React.CSSProperties> = {
  danger: { color: 'var(--term-danger-text)', background: 'color-mix(in srgb, var(--term-danger) 14%, transparent)' },
  warn: { color: 'var(--term-waiting-text)', background: 'var(--term-waiting-f)' },
  neutral: { color: 'var(--term-mid)', background: 'var(--term-alt)' },
};

const SHOW_MORE: React.CSSProperties = { alignSelf: 'flex-start', fontSize: 'var(--fs-sm)', textDecoration: 'underline', textDecorationColor: 'var(--term-line-s)', textUnderlineOffset: 2 };

export const ResultValueView = React.memo(function ResultValueView({ result, cutNote, compact = false, preview = false }: {
  result: ResultValue;
  /** Why the stored text ends early, said where it ends. */
  cutNote: string;
  /** An agent's result inside its row, a step smaller. */
  compact?: boolean;
  /** A summary's preview: what it leaves out is still stored. */
  preview?: boolean;
}) {
  const sizes = compact ? COMPACT : REGULAR;
  const view = useMemo<View>(() => ({ cut: result.cut, open: result.open, cutNote, sizes, preview }), [result, cutNote, sizes, preview]);
  const { value } = result;
  return (
    <ViewContext.Provider value={view}>
      <div data-testid="result-value" style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12, minWidth: 0, fontSize: sizes.body, lineHeight: 1.55, color: 'var(--term-mid)' }}>
        {isRecord(value) ? <RecordBody record={value} depth={0} /> : Array.isArray(value) ? <ListValue items={value} depth={1} /> : null}
      </div>
    </ViewContext.Provider>
  );
});

function CutMark() {
  const { cutNote } = useContext(ViewContext);
  return (
    <p data-testid="result-cut" style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
      <span aria-hidden>⋯ </span>Cut off here. {cutNote}
    </p>
  );
}

function Text({ value }: { value: string }) {
  const { sizes } = useContext(ViewContext);
  if (looksMarkdown(value)) {
    return <MarkdownContent text={value} size="sm" style={{ ...resultProseVars, fontSize: sizes.body, lineHeight: 1.55 }} />;
  }
  if (isCodeLike(value)) return <code style={{ fontFamily: MONO, fontSize: sizes.small, wordBreak: 'break-all' }}>{value}</code>;
  return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>;
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span style={{ color: 'var(--term-faint)' }}>—</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number') return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatNumber(value)}</span>;
  if (typeof value === 'string') return <Text value={value} />;
  return <Raw value={value} />;
}

function Raw({ value }: { value: unknown }) {
  const { open, sizes } = useContext(ViewContext);
  return (
    <>
      <pre className="term-scrollbar" style={{ margin: 0, maxHeight: 240, overflow: 'auto', padding: '6px 8px', borderRadius: INNER_RADIUS, background: 'var(--term-alt)', fontFamily: MONO, fontSize: sizes.label, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--term-mid)' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
      {typeof value === 'object' && value !== null && open.has(value) && <CutMark />}
    </>
  );
}

function Chip({ value }: { value: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', height: 18, padding: '0 6px', borderRadius: 'var(--ui-radius)', fontSize: 'var(--fs-xs)', fontWeight: 500, lineHeight: 1, whiteSpace: 'nowrap', ...CHIP[chipTone(value)] }}>
      {value}
    </span>
  );
}

/** "34 rules · 8 questions · ✓ merged": counts and yes/no fields, one line. */
function Counts({ entries }: { entries: ReadonlyArray<readonly [string, number | boolean]> }) {
  const { sizes } = useContext(ViewContext);
  return (
    <p style={{ margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, rowGap: 2, fontSize: sizes.label, color: 'var(--term-muted)' }}>
      {entries.map(([key, value], index) => (
        <React.Fragment key={key}>
          {index > 0 && <span aria-hidden style={{ color: 'var(--term-faint)' }}>·</span>}
          {typeof value === 'boolean' ? (
            <span><span aria-hidden>{value ? '✓' : '✗'} </span>{countNoun(key)}<span className="sr-only">{value ? ': yes' : ': no'}</span></span>
          ) : (
            <span><span style={{ color: 'var(--term-fg)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{formatNumber(value)}</span> {countNoun(key)}</span>
          )}
        </React.Fragment>
      ))}
    </p>
  );
}

function Field({ label, count, depth, children }: { label: string; count?: string; depth: number; children: React.ReactNode }) {
  const { sizes } = useContext(ViewContext);
  const top = depth <= 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <div style={{ fontSize: top ? sizes.label : 'var(--fs-xs)', fontWeight: top ? 600 : 500, color: top ? 'var(--term-fg)' : 'var(--term-muted)' }}>
        {label}
        {count !== undefined && <span style={{ fontWeight: 400, color: 'var(--term-faint)' }}> · {count}</span>}
      </div>
      {children}
    </div>
  );
}

function isCounts(record: Record<string, unknown>): record is Record<string, number | boolean> {
  const values = Object.values(record);
  return values.length > 0 && values.every((value) => typeof value === 'number' || typeof value === 'boolean');
}

/** A field that does not fit on one line: text, a list, a record. */
function Block({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const { open } = useContext(ViewContext);
  const label = fieldLabel(name);
  if (Array.isArray(value)) return <ListValue items={value} depth={depth} label={label} />;
  if (isRecord(value) && isCounts(value)) {
    return (
      <Field label={label} depth={depth}>
        <Counts entries={Object.entries(value)} />
        {open.has(value) && <CutMark />}
      </Field>
    );
  }
  return (
    <Field label={label} depth={depth}>
      {isRecord(value) ? <RecordFrame record={value} depth={depth} variant={depth <= 1 ? 'card' : 'nested'} first /> : <Scalar value={value} />}
    </Field>
  );
}

function RecordBody({ record, depth }: { record: Record<string, unknown>; depth: number }) {
  const { cut, sizes } = useContext(ViewContext);
  if (depth > MAX_DEPTH) return <Raw value={record} />;
  const title = titleKey(record);
  const ref = refKey(record, title);
  const chips: Array<[string, string]> = [];
  const counts: Array<[string, number | boolean]> = [];
  const fields: Array<[string, unknown]> = [];
  const blocks: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === title || key === ref) continue;
    if (isChipField(key, value)) chips.push([key, value]);
    else if (isCountField(key, value) || typeof value === 'boolean') counts.push([key, value]);
    else if (value === null || typeof value === 'number' || value === '' || isOneLine(value, 120)) fields.push([key, value]);
    else blocks.push([key, value]);
  }
  const titleValue = title !== undefined ? String(record[title]) : undefined;
  const isPath = titleValue !== undefined && titleValue.includes('/') && isCodeLike(titleValue);
  return (
    <>
      {(titleValue !== undefined || chips.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          {ref && <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: sizes.label, color: 'var(--term-muted)' }}>{String(record[ref])}</span>}
          {titleValue !== undefined && (
            <span title={isPath ? titleValue : undefined} style={{ flex: '1 1 auto', minWidth: 0, fontSize: depth === 0 && sizes === REGULAR ? 'var(--fs-xl)' : sizes.title, fontWeight: 600, lineHeight: 1.35, color: 'var(--term-fg)', overflowWrap: 'anywhere' }}>
              {isPath ? baseName(titleValue) : titleValue}
            </span>
          )}
          {chips.length > 0 && (
            <span style={{ display: 'inline-flex', flexShrink: 0, gap: 4, marginLeft: 'auto' }}>
              {chips.map(([key, value]) => <Chip key={key} value={value} />)}
            </span>
          )}
        </div>
      )}
      {counts.length > 0 && <Counts entries={counts} />}
      {fields.length > 0 && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'fit-content(40%) minmax(0, 1fr)', columnGap: 12, rowGap: 3, fontSize: sizes.small, lineHeight: 1.5 }}>
          {fields.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt style={{ color: 'var(--term-muted)', overflowWrap: 'anywhere' }}>{fieldLabel(key)}</dt>
              <dd style={{ margin: 0, minWidth: 0, color: 'var(--term-mid)', overflowWrap: 'anywhere' }}><Scalar value={value} /></dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {blocks.map(([key, value]) => <Block key={key} name={key} value={value} depth={depth + 1} />)}
      {record === cut && <CutMark />}
    </>
  );
}

/** A record in a list: a card at the top, a row inside a card, a ruled block as a field. */
function RecordFrame({ record, depth, variant, first }: { record: Record<string, unknown>; depth: number; variant: 'card' | 'item' | 'nested'; first: boolean }) {
  const { sizes } = useContext(ViewContext);
  const frame: React.CSSProperties = variant === 'card'
    ? { padding: sizes === COMPACT ? '8px 10px' : '10px 12px', borderRadius: INNER_RADIUS, background: 'color-mix(in srgb, var(--term-fg) 4%, transparent)' }
    : variant === 'item'
      ? (first ? {} : { paddingTop: 8, borderTop: '1px solid var(--term-line)' })
      : { paddingLeft: 10, borderLeft: '2px solid var(--term-line)' };
  return (
    <div data-testid="result-record" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, ...frame }}>
      <RecordBody record={record} depth={depth} />
    </div>
  );
}

function Table({ rows, columns }: { rows: ReadonlyArray<Record<string, unknown>>; columns: string[] }) {
  const { sizes } = useContext(ViewContext);
  const numeric = new Set(columns.filter((column) => rows.every((row) => row[column] === undefined || typeof row[column] === 'number')));
  const cell = (column: string, index: number): React.CSSProperties => ({
    padding: index < columns.length - 1 ? '3px 14px 3px 0' : '3px 0',
    textAlign: numeric.has(column) ? 'right' : 'left',
    verticalAlign: 'baseline',
  });
  return (
    <div className="term-scrollbar" style={{ overflowX: 'auto', minWidth: 0 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: sizes.small, lineHeight: 1.45 }}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={column} scope="col" style={{ ...cell(column, index), fontSize: 'var(--fs-xs)', fontWeight: 500, color: 'var(--term-muted)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--term-line)' }}>
                {fieldLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} style={rowIndex < rows.length - 1 ? { borderBottom: '1px solid color-mix(in srgb, var(--term-line) 55%, transparent)' } : undefined}>
              {columns.map((column, index) => (
                <td key={column} style={{ ...cell(column, index), color: 'var(--term-mid)', overflowWrap: 'anywhere' }}><Scalar value={row[column]} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListValue({ items, depth, label }: { items: unknown[]; depth: number; label?: string }) {
  const { cut, open, preview } = useContext(ViewContext);
  const [all, setAll] = useState(false);
  if (depth > MAX_DEPTH) return label ? <Field label={label} depth={depth}><Raw value={items} /></Field> : <Raw value={items} />;
  // A list the run kept only the start of ends with a marker of what it left out.
  const omitted = omittedItemsCount(items[items.length - 1]);
  const list = omitted === undefined ? items : items.slice(0, -1);
  const shown = all ? list : list.slice(0, LIST_LIMIT);
  const hidden = list.length - shown.length;
  const columns = tableColumns(list);
  let body: React.ReactNode;
  if (list.length === 0) {
    body = omitted === undefined && <span style={{ color: 'var(--term-faint)' }}>None</span>;
  } else if (columns) {
    body = <Table rows={shown as Array<Record<string, unknown>>} columns={columns} />;
  } else if (list.every(isRecord)) {
    const variant = depth <= 1 ? 'card' : 'item';
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        {(shown as Array<Record<string, unknown>>).map((item, index) => <RecordFrame key={index} record={item} depth={depth} variant={variant} first={index === 0} />)}
      </div>
    );
  } else if (list.every((item) => typeof item === 'number' || typeof item === 'boolean' || item === null)) {
    body = <span style={{ fontVariantNumeric: 'tabular-nums' }}>{shown.map((item) => (typeof item === 'number' ? formatNumber(item) : String(item))).join(', ')}</span>;
  } else {
    body = (
      <ul style={{ margin: 0, paddingLeft: 16, listStyleType: 'disc', display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--term-muted)' }}>
        {shown.map((item, index) => (
          <li key={index} style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--term-mid)', minWidth: 0 }}>
              {isRecord(item) ? <RecordFrame record={item} depth={depth + 1} variant="nested" first /> : Array.isArray(item) ? <ListValue items={item} depth={depth + 1} /> : <Scalar value={item} />}
            </div>
          </li>
        ))}
      </ul>
    );
  }
  const content = (
    <>
      {body}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="t-hover-fg workflow-card-link" style={SHOW_MORE}>
          Show {hidden} more
        </button>
      )}
      {omitted !== undefined && (
        <p data-testid="result-omitted" style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
          <span aria-hidden>⋯ </span>{omitted} more{preview ? '' : ' not kept'}
        </p>
      )}
      {(columns ? open.has(items) : items === cut) && <CutMark />}
    </>
  );
  if (label === undefined) return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>{content}</div>;
  return <Field label={label} count={`${list.length + (omitted ?? 0)}${open.has(items) ? '+' : ''}`} depth={depth}>{content}</Field>;
}
