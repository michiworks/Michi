import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { TerminalListResponse, TerminalSummary } from 'michi-shared';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import type { LauncherPaneItem, PaneLauncherChoice, TerminalPaneItem } from '../../state/paneItems';
import { useChatActions, useChatPanes, useOptionalChatProjects } from '../../state/chatStore';
import { terminalTargetForWorkspace } from '../../state/terminalTarget';
import { listTerminals } from '../../services/api/terminals';

const CHOICES: Array<{
  id: PaneLauncherChoice;
  glyph: string;
  label: string;
  description: string;
}> = [
  { id: 'review', glyph: '±', label: 'Review', description: 'Inspect workspace changes' },
  { id: 'terminal', glyph: '>_', label: 'Terminal', description: 'Start in this workspace' },
  { id: 'files', glyph: '▱', label: 'Files', description: 'Browse workspace and artifacts' },
  { id: 'side-chat', glyph: '⊕', label: 'Side chat', description: 'Create a blank branch' },
];

const buttonStyle: React.CSSProperties = {
  minHeight: 52,
  display: 'grid',
  gridTemplateColumns: '30px minmax(0, 1fr)',
  alignItems: 'center',
  gap: 10,
  padding: '7px 10px',
  borderRadius: 'var(--ui-radius)',
  color: 'var(--term-fg)',
  cursor: 'pointer',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left' as const,
  transition: 'background var(--t-quick) var(--t-ease), border-color var(--t-quick) var(--t-ease), opacity var(--t-quick) var(--t-ease)',
};

/** The choice that is opening keeps the frame its hover had. */
const CHOSEN: React.CSSProperties = { background: 'var(--term-alt)', borderColor: 'var(--term-line)' };

/** Truncate a cwd path to something legible inside the chooser. */
function shortCwd(cwd: string): string {
  if (!cwd) return '~';
  // Show last 2 path segments at most.
  const parts = cwd.replace(/\/$/, '').split('/');
  if (parts.length <= 3) return cwd.startsWith('/') ? cwd : `~/${cwd}`;
  return `…/${parts.slice(-2).join('/')}`;
}

function sharedNote(terminal: TerminalSummary, phone: boolean): string {
  if (terminal.exited) return 'exited';
  if (phone && terminal.clients.desktop > 0) return 'also on desktop';
  if (!phone && terminal.clients.phone > 0) return 'also on phone';
  if (terminal.clients.desktop + terminal.clients.phone > 0) return 'open elsewhere';
  const idleMinutes = Math.floor((Date.now() - terminal.lastActiveAt) / 60_000);
  return idleMinutes >= 60 ? `idle ${Math.floor(idleMinutes / 60)}h` : idleMinutes >= 1 ? `idle ${idleMinutes}m` : 'running';
}

/** The backend terminals this workspace can use, when it uses them (state/terminalTarget.ts). */
function useBackendTerminals(connectionId: string | null): TerminalListResponse | null {
  const [list, setList] = useState<TerminalListResponse | null>(null);
  useEffect(() => {
    setList(null);
    if (connectionId === null) return;
    const controller = new AbortController();
    listTerminals(connectionId, controller.signal).then(setList, (error: unknown) => {
      if (!controller.signal.aborted) setList({ available: false, reason: 'unsupported', message: error instanceof Error ? error.message : 'Terminals are unavailable.', terminals: [] });
    });
    return () => controller.abort();
  }, [connectionId]);
  return list;
}

export default function PaneChooser({ item }: { item: LauncherPaneItem }) {
  const { activateLauncherPane, adoptTerminalPane, adoptBackendTerminal, focusPane } = useChatActions();
  const { paneItems, openPanes } = useChatPanes();
  const workspace = useOptionalChatProjects()?.projects.find((project) => project.id === item.projectId);
  const shellStyle = usePaneShellStyle(item.id);
  const phone = usePhoneLayout();
  const [pending, setPending] = useState<PaneLauncherChoice | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [terminalNote, setTerminalNote] = useState(false);
  const target = terminalTargetForWorkspace(workspace);
  const backendConnectionId = target.transport === 'backend' ? target.connectionId : null;
  const backendTerminals = useBackendTerminals(backendConnectionId);
  const terminalOff = backendConnectionId !== null && backendTerminals !== null && !backendTerminals.available ? backendTerminals : null;

  const detachedTerminals = useMemo(() => {
    const openSet = new Set(openPanes);
    return Object.values(paneItems).filter(
      (entry): entry is TerminalPaneItem =>
        entry.kind === 'terminal' && !openSet.has(entry.id),
    );
  }, [paneItems, openPanes]);

  // Terminals the backend runs that no pane of this window holds: another
  // window's, or ones whose pane this window lost (a reload of another tab).
  const otherTerminals = useMemo(() => {
    if (!backendTerminals?.available) return [];
    const held = new Set(Object.values(paneItems).flatMap((entry) => entry.kind === 'terminal' ? [entry.surfaceId] : []));
    return backendTerminals.terminals.filter((terminal) => !held.has(terminal.terminalId));
  }, [backendTerminals, paneItems]);

  const choose = async (choice: PaneLauncherChoice) => {
    if (choice === 'terminal' && terminalOff) { setTerminalNote((open) => !open); return; }
    if (pending || adopting) return;
    setPending(choice);
    try {
      await activateLauncherPane(item.id, choice);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : 'Unable to open pane');
    }
  };

  const adopt = (terminalId: string) => {
    if (pending || adopting) return;
    setAdopting(terminalId);
    adoptTerminalPane(item.id, terminalId);
  };

  const adoptBackend = (terminal: TerminalSummary) => {
    if (pending || adopting || backendConnectionId === null) return;
    setAdopting(terminal.terminalId);
    adoptBackendTerminal(item.id, terminal, backendConnectionId);
  };

  const busy = pending !== null || adopting !== null;
  const runningCount = detachedTerminals.length + otherTerminals.length;

  return (
    <div
      data-pane-id={item.id}
      data-pane-kind="launcher"
      className="terminal-pane"
      onMouseDown={() => focusPane(item.id)}
      style={{ ...shellStyle, justifyContent: 'center' }}
    >
      <div
        aria-label="Choose pane type"
        style={{
          width: 'min(420px, calc(100% - 48px))',
          margin: '0 auto',
          display: 'grid',
          gap: 3,
        }}
      >
        {/* ── Detached terminal section ── */}
        {runningCount > 0 && (
          <>
            <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--term-muted)', padding: '0 10px', marginBottom: 2, fontFamily: 'var(--ui-font)', letterSpacing: 'var(--ls-wide)', textTransform: 'uppercase' }}>
              Running terminals
            </div>
            {detachedTerminals.map((term) => {
              const isAdopting = adopting === term.id;
              return (
                <button
                  key={term.id}
                  type="button"
                  disabled={busy}
                  aria-label={`Resume terminal — ${term.cwd || '~'}`}
                  onClick={() => adopt(term.id)}
                  className="t-hover-frame"
                  style={{
                    ...buttonStyle,
                    ...(isAdopting ? CHOSEN : undefined),
                    opacity: busy && !isAdopting ? 0.45 : 1,
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  <span aria-hidden style={{ color: 'var(--term-digest)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', textAlign: 'center' }}>
                    {isAdopting ? '…' : '●'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3 }}>Terminal</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortCwd(term.cwd)}
                    </span>
                  </span>
                </button>
              );
            })}
            {otherTerminals.map((terminal) => {
              const isAdopting = adopting === terminal.terminalId;
              return (
                <button
                  key={terminal.terminalId}
                  type="button"
                  disabled={busy}
                  aria-label={`Open terminal — ${terminal.cwd || '~'}`}
                  onClick={() => adoptBackend(terminal)}
                  className="t-hover-frame"
                  style={{
                    ...buttonStyle,
                    ...(isAdopting ? CHOSEN : undefined),
                    opacity: busy && !isAdopting ? 0.45 : 1,
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  <span aria-hidden style={{ color: terminal.exited ? 'var(--term-muted)' : 'var(--term-digest)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', textAlign: 'center' }}>
                    {isAdopting ? '…' : '●'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3 }}>Terminal</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortCwd(terminal.cwd)} · {sharedNote(terminal, phone)}
                    </span>
                  </span>
                </button>
              );
            })}
            <div style={{ borderBottom: '1px solid var(--term-line)', margin: '4px 0' }} />
          </>
        )}

        {/* ── Standard choices ── */}
        {CHOICES.map((choice) => {
          const isPending = pending === choice.id;
          // A phone with Terminal off, or a backend without terminals: say why instead of opening a pane that cannot start.
          const off = choice.id === 'terminal' && terminalOff !== null;
          const description = off ? (terminalOff.reason === 'phone-off' ? 'Off on this phone' : 'Unavailable on this machine') : choice.description;
          return (
            <React.Fragment key={choice.id}>
            <button
              type="button"
              disabled={busy}
              aria-label={choice.label}
              aria-expanded={off ? terminalNote : undefined}
              onClick={() => { void choose(choice.id); }}
              className="t-hover-frame"
              style={{
                ...buttonStyle,
                // The Off tag takes a third column.
                ...(off ? { gridTemplateColumns: '30px minmax(0, 1fr) auto' } : undefined),
                ...(isPending ? CHOSEN : undefined),
                opacity: busy && !isPending ? 0.45 : 1,
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              <span aria-hidden style={{ color: 'var(--term-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', textAlign: 'center', opacity: off ? 0.45 : 1 }}>
                {isPending ? '…' : choice.glyph}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3, opacity: off ? 0.45 : 1 }}>{choice.label}</span>
                <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3 }}>{description}</span>
              </span>
              {off ? (
                <span style={{ color: 'var(--term-muted)', border: '1px solid var(--term-line)', borderRadius: 'var(--ui-radius-pill)', padding: '1px 7px', fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>Off</span>
              ) : null}
            </button>
            {off && terminalNote ? (
              <div role="note" style={{ margin: '2px 10px 4px 50px', padding: '8px 10px', borderLeft: '2px solid var(--term-line-s)', color: 'var(--term-mid)', fontSize: 'var(--fs-sm)', lineHeight: 1.5, fontFamily: 'var(--ui-font)' }}>
                {terminalOff.reason === 'phone-off'
                  ? <>Terminals run on the machine Michi runs on, with your account, so phones can&apos;t open them unless you allow it. Turn on <strong>Settings › Phone access › Terminal</strong> on your computer.</>
                  : terminalOff.message}
              </div>
            ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
