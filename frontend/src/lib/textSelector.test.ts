import { describe, expect, it } from 'vitest';
import { computeTextSelector } from './textSelector';

const DOC = [
  '# Top Level',
  '',
  '## Configuration Fields',
  '',
  '### domainOwner',
  '',
  'Which team/service owns the data (Editor, Renderer, Storage, etc.).',
  '',
  '### storeType',
  '',
  'Which site types support this configuration.',
  '',
  '## API Endpoints',
  '',
  'The main endpoint for queries.',
].join('\n');

describe('computeTextSelector', () => {
  it('handles selection at the very start of the document', () => {
    const sel = computeTextSelector(DOC, 0, 11); // "# Top Level"
    expect(sel.exact).toBe('# Top Level');
    expect(sel.prefix).toBeUndefined(); // empty string → undefined
    expect(sel.suffix).toBeDefined();
    expect(sel.startOffset).toBe(0);
    expect(sel.startLine).toBe(1);
  });

  it('handles selection at the very end of the document', () => {
    const phrase = 'The main endpoint for queries.';
    const start = DOC.indexOf(phrase);
    const end = start + phrase.length;
    const sel = computeTextSelector(DOC, start, end);
    expect(sel.exact).toBe(phrase);
    expect(sel.suffix).toBeUndefined(); // end of doc → empty → undefined
  });
});
