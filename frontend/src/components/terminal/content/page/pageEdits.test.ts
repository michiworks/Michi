import { describe, expect, it } from 'vitest';
import type { MichiPageBlock } from 'michi-shared';
import {
  blockFingerprint,
  checklistChanges,
  deleteOps,
  draftMarkdown,
  draftText,
  insertMarkdown,
  insertOp,
  isEditableBlock,
  isEditedBlock,
  releaseOp,
  staleTargetOf,
  textChanges,
  toggledChecklist,
  updateOp,
} from './pageEdits';

const md: MichiPageBlock = { type: 'markdown', id: 'md', text: 'Old words', sources: [{ sessionId: 's1' }], edit: { at: 1, anchor: null } };
const list: MichiPageBlock = {
  type: 'checklist', id: 'cl', title: 'Before leaving', items: [{ text: 'Book', done: true }, { text: 'Pack', done: false }],
};

describe('which blocks a person may edit', () => {
  it('allows the types Michi rewrites in place, by id only', () => {
    for (const type of ['markdown', 'heading', 'callout', 'checklist']) expect(isEditableBlock({ type, id: 'x' })).toBe(true);
    for (const type of ['quote', 'text', 'compare', 'plan-actual', 'database', 'threads']) {
      expect(isEditableBlock({ type, id: 'x' })).toBe(false);
    }
    expect(isEditableBlock({ type: 'markdown', text: 'no id' })).toBe(false);
  });

  it('reads the edit mark and the agent note target', () => {
    expect(isEditedBlock(md)).toBe(true);
    expect(isEditedBlock(list)).toBe(false);
    expect(staleTargetOf({ type: 'callout', id: 'n', text: 'May be outdated', staleFor: 'md' })).toBe('md');
    expect(staleTargetOf(md)).toBeNull();
  });
});

describe('update ops', () => {
  it('sends the whole block with its changes, its sources kept and its old edit mark left to Michi', () => {
    expect(updateOp(md, { text: 'New words' })).toEqual({
      op: 'update', id: 'md', block: { type: 'markdown', id: 'md', text: 'New words', sources: [{ sessionId: 's1' }] },
    });
    expect(updateOp({ type: 'markdown', text: 'x' }, { text: 'y' })).toBeNull();
  });

  it('keeps the block type even when the changes name another', () => {
    expect(updateOp(md, { type: 'heading', text: 'x' })).toMatchObject({ block: { type: 'markdown' } });
  });

  it('sends a text change only when the words changed and are not empty', () => {
    expect(textChanges(md, '\n\nNew words  \n')).toEqual({ text: 'New words' });
    expect(textChanges(md, 'Old words\n')).toBeNull();
    expect(textChanges(md, '   \n ')).toBeNull();
    const heading: MichiPageBlock = { type: 'heading', id: 'h', text: 'Plan' };
    expect(textChanges(heading, ' Next\n steps ')).toEqual({ text: 'Next steps' });
    expect(textChanges(heading, 'Plan ')).toBeNull();
    expect(textChanges({ type: 'callout', id: 'c', text: 'a' }, 'b')).toEqual({ text: 'b' });
  });

  it('sends a callout’s title with its words, on one line, and drops an emptied one', () => {
    const callout: MichiPageBlock = { type: 'callout', id: 'c', tone: 'warn', title: 'Blockers', text: 'S3 naming' };
    expect(textChanges(callout, 'S3 naming', ' Hard\n questions ')).toEqual({ title: 'Hard questions' });
    expect(textChanges(callout, 'S3 naming, again', 'Blockers')).toEqual({ text: 'S3 naming, again' });
    expect(textChanges(callout, 'S3 naming', 'Blockers ')).toBeNull();
    // An emptied title goes (Michi keeps a callout without one); emptied words stay as they were.
    const cleared = textChanges(callout, '  ', '');
    expect(cleared).toEqual({ title: undefined });
    // As sent (JSON), the update leaves the title out.
    expect(JSON.parse(JSON.stringify(updateOp(callout, cleared!)))).toEqual({
      op: 'update', id: 'c', block: { type: 'callout', id: 'c', tone: 'warn', text: 'S3 naming' },
    });
    // A title is a callout's alone.
    expect(textChanges(md, 'Old words', 'Title')).toBeNull();
  });

  it('drops blank checklist items, keeps the title when emptied, and refuses an empty list', () => {
    expect(checklistChanges(list, '', [{ text: 'Book', done: true }, { text: '  ', done: false }, { text: 'Buy ICOCA', done: false }]))
      .toEqual({ title: 'Before leaving', items: [{ text: 'Book', done: true }, { text: 'Buy ICOCA', done: false }] });
    expect(checklistChanges(list, 'Before leaving', [{ text: 'Book', done: true }, { text: 'Pack', done: false }])).toBeNull();
    expect(checklistChanges(list, 'Trip', [{ text: 'Book', done: true }, { text: 'Pack', done: false }]))
      .toEqual({ title: 'Trip', items: [{ text: 'Book', done: true }, { text: 'Pack', done: false }] });
    expect(checklistChanges(list, 'x', [{ text: ' ', done: false }])).toBe('empty');
  });

  it('ticks one checklist item', () => {
    expect(toggledChecklist(list, 1)).toEqual({ ...list, items: [{ text: 'Book', done: true }, { text: 'Pack', done: true }] });
    expect(toggledChecklist(list, 0)?.items).toEqual([{ text: 'Book', done: false }, { text: 'Pack', done: false }]);
    expect(toggledChecklist(list, 5)).toBeNull();
  });
});

describe('adding blocks', () => {
  it('writes each kind as Markdown, since Michi adds Markdown only', () => {
    expect(insertMarkdown('text', '\nSome **words**\n')).toBe('Some **words**');
    expect(insertMarkdown('heading', '  Next  steps ')).toBe('## Next steps');
    expect(insertMarkdown('todo', 'Book\n\n Pack ')).toBe('- [ ] Book\n- [ ] Pack');
    expect(insertMarkdown('callout', 'Blocked on S3\n\nsee plan')).toBe('> Blocked on S3\n>\n> see plan');
    for (const kind of ['text', 'heading', 'todo', 'callout'] as const) expect(insertMarkdown(kind, ' \n ')).toBeNull();
  });

  it('inserts after the block, without an id (Michi assigns one)', () => {
    expect(insertOp('b1', '## Hi')).toEqual({ op: 'insert', after: 'b1', block: { type: 'markdown', text: '## Hi' } });
    expect(insertOp(null, 'Top')).toEqual({ op: 'insert', after: null, parent: null, block: { type: 'markdown', text: 'Top' } });
  });

  it('deletes and releases by id', () => {
    expect(deleteOps(['a', 'b'])).toEqual([{ op: 'delete', id: 'a' }, { op: 'delete', id: 'b' }]);
    expect(releaseOp('a')).toEqual({ op: 'release', id: 'a' });
  });
});

describe('drafts', () => {
  it('turns an open editor’s words into the Markdown block they would be', () => {
    expect(draftMarkdown('heading', { kind: 'text', text: '  Plan  ' })).toBe('## Plan');
    expect(draftMarkdown('callout', { kind: 'text', text: 'Careful\nnow' })).toBe('> Careful\n> now');
    expect(draftMarkdown('callout', { kind: 'text', title: ' Heads up ', text: 'Careful' })).toBe('> **Heads up**\n> Careful');
    expect(draftText({ kind: 'text', title: 'Heads up', text: 'Careful' })).toBe('Heads up\nCareful');
    expect(draftMarkdown('markdown', { kind: 'text', text: '\nWords  ' })).toBe('Words');
    expect(draftMarkdown('todo', { kind: 'text', text: 'Book\nPack' })).toBe('- [ ] Book\n- [ ] Pack');
    expect(draftMarkdown('checklist', { kind: 'checklist', title: 'Trip', items: [{ text: 'Book', done: true }, { text: ' ', done: false }] }))
      .toBe('**Trip**\n\n- [x] Book');
    expect(draftMarkdown('markdown', { kind: 'text', text: '   ' })).toBeNull();
  });

  it('copies a checklist draft as plain lines', () => {
    expect(draftText({ kind: 'checklist', title: 'Trip', items: [{ text: 'Book', done: true }, { text: 'Pack', done: false }] }))
      .toBe('Trip\n- [x] Book\n- [ ] Pack');
    expect(draftText({ kind: 'text', text: 'as typed ' })).toBe('as typed ');
  });
});

describe('fingerprints', () => {
  it('tell a block by what it says and, for a piece, the block it came from', () => {
    const b: MichiPageBlock = { type: 'markdown', id: 'b', text: 'Words' };
    expect(blockFingerprint(b)).toBe(blockFingerprint({ ...b, sources: [{ sessionId: 's' }], edit: { at: 1, anchor: null } }));
    expect(blockFingerprint(b)).not.toBe(blockFingerprint({ ...b, text: 'Other' }));
    expect(blockFingerprint(b)).not.toBe(blockFingerprint({ ...b, type: 'heading' }));
    expect(blockFingerprint(b, 'x')).not.toBe(blockFingerprint(b, 'y'));
    expect(blockFingerprint(list)).not.toBe(blockFingerprint(toggledChecklist(list, 1)!));
  });
});
