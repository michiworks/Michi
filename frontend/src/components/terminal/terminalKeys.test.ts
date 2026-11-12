import { describe, expect, it } from 'vitest';
import { terminalKeySequence, withControl } from './terminalKeys';

describe('terminal keys', () => {
  it('encodes arrows for the shell and for full-screen programs', () => {
    expect(terminalKeySequence('ArrowUp', false)).toBe('\x1b[A');
    expect(terminalKeySequence('ArrowLeft', false)).toBe('\x1b[D');
    expect(terminalKeySequence('ArrowUp', true)).toBe('\x1bOA');
    expect(terminalKeySequence('Escape', true)).toBe('\x1b');
    expect(terminalKeySequence('Tab', false)).toBe('\t');
  });

  it('applies ctrl to the next character only', () => {
    expect(withControl('c')).toBe('\x03');
    expect(withControl('C')).toBe('\x03');
    expect(withControl('dx')).toBe('\x04x');
    expect(withControl('[')).toBe('\x1b');
    expect(withControl('?')).toBe('\x7f');
    expect(withControl(' ')).toBe('\x00');
    expect(withControl('~')).toBe('~');
    expect(withControl('中')).toBe('中');
  });
});
