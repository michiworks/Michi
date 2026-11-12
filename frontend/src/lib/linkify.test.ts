import { describe, expect, it } from 'vitest';
import { findUrlMatches } from './linkify';

const hrefs = (text: string, schemeOnly: boolean) => findUrlMatches(text, { schemeOnly }).map((m) => m.href);

describe('findUrlMatches', () => {
  it('finds scheme URLs whatever their case, and www. URLs as https', () => {
    expect(hrefs('HTTPS://X.EXAMPLE/a http://y.example www.z.example/a WWW.Q.EXAMPLE', true)).toEqual([
      'HTTPS://X.EXAMPLE/a',
      'http://y.example',
      'https://www.z.example/a',
      'https://WWW.Q.EXAMPLE',
    ]);
  });

  it('keeps trailing sentence punctuation out of the URL but inside the match', () => {
    const text = 'see https://x.example/a. then';
    const [match] = findUrlMatches(text, { schemeOnly: true });
    expect(match).toEqual({ start: 4, end: 24, url: 'https://x.example/a', href: 'https://x.example/a' });
    expect(text.slice(match!.start, match!.end)).toBe('https://x.example/a.');
  });

  it('finds scheme-less domain/path URLs only outside scheme-only text', () => {
    expect(hrefs('open console.aws.amazon.com/ec2 or src/index.css', false)).toEqual(['https://console.aws.amazon.com/ec2']);
    expect(hrefs('open console.aws.amazon.com/ec2', true)).toEqual([]);
  });

  it('reports one match per URL, in order', () => {
    expect(hrefs('www.x.example/a https://y.example/www.z.example', false)).toEqual([
      'https://www.x.example/a',
      'https://y.example/www.z.example',
    ]);
    expect(findUrlMatches('no links here', { schemeOnly: false })).toEqual([]);
  });
});
