import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// A .js test, as the other tests in src/ that read files are: src/ is typechecked without Node's types.

/**
 * DESIGN-v2 §1.5 / U1: the Meta agent is not a persona of its own any more.
 * The agent the user talks to goes by the name the user gave it, its
 * background maintenance is "<name> · Pages upkeep", and Settings › Meta
 * agent is part of Settings › <name>. So no text the frontend shows says
 * "Meta agent": no string literal, template text or JSX text in src/
 * (comments, identifiers and the `meta-agent` ids are not shown).
 *
 * Search keywords are matched, never shown, and keep the old name so people
 * can still find the settings by it: arrays given as `keywords` or held in a
 * `*_WORDS` const are exempt.
 *
 * PENDING lists files allowed to still show it, with exactly how many such
 * strings each has: a file may not gain one, and an entry that is higher than
 * the file's count, or names a file that is gone, fails too, so the list only
 * shrinks. The W2 merge took it to empty; keep it that way.
 */
/** @type {Record<string, number>} */
const PENDING = {};

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const META_AGENT = /\bmeta\s+agent\b/i;

/** Every .ts/.tsx source under src/, tests and src/test/ left out. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' && dir === SRC ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Strings that are search keywords: inside an array that is a `keywords` value or a `*_WORDS` const. */
function isKeyword(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isArrayLiteralExpression(current) && !ts.isSpreadElement(current) && !ts.isAsExpression(current)) {
      if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) return current.name.text === 'keywords';
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return /_WORDS$/.test(current.name.text);
      return false;
    }
  }
  return false;
}

/** Each text a source can show that says "Meta agent", as `line: text`. */
function shownMetaAgent(text, fileName) {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    const shown = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (shown && META_AGENT.test(node.text) && !isKeyword(node)) {
      found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${node.text.trim().replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The file's text, or null when it went away while the tree was read (another change in progress). */
function readSource(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Where the files' counts and PENDING disagree: `found` lists what a file
 * shows, `allowed` what PENDING lets it. A file above its entry gained a
 * string; one below it (or an entry for a file that is gone) is an entry to
 * lower or drop, so nobody can add strings back up to a stale allowance.
 */
function ratchetProblems(shownByFile, pending) {
  const problems = {};
  for (const name of new Set([...Object.keys(shownByFile), ...Object.keys(pending)])) {
    const found = shownByFile[name] ?? [];
    const allowed = pending[name] ?? 0;
    if (found.length !== allowed) problems[name] = { allowed, found };
  }
  return problems;
}

describe('the frontend’s words', () => {
  it('never say Meta agent outside the files still being renamed, which list exactly what they still show', () => {
    const shownByFile = {};
    for (const path of sourceFiles(SRC)) {
      const name = relative(SRC, path).split(sep).join('/');
      const text = readSource(path);
      const shown = text === null ? [] : shownMetaAgent(text, path);
      if (shown.length > 0) shownByFile[name] = shown;
    }
    expect(ratchetProblems(shownByFile, PENDING)).toEqual({});
  }, 30_000); // It parses every source file: seconds on a busy machine.

  it('fails a file above its allowance, below it, or gone, so the list only shrinks', () => {
    const shown = { 'a.ts': ['3: Meta agent'], 'b.ts': ['1: Meta agent', '2: Meta agent'], 'new.ts': ['9: Meta agent'] };
    expect(ratchetProblems(shown, { 'a.ts': 1, 'b.ts': 1, 'stale.ts': 2, 'lower.ts': 1 })).toEqual({
      'b.ts': { allowed: 1, found: ['1: Meta agent', '2: Meta agent'] },
      'new.ts': { allowed: 0, found: ['9: Meta agent'] },
      'stale.ts': { allowed: 2, found: [] },
      'lower.ts': { allowed: 1, found: [] },
    });
  });

  it('counts shown strings, template text and JSX text, not comments, ids or search keywords', () => {
    const probe = [
      '// A comment about the Meta agent.',
      "const id = 'meta-agent';",
      "const SEARCH_WORDS = ['meta agent', 'pages upkeep'] as const;",
      "const entry = { label: 'Pages upkeep', keywords: [...SEARCH_WORDS, 'meta agent runtime'] };",
      "const title = 'Meta agent · Maintain Pages';",
      'const line = `${name} replaced the Meta agent`;',
      'export const View = () => <p title="Open the Meta agent">The Meta agent wrote this.</p>;',
    ].join('\n');
    expect(shownMetaAgent(probe, 'probe.tsx').map((line) => line.split(': ')[0])).toEqual(['5', '6', '7', '7']);
  });
});
