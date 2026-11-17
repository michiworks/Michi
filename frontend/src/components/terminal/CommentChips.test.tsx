import { afterEach, describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CommentChips } from './CommentChips';

const mk = (id: string, q: string, b: string) => ({ id, quotedText: q, body: b, createdAt: 0 });

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

describe('CommentChips', () => {
  it('renders nothing when comments is empty', () => {
    const { container } = render(<CommentChips comments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists the passages it carries in order, marked as comments, without numbers', () => {
    const { container } = render(
      <CommentChips comments={[mk('a', 'first passage', 'one'), mk('b', 'second passage', 'two')]} />,
    );
    // The list's own order says which came first; the agent read them unnumbered too.
    expect([...container.querySelectorAll('li.t-ctx [data-testid="comment-quote"]')].map((el) => el.textContent)).toEqual(['first passage', 'second passage']);
    // Each row's mark is the comment bubble, not a number.
    expect([...container.querySelectorAll('.t-ctx-mark')].map((el) => [el.textContent, !!el.querySelector('svg')])).toEqual([['', true], ['', true]]);
  });

  it('unfolds a cut comment, and the toggle reports it is open', () => {
    withClippedText(true);
    const { getByRole, getByTestId, container } = render(
      <CommentChips comments={[mk('a', 'a long passage', 'a long body')]} />,
    );
    const toggle = getByRole('button', { name: 'Show full comment' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.t-ctx')!.className).toContain('is-expanded');
    const controlled = toggle.getAttribute('aria-controls')!.split(' ').map((id) => document.getElementById(id));
    expect(controlled.some((el) => el?.contains(getByTestId('comment-quote')))).toBe(true);
    expect(controlled.some((el) => el?.contains(getByTestId('comment-body')))).toBe(true);
  });

  it('offers no toggle when the whole comment already shows', () => {
    withClippedText(false);
    const { queryByRole } = render(<CommentChips comments={[mk('a', 'short', 'short body')]} />);
    expect(queryByRole('button')).toBeNull();
  });
});
