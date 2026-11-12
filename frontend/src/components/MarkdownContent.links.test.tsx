import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

function anchors(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a'));
}
function byHref(container: HTMLElement, hrefIncludes: string) {
  return anchors(container).find((a) => (a.getAttribute('href') ?? '').includes(hrefIncludes));
}

describe('MarkdownContent links', () => {
  it('dispatches michi:internal-link custom event on relative link click', () => {
    const { container } = render(
      <MarkdownContent text="[doc](notes/design.md)" />,
    );
    const a = byHref(container, 'notes/design.md')!;
    const received: string[] = [];
    container.addEventListener('michi:internal-link', ((e: CustomEvent) => {
      received.push(e.detail.href);
    }) as EventListener);
    a.click();
    expect(received).toEqual(['notes/design.md']);
  });

  it('does not prevent default on hash-only links', () => {
    const { container } = render(
      <MarkdownContent text="[section](#heading)" />,
    );
    const a = byHref(container, '#heading')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('autolinks scheme-less domain.tld/path', () => {
    const { container } = render(
      <MarkdownContent text="open console.aws.amazon.com/ec2/home please" />,
    );
    const a = byHref(container, 'console.aws.amazon.com/ec2/home')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://console.aws.amazon.com/ec2/home');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('keeps trailing sentence punctuation out of the link', () => {
    const { container } = render(<MarkdownContent text="visit console.aws.amazon.com/x." />);
    const a = byHref(container, 'console.aws.amazon.com/x')!;
    expect(a.getAttribute('href')).toBe('https://console.aws.amazon.com/x');
    expect(container.textContent).toContain('console.aws.amazon.com/x.');
  });

  it('linkifies full https URLs inside fenced code blocks', () => {
    const { container } = render(
      <MarkdownContent text={'```\nhttps://example.com/path\n```'} />,
    );
    const a = byHref(container, 'example.com/path')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://example.com/path');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('ends a bold bare URL at CJK punctuation and keeps the bold', () => {
    const { container } = render(
      <MarkdownContent text={'审阅链接已同步：**https://poster.example.com**。截图脚本是 `npm run shots`，过程'} />,
    );
    const a = container.querySelector('strong > a')!;
    expect(a.getAttribute('href')).toBe('https://poster.example.com');
    expect(a.textContent).toBe('https://poster.example.com');
    expect(container.textContent).toBe('审阅链接已同步：https://poster.example.com。截图脚本是 npm run shots，过程');
  });

  it.each([
    ['链接 https://example.com/a，然后继续', 'https://example.com/a'],
    ['（https://example.com/a）里', 'https://example.com/a'],
    ['见“https://example.com/a”', 'https://example.com/a'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)。下一句', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['看 **https://example.com/a**这里', 'https://example.com/a'],
  ])('stops the URL in %j before the CJK text', (text, href) => {
    const { container } = render(<MarkdownContent text={text} />);
    expect(anchors(container).map(a => a.getAttribute('href'))).toEqual([href]);
  });

  it('links every URL in a run joined by CJK punctuation', () => {
    const { container } = render(<MarkdownContent text="https://a.com/x，https://b.com/y。完" />);
    expect(anchors(container).map(a => a.getAttribute('href'))).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(container.textContent).toBe('https://a.com/x，https://b.com/y。完');
  });

  it('ends www URLs too and keeps their text literal', () => {
    const { container } = render(<MarkdownContent text="见 **www.example.com/a_b_c**。" />);
    const a = container.querySelector('strong > a')!;
    expect(a.getAttribute('href')).toBe('http://www.example.com/a_b_c');
    expect(a.textContent).toBe('www.example.com/a_b_c');
  });

  it('keeps CJK letters that are part of the path', () => {
    const { container } = render(<MarkdownContent text="https://zh.wikipedia.org/wiki/北京。" />);
    expect(anchors(container).map(a => a.textContent)).toEqual(['https://zh.wikipedia.org/wiki/北京']);
  });

  it('leaves code spans as written while linking only the URL inside', () => {
    const { container } = render(<MarkdownContent text="`https://example.com/a，b`" />);
    expect(container.querySelector('code')!.textContent).toBe('https://example.com/a，b');
    expect(anchors(container).map(a => a.getAttribute('href'))).toEqual(['https://example.com/a']);
  });

  it('links an upper-case scheme in fenced code as in inline code', () => {
    const { container } = render(
      <MarkdownContent text={'`HTTPS://X.EXAMPLE/a` and `WWW.Y.EXAMPLE/b`\n\n```\nHTTPS://X.EXAMPLE/c WWW.Y.EXAMPLE/d\n```'} />,
    );
    expect(anchors(container).map((a) => a.getAttribute('href'))).toEqual([
      'HTTPS://X.EXAMPLE/a',
      'https://WWW.Y.EXAMPLE/b',
      'HTTPS://X.EXAMPLE/c',
      'https://WWW.Y.EXAMPLE/d',
    ]);
  });
});

  it('opens inline paths and encoded file links, but leaves fenced code alone', () => {
    const clicked: string[] = [];
    const { container } = render(<MarkdownContent text={'`/home/me/a b.png` [source](file:///home/me/a%20b.ts:12)\n\n```\n/home/me/no.png\n```'} onLinkClick={href => clicked.push(href)} />);
    const links = container.querySelectorAll<HTMLAnchorElement>('[data-file-link]');
    expect(links).toHaveLength(2);
    links.forEach(link => link.click());
    expect(clicked).toEqual(['/home/me/a b.png', '/home/me/a b.ts:12']);
    expect(container.querySelector('pre a')).toBeNull();
  });

  it('leaves slash commands and bare relative dirs in inline code as code', () => {
    const { container } = render(<MarkdownContent text={'`/` `/review` `/review 参数` `../` `./...` `/README.md` `/home/me` `../src/x` `src/a.ts:3`'} />);
    const linked = Array.from(container.querySelectorAll('[data-file-link]'), link => link.textContent);
    expect(linked).toEqual(['/README.md', '/home/me', '../src/x', 'src/a.ts:3']);
  });
