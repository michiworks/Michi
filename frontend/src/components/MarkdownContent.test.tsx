import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

describe('MarkdownContent streaming reveal', () => {
  function newTokenText(container: HTMLElement): string {
    return Array.from(container.querySelectorAll('[data-stream-token-new]'))
      .map((node) => node.textContent)
      .join('');
  }

  it('wraps only newly rendered visible text in reveal spans', () => {
    const { container, rerender } = render(
      <MarkdownContent text="hello" revealTailChars={1} />,
    );

    rerender(<MarkdownContent text="hello **世界**" revealTailChars={1} />);

    expect(newTokenText(container)).toBe('世界');
    expect(container.querySelectorAll('.stream-token-reveal').length).toBeGreaterThan(2);
    expect(container.textContent).toBe('hello 世界');
  });

  it('keeps text after a raw math span visible as the stream grows', () => {
    const { container, rerender } = render(
      <MarkdownContent text={'a <span class="math">x</span> b'} revealTailChars={1} />,
    );

    rerender(<MarkdownContent text={'a <span class="math">x</span> b c'} revealTailChars={1} />);

    expect(newTokenText(container)).toBe('c');
  });

  it('suppresses empty streaming code block shells', () => {
    const { container } = render(
      <MarkdownContent text={'```ts\n'} revealTailChars={1} />,
    );

    expect(container.querySelector('pre')).toBeNull();
  });
});
