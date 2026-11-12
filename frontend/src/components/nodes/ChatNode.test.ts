import { stripBranchPrefix, parseFanoutCommand } from './chatNodeUtils';

describe('stripBranchPrefix', () => {
  it('detects /branch prefix (case-insensitive)', () => {
    expect(stripBranchPrefix('/Branch tell me more')).toEqual({
      branched: true,
      text: 'tell me more',
    });
  });
});

describe('parseFanoutCommand', () => {
  it('parses bullet-list style', () => {
    const text = '/fanout\n- study option A\n- investigate option B\n* research C';
    expect(parseFanoutCommand(text)).toEqual({
      topics: ['study option A', 'investigate option B', 'research C'],
    });
  });

  it('is case-insensitive and accepts /fan-out + /explore', () => {
    expect(parseFanoutCommand('/FANOUT a;b')).toEqual({ topics: ['a', 'b'] });
    expect(parseFanoutCommand('/fan-out a;b')).toEqual({ topics: ['a', 'b'] });
    expect(parseFanoutCommand('/Explore a;b')).toEqual({ topics: ['a', 'b'] });
  });

  it('returns empty topics when only the command is typed', () => {
    expect(parseFanoutCommand('/fanout')).toEqual({ topics: [] });
    expect(parseFanoutCommand('/fanout   ')).toEqual({ topics: [] });
  });

  it('leaves a longer name that starts with the command to the skill it names', () => {
    for (const text of ['/explore-codebase how auth works', '/explore-codebase', '/fanout-plan release', '/fan-out-review the diff', '/explore:deep x']) {
      expect(parseFanoutCommand(text)).toBeNull();
    }
    expect(parseFanoutCommand('/explore\ta; b')).toEqual({ topics: ['a', 'b'] });
  });
});
