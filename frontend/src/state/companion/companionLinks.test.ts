import { describe, expect, it } from 'vitest';
import { companionItemUrls, companionLinkVerdict } from './companionLinks';

const none = new Set<string>();

describe('links in the Companion conversation (R2.1)', () => {
  it('keeps the work sites it watches as links, over https only', () => {
    expect(companionLinkVerdict('https://reviews.example.com/reviews/CR-1', none)).toEqual({ kind: 'web', url: 'https://reviews.example.com/reviews/CR-1' });
    expect(companionLinkVerdict('https://builds.example.com/pipelines/MyService', none).kind).toBe('web');
    expect(companionLinkVerdict('https://outlook.office.com/mail/id/1', none).kind).toBe('web');
    expect(companionLinkVerdict('https://outlook.office365.com/owa/', none).kind).toBe('web');
    expect(companionLinkVerdict('http://reviews.example.com/reviews/CR-1', none).kind).toBe('text');
  });

  it('shows every other site as text, lookalike hosts and credentials included', () => {
    for (const href of [
      'https://evil.example.com/phish',
      'https://reviews.example.com.evil.example/reviews',
      'https://evilreviews.example.com/',
      'https://user:pw@reviews.example.com/reviews/CR-1',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      '/relative/path',
      'not a url',
    ]) expect(companionLinkVerdict(href, none)).toEqual({ kind: 'text' });
  });

  it('allows the exact targets of its own items', () => {
    const urls = companionItemUrls([
      { target: { kind: 'url', url: 'https://broadcast.example.com/meeting/1' } },
      { target: { kind: 'node', workspaceId: 'ws', nodeId: 'n' } },
      { target: null },
    ]);
    expect(companionLinkVerdict('https://broadcast.example.com/meeting/1', urls).kind).toBe('web');
    expect(companionLinkVerdict('https://broadcast.example.com/meeting/2', urls).kind).toBe('text');
  });

  it('keeps Michi links as Michi links, and other michi: addresses as text', () => {
    expect(companionLinkVerdict('michi://node/n-1', none)).toEqual({ kind: 'michi', link: { kind: 'node', id: 'n-1' } });
    expect(companionLinkVerdict('michi://workspace/ws-1', none)).toEqual({ kind: 'text' });
  });
});
