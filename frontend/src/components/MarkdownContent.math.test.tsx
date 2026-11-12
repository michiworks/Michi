import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

// rehype-katex is loaded lazily (dynamic import in an effect), so assertions
// about rendered math must waitFor the `.katex` output to appear.
describe('MarkdownContent math', () => {
  it('reverts leaked ${…} template interpolations to text, not math', async () => {
    // Two `$` from a JS template literal pair up in remark-math; the trailing
    // $x^2$ guarantees katex loads, and the interpolation must survive as text.
    const { container } = render(
      <MarkdownContent text={'use ${API_BASE_URL}/workspaces/${id}/watch/stream, see $x^2$'} />,
    );
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(1));
    expect(container.textContent).toContain('${API_BASE_URL}/workspaces/${id}/watch/stream');
  });

  it('keeps math intact under tail-reveal streaming', async () => {
    const { container } = render(
      <MarkdownContent text={'$$E = mc^2$$'} revealTailChars={8} />,
    );
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy());
    const katex = container.querySelector('.katex')!;
    // reveal must not inject its per-char spans inside katex output
    expect(katex.querySelector('.stream-token-reveal')).toBeNull();
  });

  it('leaves URLs inside a formula unlinked', async () => {
    const { container } = render(
      <MarkdownContent text={'$\\text{see www.example.com or https://example.org/x}$'} />,
    );
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy());
    expect(container.querySelector('.katex')!.textContent).toContain('www.example.com');
    expect(container.querySelector('.katex a')).toBeNull();
  });
});
