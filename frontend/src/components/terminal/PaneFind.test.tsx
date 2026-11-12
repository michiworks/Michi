import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React, { useRef } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import PaneFind from './PaneFind';
import { MessageBlock } from './MessageBlock';
import type { ChatMessage } from '../../state/chatTypes';
import { MetaChatDecorationsContext } from '../../state/metaChat/metaChatDecorations';

const flashed = vi.hoisted(() => [] as Range[]);
vi.mock('./paneFindMatches', async (importOriginal) => ({
  ...await importOriginal<typeof import('./paneFindMatches')>(),
  flashMatchOverlay: (range: Range) => { flashed.push(range); return () => {}; },
}));

// jsdom has Range and TreeWalker but no CSS Custom Highlight API or scrolling.
class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
}
const highlights = new Map<string, FakeHighlight>();
const scrolled: Element[] = [];
const painted = () => highlights.get('pane-find')?.ranges ?? [];

const message = (id: string, role: 'user' | 'assistant', text: string): ChatMessage =>
  ({ id, role, text, toolCalls: [], streaming: false }) as ChatMessage;

function Frame({ m }: { m: ChatMessage }) {
  return (
    <div data-msg-id={m.id}>
      <MessageBlock
        m={m} index={0} isDark={false} copyText={() => ''} onRetry={() => {}} showThoughts={false}
        fontFamily="inherit" density="comfortable" usageInfo={m.role === 'assistant' ? { durationMs: 1_000, totalTokens: 1_200 } : undefined}
      />
    </div>
  );
}

function Pane({ messages, open = true, before, children, onVisitMatch }: {
  messages: ChatMessage[]; open?: boolean; before?: React.ReactNode; children?: React.ReactNode;
  onVisitMatch?: (range: Range) => () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <>
      {before}
      <div ref={rootRef}>{messages.map((m) => <Frame key={m.id} m={m} />)}{children}</div>
      <PaneFind open={open} rootRef={rootRef} onClose={() => {}} onVisitMatch={onVisitMatch} />
    </>
  );
}

const input = () => screen.getByPlaceholderText(/find in pane/i);
const counter = () => document.querySelector('.t-pane-find-counter')?.textContent;
async function search(query: string) {
  fireEvent.change(input(), { target: { value: query } });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
}

const question = message('m1', 'user', 'how does michi store turns?');
const answer = message('m2', 'assistant', 'Michi stores turns in SQLite');

describe('PaneFind', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('Highlight', FakeHighlight);
    vi.stubGlobal('CSS', { highlights });
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    highlights.clear();
    scrolled.length = 0;
    flashed.length = 0;
  });

  it('returns null when open is false', () => {
    const { container } = render(<PaneFind open={false} rootRef={{ current: null }} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('counts the hits it paints: what was said, not the speaker label or the time and usage row', async () => {
    // Pane answers carry no speaker line; the Meta agent window still labels its replies.
    render(
      <MetaChatDecorationsContext.Provider value={{ assistantLabel: '> michi' }}>
        <Pane messages={[question, answer]} />
      </MetaChatDecorationsContext.Provider>,
    );
    expect(document.body.textContent).toContain('> michi');
    await search('michi');
    expect(counter()).toBe('1 / 2');
    expect(painted().map((range) => range.startContainer.textContent)).toEqual([question.text, answer.text]);

    await search('tokens');
    expect(counter()).toBe('0 / 0');
    expect(painted()).toEqual([]);
  });

  it('skips text that is never shown: a diagram\'s stylesheet, the MathML copy of math, screen-reader text', async () => {
    // What a Mermaid diagram injects (mermaid puts its theme CSS in the SVG),
    // what rehype-katex renders (htmlAndMathml) and a visually hidden label.
    const shown = '<p>Each node has a label.</p>'
      + '<svg><style>#m .node rect{fill:#eee} #m .node .label{color:#333}</style><g><text>Start node</text></g></svg>'
      + '<span class="katex"><span class="katex-mathml"><math><annotation encoding="application/x-tex">node</annotation></math></span>'
      + '<span class="katex-html" aria-hidden="true">node</span></span>'
      + '<span class="sr-only">Show node label</span>';
    render(<Pane messages={[]}><div data-msg-id="m3" dangerouslySetInnerHTML={{ __html: shown }} /></Pane>);
    await search('node');
    expect(counter()).toBe('1 / 3');
    expect(painted().map((range) => range.startContainer.parentElement!.localName)).toEqual(['p', 'text', 'span']);
    expect(painted().every((range) => !range.startContainer.parentElement!.closest('style, .katex-mathml, .sr-only'))).toBe(true);

    await search('label');
    expect(counter()).toBe('1 / 1');
  });

  it('moves through the painted hits on Enter, scrolling to and flashing each', async () => {
    render(<Pane messages={[question, answer]} />);
    await search('michi');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(counter()).toBe('2 / 2');
    expect(flashed.at(-1)).toBe(painted()[1]);
    expect(flashed.at(-1)!.toString()).toBe('Michi');
    expect(scrolled.at(-1)!.textContent).toBe(answer.text);

    fireEvent.keyDown(input(), { key: 'Enter' }); // wraps
    expect(counter()).toBe('1 / 2');
    expect(flashed.at(-1)).toBe(painted()[0]);

    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(flashed.at(-1)).toBe(painted()[1]);
  });

  it('jumps to a hit instead of scrolling smoothly under Reduce motion', async () => {
    const behaviors: (ScrollBehavior | undefined)[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
      behaviors.push(typeof options === 'object' ? options.behavior : undefined);
    };
    render(<Pane messages={[question, answer]} />);
    await search('michi');
    fireEvent.keyDown(input(), { key: 'Enter' });
    document.documentElement.dataset.reduceMotion = 'on';
    try {
      fireEvent.keyDown(input(), { key: 'Enter' });
    } finally {
      delete document.documentElement.dataset.reduceMotion;
    }
    expect(behaviors.slice(-2)).toEqual(['smooth', 'auto']);
  });

  it('hands a visited hit to the pane that holds the view, and lets the previous one go', async () => {
    const release = vi.fn();
    const onVisitMatch = vi.fn((_range: Range) => release);
    render(<Pane messages={[question, answer]} onVisitMatch={onVisitMatch} />);
    await search('michi');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onVisitMatch).toHaveBeenLastCalledWith(painted()[1]);
    expect(scrolled).toEqual([]);
    expect(flashed).toEqual([]);

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(onVisitMatch).toHaveBeenLastCalledWith(painted()[0]);
  });

  it('finds only its own pane, whatever another pane shows that mentions this one', async () => {
    const elsewhere = (
      <div data-node-id="n1">
        <span data-node-id="n1">@michi notes</span>
        <div data-msg-id="other">michi in another pane</div>
      </div>
    );
    render(<Pane messages={[question, answer]} before={elsewhere} />);
    await search('michi');
    expect(counter()).toBe('1 / 2');
    expect(painted()).toHaveLength(2);
    expect(painted().every((range) => !range.startContainer.textContent?.includes('another pane'))).toBe(true);
  });

  it('keeps up with a streaming reply and keeps its place', async () => {
    const view = render(<Pane messages={[question, answer]} />);
    await search('michi');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(counter()).toBe('2 / 2');

    view.rerender(<Pane messages={[question, { ...answer, text: `${answer.text}, one row per michi turn` }]} />);
    // The new text appears over a few frames.
    await waitFor(() => expect(counter()).toBe('2 / 3'));
    expect(painted()).toHaveLength(3);
    expect(painted().every((range) => range.startContainer.isConnected)).toBe(true);
  });

  it('clears its highlight when closed', async () => {
    const view = render(<Pane messages={[question, answer]} />);
    await search('michi');
    expect(painted()).toHaveLength(2);
    view.rerender(<Pane messages={[question, answer]} open={false} />);
    expect(highlights.has('pane-find')).toBe(false);
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<PaneFind open rootRef={{ current: null }} onClose={onClose} />);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('stays open on the Esc that ends an IME composition (%o)', (ime) => {
    const onClose = vi.fn();
    render(<PaneFind open rootRef={{ current: null }} onClose={onClose} />);
    fireEvent.keyDown(input(), { key: 'Escape', ...ime });
    expect(onClose).not.toHaveBeenCalled();
  });
});
