import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dot } from './primitives';

describe('Dot', () => {
  it('breathes through the running-dot class, which reduced motion stops, and keeps its size, colour and glow', () => {
    const { container } = render(<Dot color="var(--term-run)" size={7} pulse />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.className).toBe('term-dot-i term-dot-i--run');
    expect(dot.style.animation).toBe('');
    expect(dot.style).toMatchObject({ width: '7px', height: '7px', background: 'var(--term-run)', boxShadow: '0 0 6px 0 currentColor' });
  });

  it('stays still without pulse', () => {
    const { container } = render(<Dot color="var(--term-danger)" />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.className).toBe('');
    expect(dot.style.boxShadow).toBe('');
  });
});
