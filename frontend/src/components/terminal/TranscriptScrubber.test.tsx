import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../state/chatTypes';
import { TranscriptScrubber } from './TranscriptScrubber';

// jsdom has no layout: the transcript is 4000px tall in an 800px viewport,
// the track 600px tall at y=10, and user messages sit at fixed content offsets.
const TOPS = [0, 900, 1800, 2700, 3400];
const TRACK_TOP = 10;

const user = (i: number): ChatMessage => ({ id: `u${i}`, role: 'user', text: `Question ${i + 1}`, toolCalls: [] });
const reply = (i: number): ChatMessage => ({ id: `a${i}`, role: 'assistant', text: 'Answer', toolCalls: [] });

function Harness({ messages, hasOlder = false, onScrub }: { messages: ChatMessage[]; hasOlder?: boolean; onScrub: (p: 'start' | 'move') => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref} data-testid="scroller">
        {messages.map((m) => <div key={m.id} data-msg-id={m.id} />)}
      </div>
      <TranscriptScrubber scrollRef={ref} messages={messages} hasOlder={hasOlder} top={TRACK_TOP} bottom={80} onScrub={onScrub} />
    </>
  );
}

function setup(questions = TOPS.length, hasOlder = false) {
  const messages = Array.from({ length: questions }, (_, i) => [user(i), reply(i)]).flat();
  const onScrub = vi.fn();
  const view = render(<Harness messages={messages} hasOlder={hasOlder} onScrub={onScrub} />);
  const scroller = view.getByTestId('scroller');
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => 4000 },
    clientHeight: { configurable: true, get: () => 800 },
    scrollTop: { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } },
  });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  scroller.querySelectorAll<HTMLElement>('[data-msg-id^="u"]').forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: TOPS[i] - scrollTop }) as DOMRect;
  });
  const track = view.container.querySelector<HTMLElement>('.transcript-scrubber')!;
  Object.defineProperty(track, 'clientHeight', { configurable: true, get: () => 600 });
  track.getBoundingClientRect = () => ({ top: TRACK_TOP }) as DOMRect;
  const handle = view.container.querySelector<HTMLElement>('.transcript-scrubber__handle')!;
  const bubble = view.container.querySelector<HTMLElement>('.transcript-scrubber__bubble')!;
  // jsdom's pointer events carry no coordinates; React reads clientY off any event of that type.
  const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', clientY = 0) =>
    fireEvent(handle, new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
  const readerScroll = (to: number) => {
    fireEvent.touchStart(scroller);
    scrollTop = to;
    fireEvent.scroll(scroller);
  };
  return { scroller, handle, bubble, onScrub, pointer, readerScroll, scrollTop: () => scrollTop };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('TranscriptScrubber', () => {
  it('comes out only when the reader scrolls a long conversation, and goes back after a pause', () => {
    const { scroller, handle, readerScroll } = setup();
    fireEvent.scroll(scroller); // a programmatic scroll, e.g. following the reply
    expect(handle.hasAttribute('data-shown')).toBe(false);
    readerScroll(400);
    expect(handle.hasAttribute('data-shown')).toBe(true);
    // The handle stands in for the native scroll indicator.
    expect(scroller.hasAttribute('data-scrubber')).toBe(true);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(handle.hasAttribute('data-shown')).toBe(false);
  });

  it('stays out of short conversations', () => {
    const { scroller, handle, readerScroll } = setup(3);
    readerScroll(400);
    expect(handle.hasAttribute('data-shown')).toBe(false);
    expect(scroller.hasAttribute('data-scrubber')).toBe(false);
  });

  it('scrolls in proportion to the drag and names the question at the reading line', () => {
    const { scroller, bubble, onScrub, pointer, readerScroll, scrollTop } = setup(TOPS.length, true);
    readerScroll(0);
    // The thumb rests at the top of the track: its centre is 21px down.
    pointer('pointerdown', TRACK_TOP + 21);
    expect(onScrub).toHaveBeenCalledWith('start');
    expect(bubble.hasAttribute('data-shown')).toBe(true);
    expect(bubble.textContent).toContain('1 / 5+');
    expect(bubble.textContent).toContain('Question 1');

    // Halfway down the track: half the scroll range, where question 3 crosses the line.
    pointer('pointermove', TRACK_TOP + 21 + 279);
    expect(onScrub).toHaveBeenLastCalledWith('move');
    expect(scrollTop()).toBe(1600);
    expect(bubble.textContent).toContain('3 / 5+');
    expect(bubble.textContent).toContain('Question 3');
    const target = scroller.querySelector('[data-scrub-target]');
    expect(target?.getAttribute('data-msg-id')).toBe('u2');

    pointer('pointerup');
    expect(bubble.hasAttribute('data-shown')).toBe(false);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(scroller.querySelector('[data-scrub-target]')).toBeNull();
  });
});
