import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { splitPageMarkdown, type PageDto } from 'michi-shared';
import NativePageDocument from './NativePageDocument';
import { NativeMarkdownSegments } from './NativeMarkdownSegments';
import { parseSegmentId } from '../content/page/vendor-blocks/shared/markdown-segments';

const a = { nodeId: 'a', turnId: 'ta', assistantId: 'ma' };
const b = { nodeId: 'b', turnId: 'tb', assistantId: 'mb' };
const text = '- Alpha\n- Beta\n- No citation';
const segmentSources = [{ text: '- Alpha', sources: [a] }, { text: '- Beta', sources: [b] }, { text: '- No citation', sources: [] }];
const sourceLabel = (source: typeof a) => source.nodeId === 'a' ? 'Alpha conversation' : 'Beta conversation';
const page = (blocks: PageDto['blocks']): PageDto => ({
  id: 'pg', workspaceId: 'ws', title: 'Research', parentId: null, color: null, position: 0, blocks,
  revision: 2, viewVersion: 2, updatedAt: 1, updatedBy: 'agent', pendingProposals: 0, helperNodeId: null,
});

describe('native Markdown item sources', () => {
  it('each item opens only its exact conversation and an explicitly uncited item stays uncited', async () => {
    const onOpen = vi.fn();
    render(<NativeMarkdownSegments text={text} segmentSources={segmentSources} sourceLabel={sourceLabel} onOpenSource={onOpen} onError={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Sources for item 3' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sources for item 1' }));
    const first = screen.getByRole('dialog', { name: 'Sources for Alpha' });
    expect(within(first).queryByText('Beta conversation')).toBeNull();
    fireEvent.click(within(first).getByRole('button', { name: 'Alpha conversation' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(a));
    fireEvent.click(screen.getByRole('button', { name: 'Sources for item 2' }));
    const second = screen.getByRole('dialog', { name: 'Sources for Beta' });
    expect(within(second).queryByText('Alpha conversation')).toBeNull();
    fireEvent.click(within(second).getByRole('button', { name: 'Beta conversation' }));
    await waitFor(() => expect(onOpen).toHaveBeenLastCalledWith(b));
  });

  it('names cited passages with ids the Desk mirror parses back to the block and passage', () => {
    const { container } = render(<NativeMarkdownSegments blockId="b:1/x" text={text} segmentSources={segmentSources} onOpenSource={vi.fn()} onError={vi.fn()} />);
    expect([...container.querySelectorAll<HTMLElement>('.native-md-segment')].map(el => parseSegmentId(el.dataset.blockId ?? ''))).toEqual([
      { blockId: 'b:1/x', index: 0 }, { blockId: 'b:1/x', index: 1 }, { blockId: 'b:1/x', index: 2 },
    ]);
  });

  it('stale source anchors fall back to the full original Markdown and never reassociate old citations', () => {
    const { container } = render(<NativeMarkdownSegments text={'- Beta\n- Alpha\n- No citation'} segmentSources={segmentSources} onOpenSource={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Sources for item/ })).toBeNull();
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Beta', 'Alpha', 'No citation']);
  });

  it('retains whole-block selection, edit drafts and source fallback while item buttons work inside containers', async () => {
    const onEdit = vi.fn().mockResolvedValue('ok');
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(<NativePageDocument page={page([{ id: 'b1', rev: 1, type: 'markdown', text, segmentSources, sources: [a] }])}
      onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} onOpenSource={onOpen} sourceLabel={sourceLabel} selectOnClick onSelectionChange={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sources for item 1' }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: '- Edited\n- Beta\n- No citation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith([{ op: 'update', id: 'b1', expectRev: 1, block: { type: 'markdown', text: '- Edited\n- Beta\n- No citation' } }], 2));
  });

  it('renders sources inside a native grid without introducing view IDs into persisted content', () => {
    render(<NativePageDocument page={page([{ id: 'grid', rev: 1, type: 'grid', regions: [{ id: 'region', span: 12, blocks: [{ type: 'markdown', text, segmentSources }] }] }])}
      onEdit={vi.fn()} onOpenPage={vi.fn()} renderDatabaseRef={() => null} onOpenSource={vi.fn()} sourceLabel={sourceLabel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sources for item 2' }));
    expect(within(screen.getByRole('dialog', { name: 'Sources for Beta' })).getByRole('button', { name: 'Beta conversation' })).toBeTruthy();
  });

  it('keeps ordered numbering, nested items, fenced code, tables and shared reference links intact', () => {
    const markdown = '1. [First][docs]\n   - Nested child\n1. Second\n\n```js\nconst value = 1;\n```\n\n| A | B |\n|---|---|\n| x | y |\n\n[docs]: https://example.com/docs';
    const mapped = splitPageMarkdown(markdown).map(segment => ({ text: segment.text, sources: segment.index < 2 ? [a] : [] }));
    const { container } = render(<NativeMarkdownSegments text={markdown} segmentSources={mapped} onOpenSource={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'First' }).getAttribute('href')).toBe('https://example.com/docs');
    expect(container.querySelectorAll('ol')).toHaveLength(2);
    expect(container.querySelectorAll('ol')[1].getAttribute('start')).toBe('2');
    expect(container.querySelector('ol ul')?.textContent).toContain('Nested child');
    expect(container.querySelector('code')?.textContent).toContain('const value = 1;');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('keeps lazy list and quote continuation in the original document when segment boundaries are ambiguous', () => {
    const markdown = '- First\ncontinued\n- Second\n\n> Quoted\ncontinued quote';
    const mapped = splitPageMarkdown(markdown).map(segment => ({ text: segment.text, sources: [a] }));
    const { container } = render(<NativeMarkdownSegments text={markdown} segmentSources={mapped} onOpenSource={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Sources for item/ })).toBeNull();
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')[0].textContent).toBe('First\ncontinued');
    expect(container.querySelector('blockquote')?.textContent).toContain('Quoted\ncontinued quote');
  });

  it('never treats reference definitions inside a fenced code sample as active links', () => {
    const markdown = '[docs]\n\n```md\n[docs]: https://example.com\n```';
    const mapped = splitPageMarkdown(markdown).map(segment => ({ text: segment.text, sources: [a] }));
    const { container } = render(<NativeMarkdownSegments text={markdown} segmentSources={mapped} onOpenSource={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'docs' })).toBeNull();
    expect(container.querySelector('code')?.textContent).toContain('[docs]: https://example.com');
  });

  it('keeps mixed GFM table row delimiters and multiline reference definitions in the original document', () => {
    const markdown = 'A | B\n--- | ---\n| x | y |\n\n[Docs][docs]\n\n[docs]: https://example.com\n  "Full title"';
    const mapped = splitPageMarkdown(markdown).map(segment => ({ text: segment.text, sources: [a] }));
    render(<NativeMarkdownSegments text={markdown} segmentSources={mapped} onOpenSource={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Sources for item/ })).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('title')).toBe('Full title');
  });
});

describe('native Markdown headings in Contents', () => {
  afterEach(() => { vi.useRealTimers(); });
  const flashed = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-flash]')];
  const contentsEntry = (name: string, index = 0) =>
    within(screen.getByRole('navigation', { name: 'Contents' })).getAllByRole('button', { name })[index]!;

  it('lands each entry of an uncited Markdown block on its own heading', () => {
    vi.useFakeTimers();
    const markdown = '## Goals\nShip it.\n\n## Risks\n- late\n\nSetext\n------\n\n## Timeline\nQ3\n\n## Risks\nagain';
    const { container } = render(<NativePageDocument page={page([{ id: 'contents', rev: 1, type: 'toc' }, { id: 'intro', rev: 1, type: 'markdown', text: markdown }])}
      onEdit={vi.fn()} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    const land = (name: string, index = 0) => {
      fireEvent.click(contentsEntry(name, index));
      const lit = flashed(container);
      expect(lit).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(1_000); });
      return lit[0]!;
    };
    const goals = land('Goals');
    const risks = land('Risks');
    const timeline = land('Timeline');
    const risksAgain = land('Risks', 1);
    expect([goals, risks, timeline, risksAgain].map(el => [el.tagName, el.textContent, el.dataset.blockId])).toEqual([
      ['H2', 'Goals', 'intro~0'], ['H2', 'Risks', 'intro~2'], ['H2', 'Timeline', 'intro~5'], ['H2', 'Risks', 'intro~7'],
    ]);
    expect(splitPageMarkdown(markdown).filter(segment => segment.kind === 'heading').map(segment => segment.index)).toEqual([0, 2, 5, 7]);
    // The block stays one block for selection and dragging.
    expect(container.querySelectorAll('.michi-doc-block[data-top]')).toHaveLength(2);
  });
});
