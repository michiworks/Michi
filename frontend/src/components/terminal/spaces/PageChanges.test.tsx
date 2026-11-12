import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PageChangeDto, PageDatabase } from 'michi-shared';
import { ChangeCard } from './ChangeCard';
import { PageChanges } from './PageChanges';

function blockChange(overrides: Partial<PageChangeDto> = {}): PageChangeDto {
  return {
    id: 'chg-1', seq: 1, batchId: 'batch-1', target: { kind: 'block', pageId: 'pg-1', blockId: 'block-1' }, op: 'update',
    before: { kind: 'block', exists: true, block: { id: 'block-1', rev: 1, type: 'heading', text: 'Risks' }, location: { parentId: null, slot: null, previousId: null, nextId: null } },
    after: { kind: 'block', exists: true, block: { id: 'block-1', rev: 2, type: 'heading', text: 'Current risks' }, location: { parentId: null, slot: null, previousId: null, nextId: null } },
    forward: { kind: 'block', op: 'upsert', block: { id: 'block-1', rev: 2, type: 'heading', text: 'Current risks', sources: [{ nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' }] }, location: { parentId: null, slot: null, previousId: null, nextId: null } },
    inverse: { kind: 'block', op: 'upsert', block: { id: 'block-1', rev: 1, type: 'heading', text: 'Risks' }, location: { parentId: null, slot: null, previousId: null, nextId: null } },
    baseRev: 1, appliedRev: null, previousHeadId: null, source: { kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' },
    proposalState: 'pending', applicationState: null, createdAt: Date.now(), resolvedAt: null, ...overrides,
  };
}

describe('native page change presentation', () => {
  it.each(['card', 'inline'] as const)('shows database field changes before accepting a %s suggestion', (variant) => {
    const before: PageDatabase = { id: 'db', workspaceId: 'ws', title: 'Tracker', revision: 1, updatedAt: 1,
      columns: [{ id: 'number', name: 'Number', type: 'text' }], views: [], rows: [] };
    const after = { ...before, revision: 2, columns: [{ ...before.columns[0]!, name: 'Ticket / CR' }, { id: 'owner', name: 'Owner', type: 'text' as const }] };
    const change = blockChange({ target: { kind: 'database', databaseId: 'db' }, op: 'schema',
      before: { kind: 'database', exists: true, database: before }, after: { kind: 'database', exists: true, database: after },
      forward: { kind: 'database', op: 'replace', database: after }, inverse: { kind: 'database', op: 'replace', database: before } });
    const onAccept = vi.fn();
    render(<ChangeCard change={change} variant={variant} showTarget onAccept={onAccept} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Proposed database changes' })).toBeTruthy();
    expect(screen.getByText('Column: Number (text) → Ticket / CR (text)')).toBeTruthy();
    expect(screen.getByText('Add column: Owner (text)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit & accept' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith(change);
  });

  it('keeps an edit draft visible after a stale 409 and allows dismissal', () => {
    const onDismiss = vi.fn();
    render(<ChangeCard change={blockChange()} onAccept={vi.fn()} onDismiss={onDismiss} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} error="409 proposal_stale" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    const editor = screen.getByLabelText('Proposed block content') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{"type":"heading","text":"My draft"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    expect(screen.getByText(/This block changed after the suggestion was made/)).toBeTruthy();
    expect((screen.getByLabelText('Proposed block content') as HTMLTextAreaElement).value).toContain('My draft');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: 'chg-1' }));
  });

  it('accepts editable proposed block content without sending metadata', () => {
    const onAccept = vi.fn();
    render(<ChangeCard change={blockChange()} onAccept={onAccept} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    fireEvent.change(screen.getByLabelText('Proposed block content'), { target: { value: '{"type":"heading","text":"Edited title","id":"forged"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText('Only block content fields can be changed here.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Proposed block content'), { target: { value: '{"type":"heading","text":"Edited title"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: 'chg-1' }), { kind: 'block', block: { type: 'heading', text: 'Edited title' } });
  });

  it('keeps accepted state visible after undo and offers Restore', () => {
    const onRedo = vi.fn();
    render(<ChangeCard change={blockChange({ proposalState: 'accepted', applicationState: 'reverted' })} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={onRedo} onOpenSource={vi.fn()} />);
    expect(screen.getByText(/You accepted this rewrite/)).toBeTruthy();
    expect(screen.getByText('Undone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRedo).toHaveBeenCalledWith(expect.objectContaining({ proposalState: 'accepted', applicationState: 'reverted' }));
  });

  it('omits user attribution and emits exact source tuple for agent changes', () => {
    const onOpenSource = vi.fn();
    const changes = [blockChange({ batchId: 'batch-a' }), blockChange({ id: 'user-change', batchId: 'batch-b', source: { kind: 'user' }, applicationState: 'applied', proposalState: null })];
    const onRevertBatch = vi.fn();
    render(<PageChanges changes={changes} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onRevertBatch={onRevertBatch} onOpenSource={onOpenSource} loading={false} error={null} />);
    expect(screen.getAllByText('Open exact message')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open exact message' }));
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' });
    expect(screen.queryByRole('button', { name: /Undo all/ })).toBeNull();
    expect(screen.getByText('Page updated')).toBeTruthy();
    expect(onRevertBatch).not.toHaveBeenCalled();
  });

  it('keeps user edits in history while exposing undo only for revertible agent changes in a mixed batch', () => {
    const userChange = blockChange({
      id: 'user-edit', source: { kind: 'user' }, proposalState: null, applicationState: 'applied',
    });
    const agentChange = blockChange({
      id: 'agent-edit', source: { kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' },
      proposalState: null, applicationState: 'applied',
    });
    const onRevert = vi.fn();
    render(<PageChanges changes={[userChange, agentChange]} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={onRevert} onRedo={vi.fn()} onRevertBatch={vi.fn()} onOpenSource={vi.fn()} loading={false} error={null} />);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(screen.getByText('Page updated')).toBeTruthy();
    expect(screen.getByText('Agent updated')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo all (1)' })).toBeTruthy();
  });

  it('offers older activity pagination independently of the loaded change list', () => {
    const onLoadMore = vi.fn();
    render(<PageChanges changes={[]} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onRevertBatch={vi.fn()} onOpenSource={vi.fn()} loading={false} error={null} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it.each(['card', 'inline'] as const)('shows and edits the proposed row text of a %s row suggestion', (variant) => {
    const onAccept = vi.fn();
    const change = rowChange({ kind: 'row', op: 'patch', id: 'r1', values: { status: 'done' }, body: 'Agent notes' });
    render(<ChangeCard change={change} variant={variant} onAccept={onAccept} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />);
    // What Accept would write, before choosing.
    expect(document.body.textContent).toContain('Agent notes');
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    expect((screen.getByLabelText('Proposed row text') as HTMLTextAreaElement).value).toBe('Agent notes');
    fireEvent.change(screen.getByLabelText('Proposed row text'), { target: { value: 'My notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    expect(onAccept).toHaveBeenCalledWith(change, { kind: 'row', values: { status: 'done' }, body: 'My notes' });
  });

  it.each(['card', 'inline'] as const)('names a %s row removal as a removal', (variant) => {
    const change = rowChange({ kind: 'row', op: 'delete', id: 'r1', expectedLocation: { position: 0, after: null } });
    render(<ChangeCard change={change} variant={variant} onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />);
    expect(screen.getByText(variant === 'card' ? 'Suggested row deletion' : 'Suggested removal')).toBeTruthy();
    expect(screen.getByText('Accepting removes the row.')).toBeTruthy();
    expect(screen.queryByText('Suggested field update')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit & accept' })).toBeNull();
  });

  it('says a row removal waits for you as a removal in a list', () => {
    const change = rowChange({ kind: 'row', op: 'delete', id: 'r1', expectedLocation: { position: 0, after: null } });
    render(<ChangeCard change={change} variant="inline" showTarget onAccept={vi.fn()} onDismiss={vi.fn()} onReopen={vi.fn()} onRevert={vi.fn()} onRedo={vi.fn()} onOpenSource={vi.fn()} />);
    expect(screen.getByText('Waiting for you: remove this row')).toBeTruthy();
  });

  it('names a block as Home does, without its Markdown marks', () => {
    const location = { parentId: null, slot: null, previousId: null, nextId: null };
    const block = { id: 'block-1', rev: 2, type: 'markdown' as const, text: '## 本周重点\n- a' };
    const change = blockChange({
      before: { kind: 'block', exists: true, block: { id: 'block-1', rev: 1, type: 'markdown', text: 'Old' }, location },
      after: { kind: 'block', exists: true, block, location }, forward: { kind: 'block', op: 'upsert', block, location },
    });
    const props = { onAccept: vi.fn(), onDismiss: vi.fn(), onReopen: vi.fn(), onRevert: vi.fn(), onRedo: vi.fn(), onOpenSource: vi.fn() };
    const view = render(<ChangeCard change={change} {...props} />);
    expect(screen.getByText('Suggested rewrite of “本周重点”')).toBeTruthy();
    view.unmount();
    render(<ChangeCard change={change} variant="inline" showTarget {...props} />);
    expect(screen.getByText('Waiting for you: rewrite “本周重点”')).toBeTruthy();
  });
});

/** A pending suggestion for row r1, recorded as the backend records every row change (op 'row'). */
function rowChange(forward: PageChangeDto['forward']): PageChangeDto {
  const row = { id: 'r1', values: { task: 'Write the spec', status: 'doing' }, body: 'My own notes', position: 0, updatedAt: 1, rev: 1, edited: { status: 1 }, bodyEditedAt: 1 };
  const location = { position: 0, after: null };
  const removal = forward.kind === 'row' && forward.op === 'delete';
  return blockChange({
    target: { kind: 'row', databaseId: 'db', rowId: 'r1', columnIds: ['status'], body: true }, op: 'row',
    before: { kind: 'row', exists: true, row, location },
    after: removal ? { kind: 'row', exists: false, id: 'r1', location: null }
      : { kind: 'row', exists: true, row: { ...row, values: { ...row.values, status: 'done' }, body: 'Agent notes' }, location },
    forward,
    inverse: removal ? { kind: 'row', op: 'upsert', row, location } : { kind: 'row', op: 'patch', id: 'r1', values: { status: 'doing' }, body: 'My own notes' },
  });
}
