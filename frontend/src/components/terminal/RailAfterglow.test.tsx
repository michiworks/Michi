import { fireEvent, render, screen } from '@testing-library/react';
import { RailAfterglow } from './RailAfterglow';

describe('RailAfterglow', () => {
  it('draws nothing for a row that mounts live or idle', () => {
    const { rerender } = render(<RailAfterglow live right={2} />);
    expect(screen.queryByTestId('rail-afterglow')).toBeNull();
    rerender(<RailAfterglow live right={2} />);
    expect(screen.queryByTestId('rail-afterglow')).toBeNull();

    render(<RailAfterglow live={false} right={2} />);
    expect(screen.queryByTestId('rail-afterglow')).toBeNull();
  });

  it('fades the live rail out when a run ends, then removes it', () => {
    const { rerender } = render(<RailAfterglow live right={3} />);
    rerender(<RailAfterglow live={false} right={3} />);
    const glow = screen.getByTestId('rail-afterglow');
    expect(glow.className).toBe('sb-rail-afterglow');
    expect(glow.style.right).toBe('3px');

    fireEvent.animationEnd(glow);
    expect(screen.queryByTestId('rail-afterglow')).toBeNull();
  });

  it('drops the afterglow when a new run starts mid-fade', () => {
    const { rerender } = render(<RailAfterglow live right={2} />);
    rerender(<RailAfterglow live={false} right={2} />);
    expect(screen.getByTestId('rail-afterglow')).toBeTruthy();
    rerender(<RailAfterglow live right={2} />);
    expect(screen.queryByTestId('rail-afterglow')).toBeNull();
  });
});
