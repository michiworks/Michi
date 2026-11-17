import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { PROGRESSIVE_BATCH, PROGRESSIVE_INITIAL, useProgressiveMount, type ProgressiveMount } from './progressiveMount';

const turns = (count: number, prefix = 'm') => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, role: i % 2 === 0 ? 'user' : 'assistant' }));

function Harness({ messages, target, paused = () => false, adjust = () => {}, api }: {
  messages: Array<{ id: string; role: string }>; target?: string; paused?: () => boolean; adjust?: (delta: number) => void;
  api: { current: ProgressiveMount | null };
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const mount = useProgressiveMount({ nodeId: 'n', messages, scrollRef, initialTarget: () => target, paused,
    following: () => false, adjustScroll: adjust });
  api.current = mount;
  return (
    <div ref={scrollRef}>
      {messages.map((message, i) => (i < mount.from ? null : <div key={message.id} data-msg-id={message.id} />))}
    </div>
  );
}
const mounted = (container: HTMLElement) => [...container.querySelectorAll('[data-msg-id]')].map((el) => el.getAttribute('data-msg-id'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('progressive mount', () => {
  it('mounts a short history at once', () => {
    const api = { current: null as ProgressiveMount | null };
    const { container } = render(<Harness messages={turns(PROGRESSIVE_INITIAL + 8)} api={api} />);
    expect(api.current!.from).toBe(0);
    expect(mounted(container)).toHaveLength(PROGRESSIVE_INITIAL + 8);
  });

  it('mounts the newest turns first, then the rest above them while idle, never unmounting', async () => {
    const api = { current: null as ProgressiveMount | null };
    const messages = turns(100);
    const { container } = render(<Harness messages={messages} api={api} />);
    expect(api.current!.from).toBe(84);
    expect(mounted(container)[0]).toBe('m84');
    const seen = [api.current!.from];
    for (let i = 0; i < 40 && api.current!.from > 0; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      if (api.current!.from !== seen[seen.length - 1]) seen.push(api.current!.from);
    }
    expect(seen).toEqual([84, 84 - PROGRESSIVE_BATCH, 84 - 2 * PROGRESSIVE_BATCH, 36, 20, 4, 0]);
    expect(mounted(container)).toHaveLength(100);
  });

  it('opens on a question and reaches the message the pane lands on', () => {
    const api = { current: null as ProgressiveMount | null };
    // Three above m40 is m37, an answer: the window opens at its question.
    render(<Harness messages={turns(100)} target="m40" api={api} />);
    expect(api.current!.from).toBe(36);
    cleanup();
    const long = [...turns(20, 'x'), { id: 'q', role: 'user' }, ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, role: 'assistant' }))];
    render(<Harness messages={long} api={api} />);
    expect(api.current!.from).toBe(20);
  });

  it('holds batches while paused and mounts through a jump target at once', async () => {
    const api = { current: null as ProgressiveMount | null };
    let paused = true;
    const messages = turns(100);
    const { rerender } = render(<Harness messages={messages} paused={() => paused} api={api} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(api.current!.from).toBe(84);
    act(() => api.current!.ensure('m51'));
    expect(api.current!.from).toBe(48);
    // A target not loaded yet is mounted once older history brings it.
    act(() => api.current!.ensure('old3'));
    expect(api.current!.from).toBe(48);
    rerender(<Harness messages={[...turns(10, 'old'), ...messages]} paused={() => paused} api={api} />);
    expect(api.current!.from).toBe(0);
    paused = false;
  });

  it('keeps the view where it was when a batch mounts above it', () => {
    const api = { current: null as ProgressiveMount | null };
    // Each mounted frame is 100px tall, stacked from the top of the content.
    let scrollTop = 0;
    const adjust = vi.fn((delta: number) => { scrollTop += delta; });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const frames = [...(this.parentElement?.children ?? [])];
      const top = this.hasAttribute('data-msg-id') ? frames.indexOf(this) * 100 - scrollTop : 0;
      return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    try {
      render(<Harness messages={turns(100)} adjust={adjust} api={api} />);
      act(() => api.current!.mountMore());
      expect(api.current!.from).toBe(84 - PROGRESSIVE_BATCH);
      expect(adjust).toHaveBeenCalledExactlyOnceWith(PROGRESSIVE_BATCH * 100);
    } finally {
      rect.mockRestore();
    }
  });
});
