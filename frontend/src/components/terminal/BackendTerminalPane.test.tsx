import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStreamEvent } from 'michi-shared';
import BackendTerminalPane from './BackendTerminalPane';

const state = vi.hoisted(() => {
  class TerminalApiError extends Error {
    constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
  }
  return {
    TerminalApiError,
    phone: true,
    terminals: [] as Array<{ written: string[]; inputListener?: (data: string) => void }>,
    links: [] as Array<{ handlers: { onEvent(e: TerminalStreamEvent): void; onStatus(s: string): void; onEnd(e: Error): void }; writes: string[]; start: ReturnType<typeof import('vitest').vi.fn> }>,
    create: vi.fn(),
    restart: vi.fn(),
  };
});
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { terminalPalette: 'monokai', terminalAccentOverrides: {} } }) }));
vi.mock('../../state/chatStore', () => ({ useChatActions: () => ({ focusPane: vi.fn() }) }));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('../../hooks/usePhoneLayout', () => ({ usePhoneLayout: () => state.phone }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: Record<string, unknown>;
  cols = 48; rows = 30;
  modes = { applicationCursorKeysMode: false };
  written: string[] = [];
  inputListener?: (data: string) => void;
  constructor(options: Record<string, unknown>) { this.options = options; state.terminals.push(this); }
  loadAddon() {}
  open() {}
  onData(listener: (data: string) => void) { this.inputListener = listener; return { dispose() {} }; }
  reset() { this.written.length = 0; }
  write(data: string) { this.written.push(data); }
  focus() {}
  blur() {}
  dispose() {}
} }));
vi.mock('../../services/api/terminals', () => ({
  TerminalApiError: state.TerminalApiError,
  createTerminal: state.create,
  restartTerminal: state.restart,
  TerminalLink: class {
    writes: string[] = [];
    start = vi.fn();
    constructor(_c: string, _t: string, _w: string, readonly handlers: never) { state.links.push(this as never); }
    write(data: string) { this.writes.push(data); }
    resize() {}
    dispose() {}
  },
}));

const item = { id: 'pane:terminal:t1', kind: 'terminal' as const, projectId: 'p1', treeId: null, createdAt: 1, surfaceId: 't1', cwd: '/home/me/Michi', title: 'Terminal', transport: 'backend' as const };

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
  state.phone = true;
  state.create.mockReset().mockResolvedValue({});
  state.restart.mockReset().mockResolvedValue({});
  state.terminals.length = 0;
  state.links.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('BackendTerminalPane', () => {
  it('explains that Terminal is off for phones instead of showing an error', async () => {
    state.create.mockRejectedValue(new state.TerminalApiError(403, 'terminal_phone_off', 'off'));
    render(<BackendTerminalPane item={item} connectionId="local" />);
    await act(async () => {});
    expect(screen.getByText('Terminal is off on this phone')).toBeTruthy();
    expect(screen.getByText('off')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull();
    expect(state.links[0].start).not.toHaveBeenCalled();
  });

  it('shows the replayed screen, and sends the keys a phone keyboard lacks', async () => {
    render(<BackendTerminalPane item={item} connectionId="local" />);
    await act(async () => {});
    expect(state.create).toHaveBeenCalledWith('local', expect.objectContaining({ terminalId: 't1', cwd: '/home/me/Michi', cols: 48, rows: 30 }));
    const link = state.links[0];
    expect(link.start).toHaveBeenCalled();
    const terminal = state.terminals[0];
    act(() => {
      link.handlers.onStatus('open');
      link.handlers.onEvent({ type: 'reset', seq: 5, instance: 'r', data: 'hello', exited: false });
      link.handlers.onEvent({ type: 'peers', phone: 0, desktop: 1 });
    });
    expect(terminal.written).toEqual(['hello']);
    expect(screen.getByText('Also on desktop')).toBeTruthy();
    expect(screen.getByText('48×30 · ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    fireEvent.click(screen.getByRole('button', { name: 'ctrl' }));
    expect(screen.getByRole('button', { name: 'ctrl' }).getAttribute('aria-pressed')).toBe('true');
    act(() => terminal.inputListener!('c'));
    terminal.inputListener!('c');
    expect(link.writes).toEqual(['\x1b[A', '\x03', 'c']);
  });

  it('offers a restart after the shell exits', async () => {
    render(<BackendTerminalPane item={item} connectionId="box" />);
    await act(async () => {});
    act(() => {
      state.links[0].handlers.onStatus('open');
      state.links[0].handlers.onEvent({ type: 'exit', seq: 3, exitCode: 0 });
    });
    expect(screen.getByText('exit 0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(state.restart).toHaveBeenCalledWith('box', 't1', expect.any(String));
  });

  it('keeps the shell running while it reconnects, and has no key row on a desktop', async () => {
    state.phone = false;
    render(<BackendTerminalPane item={item} connectionId="local" />);
    await act(async () => {});
    act(() => state.links[0].handlers.onStatus('reconnecting'));
    expect(screen.getByRole('status').textContent).toMatch(/The shell keeps running on this machine/);
    expect(screen.queryByRole('toolbar', { name: 'Terminal keys' })).toBeNull();
  });
});
