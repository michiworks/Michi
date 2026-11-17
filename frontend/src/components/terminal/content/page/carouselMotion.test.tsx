import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { forwardRef, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import type { MichiPageBlock } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';
import { MichiMantine } from './mantine/MichiMantine';
import { CAROUSEL_STEP } from './vendor-blocks/src/desk/blocks/catalog/media/CarouselView';

// Embla moves the pictures in JS, where the CSS reduced-motion catch-all cannot reach (MO-14). What the page asks of it is read here:
// the options Mantine's Carousel hands to Embla, and what happens when a swipe lets go.
const carousel = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@mantine/carousel', () => {
  const Carousel = Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown> & { children?: ReactNode }>((props, ref) => {
      carousel.props.push(props);
      return <div ref={ref} className="desk-carousel">{props.children as ReactNode}</div>;
    }),
    { Slide: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  );
  return { Carousel };
});

const ctx: MichiBlockCtx = { depth: 0, loadImages: true };
const block = { id: 'c', rev: 1, type: 'carousel', items: [{ url: 'https://images.example.com/a.jpg' }, { url: 'https://images.example.com/b.jpg' }] } as unknown as MichiPageBlock;

/** The carousel is loaded on demand: wait until this drawing has reached Mantine's Carousel. */
async function draw(reduce?: 'always') {
  carousel.props.length = 0;
  const page = <MichiMantine dark={false}><MichiBlock block={block} ctx={ctx} /></MichiMantine>;
  const drawn = render(reduce ? <MotionConfig reducedMotion={reduce}>{page}</MotionConfig> : page);
  await waitFor(() => expect(carousel.props.length).toBeGreaterThan(0));
  return drawn;
}
const last = () => carousel.props[carousel.props.length - 1]!;

/** Enough of Embla for the carousel's effects: its events, the picture it is on, and scrollTo. */
function fakeEmbla() {
  const handlers = new Map<string, Array<() => void>>();
  const api = {
    on: vi.fn((name: string, fn: () => void) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return api; }),
    off: vi.fn((name: string, fn: () => void) => { handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn)); return api; }),
    selectedScrollSnap: () => 1,
    scrollTo: vi.fn(),
    emit: (name: string) => { for (const fn of handlers.get(name) ?? []) fn(); },
  };
  return api;
}

afterEach(() => {
  cleanup();
  carousel.props.length = 0;
  vi.unstubAllGlobals();
});

describe('the carousel’s motion', () => {
  it('steps to the next picture at the shortest Embla step that lands without a bounce', async () => {
    await draw();
    expect(last().emblaOptions).toEqual({ duration: CAROUSEL_STEP });
    expect(CAROUSEL_STEP).toBeLessThan(25);
  });

  it('jumps to the picture under Michi’s own Reduce motion and under the OS setting (MO-14)', async () => {
    await draw('always');
    expect(last().emblaOptions).toEqual({ duration: 0 });
    cleanup();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    await draw();
    expect(last().emblaOptions).toEqual({ duration: 0 });
  });

  it('lands a swipe at once under reduced motion, and leaves its glide alone otherwise', async () => {
    for (const reduce of ['always', undefined] as const) {
      await draw(reduce);
      const embla = fakeEmbla();
      act(() => { (last().getEmblaApi as (api: unknown) => void)(embla); });
      act(() => { embla.emit('pointerUp'); });
      if (reduce) expect(embla.scrollTo).toHaveBeenCalledWith(1, true);
      else expect(embla.scrollTo).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
