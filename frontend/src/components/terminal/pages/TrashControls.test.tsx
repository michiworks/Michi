import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Play } from 'lucide-react';
import { TrashIconButton } from './TrashControls';

describe('TrashIconButton', () => {
  it('shows its tooltip on hover, and none while disabled', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<TrashIconButton icon={Play} tooltip="Run now" aria-label="Run" />);
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Run' }));
      act(() => { vi.advanceTimersByTime(450); });
      expect(screen.getByRole('tooltip').textContent).toBe('Run now');

      rerender(<TrashIconButton icon={Play} tooltip="Run now" aria-label="Run" disabled />);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
