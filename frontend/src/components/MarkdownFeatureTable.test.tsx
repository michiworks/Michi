import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownFeatureTable from './MarkdownFeatureTable';

afterEach(() => vi.useRealTimers());

describe('MarkdownFeatureTable cards', () => {
  it('labels each cell with its column once the table settles', () => {
    vi.useFakeTimers();
    const { container } = render(
      <MarkdownFeatureTable>
        <thead><tr><th>Ticket</th><th>Owner</th></tr></thead>
        <tbody><tr><td>B-1</td><td>alex</td></tr><tr><td>A-2</td><td>sam</td></tr></tbody>
      </MarkdownFeatureTable>,
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
