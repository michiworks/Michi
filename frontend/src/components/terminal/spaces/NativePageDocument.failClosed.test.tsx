import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PageDto } from 'michi-shared';
import type { BlockProps } from '../content/page/blockTypes';

// What each block is drawn with: whether pictures may load (ctx.loadImages).
const drawn = vi.hoisted(() => new Map<string, boolean | undefined>());
vi.mock('../content/page/MichiBlock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../content/page/MichiBlock')>();
  return {
    ...actual,
    MichiBlock: (props: BlockProps) => {
      if (typeof props.block.id === 'string' && props.ctx.depth === 0) drawn.set(props.block.id, props.ctx.loadImages);
      return <actual.MichiBlock {...props} />;
    },
  };
});

import NativePageDocument from './NativePageDocument';

const checkin = { nodeId: 'n-cmph-r1', turnId: 'cmp-r1', assistantId: 'self-n-cmph-r1-cmp-r1' };
const user = { nodeId: 'n-user', turnId: 't', assistantId: 'a' };
const page = (blocks: PageDto['blocks']): PageDto => ({
  id: 'pg-1', workspaceId: 'ws-1', parentId: null, position: 0, title: 'Notes', color: null,
  updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 2, viewVersion: 2, blocks,
});

// F1b-review #1 (DESIGN-v2 §2.6.2): the render-side fallback does not rest on
// recognising media. Whatever a check-in wrote is drawn with pictures off until
// the user loads them; the reading only decides whether "Load images" shows.
describe('blocks a check-in wrote, whatever they hold', () => {
  it('are drawn with pictures off, without a button where nothing is known to load; the user’s blocks are not', () => {
    drawn.clear();
    render(<NativePageDocument page={page([
      { id: 'quiet', rev: 1, type: 'markdown', text: 'Only words here.', sources: [checkin] },
      { id: 'nested', rev: 1, type: 'toggle', title: 'More', blocks: [{ type: 'markdown', text: 'Words' }], sources: [checkin] },
      { id: 'mine', rev: 1, type: 'markdown', text: 'Mine.', sources: [user] },
    ] as PageDto['blocks'])} onEdit={async () => 'ok'} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    expect(drawn.get('quiet')).toBe(false);
    expect(drawn.get('nested')).toBe(false);
    expect(drawn.get('mine')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load images' })).toBeNull();
  });

  it('draw a block with pictures on once its "Load images" was pressed', () => {
    drawn.clear();
    render(<NativePageDocument page={page([
      { id: 'pic', rev: 1, type: 'markdown', text: 'Look ![chart](https://example.com/chart.png)', sources: [checkin] },
    ] as PageDto['blocks'])} onEdit={async () => 'ok'} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    expect(drawn.get('pic')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
    expect(drawn.get('pic')).toBe(true);
  });
});
