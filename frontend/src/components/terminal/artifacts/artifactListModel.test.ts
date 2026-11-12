import { describe, it, expect } from 'vitest';
import type { ArtifactEntry } from '../../../state/chatTypes';
import {
  artifactRowTime,
  artifactTitleFromHead,
  artifactTypeLabel,
  groupArtifactsByTime,
} from './artifactListModel';

// Sunday 8 November 2026, 10:00 local time.
const NOW = new Date(2026, 10, 8, 10, 0).getTime();
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

function artifact(id: string, createdAt: number, extra: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return { id, name: id, filePath: `mocks/${id}.html`, type: 'file', source: 'agent', createdAt, updatedAt: createdAt, ...extra };
}

describe('groupArtifactsByTime', () => {
  it('groups by calendar day for a week, then by month, newest first', () => {
    const groups = groupArtifactsByTime([
      artifact('october', at(9, 29)),
      // 40 hours before NOW: two calendar days back, so Friday, not Yesterday.
      artifact('friday', at(10, 6, 18)),
      artifact('today', at(10, 8, 9)),
      artifact('saturday', at(10, 7, 8)),
      artifact('friday-early', at(10, 6, 9)),
    ], NOW);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Today', ['today']],
      ['Yesterday', ['saturday']],
      ['Fri, Nov 6', ['friday', 'friday-early']],
      ['October', ['october']],
    ]);
    expect(groups.map((g) => g.byDay)).toEqual([true, true, true, false]);
  });

  it('puts favorites first and sorts by the latest touch', () => {
    const groups = groupArtifactsByTime([
      artifact('old-but-updated', at(9, 1), { updatedAt: at(10, 8, 9) }),
      artifact('pinned', at(9, 2), { pinnedAt: at(10, 1) }),
    ], NOW);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['Favorites', ['pinned']],
      ['Today', ['old-but-updated']],
    ]);
  });

  it('names an earlier year', () => {
    const groups = groupArtifactsByTime([artifact('last-year', new Date(2025, 11, 3).getTime())], NOW);
    expect(groups[0].label).toBe('December 2025');
  });
});

describe('artifactRowTime', () => {
  it('shows a clock time under a day header and a date under a month', () => {
    expect(artifactRowTime(at(10, 6, 18), NOW, true)).toBe('18:00');
    expect(artifactRowTime(at(10, 8, 9), NOW, true)).toBe('09:00');
    expect(artifactRowTime(at(9, 29), NOW, false)).toBe('Oct 29');
  });

  it('says Yesterday for a favorite from the day before', () => {
    expect(artifactRowTime(at(10, 7, 8), NOW, false)).toBe('Yesterday');
  });
});

describe('artifactTitleFromHead', () => {
  it('reads an HTML title and decodes its entities', () => {
    const head = '<!doctype html><html><head><meta charset="utf-8">\n<title>\n  Michi · Bubble &amp; bar &#x2014; &lt;v2&gt;\n</title>';
    expect(artifactTitleFromHead(head, 'html')).toBe('Michi · Bubble & bar — <v2>');
  });

  it('returns null for a page without one, or a title cut off by the 4 KB read', () => {
    expect(artifactTitleFromHead('<html><body>hi', 'html')).toBeNull();
    expect(artifactTitleFromHead('<title>Half a ti', 'html')).toBeNull();
    expect(artifactTitleFromHead('<title>   </title>', 'html')).toBeNull();
  });

  it('reads the first level-one markdown heading, past front matter', () => {
    const head = '---\ntitle: ignored\n---\nIntro\n## Not this\n# Pi 能力补齐 ##\n# Later';
    expect(artifactTitleFromHead(head, 'markdown')).toBe('Pi 能力补齐');
  });

  it('caps a very long title', () => {
    const title = artifactTitleFromHead(`<title>${'x'.repeat(400)}</title>`, 'html');
    expect(title).toHaveLength(160);
    expect(title?.endsWith('…')).toBe(true);
  });
});

describe('artifactTypeLabel', () => {
  it('names HTML, documents, links and other files by extension', () => {
    expect(artifactTypeLabel(artifact('a', NOW), 'file')).toBe('HTML');
    expect(artifactTypeLabel(artifact('b', NOW, { filePath: 'x/report.pdf' }), 'file')).toBe('PDF');
    expect(artifactTypeLabel(artifact('c', NOW, { filePath: 'x/notes.md' }), 'doc')).toBe('Doc');
    expect(artifactTypeLabel(artifact('d', NOW, { filePath: '', url: 'https://x.dev' }), 'link')).toBe('Link');
  });
});
