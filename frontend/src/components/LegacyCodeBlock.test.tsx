import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LegacyCodeBlock from './LegacyCodeBlock';

// `deferHighlight` skips the lazy Shiki import so these render synchronously
// (plain lines) — we're asserting chrome, not token coloring.
describe('LegacyCodeBlock chrome', () => {
  it('optionally renders line numbers and a download action', () => {
    const { container } = render(
      <LegacyCodeBlock
        text={'a\nb\nc'}
        language="bash"
        deferHighlight
        lineNumbers
        showDownload
      />,
    );

    expect([...container.querySelectorAll('[data-line-number]')].map((line) => (
      line.getAttribute('data-line-number')
    ))).toEqual(['1', '2', '3']);
    expect(container.querySelector('[data-michi-code-download]')).not.toBeNull();
  });
});

describe('LegacyCodeBlock copy', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('ticks for as long as the other copy buttons, and only after a copy that landed', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { getByRole } = render(<LegacyCodeBlock text="echo hi" language="bash" deferHighlight />);
    const button = getByRole('button', { name: 'Copy code' });
    await act(async () => { fireEvent.click(button); });
    expect(writeText).toHaveBeenCalledWith('echo hi');
    expect(button.classList.contains('is-copied')).toBe(true);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(button.classList.contains('is-copied')).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    expect(button.classList.contains('is-copied')).toBe(false);

    vi.stubGlobal('navigator', {});
    await act(async () => { fireEvent.click(button); });
    expect(button.classList.contains('is-copied')).toBe(false);
  });
});
