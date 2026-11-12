import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PAGE_BLOCK_CATALOG, type PageDto, type PageEditOp } from 'michi-shared';
import NativePageDocument from './NativePageDocument';
import { getCompanionPanelState, resetCompanionPanelForTests, takeCompanionRequests } from '../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';

const makePage = (revision = 2, blocks: PageDto['blocks'] = [{ id: 'b1', rev: 1, type: 'markdown', text: 'Before' }]): PageDto => ({
  id: 'pg-1', workspaceId: 'ws-1', parentId: null, position: 0, title: 'Research notes', color: null,
  updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision, viewVersion: revision, blocks,
});

const noopEdit = vi.fn(async (_ops: PageEditOp[], _revision: number) => 'ok' as const);

describe('NativePageDocument', () => {
  afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard'); });

  it('saves a nested checklist as an atomic parent edit without renderer-only child IDs', async () => {
    const edit = vi.fn(async () => 'ok' as const);
    render(<NativePageDocument page={makePage(2, [{ id: 'group', rev: 1, type: 'toggle', title: 'Details', blocks: [{ type: 'checklist', items: [{ text: 'Review', done: false }] }] }])} onEdit={edit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Review' }));
    expect(edit).toHaveBeenCalledWith([{ op: 'update', id: 'group', expectRev: 1, block: { type: 'toggle', title: 'Details', blocks: [{ type: 'checklist', items: [{ text: 'Review', done: true }] }] } }], 2);
  });

  it('navigates contents to native headings inside collapsed and inactive containers', async () => {
    const page = makePage(2, [
      { id: 'contents', rev: 1, type: 'toc' },
      { id: 'group:one/α', rev: 1, type: 'tabs', tabs: [
        { label: 'Overview', blocks: [{ type: 'markdown', text: 'Overview' }] },
        { label: 'Details', blocks: [{ type: 'toggle', title: 'Hidden', blocks: [{ type: 'heading', text: 'Destination' }] }] },
      ] },
    ]);
    const { container } = render(<main><NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} /></main>);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Contents' })).getByRole('button', { name: 'Destination' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(container.querySelector('details')?.open).toBe(true));
    expect([...container.querySelectorAll('[data-flash]')].some(el => el.getAttribute('data-block-id') === 'group:one/α.1.0')).toBe(true);
  });

  it('offers the requested block menu and selects, asks, opens exact sources and copies text', async () => {
    const source = { nodeId: 'n', turnId: 't', assistantId: 'a' };
    const onAskAssistant = vi.fn();
    const onOpenSource = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const { container } = render(<NativePageDocument page={makePage(2, [{ id: 'b1', rev: 1, type: 'markdown', text: 'Before', sources: [source] }])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} onAskAssistant={onAskAssistant} onOpenSource={onOpenSource} sourceLabel={() => 'Research conversation'} />);
    const menu = () => { fireEvent.click(screen.getByRole('button', { name: 'Block menu' })); return screen.getByRole('menu'); };
    // The menu's Ask hands the block to the panel, so it is named after the agent, as the toolbar's is (DESIGN-v2 §1.5).
    expect(within(menu()).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Select', 'Ask Michi', 'Sources', 'Ignore', 'Archive', 'Copy text']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select' }));
    expect(container.querySelector('[data-block-id="b1"]')?.getAttribute('data-selected')).toBe('true');
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Ask Michi' }));
    expect(onAskAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Research conversation' }));
    await waitFor(() => expect(onOpenSource).toHaveBeenCalledWith(source));
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Copy text' }));
    expect(copy).toHaveBeenCalledWith('Before');
    expect(container.querySelector('.native-page-sources')).toBeNull();
  });

  it('says when Copy text could not reach the clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<NativePageDocument page={makePage(2, [{ id: 'b1', rev: 1, type: 'markdown', text: 'Before' }])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Copy text' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t copy the text/);
  });

  it('exposes native actions as hover icons with accessible labels and exact source navigation', async () => {
    const source = { nodeId: 'n', turnId: 't', assistantId: 'a' };
    const open = vi.fn();
    const ask = vi.fn();
    const edit = vi.fn().mockResolvedValue('ok');
    render(<NativePageDocument page={makePage(2, [{ id: 'b1', rev: 1, type: 'markdown', text: 'Before', sources: [source] }])} onEdit={edit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} onAskAssistant={ask} onOpenSource={open} sourceLabel={() => 'Research'} />);
    const toolbar = screen.getByRole('toolbar');
    expect(within(toolbar).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Select', 'Ask Michi', 'Sources', 'Ignore', 'Archive', 'Edit']);
    expect(toolbar.textContent).toBe('');
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Select' }));
    expect(within(toolbar).getByRole('button', { name: 'Deselect' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Ask Michi' }));
    expect(ask).toHaveBeenCalledTimes(1);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(source));
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith([expect.objectContaining({ op: 'update', id: 'b1' })], 2));
    await waitFor(() => expect((within(toolbar).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Archive' }));
    expect(edit).toHaveBeenLastCalledWith([{ op: 'delete', id: 'b1', expectRev: 1 }], 2);
  });

  it('protects ignored content and archives only the current block through versioned page edits', async () => {
    const onEdit = vi.fn().mockResolvedValue('ok');
    render(<NativePageDocument page={makePage()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ignore' }));
    await waitFor(() => expect(onEdit).toHaveBeenLastCalledWith([{ op: 'update', id: 'b1', block: { type: 'markdown', text: 'Before' }, expectRev: 1 }], 2));
    fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Archive' }).getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(onEdit).toHaveBeenLastCalledWith([{ op: 'delete', id: 'b1', expectRev: 1 }], 2);
  });

  it('keeps content and reports a refused archive instead of pretending it succeeded', async () => {
    const onEdit = vi.fn().mockResolvedValue('stale');
    render(<NativePageDocument page={makePage()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The page changed. Try again.');
    expect(screen.getByText('Before')).toBeTruthy();
  });

  it('says why text added below a block on a full page was not saved, and keeps the words', async () => {
    const full = makePage(2, Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, rev: 1, type: 'markdown' as const, text: `Block ${i}` })));
    const onEdit = vi.fn(async () => 'ok' as const);
    render(<NativePageDocument page={full} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add block below' })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'New text' }), { target: { value: 'One more' } });
    fireEvent.click(screen.getByText('Add', { selector: 'button' }), { detail: 1 });
    expect((await screen.findByRole('alert')).textContent).toBe('A page may contain at most 40 blocks');
    expect(onEdit).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'New text' }) as HTMLTextAreaElement).value).toBe('One more');
  });

  it('reports a block edit the page refused', async () => {
    const onEdit = vi.fn(async () => 'failed' as const);
    render(<NativePageDocument page={makePage()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New text' }), { target: { value: 'After' } });
    fireEvent.click(screen.getByText('Add', { selector: 'button' }), { detail: 1 });
    expect((await screen.findByRole('alert')).textContent).toBe('Could not save this change. Try again.');
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('uses the shared editor and submits a strict update with the opened page revision', async () => {
    const onEdit = vi.fn(async (_ops: PageEditOp[], _revision: number) => 'ok' as const);
    render(<NativePageDocument page={makePage()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit Before' }), { target: { value: 'After' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Before');
    expect(onEdit).toHaveBeenCalledWith([
      { op: 'update', id: 'b1', block: { type: 'markdown', text: 'After' }, expectRev: 1 },
    ], 2);
  });

  it('keeps an open draft and disables save after the authoritative page revision changes', () => {
    const { rerender } = render(<NativePageDocument page={makePage()} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Edit Before' });
    fireEvent.change(editor, { target: { value: 'My draft' } });
    rerender(<NativePageDocument page={makePage(3)} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    expect((screen.getByRole('textbox', { name: 'Edit Before' }) as HTMLTextAreaElement).value).toBe('My draft');
    expect(screen.getByText('The page changed while you were editing')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('routes native page links and database refs through injected workspace renderers', () => {
    const onOpenPage = vi.fn();
    const renderDatabaseRef = vi.fn(() => <div data-testid="native-db">Database view</div>);
    const page = makePage(2, [
      { id: 'link', rev: 1, type: 'page-link', pageId: 'pg-2' },
      { id: 'db', rev: 1, type: 'database-ref', databaseId: 'db-2' },
    ]);
    render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={onOpenPage} renderDatabaseRef={renderDatabaseRef} />);
    fireEvent.click(screen.getByRole('button', { name: 'pg-2' }));
    expect(onOpenPage).toHaveBeenCalledWith('pg-2');
    expect(screen.getByTestId('native-db')).toBeTruthy();
    expect(renderDatabaseRef).toHaveBeenCalledWith(page.blocks[1], false, false);
  });

  it('lets an embedded pane provide the page title and asks database renderers for compact output', () => {
    const renderDatabaseRef = vi.fn(() => <div data-testid="native-db">Database view</div>);
    const page = makePage(2, [{ id: 'db', rev: 1, type: 'database-ref', databaseId: 'db-2' }]);
    render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={renderDatabaseRef} compact />);
    expect(screen.queryByRole('heading', { name: 'Research notes' })).toBeNull();
    expect(renderDatabaseRef).toHaveBeenCalledWith(page.blocks[0], true, false);
  });

  it('shows a working Markdown editor on a blank page', () => {
    const onEdit = vi.fn(async (_ops: PageEditOp[], _revision: number) => 'ok' as const);
    render(<NativePageDocument page={makePage(1, [])} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'New page content' }), { target: { value: 'First note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    expect(onEdit).toHaveBeenCalledWith([{ op: 'insert', block: { type: 'markdown', text: 'First note' }, after: null }], 1);
  });

  it('says when the changed-page Copy of a blank page draft could not reach the clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const props = { onEdit: noopEdit, onOpenPage: vi.fn(), renderDatabaseRef: () => null };
    const { rerender } = render(<NativePageDocument page={makePage(1, [])} {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'New page content' }), { target: { value: 'Draft' } });
    rerender(<NativePageDocument page={makePage(2, [])} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/your text couldn’t be copied/)).toBeTruthy());
  });

  const homeBlocks: PageDto['blocks'] = [
    { id: 'm', rev: 1, type: 'metrics', items: [
      { label: '已在 dev 的分支', value: '6', note: '含定时任务' },
      { label: 'example-feature 比 dev 多', value: '2 个提交', tone: 'accent', note: '还没合入' },
    ] },
    { id: 'n', rev: 1, type: 'next-steps', title: '下一步', items: [
      { who: 'user', text: '确认风险段落的改写', unblocks: '发布说明草稿' },
      { who: 'agent', text: '跑完事务回滚用例' },
    ] },
    { id: 't', rev: 1, type: 'timeline', title: '进展', items: [
      { title: '示例改动合入 dev', at: '2026-01-06T05:35', detail: '后端全量通过。', tone: 'success' },
      { title: '实施计划写好', at: '2026-01-06' },
    ] },
  ];

  it('draws metrics, next steps and a timeline with the Michi renderers', () => {
    const { container } = render(<NativePageDocument page={makePage(2, homeBlocks)} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    const metrics = container.querySelectorAll('[data-michi-block="metrics"] .michi-doc-metric');
    expect(metrics).toHaveLength(2);
    expect(metrics[1]!.getAttribute('data-tone')).toBe('accent');
    expect(metrics[1]!.textContent).toBe('example-feature 比 dev 多2 个提交还没合入');
    expect(screen.getByRole('heading', { name: '下一步' })).toBeTruthy();
    const steps = container.querySelectorAll('.michi-doc-steps__item');
    expect([...steps].map((step) => step.querySelector('.michi-doc-steps__who')?.textContent)).toEqual(['You', 'Agent']);
    expect(steps[0]!.querySelector('.michi-doc-steps__unblocks')?.textContent).toBe('Unblocks 发布说明草稿');
    expect(screen.queryByRole('button', { name: 'Start a conversation' })).toBeNull();
    const entries = container.querySelectorAll('[data-michi-block="timeline"] li');
    expect(entries[0]!.querySelector('time')?.textContent).toMatch(/^(2026-)?01-06 05:35$/);
    expect(entries[0]!.querySelector('.michi-doc-dated__dot')?.getAttribute('data-tone')).toBe('success');
    expect(entries[0]!.querySelector('.michi-doc-dated__text')?.textContent).toBe('后端全量通过。');
    expect(entries[1]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-06');
  });

  it('starts a conversation from a next step in the page\'s workspace, and not on a read-only page', () => {
    const onStartConversation = vi.fn();
    const { rerender } = render(<NativePageDocument page={makePage(2, homeBlocks)} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} onStartConversation={onStartConversation} />);
    const buttons = screen.getAllByRole('button', { name: 'Start a conversation' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(onStartConversation).toHaveBeenCalledWith('跑完事务回滚用例', 'ws-1');
    rerender(<NativePageDocument page={makePage(2, homeBlocks)} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} onStartConversation={onStartConversation} readOnly />);
    expect(screen.queryByRole('button', { name: 'Start a conversation' })).toBeNull();
  });

  it('hands a selected structured block to the assistant as its words', () => {
    const onSelectionChange = vi.fn();
    render(<NativePageDocument page={makePage(2, homeBlocks)} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} selectOnClick onSelectionChange={onSelectionChange} />);
    fireEvent.click(screen.getByText('跑完事务回滚用例'));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ blockId: 'n', title: '下一步', content: '下一步\nYou: 确认风险段落的改写 (unblocks 发布说明草稿)\nAgent: 跑完事务回滚用例' });
  });

  it('draws task boards through the host, at the top and inside a grid', () => {
    const renderTaskView = vi.fn((block: { viewId?: string; title?: string }) => <div data-testid="task-board">{block.viewId ?? block.title}</div>);
    render(<NativePageDocument page={makePage(2, [
      { id: 'tv', rev: 1, type: 'task-view', viewId: 'tasks-needs-you' },
      { id: 'layout', rev: 1, type: 'grid', regions: [{ id: 'main', span: 8, blocks: [{ type: 'task-view', title: 'Release' }] }] },
    ])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} renderTaskView={renderTaskView} />);
    expect(screen.getAllByTestId('task-board').map((board) => board.textContent)).toEqual(['tasks-needs-you', 'Release']);
    expect(renderTaskView).toHaveBeenCalledWith({ viewId: 'tasks-needs-you' }, false, false);
  });

  it('says a task board is unavailable where the host draws none', () => {
    render(<NativePageDocument page={makePage(2, [{ id: 'tv', rev: 1, type: 'task-view' }])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    expect(screen.getByText('The task board is unavailable here.')).toBeTruthy();
  });

  it('adds what the host offers at the foot of a container’s section, saving the container', async () => {
    const edit = vi.fn(async () => 'ok' as const);
    const slotAddEntries = (insert: (block: { type: string }) => void) => [{ id: 'task-board', label: 'Task board', onSelect: () => insert({ type: 'task-view' }) }];
    render(<NativePageDocument page={makePage(2, [{ id: 'layout', rev: 1, type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'markdown', text: 'Notes' }] }] }])}
      onEdit={edit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} renderTaskView={() => <div data-testid="task-board" />} slotAddEntries={slotAddEntries} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to this section' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task board' }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith([{ op: 'update', id: 'layout', expectRev: 1, block: {
      type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'markdown', text: 'Notes' }, { type: 'task-view' }] }],
    } }], 2));
    // The section shows it at once, while it saves.
    expect(screen.getByTestId('task-board')).toBeTruthy();
  });

  it('offers no section + where the host offers nothing, or on a read-only page', () => {
    const page = makePage(2, [{ id: 'group', rev: 1, type: 'toggle', title: 'Details', blocks: [{ type: 'markdown', text: 'Inside' }] }]);
    const { unmount } = render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} slotAddEntries={() => []} />);
    expect(screen.queryByRole('button', { name: 'Add to this section', hidden: true })).toBeNull();
    unmount();
    render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} readOnly
      slotAddEntries={() => [{ id: 'x', label: 'Task board', onSelect: vi.fn() }]} />);
    expect(screen.queryByRole('button', { name: 'Add to this section', hidden: true })).toBeNull();
  });

  it('adds into a section against its latest content when the choice finishes after the page moved on', async () => {
    const edit = vi.fn(async () => 'ok' as const);
    let choose: (() => void) | undefined;
    const slotAddEntries = (insert: (block: { type: string }) => void) => [{ id: 'task-board', label: 'Task board', onSelect: () => { choose = () => insert({ type: 'task-view' }); } }];
    const grid = (blocks: Array<{ type: string; text?: string }>, rev: number) => makePage(rev, [{ id: 'layout', rev, type: 'grid', regions: [{ id: 'main', span: 12, blocks }] }] as PageDto['blocks']);
    const props = { onEdit: edit, onOpenPage: vi.fn(), renderDatabaseRef: () => null, renderTaskView: () => <div />, slotAddEntries };
    const { rerender } = render(<NativePageDocument page={grid([{ type: 'markdown', text: 'Notes' }], 1)} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to this section' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task board' }));
    rerender(<NativePageDocument page={grid([{ type: 'markdown', text: 'Notes' }, { type: 'markdown', text: 'From the agent' }], 2)} {...props} />);
    act(() => { choose?.(); });
    await waitFor(() => expect(edit).toHaveBeenCalledWith([{ op: 'update', id: 'layout', expectRev: 2, block: {
      type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'markdown', text: 'Notes' }, { type: 'markdown', text: 'From the agent' }, { type: 'task-view' }] }],
    } }], 2));
  });

  it('adds into a section inside a container through the outer container, named by its title', async () => {
    const edit = vi.fn(async () => 'ok' as const);
    const slotAddEntries = (insert: (block: { type: string }) => void) => [{ id: 'task-board', label: 'Task board', onSelect: () => insert({ type: 'task-view' }) }];
    render(<NativePageDocument page={makePage(2, [{ id: 'outer', rev: 1, type: 'toggle', title: 'Outer', blocks: [
      { type: 'grid', regions: [{ id: 'main', span: 12, title: 'Inner', blocks: [{ type: 'markdown', text: 'Notes' }] }] },
    ] }] as PageDto['blocks'])} onEdit={edit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} renderTaskView={() => <div />} slotAddEntries={slotAddEntries} />);
    fireEvent.click(screen.getByText('Outer'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Inner' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task board' }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith([{ op: 'update', id: 'outer', expectRev: 1, block: {
      type: 'toggle', title: 'Outer', blocks: [{ type: 'grid', regions: [{ id: 'main', span: 12, title: 'Inner', blocks: [{ type: 'markdown', text: 'Notes' }, { type: 'task-view' }] }] }],
    } }], 2));
  });

  describe('blocks a check-in wrote (DESIGN-v2 §2.6.2)', () => {
    const checkin = { nodeId: 'n-cmph-r1', turnId: 'cmp-r1', assistantId: 'self-n-cmph-r1-cmp-r1' };
    const user = { nodeId: 'n-user', turnId: 't', assistantId: 'a' };
    const picture = (sources: unknown[]) => ({ id: 'pic', rev: 1, type: 'markdown' as const, text: 'Look ![chart](https://example.com/chart.png)', sources: sources as never });

    it('hold their images behind "Load images" until the user asks', () => {
      const { container } = render(<NativePageDocument page={makePage(2, [picture([checkin])])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('[data-checkin-media="held"]')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
      expect(container.querySelector('[data-checkin-media="held"]')).toBeNull();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/chart.png');
    });

    it('know the check-in by the DTO’s mark too, once the source points at the post', () => {
      const posted = { nodeId: 'n-v', turnId: 'cmp-post-r1', assistantId: 'cmp-post-r1', checkin: true as const };
      const { container } = render(<NativePageDocument page={makePage(2, [picture([posted])])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByRole('button', { name: 'Load images' })).toBeTruthy();
    });

    it('leave the user’s own blocks and media-free check-in blocks as they are', () => {
      const { container } = render(<NativePageDocument page={makePage(2, [picture([user]), { id: 'plain', rev: 1, type: 'markdown', text: 'Just words, and a [link](https://reviews.example.com/x).', sources: [checkin] }])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/chart.png');
      expect(screen.queryByRole('button', { name: 'Load images' })).toBeNull();
    });

    it('keep a video or audio player behind the button, even nested in a container', () => {
      const video = { id: 'vid', rev: 1, type: 'toggle' as const, title: 'Demo', blocks: [{ type: 'video', url: 'https://example.com/demo.mp4' }], sources: [checkin] } as unknown as PageDto['blocks'][number];
      const { container } = render(<NativePageDocument page={makePage(2, [video])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      expect(container.querySelector('video')).toBeNull();
      expect(screen.getByText('Media not loaded.')).toBeTruthy();
      // "Load images" lets the player in.
      fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
      expect(screen.queryByText('Media not loaded.')).toBeNull();
      fireEvent.click(screen.getByText('Demo'));
      expect(container.querySelector('video')?.getAttribute('src')).toBe('https://example.com/demo.mp4');
    });

    it('leave the user’s own player as it is', () => {
      const video = { id: 'vid', rev: 1, type: 'toggle' as const, title: 'Demo', blocks: [{ type: 'video', url: 'https://example.com/demo.mp4' }], sources: [user] } as unknown as PageDto['blocks'][number];
      const { container } = render(<NativePageDocument page={makePage(2, [video])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      expect(screen.queryByRole('button', { name: 'Load images' })).toBeNull();
      fireEvent.click(screen.getByText('Demo'));
      expect(container.querySelector('video')?.getAttribute('src')).toBe('https://example.com/demo.mp4');
    });

    const block = (id: string, content: Record<string, unknown>, sources: unknown[] = [checkin]) => ({ id, rev: 1, ...content, sources }) as unknown as PageDto['blocks'][number];

    it('hold a person’s avatar, and leave link cards (drawn without a picture) and people without one alone', () => {
      const page = makePage(2, [
        block('card', { type: 'link', url: 'https://reviews.example.com/packages/Michi', title: 'Michi package', image: 'https://example.com/og.png' }),
        block('who', { type: 'person', name: 'Robin', avatar: 'https://example.com/robin.png' }),
        block('also', { type: 'person', name: 'Kim', avatar: 'https://example.com/kim.png' }),
        block('nobody', { type: 'person', name: 'Sam' }),
      ]);
      const { container } = render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      const frame = (id: string) => container.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
      expect(container.querySelector('img')).toBeNull();
      expect(frame('who').querySelector('[data-checkin-media="held"]')).not.toBeNull();
      expect(frame('card').querySelector('[data-checkin-media="held"]')).toBeNull();
      expect(within(frame('card')).getByText('Michi package')).toBeTruthy();
      expect(frame('nobody').querySelector('[data-checkin-media="held"]')).toBeNull();
      expect(within(frame('nobody')).getByText('Sam')).toBeTruthy();
      // Loading one block's images loads that block's only.
      fireEvent.click(within(frame('who')).getByRole('button', { name: 'Load images' }));
      expect(frame('who').querySelector('[data-checkin-media="held"]')).toBeNull();
      expect(frame('also').querySelector('[data-checkin-media="held"]')).not.toBeNull();
    });

    it('leave an embed alone: its page loads only on a click', () => {
      const page = makePage(2, [block('frame', { type: 'embed', url: 'https://reviews.example.com/reviews/CR-1', title: 'Review' })]);
      render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      expect(screen.queryByRole('button', { name: 'Load images' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Load page' })).toBeTruthy();
    });

    it('fail closed: a library component a check-in wrote waits whole, though pictures do not reach it', () => {
      const page = makePage(2, [block('lib', { type: 'component', componentId: 'c1', pinnedVersion: 1, props: {}, height: 200 })]);
      const { container } = render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null}
        renderComponent={() => <iframe title="Library component" src="https://example.com/widget" />} />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(screen.getByText('Media not loaded.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/widget');
    });
  });

  describe('databases and task boards where the page is narrow (F1b-review #5)', () => {
    const observers: Array<() => void> = [];
    let width = 0;
    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal('ResizeObserver', class {
        private readonly callback: () => void;
        constructor(callback: () => void) { this.callback = callback; observers.push(callback); }
        observe() {}
        unobserve() {}
        disconnect() { const at = observers.indexOf(this.callback); if (at >= 0) observers.splice(at, 1); }
      });
      const original = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('michi-doc-blocks') ? { width, height: 400, top: 0, left: 0, right: width, bottom: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect : original.call(this);
      });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    const page = makePage(2, [{ id: 'db', rev: 1, type: 'database-ref', databaseId: 'tasks' }, { id: 'board', rev: 1, type: 'task-view' }] as PageDto['blocks']);
    const renderPage = (compact?: boolean) => render(<NativePageDocument page={page} onEdit={noopEdit} onOpenPage={vi.fn()} compact={compact}
      renderDatabaseRef={(_block, narrow) => <span data-testid="database" data-compact={String(Boolean(narrow))} />}
      renderTaskView={(_block, narrow) => <span data-testid="board" data-compact={String(Boolean(narrow))} />} />);
    const shapes = () => [screen.getByTestId('database').dataset.compact, screen.getByTestId('board').dataset.compact];

    it('take their narrow form below three board columns, as when the panel is docked beside the page, and their wide form again after', () => {
      width = 1100;
      renderPage();
      expect(shapes()).toEqual(['false', 'false']);
      width = 560;
      act(() => observers.forEach((notify) => notify()));
      expect(shapes()).toEqual(['true', 'true']);
      width = 900;
      act(() => observers.forEach((notify) => notify()));
      expect(shapes()).toEqual(['false', 'false']);
    });

    it('count an unmeasured page as wide, and keep a compact host compact', () => {
      width = 0;
      const { unmount } = renderPage();
      expect(shapes()).toEqual(['false', 'false']);
      unmount();
      width = 1100;
      renderPage(true);
      expect(shapes()).toEqual(['true', 'true']);
    });
  });

  describe('a block’s own choices and prompts (DESIGN-v2 §1.3)', () => {
    afterEach(() => { resetCompanionPanelForTests(); resetCompanionStoreForTests(); });

    it('leave a prompt in the panel’s composer, with the block as the target, in any area', () => {
      resetCompanionPanelForTests();
      const actions = { id: 'act', rev: 1, type: 'actions', buttons: [{ label: 'Draft reply', prompt: 'Draft the release reply' }] } as unknown as PageDto['blocks'][number];
      render(<NativePageDocument page={makePage(2, [actions])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      fireEvent.click(screen.getByRole('button', { name: 'Draft reply' }));
      expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', target: { pageId: 'pg-1', blockId: 'act', workspaceId: 'ws-1', title: 'Draft reply' } });
      expect(takeCompanionRequests()).toEqual([{ draft: 'Draft the release reply' }]);
    });

    it('send a visible choice right away through the panel', () => {
      resetCompanionPanelForTests();
      const poll = { id: 'p', rev: 1, ...PAGE_BLOCK_CATALOG.poll.example! } as unknown as PageDto['blocks'][number];
      render(<NativePageDocument page={makePage(2, [poll])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Sushi' }));
      fireEvent.click(screen.getByRole('button', { name: 'Vote' }));
      expect(getCompanionPanelState().target).toMatchObject({ pageId: 'pg-1', blockId: 'p' });
      expect(takeCompanionRequests()).toEqual([{ send: 'For “Lunch?” I pick: Sushi' }]);
    });

    it('are not offered on a read-only page or where there is no assistant', () => {
      resetCompanionStoreForTests({ assistant: { status: 'unsupported', info: null, error: null } });
      const actions = { id: 'act', rev: 1, type: 'actions', buttons: [{ label: 'Draft reply', prompt: 'Draft the release reply' }] } as unknown as PageDto['blocks'][number];
      render(<NativePageDocument page={makePage(2, [actions])} onEdit={noopEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
      fireEvent.click(screen.getByRole('button', { name: 'Draft reply' }));
      expect(getCompanionPanelState().open).toBe(false);
    });
  });
});
