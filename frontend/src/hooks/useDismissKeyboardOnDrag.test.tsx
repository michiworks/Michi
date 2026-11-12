import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDismissKeyboardOnDrag } from './useDismissKeyboardOnDrag';

function Harness({ active = true }: { active?: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  useDismissKeyboardOnDrag(scrollRef, active, () => fieldRef.current);
  return (
    <>
      <div ref={scrollRef} data-testid="scroller" />
      <div ref={fieldRef}><input data-testid="field" /></div>
      <input data-testid="other" />
    </>
  );
}

const point = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y });

function drag(target: HTMLElement, ...points: Array<[number, number]>) {
  const [first, ...rest] = points;
  fireEvent.touchStart(target, { touches: [point(...first)] });
  for (const p of rest) fireEvent.touchMove(target, { touches: [point(...p)] });
  fireEvent.touchEnd(target, { touches: [] });
}

describe('useDismissKeyboardOnDrag', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('lets go of the field when a finger drags the scroller up or down', () => {
    const view = render(<Harness />);
    const field = view.getByTestId('field');
    field.focus();
    drag(view.getByTestId('scroller'), [100, 400], [102, 396], [103, 380]);
    expect(document.activeElement).not.toBe(field);
  });

  it('keeps the field on a tap, a sideways swipe or a pinch', () => {
    const view = render(<Harness />);
    const field = view.getByTestId('field');
    const scroller = view.getByTestId('scroller');
    field.focus();
    drag(scroller, [100, 400], [104, 404]);
    // Decided as sideways at its first 10px, so the later vertical travel does not count.
    drag(scroller, [100, 400], [130, 402], [130, 460]);
    fireEvent.touchStart(scroller, { touches: [point(100, 400), { identifier: 2, clientX: 200, clientY: 400 }] });
    fireEvent.touchMove(scroller, { touches: [point(100, 300), { identifier: 2, clientX: 200, clientY: 500 }] });
    expect(document.activeElement).toBe(field);
  });

  it('leaves a field outside its own alone, and does nothing while inactive', () => {
    const view = render(<Harness />);
    const other = view.getByTestId('other');
    other.focus();
    drag(view.getByTestId('scroller'), [100, 400], [100, 340]);
    expect(document.activeElement).toBe(other);

    view.rerender(<Harness active={false} />);
    const field = view.getByTestId('field');
    field.focus();
    drag(view.getByTestId('scroller'), [100, 400], [100, 340]);
    expect(document.activeElement).toBe(field);
  });
});
