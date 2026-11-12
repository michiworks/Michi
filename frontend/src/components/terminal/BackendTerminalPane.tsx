import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_ERROR_CODES, type TerminalPeers } from 'michi-shared';
import type { TerminalPaneItem } from '../../state/paneItems';
import { useChatActions } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';
import { usePrefs } from '../../state/prefs';
import { TERMINAL_CLIENT_ID } from '../../state/terminalTarget';
import { createTerminal, restartTerminal, TerminalApiError, TerminalLink } from '../../services/api/terminals';
import { Button } from '../ui/controls';
import { TerminalKeyBar, type TerminalBarKey } from './TerminalKeyBar';
import { terminalKeySequence, withControl, type TerminalKeyName } from './terminalKeys';
import { terminalTheme } from './terminalTheme';
import { createPaneTerminal } from './terminalXterm';
import './backendTerminal.css';

type Status = 'connecting' | 'ready' | 'reconnecting' | 'exited' | 'off' | 'unavailable' | 'closed';

const STATUS_TEXT: Partial<Record<Status, string>> = {
  connecting: 'connecting', ready: 'ready', reconnecting: 'reconnecting', off: 'off', unavailable: 'unavailable', closed: 'closed',
};

function endedStatus(error: unknown): { status: Status; message: string } {
  if (error instanceof TerminalApiError) {
    if (error.code === TERMINAL_ERROR_CODES['phone-off']) return { status: 'off', message: '' };
    if (error.code === TERMINAL_ERROR_CODES.notFound) return { status: 'closed', message: '' };
    return { status: 'unavailable', message: error.message };
  }
  return { status: 'unavailable', message: error instanceof Error ? error.message : 'The terminal could not start.' };
}

function peersLabel(peers: TerminalPeers, phone: boolean): string | null {
  if (phone && peers.desktop > 0) return 'Also on desktop';
  if (!phone && peers.phone > 0) return 'Also on phone';
  return peers.phone + peers.desktop > 0 ? 'Also open elsewhere' : null;
}

/**
 * A terminal a Michi backend runs (backend/src/services/terminalHost.ts):
 * on phones, in browsers and for the desktop's remote workspaces. Other
 * windows may show the same shell; the one that typed last sets its size.
 */
export default function BackendTerminalPane({ item, connectionId }: { item: TerminalPaneItem; connectionId: string }) {
  const { focusPane } = useChatActions();
  const { prefs } = usePrefs();
  const phone = usePhoneLayout();
  const shellStyle = usePaneShellStyle(item.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const linkRef = useRef<TerminalLink | null>(null);
  const ctrlRef = useRef(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [peers, setPeers] = useState<TerminalPeers>({ phone: 0, desktop: 0 });
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [focused, setFocused] = useState(false);
  // Mobile Safari does not resize the layout for its keyboard and pans only to
  // xterm's hidden textarea at the cursor: lift the key row above the keyboard.
  const keyboardInset = useKeyboardInset(phone && focused);

  const armCtrl = useCallback((armed: boolean) => { ctrlRef.current = armed; setCtrlArmed(armed); }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setStatus('connecting'); setMessage(''); setExitCode(null); setPeers({ phone: 0, desktop: 0 });
    const terminal = createPaneTerminal(host);
    terminalRef.current = terminal;
    terminal.options.theme = terminalTheme(prefs.terminalPalette, prefs.terminalAccentOverrides);
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    terminal.textarea?.addEventListener('focus', onFocus);
    terminal.textarea?.addEventListener('blur', onBlur);
    const link = new TerminalLink(connectionId, item.surfaceId, TERMINAL_CLIENT_ID, {
      onStatus: (next) => {
        if (next === 'open') setStatus((prev) => (prev === 'exited' ? prev : 'ready'));
        else setStatus((prev) => (prev === 'exited' && next === 'reconnecting' ? 'reconnecting' : next));
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'reset':
            terminal.reset();
            if (event.data) terminal.write(event.data);
            if (event.exited) { setExitCode(event.exitCode ?? 0); setStatus('exited'); } else setStatus('ready');
            break;
          case 'data':
            terminal.write(event.data);
            break;
          case 'exit':
            setExitCode(event.exitCode);
            setStatus('exited');
            break;
          case 'restart':
            setExitCode(null);
            setStatus('ready');
            break;
          case 'peers':
            setPeers({ phone: event.phone, desktop: event.desktop });
            break;
          case 'closed':
            break;
        }
      },
      onEnd: (error) => {
        if (disposed) return;
        const ended = endedStatus(error);
        setStatus(ended.status); setMessage(ended.message);
      },
    });
    linkRef.current = link;
    const applyFit = () => {
      try {
        fit.fit();
        link.resize(terminal.cols, terminal.rows);
        setSize({ cols: terminal.cols, rows: terminal.rows });
      } catch { /* pane is between layouts */ }
    };
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(applyFit));
    resizeObserver.observe(host);
    const input = terminal.onData((data) => {
      if (ctrlRef.current) { armCtrl(false); data = withControl(data); }
      link.write(data);
    });
    requestAnimationFrame(applyFit);
    createTerminal(connectionId, { terminalId: item.surfaceId, cwd: item.cwd, cols: terminal.cols, rows: terminal.rows, clientId: TERMINAL_CLIENT_ID })
      .then(() => { if (!disposed) link.start(); })
      .catch((error: unknown) => {
        if (disposed) return;
        const ended = endedStatus(error);
        setStatus(ended.status === 'closed' ? 'unavailable' : ended.status); setMessage(ended.message);
      });
    return () => {
      disposed = true;
      terminal.textarea?.removeEventListener('focus', onFocus);
      terminal.textarea?.removeEventListener('blur', onBlur);
      setFocused(false);
      resizeObserver.disconnect();
      input.dispose();
      link.dispose();
      linkRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
    // The theme updates in place below; armCtrl is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, item.cwd, item.surfaceId, generation]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(prefs.terminalPalette, prefs.terminalAccentOverrides);
  }, [prefs.terminalPalette, prefs.terminalAccentOverrides]);

  const onBarKey = useCallback((key: TerminalBarKey) => {
    const terminal = terminalRef.current;
    const link = linkRef.current;
    if (!terminal || !link) return;
    if (key === 'Hide') { terminal.blur(); return; }
    if (key === 'Ctrl') { armCtrl(!ctrlRef.current); return; }
    const text = key.startsWith('text:');
    let data = text ? key.slice(5) : terminalKeySequence(key as TerminalKeyName, terminal.modes.applicationCursorKeysMode);
    if (ctrlRef.current) { armCtrl(false); if (text) data = withControl(data); }
    link.write(data);
  }, [armCtrl]);

  const restart = () => {
    void restartTerminal(connectionId, item.surfaceId, TERMINAL_CLIENT_ID).catch((error: unknown) => {
      const ended = endedStatus(error);
      setStatus(ended.status); setMessage(ended.message);
    });
  };

  const live = status === 'ready' || status === 'reconnecting' || status === 'exited' || status === 'connecting';
  const shared = peersLabel(peers, phone);
  const statusText = status === 'exited'
    ? `exit ${exitCode ?? ''}`
    : status === 'ready' && shared && size ? `${size.cols}×${size.rows} · ready` : STATUS_TEXT[status];
  const dot = status === 'ready' ? 'var(--term-digest)' : status === 'exited' ? 'var(--term-danger)' : status === 'reconnecting' ? 'var(--term-mauve)' : 'var(--term-muted)';

  return (
    <div data-pane-id={item.id} data-pane-kind="terminal" data-terminal-status={status} className="terminal-pane" onMouseDown={() => focusPane(item.id)} style={keyboardInset ? { ...shellStyle, paddingBottom: keyboardInset } : shellStyle}>
      <div className="backend-terminal__header">
        <span className={status === 'reconnecting' ? 'backend-terminal__dot backend-terminal__dot--wait' : 'backend-terminal__dot'} style={{ color: dot }}>●</span>
        <span className="backend-terminal__cwd">{item.cwd || '~'}</span>
        {shared && live ? <span className="backend-terminal__shared">{shared}</span> : null}
        <span className="backend-terminal__status">{statusText}</span>
      </div>
      <div className="backend-terminal__body" data-dim={status === 'reconnecting' || undefined}>
        <div ref={hostRef} className="backend-terminal__host" aria-hidden={!live || undefined} />
        {status === 'reconnecting' ? (
          <div className="backend-terminal__banner" role="status">
            <span className="backend-terminal__spinner" aria-hidden />
            <span><strong>Reconnecting…</strong> The shell keeps running on this machine. Output you missed will catch up.</span>
          </div>
        ) : null}
        {!live ? (
          <div className="backend-terminal__empty">
            <div className="backend-terminal__glyph" aria-hidden>&gt;_</div>
            {status === 'off' ? (
              <>
                <div className="backend-terminal__title">Terminal is off on this phone</div>
                <p>Terminals run on the machine Michi runs on, with your account. To use them here, turn on <span className="backend-terminal__path">Settings › Phone access › Terminal</span> on your computer.</p>
                <Button onClick={() => setGeneration((value) => value + 1)}>Try again</Button>
              </>
            ) : status === 'closed' ? (
              <>
                <div className="backend-terminal__title">This terminal was closed</div>
                <p>Its shell ended on the machine that ran it.</p>
                <Button onClick={() => setGeneration((value) => value + 1)}>Start a new shell</Button>
              </>
            ) : (
              <>
                <div className="backend-terminal__title">Terminal unavailable</div>
                <p>{message || 'The terminal could not start.'}</p>
                <Button onClick={() => setGeneration((value) => value + 1)}>Try again</Button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {status === 'exited' ? (
        <div className="backend-terminal__exited">
          <span>Shell exited</span>
          <Button onClick={restart}>Restart</Button>
        </div>
      ) : phone && live ? (
        <TerminalKeyBar onKey={onBarKey} ctrlArmed={ctrlArmed} disabled={status !== 'ready'} />
      ) : null}
    </div>
  );
}
