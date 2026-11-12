import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LegacyHighlightedCode from './LegacyHighlightedCode';

const SOURCE = 'curl https://ok.example/a http://x.example/b\nls';
// Shiki's tokens: the https URL starts inside one token and ends inside the next.
const TOKENS = [
  [
    { content: 'curl htt', htmlStyle: { color: '#111' } },
    { content: 'ps://ok.example', htmlStyle: { color: '#222' } },
    { content: '/a http://x.example/b', htmlStyle: { color: '#333' } },
  ],
  [{ content: 'ls', htmlStyle: { color: '#444' } }],
];

vi.mock('./shikiCodePlugin', () => ({
  createCodePlugin: () => ({ highlight: () => ({ tokens: TOKENS }) }),
}));

function renderCode(httpsLinksOnly: boolean) {
  return render(
    <code>
      <LegacyHighlightedCode source={SOURCE} language="bash" lineNumbers httpsLinksOnly={httpsLinksOnly} tail={<i data-tail />} />
    </code>,
  ).container;
}

const tokenColors = (root: Element) => Array.from(root.querySelectorAll('.michi-code-token')).map((t) => (t as HTMLElement).style.getPropertyValue('--michi-code-token'));

describe('LegacyHighlightedCode links', () => {
  it('links URLs across token boundaries and keeps the text, styles, line numbers and tail', () => {
    const container = renderCode(false);
    const code = container.querySelector('code')!;
    expect(code.textContent).toBe('curl https://ok.example/a http://x.example/bls');
    expect(Array.from(code.querySelectorAll('[data-line-number]')).map((l) => l.getAttribute('data-line-number'))).toEqual(['1', '2']);
    expect(code.querySelectorAll('.michi-code-line')[1]!.querySelector('[data-tail]')).not.toBeNull();

    const links = Array.from(code.querySelectorAll('a'));
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['https://ok.example/a', 'https://ok.example/a'],
      ['http://x.example/b', 'http://x.example/b'],
    ]);
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(tokenColors(links[0]!)).toEqual(['#111', '#222', '#333']);
    expect(tokenColors(code)).toEqual(['#111', '#111', '#222', '#333', '#333', '#333', '#444']);
  });

  it('links only https URLs when asked', () => {
    const container = renderCode(true);
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://ok.example/a']);
    expect(container.querySelector('code')!.textContent).toBe('curl https://ok.example/a http://x.example/bls');
  });
});
