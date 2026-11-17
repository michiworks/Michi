import { describe, expect, it } from 'vitest';
import { createCodePlugin, type CodeHighlighterPlugin } from './shikiCodePlugin';

type Result = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;

function highlighted(plugin: CodeHighlighterPlugin, code: string): Promise<Result> {
  return new Promise((resolve) => {
    const cached = plugin.highlight({ code, language: 'text', themes: ['github-light', 'github-dark'] }, resolve);
    if (cached) resolve(cached);
  });
}
const textOf = (result: Result) => result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n');

describe('createCodePlugin', () => {
  it('gives two blocks that share their length, start and end but differ in between their own tokens', async () => {
    const plugin = createCodePlugin();
    const edge = 'x'.repeat(120);
    const first = await highlighted(plugin, `${edge}\nvalue15 = 10\n${edge}`);
    const second = await highlighted(plugin, `${edge}\nvalue15 = 20\n${edge}`);
    expect(textOf(first)).toContain('value15 = 10');
    expect(textOf(second)).toContain('value15 = 20');
  });
});
