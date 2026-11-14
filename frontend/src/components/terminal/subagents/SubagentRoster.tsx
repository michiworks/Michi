import React, { useId } from 'react';
import type { SubagentInfo } from '../../../state/chatTypes';
import { formatDurationMs, isFailedStatus, isRunningStatus, subagentStatusLabel } from '../toolCallGrouping';
import { openBackgroundWork, useBackgroundWorkNodeId } from '../backgroundWork/backgroundWorkEvents';
import { useConversationSubagent, useSubagentToneCounts } from '../backgroundWork/useConversationSubagent';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import { FadeOnChange, GlyphSwap } from '../agentBlockMotion';
import {
  SUBAGENT_TONE_COLOR,
  SUBAGENT_TONE_LABEL,
  shownSubagent,
  subagentDisplayName,
  subagentDurationMs,
  subagentShownDurationMs,
  subagentSummary,
  subagentToolStatus,
  subagentTone,
  type SubagentSummaryTone,
  type SubagentTone,
} from './subagentPresentation';
// MessageSubagents takes the line chrome's classes.
import '../AgentLineBlocks.css';

const MONO = 'var(--font-mono)';

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * Running → breathing dot, failed → red ×, otherwise a muted dot. A change
 * of kind cross-scales.
 */
export function SubagentStatusGlyph({ status }: { status: string | undefined }) {
  const failed = isFailedStatus(status);
  const running = isRunningStatus(status);
  return (
    <GlyphSwap glyph={failed ? 'failed' : running ? 'running' : 'done'} style={{ width: 8, ...(failed ? null : { alignSelf: 'center' }) }}>
      {failed ? (
        <span aria-hidden style={{ color: 'var(--term-danger)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>
      ) : (
        <span aria-hidden className={running ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} />
      )}
    </GlyphSwap>
  );
}

/**
 * Status word in the tone color, plus how long it took. Nothing while it
 * still runs: a background agent's recorded end is its launch turn's, not
 * its own. `active` is the conversation's view (subagentTone). A new word,
 * and the duration once it appears, fade in.
 */
export function SubagentToneLabel({ subagent, active, fontSize = 'var(--fs-xs)' }: { subagent: SubagentInfo; active?: boolean; fontSize?: string }) {
  const tone = subagentTone(subagent, active);
  const duration = tone === 'running' || tone === 'background'
    ? undefined
    : active === undefined ? subagentDurationMs(subagent) : subagentShownDurationMs(subagent, active, Date.now());
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, flexShrink: 0, fontSize }}>
      <FadeOnChange k={tone} style={{ color: SUBAGENT_TONE_COLOR[tone] }}>{SUBAGENT_TONE_LABEL[tone]}</FadeOnChange>
      <FadeOnChange k={duration !== undefined ? 'duration' : null} style={{ fontFamily: MONO, color: 'var(--term-muted)' }}>
        {duration !== undefined && formatDurationMs(duration)}
      </FadeOnChange>
    </span>
  );
}

const SUMMARY_COLOR: Record<SubagentSummaryTone, string> = {
  now: 'var(--term-accent)',
  status: 'var(--term-muted)',
  result: 'var(--term-mid)',
  error: 'var(--term-danger)',
  mission: 'var(--term-muted)',
};

/** The 'line' agent-block chrome's type scale: 14px words, 12px mono, error text in --term-danger-text. */
const LINE_SUMMARY_COLOR: Record<SubagentSummaryTone, string> = { ...SUMMARY_COLOR, error: 'var(--term-danger-text)' };

/** "now ❯ Read src/a.ts", the status line, the result's first line or the mission. */
export function SubagentSummaryText({ summary, scale = 'chrome' }: { summary: { tone: SubagentSummaryTone; text: string }; scale?: SubagentLineScale }) {
  const now = summary.tone === 'now';
  const line = scale === 'line';
  return (
    <span
      data-testid="subagent-summary-text"
      data-summary-tone={summary.tone}
      // Mono tool detail is verbatim: no ligatures ("--count", "...").
      className={now ? 'agent-verbatim' : undefined}
      style={{
        ...ellipsis,
        flex: 1,
        fontSize: line ? (now ? 'var(--fs-md)' : 'var(--fs-xl)') : now ? 'var(--fs-xs)' : 'var(--fs-sm)',
        fontFamily: now ? MONO : undefined,
      }}
    >
      {/* The ornament stays out of the transcript line's accessible name; "now" reads. */}
      {now && <span style={{ color: 'var(--term-muted)' }}>now <span aria-hidden="true">❯</span> </span>}
      <span style={{ color: (line ? LINE_SUMMARY_COLOR : SUMMARY_COLOR)[summary.tone] }}>{summary.text}</span>
    </span>
  );
}

export type SubagentLineScale = 'chrome' | 'line';

const lineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 7,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left',
};

const buttonReset: React.CSSProperties = {
  border: 0,
  margin: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

/**
 * One subagent on one line: glyph, name, what it does now (or returned),
 * status. With a roster entry and a conversation to scope to, the whole line
 * opens the Background work drawer on that agent; the transcript itself no
 * longer unfolds task, activity or result.
 *
 * In a conversation the line shows the agent as the conversation knows it,
 * like the drawer: a background agent's launch message reads completed once
 * a later turn brought its completion.
 */
export function SubagentSummaryLine({
  subagent: ownCopy,
  name,
  status: ownStatus,
  fallback,
  glyph,
  nameStyle,
  style,
  scale = 'chrome',
  className,
}: {
  /** The roster entry. Without one there is nothing to open. */
  subagent?: SubagentInfo;
  name: string;
  /** Tool-status vocabulary (a delegation chip's status). */
  status: string | undefined;
  /** Mission from the delegation input when the roster has none. */
  fallback?: string;
  /** Leading glyph; defaults to the status dot (which then moves beside the label). */
  glyph?: React.ReactNode;
  nameStyle?: React.CSSProperties;
  style?: React.CSSProperties;
  /** 'line': the line chrome's 14px scale; status words and error text use their text tokens. */
  scale?: SubagentLineScale;
  className?: string;
}) {
  const nodeId = useBackgroundWorkNodeId();
  const hintId = useId();
  // Another turn holds a copy of this agent too (a newer status, or the
  // launch turn's steps): show the folded copy and its status. With one
  // copy only, the caller's status stands (it knows legacy rosters).
  const conversation = useConversationSubagent(nodeId, ownCopy?.sessionId);
  const shown = shownSubagent(ownCopy, conversation);
  const { subagent, active } = shown;
  const status = shown.folded ? subagentToolStatus(shown.subagent, shown.active) : ownStatus;
  const running = isRunningStatus(status);
  const failed = isFailedStatus(status);
  const summary = subagentSummary(subagent, { running, fallback });
  const line = scale === 'line';
  const statusColor = failed ? (line ? 'var(--term-danger-text)' : 'var(--term-danger)') : running ? 'var(--term-run)' : 'var(--term-muted)';
  const statusLabel = subagentStatusLabel(status);
  const statusSize = line ? 'var(--fs-md)' : 'var(--fs-xs)';
  const nameLook: React.CSSProperties = line
    ? { fontSize: 'var(--fs-xl)', fontWeight: 500, color: failed ? 'var(--term-danger-text)' : 'var(--term-mid)' }
    : { fontSize: 'var(--fs-sm)', fontWeight: 600, color: failed ? 'var(--term-danger-text)' : 'var(--term-fg)' };
  const content = (
    <>
      {glyph ?? <SubagentStatusGlyph status={status} />}
      <span data-subagent-name="" style={{ ...ellipsis, flexShrink: 0, maxWidth: '45%', ...nameLook, ...nameStyle }}>
        {name}
      </span>
      {summary ? <SubagentSummaryText summary={summary} scale={scale} /> : <span style={{ flex: 1 }} />}
      <span style={{ flexShrink: 0, paddingLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {/* A custom leading glyph names the kind; the dot still says the state. */}
        {glyph && <SubagentStatusGlyph status={status} />}
        {subagent && status === subagentToolStatus(subagent, active)
          ? <SubagentToneLabel subagent={subagent} active={active} fontSize={statusSize} />
          : <FadeOnChange k={statusLabel} style={{ fontSize: statusSize, color: statusColor }}>{statusLabel}</FadeOnChange>}
      </span>
    </>
  );
  const look: React.CSSProperties = line ? { ...lineStyle, alignItems: 'center', gap: 8 } : lineStyle;
  if (!subagent || !nodeId) {
    return <div data-testid="subagent-summary" className={className} style={{ ...look, ...style }}>{content}</div>;
  }
  return (
    <button
      type="button"
      data-testid="subagent-summary"
      data-subagent-id={subagent.sessionId}
      aria-haspopup="dialog"
      aria-describedby={hintId}
      title="Show in background work"
      className={className ?? 't-hover-bg-alt'}
      onClick={() => openBackgroundWork({ nodeId, focus: { kind: 'subagent', sessionId: subagent.sessionId } })}
      style={{ ...buttonReset, ...look, ...style }}
    >
      {/* The line's content is its name (what the agent does or returned); the hint is its description. */}
      {content}
      <span id={hintId} hidden>Show in background work</span>
    </button>
  );
}

/**
 * One subagent as a compact row. Used where one delegation owns several
 * agents (Kiro crews, Codex spawns) and for agents no chip claims.
 */
export function SubagentRow({ subagent }: { subagent: SubagentInfo }) {
  return (
    <div data-testid="subagent-row" data-subagent-id={subagent.sessionId} style={{ minWidth: 0 }}>
      <SubagentSummaryLine
        subagent={subagent}
        name={subagentDisplayName(subagent)}
        status={subagentToolStatus(subagent)}
        style={{ padding: '1px 0' }}
      />
    </div>
  );
}

/** The count line's groups, in order: each tone the line counts under one word. */
const COUNT_GROUPS: ReadonlyArray<{ label: string; tones: readonly SubagentTone[]; color?: string }> = [
  // `in background` still runs: its turn ended, its outcome has not landed.
  { label: 'working', tones: ['running', 'background'], color: 'var(--term-run)' },
  { label: 'done', tones: ['completed', 'ended'] },
  { label: 'failed', tones: ['failed'], color: 'var(--term-danger-text)' },
  // Cancelled, or interrupted: no live process tracks it any more.
  { label: 'stopped', tones: ['cancelled'] },
];

/** "1 working", "6 done", "2 stopped": the groups that hold any agent. */
function subagentCountParts(counts: Readonly<Record<SubagentTone, number>>) {
  return COUNT_GROUPS
    .map((group) => ({ ...group, count: group.tones.reduce((sum, tone) => sum + counts[tone], 0) }))
    .filter((group) => group.count > 0);
}

/**
 * Subagents in a message that no tool chip claims, as one line of counts:
 * "✦ Subagents  1 working · 6 done · 2 stopped  Details ›". It takes the line
 * chrome's grid and type (AgentLineBlocks.css), so its words start where a
 * run's words do. The line opens the Background work drawer, which lists each
 * agent; the transcript does not repeat their results.
 */
export function MessageSubagents({ subagents }: { subagents: readonly SubagentInfo[] }) {
  const nodeId = useBackgroundWorkNodeId();
  const hintId = useId();
  const phone = usePhoneLayout();
  // Counted as the drawer's rows show them, not by each copy's own status.
  const counts = useSubagentToneCounts(nodeId, subagents);
  if (subagents.length === 0) return null;
  const parts = subagentCountParts(counts);
  const content = (
    <>
      <span className="agent-line__ico">
        {/* The line chrome's agent glyph (AgentLineBlocks PATHS.agent). */}
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <path d="M8 2.25 9.3 6.7 13.75 8 9.3 9.3 8 13.75 6.7 9.3 2.25 8 6.7 6.7z" />
        </svg>
      </span>
      <span className="agent-line__txt">
        <span className="agent-line__lead"><span className="agent-line__layer">Subagents</span></span>
        {/* A count that changes fades to its new value. */}
        <span className="agent-line__rest">
          <span className="agent-line__layer">
            {parts.map((part, index) => (
              <React.Fragment key={part.label}>
                {index > 0 && <span aria-hidden style={{ margin: '0 8px', color: 'var(--term-faint)' }}>·</span>}
                <FadeOnChange
                  k={`${part.label}:${part.count}`}
                  style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, color: part.color }}
                >
                  {part.label === 'working' && <span aria-hidden className="term-dot-i term-dot-i--run" style={{ alignSelf: 'center' }} />}
                  <span>{part.count}</span> {part.label}
                </FadeOnChange>
              </React.Fragment>
            ))}
          </span>
        </span>
      </span>
    </>
  );
  if (!nodeId) {
    return (
      <section aria-label={`${subagents.length} subagents`} data-testid="message-subagents" className="agent-line-run agent-line-run--roster">
        <div className="agent-line">{content}</div>
      </section>
    );
  }
  return (
    <section aria-label={`${subagents.length} subagents`} className="agent-line-run agent-line-run--roster">
      <button
        type="button"
        data-testid="message-subagents"
        aria-haspopup="dialog"
        aria-describedby={hintId}
        title="Show in background work"
        className="agent-line"
        onClick={() => openBackgroundWork({ nodeId })}
      >
        {content}
        <span aria-hidden className="agent-line__meta">{phone ? null : 'Details'}</span>
        <svg className="agent-line__chev" width={12} height={12} viewBox="0 0 12 12" aria-hidden focusable="false">
          <path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span id={hintId} hidden>Show in background work</span>
      </button>
    </section>
  );
}
