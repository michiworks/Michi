// Locks the role-differentiation styling contract for MessageBlock.
// User: right-aligned paper-card bubble with no role/time label; surface +
//   drop shadow + 72% max-width live in index.css (.terminal-message-user),
//   not inline. The time shows only in the hover action row.
// Assistant: flush-left, no border, no fill, no speaker line; one meta line
//   (copy / retry / branch, time · tokens) under it.
// Asserts on inline style strings because jsdom doesn't resolve var()/color-mix()/calc().
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, fireEvent, screen, waitFor } from '@testing-library/react';
import { MessageBlock, TermThoughtBlock, userTextToMarkdown } from './MessageBlock';
import { kbd } from '../../lib/platform';
import { AgentBlockStyleOverride } from '../../state/prefs';
import { recordBackendObservation, resetBackendClocksForTest } from '../../services/backendClock';
import type { AssistantBlock, ChatMessage } from '../../state/chatTypes';
import { rememberRuntimeLabels, resetSkillCatalogs } from '../../state/skillCatalog';

const baseMsg = {
  id: 'm1',
  role: 'user' as const,
  text: 'hello',
  toolCalls: [],
  streaming: false,
} satisfies Partial<ChatMessage> as ChatMessage;

const noop = () => {};

function renderMessage(
  overrides: Partial<ChatMessage>,
  extraProps?: {
    isErrorTail?: boolean;
    onRetry?: () => void;
    errorMessage?: string;
    usageInfo?: React.ComponentProps<typeof MessageBlock>['usageInfo'];
  },
) {
  return render(
    <MessageBlock
      m={{ ...baseMsg, ...overrides }}
      index={0}
      isDark={false}
      // Only pass onRetry when explicitly provided so MessageActions doesn't
      // render its own hover-retry button in tests that only care about the
      // error-tail row.
      onRetry={extraProps?.onRetry}
      onEdit={noop}
      copyText={() => ''}
      showThoughts={false}
      fontFamily={'inherit'}
      density={'comfortable'}
      usageInfo={extraProps?.usageInfo}
      isErrorTail={extraProps?.isErrorTail}
      errorMessage={extraProps?.errorMessage}
    />,
  );
}

describe('MessageBlock — role styling', () => {
  it('marks a relayed thread message and links to the sending thread', () => {
    const onMentionClick = vi.fn();
    const { container, getByRole } = render(
      <MessageBlock
        m={{ ...baseMsg, text: 'Please review', threadMessage: { fromNodeId: 'n-a', fromTitle: 'Research notes' } }}
        index={0}
        isDark={false}
        onEdit={noop}
        copyText={() => ''}
        showThoughts={false}
        fontFamily={'inherit'}
        density={'comfortable'}
        onMentionClick={onMentionClick}
      />,
    );
    const marker = container.querySelector('.terminal-message-thread-source');
    expect(marker?.textContent).toBe('From Research notes');
    expect(container.querySelector('.terminal-message-user')?.textContent).toContain('Please review');
    fireEvent.click(getByRole('button', { name: 'Research notes' }));
    expect(onMentionClick).toHaveBeenCalledWith('Research notes', 'node', 'n-a');
  });

  it('marks a woken thread reply as the other thread\'s reply', () => {
    const { container } = renderMessage({
      text: 'The API section looks right.',
      threadMessage: { fromNodeId: 'n-b', fromTitle: 'Implementation', kind: 'reply', hop: 2 },
    });
    const marker = container.querySelector('.terminal-message-thread-source');
    expect(marker?.textContent).toBe('Reply from Implementation');
    expect(marker?.getAttribute('title')).toMatch(/answer to a message this thread sent/);
    expect(container.querySelector('.terminal-message-user')?.textContent).toContain('The API section looks right.');
  });

  it('marks a message that ran a skill with where the skill came from, by the label its backend gave the runtime', () => {
    const { container } = renderMessage({
      text: '/review the diff',
      skill: { id: 'library:review', name: 'review', origin: 'library', args: 'the diff' },
    });
    const chip = container.querySelector('.terminal-message-skill');
    expect(chip?.textContent).toBe('Skill · Michi');
    expect(chip?.getAttribute('title')).toBe('Ran the review skill');
    expect(container.querySelector('.terminal-message-user')?.textContent).toContain('/review the diff');
    const builtin = renderMessage({ text: '/compare queues', skill: { id: 'builtin:compare', name: 'compare', origin: 'builtin', args: 'queues' } });
    expect(builtin.container.querySelector('.terminal-message-skill')?.textContent).toBe('Skill · Built-in');
    const runtime = renderMessage({ text: '/deploy', skill: { id: 'runtime:acme:user:deploy', name: 'deploy', origin: 'runtime', runtimeId: 'acme', args: '' } });
    const caption = () => runtime.container.querySelector('.terminal-message-skill')?.textContent;
    expect(caption()).toBe('Skill · acme');
    act(() => { rememberRuntimeLabels('local', [{ id: 'acme', label: 'Acme Agent' }]); });
    expect(caption()).toBe('Skill · Acme Agent');
    resetSkillCatalogs();
  });
});

describe('userTextToMarkdown', () => {
  it('keeps every line break outside code and leaves a nested code example untouched', () => {
    expect(userTextToMarkdown('one\ntwo\n````md\n```js\nx\n```\n````\nthree\nfour'))
      .toBe('one  \ntwo  \n````md\n```js\nx\n```\n````\nthree  \nfour');
  });

  it('leaves a code block indented inside a list item untouched', () => {
    expect(userTextToMarkdown('1. Run it:\n    ```sh\n    npm test\n    npm run build\n    ```\n2. Done'))
      .toBe('1. Run it:  \n    ```sh\n    npm test\n    npm run build\n    ```\n2. Done');
  });
});

describe('MessageBlock — answer meta line', () => {
  const answerProps = {
    index: 0, isDark: false, copyText: () => '', onRetry: noop, onBranch: noop, onEdit: noop, showThoughts: false,
    fontFamily: 'inherit', density: 'comfortable' as const,
  };
  const answer = { ...baseMsg, role: 'assistant' as const, text: 'The answer', createdAt: new Date(2026, 7, 18, 16, 35).getTime() };
  const actionsOf = (container: HTMLElement) => container.querySelector('.t-answer-meta .t-msg-actions') as HTMLElement;

  it('shows native Codex token usage on the line, with the breakdown in its tooltip', () => {
    const { getByTestId } = renderMessage(
      { role: 'assistant', text: 'done', streaming: false },
      {
        usageInfo: {
          durationMs: 9_700,
          credits: 0,
          totalTokens: 1_534,
          inputTokens: 1_234,
          cachedInputTokens: 800,
          outputTokens: 300,
          reasoningOutputTokens: 120,
          contextUsagePercentage: 12.5,
        },
      },
    );
    const usage = getByTestId('turn-usage');
    expect(usage.textContent).toBe('1.5k tokens');
    const title = (usage.closest('[title]') as HTMLElement).title;
    expect(title).toContain('Duration 9.7 seconds');
    expect(title).toContain('1,234 input tokens');
    expect(title).toContain('800 cached input tokens');
    expect(title).toContain('12.5% context used');
  });

  it('is one 12px line: copy, retry and branch, then time · tokens, and no speaker line above the answer', () => {
    const { container, getByRole, queryByRole } = render(
      <MessageBlock {...answerProps} m={answer} usageInfo={{ totalTokens: 46_000 }} />,
    );
    expect(container.textContent).not.toContain('> michi');
    const root = container.firstElementChild!;
    expect(root.firstElementChild!.classList.contains('terminal-message-assistant')).toBe(true);
    const line = container.querySelector('.t-answer-meta')!;
    const buttons = [...line.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['copy message', 'retry this turn', 'branch from here']);
    // Edit belongs to the user's message.
    expect(queryByRole('button', { name: 'edit and resend' })).toBeNull();
    const parts = [...line.querySelectorAll('.t-answer-meta__part')].map((p) => p.textContent);
    expect(parts).toEqual([expect.stringMatching(/^(8\/18 )?16:35$/), '46k tokens']);
    expect(line.contains(getByRole('button', { name: 'copy message' }))).toBe(true);
  });

  it('shows only what the answer has', () => {
    const { container } = render(<MessageBlock {...answerProps} m={{ ...answer, createdAt: undefined }} usageInfo={{ durationMs: 1_000 }} />);
    expect(container.querySelector('.t-answer-meta__text')).toBeNull();
    expect(container.querySelector('.t-answer-meta button[aria-label="copy message"]')).not.toBeNull();
  });

  it('stays shown under the latest answer and waits for a hover under earlier ones', () => {
    const latest = render(<MessageBlock {...answerProps} m={answer} pinned />);
    expect(actionsOf(latest.container).style.opacity).toBe('1');
    expect(actionsOf(latest.container).style.pointerEvents).toBe('auto');
    latest.unmount();
    const earlier = render(<MessageBlock {...answerProps} m={answer} />);
    const actions = actionsOf(earlier.container);
    expect(actions.style.opacity).toBe('0');
    expect(actions.style.pointerEvents).toBe('none');
    fireEvent.mouseOver(earlier.container.querySelector('.terminal-message-assistant')!);
    expect(actions.style.opacity).toBe('1');
  });

  it('keeps its buttons in the tab order while hidden, so keyboard focus can reveal them (index.css :has(:focus-visible))', () => {
    const { container } = render(<MessageBlock {...answerProps} m={answer} />);
    for (const button of container.querySelectorAll<HTMLButtonElement>('.t-answer-meta button')) {
      expect(button.tabIndex).toBe(0);
      expect(button.disabled).toBe(false);
    }
  });

  it('shows no meta line while the answer streams', () => {
    const { container } = render(<MessageBlock {...answerProps} m={{ ...answer, streaming: true }} pinned />);
    expect(container.querySelector('.t-answer-meta')).toBeNull();
    const tail = render(<MessageBlock {...answerProps} m={answer} hideActions pinned />);
    expect(tail.container.querySelector('.t-answer-meta')).toBeNull();
  });
});

describe('MessageBlock — actions at rest', () => {
  function renderReply(actionsAtRest: boolean) {
    return render(
      <MessageBlock
        m={{ ...baseMsg, role: 'assistant', text: 'done' }}
        index={0}
        isDark={false}
        onRetry={noop}
        copyText={() => ''}
        onBranch={noop}
        showThoughts={false}
        fontFamily={'inherit'}
        density={'comfortable'}
        actionsAtRest={actionsAtRest}
      />,
    );
  }

  it('marks only the latest reply for touch screens to show without a tap', () => {
    const latest = renderReply(true);
    const row = latest.container.querySelector('[data-msg-actions]');
    expect(row?.getAttribute('data-msg-actions')).toBe('rest');
    // Hidden for a mouse until hover; index.css reveals it on touch.
    expect((latest.container.querySelector('.t-msg-actions') as HTMLElement).style.opacity).toBe('0');
    latest.unmount();

    const older = renderReply(false);
    expect(older.container.querySelector('[data-msg-actions]')).toBeNull();
  });
});

describe('MessageBlock — error-tail row', () => {
  it('renders the friendly error message when provided', () => {
    const msg = 'Claude slots are busy. Stop a running reply or wait for one to finish, then retry.';
    const { getByText } = renderMessage(
      { role: 'assistant', text: '' },
      { isErrorTail: true, onRetry: noop, errorMessage: msg },
    );
    expect(getByText(msg)).not.toBeNull();
  });

  it('calls onRetry when the error-tail retry button is clicked', () => {
    const onRetry = vi.fn();
    const { getByTestId } = renderMessage(
      { role: 'assistant', text: 'something went wrong' },
      { isErrorTail: true, onRetry },
    );
    fireEvent.click(getByTestId('error-tail-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves no hover tint on Test Connection once a test the pointer left finishes', async () => {
    let finish!: (result: { ok: boolean }) => void;
    const { getByTestId } = render(
      <MessageBlock
        m={{ ...baseMsg, role: 'assistant', text: 'cannot connect' }}
        index={0} isDark={false} onEdit={noop} copyText={() => ''} showThoughts={false}
        fontFamily="inherit" density="comfortable"
        isErrorTail errorKind="connection"
        onTestConnection={() => new Promise((resolve) => { finish = resolve; })}
      />,
    );
    const button = getByTestId('error-tail-test-connection');
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    await act(async () => { finish({ ok: false }); });
    expect(button.textContent).toBe('⚙ Test Connection');
    expect(button.style.background).not.toContain('danger');
  });
});

describe('MessageBlock — highlight frame', () => {
  const props = {
    index: 0, isDark: false, onEdit: noop, copyText: () => '', onRetry: noop, showThoughts: false,
    fontFamily: 'inherit', density: 'comfortable' as const,
  };
  const reply = { ...baseMsg, role: 'assistant' as const, text: 'The cited reply' };
  const mark = <div data-testid="mark">Referenced by page</div>;

  it('frames the mark and the message, and keeps the hover actions under the frame', () => {
    const { container, getByTestId, getByRole } = render(<MessageBlock {...props} m={reply} highlight={mark} />);
    const frame = container.querySelector('.terminal-message-highlight')!;
    expect(frame.firstElementChild).toBe(getByTestId('mark'));
    expect(frame.textContent).toContain('The cited reply');
    const copy = getByRole('button', { name: 'copy message' });
    // Nothing of the reserved actions row sits inside the frame, so its bottom is the message's.
    expect(frame.contains(copy)).toBe(false);
    expect(frame.lastElementChild!.classList.contains('terminal-message-assistant')).toBe(true);
    const actions = copy.parentElement!;
    expect(actions.style.opacity).toBe('0');
    fireEvent.mouseEnter(frame.parentElement!);
    expect(actions.style.opacity).toBe('1');
    fireEvent.mouseEnter(copy);
    expect(actions.style.opacity).toBe('1');
  });

  it('leaves a message that is not highlighted as it was', () => {
    const { container, getByRole } = render(<MessageBlock {...props} m={reply} />);
    expect(container.querySelector('.terminal-message-highlight')).toBeNull();
    const root = container.firstElementChild!;
    expect(root.firstElementChild!.classList.contains('terminal-message-assistant')).toBe(true);
    expect(root.contains(getByRole('button', { name: 'copy message' }))).toBe(true);
  });
});

describe('MessageBlock — copy', () => {
  const reply = { ...baseMsg, role: 'assistant' as const, text: 'The reply' };
  afterEach(() => { vi.unstubAllGlobals(); });
  const press = async (copyText: () => string) => {
    const view = render(
      <MessageBlock m={reply} index={0} isDark={false} copyText={copyText} showThoughts={false} fontFamily="inherit" density="comfortable" />,
    );
    const button = view.getByRole('button', { name: 'copy message' });
    await act(async () => { fireEvent.click(button); });
    return { view, button };
  };

  it('ticks only once the text is on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { view, button } = await press(() => 'run text');
    expect(writeText).toHaveBeenCalledWith('run text');
    expect(button.querySelector('path')!.getAttribute('d')).toBe('M3 8.5l3.5 3.5L13 5');
    expect(view.getByRole('status').textContent).toBe('Copied');
  });

  it('says so instead of ticking when the browser has no clipboard here', async () => {
    vi.stubGlobal('navigator', {});
    const { view, button } = await press(() => 'run text');
    expect(button.querySelector('path')!.getAttribute('d')).not.toBe('M3 8.5l3.5 3.5L13 5');
    expect(view.getByRole('status').textContent).toMatch(/Couldn’t copy/);
  });
});

describe('MessageBlock — user modules', () => {
  it('renders one AttachmentPill per attachment', () => {
    const { container } = renderMessage({
      role: 'user',
      text: 'check these',
      attachments: [
        { name: 'a.tsx', absPath: '/a.tsx' },
        { name: 'b.tsx', absPath: '/b.tsx' },
      ],
    });
    expect(container.querySelectorAll('[data-testid="attachment-pill"]').length).toBe(2);
  });

  it('renders one CommentChip per comment', () => {
    const { container } = renderMessage({
      role: 'user',
      text: 'follow up',
      comments: [
        { id: 'c1', quotedText: 'q1', body: 'b1', createdAt: 0 },
        { id: 'c2', quotedText: 'q2', body: 'b2', createdAt: 0 },
      ],
    });
    expect(container.querySelectorAll('[data-testid="comment-quote"]').length).toBe(2);
  });

  it('floats its action row and lets pointers through it until the message is hovered', () => {
    const { container, getByRole } = renderMessage({ role: 'user', text: 'hello' });
    const root = container.firstElementChild as HTMLElement;
    const row = container.querySelector('.t-user-msg-actions') as HTMLElement;
    // The row is positioned against the message and laid over the next
    // message's first line, so while hidden it must not take that line's clicks.
    expect(root.style.position).toBe('relative');
    expect(row.style.pointerEvents).toBe('none');
    fireEvent.mouseEnter(root);
    expect(row.style.pointerEvents).toBe('');
    expect(row.contains(getByRole('button', { name: 'edit and resend' }))).toBe(true);
    fireEvent.mouseLeave(root);
    expect(row.style.pointerEvents).toBe('none');
  });
});

describe('MessageBlock — editing a sent message', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves an Esc that ends an IME composition to it (%o)', (ime) => {
    const onEditCancel = vi.fn();
    const onEditSave = vi.fn();
    const { container } = render(
      <MessageBlock
        m={baseMsg}
        index={0}
        isDark={false}
        onEdit={noop}
        copyText={() => ''}
        showThoughts={false}
        fontFamily={'inherit'}
        density={'comfortable'}
        editing
        onEditCancel={onEditCancel}
        onEditSave={onEditSave}
      />,
    );
    const area = container.querySelector('textarea.user-edit-area') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'hello 修改' } });
    fireEvent.keyDown(area, { key: 'Escape', ...ime });
    expect(onEditCancel).not.toHaveBeenCalled();
    expect(area.value).toBe('hello 修改');
    fireEvent.keyDown(area, { key: 'Escape' });
    expect(onEditCancel).toHaveBeenCalledTimes(1);
    expect(onEditSave).not.toHaveBeenCalled();
  });

  it('labels Save with the key that saves', () => {
    const onEditSave = vi.fn();
    const { container } = render(
      <MessageBlock
        m={baseMsg}
        index={0}
        isDark={false}
        onEdit={noop}
        copyText={() => ''}
        showThoughts={false}
        fontFamily={'inherit'}
        density={'comfortable'}
        editing
        onEditCancel={noop}
        onEditSave={onEditSave}
      />,
    );
    const area = container.querySelector('textarea.user-edit-area') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'hello again' } });
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onEditSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Save/ }).querySelector('kbd')?.textContent).toBe(kbd('mod', 'enter'));
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(onEditSave).toHaveBeenCalledWith('hello again');
  });
});

describe('MessageBlock — subagents forwarding', () => {
  it('renders the SubAgent spine row and now line when matching subagents are passed', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const subagentTool = {
      id: 't1',
      title: 'Agent',
      status: 'in_progress',
      kind: 'tool',
      detail,
    };
    const m = {
      ...baseMsg,
      role: 'assistant' as const,
      text: '',
      toolCalls: [subagentTool],
      blocks: [
        { id: 'a1', kind: 'answer' as const, rawText: '' },
        {
          id: 'b1',
          kind: 'tool' as const,
          toolCallId: 't1',
          section: 'answer' as const,
          rawOffset: 0,
        },
      ],
    } as ChatMessage;

    const { getByTestId, container } = render(
      <MessageBlock
        m={m}
        index={0}
        isDark={true}
        copyText={() => ''}
        showThoughts={true}
        fontFamily="monospace"
        density="comfortable"
        subagents={[
          {
            sessionId: 's1',
            sessionName: 's1',
            agentName: 'Explore',
            initialQuery: 'Explore Michi',
            status: 'working',
            group: 'g',
            dependsOn: [],
            currentTool: 'Glob',
          },
        ]}
      />,
    );
    expect(getByTestId('subagent-spine-row')).toBeTruthy();
    expect(container.textContent).toContain('now ❯ Glob');
  });
});

describe('MessageBlock — collapsed user text', () => {
  it('fades only the clamped content and keeps the expansion control outside the overlay', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    try {
      const { container, getByRole } = renderMessage({ role: 'user', text: 'A long message that overflows the measured preview.' });
      const toggle = getByRole('button', { name: 'Show more' });
      const content = container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`) as HTMLElement;
      const fade = content.querySelector<HTMLElement>('[aria-hidden="true"]');
      expect(content.style.maxHeight).not.toBe('');
      expect(content.style.position).toBe('relative');
      expect(fade?.parentElement).toBe(content);
      expect(content.contains(toggle)).toBe(false);
      expect(toggle.classList.contains('t-user-text-toggle')).toBe(true);
      expect(toggle.style.color).toBe('');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
      expect(content.querySelector('[aria-hidden="true"]')).toBeNull();
      expect(content.style.maxHeight).toBe('');
      fireEvent.click(toggle);
      expect(content.querySelector('[aria-hidden="true"]')).toBeTruthy();
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it('opens and closes as a height disclosure that moves in the click’s own commit', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    try {
      const { container, getByRole } = renderMessage({ role: 'user', text: 'A long message that overflows the measured preview.' });
      const toggle = getByRole('button', { name: 'Show more' });
      const content = container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`) as HTMLElement;
      const clamp = parseFloat(content.style.maxHeight);
      expect(clamp).toBeGreaterThan(0);
      let shown = clamp;
      const box = vi.spyOn(content, 'getBoundingClientRect').mockImplementation(
        () => ({ height: shown, width: 400, top: 0, left: 0, right: 400, bottom: shown, x: 0, y: 0, toJSON() {} }) as DOMRect,
      );
      const probe = document.createElement('div');
      const heights = new MutationObserver(() => {});
      heights.observe(content, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      const heightsSoFar = () => heights.takeRecords().flatMap((r) => {
        probe.setAttribute('style', r.oldValue ?? '');
        return [probe.style.height, content.style.height].filter(Boolean);
      });

      fireEvent.click(toggle);
      // The first frame is already 1px taller than the clamp: TPane sees the
      // transcript change in this commit and leaves follow mode.
      expect(heightsSoFar()).toContain(`${clamp + 1}px`);
      expect(content.style.maxHeight).toBe('');
      await waitFor(() => expect(content.style.height).toBe(''));

      shown = 500;
      fireEvent.click(getByRole('button', { name: 'Show less' }));
      expect(heightsSoFar()).toContain('499px');
      // Clamped again once the height has come down.
      await waitFor(() => expect(content.style.maxHeight).toBe(`${clamp}px`));
      expect(content.style.height).toBe('');
      heights.disconnect();
      box.mockRestore();
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });

  it('does not clamp while the pane has no width yet', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { queryByRole } = renderMessage({ role: 'user', text: 'A short message in a pane that is still opening.' });
      expect(queryByRole('button', { name: 'Show more' })).toBeNull();
    } finally {
      height.mockRestore();
    }
  });
});

describe('MessageBlock — branch anchors motion', () => {
  const reply = { ...baseMsg, id: 'a1', role: 'assistant' as const, text: 'An answer' };
  const anchor = (childNodeId: string, createdAt: number) =>
    ({ childNodeId, title: `Branch ${childNodeId}`, messageCount: 1, createdAt, status: 'idle' as const });
  const block = (anchors: ReturnType<typeof anchor>[]) => (
    <MessageBlock
      m={reply} index={0} isDark={false} onEdit={noop} copyText={() => ''} showThoughts={false}
      fontFamily="inherit" density="comfortable" turnAnchors={anchors} onOpenBranch={noop}
    />
  );
  const sectionOf = (container: HTMLElement) =>
    container.querySelector('section[aria-label="Branches from this reply"]') as HTMLElement;
  const grows = (el: HTMLElement | null) => el?.parentElement?.style.display === 'flow-root';

  it('renders branches made earlier settled', () => {
    const { container } = render(block([anchor('b1', Date.now() - 60_000)]));
    expect(grows(sectionOf(container))).toBe(false);
  });

  it('grows the list in when its first branch was made just now', () => {
    const { container } = render(block([anchor('b1', Date.now())]));
    expect(grows(sectionOf(container))).toBe(true);
    // One entrance: the row inside the growing list does not grow again.
    expect(grows(sectionOf(container).querySelector('.t-branch-anchor-row'))).toBe(false);
  });

  it('a new branch on an existing list grows in as its own row', () => {
    const { container, rerender } = render(block([anchor('b1', Date.now() - 60_000)]));
    rerender(block([anchor('b1', Date.now() - 60_000), anchor('b2', Date.now())]));
    const rows = sectionOf(container).querySelectorAll<HTMLElement>('.t-branch-anchor-row');
    expect(grows(sectionOf(container))).toBe(false);
    expect(grows(rows[0])).toBe(false);
    expect(grows(rows[1])).toBe(true);
    expect(sectionOf(container).querySelector('h3')?.textContent).toBe('Branches 2');
  });
});

describe('MessageBlock — user message markdown', () => {
  it('renders inline markdown instead of literal markers', () => {
    const { container } = renderMessage({ role: 'user', text: 'This is **bold** and `code`' });
    const strong = container.querySelector('.terminal-message-user strong');
    expect(strong?.textContent).toBe('bold');
    const code = container.querySelector('.terminal-message-user code');
    expect(code?.textContent).toBe('code');
    expect(container.textContent).not.toContain('**');
  });

  it('preserves single newlines as hard breaks', () => {
    const { container } = renderMessage({ role: 'user', text: 'line1\nline2' });
    expect(container.querySelector('.terminal-message-user br')).toBeTruthy();
    expect(container.textContent).toContain('line1');
    expect(container.textContent).toContain('line2');
  });

  it('renders fenced code blocks without mangling their content', () => {
    const { container } = renderMessage({ role: 'user', text: '```\nconst x = 1;\n```' });
    const pre = container.querySelector('.terminal-message-user pre');
    expect(pre?.textContent).toContain('const x = 1;');
  });
});

describe('MessageBlock — expanded activity scroll', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['card', 'terminal', 'plain'] as const)('preserves reading position and resumes following at the bottom (%s)', (variant) => {
    let height = 1000;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const view = (text: string, streaming = true) => <AgentBlockStyleOverride.Provider value={variant}>
      <TermThoughtBlock text={text} streaming={streaming} initialMode="expanded" />
    </AgentBlockStyleOverride.Provider>;
    const { getByRole, rerender } = render(view('First step'));
    const activity = getByRole('region', { name: 'Activity details' });
    expect(activity.tabIndex).toBe(0);
    expect(activity.style.overflowY).toBe('auto');
    expect(activity.scrollTop).toBe(1000);

    activity.scrollTop = 120;
    fireEvent.scroll(activity);
    height = 1200;
    rerender(view('First step\nNext step'));
    expect(activity.scrollTop).toBe(120);

    activity.scrollTop = 900;
    fireEvent.scroll(activity);
    height = 1400;
    rerender(view('First step\nNext step\nLatest step'));
    expect(activity.scrollTop).toBe(1400);

    activity.scrollTop = 160;
    fireEvent.scroll(activity);
    rerender(view('First step\nNext step\nLatest step', false));
    expect(activity.scrollTop).toBe(160);
    expect(getByRole('region', { name: 'Activity details' })).toBe(activity);
  });

  it('opens completed activity from the start without an extra tab stop for short content', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80);
    const { getByText, queryByRole } = render(<TermThoughtBlock text="Earlier reasoning" />);
    fireEvent.click(getByText('thoughts'));
    const body = getByText('Earlier reasoning').closest('div[style*="overflow-y"]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.scrollTop).toBe(0);
    expect(body.hasAttribute('tabindex')).toBe(false);
    expect(queryByRole('region')).toBeNull();
  });

  it('opens and reopens a live activity at its latest content', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const { getByText, getByRole } = render(<TermThoughtBlock text="Live reasoning" streaming />);
    fireEvent.click(getByText('thinking'));
    const activity = getByRole('region', { name: 'Activity details' });
    expect(activity.scrollTop).toBe(1000);
    activity.scrollTop = 100;
    fireEvent.scroll(activity);
    fireEvent.click(getByText('thinking'));
    fireEvent.click(getByText('thinking'));
    expect(getByRole('region', { name: 'Activity details' }).scrollTop).toBe(1000);
  });
});

describe('MessageBlock — thought block motion', () => {
  const variants = ['card', 'terminal', 'plain'] as const;
  const view = (variant: (typeof variants)[number], streaming: boolean) => (
    <AgentBlockStyleOverride.Provider value={variant}>
      <TermThoughtBlock text="Some reasoning" streaming={streaming} />
    </AgentBlockStyleOverride.Provider>
  );
  afterEach(() => vi.restoreAllMocks());

  it.each(variants)('%s: the live header leaves hidden and unclickable as the block finishes', (variant) => {
    const { container, rerender } = render(view(variant, true));
    rerender(view(variant, false));
    const leaving = container.querySelector('.term-shimmer')!.closest('[aria-hidden="true"]') as HTMLElement;
    expect(leaving).not.toBeNull();
    expect(leaving.style.pointerEvents).toBe('none');
  });

  it.each(variants)('%s: a body the user toggles opens from 1px and closes from 1px under its height', (variant) => {
    const { container, getByText } = render(view(variant, false));
    const header = () => container.querySelector('[data-agent-block] [style*="cursor: pointer"]') as HTMLElement;
    fireEvent.click(header());
    const body = getByText('Some reasoning').closest('[data-reveal="disclosure"]') as HTMLElement;
    expect(body.style.height).toBe('1px');

    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
    fireEvent.click(header());
    expect(body.style.height).toBe('39px');
  });
});

describe('MessageBlock — thought activity sync', () => {
  function renderCardMessage(m: ChatMessage) {
    return render(
      <AgentBlockStyleOverride.Provider value="card">
        <MessageBlock
          m={m}
          index={0}
          isDark={false}
          copyText={() => ''}
          showThoughts
          fontFamily="inherit"
          density="comfortable"
        />
      </AgentBlockStyleOverride.Provider>,
    );
  }

  it('keeps the latest thought block working during a between-steps gap', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{
        id: 't1',
        title: 'bash',
        status: 'completed',
        startedAt: 100,
        endedAt: 500,
      }],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Assessing options', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 17 },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Working…')).not.toBeNull();
    expect(queryByText(/Thought for/)).toBeNull();
  });

  it('leaves the thought block completed once a visible answer starts streaming', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Here is the answer',
      streaming: true,
      toolCalls: [{
        id: 't1',
        title: 'bash',
        status: 'in_progress',
        startedAt: 100,
      }],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Assessing options', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 17 },
        { id: 'b3', kind: 'answer', rawText: 'Here is the answer', streaming: true },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Ran 1 command')).not.toBeNull();
    expect(queryByText('Working…')).toBeNull();
  });

  it('heads a finished block with what it did, the duration at the right and failures apart', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Read a.ts', kind: 'read', status: 'completed', startedAt: 1_000, endedAt: 2_000 },
        { id: 't2', title: 'Edit a.ts', kind: 'edit', status: 'completed', startedAt: 2_000, endedAt: 3_000 },
        { id: 't3', title: 'Bash npm test', kind: 'bash', status: 'error', startedAt: 3_000, endedAt: 13_000 },
      ],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Fixing', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 6 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'thinking', rawOffset: 6 },
        { id: 'b4', kind: 'tool', toolCallId: 't3', section: 'thinking', rawOffset: 6 },
        { id: 'b5', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    const summary = getByText('Edited 1 file, ran 1 command, read 1 file');
    expect(summary.getAttribute('title')).toBe('Edited 1 file, ran 1 command, read 1 file');
    expect(getByText('· 1 failed')).not.toBeNull();
    const duration = getByText('12s');
    expect(summary.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queryByText(/Worked/)).toBeNull();
    expect(queryByText(/tool calls/)).toBeNull();
  });

  it('moves tools that close a prose run into the thought block that follows', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Checking first:',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Bash npm test', kind: 'bash', status: 'completed' },
        { id: 't2', title: 'Read a.ts', kind: 'read', status: 'completed' },
        { id: 't3', title: 'Edit a.ts', kind: 'edit', status: 'completed' },
      ],
      blocks: [
        { id: 'b1', kind: 'answer', rawText: 'Checking first:', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 15 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 15 },
        { id: 'b4', kind: 'thinking', rawText: 'Deciding', streaming: false },
        { id: 'b5', kind: 'tool', toolCallId: 't3', section: 'thinking', rawOffset: 8 },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Checking first:')).not.toBeNull();
    expect(getByText('Edited 1 file, ran 1 command, read 1 file')).not.toBeNull();
    expect(queryByText('ran 1 command, read 1 file')).toBeNull();
  });

  it('moves tools that open a prose run into the thought block before it', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Read a.ts', kind: 'read', status: 'completed' },
        { id: 't2', title: 'Bash npm test', kind: 'bash', status: 'completed' },
      ],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Deciding', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 8 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 0 },
        { id: 'b4', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText('Done')).not.toBeNull();
    expect(getByText('Ran 1 command, read 1 file')).not.toBeNull();
    expect(queryByText('Bash npm test')).toBeNull();
  });

  it('leaves hidden metadata tools with the prose run', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [{ id: 't1', title: 'set_branch_overview', status: 'completed' }],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Wrapping up', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 0 },
        { id: 'b3', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText(/^Thoughts$/)).not.toBeNull();
    expect(queryByText(/Worked/)).toBeNull();
  });

  it.each(['terminal', 'plain'] as const)('counts only the calls a thought block shows (%s)', (variant) => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: 'Done',
      streaming: false,
      toolCalls: [
        { id: 't1', title: 'Read a.ts', kind: 'read', status: 'completed' },
        { id: 't2', title: 'set_branch_overview', status: 'completed' },
      ],
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Reading', streaming: false },
        { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 7 },
        { id: 'b3', kind: 'tool', toolCallId: 't2', section: 'thinking', rawOffset: 7 },
        { id: 'b4', kind: 'answer', rawText: 'Done', streaming: false },
      ],
    };
    const { container } = render(
      <AgentBlockStyleOverride.Provider value={variant}>
        <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="comfortable" />
      </AgentBlockStyleOverride.Provider>,
    );
    expect(container.textContent).toMatch(/1 tool(?!s)/);
    expect(container.textContent).not.toMatch(/2 tool/);
  });

  it('keeps Thought for when a duration is known but there were no tools', () => {
    const { getByText, queryByText } = render(
      <AgentBlockStyleOverride.Provider value="card">
        <TermThoughtBlock text="Just reasoning" durationMs={7_000} />
      </AgentBlockStyleOverride.Provider>,
    );
    expect(getByText('Thought for 7.0s')).not.toBeNull();
    expect(queryByText(/Worked/)).toBeNull();
  });

  it('labels a completed thought-only block as Thoughts when duration is unknown', () => {
    const m: ChatMessage = {
      ...baseMsg,
      role: 'assistant',
      text: '',
      streaming: false,
      blocks: [
        { id: 'b1', kind: 'thinking', rawText: 'Just reasoning', streaming: false },
      ],
    };

    const { getByText, queryByText } = renderCardMessage(m);

    expect(getByText(/^Thoughts$/)).not.toBeNull();
    expect(queryByText(/Worked/)).toBeNull();
  });
});


it('renders durable answered and skipped cards without pending node state', () => {
  const { getByText } = renderMessage({ role: 'assistant', text: '', blocks: [
    { id: 'first', kind: 'user-input', requestId: 1, section: 'answer', rawOffset: 0,
      interaction: { interactionId: 't:1', requestId: 1, status: 'answered', questions: [{ id: 'q1', question: 'Color?', options: [], multiSelect: false }], answers: [{ id: 'q1', question: 'Color?', answer: 'Blue' }] } },
    { id: 'second', kind: 'user-input', requestId: 2, section: 'answer', rawOffset: 0,
      interaction: { interactionId: 't:2', requestId: 2, status: 'skipped', questions: [{ id: 'q2', question: 'Continue?', options: [], multiSelect: false }], answers: [] } },
  ] });
  expect(getByText('Color?')).not.toBeNull();
  expect(getByText('Blue')).not.toBeNull();
  expect(getByText('Continue?')).not.toBeNull();
  expect(getByText('(skipped)')).not.toBeNull();
});

it('labels estimated USD costs with their unit and provenance', () => {
  const { getByTestId } = renderMessage({ role: 'assistant', text: 'done' }, { usageInfo: { charge: { amount: 0.0123, unit: 'USD', provenance: 'sdk_estimate' } } });
  expect(getByTestId('turn-usage').textContent).toBe('estimated 0.0123 USD');
  expect((getByTestId('turn-usage').closest('[title]') as HTMLElement).title).toContain('sdk estimate');
});

describe('MessageBlock — durable agent timer', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetBackendClocksForTest();
  });

  function renderCard(m: ChatMessage) {
    return render(
      <AgentBlockStyleOverride.Provider value="card">
        <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="comfortable" />
      </AgentBlockStyleOverride.Provider>,
    );
  }

  // Backend-clock times; the cluster started at 50s, its tool ran 60s-99s.
  function workingMessage(id: string, extraBlocks: AssistantBlock[] = []): ChatMessage {
    return {
      ...baseMsg,
      id,
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{ id: 't1', title: 'bash', status: 'completed', startedAt: 60_000, endedAt: 99_000 }],
      blocks: [
        { id: `${id}-b-0`, kind: 'thinking', rawText: 'Checking disks', streaming: false, startedAt: 50_000, endedAt: 60_000 },
        { id: `${id}-b-1`, kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 14 },
        ...extraBlocks,
      ],
    };
  }

  it('resumes the Working… count from the durable start after a remount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const m = workingMessage('a-live');

    const first = renderCard(m);
    expect(first.getByText('Working…')).not.toBeNull();
    expect(first.getByText('50s')).not.toBeNull();
    first.unmount();

    vi.setSystemTime(106_000);
    const second = renderCard(m);
    expect(second.getByText('56s')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(second.getByText('57s')).not.toBeNull();
  });

  it('counts on the backend clock once its offset is confirmed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(160_000);
    // The renderer runs 60s ahead of the backend that stamped the blocks.
    recordBackendObservation('a-remote', 99_000, 159_000);
    recordBackendObservation('a-remote', 100_000, 160_000);

    const { getByText, queryByText } = renderCard(workingMessage('a-remote'));
    expect(getByText('50s')).not.toBeNull();
    expect(queryByText('110s')).toBeNull();
  });

  it('labels a finished cluster with its durable window, ending when the answer opened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const m = workingMessage('a-done', [
      { id: 'a-done-b-2', kind: 'answer', rawText: 'Here is the answer', streaming: true, startedAt: 104_000 },
    ]);

    const { getByText, queryByText } = renderCard(m);
    expect(getByText('Ran 1 command')).not.toBeNull();
    expect(getByText('54s')).not.toBeNull();
    expect(queryByText('Working…')).toBeNull();
  });
});

describe('MessageBlock — thought block motion', () => {
  afterEach(() => vi.restoreAllMocks());

  const card = (node: React.ReactNode) => <AgentBlockStyleOverride.Provider value="card">{node}</AgentBlockStyleOverride.Provider>;
  const block = (container: HTMLElement) => container.querySelector('[data-agent-block]') as HTMLElement;

  it('finishes in place: the live label leaves unannounced while the summary arrives and the body closes', async () => {
    const view = (streaming: boolean) => card(<TermThoughtBlock text="Weighing the options" streaming={streaming} />);
    const { getByText, queryByText, rerender } = render(view(true));
    expect(getByText('Weighing the options')).not.toBeNull();

    rerender(view(false));
    expect(getByText(/^Thought for /)).not.toBeNull();
    expect(getByText('Thinking…').closest('[aria-hidden="true"]')).not.toBeNull();
    await waitFor(() => expect(queryByText('Thinking…')).toBeNull());
    await waitFor(() => expect(queryByText('Weighing the options')).toBeNull());
  });

  it('turns one chevron and opens/closes the body, reversing when clicked mid-way', async () => {
    const { container, getByText, queryByText } = render(card(<TermThoughtBlock text="Earlier reasoning" durationMs={2_000} />));
    expect(queryByText('Earlier reasoning')).toBeNull();
    const chevron = () => Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '▸')!;
    expect(container.textContent).not.toContain('▾');

    fireEvent.click(getByText('Thought for 2.0s'));
    expect(getByText('Earlier reasoning')).not.toBeNull();
    await waitFor(() => expect(chevron().style.transform).toContain('rotate(90deg)'));

    // Close, then reopen before the close finishes: the same body comes back.
    fireEvent.click(getByText('Thought for 2.0s'));
    fireEvent.click(getByText('Thought for 2.0s'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getByText('Earlier reasoning')).not.toBeNull();

    fireEvent.click(getByText('Thought for 2.0s'));
    await waitFor(() => expect(queryByText('Earlier reasoning')).toBeNull());
    await waitFor(() => expect(chevron().style.transform).not.toContain('90deg'));
  });

  it('grows a block that arrives while its message is on screen from the dots it replaces', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(28);
    const pending: ChatMessage = { ...baseMsg, id: 'a1', role: 'assistant', text: '', streaming: true, blocks: [] };
    const view = (m: ChatMessage) => card(
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="comfortable" />,
    );
    const { container, getByRole, queryByRole, rerender } = render(view(pending));
    expect(getByRole('status', { name: 'loading' })).not.toBeNull();

    // Every inline style the arriving block goes through.
    const styles: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if ((record.target as HTMLElement).matches?.('[data-agent-block]')) styles.push(record.oldValue ?? '');
      }
    });
    observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    rerender(view({ ...pending, blocks: [{ id: 'a1-b-0', kind: 'thinking', rawText: 'First thought', streaming: true }] }));
    // The leaving dots stop being a status at once.
    expect(queryByRole('status', { name: 'loading' })).toBeNull();
    // It starts clipped at the dots' height, then releases its height entirely.
    await waitFor(() => expect(styles.some((style) => /height: 28px/.test(style) && /overflow: hidden/.test(style))).toBe(true));
    await waitFor(() => expect(block(container).style.height).toBe(''));
    expect(block(container).style.overflow).toBe('');
    observer.disconnect();
    await waitFor(() => expect(container.querySelector('.typing-dot')).toBeNull());
  });

  it('keeps the tail pinned while its content resizes after the render (a tool row growing in)', () => {
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal('ResizeObserver', class {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.push(target); }
      unobserve() {}
      disconnect() { this.entry.targets = []; }
    });
    let height = 300;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    const { getByText } = render(card(<TermThoughtBlock text="Running the tests" streaming />));
    const tail = getByText('Running the tests').closest('div[style*="max-height"]') as HTMLElement;
    expect(tail.scrollTop).toBe(300);

    // No re-render: the content only grows (a row animating in).
    height = 360;
    const watcher = observers.find((o) => o.targets.some((t) => tail.contains(t) && t !== tail))!;
    act(() => watcher.callback([], {} as ResizeObserver));
    expect(tail.scrollTop).toBe(360);
    vi.unstubAllGlobals();
  });

  it('leaves a body present at mount unclipped, and takes a leaving body out of reach', async () => {
    const view = (streaming: boolean) => card(<TermThoughtBlock text="Live reasoning" streaming={streaming} />);
    const { getByText, queryByText, rerender } = render(view(true));
    const reveal = () => getByText('Live reasoning').closest('div[style*="max-height"]')!.parentElement as HTMLElement;
    // Present with its block: settled, so nothing clips its focus ring.
    expect(reveal().style.overflow).toBe('visible');

    rerender(view(false));
    expect(reveal().getAttribute('aria-hidden')).toBe('true');
    expect(reveal().hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(queryByText('Live reasoning')).toBeNull());
  });

  it('renders blocks that were there when the message mounted settled', () => {
    const m: ChatMessage = {
      ...baseMsg, id: 'a1', role: 'assistant', text: '', streaming: true,
      blocks: [{ id: 'a1-b-0', kind: 'thinking', rawText: 'Resumed thought', streaming: true }],
    };
    const { container } = render(card(
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="comfortable" />,
    ));
    expect(block(container).style.height).toBe('');
    expect(block(container).style.opacity).toBe('');
  });
});
