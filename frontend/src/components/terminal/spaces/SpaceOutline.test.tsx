import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { PageBlock, PageSummaryDto } from 'michi-shared';
import SpaceOutline, { pageOutline } from './SpaceOutline';

const block = (id: string, content: Record<string, unknown>) => ({ id, rev: 1, ...content }) as unknown as PageBlock;
const BLOCKS = [
  block('t', { type: 'threads', nodeIds: ['n1'] }),
  block('h1', { type: 'heading', text: 'Progress' }),
  block('pa', { type: 'plan-actual', items: [{ label: 'Build', planned: 2, actual: 3 }] }),
  block('m', { type: 'markdown', text: '### Notes\nSome words' }),
  block('k', { type: 'metrics', items: [{ label: 'Done', value: '14' }] }),
  block('h2', { type: 'heading', text: 'Blockers' }),
  block('c', { type: 'callout', title: 'Schema naming', text: 'Waiting on you', tone: 'warn' }),
  block('ch', { type: 'chart', title: 'Turns per day', kind: 'bar', labels: ['14'], series: [{ label: 'Kiro', values: [3] }] }),
  block('blank', { type: 'heading', text: '  ' }),
];

describe('Space outline', () => {
  it('omits content reserved for a named view', () => {
    expect(pageOutline([
      block('detail-title', { type: 'heading', text: 'Hidden evidence', visibility: 'detail' }),
      block('definition', { type: 'view', viewId: 'evidence', title: 'Evidence', blockIds: ['detail-title'] }),
      block('visible', { type: 'chart', title: 'Progress' }),
    ])).toEqual([{ id: 'visible', text: 'Progress', depth: 1 }]);
  });

  it('lists the headings, and the titled blocks under them one step in', () => {
    expect(pageOutline(BLOCKS)).toEqual([
      { id: 't', text: 'Threads', depth: 1 },
      { id: 'h1', text: 'Progress', depth: 1 },
      { id: 'pa', text: 'Plan vs actual', depth: 2 },
      { id: 'h2', text: 'Blockers', depth: 1 },
      { id: 'c', text: 'Schema naming', depth: 2 },
      { id: 'ch', text: 'Turns per day', depth: 2 },
    ]);
  });

  it('gives each page row the sidebar\'s row menu: its ⋯, a right-click and a long press', () => {
    const pages = [
      { id: 'home', title: 'Home', parentId: null, position: 0, pendingProposals: 0 },
      { id: 'plan', title: 'Plan', parentId: 'home', position: 0, pendingProposals: 0 },
    ] as unknown as PageSummaryDto[];
    const onRename = vi.fn();
    render(<SpaceOutline pages={pages} activePageId="plan" rootId="home" blocks={[]} readOnly={false} onOpen={vi.fn()} onCreateChild={vi.fn()} onRename={onRename} onMove={vi.fn()} onTrash={vi.fn()} />);
    const more = screen.getByRole('button', { name: 'Actions for Plan' });
    // The shared ⋯: shown on a touch screen, a finger-sized target there.
    expect(more.closest('.row-kebab')).toBeTruthy();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(screen.getByRole('menu', { name: 'Actions for Plan' })).getByRole('menuitem', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalledWith(pages[1]);
    // A long press on a touch screen arrives as a contextmenu on the row.
    const row = more.closest('[data-context-target]') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row);
    expect(within(screen.getByRole('menu', { name: 'Actions for Plan' })).getByRole('menuitem', { name: 'Move…' })).toBeTruthy();
  });

  it('offers no row menu on a read-only page', () => {
    const page = { id: 'p', title: 'Home', parentId: null, position: 0, pendingProposals: 0 } as unknown as PageSummaryDto;
    render(<SpaceOutline pages={[page]} activePageId="p" rootId="p" blocks={[]} readOnly onOpen={vi.fn()} onCreateChild={vi.fn()} onRename={vi.fn()} onMove={vi.fn()} onTrash={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Actions for Home' })).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Home' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows the block an entry names as other page links do: centred, lit, still under Reduce motion', () => {
    const target = document.createElement('div');
    target.className = 'michi-doc-block';
    target.dataset.blockId = 'ch';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const page = { id: 'p', title: 'Home', parentId: null, position: 0, pendingProposals: 0 } as unknown as PageSummaryDto;
    render(<SpaceOutline pages={[page]} activePageId="p" rootId="p" blocks={BLOCKS} readOnly onOpen={vi.fn()} onCreateChild={vi.fn()} onRename={vi.fn()} onMove={vi.fn()} onTrash={vi.fn()} />);
    const entry = within(screen.getByRole('navigation', { name: 'Page outline' })).getByRole('button', { name: 'Turns per day' });
    fireEvent.click(entry);
    expect(target.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth', block: 'center' }));
    expect(target.hasAttribute('data-reveal-flash')).toBe(true);
    document.documentElement.dataset.reduceMotion = 'on';
    try {
      fireEvent.click(entry);
      expect(target.scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }));
    } finally {
      delete document.documentElement.dataset.reduceMotion;
      target.remove();
    }
  });
});
