import React, { useId } from 'react';
import type { SubagentInfo } from '../../../state/chatTypes';
import { formatDurationMs, isFailedStatus, isRunningStatus, subagentStatusLabel } from '../toolCallGrouping';
import { openBackgroundWork, useBackgroundWorkNodeId } from '../backgroundWork/backgroundWorkEvents';
import { useConversationSubagent, useSubagentToneCounts } from '../backgroundWork/useConversationSubagent';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import { FadeOnChange, GlyphSwap } from '../agentBlockMotion';
import { ChevronRightIcon, CloseIcon, SubagentIcon } from '../icons';
import { StateGlyph } from '../backgroundWork/workCardParts';
import {
  SUBAGENT_TONE_COLOR,
  SUBAGENT_TONE_LABEL,
  shownSubagent,
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
 * Running → breathing dot, failed → red ×, completed → Background work's
 * green ✓, otherwise (stopped, ended, in background) a quiet dot. Without a
 * `tone`, a finished status reads completed, as its word does. A change of
 * kind cross-scales.
 */
export function SubagentStatusGlyph({ status, tone }: { status: string | undefined; tone?: SubagentTone }) {
  const failed = isFailedStatus(status);
  const running = isRunningStatus(status);
  const completed = !failed && !running && (tone === undefined || tone === 'completed');
  return (
    <GlyphSwap glyph={failed ? 'failed' : running ? 'running' : completed ? 'completed' : 'done'} style={{ width: 8, ...(failed ? null : { alignSelf: 'center' }) }}>
      {failed ? (
        <CloseIcon size={8} style={{ color: 'var(--term-danger)' }} />
      ) : completed ? (
        <StateGlyph state="completed" />
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
  error: 'var(--term-danger-text)',
  mission: 'var(--term-muted)',
};

/** "now ❯ Read src/a.ts", the status line, the result's first line or the mission. */
export function SubagentSummaryText({ summary }: { summary: { tone: SubagentSummaryTone; text: string } }) {
  const now = summary.tone === 'now';
  return (
    <span
      data-testid="subagent-summary-text"
      data-summary-tone={summary.tone}
      // Mono tool detail is verbatim: no ligatures ("--count", "...").
      className={now ? 'agent-verbatim' : undefined}
      style={{
        ...ellipsis,
        flex: 1,
        fontSize: now ? 'var(--fs-md)' : 'var(--fs-xl)',
        fontFamily: now ? MONO : undefined,
      }}
    >
      {/* The ornament stays out of the transcript line's accessible name; "now" reads. */}
      {now && <span style={{ color: 'var(--term-muted)' }}>now <span aria-hidden="true">❯</span> </span>}
      <span style={{ color: SUMMARY_COLOR[summary.tone] }}>{summary.text}</span>
    </span>
  );
}

const lineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left',
};

/** No fill or ink: the button's class (.agent-line) owns both, hover included. */
const buttonReset: React.CSSProperties = {
  border: 0,
  margin: 0,
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
  style,
  className,
}: {
  /** The roster entry. Without one there is nothing to open. */
  subagent?: SubagentInfo;
  name: string;
  /** Tool-status vocabulary (a delegation chip's status). */
  status: string | undefined;
  /** Mission from the delegation input when the roster has none. */
  fallback?: string;
  /** Leading glyph naming the kind; the status dot sits beside the label. */
  glyph: React.ReactNode;
  style?: React.CSSProperties;
  className: string;
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
  // The agent's own tone when the line shows it, else the status word alone.
  const tone = subagent && status === subagentToolStatus(subagent, active) ? subagentTone(subagent, active) : undefined;
  const summary = subagentSummary(subagent, { running, fallback });
  const statusColor = failed ? 'var(--term-danger-text)' : running ? 'var(--term-run)' : 'var(--term-digest)';
  const statusLabel = subagentStatusLabel(status);
  const statusSize = 'var(--fs-md)';
  const nameLook: React.CSSProperties = { fontSize: 'var(--fs-xl)', fontWeight: 500, color: failed ? 'var(--term-danger-text)' : 'var(--term-mid)' };
  const content = (
    <>
      {glyph}
      <span data-subagent-name="" style={{ ...ellipsis, flexShrink: 0, maxWidth: '45%', ...nameLook }}>
        {name}
      </span>
      {summary ? <SubagentSummaryText summary={summary} /> : <span style={{ flex: 1 }} />}
      <span style={{ flexShrink: 0, paddingLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {/* The leading glyph names the kind; the dot says the state. */}
        <SubagentStatusGlyph status={status} tone={tone} />
        {subagent && tone
          ? <SubagentToneLabel subagent={subagent} active={active} fontSize={statusSize} />
          : <FadeOnChange k={statusLabel} style={{ fontSize: statusSize, color: statusColor }}>{statusLabel}</FadeOnChange>}
      </span>
    </>
  );
  if (!subagent || !nodeId) {
    return <div data-testid="subagent-summary" className={className} style={{ ...lineStyle, ...style }}>{content}</div>;
  }
  return (
    <button
      type="button"
      data-testid="subagent-summary"
      data-subagent-id={subagent.sessionId}
      aria-haspopup="dialog"
      aria-describedby={hintId}
      title="Show in background work"
      className={className}
      onClick={() => openBackgroundWork({ nodeId, focus: { kind: 'subagent', sessionId: subagent.sessionId } })}
      style={{ ...buttonReset, ...lineStyle, ...style }}
    >
      {/* The line's content is its name (what the agent does or returned); the hint is its description. */}
      {content}
      <span id={hintId} hidden>Show in background work</span>
    </button>
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
 * The conversation's inline roster (inlineSubagentRoster) as one line of
 * counts: "Subagents  1 working · 6 done · 2 stopped  Details ›". It takes
 * the line chrome's grid and type (AgentLineBlocks.css), so its words start
 * where a run's words do. The line opens the Background work drawer on
 * these agents, which lists each; the transcript does not repeat their
 * results.
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
        {/* The line chrome's glyph for a delegation (AgentLineBlocks ICONS.agent). */}
        <SubagentIcon size="lg" />
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
        onClick={() => openBackgroundWork({ nodeId, subagentIds: subagents.map((subagent) => subagent.sessionId) })}
      >
        {content}
        <span aria-hidden className="agent-line__meta">{phone ? null : 'Details'}</span>
        <ChevronRightIcon size="sm" className="agent-line__chev" />
        <span id={hintId} hidden>Show in background work</span>
      </button>
    </section>
  );
}
