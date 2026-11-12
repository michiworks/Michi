import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefsProvider, usePanelWidth } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn(async () => true) }));
vi.mock('../services/api', () => api);

let panel: ReturnType<typeof usePanelWidth> = null;
function Probe({ id }: { id: string }) {
  panel = usePanelWidth(id);
  return <output data-testid="width">{panel === null ? 'none' : String(panel.width)}</output>;
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); panel = null;
  api.fetchPrefs.mockResolvedValue(null);
});
afterEach(cleanup);

describe('panel width preference', () => {
  it('keeps a stored width and drops entries that are not a panel width', () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ panelWidths: { row: 600, tiny: 12, word: 'wide' } }));
    render(<PrefsProvider><Probe id="row" /></PrefsProvider>);
    expect(screen.getByTestId('width').textContent).toBe('600');
    cleanup();
    render(<PrefsProvider><Probe id="tiny" /></PrefsProvider>);
    expect(screen.getByTestId('width').textContent).toBe('undefined');
  });

  it('saves a dragged width, then forgets it on reset', () => {
    render(<PrefsProvider><Probe id="row" /></PrefsProvider>);
    expect(screen.getByTestId('width').textContent).toBe('undefined');
    act(() => panel!.set(512.4));
    expect(screen.getByTestId('width').textContent).toBe('512');
    act(() => panel!.reset());
    expect(screen.getByTestId('width').textContent).toBe('undefined');
  });

  it('is unavailable outside a PrefsProvider, where a panel keeps its fixed width', () => {
    render(<Probe id="row" />);
    expect(screen.getByTestId('width').textContent).toBe('none');
  });
});
