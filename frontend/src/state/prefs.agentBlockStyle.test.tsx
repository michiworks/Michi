import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_BLOCK_STYLE_REVISION, DEFAULT_PREFS, PREFS_KEY, PrefsProvider, migrateAgentBlockStyle, useAgentBlockStyle, usePrefs } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn(async () => true) }));
vi.mock('../services/api', () => api);

function Probe() {
  const { setPref, reset, resetTerminal } = usePrefs();
  return <>
    <output data-testid="style">{useAgentBlockStyle()}</output>
    <button onClick={() => setPref('agentBlockStyle', 'card')}>Card</button>
    <button onClick={() => setPref('agentBlockStyle', 'terminal')}>Terminal</button>
    <button onClick={reset}>Reset</button>
    <button onClick={resetTerminal}>Reset appearance</button>
  </>;
}

const saved = () => JSON.parse(localStorage.getItem(PREFS_KEY)!);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  api.fetchPrefs.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('agentBlockStyle', () => {
  it("defaults to 'line'", () => {
    expect(DEFAULT_PREFS.agentBlockStyle).toBe('line');
    expect(DEFAULT_PREFS.agentBlockStyleRevision).toBe(AGENT_BLOCK_STYLE_REVISION);
  });

  it("migrates a 'card' saved before the revision to 'line', once; keeps every other value", () => {
    expect(migrateAgentBlockStyle({ agentBlockStyle: 'card' })).toEqual({ agentBlockStyle: 'line', agentBlockStyleRevision: 2 });
    expect(migrateAgentBlockStyle({ agentBlockStyle: 'card', agentBlockStyleRevision: 2 })).toEqual({ agentBlockStyle: 'card', agentBlockStyleRevision: 2 });
    expect(migrateAgentBlockStyle({ agentBlockStyle: 'terminal' }).agentBlockStyle).toBe('terminal');
    expect(migrateAgentBlockStyle({ agentBlockStyle: 'plain' }).agentBlockStyle).toBe('plain');
    expect(migrateAgentBlockStyle({ agentBlockStyle: 'line' }).agentBlockStyle).toBe('line');
    expect(migrateAgentBlockStyle({ agentBlockStyle: 'neon' }).agentBlockStyle).toBe('line');
    expect(migrateAgentBlockStyle({}).agentBlockStyle).toBe('line');
  });

  it('applies the migration to saved local prefs and stores the marker, so a later explicit card stays', async () => {
    vi.useFakeTimers();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ agentBlockStyle: 'card', onboardingCompletedAt: 1 }));
    const first = render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('style').textContent).toBe('line');
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(saved()).toMatchObject({ agentBlockStyle: 'line', agentBlockStyleRevision: 2 });

    fireEvent.click(screen.getByText('Card'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(saved()).toMatchObject({ agentBlockStyle: 'card', agentBlockStyleRevision: 2 });
    first.unmount();

    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('style').textContent).toBe('card');
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByTestId('style').textContent).toBe('line');
    fireEvent.click(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Reset appearance'));
    expect(screen.getByTestId('style').textContent).toBe('line');
  });

  it('keeps a saved terminal style', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ agentBlockStyle: 'terminal' }));
    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('style').textContent).toBe('terminal');
  });

  it('migrates backend prefs on a fresh profile the same way', async () => {
    api.fetchPrefs.mockResolvedValue({ agentBlockStyle: 'card', onboardingCompletedAt: 1 });
    render(<PrefsProvider><Probe /></PrefsProvider>);
    await act(async () => {});
    expect(screen.getByTestId('style').textContent).toBe('line');
  });
});
