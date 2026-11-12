import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { motion, useReducedMotionConfig } from 'motion/react';
import type { SubagentInfo, ToolCallState } from '../../state/chatTypes';
import { backendNow } from '../../services/backendClock';
import {
  delegationToolInfo,
  findRecoveries,
  formatDurationMs,
  formatElapsedMs,
  formatToolPayload,
  isDenied,
  isFailedStatus,
  isRunningStatus,
  isStoppedStatus,
  isTerminalStatus,
  spokenDurationMs,
  stepDetail,
  stepName,
  stepView,
  summarizeOutcome,
  summarizeWork,
  capPhrases,
  sentenceOf,
  type OutcomePhrase,
  thoughtConclusion,
  thoughtPreview,
  toolKind,
  payloadSubject,
  type PayloadSubject,
  toolDisplayTitle,
  toolDurationMs,
  toolErrorLine,
  toolExitCode,
  toolOutcomeIcon,
  toolRecord,
  toolSpanMs,
  type OutcomeIcon,
  type SubagentToolInfo,
} from './toolCallGrouping';
import { LineDrawerBody, LineFlash, LineGlyphSwap, LineSwap, useLineDrawer } from './agentBlockMotion';
import { SubagentSummaryLine } from './subagents/SubagentRoster';
import { delegationName, delegationStatus, ownGroupTools, subagentDisplayName, subagentToolStatus, subagentsForTool } from './subagents/subagentPresentation';
import { DUR } from '../../motion/tokens';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import './AgentLineBlocks.css';

/**
 * The 'line' agent-block chrome (W2 · outcome-first, "Same Box"). Every thought,
 * call and run of calls is ONE 28px native disclosure button, live and settled:
 * a hanging icon, a lead that says what came of the run, the rest of the record
 * in muted, a failure fragment, a tabular duration and a chevron. The box never
 * changes shape; only its words do (toolCallGrouping: summarizeOutcome and the
 * phrase helpers). Opening it shows step rows (each a button that opens its
 * payload well) with the thought prose between them.
 *
 * ToolCallGroup and TermThoughtBlock dispatch here for agentBlockStyle 'line';
 * grouping and clustering are theirs and unchanged.
 */

/** A spinner appears only once a run has lasted this long, then spins until the run ends. */
const SPINNER_DELAY_MS = 200;
/** Each live label stays at least this long. */
const LABEL_DWELL_MS = 400;
/** The thought preview changes at most this often. */
const THOUGHT_DWELL_MS = 600;
/** A gap between steps longer than this reads "Working…". */
const GAP_MS = 600;

/* ── Turn context: recoveries across groups, and the backend clock key ── */

export interface AgentTurnInfo {
  /** Failed call id → the later call that recovered it (findRecoveries). */
  recovered: ReadonlyMap<string, string>;
  /** Backend clock key (the assistant message id) for live timers. */
  clockKey?: string;
}

export const AgentTurnContext = createContext<AgentTurnInfo | null>(null);

const SEP = '\u0000';

/** One stable value per turn: it changes only when a recovery appears or the turn does. */
export function useAgentTurnInfo(tools: readonly ToolCallState[], clockKey?: string): AgentTurnInfo {
  const pairs = useMemo(() => [...findRecoveries(tools)].map(([a, b]) => `${a}${SEP}${b}`).join(SEP + SEP), [tools]);
  return useMemo(() => ({
    recovered: new Map(pairs ? pairs.split(SEP + SEP).map((p) => p.split(SEP) as [string, string]) : []),
    clockKey,
  }), [pairs, clockKey]);
}

/* ── Live timing ── */

/** Re-renders at the earliest future instant (backend clock) while active. */
function useLiveTicker(active: boolean, deadlines: ReadonlyArray<number | undefined>, clockKey?: string): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const now = backendNow(clockKey);
  const future = deadlines.filter((d): d is number => d !== undefined && d > now);
  const next = future.length ? Math.min(...future) : undefined;
  useEffect(() => {
    if (!active || next === undefined) return undefined;
    const id = window.setTimeout(force, Math.max(16, next - backendNow(clockKey) + 4));
    return () => window.clearTimeout(id);
  }, [active, next, clockKey]);
}

/**
 * Age of a live run from its durable start (backend clock), so a remount or a
 * reload resumes the same count; legacy runs without a start count from mount.
 * Ticks on whole seconds, at the spinner delay and at the end of a gap.
 */
function useRunClock(active: boolean, startedAt: number | undefined, clockKey: string | undefined, gapSince?: number) {
  const [mountedAt] = useState(() => backendNow(clockKey));
  const start = startedAt ?? mountedAt;
  const now = backendNow(clockKey);
  const age = Math.max(0, now - start);
  useLiveTicker(active, [
    start + SPINNER_DELAY_MS,
    gapSince === undefined ? undefined : gapSince + GAP_MS,
    start + (Math.floor(age / 1000) + 1) * 1000,
  ], clockKey);
  return { age, now };
}

/** When the gap after `key`'s step began: its durable end, else when it was first seen idle. */
function useGapSince(key: string | null, endedAt: number | undefined, clockKey?: string): number | undefined {
  const [mark, setMark] = useState(() => ({ key, at: backendNow(clockKey) }));
  if (mark.key !== key) setMark({ key, at: backendNow(clockKey) });
  if (key === null) return undefined;
  return endedAt ?? (mark.key === key ? mark.at : backendNow(clockKey));
}

/** Holds a value whose key changed until the previous one has shown for `ms`. */
function useDwell<T>(value: T, key: string, ms: number, enabled: boolean): T {
  const [shown, setShown] = useState(() => ({ key, value, at: Date.now() }));
  const now = Date.now();
  const switchNow = shown.key !== key && (!enabled || now - shown.at >= ms);
  if (switchNow) setShown({ key, value, at: now });
  useEffect(() => {
    if (shown.key === key || !enabled) return undefined;
    const id = window.setTimeout(() => setShown({ key, value, at: Date.now() }), Math.max(0, shown.at + ms - Date.now()));
    return () => window.clearTimeout(id);
  }, [key, value, enabled, ms, shown.key, shown.at]);
  return shown.key === key || switchNow ? value : shown.value;
}

/* ── Glyphs (16px, 1.5 stroke; decorative) ── */

export type LineGlyph = OutcomeIcon | 'spin' | 'steps';

const PATHS: Record<Exclude<LineGlyph, 'spin'>, React.ReactNode> = {
  terminal: <><path d="M3.5 4.75 6.25 7.5 3.5 10.25" /><path d="M8 11h4.5" /></>,
  file: <><path d="M4 2.25h5l3 3v8.5H4z" /><path d="M8.75 2.25v3.25H12" /></>,
  search: <><circle cx="7" cy="7" r="3.75" /><path d="m9.75 9.75 3 3" /></>,
  edit: <path d="M10.5 2.75l2.75 2.75-7.5 7.5-3.25.75.75-3.25z" />,
  sparkle: <path d="M8 2.25 9.3 6.7 13.75 8 9.3 9.3 8 13.75 6.7 9.3 2.25 8 6.7 6.7z" />,
  agent: <path d="M8 2.25 9.3 6.7 13.75 8 9.3 9.3 8 13.75 6.7 9.3 2.25 8 6.7 6.7z" />,
  steps: <><path d="M6.75 4.5h6M6.75 8h6M6.75 11.5h6" /><path d="M3.5 4.5h.25M3.5 8h.25M3.5 11.5h.25" /></>,
  fail: <path d="m4.75 4.75 6.5 6.5M11.25 4.75l-6.5 6.5" />,
  merge: <><circle cx="4.75" cy="4" r="1.75" /><circle cx="11.25" cy="11.25" r="1.75" /><path d="M4.75 14V5.75" /><path d="M4.75 6.25a5 5 0 0 0 4.75 5" /></>,
  push: <><path d="M4.75 5.75 8 2.5l3.25 3.25" /><path d="M8 2.75v7.75" /><path d="M3.75 13.25h8.5" /></>,
  commit: <><circle cx="8" cy="8" r="2.5" /><path d="M1.75 8h3.75M10.5 8h3.75" /></>,
};

function Svg({ size = 16, className, children }: { size?: number; className?: string; children: React.ReactNode }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="agent-line-spin" width={16} height={16} viewBox="0 0 16 16" aria-hidden focusable="false" data-spinner="spinning">
      <g className="agent-line-spin__g">
        <circle cx="8" cy="8" r="5.25" fill="none" stroke="var(--term-line-s)" strokeWidth={1.5} opacity={0.6} />
        <path d="M8 2.75a5.25 5.25 0 0 1 5.25 5.25" fill="none" stroke="var(--term-run)" strokeWidth={1.5} strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Glyph({ name }: { name: LineGlyph }) {
  if (name === 'spin') return <Spinner />;
  const tone = name === 'fail' ? ' is-fail' : name === 'agent' ? ' is-agent' : '';
  return <Svg className={`agent-line__svg${tone}`}>{PATHS[name]}</Svg>;
}

/** The hanging icon slot: kinds scale in and out. */
function LineIcon({ name }: { name: LineGlyph }) {
  return (
    <LineGlyphSwap glyph={name} className="agent-line__ico" layerClassName="agent-line__glyph">
      <Glyph name={name} />
    </LineGlyphSwap>
  );
}

function Chevron() {
  return (
    <svg className="agent-line__chev" width={12} height={12} viewBox="0 0 12 12" aria-hidden focusable="false">
      <g className="agent-line__chev-g"><path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></g>
    </svg>
  );
}

/** A duration for eyes and its spelled-out form for screen readers. */
function Duration({ text, spoken }: { text: string; spoken: string }) {
  return <><span aria-hidden>{text}</span><span className="sr-only">{spoken}</span></>;
}

const settledDuration = (ms: number) => ({ text: formatDurationMs(ms), spoken: spokenDurationMs(ms) });
const liveDuration = (ms: number) => ({ text: formatElapsedMs(ms), spoken: spokenDurationMs(ms, true) });

/* ── The row ── */

type RestKind = 'record' | 'error' | 'cmd' | 'thought';

interface LineView {
  icon: LineGlyph;
  lead: string;
  /** Lead content when it differs from `lead` (a spoken duration inside it). */
  leadNode?: React.ReactNode;
  rest?: string;
  restKind?: RestKind;
  frag?: { tone: 'danger' | 'calm'; text: string; more?: string } | null;
  meta?: { text: string; spoken: string } | null;
  /** Settled summary: one muted sentence fitted to the line by whole phrases. */
  sentence?: { phrases: OutcomePhrase[]; dropped: number; full: string };
}

/**
 * A run's settled sentence, fitted to its line: phrases that don't fit are
 * dropped whole (lowest rank first, see capPhrases) and counted into "+N",
 * never cut mid-word. Measured once per width change, never per token. The
 * accessible name is every phrase.
 */
function FitSentence({ phrases, dropped, full }: { phrases: readonly OutcomePhrase[]; dropped: number; full: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(() => ({ text: sentenceOf(phrases), extra: dropped }));
  // The summary is rebuilt each render; refit only when its words change.
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;
  const key = phrases.map((p) => `${p.rank}:${p.join ?? ''}:${p.text}`).join('\u0000');
  useLayoutEffect(() => {
    const phrases = phrasesRef.current;
    const el = ref.current;
    const probe = measureRef.current;
    const host = el?.closest('.agent-line__lead') as HTMLElement | null;
    if (!el || !probe || !host) return undefined;
    const fit = () => {
      const avail = host.clientWidth;
      let kept = [...phrases];
      let extra = dropped;
      let text = sentenceOf(kept);
      const width = (t: string, n: number) => { probe.textContent = n > 0 ? `${t}\u00A0+${n}` : t; return probe.getBoundingClientRect().width; };
      // jsdom and hidden panes report 0: leave the capped sentence as is.
      if (avail > 0) {
        while (kept.length > 1 && width(text, extra) > avail) {
          kept = capPhrases(kept, kept.length - 1).kept;
          extra += 1;
          text = sentenceOf(kept);
        }
        const short = kept.length === 1 ? kept[0].short : undefined;
        if (short && width(text, extra) > avail) text = short;
      }
      probe.textContent = '';
      setShown((prev) => (prev.text === text && prev.extra === extra ? prev : { text, extra }));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [key, dropped]);
  return (
    <span ref={ref} className="agent-line__sentence" title={full}>
      {/* If even one phrase is too wide it ellipsizes; "+N" never does. */}
      <span aria-hidden className="agent-line__fit">{shown.text}</span>
      {shown.extra > 0 && <span aria-hidden className="agent-line__plus">{`\u00A0+${shown.extra}`}</span>}
      <span className="sr-only">{full}</span>
      <span ref={measureRef} className="agent-line__measure" aria-hidden />
    </span>
  );
}

/**
 * One 28px line: a native button when it toggles something (aria-expanded,
 * aria-controls), a plain row when there is nothing to open. A step row's
 * command or error describes it rather than naming it.
 */
function LineRow({ view, live, step, expanded, controls, onToggle, groupHeader }: {
  view: LineView;
  live: boolean;
  step?: boolean;
  expanded?: boolean;
  controls?: string;
  onToggle?: () => void;
  groupHeader?: boolean;
}) {
  const restId = useId();
  const restKind = view.restKind ?? 'record';
  const verbatim = restKind === 'cmd' || restKind === 'error';
  const content = (
    <>
      <LineFlash on={view.icon === 'fail'} className="agent-line__flash" />
      <LineIcon name={view.icon} />
      <span className="agent-line__txt">
        <LineSwap k={view.lead} className={`agent-line__lead${view.sentence ? ' is-sentence' : ''}`} layerClassName="agent-line__layer">
          {view.sentence ? <FitSentence {...view.sentence} /> : view.leadNode ?? view.lead}
        </LineSwap>
        {/* Keyed by the lead too: when the lead changes width the rest dips
            (out in place, back at its new place) instead of sliding. */}
        <LineSwap
          rest
          k={view.rest ? `${restKind}|${view.lead}|${view.rest}` : null}
          id={restId}
          ariaHidden={step}
          className={`agent-line__rest is-${restKind}${view.rest ? '' : ' is-empty'}`}
          layerClassName={`agent-line__layer${verbatim ? ' agent-verbatim' : ''}`}
          translate={verbatim ? 'no' : undefined}
        >
          {view.rest}
        </LineSwap>
      </span>
      {view.frag ? (
        <LineSwap k={`${view.frag.tone}|${view.frag.text}`} className={`agent-line__frag is-${view.frag.tone}`} layerClassName="agent-line__frag-i">
          <Svg size={12} className="agent-line__x">{PATHS.fail}</Svg>
          <span>{view.frag.text}{view.frag.more && <span className="agent-line__more">{view.frag.more}</span>}</span>
        </LineSwap>
      ) : <span className="agent-line__frag" />}
      {/* Ticks never animate: whole seconds, tabular. */}
      <span className="agent-line__meta">{view.meta && <Duration text={view.meta.text} spoken={view.meta.spoken} />}</span>
      {onToggle ? <Chevron /> : <span />}
    </>
  );
  const className = `agent-line${step ? ' agent-line--step' : ''}`;
  if (!onToggle) {
    return <div className={className} data-live={live ? '' : undefined}>{content}</div>;
  }
  return (
    <button
      type="button"
      className={className}
      data-live={live ? '' : undefined}
      data-toolgroup-header={groupHeader ? '' : undefined}
      aria-expanded={!!expanded}
      aria-controls={controls}
      aria-describedby={step && view.rest ? restId : undefined}
      onClick={onToggle}
    >
      {content}
    </button>
  );
}

/* ── Payload well ── */

function CopyButton({ text, label }: { text: string; label: string }) {
  const { result, status, copy } = useCopyFeedback();
  return (
    <>
      <button type="button" className="agent-line-icon-btn" aria-label={label} onClick={() => { void copy(text); }}>
        {result === 'copied'
          ? <Svg size={14}><path d="m3.5 8.25 3 3 6-6.75" /></Svg>
          : <Svg size={14}><rect x="5.5" y="5.5" width="7.25" height="7.25" rx="1.25" /><path d="M3.25 10.5V3.25h7.25" /></Svg>}
      </button>
      {/* An honest result, said once. */}
      <span className="sr-only" role="status">{status}</span>
    </>
  );
}

/** Scrollable output is a focusable, named region; short output adds no tab stop. */
function useScrollable(ref: React.RefObject<HTMLElement | null>, content: unknown): boolean {
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setScrollable(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, content]);
  return scrollable;
}

const COPY_LABEL: Record<PayloadSubject['kind'], string> = {
  command: 'Copy command', pattern: 'Copy pattern', path: 'Copy path', detail: 'Copy',
};

/**
 * `$ command` with a copy button, the output in mid on the deep well (a region
 * when it scrolls), and a footer: "× exit 1 · 1m 12s · rerun passed". No caps
 * INPUT/OUTPUT labels; failure is marked in the footer, not by tinting the
 * output. The raw JSON input stays one toggle away.
 */
function LinePayload({ tool, recovered }: { tool: ToolCallState; recovered: boolean }) {
  const running = isRunningStatus(tool.status);
  const failed = isFailedStatus(tool.status);
  const kind = toolKind(tool);
  const subject = payloadSubject(tool);
  const outRef = useRef<HTMLPreElement>(null);
  const scrollable = useScrollable(outRef, tool.output);
  const [rawOpen, setRawOpen] = useState(false);
  const rawId = useId();
  const code = toolExitCode(tool);
  const denied = isDenied(tool);
  const status = running
    ? null
    : denied ? 'denied'
      : isStoppedStatus(tool.status) ? 'stopped'
        : code !== undefined ? `exit ${code}` : failed ? 'failed' : kind === 'edit' || kind === 'write' ? 'applied' : 'done';
  const durMs = toolDurationMs(tool);
  const name = stepName(tool).text;
  return (
    <div className="agent-line-payload" role="group" aria-label={`Details: ${name}`}>
      <div className="agent-line-payload__cmd">
        {subject?.kind === 'command' ? (
          <><span className="agent-line-payload__prompt" aria-hidden>$</span><code className="agent-verbatim" translate="no">{subject.text}</code></>
        ) : subject?.kind === 'pattern' ? (
          <><span className="sr-only">Pattern </span><code className="agent-verbatim" translate="no">“{subject.text}”{subject.within ? `  in ${subject.within}` : ''}</code></>
        ) : subject?.kind === 'path' ? (
          <><span className="sr-only">{kind === 'glob' ? 'Path ' : 'File '}</span><code className="agent-verbatim" translate="no">{subject.text}</code></>
        ) : (
          <code className="agent-verbatim" translate="no">{subject?.text ?? toolDisplayTitle(tool)}</code>
        )}
        {subject && <CopyButton text={subject.text} label={COPY_LABEL[subject.kind]} />}
      </div>
      {running ? (
        <div className="agent-line-payload__wait">Output appears when the call finishes…</div>
      ) : tool.output ? (
        <pre
          ref={outRef}
          className="agent-line-payload__out agent-verbatim"
          translate="no"
          tabIndex={scrollable ? 0 : undefined}
          role={scrollable ? 'region' : undefined}
          aria-label={scrollable ? 'Output' : undefined}
        >
          {formatToolPayload(tool.output)}
        </pre>
      ) : null}
      {tool.inputJson && (
        <pre id={rawId} hidden={!rawOpen} className="agent-line-payload__out agent-line-payload__raw agent-verbatim" translate="no" aria-label="Raw input">
          {rawOpen ? formatToolPayload(tool.inputJson) : null}
        </pre>
      )}
      <div className="agent-line-payload__foot">
        {status && (failed && !denied
          ? <span className="agent-line-payload__bad"><Svg size={12}>{PATHS.fail}</Svg>{status}</span>
          : <span>{status}</span>)}
        {durMs != null && <><span aria-hidden>·</span><span><Duration {...settledDuration(durMs)} /></span></>}
        {failed && recovered && <><span aria-hidden>·</span><span>rerun passed</span></>}
        {tool.inputJson && (
          <button type="button" className="agent-line-link" aria-expanded={rawOpen} aria-controls={rawId} onClick={() => setRawOpen((o) => !o)}>
            Raw input
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Step rows ── */

function stepIcon(tool: ToolCallState, age: number, loud: boolean): LineGlyph {
  if (isRunningStatus(tool.status)) return age < SPINNER_DELAY_MS ? toolOutcomeIcon(tool) : 'spin';
  return loud ? 'fail' : toolOutcomeIcon(tool);
}

/**
 * A call inside an opened run: its name (the agent's words, else Michi's in the
 * base form), what it touched in mono (or the error that replaced it), how it
 * ended ("exit 1", "denied"), its time. A button that opens its payload.
 * Memoised: a streaming update re-renders one row.
 */
/**
 * The step list keeps its height when a payload opens, so a step opened near
 * its bottom edge scrolls the list until the payload shows, never past the
 * step's own row.
 */
function useRevealOpenedStep(open: boolean, bodyRef: React.RefObject<HTMLDivElement | null>) {
  const reduce = !!useReducedMotionConfig();
  const wasOpenRef = useRef(open);
  useLayoutEffect(() => {
    const opened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    const body = bodyRef.current;
    const list = body?.closest<HTMLElement>('.agent-line-steps-scroll');
    const row = body?.parentElement;
    if (!opened || !body || !list || !row) return;
    const view = list.getBoundingClientRect();
    const below = body.getBoundingClientRect().bottom - view.bottom;
    const rowAbove = row.getBoundingClientRect().top - view.top;
    const by = Math.min(below, rowAbove);
    if (by <= 0) return;
    list.scrollBy({ top: by, behavior: reduce ? 'auto' : 'smooth' });
  }, [open, bodyRef, reduce]);
}

const LineStep = React.memo(function LineStep({ tool, recovered, clockKey }: { tool: ToolCallState; recovered: boolean; clockKey?: string }) {
  const running = isRunningStatus(tool.status);
  const step = stepView(tool, recovered);
  const hasPayload = !!(tool.inputJson || tool.output);
  const drawer = useLineDrawer();
  const bodyId = useId();
  const { age } = useRunClock(running, tool.startedAt, clockKey);
  const durMs = toolDurationMs(tool);
  // A window that words its own tools (the Companion's toolLine) names the step; its line replaces the generic detail.
  const label = useMetaChatDecorations()?.toolLine?.(tool) ?? null;
  useRevealOpenedStep(drawer.open, drawer.bodyRef);
  const view: LineView = {
    icon: stepIcon(tool, age, step.loud),
    lead: label ?? step.lead,
    rest: label && step.restKind !== 'error' ? undefined : step.rest,
    restKind: step.restKind,
    frag: step.frag,
    meta: running ? (age >= 1000 ? liveDuration(age) : null) : durMs != null ? settledDuration(durMs) : null,
  };
  return (
    <div className="agent-line-run agent-line-run--step">
      <LineRow
        view={view}
        live={running}
        step
        expanded={drawer.open}
        controls={hasPayload ? bodyId : undefined}
        onToggle={hasPayload ? drawer.toggle : undefined}
      />
      {hasPayload && (
        <LineDrawerBody drawer={drawer} id={bodyId} className="agent-line-body">
          <LinePayload tool={tool} recovered={recovered} />
        </LineDrawerBody>
      )}
    </div>
  );
});

/**
 * A delegation keeps today's behaviour in the line look: a button that opens
 * the Background work drawer (aria-haspopup=dialog), "now ❯ tool", the status
 * words. A crew shows one line per agent.
 */
/** SubagentSummaryLine resets margins and width inline; the line's hang is put back here. */
const SUB_LINE_STYLE: React.CSSProperties = {
  width: 'calc(100% + var(--agent-line-hang) + 8px)',
  marginLeft: 'calc(-1 * var(--agent-line-hang) - 4px)',
  padding: 4,
  borderRadius: 'var(--ui-radius)',
};

function LineSubagent({ tool, info, linked }: { tool: ToolCallState; info: SubagentToolInfo; linked: readonly SubagentInfo[] }) {
  const glyph = <span className="agent-line__ico"><Glyph name="agent" /></span>;
  return (
    <div data-testid="subagent-card" className="agent-line-run agent-line-sub">
      {linked.length > 1 ? linked.map((entry) => (
        <SubagentSummaryLine
          key={entry.sessionId}
          subagent={entry}
          name={subagentDisplayName(entry)}
          status={subagentToolStatus(entry)}
          glyph={glyph}
          scale="line"
          className="agent-line agent-line--sub"
          style={SUB_LINE_STYLE}
        />
      )) : (
        <SubagentSummaryLine
          subagent={linked[0]}
          name={delegationName(info, linked) ?? 'SubAgent'}
          status={delegationStatus(tool, linked)}
          fallback={info.description ?? info.prompt}
          glyph={glyph}
          scale="line"
          className="agent-line agent-line--sub"
          style={SUB_LINE_STYLE}
        />
      )}
    </div>
  );
}

/* ── Runs ── */

export type LineRunItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: ToolCallState };

interface LineRunProps {
  items: readonly LineRunItem[];
  /** The run is the live edge of its turn: running, thinking, or between steps. */
  live: boolean;
  /** A live thought block's phase; tool groups leave it unset. */
  phase?: 'thinking' | 'working' | 'done';
  /** Durable start (backend clock) of the live run. */
  startedAt?: number;
  /** Settled duration shown at the right (a thought-only run puts it in its lead). */
  durationMs?: number;
  subagents?: readonly SubagentInfo[];
  /** Renders a thought chunk (Markdown / Codex steps), from TermThoughtBlock. */
  renderProse?: (text: string, streaming: boolean, key: string) => React.ReactNode;
  /** Extra body content (a plain-style caller's own tool groups). */
  extraBody?: React.ReactNode;
  initialOpen?: boolean;
  /** A thought block that started streaming on screen fades in. */
  enter?: boolean;
  kind: 'group' | 'thought';
}

/**
 * One run as one line. Live, the lead is the current step in the present
 * progressive (each kept ≥ 400ms; "Working…" after a 600ms gap; "Thinking…"
 * with the sentence being written) and the rest is the record so far.
 * Settled, the lead is the run's sentence (summarizeOutcome) or "Thought for 3.1s"
 * with the thought's conclusion. One call opens its payload directly.
 */
export function LineRun({
  items, live, phase, startedAt, durationMs, subagents, renderProse, extraBody, initialOpen = false, enter = false, kind,
}: LineRunProps) {
  const turn = useContext(AgentTurnContext);
  const clockKey = turn?.clockKey;
  const tools = useMemo(() => items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : [])), [items]);
  const ownRecoveries = useMemo(() => (turn ? null : findRecoveries(tools)), [turn, tools]);
  const recovered = turn?.recovered ?? ownRecoveries ?? new Map<string, string>();
  const textItems = items.filter((i): i is Extract<LineRunItem, { kind: 'text' }> => i.kind === 'text');
  const thoughtText = textItems.map((i) => i.text).join('\n\n');
  const thoughtOnly = tools.length === 0;
  const single = tools.length === 1 && textItems.length === 0 && !delegationToolInfo(tools[0], subagents);
  const drawer = useLineDrawer(initialOpen);
  const bodyId = useId();

  const running = tools.filter((t) => isRunningStatus(t.status));
  const current = running[running.length - 1];
  const last = items[items.length - 1];
  const lastTool = tools[tools.length - 1];
  const thinkingNow = live && phase === 'thinking' && (!lastTool || last?.kind === 'text');
  const gapKey = live && !current && !thinkingNow && lastTool ? lastTool.id : null;
  const gapSince = useGapSince(gapKey, lastTool?.endedAt, clockKey);
  const runStart = startedAt ?? tools.reduce<number | undefined>((min, t) => (t.startedAt == null ? min : min == null ? t.startedAt : Math.min(min, t.startedAt)), undefined);
  const { age, now } = useRunClock(live, runStart, clockKey, gapSince);
  const rawPreview = thinkingNow && last?.kind === 'text' ? thoughtPreview(last.text) : undefined;
  const preview = useDwell(rawPreview, rawPreview ?? '', THOUGHT_DWELL_MS, live);
  // A window that words its own tools (the Companion's toolLine and workLine) names the run's steps and work.
  const decorations = useMetaChatDecorations();
  const toolLine = decorations?.toolLine;
  const workLine = decorations?.workLine;

  let view: LineView;
  if (live) {
    const loud = tools.filter((t) => isFailedStatus(t.status) && !recovered.has(t.id) && !isDenied(t));
    const step = current ?? (gapSince !== undefined && now - gapSince < GAP_MS ? lastTool : undefined);
    const spin: LineGlyph = age < SPINNER_DELAY_MS ? (step ? toolOutcomeIcon(step) : 'sparkle') : 'spin';
    let icon: LineGlyph = spin;
    let lead = step ? toolLine?.(step) ?? `${stepName(step).text}…` : thinkingNow ? 'Thinking…' : 'Working…';
    let rest: string | undefined;
    let restKind: RestKind | undefined;
    if (step && isFailedStatus(step.status) && loud.includes(step)) {
      icon = 'fail';
      lead = toolLine?.(step) ?? stepName(step).text;
      rest = toolErrorLine(step);
      restKind = 'error';
    } else if (drawer.open && !thoughtOnly && !single) {
      // Opened mid-run: the running step row owns the only spinner.
      icon = 'steps';
      lead = 'Working…';
    }
    if (!restKind) {
      const prior = tools.filter((t) => t !== step && isTerminalStatus(t.status));
      const ownRecord = prior.length ? workLine?.(prior) ?? null : null;
      if (ownRecord) { rest = ownRecord.charAt(0).toLowerCase() + ownRecord.slice(1); restKind = 'record'; }
      else if (prior.length) { rest = toolRecord(prior); restKind = 'record'; }
      else if (thinkingNow && preview) { rest = preview; restKind = 'thought'; }
      else if (single && step && stepDetail(step)) { rest = stepDetail(step); restKind = 'cmd'; }
    }
    const quiet = loud.filter((t) => !(restKind === 'error' && t === step));
    view = {
      icon, lead, rest, restKind,
      frag: quiet.length ? { tone: 'danger', text: `${quiet.length}\u00A0failed` } : null,
      meta: age >= 1000 ? liveDuration(age) : null,
    };
  } else if (thoughtOnly) {
    const dur = durationMs != null ? settledDuration(durationMs) : null;
    view = {
      icon: 'sparkle',
      lead: dur ? `Thought for ${dur.text}` : 'Thoughts',
      leadNode: dur ? <>Thought for <Duration {...dur} /></> : undefined,
      rest: thoughtConclusion(thoughtText),
      restKind: 'thought',
    };
  } else {
    const outcome = summarizeOutcome(tools, recovered);
    // The window's own line, without the span: it covers the reasoning around the calls (MetaChatDecorations.workLine).
    const own = workLine?.(tools) ?? null;
    const spanMs = durationMs ?? (single ? toolDurationMs(tools[0]) : toolSpanMs(tools));
    view = {
      icon: outcome.icon,
      lead: own ?? outcome.lead,
      rest: outcome.rest,
      restKind: outcome.restKind,
      sentence: own ? undefined : outcome.sentence,
      frag: runFrag(outcome, single),
      meta: !own && spanMs != null ? settledDuration(spanMs) : null,
    };
  }
  const { meta, ...words } = view;
  // Each live lead stays ≥ 400ms; a user opening the run changes it at once.
  const shown = useDwell(words, words.lead, LABEL_DWELL_MS, live && !drawer.open);

  const lastTextKey = textItems[textItems.length - 1]?.key;
  const streamingText = (key: string) => live && phase === 'thinking' && key === lastTextKey;

  let body: React.ReactNode;
  if (thoughtOnly) {
    body = (
      <>
        {thoughtText && <ThoughtBody text={thoughtText} streaming={live && phase === 'thinking'} renderProse={renderProse} />}
        {extraBody}
      </>
    );
  } else if (single) {
    body = <LinePayload tool={tools[0]} recovered={recovered.has(tools[0].id)} />;
  } else {
    body = (
      <>
        <StepList items={items} live={live} recovered={recovered} subagents={subagents} clockKey={clockKey} renderProse={renderProse} streamingText={streamingText} />
        {extraBody}
      </>
    );
  }

  const row = (
    <LineRow
      view={{ ...shown, meta }}
      live={live}
      expanded={drawer.open}
      controls={bodyId}
      onToggle={drawer.toggle}
      groupHeader={kind === 'group'}
    />
  );
  const content = (
    <>
      {row}
      <LineDrawerBody drawer={drawer} id={bodyId} className="agent-line-body">{body}</LineDrawerBody>
    </>
  );
  const rootProps = {
    className: `agent-line-run agent-line-run--${kind}`,
    'data-live': live ? '' : undefined,
    'data-agent-block': kind === 'thought' ? '' : undefined,
  };
  return enter ? (
    <motion.div {...rootProps} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: DUR.enter, ease: 'linear' }}>{content}</motion.div>
  ) : (
    <div {...rootProps}>{content}</div>
  );
}

/** A thought-only block's body: its prose in mid, following the newest text while it streams. */
function ThoughtBody({ text, streaming, renderProse }: {
  text: string;
  streaming: boolean;
  renderProse?: LineRunProps['renderProse'];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const scrollable = useScrollable(ref, text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && streaming && stickyRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);
  return (
    <div
      ref={ref}
      className="agent-line-thought agent-line-thought--body"
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? 'region' : undefined}
      aria-label={scrollable ? 'Thought' : undefined}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
    >
      {renderProse ? renderProse(text, streaming, 'thought') : <p>{text}</p>}
    </div>
  );
}

/** Step rows with the thought prose between them. Rows that arrive while it is open fade in. */
/**
 * The edges of a capped step list that hide more ("up", "down", "up down",
 * or "" when it all shows), re-read on scroll, resize and new items. A live
 * run follows its newest step until the reader scrolls away from the end.
 */
function useStepScroll(ref: React.RefObject<HTMLDivElement | null>, live: boolean, count: number) {
  const [more, setMore] = useState('');
  const followRef = useRef(live);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const up = el.scrollTop > 1;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const next = up && down ? 'up down' : up ? 'up' : down ? 'down' : '';
    setMore((prev) => (prev === next ? prev : next));
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && live && followRef.current) el.scrollTop = el.scrollHeight;
    measure();
  }, [ref, live, count, measure]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref, measure]);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    measure();
  }, [ref, measure]);
  return { more, onScroll };
}

function StepList({ items, live, recovered, subagents, clockKey, renderProse, streamingText }: {
  items: readonly LineRunItem[];
  live: boolean;
  recovered: ReadonlyMap<string, string>;
  subagents?: readonly SubagentInfo[];
  clockKey?: string;
  renderProse?: LineRunProps['renderProse'];
  streamingText: (key: string) => boolean;
}) {
  const [atMount] = useState(() => new Set(items.map((i) => i.key)));
  const scrollRef = useRef<HTMLDivElement>(null);
  const { more, onScroll } = useStepScroll(scrollRef, live, items.length);
  // Scrollable, the list is a named region a keyboard can scroll; short, it adds no tab stop.
  const region = more !== '';
  return (
    <div className="agent-line-stepbox">
      <div
        ref={scrollRef}
        className="agent-line-steps-scroll"
        data-more={more || undefined}
        tabIndex={region ? 0 : undefined}
        role={region ? 'region' : undefined}
        aria-label={region ? 'Steps' : undefined}
        onScroll={onScroll}
      >
        <ul className="agent-line-steps" role="list">
          {items.map((item) => {
            const cls = atMount.has(item.key) ? undefined : 'is-new';
            if (item.kind === 'text') {
              // No glyph: between step rows, only calls carry an icon. The prose
              // starts at the rows' icon edge.
              return (
                <li key={item.key} className={`agent-line-steps__thought${cls ? ` ${cls}` : ''}`}>
                  <div className="agent-line-thought">
                    {renderProse ? renderProse(item.text, streamingText(item.key), item.key) : <p>{item.text}</p>}
                  </div>
                </li>
              );
            }
            const info = delegationToolInfo(item.tool, subagents);
            return (
              <li key={item.key} className={cls}>
                {info
                  ? <LineSubagent tool={item.tool} info={info} linked={subagentsForTool(item.tool, subagents)} />
                  : <LineStep tool={item.tool} recovered={recovered.has(item.tool.id)} clockKey={clockKey} />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * ToolCallGroup in the line chrome. A group of only delegations shows their
 * lines; anything else is one run line (one call opens its payload directly).
 * `live`: the group is the newest content of a streaming turn, so a gap
 * between its calls stays live ("Working…") instead of settling.
 */
export function LineToolGroup({ tools, subagents, live = false }: {
  tools: ToolCallState[];
  subagents?: readonly SubagentInfo[];
  live?: boolean;
}) {
  const items = useMemo<LineRunItem[]>(() => tools.map((tool) => ({ kind: 'tool', key: tool.id, tool })), [tools]);
  const delegations = tools.map((t) => delegationToolInfo(t, subagents));
  if (delegations.every(Boolean)) {
    return (
      <div className="agent-line-group">
        {tools.map((t, i) => <LineSubagent key={t.id} tool={t} info={delegations[i]!} linked={subagentsForTool(t, subagents)} />)}
      </div>
    );
  }
  const active = tools.some((t) => isRunningStatus(t.status)) || live;
  return (
    <div className="agent-line-group">
      <LineRun items={items} live={active} subagents={subagents} kind="group" />
    </div>
  );
}

/**
 * How a settled run ended, beside its sentence. A run that ended on a failure
 * leads with the failed step and shows its exit code, counting failures only
 * when there are more. One that went on after a failure keeps its sentence and
 * counts what stayed failed. Declined calls are no failure: said calmly.
 */
function runFrag(outcome: ReturnType<typeof summarizeOutcome>, single: boolean): LineView['frag'] {
  const NB = '\u00A0';
  if (outcome.restKind === 'error') {
    const code = outcome.leadTool ? toolExitCode(outcome.leadTool) : undefined;
    const count = outcome.failed > 1 ? `${outcome.failed}${NB}failed` : 'failed';
    return { tone: 'danger', text: code !== undefined ? `exit${NB}${code}${outcome.failed > 1 ? ` · ${count}` : ''}` : count };
  }
  if (outcome.unrecovered > 0) return { tone: 'danger', text: `${outcome.unrecovered}${NB}failed` };
  if (outcome.failed > 0) return { tone: 'calm', text: single ? 'failed' : `${outcome.failed}${NB}failed`, more: ', rerun passed' };
  if (outcome.denied > 0) return { tone: 'calm', text: outcome.endedDenied && outcome.denied === 1 ? 'denied' : `${outcome.denied}${NB}denied` };
  return null;
}

/**
 * A finished turn's work, folded into one line above its final answer (see
 * workFold.splitFinishedTurn): "Worked for 1m 5s" with what it did and the
 * prose it folded, failures apart. Opening it shows the work as it rendered
 * while the turn ran, hung under the row's icon and a step quieter.
 */
export function LineWorkFold({ tools, notes, durationMs, subagents, children }: {
  tools: readonly ToolCallState[];
  notes: number;
  durationMs?: number;
  subagents?: readonly SubagentInfo[];
  children: React.ReactNode;
}) {
  const turn = useContext(AgentTurnContext);
  const workLine = useMetaChatDecorations()?.workLine;
  const drawer = useLineDrawer();
  const bodyId = useId();
  const view = useMemo<LineView>(() => {
    const recovered = turn?.recovered ?? findRecoveries(tools);
    // Counted by each call's own status: a delegation counts as its launch chip ended.
    const shown = ownGroupTools(tools, subagents);
    const outcome = summarizeOutcome(shown, recovered);
    // A window that words its own tools (the Companion's workLine) says what the turn did, without the duration.
    const own = workLine?.(shown) ?? null;
    const work = own ?? summarizeWork(shown).text;
    const rest = [
      work && work.charAt(0).toLowerCase() + work.slice(1),
      notes > 0 ? `${notes}\u00A0${notes === 1 ? 'note' : 'notes'}` : '',
    ].filter(Boolean).join(' · ');
    const dur = !own && durationMs != null ? settledDuration(durationMs) : null;
    return {
      icon: 'steps',
      lead: dur ? `Worked for ${dur.text}` : 'Worked',
      leadNode: dur ? <>Worked for <Duration {...dur} /></> : undefined,
      rest: rest || undefined,
      restKind: 'record',
      frag: outcome.unrecovered > 0
        ? { tone: 'danger', text: `${outcome.unrecovered}\u00A0failed` }
        : outcome.failed > 0 ? { tone: 'calm', text: `${outcome.failed}\u00A0failed`, more: ', rerun passed' }
          : outcome.denied > 0 ? { tone: 'calm', text: `${outcome.denied}\u00A0denied` } : null,
    };
  }, [turn, tools, subagents, notes, durationMs, workLine]);
  return (
    <div className="agent-line-workfold">
      <div className="agent-line-run agent-line-run--workfold">
        <LineRow view={view} live={false} expanded={drawer.open} controls={bodyId} onToggle={drawer.toggle} />
        <LineDrawerBody drawer={drawer} id={bodyId} className="agent-line-body" innerClassName="agent-line-workfold__work">
          {children}
        </LineDrawerBody>
      </div>
    </div>
  );
}
