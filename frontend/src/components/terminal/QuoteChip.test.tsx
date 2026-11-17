import { afterEach, describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { QuoteChip } from './QuoteChip';
import { AssistantScopeContext } from './assistant/assistantScope';
import { ATTACHED_QUOTE_SOURCE } from '../../lib/quoteFormat';

/** jsdom lays nothing out, so a row only cuts text when we say it does. */
const measured: Array<'scrollWidth' | 'clientWidth'> = [];
function withClippedText(clipped: boolean) {
  for (const [prop, value] of [['scrollWidth', clipped ? 400 : 100], ['clientWidth', 100]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    measured.push(prop);
  }
}

afterEach(() => {
  for (const prop of measured.splice(0)) delete (HTMLElement.prototype as Partial<HTMLElement>)[prop];
});

describe('QuoteChip', () => {
  it('unfolds the passage, and the toggle reports it is open', () => {
    withClippedText(true);
    const { getByRole, getByTestId, container } = render(<QuoteChip text="hello" />);
    const toggle = getByRole('button', { name: 'Show full quote' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.t-ctx')!.className).toContain('is-expanded');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.contains(getByTestId('quote-preview'))).toBe(true);
  });

  it('offers no toggle when the whole passage already shows', () => {
    withClippedText(false);
    const { queryByRole } = render(<QuoteChip text="short" />);
    expect(queryByRole('button')).toBeNull();
  });

  it('says it replies to a selection only when a selection is in the quote', () => {
    const label = (container: HTMLElement) => container.querySelector('.t-ctx-label')!.textContent;
    // A reply to a selection.
    expect(label(render(<QuoteChip text="the passage" />).container)).toBe('Replying to selection');
    // The ⌘J assistant's page line and chips alone: attached context.
    const page = 'On screen: Home\n- thread: Fix CI (michi://node/t1) — Stalled';
    expect(label(render(<QuoteChip text={page} source={ATTACHED_QUOTE_SOURCE} />).container)).toBe('Attached context');
    // The context and a selection together: the selection is what it replies to.
    expect(label(render(<QuoteChip text={`${page}\n\nthe passage`} source={ATTACHED_QUOTE_SOURCE} />).container))
      .toBe('Replying to selection');
  });

  it('reads an assistant message’s context from the quote itself after a reload', () => {
    const { container } = render(
      <AssistantScopeContext.Provider value>
        <QuoteChip text="On screen: Home" />
      </AssistantScopeContext.Provider>,
    );
    expect(container.querySelector('.t-ctx-label')!.textContent).toBe('Attached context');
    // Outside the assistant, a quote is a selection, whatever it says.
    const other = render(<QuoteChip text="On screen: Home" />);
    expect(other.container.querySelector('.t-ctx-label')!.textContent).toBe('Replying to selection');
  });
});
