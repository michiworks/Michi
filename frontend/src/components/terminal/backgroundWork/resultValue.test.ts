import { describe, expect, it } from 'vitest';
import { readResultValue } from './resultValue';

describe('readResultValue', () => {
  it('reads whole JSON and leaves prose and scalars alone', () => {
    expect(readResultValue('{"a": 1}')).toEqual({ value: { a: 1 }, open: new Set() });
    expect(readResultValue('All read.')).toBeUndefined();
    expect(readResultValue('[CR-1](https://example.com) is ready')).toBeUndefined();
    expect(readResultValue('42')).toBeUndefined();
  });

  it('keeps what a cut text holds and marks the innermost open list as its end', () => {
    const read = readResultValue('{"docs": [{"file": "a.md", "notes": ["one", "tw…')!;
    expect(read.value).toEqual({ docs: [{ file: 'a.md', notes: ['one', 'tw…'] }] });
    const docs = (read.value as { docs: Array<{ notes: string[] }> }).docs;
    expect(read.cut).toBe(docs[0].notes);
    expect([...read.open]).toEqual([docs[0].notes, docs[0], docs, read.value]);
  });

  it('leaves out a key, number or literal the text ends inside', () => {
    expect(readResultValue('{"a": 1, "bc…')?.value).toEqual({ a: 1 });
    expect(readResultValue('{"a": 1, "b":')?.value).toEqual({ a: 1 });
    expect(readResultValue('[1, 2')?.value).toEqual([1]);
    expect(readResultValue('[1, 2.')?.value).toEqual([1]);
    expect(readResultValue('[true, fal')?.value).toEqual([true]);
    expect(readResultValue('{"a": [1, 2, ')?.value).toEqual({ a: [1, 2] });
  });

  it('decodes a cut string and drops a half-written escape', () => {
    expect(readResultValue('["line\\nnext')?.value).toEqual(['line\nnext…']);
    expect(readResultValue('["a\\')?.value).toEqual(['a…']);
    expect(readResultValue('["a\\u00')?.value).toEqual(['a…']);
    expect(readResultValue('["a\\\\')?.value).toEqual(['a\\…']);
  });

  it('keeps a "__proto__" key an ordinary field, as JSON.parse does', () => {
    const read = readResultValue('{"__proto__": {"x": 1}, "y": [')!;
    expect(Object.getPrototypeOf(read.value)).toBe(Object.prototype);
    expect(Object.keys(read.value as object)).toEqual(['__proto__', 'y']);
  });

  it('rejects text that is not JSON before its end', () => {
    expect(readResultValue("{'a': 1")).toBeUndefined();
    expect(readResultValue('{"a": 1 "b"')).toBeUndefined();
    expect(readResultValue('{"a": 1} and more')).toBeUndefined();
  });
});
