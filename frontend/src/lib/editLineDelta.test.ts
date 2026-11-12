import { describe, expect, it } from 'vitest';
import { editLineDelta, lineDiff } from './editLineDelta';

describe('lineDiff', () => {
  it('counts an edit\'s lines by what changed, not by its size', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 });
    expect(lineDiff('x', 'x\ny\nz')).toEqual({ added: 2, removed: 0 });
    expect(lineDiff('', 'new')).toEqual({ added: 1, removed: 0 });
    expect(lineDiff('one\ntwo\nthree\nfour', 'one\nthree\nfour\nfive')).toEqual({ added: 1, removed: 1 });
  });

  it('counts a newline-terminated text\'s lines as git does', () => {
    expect(lineDiff(undefined, 'x\ny\n')).toEqual({ added: 2, removed: 0 });
    expect(lineDiff('', 'x\n')).toEqual({ added: 1, removed: 0 });
    expect(lineDiff('a\nb\n', '')).toEqual({ added: 0, removed: 2 });
    expect(lineDiff('', '\n')).toEqual({ added: 1, removed: 0 });
  });
});

describe('editLineDelta', () => {
  it('reads Claude and Kiro edit and write inputs', () => {
    expect(editLineDelta({ old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' })).toEqual({ added: 2, removed: 1 });
    expect(editLineDelta({ oldStr: 'a', newStr: 'a\nb' })).toEqual({ added: 1, removed: 0 });
    expect(editLineDelta({ content: 'x\ny' })).toEqual({ added: 2, removed: 0 });
    expect(editLineDelta({ command: 'create', text: 'x\ny' })).toEqual({ added: 2, removed: 0 });
  });

  it('sums a multi-edit\'s edits', () => {
    expect(editLineDelta({ edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '', new_string: 'c\nd' }] }))
      .toEqual({ added: 3, removed: 1 });
  });

  it('is null when the input carries no text', () => {
    expect(editLineDelta({ path: 'x.ts' })).toBeNull();
    expect(editLineDelta({ edits: [] })).toBeNull();
  });
});
