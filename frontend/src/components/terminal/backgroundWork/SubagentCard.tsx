import React, { useId } from 'react';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import type { BackgroundSubagentItem } from '../../../state/backgroundWork';
import type { SubagentInfo } from '../../../state/chatTypes';
import { formatDurationMs } from '../toolCallGrouping';
import { SubagentDetail, subagentDetailDomId } from '../subagents/SubagentDetail';
import {
  SUBAGENT_TONE_LABEL,
  subagentRowTitle,
  subagentShownDurationMs,
  subagentSummary,
  subagentTone,
  type SubagentSummaryTone,
  type SubagentTone,
} from '../subagents/subagentPresentation';
import { useNow } from '../../../hooks/useNow';
import { BAND_ROW, ToolLine } from './WorkflowWorkCard';
import type { CardLeafState } from './workflowCardModel';
import { SegmentStrip, StateGlyph, WORK_CARD, useFinishedFold } from './workCardParts';
import './WorkflowWorkCard.css';

/**
 * A conversation's subagents in the Background work drawer, as one card in
 * the workflow card's language: bands over rows. The first band lists them,
 * running first; finished ones the drawer folds (foldedItems) wait behind a
 * second band, "Finished", closed while others run. A band has no number,
 * so its title starts at the card's edge, over the rows' glyph column.
 *
 * Each row leads with what the agent was asked to do, its type a quiet label
 * under it. The glyph column marks only what differs (done, failed, stopped):
 * a running agent carries none, and nothing here is in the run colour.
 */

const MONO = 'var(--font-mono)';
const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/** An ended agent's tone as a workflow leaf's state; other tones read as running (glyph) or queued (segment). */
function endedState(tone: SubagentTone): CardLeafState | undefined {
  return tone === 'completed' || tone === 'failed' || tone === 'cancelled' ? tone : undefined;
}

/** Finished work is green, like a workflow's; running work is neutral. */
function Segments({ items }: { items: readonly BackgroundSubagentItem[] }) {
  const segments = items.map(({ subagent, active }) => ({
    key: subagent.sessionId,
    state: active ? 'running' as const : endedState(subagentTone(subagent, active)) ?? 'queued',
  }));
  return <SegmentStrip segments={segments} fixed />;
}

function Band({ title, items, count, label, open, controls, onClick, testId, stacked, done }: {
  title: string;
  items: readonly BackgroundSubagentItem[];
  /** What the band says after its segments: how many, and how many failed. */
  count: { text: string; failed: number };
  label: string;
  open: boolean;
  controls: string;
  onClick: () => void;
  testId: string;
  stacked: boolean;
  /** Nothing under it runs: its title steps back like a finished phase's. */
  done: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      onClick={onClick}
      className="workflow-phase-band"
      style={{
        display: 'grid', gridTemplateColumns: 'fit-content(46%) minmax(24px, 1fr) auto 10px', alignItems: 'center', columnGap: 12,
        width: '100%', minWidth: 0, minHeight: stacked ? 44 : 36, padding: '0 16px', border: 0,
        borderBottom: open ? '1px solid var(--term-line)' : 0, borderRadius: 0, color: 'inherit', font: 'inherit', textAlign: 'left',
      }}
    >
      <span style={{ ...ellipsis, fontSize: 'var(--fs-md)', fontWeight: 600, color: done ? 'var(--term-mid)' : 'var(--term-fg)' }}>{title}</span>
      <Segments items={items} />
      <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-mid)', whiteSpace: 'nowrap', textAlign: 'right' }}>
        {count.text}
        {count.failed > 0 && <span style={{ color: 'var(--term-danger-text)' }}> · {count.failed} failed</span>}
      </span>
      <span aria-hidden style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-faint)', textAlign: 'right' }}>{open ? '▾' : '▸'}</span>
    </button>
  );
}

/** The state words a glyph cannot say; working, completed and failed read from the glyph. */
const TONE_WORD: Partial<Record<SubagentTone, string>> = { background: 'in background', cancelled: 'stopped', ended: 'ended' };

const SUMMARY_COLOR: Record<SubagentSummaryTone, string> = {
  now: 'var(--term-muted)',
  status: 'var(--term-mid)',
  result: 'var(--term-mid)',
  error: 'var(--term-danger-text)',
  mission: 'var(--term-muted)',
};

/** What the row says the agent does: a tool as a label and its argument quiet, else one line in the summary's tone. */
function RowSummary({ summary }: { summary: { tone: SubagentSummaryTone; text: string } | undefined }) {
  if (!summary) return <span style={{ flex: 1 }} />;
  return (
    <span data-testid="subagent-summary-text" data-summary-tone={summary.tone} style={{ display: 'flex', flex: 1, minWidth: 0 }}>
      {summary.tone === 'now'
        ? <ToolLine line={summary.text} />
        : <span style={{ ...ellipsis, flex: 1, fontSize: 'var(--fs-sm)', color: SUMMARY_COLOR[summary.tone] }}>{summary.text}</span>}
    </span>
  );
}

/**
 * Elapsed time, ticking while the agent runs (a background agent's too:
 * since it started, not its launch turn's length). Still once it stopped.
 * The row's one clock: the detail does not repeat it.
 */
function SubagentDuration({ subagent, active }: { subagent: SubagentInfo; active: boolean }) {
  const now = useNow(1_000, active);
  const duration = subagentShownDurationMs(subagent, active, now);
  return duration === undefined ? null : <span>{formatDurationMs(duration)}</span>;
}

const rowLine: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: BAND_ROW.gap, width: '100%', minWidth: 0 };

const SubagentWorkRow = React.memo(function SubagentWorkRow({ subagent, active, rowKey, expanded, onToggle }: {
  subagent: SubagentInfo;
  active: boolean;
  rowKey: string;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  // A `working` entry the conversation no longer counts reads as ended.
  const tone = subagentTone(subagent, active);
  const { title, kind } = subagentRowTitle(subagent);
  const said = subagentSummary(subagent, { running: tone === 'running' });
  // The title already says the mission.
  const summary = said?.tone === 'mission' && said.text === title ? undefined : said;
  const stacked = usePhoneLayout();
  const ended = tone === 'completed' || tone === 'ended' || tone === 'cancelled';
  // Only what differs from running gets a glyph: done, failed, stopped.
  const glyph = <StateGlyph state={endedState(tone) ?? 'running'} />;
  const nameText = (
    <span style={{ ...ellipsis, ...(stacked ? { flex: 1 } : { width: '38%', flexShrink: 0 }), fontSize: 'var(--fs-md)', fontWeight: 500, color: tone === 'failed' ? 'var(--term-danger-text)' : ended ? 'var(--term-mid)' : 'var(--term-fg)' }}>
      {title}
    </span>
  );
  const what = (kind || summary) ? (
    <>
      {/* The type stays whole beside the summary; on a phone's line it may give way. */}
      {kind && <span style={{ ...ellipsis, flexShrink: 0, ...(stacked ? { maxWidth: '60%' } : null), fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>{kind}</span>}
      {kind && summary && <span aria-hidden style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>·</span>}
      <RowSummary summary={summary} />
    </>
  ) : null;
  const word = TONE_WORD[tone];
  const state = word ? <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{word}</span> : null;
  const time = (
    <span style={{ flexShrink: 0, minWidth: 34, textAlign: 'right', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>
      <SubagentDuration subagent={subagent} active={active} />
    </span>
  );
  return (
    <div data-testid="background-subagent-row" data-background-work-key={rowKey} data-subagent-id={subagent.sessionId} data-active={active ? 'true' : undefined} data-stacked={stacked ? 'true' : undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? subagentDetailDomId(subagent) : undefined}
        aria-label={`${title}, ${SUBAGENT_TONE_LABEL[tone]}${summary ? `: ${summary.text}` : ''}`}
        onClick={() => onToggle(rowKey)}
        className="t-hover-bg-alt"
        style={{
          display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: stacked ? 3 : BAND_ROW.gap,
          width: '100%', minWidth: 0, boxSizing: 'border-box', margin: 0, border: 0, borderRadius: 'var(--ui-radius)',
          padding: stacked ? `8px ${BAND_ROW.padRight}px 8px 8px` : `6px ${BAND_ROW.padRight}px 6px 8px`,
          background: 'transparent', color: 'var(--term-fg)', font: 'inherit', fontFamily: 'var(--ui-font)', textAlign: 'left', cursor: 'pointer',
        }}
      >
        {stacked ? (
          <>
            <span data-row-line="" style={rowLine}>{glyph}{nameText}{state}{time}</span>
            {what && <span data-row-line="" style={{ ...rowLine, gap: 6, paddingLeft: BAND_ROW.textIndent, boxSizing: 'border-box' }}>{what}</span>}
          </>
        ) : (
          <>{glyph}{nameText}<span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>{what}</span>{state}{time}</>
        )}
      </button>
      {expanded && <SubagentDetail subagent={subagent} active={active} style={{ margin: `0 ${BAND_ROW.detailInset}px 12px` }} />}
    </div>
  );
});

function counts(items: readonly BackgroundSubagentItem[]): { running: number; failed: number } {
  return {
    running: items.filter((item) => item.active).length,
    failed: items.filter((item) => subagentTone(item.subagent, item.active) === 'failed').length,
  };
}

/** The Finished band folds as the drawer's workflows do (useFinishedFold); closing either band collapses the row it hides. */
export function SubagentCard({ items, keyOf, folded, foldKey, listKey, openFolds, onSetFold, expandedKey, onToggle }: {
  items: readonly BackgroundSubagentItem[];
  keyOf: (item: BackgroundSubagentItem) => string;
  /** Item keys behind the Finished band (foldedItems). */
  folded: ReadonlySet<string>;
  /** The Finished band's key in `openFolds`: there while it is open. */
  foldKey: string;
  /** The list band's key in `openFolds`: there while the user has it closed. */
  listKey: string;
  openFolds: ReadonlySet<string>;
  onSetFold: (key: string, open: boolean) => void;
  expandedKey: string | null;
  onToggle: (key: string) => void;
}) {
  const stacked = usePhoneLayout();
  const listId = useId();
  const finishedId = useId();
  const { inline, tucked, folds, open: finishedOpen, toggle: toggleFinished } = useFinishedFold({
    items, keyOf, folded, foldKey, foldOpen: openFolds.has(foldKey), onSetFold, expandedKey, onToggle,
  });
  const listOpen = !openFolds.has(listKey);
  const rows = (entries: typeof inline) => entries.map(({ item, key }) => (
    <SubagentWorkRow key={key} subagent={item.subagent} active={item.active} rowKey={key} expanded={expandedKey === key} onToggle={onToggle} />
  ));
  const shown = inline.map(({ item }) => item);
  const listed = counts(shown);
  const finished = tucked.map(({ item }) => item);
  const finishedFailed = counts(finished).failed;
  return (
    <article data-testid="background-subagent-card" className="background-subagent-card" style={WORK_CARD}>
      {inline.length > 0 && (
        <section>
          <Band
            title="Subagents"
            items={shown}
            count={{ text: listed.running > 0 ? `${listed.running} running` : `${shown.length}`, failed: listed.failed }}
            label={`Subagents, ${listed.running > 0 ? `${listed.running} running` : `${shown.length}`}${listed.failed > 0 ? `, ${listed.failed} failed` : ''}`}
            open={listOpen}
            controls={listId}
            onClick={() => {
              // Closing the band hides its rows: collapse the expanded one among them.
              if (listOpen && expandedKey && inline.some(({ key }) => key === expandedKey)) onToggle(expandedKey);
              onSetFold(listKey, listOpen);
            }}
            testId="background-subagent-band"
            stacked={stacked}
            done={listed.running === 0}
          />
          {listOpen && <div id={listId} style={{ padding: '4px 8px 6px' }}>{rows(inline)}</div>}
        </section>
      )}
      {folds && (
        <section style={inline.length > 0 ? { borderTop: '1px solid var(--term-line)' } : undefined}>
          <Band
            title="Finished"
            items={finished}
            count={{ text: `${finished.length}`, failed: finishedFailed }}
            label={`${finished.length} finished subagents${finishedFailed > 0 ? `, ${finishedFailed} failed` : ''}`}
            open={finishedOpen}
            controls={finishedId}
            onClick={toggleFinished}
            testId="background-work-fold"
            stacked={stacked}
            done
          />
          {finishedOpen && <div id={finishedId} style={{ padding: '4px 8px 6px' }}>{rows(tucked)}</div>}
        </section>
      )}
    </article>
  );
}
