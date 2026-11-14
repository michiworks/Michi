import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { ToolCallGroup } from './ToolCallGroup';
import { MessageBlock, TermThoughtBlock } from './MessageBlock';
import { AgentTurnContext } from './AgentLineBlocks';
import { deriveStreamActivity } from './StreamActivityIndicator';
import { AgentBlockStyleOverride, type AgentBlockStyle } from '../../state/prefs';
import type { ChatMessage, ChatNodeState, ToolCallState } from '../../state/chatTypes';

const NB = '\u00A0';
const T0 = 1_000_000;

function withStyle(ui: React.ReactNode, style: AgentBlockStyle = 'line') {
  return <AgentBlockStyleOverride.Provider value={style}>{ui}</AgentBlockStyleOverride.Provider>;
}

function bash(id: string, command: string, description: string | undefined, extra: Partial<ToolCallState> = {}): ToolCallState {
  return {
    id, title: 'Bash', kind: 'bash', status: 'completed',
    inputJson: JSON.stringify({ command, ...(description ? { description } : {}) }),
    ...extra,
  };
}
function read(id: string, path: string, extra: Partial<ToolCallState> = {}): ToolCallState {
  return { id, title: 'Read', kind: 'read', status: 'completed', inputJson: JSON.stringify({ file_path: path }), ...extra };
}

/** What a layer shows the eye (screen-reader-only text removed). */
function visibleText(el: Element | undefined): string {
  if (!el) return '';
  const copy = el.cloneNode(true) as Element;
  for (const sr of copy.querySelectorAll('.sr-only')) sr.remove();
  return copy.textContent ?? '';
}
/** The label a line shows now (a leaving layer may still be fading out). */
function shownLead(scope: HTMLElement): string {
  const layers = [...scope.querySelectorAll('.agent-line__lead .agent-line__layer')].filter((el) => !el.hasAttribute('data-leaving'));
  return visibleText(layers[layers.length - 1]);
}
function shownRest(scope: HTMLElement): string {
  const layers = [...scope.querySelectorAll('.agent-line__rest .agent-line__layer')].filter((el) => !el.hasAttribute('data-leaving'));
  return layers[layers.length - 1]?.textContent ?? '';
}
/** Spinners shown now (not a glyph still scaling out). */
const spinners = (scope: Element) => [...scope.querySelectorAll('[data-spinner]')].filter((el) => !el.closest('[data-leaving]'));
const header = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button.agent-line')!;
const bodyOf = (button: HTMLElement) => document.getElementById(button.getAttribute('aria-controls')!)!;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const verify = (failedOutput = 'Exit code 1\nError: http://localhost:4173 is already used\nmore') => [
  bash('t8', 'npm run typecheck -w frontend', 'Typecheck frontend', { startedAt: T0, endedAt: T0 + 41_000 }),
  bash('t9', 'npm test -w frontend -- a.test.ts', 'Run related unit tests', { startedAt: T0 + 41_000, endedAt: T0 + 59_000 }),
  bash('t10', 'npm run test:e2e -- e2e/specs/send-scroll.spec.ts', 'Run send-scroll E2E', {
    status: 'failed', output: failedOutput, startedAt: T0 + 59_000, endedAt: T0 + 131_000,
  }),
];

describe('line chrome · one call', () => {
  it('is one native disclosure button that opens the payload well directly', () => {
    const tool = bash('t1', 'git rev-list --left-right --count dev...origin/dev', 'Count divergence', {
      output: '0\t23', startedAt: T0, endedAt: T0 + 1_400,
    });
    const { container } = render(withStyle(<ToolCallGroup tools={[tool]} defaultExpanded={false} />));
    const button = header(container);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('button.agent-line')).toHaveLength(1);
    expect(shownLead(container)).toBe('Count divergence');
    // The duration reads in full for screen readers; the short form is visual only.
    expect(button.textContent).toContain('1.4 seconds');
    expect(button.querySelector('.agent-line__meta [aria-hidden]')?.textContent).toBe('1.4s');
    const body = bodyOf(button);
    expect(body.hidden).toBe(true);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    const well = within(body).getByRole('group', { name: 'Details: Count divergence' });
    const command = well.querySelector('code')!;
    expect(command.textContent).toBe('git rev-list --left-right --count dev...origin/dev');
    // Verbatim mono: ligatures off, so "--count" and "..." keep their spelling.
    expect(command.className).toContain('agent-verbatim');
    expect(within(well).getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(well.textContent).toContain('0\t23');
    // No caps INPUT / OUTPUT section labels.
    expect([...well.querySelectorAll('*')].some((el) => /^(in|out|input|output)$/i.test(el.textContent?.trim() ?? ''))).toBe(false);
    expect(well.querySelector('.agent-line-payload__foot')?.textContent).toContain('done');

    // The raw JSON input stays reachable behind its own disclosure.
    const raw = within(well).getByRole('button', { name: 'Raw input' });
    const rawBody = document.getElementById(raw.getAttribute('aria-controls')!)!;
    expect(rawBody.hidden).toBe(true);
    fireEvent.click(raw);
    expect(raw.getAttribute('aria-expanded')).toBe('true');
    expect(rawBody.hidden).toBe(false);
    expect(rawBody.textContent).toContain('"description": "Count divergence"');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
  });

  it('reports the copy result honestly', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const tool = read('r1', 'frontend/src/a.ts', { output: 'x', startedAt: T0, endedAt: T0 + 100 });
    const { container } = render(withStyle(<ToolCallGroup tools={[tool]} defaultExpanded={false} />));
    fireEvent.click(header(container));
    const copy = within(container).getByRole('button', { name: 'Copy path' });
    await act(async () => { fireEvent.click(copy); });
    expect(writeText).toHaveBeenCalledWith('frontend/src/a.ts');
    expect(within(container).getByRole('status').textContent).toBe('Copied');
    await act(async () => { fireEvent.click(copy); });
    expect(within(container).getByRole('status').textContent).toMatch(/Couldn’t copy/);
  });
});

describe('line chrome · what a call touched', () => {
  it('shows a web search\'s query as itself, not as a file with a Copy path button', () => {
    const tool: ToolCallState = {
      id: 'w1', title: 'WebSearch', kind: 'tool', status: 'completed', output: 'results',
      inputJson: JSON.stringify({ query: 'vitest fake timers' }), startedAt: T0, endedAt: T0 + 900,
    };
    const { container } = render(withStyle(<ToolCallGroup tools={[tool]} defaultExpanded={false} />));
    fireEvent.click(header(container));
    const well = container.querySelector<HTMLElement>('.agent-line-payload')!;
    expect(well.querySelector('.agent-line-payload__cmd code')?.textContent).toBe('vitest fake timers');
    expect(well.querySelector('.agent-line-payload__cmd')?.textContent).not.toMatch(/^File/);
    expect(within(well).queryByRole('button', { name: 'Copy path' })).toBeNull();
    expect(within(well).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('names the file a Kiro read opened', () => {
    const tool: ToolCallState = {
      id: 'k1', title: 'Reading a.ts', kind: 'read', status: 'completed', output: 'x',
      inputJson: JSON.stringify({ operations: [{ mode: 'Line', path: '/repo/a.ts' }] }), startedAt: T0, endedAt: T0 + 100,
    };
    const { container } = render(withStyle(<ToolCallGroup tools={[tool]} defaultExpanded={false} />));
    fireEvent.click(header(container));
    const well = container.querySelector<HTMLElement>('.agent-line-payload')!;
    expect(well.querySelector('.agent-line-payload__cmd code')?.textContent).toBe('/repo/a.ts');
    expect(within(well).getByRole('button', { name: 'Copy path' })).toBeTruthy();
  });
});

describe('line chrome · failure and recovery', () => {
  it('leads with an unrecovered failure: × in the gutter, the error line in danger text', () => {
    const { container } = render(withStyle(<ToolCallGroup tools={verify()} defaultExpanded={false} />));
    // The failed step's name leads, its exit code beside it.
    expect(shownLead(container)).toBe('Run send-scroll E2E');
    expect(container.querySelector('.agent-line__frag')?.textContent).toBe(`exit${NB}1`);
    expect(shownRest(container)).toBe('http://localhost:4173 is already used');
    expect(container.querySelector('.agent-line__rest')?.className).toContain('is-error');
    expect(container.querySelector('.agent-line__ico .is-fail')).not.toBeNull();
  });

  it('keeps the sentence when the run went on after a failure, counting it calmly', () => {
    const tools = [...verify(), read('r1', 'e2e/specs/send-scroll.spec.ts', { startedAt: T0 + 131_000, endedAt: T0 + 132_000 })];
    const { container } = render(withStyle(<ToolCallGroup tools={tools} defaultExpanded={false} />));
    expect(shownLead(container)).toBe('Read send-scroll.spec.ts; send-scroll E2E failed, typecheck and a.test.ts passed');
    expect(container.querySelector('.agent-line__ico .is-fail')).toBeNull();
    const frag = container.querySelector('.agent-line__frag')!;
    // Danger is for a run that ended failing; this one moved past it.
    expect(frag.className).toContain('is-calm');
    expect(frag.textContent).toBe(`1${NB}failed`);
  });

  it('returns to the outcome once a later call recovered it, with a muted “rerun passed”', () => {
    const { container } = render(withStyle(
      <AgentTurnContext.Provider value={{ recovered: new Map([['t10', 't11']]) }}>
        <ToolCallGroup tools={verify()} defaultExpanded={false} />
      </AgentTurnContext.Provider>,
    ));
    const button = header(container);
    expect(button.hasAttribute('data-toolgroup-header')).toBe(true);
    // Settled, one sentence in the order things happened; the rest is empty.
    expect(shownLead(container)).toBe('Typecheck, a.test.ts and send-scroll E2E passed');
    expect(shownRest(container)).toBe('');
    expect(container.querySelector('.agent-line__lead')!.classList.contains('is-sentence')).toBe(true);
    const frag = container.querySelector('.agent-line__frag')!;
    expect(frag.className).toContain('is-calm');
    expect(frag.textContent).toBe(`1${NB}failed, rerun passed`);
    expect(button.textContent).toContain('2 minutes 11 seconds');

    // Opened: step rows, each a native button; the failed row keeps its words, muted.
    fireEvent.click(button);
    const rows = [...bodyOf(button).querySelectorAll<HTMLButtonElement>('button.agent-line--step')];
    expect(rows.map((r) => shownLead(r))).toEqual(['Typecheck frontend', 'Run related unit tests', 'Run send-scroll E2E']);
    for (const el of container.querySelectorAll('[aria-expanded]')) expect(el.tagName).toBe('BUTTON');
    const failed = rows[2];
    expect(failed.textContent).toContain('rerun passed');
    expect(failed.querySelector('.agent-line__rest')?.className).not.toContain('is-error');
    // The command describes a row; it is not its name.
    expect(failed.getAttribute('aria-describedby')).toBe(failed.querySelector('.agent-line__rest')?.id);
    fireEvent.click(failed);
    const foot = bodyOf(failed).querySelector('.agent-line-payload__foot')!;
    expect(foot.textContent).toContain('exit 1');
    expect(foot.textContent).toContain('rerun passed');
    // Failure is marked in the footer only, not by tinting the output.
    expect(bodyOf(failed).querySelector('.agent-line-payload__out')?.className).not.toMatch(/danger|bad/);
  });

  it('finds recoveries across the groups of one turn (MessageBlock)', () => {
    const m: ChatMessage = {
      id: 'm1', role: 'assistant', text: '', streaming: false,
      toolCalls: [
        ...verify(),
        bash('t11', 'E2E_PORT=4317 npm run test:e2e -- e2e/specs/send-scroll.spec.ts', 'Rerun send-scroll E2E', { startedAt: T0 + 140_000, endedAt: T0 + 205_000 }),
      ],
      blocks: [
        { id: 'a1', kind: 'answer', rawText: 'Verifying.', streaming: false },
        { id: 'b8', kind: 'tool', toolCallId: 't8', section: 'answer', rawOffset: 10 },
        { id: 'b9', kind: 'tool', toolCallId: 't9', section: 'answer', rawOffset: 10 },
        { id: 'b10', kind: 'tool', toolCallId: 't10', section: 'answer', rawOffset: 10 },
        { id: 'a2', kind: 'answer', rawText: ' Port in use; rerunning.', streaming: false },
        { id: 'b11', kind: 'tool', toolCallId: 't11', section: 'answer', rawOffset: 34 },
        { id: 'a3', kind: 'answer', rawText: ' Done.', streaming: false },
      ],
    };
    const { container, getByRole } = render(withStyle(
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="compact" />,
    ));
    // The finished turn's work is folded; its row already counts the recovery.
    const fold = getByRole('button', { name: /Worked for/ });
    expect(fold.textContent).toContain('rerun passed');
    fireEvent.click(fold);
    const groups = [...container.querySelectorAll<HTMLElement>('.agent-line-group')];
    expect(groups).toHaveLength(2);
    expect(shownLead(groups[0])).toBe('Typecheck, a.test.ts and send-scroll E2E passed');
    expect(groups[0].textContent).toContain('rerun passed');
    // A run of one check says its fact.
    expect(shownLead(groups[1])).toBe('Ran send-scroll E2E');
  });
});

describe('line chrome · live', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  it('shows the spinner only after 200ms, keeps it spinning and counts whole seconds', () => {
    const running = bash('s1', 'npm test -w backend -- test/chatHub.replay.test.ts', 'Run backend replay tests', { status: 'running', startedAt: T0 });
    const { container } = render(withStyle(<ToolCallGroup tools={[running]} defaultExpanded />));
    expect(shownLead(container)).toBe('Run backend replay tests…');
    // The instruction names the step; what it runs is the detail.
    expect(shownRest(container)).toBe('npm test -w backend -- test/chatHub.replay.test.ts');
    expect(spinners(container)).toHaveLength(0);
    expect(header(container).hasAttribute('data-live')).toBe(true);

    act(() => { vi.advanceTimersByTime(250); });
    expect(spinners(container).map((el) => el.getAttribute('data-spinner'))).toEqual(['spinning']);
    // The run colour, not the accent: a red accent must not read as failed.
    expect(spinners(container)[0].querySelector('path')?.getAttribute('stroke')).toBe('var(--term-run)');
    expect(container.querySelector('.agent-line__meta')?.textContent).toBe('');

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(container.querySelector('.agent-line__meta [aria-hidden]')?.textContent).toBe('1s');

    act(() => { vi.advanceTimersByTime(4_000); });
    expect(container.querySelector('.agent-line__meta [aria-hidden]')?.textContent).toBe('5s');
    expect(container.querySelector('.agent-line__meta')?.textContent).toContain('5 seconds');
    // A long step never looks stalled: the spinner turns until the call ends.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(spinners(container).map((el) => el.getAttribute('data-spinner'))).toEqual(['spinning']);
    expect(shownLead(container)).toBe('Run backend replay tests…');
  });

  it('names a live call without an instruction by its command', () => {
    const running = bash('s2', './scripts/deploy.sh --fast', undefined, { status: 'running', startedAt: T0 });
    const { container } = render(withStyle(<ToolCallGroup tools={[running]} defaultExpanded />));
    expect(shownRest(container)).toBe('./scripts/deploy.sh --fast');
  });

  it('keeps each live label at least 400ms', () => {
    const a = read('a', 'src/a.ts', { status: 'running', startedAt: T0 });
    const { container, rerender } = render(withStyle(<ToolCallGroup tools={[a]} defaultExpanded />));
    expect(shownLead(container)).toBe('Read a.ts…');
    act(() => { vi.advanceTimersByTime(100); });
    const done = { ...a, status: 'completed', endedAt: T0 + 100 };
    const b = read('b', 'src/b.ts', { status: 'running', startedAt: T0 + 100 });
    rerender(withStyle(<ToolCallGroup tools={[done, b]} defaultExpanded />));
    expect(shownLead(container)).toBe('Read a.ts…');
    act(() => { vi.advanceTimersByTime(320); });
    expect(shownLead(container)).toBe('Read b.ts…');
    expect(shownRest(container)).toBe('read a.ts');
  });

  it('says “Working…” in a gap over 600ms while the group is the live tail, then settles', () => {
    const a = read('a', 'src/a.ts', { startedAt: T0 - 300, endedAt: T0 - 100 });
    const { container, rerender } = render(withStyle(<ToolCallGroup tools={[a]} defaultExpanded={false} live />));
    expect(shownLead(container)).toBe('Read a.ts…');
    act(() => { vi.advanceTimersByTime(600); });
    expect(shownLead(container)).toBe('Working…');
    rerender(withStyle(<ToolCallGroup tools={[a]} defaultExpanded={false} live={false} />));
    expect(shownLead(container)).toBe('Read a.ts');
    expect(header(container).hasAttribute('data-live')).toBe(false);
  });

  it('opened mid-run, the header says “Working…” and the running row owns the only spinner', () => {
    const tools = [read('a', 'src/a.ts', { startedAt: T0 - 2_000, endedAt: T0 - 1_000 }), read('b', 'src/b.ts', { status: 'running', startedAt: T0 - 1_000 })];
    const { container } = render(withStyle(<ToolCallGroup tools={tools} defaultExpanded />));
    expect(spinners(container)).toHaveLength(1);
    fireEvent.click(header(container));
    expect(shownLead(header(container))).toBe('Working…');
    expect(spinners(header(container))).toHaveLength(0);
    const rows = bodyOf(header(container)).querySelectorAll('button.agent-line--step');
    expect(rows).toHaveLength(2);
    expect(spinners(rows[1])).toHaveLength(1);
    expect(spinners(container)).toHaveLength(1);
  });
});

describe('line chrome · thinking', () => {
  it('live: “Thinking…” with the sentence being written', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { container } = render(withStyle(
      <TermThoughtBlock text="用户要把它合进 dev 再 push。先确认 origin/dev 有没有" streaming phase="thinking" startedAt={T0} />,
    ));
    expect(container.querySelector('[data-agent-block]')).not.toBeNull();
    expect(shownLead(container)).toBe('Thinking…');
    expect(shownRest(container)).toBe('用户要把它合进 dev 再 push。');
  });

  it('settled: “Thought for 3.1s” and its conclusion; a question falls back to the label', () => {
    const { container, unmount } = render(withStyle(
      <TermThoughtBlock text="先确认 origin/dev。测试只挑和发送动效有关的。" durationMs={3_100} />,
    ));
    const button = header(container);
    expect(shownLead(container)).toBe('Thought for 3.1s');
    expect(button.textContent).toContain('3.1 seconds');
    expect(shownRest(container)).toBe('测试只挑和发送动效有关的。');
    const body = bodyOf(button);
    expect(body.hidden).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(body.textContent).toContain('先确认 origin/dev。');
    unmount();

    const q = render(withStyle(<TermThoughtBlock text="Merged cleanly. Should I push now?" durationMs={2_000} />));
    expect(shownLead(q.container)).toBe('Thought for 2.0s');
    expect(shownRest(q.container)).toBe('');
  });

  it('an agent block lists step rows with the thought prose between them', () => {
    const m: ChatMessage = {
      id: 'm2', role: 'assistant', text: '', streaming: false,
      toolCalls: [
        read('r1', 'src/TPane.tsx', { startedAt: T0, endedAt: T0 + 200 }),
        bash('g1', 'git merge origin/dev --no-edit', 'Merge origin/dev', { startedAt: T0 + 1_000, endedAt: T0 + 1_900 }),
      ],
      blocks: [
        { id: 'th1', kind: 'thinking', rawText: 'Look first.', streaming: false, startedAt: T0 - 500, endedAt: T0 },
        { id: 'b1', kind: 'tool', toolCallId: 'r1', section: 'thinking', rawOffset: 11 },
        { id: 'th2', kind: 'thinking', rawText: 'Safe to merge.', streaming: false, startedAt: T0 + 300, endedAt: T0 + 1_000 },
        { id: 'b2', kind: 'tool', toolCallId: 'g1', section: 'thinking', rawOffset: 25 },
        { id: 'a1', kind: 'answer', rawText: 'Merged.', streaming: false, startedAt: T0 + 2_000, endedAt: T0 + 2_100 },
      ],
    };
    const { container } = render(withStyle(
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="compact" />,
    ));
    const block = container.querySelector<HTMLElement>('[data-agent-block]')!;
    expect(shownLead(block)).toBe('Read TPane.tsx, then merged origin/dev');
    expect(shownRest(block)).toBe('');
    expect(block.querySelector('.agent-line__ico svg')).not.toBeNull();
    fireEvent.click(header(block));
    const items = [...bodyOf(header(block)).querySelectorAll('.agent-line-steps > li')];
    expect(items.map((li) => (li.classList.contains('agent-line-steps__thought') ? `~${li.textContent}` : shownLead(li as HTMLElement))))
      .toEqual(['~Look first.', 'Read TPane.tsx', '~Safe to merge.', 'Merge origin/dev']);
    // Only calls carry a glyph; the prose between them has none.
    const thoughts = items.filter((li) => li.classList.contains('agent-line-steps__thought'));
    expect(thoughts.map((li) => li.querySelector('svg'))).toEqual([null, null]);
    // A row shows what it touched beside its name: the path, the command as typed.
    expect(items.filter((li) => !thoughts.includes(li)).map((li) => shownRest(li as HTMLElement))).toEqual(['src/TPane.tsx', 'git merge origin/dev --no-edit']);
  });
});

describe('line chrome · step area', () => {
  /** jsdom has no layout: the step area is `client` tall and holds `scroll`. */
  function stepArea(scroll: number, client: number) {
    const isArea = (el: Element) => el.classList.contains('agent-line-steps-scroll');
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return isArea(this) ? scroll : 0; });
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return isArea(this) ? client : 0; });
    return () => { sh.mockRestore(); ch.mockRestore(); };
  }
  const many = (n: number, extra: Partial<ToolCallState> = {}) =>
    Array.from({ length: n }, (_, i) => read(`r${i}`, `src/f${i}.ts`, { startedAt: T0 + i * 100, endedAt: T0 + i * 100 + 50, ...extra }));

  it('shows an opened run’s steps under its words, in an area that scrolls and fades the edge that hides more', () => {
    const restore = stepArea(400, 148);
    try {
      const { container } = render(withStyle(<ToolCallGroup tools={many(12)} defaultExpanded={false} />));
      fireEvent.click(header(container));
      const area = bodyOf(header(container)).querySelector<HTMLElement>('.agent-line-stepbox > .agent-line-steps-scroll')!;
      expect(area.querySelectorAll('button.agent-line--step')).toHaveLength(12);
      // A settled run opens at its first step; more waits below.
      expect(area.scrollTop).toBe(0);
      expect(area.getAttribute('data-more')).toBe('down');
      expect(area.getAttribute('role')).toBe('region');
      expect(area.getAttribute('aria-label')).toBe('Steps');
      expect(area.tabIndex).toBe(0);
      area.scrollTop = 120;
      fireEvent.scroll(area);
      expect(area.getAttribute('data-more')).toBe('up down');
      area.scrollTop = 252;
      fireEvent.scroll(area);
      expect(area.getAttribute('data-more')).toBe('up');
    } finally {
      restore();
    }
  });

  it('adds no region or tab stop when every step shows', () => {
    const restore = stepArea(96, 96);
    try {
      const { container } = render(withStyle(<ToolCallGroup tools={many(3)} defaultExpanded={false} />));
      fireEvent.click(header(container));
      const area = bodyOf(header(container)).querySelector<HTMLElement>('.agent-line-steps-scroll')!;
      expect(area.hasAttribute('data-more')).toBe(false);
      expect(area.hasAttribute('role')).toBe(false);
      expect(area.hasAttribute('tabindex')).toBe(false);
    } finally {
      restore();
    }
  });

  it('follows a live run’s newest step until the reader scrolls up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 5_000);
    const restore = stepArea(400, 148);
    try {
      const done = many(10);
      const running = read('live1', 'src/live1.ts', { status: 'running', startedAt: T0 + 4_000 });
      const { container, rerender } = render(withStyle(<ToolCallGroup tools={[...done, running]} defaultExpanded={false} />));
      fireEvent.click(header(container));
      const area = () => bodyOf(header(container)).querySelector<HTMLElement>('.agent-line-steps-scroll')!;
      expect(area().scrollTop).toBe(400);
      // The reader scrolls up: a new step no longer pulls the list down.
      area().scrollTop = 0;
      fireEvent.scroll(area());
      const next = read('live2', 'src/live2.ts', { status: 'running', startedAt: T0 + 4_500 });
      rerender(withStyle(<ToolCallGroup tools={[...done, { ...running, status: 'completed', endedAt: T0 + 4_500 }, next]} defaultExpanded={false} />));
      expect(area().scrollTop).toBe(0);
      // Back at the end, it follows again.
      area().scrollTop = 252;
      fireEvent.scroll(area());
      const last = read('live3', 'src/live3.ts', { status: 'running', startedAt: T0 + 4_800 });
      rerender(withStyle(<ToolCallGroup tools={[...done, { ...running, status: 'completed', endedAt: T0 + 4_500 }, { ...next, status: 'completed', endedAt: T0 + 4_800 }, last]} defaultExpanded={false} />));
      expect(area().scrollTop).toBe(400);
    } finally {
      restore();
    }
  });
});

describe('line chrome · subagents', () => {
  it('keeps the delegation line (subagent-card / subagent-summary) with its status word', () => {
    const agent: ToolCallState = {
      id: 'sa', title: 'Task', kind: 'tool', status: 'running',
      inputJson: JSON.stringify({ subagent_type: 'Explore', description: 'Find every caller of anchorComposer' }),
    };
    const { getByTestId } = render(withStyle(<ToolCallGroup tools={[agent]} defaultExpanded />));
    const card = getByTestId('subagent-card');
    const line = within(card).getByTestId('subagent-summary');
    expect(line.textContent).toContain('Explore');
    expect(line.textContent).toContain('Find every caller of anchorComposer');
    expect(line.textContent).toContain('working');
  });
});

describe('verbatim mono in every chrome', () => {
  it.each(['card', 'terminal', 'plain'] as const)('switches ligatures off for command detail (%s)', (style) => {
    const tool: ToolCallState = {
      id: 't1', title: 'Bash', kind: 'bash', status: 'completed', startedAt: T0, endedAt: T0 + 100,
      inputJson: JSON.stringify({ __tool_use_purpose: 'Count divergence', command: 'git rev-list --left-right --count dev...origin/dev' }),
    };
    const { container } = render(withStyle(<ToolCallGroup tools={[tool, read('r', 'a.ts')]} defaultExpanded />, style));
    const detail = [...container.querySelectorAll('.agent-verbatim')].find((el) => el.textContent?.includes('--count'));
    expect(detail).toBeTruthy();
  });
});

describe('one tool kind in every chrome', () => {
  it.each(['card', 'terminal', 'plain'] as const)('does not call Pi\'s web searches commands (%s)', (style) => {
    const search = (id: string, query: string): ToolCallState => ({
      id, title: 'web_search', kind: 'execute', status: 'completed', startedAt: T0, endedAt: T0 + 100, inputJson: JSON.stringify({ query }),
    });
    const tools = [search('1', 'a'), search('2', 'b'), search('3', 'c')];
    const folded = render(withStyle(<ToolCallGroup tools={tools} defaultExpanded={false} />, style));
    expect(folded.container.textContent).toMatch(/used 3 tools/i);
    folded.unmount();
    const { container } = render(withStyle(<ToolCallGroup tools={tools} defaultExpanded />, style));
    expect(container.textContent).not.toMatch(/ran 3 commands|Bash/i);
  });
});

describe('StreamActivityIndicator · line chrome', () => {
  const node = (blocks: ChatMessage['blocks'], toolCalls: ToolCallState[]): ChatNodeState => ({
    status: 'streaming',
    messages: [{ id: 'm', role: 'assistant', text: '', streaming: true, blocks, toolCalls }],
  } as unknown as ChatNodeState);

  it('stays silent while the live tool row owns a gap, and speaks otherwise', () => {
    const n = node([
      { id: 'a1', kind: 'answer', rawText: 'Checking.', streaming: false },
      { id: 'b1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 9 },
    ], [read('t1', 'a.ts')]);
    expect(deriveStreamActivity(n, { showThoughts: true, agentBlockStyle: 'line' })).toBeNull();
    expect(deriveStreamActivity(n, { showThoughts: true, agentBlockStyle: 'card' })?.label).toBe('Working');
    const hiddenOnly = node([
      { id: 'a1', kind: 'answer', rawText: 'Done.', streaming: false },
      { id: 'b1', kind: 'tool', toolCallId: 'h', section: 'answer', rawOffset: 5 },
    ], [{ id: 'h', title: 'set_follow_ups', status: 'completed' }]);
    expect(deriveStreamActivity(hiddenOnly, { showThoughts: true, agentBlockStyle: 'line' })?.label).toBe('Working');
  });

  it('keeps the newest tool group of a streaming turn live between calls (MessageBlock)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const m: ChatMessage = {
      id: 'm3', role: 'assistant', text: '', streaming: true,
      toolCalls: [read('t1', 'src/a.ts', { startedAt: T0 - 900, endedAt: T0 - 700 })],
      blocks: [
        { id: 'a1', kind: 'answer', rawText: 'Checking.', streaming: false },
        { id: 'b1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 9 },
      ],
    };
    const { container } = render(withStyle(
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="compact" hideActions />,
    ));
    const group = container.querySelector<HTMLElement>('.agent-line-group')!;
    expect(header(group).hasAttribute('data-live')).toBe(true);
    expect(shownLead(group)).toBe('Working…');
  });
});

describe('line chrome · settled sentence', () => {
  it('fits the sentence by dropping whole phrases into +N, keeping every phrase for screen readers', () => {
    const many: ToolCallState[] = [
      bash('d1', 'git diff --stat dev...origin/dev', 'Show files origin/dev changed'),
      read('r1', 'frontend/src/a.ts'), read('r2', 'frontend/src/b.ts'), read('r3', 'frontend/src/c.ts'),
      bash('m1', 'git merge origin/dev --no-edit', 'Merge origin/dev'),
      bash('t1', 'npm test -w frontend -- src/a.test.ts src/b.test.tsx', 'Run related unit tests'),
    ];
    // jsdom has no layout: give the line 300px and the text 7px per character.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-line__lead') ? 300 : 0;
    });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const w = this.classList.contains('agent-line__measure') ? (this.textContent ?? '').length * 7 : 0;
      return { width: w, height: 20, top: 0, left: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const { container } = render(withStyle(<ToolCallGroup tools={many} defaultExpanded={false} />));
      const lead = container.querySelector<HTMLElement>('.agent-line__lead.is-sentence')!;
      // 300px holds 42 characters: what the run looked at goes first; the merge and the checks stay.
      expect(shownLead(container)).toBe(`Merged origin/dev; 2${NB}test files passed${NB}+1`);
      expect(lead.querySelector('.sr-only')!.textContent)
        .toBe(`Explored 3${NB}files and 1${NB}command, then merged origin/dev; 2${NB}test files passed`);
      expect(lead.querySelector('.agent-line__sentence')!.getAttribute('title')).toBe(lead.querySelector('.sr-only')!.textContent);
    } finally {
      width.mockRestore();
      rect.mockRestore();
    }
  });
});
