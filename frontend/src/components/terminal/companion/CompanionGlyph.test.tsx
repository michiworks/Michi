import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CompanionGlyph } from './CompanionGlyph';

/** The outline's points (its first subpath is written in absolute coordinates). */
function outline(d: string): Array<[number, number]> {
  const shape = d.slice(0, d.indexOf('Z'));
  const numbers = shape.match(/-?\d*\.?\d+/g)!.map(Number);
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  return points;
}

describe('the agent’s glyph (DESIGN-v2 §1.2, F1a-review #13)', () => {
  it('is the tray glyph’s shape: a taller ear on the left than on the right, and the eyes cut out', () => {
    const { container } = render(<CompanionGlyph />);
    const path = container.querySelector('svg[data-companion-glyph] path')!;
    const d = path.getAttribute('d')!;
    expect(path.getAttribute('fill-rule')).toBe('evenodd');
    // The outline and two eyes.
    expect(d.match(/M/g)).toHaveLength(3);
    const points = outline(d);
    const top = (side: 'left' | 'right') => Math.min(...points.filter(([x]) => (side === 'left' ? x < 8 : x > 8)).map(([, y]) => y));
    // y grows downwards: the left ear reaches higher than the right one, by more than a unit.
    expect(top('right') - top('left')).toBeGreaterThan(1);
  });
});
