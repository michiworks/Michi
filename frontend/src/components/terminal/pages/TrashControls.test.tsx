import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlayIcon } from '../icons';
import { TrashIconButton } from './TrashControls';

describe('TrashIconButton', () => {
  it('shows its tooltip on hover, and none while disabled', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<TrashIconButton icon={PlayIcon} tooltip="Run now" aria-label="Run" />);
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Run' }));
      act(() => { vi.advanceTimersByTime(450); });
      expect(screen.getByRole('tooltip').textContent).toBe('Run now');

      rerender(<TrashIconButton icon={PlayIcon} tooltip="Run now" aria-label="Run" disabled />);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a blocked button focusable, says why on keyboard focus and ignores its clicks', () => {
    const onClick = vi.fn();
    render(<TrashIconButton icon={PlayIcon} tooltip="Run now" blockedReason="Confirm the previous run stopped first"
      aria-label="Run" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(document, { key: 'Tab' });
    act(() => { button.focus(); });
    expect(screen.getByRole('tooltip').textContent).toBe('Confirm the previous run stopped first');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
