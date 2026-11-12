import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownContent, { type MarkdownFeatureProfile } from './MarkdownContent';

const features: MarkdownFeatureProfile = {
  autoDirection: true,
  cjk: true,
  codeDownload: true,
  codeLineNumbers: true,
  normalizeHtmlIndentation: true,
  strikethrough: true,
  tableControls: true,
};

describe('MarkdownContent optional Streamdown-parity features', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders CJK-adjacent emphasis and strikethrough semantically', () => {
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'**该强调包含句号。**这是后文。\n\n~~该删除线包含句号。~~这是后文。'}
      />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('该强调包含句号。');
    expect(container.querySelector('del')?.textContent).toBe('该删除线包含句号。');
  });

  it('normalizes indented raw HTML instead of turning it into a code block', () => {
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'<div>\n    <strong>normalized</strong>\n</div>'}
      />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('normalized');
    expect(container.querySelector('.michi-code-block')).toBeNull();
  });

  it('keeps table control clicks local to the rendered table', () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard },
    });
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'| A | B |\n| --- | --- |\n| one | two |'}
      />,
    );

    fireEvent.click(container.querySelector('[aria-label="Copy table"]')!);
    expect(clipboard).toHaveBeenCalledOnce();
    expect(clipboard.mock.calls[0][0]).toContain('| A | B |');
  });

  it('keeps mixed cell content in one element for the phone card grid', () => {
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'| Runtime | Notes |\n| --- | --- |\n| Sample | `~/.local/bin/sample-cli` is a **local** shim |'}
      />,
    );
    const cell = container.querySelectorAll('td')[1];

    expect(cell.childNodes).toHaveLength(1);
    const value = cell.firstElementChild!;
    expect(value.classList.contains('michi-table-cell')).toBe(true);
    expect(value.querySelector('code')?.textContent).toBe('~/.local/bin/sample-cli');
    expect(value.textContent).toBe('~/.local/bin/sample-cli is a local shim');
  });
});
