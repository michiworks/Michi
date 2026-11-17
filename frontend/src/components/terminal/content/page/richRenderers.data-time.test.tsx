import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { MichiPageBlock } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';
import { MichiMantine } from './mantine/MichiMantine';
import { SAMPLE_BLOCKS } from './vendor-blocks/src/desk/component-samples';

vi.mock('../../../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div data-testid="md">{text}</div> }));

const TYPES = ['gauge', 'ring', 'rating', 'leaderboard', 'agenda', 'calendar', 'clocks', 'countdown', 'gantt', 'stepper'] as const;
type T = (typeof TYPES)[number];
// What each type draws, as Desk's sheets name it.
const MARK: Record<T, string> = {
  gauge: '.desk-gauge', ring: '.desk-ring', rating: '.desk-rate', leaderboard: '.desk-lb', agenda: '.desk-agenda', calendar: '.desk-time-cal',
  clocks: '.desk-clock', countdown: '.desk-countdown', gantt: '.desk-bars', stepper: '.michi-doc-track',
};
const ctx: MichiBlockCtx = { depth: 0, loadImages: true };

function draw(block: MichiPageBlock) {
  return render(<MichiMantine dark={false}><MichiBlock block={block} ctx={ctx} /></MichiMantine>);
}
const sample = (type: T) => SAMPLE_BLOCKS.get(type) as unknown as MichiPageBlock;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Desk-drawn data and time blocks', () => {
  it.each(TYPES)('draws %s from its Desk sample', (type) => {
    const { container } = draw(sample(type));
    expect(container.querySelector(MARK[type])).not.toBeNull();
    expect(container.querySelector('[data-michi-block="unknown"]')).toBeNull();
  });

  it.each([
    ['gauge', { type: 'gauge', value: 'high' }],
    ['ring', { type: 'ring', items: 'x' }],
    ['rating', { type: 'rating' }],
    ['leaderboard', { type: 'leaderboard', items: 3 }],
    ['agenda', { type: 'agenda' }],
    ['calendar', { type: 'calendar', month: 'October' }],
    ['clocks', { type: 'clocks', zones: 'UTC' }],
    ['countdown', { type: 'countdown' }],
    ['gantt', { type: 'gantt', items: 'x' }],
    ['stepper', { type: 'stepper', steps: 'x' }],
  ] as Array<[string, MichiPageBlock]>)('falls back to the one-line label for an invalid %s', (_type, block) => {
    const { container } = draw(block);
    expect(container.querySelector('[data-michi-block="unknown"]')).not.toBeNull();
  });

  it('draws a lane per gantt item', () => {
    const { container } = draw(sample('gantt'));
    const items = (sample('gantt') as unknown as { items: unknown[] }).items;
    expect(container.querySelectorAll('.desk-bars-body .desk-bars-row').length).toBe(items.length);
    expect(container.querySelectorAll('.desk-bar').length).toBe(items.length);
  });

  it('draws a ring percentage per item', () => {
    const { container } = draw(sample('ring'));
    expect(container.querySelectorAll('.desk-ring-pct').length).toBe(3);
    expect(screen.getByText('92%')).toBeTruthy();
  });

  it('marks the stepper position on the milestone track', () => {
    const { container } = draw(sample('stepper'));
    const steps = [...container.querySelectorAll('ol.michi-doc-track > li')];
    expect(steps.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done', 'next', 'later']);
    expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(steps.map((li) => li.querySelector('.michi-doc-track__note')?.textContent ?? null)).toEqual(['Done', 'Done', 'Now', null]);
    expect(container.querySelector('ol.michi-doc-track')?.hasAttribute('data-stack')).toBe(false);
  });

  it('stacks a long run of steps, and marks every step done past the last', () => {
    const steps = Array.from({ length: 7 }, (_, i) => ({ label: `Step ${i + 1}` }));
    const { container } = draw({ type: 'stepper', steps, current: 7 } as unknown as MichiPageBlock);
    expect(container.querySelector('ol.michi-doc-track')?.hasAttribute('data-stack')).toBe(true);
    expect([...container.querySelectorAll('ol.michi-doc-track > li')].every((li) => li.getAttribute('data-state') === 'done')).toBe(true);
    expect(container.querySelector('[aria-current]')).toBeNull();
  });
});

describe('ticking blocks', () => {
  it('counts down as time advances', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:30Z'));
    const { container } = draw({ type: 'countdown', title: 'Launch', to: '2026-10-25T12:03:00Z' });
    const text = () => container.querySelector('.desk-countdown')?.textContent;
    expect(text()).toBe('2 minutes left');
    // The clock renews on minute changes: 12:02:00 is 90s on.
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(text()).toBe('1 minute left');
  });

  it('shows time is up once the target has passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:30Z'));
    const { container } = draw({ type: 'countdown', title: 'Launch', to: '2026-10-25T12:00:50Z' });
    expect(container.querySelector('.desk-countdown')?.getAttribute('data-over')).toBeNull();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(container.querySelector('.desk-countdown')?.getAttribute('data-over')).not.toBeNull();
  });

  it('advances a clock on the minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:30Z'));
    const { container } = draw({ type: 'clocks', zones: [{ label: 'UTC', tz: 'UTC' }] });
    const time = () => container.querySelector('.desk-clock-time')?.textContent;
    expect(time()).toBe('12:00');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(time()).toBe('12:01');
  });

  it('lists a month\'s events by day under the calendar, in date order', () => {
    const { container } = draw({ type: 'calendar', month: '2026-11', events: [
      { date: '2026-11-20', title: 'Freeze' }, { date: '2026-11-08', title: 'Design review' }, { date: '2026-11-20', title: 'Notes due' },
    ] } as unknown as MichiPageBlock);
    const rows = [...container.querySelectorAll('.desk-time-cal-event')].map((li) => [
      li.querySelector('.desk-time-cal-day')?.textContent,
      [...li.querySelectorAll('.desk-time-cal-names > span')].map((n) => n.textContent),
    ]);
    expect(rows).toEqual([['Nov 8', ['Design review']], ['Nov 20', ['Freeze', 'Notes due']]]);
  });

  it("gives a clock's offset a line of its own, apart from the date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T08:00:00Z'));
    const { container } = draw({ type: 'clocks', zones: [{ label: 'Seattle', tz: 'America/Los_Angeles' }] });
    const offset = container.querySelector('.desk-clock-offset');
    expect(offset?.textContent).toMatch(/^GMT-8$/);
    expect(offset?.previousElementSibling?.textContent).not.toContain('GMT');
  });
});
