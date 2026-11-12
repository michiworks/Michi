import React, { useId, useMemo, useState } from 'react';
import {
  isWorkflowRunTerminal,
  isWorkflowWorkNode,
  omittedLeafCounts,
  workflowProgress,
  type WorkflowAction,
  type WorkflowApprovalDto,
  type WorkflowNodeDto,
  type WorkflowRunDtoV1,
  type WorkflowRuntime,
} from 'michi-shared';
import MarkdownContent from '../../MarkdownContent';
import { modelDisplayLabel } from '../../../lib/modelLabel';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import { useOptionalWorkflowDomain, useWorkflowRun, useWorkflowRunDetail } from '../../../state/workflowDomain';
import '../workflows/runChip.css';
import './WorkflowWorkCard.css';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import { resultProseVars } from '../resultProseVars';
import { firstPlainLine } from '../subagents/subagentPresentation';
import { formatDurationMs } from '../toolCallGrouping';
import { useNow } from '../../../hooks/useNow';
import { formatClockTime, formatMessageTime } from '../../../lib/messageTime';
import { ACTION_LABEL, RUNTIME_LABEL, RUN_NOUN, WORKFLOW_CHIP, WORKFLOW_NEEDS_YOU_CHIP, formatWorkflowTokens, nodeDurationMs, runNounTitle, workflowApprovalSource, workflowElapsedLabel } from '../workflows/workflowPresentation';
import {
  cardLeafState,
  hasPhaseSteps,
  leafLabel,
  sectionDurationMs,
  sharedModel,
  splitToolLine,
  waitingNodeIds,
  workflowCardLeaves,
  workflowCardSections,
  workflowDisplayName,
  type CardLeafState,
  type CardSection,
} from './workflowCardModel';
import { INNER_RADIUS, SegmentStrip, StateGlyph, WORK_CARD, WORK_CARD_CLASS } from './workCardParts';

/**
 * A workflow run in the Background work drawer, as one card: what it is
 * (name, goal) and what you can do (its controls, an approval it waits on),
 * then who is working. A Claude run lists its agents under its phases, one
 * disclosure each; other runs show one strip and a line of steps, opened by
 * the drawer's expanded state. The run's status is said once, on the chip,
 * the card's one running light: a running agent carries no glyph, so the
 * glyph column only marks what differs (done, failed, waiting, queued).
 * What the agents share (model, run id, start) is said once, in the footer,
 * with the script and the log behind it.
 */

const MONO = 'var(--font-mono)';

/**
 * Rows under a band share its columns: the glyph under the band's number,
 * the text after the band's 12px gap, and figures ending where the band's
 * count ends (the band's caret column, 10px and its gap, stays empty).
 * Rows sit in a list padded 8px, with 8px of their own on the left.
 */
export const BAND_ROW = { gap: 12, textIndent: 22, padRight: 30, detailInset: 30 } as const;
const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const STATE_WORD: Record<CardLeafState, string> = {
  queued: 'queued', running: 'running', paused: 'paused', waiting: 'waiting for approval',
  completed: 'done', failed: 'failed', cancelled: 'stopped', skipped: 'skipped',
};

const button: React.CSSProperties = {
  height: 24, padding: '0 10px', border: '1px solid var(--term-line-s)', borderRadius: 'var(--ui-radius)',
  background: 'transparent', color: 'var(--term-mid)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)',
  cursor: 'pointer', whiteSpace: 'nowrap',
};
const quietButton: React.CSSProperties = { border: 0, padding: 0, background: 'transparent', font: 'inherit', cursor: 'pointer' };
/** Text shown as written: the run's script, an agent's JSON result. */
const codePanel: React.CSSProperties = {
  margin: 0, maxHeight: 320, overflow: 'auto', border: '1px solid var(--term-line)', borderRadius: 'var(--ui-radius)', background: 'var(--term-alt)', padding: '8px 10px',
  fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, color: 'var(--term-mid)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontVariantLigatures: 'none',
};

function domId(runId: string, nodeId: string): string {
  return `bw-node-${`${runId}-${nodeId}`.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** A section's key: its container's id, or its place among the loose leaves. */
function sectionKey(section: CardSection, index: number): string {
  return section.node?.id ?? `loose:${index}`;
}

function sectionDomId(runId: string, key: string): string {
  return domId(runId, `section-${key}`);
}

/** The run's full copy, while something the bulk snapshot may trim is shown. */
export function FullRun({ identity }: { identity: AgentResourceIdentity }) {
  useWorkflowRunDetail(identity);
  return null;
}

function StatusChip({ run, now }: { run: WorkflowRunDtoV1; now: number }) {
  const waits = (run.approvals?.length ?? 0) > 0;
  const chip = waits ? WORKFLOW_NEEDS_YOU_CHIP : WORKFLOW_CHIP[run.status];
  return (
    <span data-testid="background-workflow-status" className="run-chip" style={{ background: chip.fill, color: chip.color }}>
      {run.status === 'running' && <span aria-hidden className={waits ? 'term-dot-i' : 'term-dot-i term-dot-i--run'} />}
      {run.status === 'completed' && <span aria-hidden>✓</span>}
      {run.status === 'failed' && <span aria-hidden>×</span>}
      {chip.label}
      <span className="run-chip__time">{workflowElapsedLabel(run, now)}</span>
    </span>
  );
}

/** One segment per agent. `fixed` keeps each segment one width, so the bar's length is the phase's size. */
function Segments({ leaves, waiting, fixed = false }: { leaves: readonly WorkflowNodeDto[]; waiting: ReadonlySet<string>; fixed?: boolean }) {
  const segments = leaves.map((leaf) => {
    const state = cardLeafState(leaf, waiting);
    return { key: leaf.id, state, title: `${leaf.title} · ${STATE_WORD[state]}` };
  });
  return <SegmentStrip segments={segments} fixed={fixed} />;
}

/**
 * How far a phase is: queued, done/total and its time, or once over its
 * failures and its time. A phase that ended clean says done in its number
 * column (a ✓), so its text is only the time; its label still says done.
 */
function phaseProgress(run: WorkflowRunDtoV1, section: CardSection, now: number): { text: string; label: string; color: string; clean: boolean; total: number } {
  // Agents the run left out of its node list still count.
  const omitted = section.node ? omittedLeafCounts(run, section.node.id) : {};
  const total = section.leaves.length + Object.values(omitted).reduce((sum, count) => sum + count, 0);
  const done = section.leaves.filter((leaf) => leaf.status === 'completed').length + (omitted.completed ?? 0);
  const failed = section.leaves.filter((leaf) => leaf.status === 'failed').length + (omitted.failed ?? 0);
  const duration = sectionDurationMs(section.leaves, now);
  const elapsed = duration !== undefined ? formatDurationMs(duration) : undefined;
  if (section.state === 'queued') return { text: 'queued', label: 'queued', color: 'var(--term-muted)', clean: false, total };
  if (section.state === 'done') {
    const text = failed ? `${failed} failed · ${elapsed ?? 'done'}` : elapsed ?? 'done';
    return { text, label: failed || !elapsed ? text : `done · ${elapsed}`, color: failed ? 'var(--term-danger-text)' : 'var(--term-digest)', clean: !failed, total };
  }
  const text = `${done}/${total}${elapsed ? ` · ${elapsed}` : ''}`;
  return { text, label: text, color: failed ? 'var(--term-danger-text)' : 'var(--term-mid)', clean: false, total };
}

/** Agent names share one column width: the longest, within bounds. */
function agentNameWidth(sections: readonly CardSection[]): string {
  const longest = Math.max(4, ...sections.flatMap((section) => section.leaves.map((leaf) => leafLabel(leaf, section.node).length)));
  return `min(${Math.min(longest, 24) + 1}ch, 38%)`;
}

/**
 * Claude phases as bands over their agents, one disclosure each: number,
 * name, one segment per agent, how far. The band takes the code block
 * header's recipe (a faint foreground tint, a hairline under it when open),
 * not --term-alt, which marks hover and selection. An open phase lists its
 * agents under its band; a closed one is its band alone, failures included.
 * The number column lines up with the agents' glyph column.
 */
function PhaseGroups({ id, run, sections, waiting, isOpen, onTogglePhase, openNodes, onToggleNode, model, now, stacked }: {
  id: string;
  run: WorkflowRunDtoV1;
  sections: readonly CardSection[];
  waiting: ReadonlySet<string>;
  isOpen: (section: CardSection, key: string) => boolean;
  onTogglePhase: (section: CardSection, index: number) => void;
  openNodes: ReadonlySet<string>;
  onToggleNode: (nodeId: string) => void;
  model?: string;
  now: number;
  stacked: boolean;
}) {
  const nameWidth = agentNameWidth(sections);
  return (
    <div id={id} data-testid="background-workflow-agents">
      {sections.map((section, index) => {
        const key = sectionKey(section, index);
        const open = isOpen(section, key);
        const title = section.node?.title ?? `Phase ${index + 1}`;
        const progress = phaseProgress(run, section, now);
        const listId = `${sectionDomId(run.id, key)}-agents`;
        const hasAgents = section.leaves.length > 0;
        // A phase's one agent named as the phase ("Judge", "judge"): its band already says who and how long.
        const nameless = progress.total === 1 && section.leaves.length === 1 && leafLabel(section.leaves[0], section.node).toLowerCase() === title.trim().toLowerCase();
        const head = (
          <>
            <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: progress.clean ? 'var(--term-digest)' : 'var(--term-faint)', textAlign: 'center' }}>{progress.clean ? '✓' : index + 1}</span>
            <span style={{ ...ellipsis, fontSize: 'var(--fs-md)', fontWeight: section.state === 'queued' ? 500 : 600, color: section.state === 'running' ? 'var(--term-fg)' : section.state === 'done' ? 'var(--term-mid)' : 'var(--term-muted)' }}>{title}</span>
            {hasAgents && section.state !== 'queued' ? <Segments leaves={section.leaves} waiting={waiting} fixed /> : <span />}
            <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: progress.color, whiteSpace: 'nowrap', textAlign: 'right' }}>{progress.text}</span>
          </>
        );
        const band: React.CSSProperties = {
          display: 'grid', gridTemplateColumns: '10px fit-content(42%) minmax(24px, 1fr) auto 10px', alignItems: 'center', columnGap: 12,
          width: '100%', minWidth: 0, minHeight: stacked ? 44 : 36, padding: '0 16px', border: 0, borderBottom: open ? '1px solid var(--term-line)' : 0,
          borderRadius: 0, color: 'inherit', font: 'inherit', textAlign: 'left',
        };
        return (
          <section key={key} id={sectionDomId(run.id, key)} data-testid="background-workflow-section" style={{ borderTop: '1px solid var(--term-line)' }}>
            {hasAgents ? (
              <button type="button" data-testid="background-workflow-phase" data-phase-state={section.state} aria-expanded={open} aria-controls={open ? listId : undefined}
                aria-label={`${title}, ${progress.label}`} onClick={() => onTogglePhase(section, index)} className="workflow-phase-band" style={band}>
                {head}
                <span aria-hidden style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-faint)', textAlign: 'right' }}>{open ? '▾' : '▸'}</span>
              </button>
            ) : (
              <div data-testid="background-workflow-phase" data-phase-state={section.state} className="workflow-phase-band" style={band}>{head}</div>
            )}
            {open && (
              <ul id={listId} style={{ listStyle: 'none', margin: 0, padding: '4px 8px 6px' }}>
                {section.leaves.map((leaf) => (
                  <LeafRow key={leaf.id} runId={run.id} runtime={run.runtime} node={leaf} section={section.node} state={cardLeafState(leaf, waiting)} open={openNodes.has(leaf.id)}
                    onToggle={onToggleNode} model={model} now={now} nameWidth={nameWidth} stacked={stacked} nameless={nameless} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Runs without phases (Kiro steps): one strip and a count. */
function ProgressStrip({ run, leaves, waiting }: { run: WorkflowRunDtoV1; leaves: readonly WorkflowNodeDto[]; waiting: ReadonlySet<string> }) {
  const progress = workflowProgress(run);
  if (progress.total === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 6, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
        <span>{progress.done}/{progress.total} {RUN_NOUN[run.runtime]}</span>
        {progress.failed > 0 && <span style={{ color: 'var(--term-danger-text)' }}>· {progress.failed} failed</span>}
      </div>
      <Segments leaves={leaves} waiting={waiting} />
    </div>
  );
}

function optionButton(kind: string | undefined, primary: boolean): React.CSSProperties {
  if (kind?.startsWith('reject')) return { ...button, borderColor: 'transparent', color: 'var(--term-muted)' };
  if (primary) return { ...button, borderColor: 'var(--term-select)', background: 'color-mix(in srgb, var(--term-select) 20%, transparent)', color: 'var(--term-fg)', fontWeight: 600 };
  return button;
}

function CardApproval({ run, approval, busy, onAnswer }: { run: WorkflowRunDtoV1; approval: WorkflowApprovalDto; busy: boolean; onAnswer?: (approvalId: string, optionId: string) => void }) {
  const source = workflowApprovalSource(run, approval);
  return (
    <div role="group" aria-label={`Approval needed: ${approval.title}`} data-testid="workflow-approval" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 500, color: 'var(--term-fg)', overflowWrap: 'anywhere' }}>{approval.title}</span>
        {source.label && (
          <span title={source.title} style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', flexShrink: 0 }}>{source.label}</span>
        )}
      </div>
      {approval.detail && (
        <pre className="term-scrollbar" style={{ margin: 0, maxHeight: 140, overflow: 'auto', padding: '5px 8px', borderRadius: 'var(--ui-radius)', background: 'color-mix(in srgb, var(--term-bg) 55%, transparent)', fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, color: 'var(--term-mid)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {approval.detail}
        </pre>
      )}
      {onAnswer && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {approval.options.map((option, index) => (
            <button key={option.optionId} type="button" disabled={busy} className="t-hover-bg-alt" onClick={() => onAnswer(approval.id, option.optionId)}
              style={{ ...optionButton(option.kind, index === 0), opacity: busy ? 0.6 : 1 }}>
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A tool name as a small label, its argument in quiet mono. */
export function ToolLine({ line, stacked = false }: { line: string; stacked?: boolean }) {
  const { tool, arg } = splitToolLine(line);
  return (
    <span style={{ display: 'flex', alignItems: stacked ? 'flex-start' : 'center', flexDirection: stacked ? 'column' : 'row', gap: stacked ? 3 : 6, minWidth: 0, flex: 1 }}>
      {tool && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', lineHeight: '16px', padding: '0 5px', borderRadius: 'var(--ui-radius-sm)', background: 'var(--term-alt)', color: 'var(--term-mid)' }}>{tool}</span>}
      {tool && arg && ' '}
      {arg && <span style={{ ...ellipsis, maxWidth: '100%', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{arg}</span>}
    </span>
  );
}

/** JSON text indented by its brackets, so a value cut off mid-way still reads as a tree. */
function indentJson(text: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => `\n${'  '.repeat(depth)}`;
  for (const char of text) {
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '{' || char === '[') {
      depth += 1;
      out += char + newline();
    } else if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      out = /[{[]\n\s*$/.test(out) ? out.replace(/\n\s*$/, '') + char : out + newline() + char;
    } else if (char === ',') {
      out += char + newline();
    } else if (char === ':') {
      out += ': ';
    } else if (!/\s/.test(char)) {
      out += char;
    }
  }
  return out;
}

/**
 * A result an agent returned as JSON (a schema's output), indented to read.
 * Claude sends a preview of each agent's result, so it is often cut short.
 * Undefined for prose.
 */
function jsonResult(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : undefined;
  } catch {
    return /^(?:\{\s*"|\[\s*[{["])/.test(trimmed) ? indentJson(trimmed) : undefined;
  }
}

function leafSummary(node: WorkflowNodeDto, state: CardLeafState): { text: string; color: string } | { tool: string } | undefined {
  if (state === 'waiting') return { text: 'Waiting for your approval', color: 'var(--term-select)' };
  if (state === 'running' || state === 'paused') {
    if (node.currentTool) return { tool: node.currentTool };
    return node.statusMessage ? { text: node.statusMessage, color: 'var(--term-mid)' } : undefined;
  }
  if (state === 'failed') {
    const error = firstPlainLine(node.error) ?? node.statusMessage;
    return error ? { text: error, color: 'var(--term-danger-text)' } : undefined;
  }
  if (state === 'completed') {
    // A JSON result's first line is braces and keys: it shows in the detail only.
    const result = (jsonResult(node.result) === undefined ? firstPlainLine(node.result) : undefined) ?? node.statusMessage;
    return result ? { text: result, color: 'var(--term-mid)' } : undefined;
  }
  if (state === 'cancelled') return { text: 'Stopped', color: 'var(--term-muted)' };
  return { text: state === 'skipped' ? 'Skipped' : 'Queued', color: 'var(--term-faint)' };
}

function LeafDetail({ id, node, runtime, model, now }: { id: string; node: WorkflowNodeDto; runtime: WorkflowRuntime; model?: string; now: number }) {
  const duration = nodeDurationMs(node, now);
  const json = jsonResult(node.result);
  const meta = [
    node.agentName && node.agentName !== node.title ? node.agentName : undefined,
    node.model && node.model !== model ? modelDisplayLabel(runtime, node.model, []) : undefined,
    node.iteration !== undefined ? `iteration ${node.iteration}` : undefined,
    node.attempt !== undefined && node.attempt > 1 ? `attempt ${node.attempt}` : undefined,
    node.toolCount ? `${node.toolCount} ${node.toolCount === 1 ? 'tool' : 'tools'}` : undefined,
    formatWorkflowTokens(node.usage?.totalTokens),
    duration !== undefined ? formatDurationMs(duration) : undefined,
  ].filter(Boolean);
  // Each label over its content, all of it starting where the row's name starts.
  let first = true;
  const row = (label: string, value: React.ReactNode, color?: string) => {
    const top = first ? 4 : 10;
    first = false;
    return (
      <>
        {label && <dt style={{ margin: `${top}px 0 3px`, fontSize: 'var(--fs-xs)', color: color ?? 'var(--term-muted)' }}>{label}</dt>}
        <dd style={{ margin: label ? 0 : `${top}px 0 0`, minWidth: 0, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--term-mid)' }}>{value}</dd>
      </>
    );
  };
  const running = node.status === 'running' || node.status === 'paused';
  return (
    <dl id={id} data-testid="workflow-node-detail" style={{ margin: `0 ${BAND_ROW.detailInset}px 10px`, padding: 0 }}>
      {node.prompt && row('Task', <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{node.prompt}</span>)}
      {running && node.currentTool && row('Now', <code style={{ display: 'block', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-fg)', background: 'var(--term-alt)', padding: '5px 8px', borderRadius: 'var(--ui-radius)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{node.currentTool}</code>)}
      {node.statusMessage && !(running && !node.currentTool) && row('Status', node.statusMessage)}
      {node.error && row('Error', <pre style={{ margin: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--term-danger-text)' }}>{node.error}</pre>, 'var(--term-danger-text)')}
      {node.result && row('Result', json !== undefined
        ? <pre className="term-scrollbar" style={codePanel}>{json}</pre>
        : <MarkdownContent text={node.result} size="sm" style={{ ...resultProseVars, fontSize: 'var(--fs-md)', lineHeight: 1.55 }} />)}
      {meta.length > 0 && row('', <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{meta.join(' · ')}</span>)}
    </dl>
  );
}

function LeafRow({ runId, runtime, node, section, state, open, onToggle, model, now, nameWidth, stacked, nameless = false }: {
  runId: string;
  runtime: WorkflowRuntime;
  node: WorkflowNodeDto;
  section?: WorkflowNodeDto;
  state: CardLeafState;
  open: boolean;
  onToggle: (nodeId: string) => void;
  model?: string;
  now: number;
  nameWidth: string;
  stacked: boolean;
  /** The band says this agent's name and time: the row is its line alone. */
  nameless?: boolean;
}) {
  const label = leafLabel(node, section);
  const summary = leafSummary(node, state);
  const id = domId(runId, node.id);
  // Every row's figure is its time, live while it runs; tokens are in the detail.
  const duration = state === 'queued' || state === 'skipped' ? undefined : nodeDurationMs(node, now);
  const tail = duration !== undefined ? formatDurationMs(duration) : undefined;
  // With no line to show, the row keeps its name.
  const bare = nameless && summary !== undefined;
  const summaryText = summary && ('tool' in summary ? summary.tool : summary.text);
  const summaryNode = summary === undefined ? <span style={{ flex: 1 }} />
    : 'tool' in summary ? <ToolLine line={summary.tool} />
      : <span style={{ ...ellipsis, flex: 1, fontSize: 'var(--fs-sm)', color: summary.color }}>{summary.text}</span>;
  const name = (
    <span style={{ ...ellipsis, ...(stacked ? { flex: 1 } : { width: nameWidth, flexShrink: 0 }), fontSize: 'var(--fs-md)', fontWeight: 500, color: state === 'failed' ? 'var(--term-danger-text)' : state === 'completed' ? 'var(--term-mid)' : state === 'queued' || state === 'skipped' || state === 'cancelled' ? 'var(--term-muted)' : 'var(--term-fg)' }}>{label}</span>
  );
  const tailNode = <span style={{ flexShrink: 0, minWidth: 34, textAlign: 'right', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>{tail}</span>;
  return (
    <li data-testid="workflow-node" data-node-id={node.id} data-node-status={state} style={{ listStyle: 'none', minWidth: 0 }}>
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={`${label}, ${STATE_WORD[state]}${summaryText ? `: ${summaryText}` : ''}`}
        onClick={() => onToggle(node.id)} className="t-hover-bg-alt"
        style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: stacked ? 3 : BAND_ROW.gap, width: '100%', minWidth: 0, padding: stacked ? `8px ${BAND_ROW.padRight}px 8px 8px` : `6px ${BAND_ROW.padRight}px 6px 8px`, border: 0, borderRadius: 'var(--ui-radius)', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
        {bare ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: BAND_ROW.gap, minWidth: 0, flex: 1 }}><StateGlyph state={state} />{summaryNode}</span>
        ) : stacked ? (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: BAND_ROW.gap, minWidth: 0 }}><StateGlyph state={state} />{name}{tailNode}</span>
            <span style={{ display: 'flex', minWidth: 0, paddingLeft: BAND_ROW.textIndent }}>{summaryNode}</span>
          </>
        ) : (
          <><StateGlyph state={state} />{name}{summaryNode}{tailNode}</>
        )}
      </button>
      {open && <LeafDetail id={id} node={node} runtime={runtime} model={model} now={now} />}
    </li>
  );
}

const subheadStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 8px 2px', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' };

/**
 * A run without phases (Kiro steps), one line per step, by section: the
 * running one listed, finished ones folded (their failures stay out),
 * future ones one line.
 */
function AgentsZone({ run, sections, waiting, openNodes, onToggleNode, openSections, onToggleSection, model, now, stacked }: {
  run: WorkflowRunDtoV1;
  sections: readonly CardSection[];
  waiting: ReadonlySet<string>;
  openNodes: ReadonlySet<string>;
  onToggleNode: (nodeId: string) => void;
  openSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  model?: string;
  now: number;
  stacked: boolean;
}) {
  const nameWidth = agentNameWidth(sections);
  const rows = (section: CardSection, leaves: readonly WorkflowNodeDto[]) => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {leaves.map((leaf) => (
        <LeafRow key={leaf.id} runId={run.id} runtime={run.runtime} node={leaf} section={section.node} state={cardLeafState(leaf, waiting)} open={openNodes.has(leaf.id)}
          onToggle={onToggleNode} model={model} now={now} nameWidth={nameWidth} stacked={stacked} />
      ))}
    </ul>
  );
  if (sections.length === 0) {
    return <div style={{ padding: '6px 8px', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{isWorkflowRunTerminal(run.status) ? 'The runtime reported no steps for this workflow.' : 'Waiting for the first step…'}</div>;
  }
  return (
    <>
      {sections.map((section, index) => {
        const key = sectionKey(section, index);
        const id = sectionDomId(run.id, key);
        if (!section.node) return <React.Fragment key={key}>{rows(section, section.leaves)}</React.Fragment>;
        if (section.leaves.length === 0) {
          return (
            <div key={key} id={id} data-testid="background-workflow-section" style={{ ...subheadStyle, alignItems: 'center', gap: BAND_ROW.gap, padding: '7px 8px 5px' }}>
              <StateGlyph state={section.state === 'done' ? 'completed' : section.state === 'running' ? 'running' : 'queued'} />
              <span><span style={{ fontWeight: 600, color: 'var(--term-mid)' }}>{section.node.title}</span> · {section.state === 'queued' ? 'starts when the previous phase finishes' : section.state}</span>
            </div>
          );
        }
        if (section.state === 'done') {
          const failed = section.leaves.filter((leaf) => leaf.status === 'failed');
          const rest = section.leaves.filter((leaf) => leaf.status !== 'failed');
          const open = openSections.has(key);
          const duration = sectionDurationMs(section.leaves, now);
          return (
            <div key={key} id={id} data-testid="background-workflow-section">
              {rest.length > 0 && (
                <button type="button" aria-expanded={open} onClick={() => onToggleSection(key)} className="t-hover-bg-alt"
                  style={{ display: 'flex', alignItems: 'center', gap: BAND_ROW.gap, width: '100%', padding: '6px 8px', border: 0, borderRadius: 'var(--ui-radius)', background: 'transparent', color: 'var(--term-muted)', font: 'inherit', fontSize: 'var(--fs-sm)', textAlign: 'left', cursor: 'pointer' }}>
                  <StateGlyph state="completed" />
                  <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--term-mid)' }}>{section.node.title}</span>
                  <span>{rest.length} done{duration !== undefined ? ` · ${formatDurationMs(duration)}` : ''}</span>
                  <span aria-hidden style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>{open ? '▾' : '▸'}</span>
                </button>
              )}
              {open && rows(section, rest)}
              {failed.length > 0 && rows(section, failed)}
            </div>
          );
        }
        return (
          <div key={key} id={id} data-testid="background-workflow-section">
            <div style={subheadStyle}><span style={{ fontWeight: 600, color: 'var(--term-mid)' }}>{section.node.title}</span></div>
            {rows(section, section.leaves)}
          </div>
        );
      })}
    </>
  );
}

/** The agents line's summary: counts by state; with one agent at work, what it does. */
function zoneSummary(run: WorkflowRunDtoV1, sections: readonly CardSection[], waiting: ReadonlySet<string>): React.ReactNode {
  const leaves = sections.flatMap((section) => section.leaves).filter(isWorkflowWorkNode);
  const states = leaves.map((leaf) => cardLeafState(leaf, waiting));
  const count = (state: CardLeafState) => states.filter((value) => value === state).length;
  if (isWorkflowRunTerminal(run.status)) {
    const omitted = omittedLeafCounts(run);
    const total = leaves.length + Object.values(omitted).reduce((sum, value) => sum + value, 0);
    const failed = count('failed') + (omitted.failed ?? 0);
    return <>{total} finished{failed > 0 && <span style={{ color: 'var(--term-danger-text)' }}> · {failed} failed</span>}</>;
  }
  const running = leaves.filter((leaf, index) => states[index] === 'running');
  const parts: React.ReactNode[] = [];
  if (running.length > 0) parts.push(<span key="r">{running.length} working</span>);
  if (count('waiting') > 0) parts.push(<span key="w" style={{ color: 'var(--term-select)' }}>{count('waiting')} waiting</span>);
  if (count('failed') > 0) parts.push(<span key="f" style={{ color: 'var(--term-danger-text)' }}>{count('failed')} failed</span>);
  if (parts.length === 0) parts.push(<span key="q">{count('queued') > 0 ? `${count('queued')} queued` : 'none yet'}</span>);
  const [only] = running;
  if (running.length === 1 && only.currentTool) {
    const section = sections.find((entry) => entry.leaves.includes(only))?.node;
    parts.push(<span key="n" style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)' }}>{leafLabel(only, section)}: {only.currentTool}</span>);
  }
  return parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`s${index}`} aria-hidden> · </span>, part]));
}

export const WorkflowWorkCard = React.memo(function WorkflowWorkCard({ runKey, rowKey, expanded, onToggle }: {
  runKey: string;
  rowKey: string;
  /** The agent lines are open (the drawer's one expanded item). */
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const { resource, pending, error } = useWorkflowRun(runKey);
  const domain = useOptionalWorkflowDomain();
  const stacked = usePhoneLayout();
  const zoneId = useId();
  const run = resource?.value;
  const live = !!run && !isWorkflowRunTerminal(run.status);
  const now = useNow(1_000, live);
  const [openNodes, setOpenNodes] = useState<ReadonlySet<string>>(() => new Set((run?.nodes ?? []).filter((node) => node.status === 'failed' && node.error).map((node) => node.id)));
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set());
  /** Phases the user opened (true) or closed (false); the others follow their state. */
  const [phaseChoices, setPhaseChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [panel, setPanel] = useState<'script' | 'log' | null>(null);
  const [fullResult, setFullResult] = useState(false);
  const nodes = run?.nodes;
  const sections = useMemo(() => workflowCardSections(nodes ?? []), [nodes]);
  const leaves = useMemo(() => workflowCardLeaves(nodes ?? []), [nodes]);
  if (!resource || !run) return null;

  const identity = { backendConnectionId: resource.backendConnectionId, id: run.id };
  const onAction = domain ? (action: WorkflowAction) => { void domain.act(identity, action); } : undefined;
  const onAnswer = domain ? (approvalId: string, optionId: string) => { void domain.answer(identity, approvalId, optionId); } : undefined;
  const waiting = waitingNodeIds(run);
  const phased = hasPhaseSteps(sections);
  const model = sharedModel(leaves);
  const failed = live ? leaves.filter((leaf) => leaf.status === 'failed') : [];
  const approvals = run.approvals ?? [];
  const tokens = formatWorkflowTokens(run.usage?.totalTokens);
  const displayName = workflowDisplayName(run.name);
  const toggleSet = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const onToggleNode = (nodeId: string) => setOpenNodes((current) => toggleSet(current, nodeId));
  /** The failure line's View: open the card and the phase the agent failed in, the agent's detail open. */
  const showFailure = (node: WorkflowNodeDto) => {
    if (!expanded) onToggle(rowKey);
    const at = sections.findIndex((section) => section.leaves.includes(node));
    if (phased && at >= 0) setPhaseChoices((current) => new Map(expanded ? current : []).set(sectionKey(sections[at], at), true));
    setOpenNodes((current) => new Set(current).add(node.id));
    requestAnimationFrame(() => document.getElementById(domId(run.id, node.id))?.closest('li')?.scrollIntoView?.({ block: 'nearest' }));
  };
  /** A phase with agents is open while the card is: the running one unless closed, any other once opened. */
  const phaseOpenIn = (choices: ReadonlyMap<string, boolean>, section: CardSection, key: string) =>
    section.leaves.length > 0 && (choices.get(key) ?? section.state === 'running');
  const isPhaseOpen = (section: CardSection, key: string) => expanded && phaseOpenIn(phaseChoices, section, key);
  /**
   * A phase's header: on a closed card, open the card on that phase alone;
   * on an open one, toggle the phase, and close the card with its last open phase.
   */
  const togglePhase = (section: CardSection, index: number) => {
    const key = sectionKey(section, index);
    if (!expanded) {
      onToggle(rowKey);
      setPhaseChoices(new Map(sections.map((entry, at) => [sectionKey(entry, at), at === index])));
      requestAnimationFrame(() => document.getElementById(sectionDomId(run.id, key))?.scrollIntoView?.({ block: 'nearest' }));
      return;
    }
    const next = new Map(phaseChoices).set(key, !isPhaseOpen(section, key));
    if (sections.some((entry, at) => phaseOpenIn(next, entry, sectionKey(entry, at)))) {
      setPhaseChoices(next);
      return;
    }
    onToggle(rowKey);
    setPhaseChoices(new Map());
  };
  const longResult = (run.result?.length ?? 0) > 700;
  const footerLink = (target: 'script' | 'log', label: string) => (
    <button type="button" aria-expanded={panel === target} onClick={() => setPanel((current) => (current === target ? null : target))} className="t-hover-fg"
      style={{ ...quietButton, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-mid)', textDecoration: 'underline', textDecorationColor: 'var(--term-line-s)', textUnderlineOffset: 2 }}>
      {label}
    </button>
  );

  return (
    <article
      data-testid="background-workflow-row"
      data-background-work-key={rowKey}
      data-run-key={runKey}
      data-active={live ? 'true' : undefined}
      aria-label={`Workflow ${run.name}, ${approvals.length > 0 ? 'needs approval' : WORKFLOW_CHIP[run.status].label.toLowerCase()}`}
      className={WORK_CARD_CLASS}
      style={WORK_CARD}
    >
      {(expanded || panel !== null) && <FullRun identity={identity} />}
      <div style={{ padding: '14px 16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', minWidth: 0 }}>
            <span aria-hidden style={{ color: 'var(--term-mauve)', fontSize: 'var(--fs-xs)' }}>⧉</span>
            <span style={ellipsis}>Workflow · {RUNTIME_LABEL[run.runtime]}</span>
          </span>
          <StatusChip run={run} now={now} />
        </div>
        <h3 data-testid="background-workflow-title" title={run.name} style={{ margin: '7px 0 0', fontSize: 'calc(var(--fs-xl) + 1px)', fontWeight: 600, lineHeight: 1.3, color: 'var(--term-fg)', overflowWrap: 'anywhere' }}>{displayName}</h3>
        {run.description && run.description !== run.name && (
          <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-md)', lineHeight: 1.55, color: 'var(--term-mid)' }}>{run.description}</p>
        )}
        {run.statusDetail && run.status !== 'running' && (
          <p style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: run.status === 'failed' ? 'var(--term-danger-text)' : run.status === 'paused' ? 'var(--term-select)' : 'var(--term-muted)' }}>{run.statusDetail}</p>
        )}
        {error && <p role="alert" style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--term-danger-text)' }}>{error}</p>}
        {approvals.length > 0 && (
          <div data-testid="workflow-approvals" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', borderRadius: INNER_RADIUS, border: '1px solid color-mix(in srgb, var(--term-select) 45%, transparent)', background: 'color-mix(in srgb, var(--term-select-f) 70%, transparent)' }}>
            <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--term-select)' }}>Needs your approval</div>
            {approvals.map((approval) => <CardApproval key={approval.id} run={run} approval={approval} busy={pending === 'answer'} onAnswer={onAnswer} />)}
          </div>
        )}
        {failed.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: INNER_RADIUS, background: 'color-mix(in srgb, var(--term-danger) 11%, transparent)', fontSize: 'var(--fs-sm)', minWidth: 0 }}>
            <span style={{ flexShrink: 0, fontWeight: 600, color: 'var(--term-danger-text)' }}>× {failed.length} {failed.length === 1 ? 'agent' : 'agents'} failed</span>
            <span style={{ ...ellipsis, color: 'var(--term-mid)' }}>{leafLabel(failed[0], sections.find((section) => section.leaves.includes(failed[0]))?.node)}{firstPlainLine(failed[0].error) ? ` · ${firstPlainLine(failed[0].error)}` : ''}</span>
            <button type="button" onClick={() => showFailure(failed[0])} className="t-hover-fg" style={{ ...quietButton, marginLeft: 'auto', flexShrink: 0, color: 'var(--term-fg)', fontSize: 'var(--fs-sm)', textDecoration: 'underline', textUnderlineOffset: 2 }}>View</button>
          </div>
        )}
        {run.result && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: INNER_RADIUS, border: '1px solid color-mix(in srgb, var(--term-digest) 30%, var(--term-line))', background: 'var(--term-surface)' }}>
            <div data-testid="workflow-result" style={longResult && !fullResult ? { maxHeight: 220, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, #000 75%, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000 75%, transparent)' } : undefined}>
              <MarkdownContent text={run.result} size="sm" style={{ ...resultProseVars, fontSize: 'var(--fs-lg)', lineHeight: 1.55 }} />
            </div>
            {longResult && (
              <button type="button" onClick={() => setFullResult((value) => !value)} className="t-hover-fg" style={{ ...quietButton, marginTop: 6, fontSize: 'var(--fs-sm)', color: 'var(--term-mid)' }}>
                {fullResult ? 'Show less' : 'Show full result'}
              </button>
            )}
          </div>
        )}
        {!phased && <ProgressStrip run={run} leaves={leaves} waiting={waiting} />}
        {(onAction && run.actions.length > 0) || tokens || run.usage?.toolUses ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, minWidth: 0 }}>
            {onAction && run.actions.map((action) => (
              <button key={action} type="button" disabled={!!pending} onClick={() => onAction(action)} aria-label={`${ACTION_LABEL[action]} workflow ${run.name}`} className="t-hover-bg-alt"
                style={{ ...button, opacity: pending && pending !== action ? 0.5 : 1 }}>
                {pending === action ? `${ACTION_LABEL[action]}…` : ACTION_LABEL[action]}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', whiteSpace: 'nowrap' }}>
              {[tokens, run.usage?.toolUses ? `${run.usage.toolUses} tools` : undefined].filter(Boolean).join(' · ')}
            </span>
          </div>
        ) : null}
      </div>

      {phased ? (
        <PhaseGroups id={zoneId} run={run} sections={sections} waiting={waiting} isOpen={isPhaseOpen} onTogglePhase={togglePhase}
          openNodes={openNodes} onToggleNode={onToggleNode} model={model} now={now} stacked={stacked} />
      ) : (
        <div style={{ borderTop: '1px solid var(--term-line)' }}>
          <button type="button" aria-expanded={expanded} aria-controls={expanded ? zoneId : undefined} onClick={() => onToggle(rowKey)} className="t-hover-bg-alt"
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', minWidth: 0, padding: '9px 16px', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
            <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--term-fg)' }}>{runNounTitle(run.runtime)}</span>
            <span style={{ ...ellipsis, fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{zoneSummary(run, sections, waiting)}</span>
            <span aria-hidden style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>{expanded ? '▾' : '▸'}</span>
          </button>
          {expanded && (
            <div id={zoneId} data-testid="background-workflow-agents" style={{ padding: '0 8px 8px' }}>
              <AgentsZone run={run} sections={sections} waiting={waiting} openNodes={openNodes} onToggleNode={onToggleNode}
                openSections={openSections} onToggleSection={(key) => setOpenSections((current) => toggleSet(current, key))} model={model} now={now} stacked={stacked} />
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 6px', padding: '9px 16px', borderTop: '1px solid var(--term-line)', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', minWidth: 0 }}>
        {model && (<><span>{modelDisplayLabel(run.runtime, model, [])}</span><span aria-hidden style={{ color: 'var(--term-faint)' }}>·</span></>)}
        <span>{run.nativeId}</span>
        <span aria-hidden style={{ color: 'var(--term-faint)' }}>·</span>
        <span>started {formatMessageTime(run.startedAt, new Date(now))}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10 }}>
          {run.definition && footerLink('script', run.runtime === 'claude' ? 'Script' : 'Inputs')}
          {run.log.length > 0 && footerLink('log', `Log ${run.log.length}`)}
        </span>
      </div>
      {panel === 'script' && run.definition && (
        <pre data-testid="workflow-definition" className="term-scrollbar" style={{ ...codePanel, margin: '0 16px 14px' }}>
          {run.definition}
        </pre>
      )}
      {panel === 'log' && run.log.length > 0 && (
        <ol aria-label="Workflow messages" style={{ margin: '0 16px 14px', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {run.log.map((entry, index) => (
            <li key={`${entry.at}-${index}`} style={{ listStyle: 'none', display: 'flex', gap: 8, fontSize: 'var(--fs-sm)', lineHeight: 1.45, minWidth: 0 }}>
              <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)', flexShrink: 0 }}>
                {formatClockTime(entry.at)}
              </span>
              {entry.nodeId && <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', flexShrink: 0 }}>{entry.nodeId}</span>}
              <span style={{ color: entry.severity === 'error' ? 'var(--term-danger-text)' : entry.severity === 'warning' ? 'var(--term-select)' : 'var(--term-mid)', overflowWrap: 'anywhere' }}>{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
});
