import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownFeatureTable, { MarkdownTableLiveContext } from './MarkdownFeatureTable';

afterEach(() => vi.useRealTimers());

const rows = (
  <>
    <thead><tr><th>Ticket</th><th>Owner</th></tr></thead>
    <tbody><tr><td>B-1</td><td>alex</td></tr><tr><td>A-2</td><td>sam</td></tr></tbody>
  </>
);

describe('MarkdownFeatureTable settling', () => {
  it('mounts a complete message’s table settled, so its columns never move on open', () => {
    vi.useFakeTimers();
    const { container } = render(<MarkdownFeatureTable>{rows}</MarkdownFeatureTable>);
    const table = container.querySelector('table')!;
    expect(table.className).toBe('michi-table-settled');
    expect(table.hasAttribute('data-cards')).toBe(true);
  });

  it('keeps a streaming table fixed until its content rests, then settles it', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MarkdownTableLiveContext.Provider value><MarkdownFeatureTable>{rows}</MarkdownFeatureTable></MarkdownTableLiveContext.Provider>,
    );
    const table = container.querySelector('table')!;
    expect(table.className).toBe('');
    act(() => { vi.advanceTimersByTime(300); });
    expect(table.className).toBe('');
    act(() => { vi.advanceTimersByTime(200); });
    expect(table.className).toBe('michi-table-settled');
  });

  it('settles a streaming table as soon as its message finishes', () => {
    vi.useFakeTimers();
    const view = (live: boolean) => (
      <MarkdownTableLiveContext.Provider value={live}><MarkdownFeatureTable>{rows}</MarkdownFeatureTable></MarkdownTableLiveContext.Provider>
    );
    const { container, rerender } = render(view(true));
    const table = container.querySelector('table')!;
    expect(table.className).toBe('');
    rerender(view(false));
    expect(table.className).toBe('michi-table-settled');
  });
});

describe('MarkdownFeatureTable cards', () => {
  it('labels each cell with its column once the table settles', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MarkdownTableLiveContext.Provider value><MarkdownFeatureTable>{rows}</MarkdownFeatureTable></MarkdownTableLiveContext.Provider>,
    );
    const table = container.querySelector('table')!;
    expect(table.hasAttribute('data-cards')).toBe(false);
    act(() => { vi.advanceTimersByTime(500); });
    expect(table.hasAttribute('data-cards')).toBe(true);
    expect(Array.from(table.querySelectorAll('td'), (cell) => cell.dataset.label)).toEqual(['Ticket', 'Owner', 'Ticket', 'Owner']);
  });

  it('leaves a table without a header row as a table', () => {
    vi.useFakeTimers();
    const { container } = render(<MarkdownFeatureTable><tbody><tr><td>a</td><td>b</td></tr></tbody></MarkdownFeatureTable>);
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector('table')!.hasAttribute('data-cards')).toBe(false);
  });
});

describe('MarkdownFeatureTable copy', () => {
  it('keeps a refused copy from escaping as an unhandled rejection', async () => {
    type Listener = (reason: unknown) => void;
    const node = (globalThis as unknown as { process: { on(event: string, listener: Listener): void; off(event: string, listener: Listener): void } }).process;
    const unhandled = vi.fn();
    node.on('unhandledRejection', unhandled);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    try {
      const { getByRole } = render(<MarkdownFeatureTable><tbody><tr><td>a</td></tr></tbody></MarkdownFeatureTable>);
      await act(async () => { fireEvent.click(getByRole('button', { name: 'Copy table' })); });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      node.off('unhandledRejection', unhandled);
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
