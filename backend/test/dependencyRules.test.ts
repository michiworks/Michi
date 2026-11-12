import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

type Print = (line: string) => void;
interface DependencyRules {
  scan(repoRoot: string): string[];
  loadFixture(file?: string): string[];
  compare(current: string[], fixture: string[]): { added: string[]; stale: string[] };
  writeFixture(entries: string[], file?: string): void;
  main(argv: string[], io?: { repoRoot?: string; fixtureFile?: string; log?: Print; error?: Print }): number;
}

// The scanner is a CommonJS build script (backend/scripts), not part of src/.
const rules = require('../scripts/dependencyRules.cjs') as DependencyRules;

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MINI_REPO: Record<string, string> = {
  'backend/src/services/db.ts': 'export const getDb = () => 1;\n',
  'backend/src/services/dbRepository.ts': "import { getDb } from './db';\nexport const repo = getDb;\n",
  'backend/src/agents/chatHub.ts': "import { getDb } from '../services/db';\nexport const hub = getDb;\n",
  'backend/src/agents/runs/worker.ts': [
    "import { hub } from '../chatHub';",
    "import type { getDb } from '../../services/db.js';",
    "import { repo } from '../../services/dbRepository';",
    'export const w = [hub, repo];',
  ].join('\n'),
  'backend/src/agents/worker.test.ts': "import { hub } from './chatHub';\nexport const t = hub;\n",
  'backend/src/routes/pages.ts': [
    "import { repo } from '../services/dbRepository';",
    "const lazy = require('../services/db');",
    'export const r = [repo, lazy];',
  ].join('\n'),
  'backend/src/routes/middleware/owner.ts': "export { getDb } from '../../services/db';\n",
  'backend/src/services/other.ts': "import { hub } from '../agents/chatHub';\nimport { getDb } from './db';\nexport const o = [hub, getDb];\n",
  'frontend/src/components/mentions.ts': 'export const m = 1;\n',
  'frontend/src/components/terminal/Pane/index.tsx': 'export const Pane = 1;\n',
  'frontend/src/state/store.tsx': [
    "import { m } from '../components/mentions';",
    "import { Pane } from '../components/terminal/Pane';",
    "import { x } from './local';",
    'export const s = [m, Pane, x];',
  ].join('\n'),
  'frontend/src/state/local.ts': 'export const x = 1;\n',
  'frontend/src/state/store.test.tsx': "import { m } from '../components/mentions';\nexport const t = m;\n",
  'frontend/src/lib/helper.ts': "import { m } from '../components/mentions';\nexport const h = m;\n",
};

describe('layer dependency scanner', () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-dependency-rules-'));
    for (const [relative, content] of Object.entries(MINI_REPO)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('records agents -> db/chatHub, routes -> db and state -> components edges only', () => {
    assert.deepEqual(rules.scan(root), [
      'agents-to-chatHub\tbackend/src/agents/runs/worker.ts\tbackend/src/agents/chatHub.ts',
      'agents-to-db\tbackend/src/agents/chatHub.ts\tbackend/src/services/db.ts',
      'agents-to-db\tbackend/src/agents/runs/worker.ts\tbackend/src/services/db.ts',
      'routes-to-db\tbackend/src/routes/middleware/owner.ts\tbackend/src/services/db.ts',
      'routes-to-db\tbackend/src/routes/pages.ts\tbackend/src/services/db.ts',
      'state-to-components\tfrontend/src/state/store.tsx\tfrontend/src/components/mentions.ts',
      'state-to-components\tfrontend/src/state/store.tsx\tfrontend/src/components/terminal/Pane/index.tsx',
    ]);
  });

  test('compare reports added and stale entries separately', () => {
    const { added, stale } = rules.compare(['a\tx\ty', 'b\tx\ty'], ['b\tx\ty', 'c\tx\ty']);
    assert.deepEqual(added, ['a\tx\ty']);
    assert.deepEqual(stale, ['c\tx\ty']);
  });

  test('loadFixture rejects malformed lines and unknown rules', () => {
    const file = path.join(root, 'edges.txt');
    fs.writeFileSync(file, '# comment\n\nroutes-to-db\tbackend/src/routes/a.ts\tbackend/src/services/db.ts\n');
    assert.deepEqual(rules.loadFixture(file), ['routes-to-db\tbackend/src/routes/a.ts\tbackend/src/services/db.ts']);
    fs.writeFileSync(file, 'routes-to-everything\ta\tb\n');
    assert.throws(() => rules.loadFixture(file), /edges\.txt:1/);
  });
});

describe('layer dependency CLI', () => {
  const PAGES = 'routes-to-db\tbackend/src/routes/pages.ts\tbackend/src/services/db.ts';
  const SEARCH = 'routes-to-db\tbackend/src/routes/search.ts\tbackend/src/services/db.ts';
  const GONE = 'routes-to-db\tbackend/src/routes/gone.ts\tbackend/src/services/db.ts';
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-dependency-cli-'));
    for (const [relative, content] of Object.entries({
      'backend/src/services/db.ts': 'export const getDb = () => 1;\n',
      'backend/src/routes/pages.ts': "import { getDb } from '../services/db';\nexport const p = getDb;\n",
      'backend/src/routes/search.ts': "import { getDb } from '../services/db';\nexport const s = getDb;\n",
    })) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function cli(argv: string[], entries: string[]) {
    const file = path.join(root, 'edges.txt');
    rules.writeFixture(entries, file);
    const before = fs.readFileSync(file, 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    const code = rules.main(argv, { repoRoot: root, fixtureFile: file, log: (line) => out.push(line), error: (line) => err.push(line) });
    return { code, before, after: fs.readFileSync(file, 'utf8'), entries: rules.loadFixture(file), stdout: out.join('\n'), stderr: err.join('\n') };
  }

  test('--prune on an unchanged tree leaves the baseline byte-identical', () => {
    const result = cli(['--prune'], [PAGES, SEARCH]);
    assert.equal(result.code, 0);
    assert.equal(result.after, result.before);
  });

  test('a stale baseline edge fails the check and names the prune command', () => {
    const result = cli([], [GONE, PAGES, SEARCH]);
    assert.equal(result.code, 1);
    assert.equal(result.after, result.before, 'the check never writes');
    assert.match(result.stderr, /Stale baseline edges[^\n]*\nroutes-to-db\tbackend\/src\/routes\/gone\.ts/);
    assert.match(result.stderr, /`node backend\/scripts\/dependencyRules\.cjs --prune`/);
  });

  test('--prune drops stale edges, never adds new ones, and still fails on the new ones', () => {
    const result = cli(['--prune'], [GONE, PAGES]);
    assert.deepEqual(result.entries, [PAGES]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /New layer dependency edges:\nroutes-to-db\tbackend\/src\/routes\/search\.ts/);
  });

  test('--write is a deprecated alias of --prune', () => {
    const pruned = cli(['--prune'], [GONE, PAGES]);
    const written = cli(['--write'], [GONE, PAGES]);
    assert.equal(written.after, pruned.after);
    assert.equal(written.code, pruned.code);
    assert.match(written.stderr, /--write is deprecated and now means --prune/);
  });

  test('--accept-new without a non-empty reason is refused', () => {
    for (const argv of [['--accept-new'], ['--accept-new', ' ']]) {
      const result = cli(argv, [PAGES]);
      assert.equal(result.code, 2);
      assert.equal(result.after, result.before);
      assert.match(result.stderr, /--accept-new needs a non-empty reason/);
    }
  });

  test('--accept-new adds the new edges and prints the reason for the commit body', () => {
    const result = cli(['--accept-new', 'search moves to a repository next'], [PAGES]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.entries, [PAGES, SEARCH]);
    assert.match(result.stdout, /Reason: search moves to a repository next\n {4}routes-to-db\tbackend\/src\/routes\/search\.ts/);
  });
});

describe('layer dependency ratchet', () => {
  let comparison: { added: string[]; stale: string[] };

  before(() => {
    comparison = rules.compare(rules.scan(REPO_ROOT), rules.loadFixture());
  });

  test('no new layer dependency edges', () => {
    assert.deepEqual(comparison.added, [], 'see backend/scripts/dependencyRules.cjs for each rule and how to resolve it');
  });

  test('no stale baseline edges', () => {
    assert.deepEqual(comparison.stale, [], 'the baseline only shrinks: run `node backend/scripts/dependencyRules.cjs --prune`');
  });
});
