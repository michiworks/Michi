import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalPaneItem } from '../../state/paneItems';
import { useChatActions } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { getElectron } from '../../lib/electronBridge';
import { usePrefs } from '../../state/prefs';
import { terminalTargetForPane } from '../../state/terminalTarget';
import BackendTerminalPane from './BackendTerminalPane';
import { terminalTheme } from './terminalTheme';
import { createPaneTerminal } from './terminalXterm';

export default function TerminalPane({ item }: { item: TerminalPaneItem }) {
  const target = terminalTargetForPane(item);
  return target.transport === 'native'
    ? <NativeTerminalPane item={item} />
    : <BackendTerminalPane item={item} connectionId={target.connectionId} />;
}

/** Electron's local PTY, over IPC (electron/main.ts). */
function NativeTerminalPane({ item }: { item: TerminalPaneItem }) {
  const { focusPane } = useChatActions();
  const { prefs } = usePrefs();
  const terminalRef = useRef<Terminal | null>(null);
  const shellStyle = usePaneShellStyle(item.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'unavailable' | 'exited'>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const electron = getElectron();
    if (!host || !electron?.terminalCreate || !electron.terminalWrite || !electron.terminalResize) {
      setStatus('unavailable');
      return;
    }
    const terminal = createPaneTerminal(host);
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const applyFit = () => {
      try {
        fit.fit();
        electron.terminalResize?.(item.surfaceId, terminal.cols, terminal.rows);
      } catch { /* pane is between layouts */ }
    };
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(applyFit));
    resizeObserver.observe(host);
    const inputDisposable = terminal.onData((data) => electron.terminalWrite?.(item.surfaceId, data));
    const offData = electron.onTerminalData?.((surfaceId, data) => {
      if (surfaceId === item.surfaceId) terminal.write(data);
    });
    const offExit = electron.onTerminalExit?.((surfaceId, code) => {
      if (surfaceId !== item.surfaceId) return;
      setExitCode(code);
      setStatus('exited');
      terminal.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
    });
    requestAnimationFrame(applyFit);
    electron.terminalCreate(item.surfaceId, item.cwd, terminal.cols, terminal.rows)
      .then((snapshot) => {
        if (snapshot.data) terminal.write(snapshot.data);
        if (snapshot.exited) {
          setExitCode(snapshot.exitCode ?? 0);
          setStatus('exited');
        } else {
          setStatus('ready');
          requestAnimationFrame(() => terminal.focus());
        }
      })
      .catch((error) => {
        setStatus('unavailable');
        terminal.write(`\r\n\x1b[31m${error instanceof Error ? error.message : 'Unable to start terminal'}\x1b[0m\r\n`);
      });
    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      offData?.();
      offExit?.();
      terminalRef.current = null;
      terminal.dispose();
      // The PTY deliberately stays alive. Closing the pane, not unmounting the
      // Dashboard during navigation, owns terminalDestroy.
    };
  }, [item.cwd, item.surfaceId]);

  useEffect(() => {
    if (terminalRef.current) {
      // Update the renderer in place: preserve the PTY, buffer and selection.
      terminalRef.current.options.theme = terminalTheme(prefs.terminalPalette, prefs.terminalAccentOverrides);
    }
  }, [prefs.terminalPalette, prefs.terminalAccentOverrides, item.cwd, item.surfaceId]);

  return (
    <div data-pane-id={item.id} data-pane-kind="terminal" className="terminal-pane" onMouseDown={() => focusPane(item.id)} style={shellStyle}>
      <div style={{ height: 32, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--term-line)', flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
        <span style={{ color: status === 'ready' ? 'var(--term-digest)' : status === 'exited' ? 'var(--term-danger)' : 'var(--term-muted)' }}>●</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.cwd || '~'}</span>
        <span>{status === 'exited' ? `exit ${exitCode ?? ''}` : status}</span>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: '8px 8px 4px', background: 'var(--term-pane-bg)' }} />
      {status === 'unavailable' ? (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--term-line)', color: 'var(--term-danger-text)', fontSize: 'var(--fs-xs)' }}>
          The terminal could not start.
        </div>
      ) : null}
    </div>
  );
}
