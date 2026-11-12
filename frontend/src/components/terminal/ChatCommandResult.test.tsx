import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChatCommandResult, COMMAND_RESULT_DISMISS_MS } from './ChatCommandResult';

describe('ChatCommandResult', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('dismisses a completed result after a moment, but keeps a running one', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<ChatCommandResult result={{ command: 'compact', status: 'running', message: 'Running…' }} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(COMMAND_RESULT_DISMISS_MS * 2); });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    rerender(<ChatCommandResult result={{ command: 'compact', status: 'completed', message: 'Compacted 923.7k → 27.7k tokens.' }} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(COMMAND_RESULT_DISMISS_MS); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps a failure until it is dismissed', () => {
    const onDismiss = vi.fn();
    render(<ChatCommandResult result={{ command: 'compact', status: 'error', message: 'Compaction failed' }} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(COMMAND_RESULT_DISMISS_MS * 2); });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
