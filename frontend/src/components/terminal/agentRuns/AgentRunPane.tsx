import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from 'motion/react';
import { AgentRunStatus, isAgentRunTerminal } from 'michi-shared';
import type {
  AgentRunAttemptDtoV1,
  AgentRunEventV1,
  AgentRunInputRequestV1,
  AgentRunInteractionDtoV1,
  JsonValue,
} from 'michi-shared';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import { useNow } from '../../../hooks/useNow';
import { useFocusAfterAction } from '../../../hooks/useFocusAfterAction';
import { AgentRunContextView } from './AgentRunContextView';
import { AgentRunInteractions } from './AgentRunInteractions';
import { AgentRunTimeline } from './AgentRunTimeline';
import { elapsedRunLabel, runIdentity, runtimeProfileLabel, type LocatedAgentRun } from './agentRunSelectors';
import { CloseIcon, WarningIcon } from '../icons';
import { AgentRunActions } from './AgentRunActions';
import { Button } from '../../ui/controls';
import './agentRuns.css';
import { EASE } from '../../../motion/tokens';
import { measureSurface, PopoverSurface } from '../../ui/Popover';
import { useOverlayFocus } from '../../ui/useOverlayFocus';
import { placeBelowAnchor, useAnchoredPosition } from '../../ui/useAnchoredPosition';
import { useBackLayer } from '../../../lib/backStack';
import { isImeComposing } from '../../../lib/ime';
import { kbd } from '../../../lib/platform';
import './AgentRunPane.css';

const META_WIDTH = 340;

/**
 * The run's metadata, hung from the agent's name. Opening it moves focus in;
 * Esc, a press outside it or Back closes it and gives focus back to the name.
 */
function RunMetadataPopover({ anchor, onClose, children }: {
  anchor: HTMLElement;
  onClose: (restoreFocus: boolean) => void;
  children: React.ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Closed, it fades out for a moment (PopoverSurface) and takes no keys, presses or Back.
  const present = useIsPresent();
  useBackLayer(present, { back: () => closeRef.current(true) });
  useOverlayFocus({ open: present, panelRef: body, trap: false, deferInitialFocus: true });
  useAnchoredPosition({ anchor, surfaceRef: surface, measure: () => {
    // The size it settles to, not the scaled box it grows in from.
    const size = surface.current ? measureSurface(surface.current) : null;
    const { left, top } = placeBelowAnchor(anchor.getBoundingClientRect(), { width: size?.width || META_WIDTH, height: size?.height || 0 }, { gap: 6 });
    setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
  } });
  useEffect(() => {
    if (!present) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surface.current?.contains(target) || anchor.contains(target))) return;
      // Focus inside goes back to the name; focus elsewhere stays where it is.
      closeRef.current(surface.current?.contains(document.activeElement) ?? false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [present, anchor]);
  return (
    <PopoverSurface ref={surface} role="dialog" aria-label="Agent metadata" escapeLayer="over"
      width={META_WIDTH} left={position?.left ?? 0} top={position?.top ?? 0} style={position ? undefined : { visibility: 'hidden' }}>
      <div ref={body} className="agent-run-pane__meta" data-testid="run-metadata-popover" tabIndex={-1}>{children}</div>
    </PopoverSurface>
  );
}

const KBD_HINT: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' };

const REVEAL = { duration: 0.2, ease: EASE.out };
const STATUS_FADE = { duration: 0.12, ease: EASE.out };
const STATUS_TINT = 'color 120ms ease, background-color 120ms ease';

/**
 * What a run adds as it finishes (its result, its actions) opens in: height
 * and opacity over 200ms, bringing the body's gap (read from it as it opens)
 * with it. Present when the pane opens (a finished run), it is simply there.
 * Under reduced motion only the fade.
 */
function RunReveal({ body, children }: { body: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  const still = useReducedMotionConfig() === true;
  const [gap] = useState(() => (body.current ? parseFloat(getComputedStyle(body.current).rowGap) || 0 : 0));
  return (
    <motion.div
      initial={still ? { opacity: 0 } : { height: 0, marginTop: -gap, opacity: 0, overflow: 'hidden' }}
      animate={still ? { opacity: 1 } : { height: 'auto', marginTop: 0, opacity: 1, transitionEnd: { overflow: 'visible' } }}
      transition={REVEAL}
    >
      {children}
    </motion.div>
  );
}

/** The header's status dot. */
const STATUS_COLOR: Partial<Record<AgentRunStatus, string>> = {
  [AgentRunStatus.Running]: 'var(--term-run)',
  [AgentRunStatus.Waiting]: 'var(--term-select)',
  [AgentRunStatus.Recovering]: 'var(--term-mauve)',
  [AgentRunStatus.Failed]: 'var(--term-danger)',
  [AgentRunStatus.Cancelled]: 'var(--term-muted)',
  [AgentRunStatus.Completed]: 'var(--term-digest)',
};

/** The status word beside it: a hue's text form where the hue is too dim for words. */
const STATUS_TEXT_COLOR: Partial<Record<AgentRunStatus, string>> = {
  ...STATUS_COLOR,
  [AgentRunStatus.Waiting]: 'var(--term-waiting-text)',
  [AgentRunStatus.Failed]: 'var(--term-danger-text)',
};

export interface AgentRunPaneProps {
  run: LocatedAgentRun;
  attempts?: readonly AgentRunAttemptDtoV1[];
  events?: readonly AgentRunEventV1[];
  interactions?: readonly AgentRunInteractionDtoV1[];
  now?: number;
  /** An action is in flight or unconfirmed: Cancel, the answers and the sends stay, aria-disabled, and do nothing. */
  busy?: boolean;
  onClose: (identity: AgentResourceIdentity) => void;
  onCancel?: (identity: AgentResourceIdentity) => void;
  onSendInput?: (identity: AgentResourceIdentity, request: AgentRunInputRequestV1) => void;
  onRespondInteraction?: (identity: AgentResourceIdentity, interaction: AgentRunInteractionDtoV1, response: JsonValue) => void;
  onOpenParent?: (identity: AgentResourceIdentity) => void;
}

/**
 * The Run Pane IS a conversation: a slim identity header (agent name →
 * metadata popover), the delegated task as the first message, the event
 * stream rendered as chat flow, interactions inline, and a queued-send
 * steering composer pinned at the bottom. Everything the old Overview /
 * Context / Attempts sections carried lives in the metadata popover.
 */
export function AgentRunPane({
  run: resource, attempts = [], events = [], interactions = [], now, busy = false,
  onClose, onCancel, onSendInput, onRespondInteraction, onOpenParent,
}: AgentRunPaneProps) {
  const run = resource.value;
  const clock = useNow(1_000, now === undefined && run.completedAt === null);
  const identity = runIdentity(resource);
  const [input, setInput] = useState('');
  const [metaOpen, setMetaOpen] = useState(false);
  const nameRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // A cancelled run drops Cancel Run: focus moves on to Close.
  const focusAfter = useFocusAfterAction(busy);
  const activeAttempt = attempts.find((attempt) => attempt.id === run.activeAttemptId) ?? attempts.at(-1);
  const terminal = isAgentRunTerminal(run.status);
  const submit = (mode: AgentRunInputRequestV1['mode']) => {
    const text = input.trim();
    if (!text || !onSendInput || busy) return;
    onSendInput(identity, { version: 1, text, mode, expectedAttemptId: run.activeAttemptId });
    setInput('');
  };
  const result = run.resultBundle;
  const attemptRows = useMemo(() => [...attempts].sort((a, b) => a.attemptIndex - b.attemptIndex), [attempts]);
  const fallbacks = attemptRows.length > 1 ? attemptRows.length - 1 : 0;
  const statusColor = STATUS_COLOR[run.status] ?? 'var(--term-muted)';
  const statusTextColor = STATUS_TEXT_COLOR[run.status] ?? 'var(--term-muted)';
  // The status the pane opened with is drawn settled; a later one fades in.
  const statusSeen = useRef(false);
  useEffect(() => { statusSeen.current = true; }, []);
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <section data-testid="agent-run-pane" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', background: 'var(--term-bg)', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', position: 'relative' }}>
      {/* Boxless identity header: plain text + status dot, no chips. */}
      <header style={{ height: 36, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--term-line)', padding: '0 12px', background: 'var(--term-surface)', flexShrink: 0 }}>
        <button ref={nameRef} type="button" className="t-text-btn agent-run-name" aria-label="Agent metadata" aria-expanded={metaOpen} onClick={() => setMetaOpen((open) => !open)}>
          {run.effectiveDefinition.name}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase', color: statusTextColor, fontWeight: 600, transition: STATUS_TINT }}>
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: 'var(--ui-radius-pill)', background: statusColor, transition: STATUS_TINT }} />
          {/* A new status fades its word in; the clock beside it ticks on unanimated. */}
          <motion.span key={run.status} initial={statusSeen.current ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={STATUS_FADE}>{run.status}</motion.span>
          {' · '}{elapsedRunLabel(run, now ?? clock)}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{runtimeProfileLabel(run)}</span>
        {onCancel && !terminal && (
          <Button variant="ghost" size="sm" aria-disabled={busy || undefined}
            onClick={() => { if (busy) return; focusAfter(() => closeRef.current); onCancel(identity); }}>Cancel Run</Button>
        )}
        <button ref={closeRef} type="button" className="t-icon-btn" aria-label="Close Run Pane" onClick={() => onClose(identity)}><CloseIcon /></button>
      </header>

      {/* Metadata popover — everything the old kv sections carried. */}
      <AnimatePresence>{metaOpen && nameRef.current && (
        <RunMetadataPopover key="metadata" anchor={nameRef.current} onClose={(restoreFocus) => { setMetaOpen(false); if (restoreFocus) nameRef.current?.focus({ preventScroll: true }); }}>
          <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--term-line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', fontWeight: 600, letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase', color: 'var(--term-muted)' }}>Agent metadata</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>run {run.id.slice(0, 8)}</span>
          </div>
          <dl style={{ margin: 0, padding: '5px 0', fontSize: 'var(--fs-md)' }}>
            <MetaRow label="definition" value={run.definitionId ? `snapshotted at spawn · r${run.definitionRevision}` : 'ephemeral snapshot'} />
            <MetaRow label="runtime" value={runtimeProfileLabel(run)} />
            {fallbacks > 0 && <MetaRow label="fallback" value={`${fallbacks} fallback${fallbacks === 1 ? '' : 's'} · now ${activeAttempt ? [activeAttempt.runtimeProfile.runtimeId, activeAttempt.runtimeProfile.modelId].filter(Boolean).join(' · ') : '—'}`} />}
            <MetaRow label="environment" value={run.executionEnvironment.kind.replace('_', ' ')} />
            <MetaRow label="permissions" value={`${run.effectiveDefinition.permissionPolicy.preset} preset`} />
            {run.waitingReason && <MetaRow label="waiting on" value={run.waitingReason} tone="var(--term-waiting-text)" />}
            <MetaRow label="completion" value={run.completionMode} />
          </dl>
          <details style={{ borderTop: '1px solid var(--term-line)', padding: '6px 12px' }}>
            <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
              context · {run.contextManifest.entries.length} items · immutable
            </summary>
            <div style={{ paddingTop: 6 }}><AgentRunContextView manifest={run.contextManifest} /></div>
          </details>
          {onOpenParent && (run.parentRunId || run.parentNodeId) && (
            <div style={{ borderTop: '1px solid var(--term-line)', padding: '6px 12px' }}>
              <button type="button" className="t-text-btn" onClick={() => onOpenParent(identity)}>↰ Open parent</button>
            </div>
          )}
        </RunMetadataPopover>
      )}</AnimatePresence>

      {/* Conversation body: task bubble → event flow → interactions → result. */}
      <div ref={bodyRef} style={{ overflowY: 'auto', padding: '16px 16px 0', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div data-testid="run-task" style={{
            maxWidth: '84%', padding: '10px 14px 11px',
            background: 'color-mix(in srgb, var(--term-accent) 4%, var(--term-surface))',
            borderRight: '2px solid var(--term-accent)',
            boxShadow: '0 1px 2px rgba(0,0,0,.03)',
          }}>
            <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase', marginBottom: 4, color: 'var(--term-accent-text)', fontWeight: 500, lineHeight: 1 }}>
              $ delegated
            </span>
            <div style={{ fontSize: 'var(--fs-lg)', lineHeight: 1.5 }}>{run.task}</div>
          </div>
        </div>

        <AgentRunTimeline events={events} />

        {/* Failed attempts surface as inline system events — the fallback
            story ("rate limited → switched") belongs in the flow. */}
        {attemptRows.filter((attempt) => attempt.error).map((attempt) => {
          const next = attemptRows.find((candidate) => candidate.attemptIndex === attempt.attemptIndex + 1);
          const nextLabel = next ? [next.runtimeProfile.runtimeId, next.runtimeProfile.modelId].filter(Boolean).join(' · ') : null;
          return (
            <div key={attempt.id} data-testid="run-attempt-fallback" style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
              <WarningIcon size="sm" style={{ color: 'var(--term-select)', flexShrink: 0 }} />
              <span>{attempt.error?.message}</span>
              {nextLabel && <span style={{ color: 'var(--term-muted)' }}>→ switched to {nextLabel}</span>}
            </div>
          );
        })}

        <AgentRunInteractions interactions={interactions} busy={busy}
          onRespond={onRespondInteraction ? (interaction, response) => onRespondInteraction(identity, interaction, response) : undefined} />

        {/* A run finishing while it is open: its result and actions open in. Opened finished, they are there. */}
        <AnimatePresence initial={false}>
          {result && (
            <RunReveal key="result" body={bodyRef}>
              <div data-testid="run-result" style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)', padding: 10, display: 'grid', gap: 8, fontSize: 'var(--fs-sm)' }}>
                {result.source === 'inferred' && <span style={{ color: 'var(--term-waiting-text)' }}>Inferred from final output</span>}
                <strong>{result.handoff.conclusion}</strong>
                <div>{result.handoff.artifactsOrChanges}</div>
                {result.handoff.unresolvedIssues && <div style={{ color: 'var(--term-waiting-text)' }}>Unresolved: {result.handoff.unresolvedIssues}</div>}
                {result.changeSet && (
                  <div style={{ border: '1px solid var(--term-line)', padding: 9 }}>
                    <div style={{ fontWeight: 600 }}>Change Set · {result.changeSet.changedFiles.length} files</div>
                    <div style={{ color: 'var(--term-muted)', marginTop: 3 }}>{result.changeSet.summary}</div>
                    <div style={{ color: 'var(--term-muted)', marginTop: 3 }}>Base {result.changeSet.baseCommit} · changes have not been merged automatically</div>
                  </div>
                )}
              </div>
            </RunReveal>
          )}
          {terminal && <RunReveal key="actions" body={bodyRef}><AgentRunActions run={resource} events={events} /></RunReveal>}
        </AnimatePresence>
        <div style={{ flexShrink: 0, height: 2 }} />
      </div>

      {/* Steering composer — sending during a run is queued-send semantics. */}
      {!terminal && (
        <footer style={{ flexShrink: 0, padding: '10px 14px 12px' }}>
          <div className="t-field-frame" style={{ border: 'var(--term-composer-border)', background: 'var(--term-composer-bg, var(--term-surface))', boxShadow: 'var(--term-composer-shadow-muted)' }}>
            <textarea aria-label="Steer Agent Run" value={input} onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || isImeComposing(event)) return;
                event.preventDefault();
                if (event.altKey) { if (activeAttempt) submit('immediate'); } else submit('queued');
              }}
              placeholder={`Message ${run.effectiveDefinition.name}…`}
              style={{ width: '100%', minHeight: 44, boxSizing: 'border-box', resize: 'vertical', border: 0, background: 'transparent', color: 'var(--term-fg)', padding: '9px 11px 0', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-md)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px 9px' }}>
              <Button size="sm" aria-label="Queue input" onClick={() => submit('queued')} disabled={!input.trim()} aria-disabled={busy || undefined}>
                <span style={KBD_HINT}>{kbd('enter')}</span>Queue input
              </Button>
              <Button variant="ghost" size="sm" aria-label="Stop & redirect" onClick={() => submit('immediate')} disabled={!input.trim() || !activeAttempt} aria-disabled={busy || undefined}>
                <span style={KBD_HINT}>{kbd('alt', 'enter')}</span>Stop &amp; redirect
              </Button>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>Enter never cancels active work.</span>
            </div>
          </div>
        </footer>
      )}
    </section>
  );
}

function MetaRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '4px 12px' }}>
      <dt style={{ width: 84, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: tone ?? 'var(--term-muted)', margin: 0 }}>{label}</dt>
      <dd style={{ flex: 1, minWidth: 0, margin: 0, lineHeight: 1.45, color: 'var(--term-fg)' }}>{value}</dd>
    </div>
  );
}
