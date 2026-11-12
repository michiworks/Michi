import React, { useState } from 'react';
import { formatTokenCount } from 'michi-shared';
import type { SubagentActivity, SubagentInfo } from '../../../state/chatTypes';
import MarkdownContent from '../../MarkdownContent';
import { resultProseVars } from '../resultProseVars';
import { formatDurationMs, isFailedStatus, isRunningStatus } from '../toolCallGrouping';
import {
  subagentToolCount,
  subagentTone,
} from './subagentPresentation';

/**
 * The expanded body of a subagent in the Background work drawer, opened in
 * place under its row: what it was asked (task), what it did (steps), what
 * it returned (result / error) and what it cost.
 *
 * It follows a workflow agent's detail: no box and no fill, each label above
 * its content, every line starting where the row's name starts. Its length
 * is on the row, on the row's one clock, so the detail does not repeat it.
 */

const MONO = 'var(--font-mono)';
const ACTIVITY_PREVIEW = 12;
const TASK_PREVIEW_CHARS = 600;

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const textButtonStyle: React.CSSProperties = {
  border: 0,
  padding: 0,
  background: 'transparent',
  color: 'var(--term-muted)',
  font: 'inherit',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationColor: 'var(--term-line-s)',
  textUnderlineOffset: 2,
};

/** A label over its content; the first one sits close to the row. */
function Section({ label, tone, first, children }: { label: string; tone?: string; first: boolean; children: React.ReactNode }) {
  return (
    <>
      <div style={{ margin: first ? '4px 0 3px' : '10px 0 3px', fontSize: 'var(--fs-xs)', color: tone ?? 'var(--term-muted)' }}>{label}</div>
      <div style={{ minWidth: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--term-mid)' }}>{children}</div>
    </>
  );
}

/** A tool as a small label and its argument in quiet mono, like the row's summary. */
function StepLine({ item, now }: { item: SubagentActivity; now: boolean }) {
  if (item.kind === 'message') {
    return <span style={{ ...ellipsis, flex: 1, color: 'var(--term-mid)' }}>{item.title}</span>;
  }
  const tool = item.toolKind || item.title.split(/\s+/)[0] || 'tool';
  const arg = item.detail && item.detail !== item.title ? item.detail : item.title.slice(tool.length).trim();
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', lineHeight: '16px', padding: '0 5px', borderRadius: 'var(--ui-radius-sm)', background: 'var(--term-alt)', color: 'var(--term-mid)' }}>{tool}</span>
      {arg && <span style={{ ...ellipsis, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: now ? 'var(--term-fg)' : 'var(--term-muted)', fontVariantLigatures: 'none' }}>{arg}</span>}
    </span>
  );
}

function ActivityRow({ item, running }: { item: SubagentActivity; running: boolean }) {
  const [open, setOpen] = useState(false);
  const hasOutput = item.kind === 'tool' && !!item.output;
  const failed = isFailedStatus(item.status) || item.status === 'interrupted';
  // The step at work while the agent runs: said by its place and "now", not a light.
  const now = running && item.kind === 'tool' && isRunningStatus(item.status);
  const duration = item.startedAt !== undefined && item.endedAt !== undefined && item.endedAt >= item.startedAt
    ? item.endedAt - item.startedAt
    : undefined;
  return (
    <li data-testid="subagent-activity-row" data-activity-kind={item.kind} style={{ listStyle: 'none', minWidth: 0 }}>
      <div
        role={hasOutput ? 'button' : undefined}
        tabIndex={hasOutput ? 0 : undefined}
        aria-expanded={hasOutput ? open : undefined}
        onClick={hasOutput ? () => setOpen((value) => !value) : undefined}
        onKeyDown={hasOutput ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value); }
        } : undefined}
        className={hasOutput ? 't-hover-fg' : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20, minWidth: 0, cursor: hasOutput ? 'pointer' : 'default' }}
      >
        {failed && <span aria-hidden style={{ width: 8, flexShrink: 0, color: 'var(--term-danger)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>}
        {item.kind === 'message' && <span aria-hidden style={{ width: 8, flexShrink: 0, color: 'var(--term-faint)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>›</span>}
        <StepLine item={item} now={now} />
        {(now || duration !== undefined) && (
          <span style={{ flexShrink: 0, paddingLeft: 8, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: now ? 'var(--term-fg)' : 'var(--term-faint)' }}>
            {now ? 'now' : formatDurationMs(duration!)}
          </span>
        )}
        {hasOutput && <span aria-hidden style={{ flexShrink: 0, fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)' }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && hasOutput && (
        <pre
          className="term-scrollbar"
          style={{
            margin: '3px 0 5px',
            padding: '5px 8px',
            maxHeight: 220,
            overflowY: 'auto',
            borderRadius: 'var(--ui-radius)',
            background: 'var(--term-alt)',
            fontFamily: MONO,
            fontSize: 'var(--fs-xs)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: failed ? 'var(--term-danger-text)' : 'var(--term-mid)',
            fontVariantLigatures: 'none',
          }}
        >
          {item.output}
        </pre>
      )}
    </li>
  );
}

function ActivityList({ subagent, running }: { subagent: SubagentInfo; running: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const activity = subagent.activity ?? [];
  const hidden = showAll ? 0 : Math.max(0, activity.length - ACTIVITY_PREVIEW);
  const visible = hidden > 0 ? activity.slice(hidden) : activity;
  const dropped = subagent.activityDropped ?? 0;
  return (
    <>
      {(hidden > 0 || dropped > 0) && (
        <div style={{ marginBottom: 2, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
          {hidden > 0 ? (
            <button type="button" className="t-hover-fg" style={textButtonStyle} onClick={() => setShowAll(true)}>
              Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
            </button>
          ) : (
            <span>{dropped} earlier {dropped === 1 ? 'step' : 'steps'} not kept</span>
          )}
        </div>
      )}
      <ol aria-label="Subagent activity" style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visible.map((item) => <ActivityRow key={item.id} item={item} running={running} />)}
      </ol>
    </>
  );
}

function TaskText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TASK_PREVIEW_CHARS;
  const shown = expanded || !long ? text : `${text.slice(0, TASK_PREVIEW_CHARS).trimEnd()}…`;
  return (
    <>
      <div data-testid="subagent-task" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shown}</div>
      {long && (
        <button type="button" className="t-hover-fg" style={{ ...textButtonStyle, marginTop: 3 }} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show full task'}
        </button>
      )}
    </>
  );
}

/** What it cost and what ran it; its length is on the row. */
function MetaLine({ subagent }: { subagent: SubagentInfo }) {
  const tools = subagentToolCount(subagent);
  const parts = [
    subagent.model,
    subagent.usage?.totalTokens !== undefined ? `${formatTokenCount(subagent.usage.totalTokens)} tokens` : undefined,
    tools > 0 ? `${tools} ${tools === 1 ? 'tool' : 'tools'}` : undefined,
    subagent.source,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div data-testid="subagent-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
      {parts.map((part, index) => (
        <React.Fragment key={`${part}-${index}`}>
          {index > 0 && <span aria-hidden>·</span>}
          <span>{part}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

/** Stable DOM id tying a Background work row to the detail it expands. */
export function subagentDetailDomId(subagent: SubagentInfo): string {
  return `subagent-detail-${subagent.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function SubagentDetail({ subagent, active, style }: {
  subagent: SubagentInfo;
  /**
   * Whether the conversation counts it as running (isSubagentRunningIn). A
   * `working` entry it does not count shows no live step; without it,
   * `working` is taken at its word.
   */
  active?: boolean;
  /** Placement under the row (its margins line the text up with the row's name). */
  style?: React.CSSProperties;
}) {
  const activityCount = (subagent.activity?.length ?? 0) + (subagent.activityDropped ?? 0);
  const running = subagent.status === 'working' && active !== false;
  // Reads "stopped" (SUBAGENT_TONE_LABEL), so its error is a reason, not a failure.
  const stopped = subagentTone(subagent, active) === 'cancelled';
  const sections: Array<{ label: string; tone?: string; body: React.ReactNode }> = [];
  if (subagent.prompt) sections.push({ label: 'Task', body: <TaskText text={subagent.prompt} /> });
  if (activityCount > 0) sections.push({ label: 'Steps', body: <ActivityList subagent={subagent} running={running} /> });
  if (subagent.error) {
    sections.push({
      label: stopped ? 'Why it stopped' : 'Error',
      tone: stopped ? undefined : 'var(--term-danger-text)',
      body: (
        <pre
          data-testid="subagent-error"
          data-error-tone={stopped ? 'stopped' : 'error'}
          style={{ margin: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: stopped ? 'var(--term-mid)' : 'var(--term-danger-text)' }}
        >
          {subagent.error}
        </pre>
      ),
    });
  }
  if (subagent.result) {
    sections.push({
      label: 'Result',
      body: (
        <div data-testid="subagent-result">
          {/* Typography has no prose-xs; the wrapper size scales its em-based children. */}
          <MarkdownContent text={subagent.result} size="sm" style={{ ...resultProseVars, fontSize: 'var(--fs-md)', lineHeight: 1.55 }} />
        </div>
      ),
    });
  }
  const note = subagent.background && subagent.status !== 'working' && !subagent.outcome
    ? { text: 'Still running after this turn ended. Its result arrives with a later reply.', color: 'var(--term-mid)' }
    : sections.length === 0 && !subagent.background
      ? { text: running ? 'Waiting for the first step…' : 'The runtime reported no detail for this subagent.', color: 'var(--term-muted)' }
      : undefined;
  return (
    <div id={subagentDetailDomId(subagent)} data-testid="subagent-detail" style={{ fontFamily: 'var(--ui-font)', minWidth: 0, ...style }}>
      {sections.map((section, index) => (
        <Section key={section.label} label={section.label} tone={section.tone} first={index === 0}>{section.body}</Section>
      ))}
      {note && <div style={{ marginTop: sections.length ? 10 : 4, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: note.color }}>{note.text}</div>}
      <MetaLine subagent={subagent} />
    </div>
  );
}
