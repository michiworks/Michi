import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefsProvider } from '../../state/prefs';
import { useSideColumn } from './useSideColumn';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn(async () => true) }));
vi.mock('../../services/api', () => api);

function Split() {
  const side = useSideColumn('files-tree');
  return (
    <div data-testid="grid" style={{ display: 'grid', gridTemplateColumns: side.columns }}>
      <main />
      <aside ref={side.columnRef} data-testid="column">{side.handle}</aside>
    </div>
  );
}

// jsdom has no PointerEvent; a MouseEvent carries the pointer's x.
function drag(from: number, to: number) {
  const column = screen.getByTestId('column');
  column.getBoundingClientRect = () => ({ width: 300 } as DOMRect);
  Object.defineProperty(screen.getByTestId('grid'), 'clientWidth', { configurable: true, value: 900 });
  const handle = screen.getByTitle('Drag to resize · Double-click to reset');
  handle.setPointerCapture = vi.fn();
  fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: from }));
  act(() => {
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
    handle.dispatchEvent(new MouseEvent('pointerup', { clientX: to }));
  });
}

const columns = () => screen.getByTestId('grid').style.gridTemplateColumns;

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); api.fetchPrefs.mockResolvedValue(null); });
afterEach(cleanup);

describe('useSideColumn', () => {
  it('starts at 31% of the pane, drags wider while leaving the main view its share, and double-click resets', () => {
    render(<PrefsProvider><Split /></PrefsProvider>);
    expect(columns()).toBe('minmax(0, 1fr) minmax(220px, 31%)');
    drag(600, 500);
    expect(columns()).toBe('minmax(0, 1fr) minmax(220px, min(400px, calc(100% - 240px)))');
    drag(600, -1000);
    expect(columns()).toContain('min(660px,');
    drag(600, 900);
    expect(columns()).toContain('min(220px,');
    fireEvent.doubleClick(screen.getByTitle('Drag to resize · Double-click to reset'));
    expect(columns()).toBe('minmax(0, 1fr) minmax(220px, 31%)');
  });

  it('has no handle outside a PrefsProvider', () => {
    render(<Split />);
    expect(screen.queryByTitle('Drag to resize · Double-click to reset')).toBeNull();
    expect(columns()).toBe('minmax(0, 1fr) minmax(220px, 31%)');
  });
});
