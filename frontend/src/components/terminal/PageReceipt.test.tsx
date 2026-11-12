import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallState } from '../../state/chatTypes';
import { resetPageReceiptInvalidationForTests } from './PageReceipt';
import { TurnReceipts } from './TurnReceipts';

const openPagePane = vi.hoisted(() => vi.fn());
vi.mock('../../state/chatStore', () => ({ useOptionalChatActions: () => ({ openPagePane }) }));
const revealPageTarget = vi.hoisted(() => vi.fn());
vi.mock('../../state/pages/revealPageTarget', () => ({ revealPageTarget }));

function write(id: string, title: string, michiPageWrite: Record<string, unknown>, applied: unknown[] = []): ToolCallState {
  return {
    id, title, status: 'completed', kind: 'other', inputJson: '{}',
    output: JSON.stringify({
      result: { resource: { kind: michiPageWrite.resourceKind, id: michiPageWrite.resourceId }, applied, proposed: [], rejected: [] },
      michiPageWrite: { kind: 'michiPageWrite', ...michiPageWrite },
    }),
  } as ToolCallState;
}

/** Each row's text, without its glyph. */
const rows = () => [...document.querySelectorAll('[data-receipt="page"]')].map((row) => row.textContent!.replace(/^✓ /, ''));

afterEach(() => {
  cleanup();
  openPagePane.mockReset();
  revealPageTarget.mockReset();
  resetPageReceiptInvalidationForTests();
});

describe('page rows under a reply', () => {
  it('counts the tasks a write made and opens the page the same reply put the board on', () => {
    const tasks = write('t1', 'edit_database', {
      resourceKind: 'database', resourceId: 'db-t', title: 'Tasks', originatingPageIds: [],
      appliedCount: 3, proposedCount: 1, affectedTargetIds: ['row-1'], tasks: { added: 2, updated: 1, removed: 0 },
    });
    const board = write('t2', 'edit_page', { resourceKind: 'page', resourceId: 'pg-r', title: 'sample-project', appliedCount: 1, proposedCount: 0, affectedTargetIds: ['b-board'] },
      [{ id: 'c9', seq: 9, op: 'insert', after: { kind: 'block', exists: true, block: { type: 'task-view' } } }]);
    render(<TurnReceipts tools={[tasks, board]} workspaceId="ws-r" backendConnectionId="local" />);
    expect(rows()).toEqual([
      'Updated Tasks created 2 tasks, updated 1 · 1 waiting for you View',
      'Updated sample-project added a task board View',
    ]);
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]!);
    expect(openPagePane).toHaveBeenCalledWith({ pageId: 'pg-r', workspaceId: 'ws-r', backendConnectionId: 'local', title: 'Tasks' });
  });

  it('gives a task database shown on two pages one View, which opens the first', () => {
    const tasks = write('t4', 'edit_database', {
      resourceKind: 'database', resourceId: 'db-t', title: 'Tasks', originatingPageIds: ['pg-home', 'pg-plan'],
      appliedCount: 1, proposedCount: 0, affectedTargetIds: ['row-1'], tasks: { added: 0, updated: 1, removed: 0 },
    });
    render(<TurnReceipts tools={[tasks]} workspaceId="ws-r" backendConnectionId="local" />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['View']);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(openPagePane).toHaveBeenCalledWith({ pageId: 'pg-home', workspaceId: 'ws-r', backendConnectionId: 'local', title: 'Tasks' });
    // The changed row, in the pane it just opened.
    expect(revealPageTarget).toHaveBeenCalledWith({ targetId: 'row-1', databaseId: 'db-t', pane: { pageId: 'pg-home', workspaceId: 'ws-r', backendConnectionId: 'local' } });
  });

  it('counts the places a write changed', () => {
    const edit = write('t3', 'edit_page', { resourceKind: 'page', resourceId: 'pg-r', title: 'sample-project', appliedCount: 2, proposedCount: 0, affectedTargetIds: ['b1'] });
    render(<TurnReceipts tools={[edit]} workspaceId="ws-r" backendConnectionId="local" />);
    expect(rows()).toEqual(['Updated sample-project 2 places View']);
  });

  it('reads a database made and filled in by the same reply as one row, with no View while no page shows it', () => {
    const made = write('t5', 'create_database', { resourceKind: 'database', resourceId: 'db-f', title: '外部跟进', created: true, appliedCount: 0, proposedCount: 0, affectedTargetIds: [] });
    const filled = write('t6', 'edit_database', { resourceKind: 'database', resourceId: 'db-f', title: '外部跟进', appliedCount: 2, proposedCount: 0, affectedTargetIds: ['r1', 'r2'] });
    const page = write('t7', 'edit_page', { resourceKind: 'page', resourceId: 'pg-c', title: 'FMH Config 进度', appliedCount: 1, proposedCount: 0, affectedTargetIds: ['b1'] });
    render(<TurnReceipts tools={[made, page, filled]} workspaceId="ws-r" backendConnectionId="local" />);
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(rows()).toEqual(['Created 外部跟进 Database · 2 edits', 'Updated FMH Config 进度 1 place View']);
  });

  it('shows no page rows without the conversation’s workspace', () => {
    const edit = write('t8', 'edit_page', { resourceKind: 'page', resourceId: 'pg-r', title: 'sample-project', appliedCount: 2, proposedCount: 0, affectedTargetIds: ['b1'] });
    const { container } = render(<TurnReceipts tools={[edit]} backendConnectionId="local" />);
    expect(container.innerHTML).toBe('');
  });
});
