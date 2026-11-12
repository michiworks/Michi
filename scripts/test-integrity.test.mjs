import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { formatReport, testIntegrity } from './test-integrity.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'test-integrity.mjs');
const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';

function git(cwd, ...args) {
  return execFileSync(GIT, ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const lines = (...rows) => `${rows.join('\n')}\n`;

const VITEST = lines(
  "import { describe, expect, it } from 'vitest';",
  "describe('sum', () => {",
  "  it('adds', async () => {",
  "    await waitFor(() => expect(1).toBe(1), { timeout: 1_000 });",
  "  }, 5_000);",
  "  it.skip('is pending', () => {});",
  "  it('waits', () => new Promise((done) => {",
  "    setTimeout(() => {",
  "      done();",
  "    }, 20);",
  "  }));",
  "});",
);
const SPEC = lines(
  "import { expect, test } from '@playwright/test';",
  "test('opens', async ({ page }) => {",
  "  await expect(page.getByText('Home')).toBeVisible();",
  "});",
);
// node:test options across lines, as in backend/test/crewGatewayCapabilities.live.test.ts.
const LIVE = lines(
  "import test from 'node:test';",
  "const enabled = process.env.LIVE === '1';",
  "test('live: one', {",
  '  timeout: 600_000,',
  '}, async () => {',
  '  await run();',
  '});',
  "test('live: two', {",
  '  skip: !enabled,',
  '}, async () => {});',
);
const BASE = {
  'frontend/src/sum.test.ts': VITEST,
  'backend/test/live.test.ts': LIVE,
  'e2e/specs/home.spec.ts': SPEC,
  'e2e/playwright.config.ts': lines('export default {', '  forbidOnly: true,', '  retries: process.env.CI ? 1 : 0,', '  timeout: 60_000,', '};'),
  'frontend/vitest.config.mts': lines('const commonTest = { globals: true, allowOnly: false };', 'export default { test: commonTest };'),
  'backend/package.json': `${JSON.stringify({ scripts: {
    test: 'node --test --test-timeout=30000 test/*.test.ts', 'test:file': 'node --test --test-timeout=30000',
  } }, null, 2)}\n`,
  'scripts/knip-baseline.json': `${JSON.stringify({ production: ['exports\tsrc/a.ts\tfoo'], default: ['exports\tsrc/a.ts\tfoo'] }, null, 2)}\n`,
  'backend/test/fixtures/dependencyRules/edges.txt': lines('# rule from to', 'routes-to-db\tbackend/src/routes/a.ts\tbackend/src/services/db.ts'),
  'backend/test/fixtures/runtimeBoundary/runtime-ids.txt': lines('# file id count', 'backend/src/a.ts\tclaude\t2'),
  'docs/validation/known-failures.json': `${JSON.stringify([{ id: 'e2e-a', file: 'e2e/specs/a.spec.ts:1' }])}\n`,
  'backend/test/fixtures/claudeAdapterGolden/turn.json': '{"events":[]}\n',
  'src/app.ts': 'export const x = 1;\n',
};

// A repo on branch dev whose first commit holds BASE plus `extra`.
function repo(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'michi-test-integrity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'dev');
  const commit = (changes, message = 'change') => {
    for (const [path, content] of Object.entries(changes)) {
      const full = join(root, path);
      if (content === null) {
        rmSync(full);
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--allow-empty', '-m', message);
    return git(root, 'rev-parse', 'HEAD');
  };
  return { root, base: commit({ ...BASE, ...extra }, 'base'), commit };
}

const check = (r, base = r.base) => testIntegrity({ root: r.root, base });
const found = (report) => report.violations.map((v) => `${v.rule} ${v.file} ${v.message}`).sort();

test('ordinary test edits, moves, renames and lowered timeouts pass and changed test files are listed', (t) => {
  const r = repo(t);
  const [head, adds, skipped, waits] = [VITEST.split('\n').slice(0, 2), VITEST.split('\n').slice(2, 5),
    VITEST.split('\n').slice(5, 6), VITEST.split('\n').slice(6, 11)];
  r.commit({
    // The two tests swap places and the skipped one is retitled: same timeouts, same number of skips.
    'frontend/src/sum.test.ts': lines(...head, ...waits, ...skipped.map((l) => l.replace('is pending', 'is still pending')),
      ...adds.map((l) => l.replace('expect(1).toBe(1)', 'expect(2).toBe(2)')), '});'),
    'frontend/src/new.test.ts': lines("it('runs long', async () => {", '  await work();', '}, 20_000);'),
    'e2e/specs/home.spec.ts': null,
    'e2e/specs/start.spec.ts': SPEC.replace("getByText('Home')", "getByText('Start')"),
    'e2e/playwright.config.ts': BASE['e2e/playwright.config.ts'].replace('60_000', '30_000'),
    'src/app.ts': 'export const x = 2;\n',
    'frontend/vitest.config.mts': BASE['frontend/vitest.config.mts'].replace('globals: true, allowOnly: false', 'allowOnly: false, globals: true'),
    // The two live tests swap places and the first lowers its timeout.
    'backend/test/live.test.ts': lines(...LIVE.split('\n').slice(0, 2), ...LIVE.split('\n').slice(7, 10),
      ...LIVE.split('\n').slice(2, 7).map((l) => l.replace('600_000', '300_000'))),
  });
  const report = check(r);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.testFiles.map(({ status, file, from, added, deleted }) => [status, file, from, added, deleted]), [
    ['M', 'backend/test/live.test.ts', undefined, 4, 4],
    ['M', 'e2e/playwright.config.ts', undefined, 1, 1],
    ['R', 'e2e/specs/start.spec.ts', 'e2e/specs/home.spec.ts', 1, 1],
    ['A', 'frontend/src/new.test.ts', undefined, 3, 0],
    ['M', 'frontend/src/sum.test.ts', undefined, 4, 4],
    ['M', 'frontend/vitest.config.mts', undefined, 1, 1],
  ]);
  assert.match(formatReport(report), /violations: none\n[^]*R +\+1 +-1 {2}e2e\/specs\/home\.spec\.ts -> e2e\/specs\/start\.spec\.ts/);
});

test('flags each vitest, node:test and Playwright form of .only, .skip, .todo and fixme', (t) => {
  const r = repo(t);
  r.commit({
    'e2e/specs/new.spec.ts': lines(
      "test.describe.skip('a', () => {});",
      "test.describe.serial.only('b', () => {});",
      "test.fixme('c', async () => {});",
      "test('d', async () => { test.skip(isBroken, 'no'); });",
      "test('e', async ({}, testInfo) => { testInfo.fixme(); });",
      "test('f', () => { expect('test.only(').toBe(1); }); // test.skip in a comment",
    ),
    'backend/test/new.test.ts': lines(
      "test('g', { skip: 'later' }, () => {});",
      "test('h', { only: true }, () => {});",
      "test('i', (t) => { t.todo(); });",
      "test('j', { skip: false }, () => {});",
      "const LIVE = { skip: !ready };",
      "post({ requestId: 1, skip: true });",
      "describe.only('k', () => {});",
      'const GATED = {',
      '  skip: !ready,',
      '};',
      'post({',
      '  requestId: 1,',
      '  skip: true,',
      '});',
      'const source = `',
      "it.only('inside a template literal', () => {});",
      '`;',
      '/*',
      "it.skip('inside a block comment', () => {});",
      '*/',
      'if (/a/.test(name)) post({ skip: true });',
    ),
    'backend/test/live.test.ts': LIVE.replace('  timeout: 600_000,', '  skip: true,\n  timeout: 600_000,'),
    'frontend/src/sum.test.ts': VITEST.replace('is pending', 'is still pending')
      .replace('});\n', "});\n  it.todo('later');\n  describe.skipIf(!ready)('live', () => {});\n"),
    'frontend/vitest.config.mts': BASE['frontend/vitest.config.mts'].replace(', allowOnly: false', ''),
    'e2e/playwright.config.ts': BASE['e2e/playwright.config.ts'].replace('forbidOnly: true', 'forbidOnly: !!process.env.CI'),
  });
  assert.deepEqual(found(check(r)), [
    'skip backend/test/live.test.ts adds .skip',
    'skip backend/test/new.test.ts adds .only',
    'skip backend/test/new.test.ts adds .only',
    'skip backend/test/new.test.ts adds .skip',
    'skip backend/test/new.test.ts adds .skip',
    'skip backend/test/new.test.ts adds .skip',
    'skip backend/test/new.test.ts adds .todo',
    'skip e2e/playwright.config.ts changes forbidOnly: true to !!process.env.CI, so .only no longer fails the run',
    'skip e2e/specs/new.spec.ts adds .fixme',
    'skip e2e/specs/new.spec.ts adds .fixme',
    'skip e2e/specs/new.spec.ts adds .only',
    'skip e2e/specs/new.spec.ts adds .skip',
    'skip e2e/specs/new.spec.ts adds .skip',
    'skip frontend/src/sum.test.ts adds .skip',
    'skip frontend/src/sum.test.ts adds .todo',
    'skip frontend/vitest.config.mts drops allowOnly: false, so .only no longer fails the run',
  ]);
});

test('lets a new test skip on the platform or the environment, directly or through a binding, not an existing one', (t) => {
  const EXISTING = lines(
    "import { spawnSync } from 'node:child_process';",
    'function runCli(args) {',
    "  return spawnSync('node', args, { env: { PATH: process.env.PATH } });",
    '}',
    "test('broken', { skip: 'flaky' }, () => {});",
    "test('cli', () => {",
    "  const result = runCli(['--version']);",
    '  assert.equal(result.status, 0);',
    '});',
    "test('works', () => {",
    '  assert.ok(true);',
    '});',
    "test('steady', () => {",
    '  assert.ok(true);',
    '});',
    "test('stays', () => {});",
  );
  const r = repo(t, { 'backend/test/existing.test.ts': EXISTING });
  // A whole new test in an existing file, as at bashCloudEnv.test.ts:71, and a skip narrowed to one platform.
  const existing = `${EXISTING.replace("{ skip: 'flaky' }", "{ skip: process.platform === 'win32' }")}${lines('',
    "test('posix shell', { skip: process.platform === 'win32' }, async (t) => {", '  assert.ok(true);', '});')}`;
  // A new test may also be declared in a loop, as in pane-performance.spec.ts.
  const home = `${SPEC}${lines('for (const panes of [1, 4]) test(`opt-in ${panes}`, async () => {',
    "  test.skip(process.env.HOME_E2E !== '1', 'opt-in');", '});')}`;
  r.commit({
    'backend/test/existing.test.ts': existing,
    'e2e/specs/home.spec.ts': home,
    'backend/test/gated.test.ts': lines(
      "import os from 'node:os';",
      "const POSIX = process.platform !== 'win32';",
      "const enabled = (process.env.MICHI_KIRO_LIVE ?? '')",
      "  .split(',');",
      'function posix() {',
      "  return os.platform() !== 'win32';",
      '}',
      "test('a', { skip: process.platform === 'win32' }, async (t) => {});", // bashCloudEnv.test.ts:71
      "test('b', { skip: !POSIX }, () => {});",
      "describe('c', { skip: !enabled.includes('v2'), timeout: 300_000 }, () => {});",
      "test('d', { skip: !posix() }, () => {});",
      "const LIVE = { skip: process.env.MICHI_CLAUDE_SDK_SMOKE !== '1', timeout: 420_000 };",
      "test('e', (t) => {",
      "  if (process.arch !== 'x64') {",
      "    t.skip('x64 only');",
      '    return;',
      '  }',
      '});',
      "test('f', (t) => { if (!process.env.LIVE) return t.skip('opt-in'); });",
      "test('g', (t) => { if (process.platform === 'win32') t.skip(WHY); });",
    ),
    // crewGatewayCapabilities.live.test.ts: the gate is in a binding and the options span lines.
    'backend/test/crew.live.test.ts': lines(
      "const enabled = process.env.MICHI_CREW_LIVE === '1';",
      "test('real Crew Gateway: subagent roster through the Michi Crew runtime', {",
      '    skip: !enabled, timeout: 600_000,',
      '}, async (t) => {});',
    ),
    'e2e/specs/perf.spec.ts': lines(
      "test.skip(process.env.MICHI_PANE_PERF !== '1', 'Set MICHI_PANE_PERF=1 to run the pane performance suite.');",
      "const LONG = process.env.MICHI_LONG_PERF === '1';",
      "test('short', async () => { test.skip(LONG); });",
    ),
    'frontend/src/gated.test.ts': lines(
      "describe.skipIf(process.platform === 'win32')('posix', () => {});",
      "it.runIf(import.meta.env.VITE_LIVE)('live', () => {});",
    ),
  });
  assert.deepEqual(found(check(r)), []);

  // Unconditional skips and other conditions still count, also where a gated skip was before. A gated skip
  // counts on an existing test (plan §3.3: a new red is fixed, not skipped) and as a file-wide test.skip(c).
  r.commit({
    'backend/test/live.test.ts': LIVE.replace('  skip: !enabled,', '  skip: true,'),
    'backend/test/ungated.test.ts': lines(
      'const flaky = true;',
      "test('g', { skip: flaky }, () => {});",
      "test('h', (t) => { if (flaky) t.skip(); });",
      "test('i', (t) => { t.skip('later'); });",
      "if (process.platform === 'win32') test.skip('placeholder', () => {});",
      "test.fixme(process.platform === 'darwin', 'broken on macOS');",
      "test('j', (t) => { if (process.platform === 'win32') return; t.skip('broken'); });",
    ),
    'backend/test/existing.test.ts': existing
      .replace("test('cli', () => {", "test('cli', (t) => {")
      .replace('  assert.equal(result.status, 0);', "  if (result.status !== 0) { t.skip('cli failed'); return; }\n  assert.equal(result.status, 0);")
      .replace("test('works', () => {", "test('works', { skip: !process.env.RUN_WORKS }, () => {")
      .replace("test('steady', () => {", "const isCI = Boolean(process.env.CI);\ntest('steady', { skip: isCI }, () => {"),
    'frontend/src/sum.test.ts': VITEST.replace("it('adds', async", "it('adds', { skip: process.platform === 'linux' }, async"),
    'e2e/specs/home.spec.ts': home.replace('\n', "\ntest.skip(process.env.HOME_E2E !== '1', 'opt-in');\n"),
  });
  const report = check(r);
  const gated = 'adds a platform/env-gated .skip to an existing test';
  assert.deepEqual(found(report), [
    `skip backend/test/existing.test.ts ${gated}`,
    `skip backend/test/existing.test.ts ${gated}`,
    `skip backend/test/existing.test.ts ${gated}`,
    'skip backend/test/live.test.ts adds .skip',
    'skip backend/test/ungated.test.ts adds .fixme',
    'skip backend/test/ungated.test.ts adds .skip',
    'skip backend/test/ungated.test.ts adds .skip',
    'skip backend/test/ungated.test.ts adds .skip',
    'skip backend/test/ungated.test.ts adds .skip',
    'skip backend/test/ungated.test.ts adds .skip',
    `skip e2e/specs/home.spec.ts ${gated}`,
    `skip frontend/src/sum.test.ts ${gated}`,
  ]);
  assert.deepEqual(report.violations.filter((v) => v.message === gated).map((v) => `${v.file}:${v.line}`).sort(), [
    'backend/test/existing.test.ts:11',
    'backend/test/existing.test.ts:15',
    'backend/test/existing.test.ts:8',
    'e2e/specs/home.spec.ts:2',
    'frontend/src/sum.test.ts:3',
  ]);
});

test('flags raised timeouts in existing files, not lowered ones, timer delays or new files', (t) => {
  const r = repo(t);
  r.commit({
    // A runner-wide timeout raises even next to a new test; the new test's own limit does not.
    'frontend/src/sum.test.ts': `${VITEST.replace('}, 5_000);', '}, 30_000);').replace('{ timeout: 1_000 }', '{ timeout: 500 }')
      .replace('}, 20);', '}, 2_000);')}vi.setConfig({ testTimeout: 60_000 });\nit('new and slow', async () => {\n  await work();\n}, 45_000);\n`,
    // A new test above the existing one may set its own limits; the existing test may not.
    'e2e/specs/home.spec.ts': lines(SPEC.split('\n')[0], "test('new', async ({ page }) => {", '  test.slow();',
      '  test.setTimeout(90_000);', "  await expect(page.getByText('New')).toBeVisible({ timeout: 10_000 });", '});',
      'for (const panes of [1, 4]) test(`new ${panes} panes`, async () => {', '  test.setTimeout(180_000);', '});',
      SPEC.split('\n')[1], '  test.slow();',
      ...SPEC.trimEnd().split('\n').slice(2).map((l) => l.replace('toBeVisible()', 'toBeVisible({ timeout: 30_000 })'))),
    'backend/test/live.test.ts': `${LIVE.replace('  skip: !enabled,', '  skip: !enabled,\n  timeout: 900_000,')}${lines(
      "test('live: three', {", '  timeout: 600_000,', '}, async () => {});')}`,
    'e2e/playwright.config.ts': BASE['e2e/playwright.config.ts'].replace('60_000', '0'),
    'backend/package.json': BASE['backend/package.json'].replace('--test-timeout=30000', '--test-timeout=60000')
      .replace('node --test --test-timeout=30000"', 'node --test"'),
    'e2e/specs/slow.spec.ts': lines('test.setTimeout(120_000);', "test('slow', async () => {});"),
  });
  assert.deepEqual(found(check(r)), [
    'timeout backend/package.json raises a timeout from 30000 to 60000',
    'timeout backend/package.json removes --test-timeout (no limit)',
    'timeout backend/test/live.test.ts adds a timeout of 900000',
    'timeout e2e/playwright.config.ts raises a timeout from 60000 to no limit',
    'timeout e2e/specs/home.spec.ts adds a timeout of 30000',
    'timeout e2e/specs/home.spec.ts adds test.slow()',
    'timeout frontend/src/sum.test.ts adds a timeout of 60000',
    'timeout frontend/src/sum.test.ts raises a timeout from 5000 to 30000',
  ]);
});

test('flags newly added retries but not retry callbacks or retry counts passed to code', (t) => {
  const r = repo(t);
  r.commit({
    'e2e/playwright.config.ts': BASE['e2e/playwright.config.ts'].replace('process.env.CI ? 1 : 0', '2'),
    'e2e/specs/flaky.spec.ts': lines('test.describe.configure({ retries: 2 });', "test('flaky', async () => {});"),
    'frontend/src/sum.test.ts': `${VITEST}vi.mock('./x', () => ({ useX: () => ({ retry: vi.fn() }) }));\nconst client = createClient({ retries: 3 });\n`,
  });
  assert.deepEqual(found(check(r)), [
    'retry e2e/playwright.config.ts raises retries from 1 to 2',
    'retry e2e/specs/flaky.spec.ts adds retries: 2',
  ]);
});

test('flags changed or deleted goldens and snapshots, not new ones, until a commit approves them with a reason', (t) => {
  const r = repo(t, {
    'frontend/src/__snapshots__/sum.test.ts.snap': 'exports[`a`] = `1`;\n',
    'runtime/test/fixtures/acp/turn.json': '{}\n',
    'backend/test/fixtures/dataDbSchema.golden.txt': 'CREATE TABLE a (id);\n',
    'backend/test/fixtures/permissionMatrix.json': '{"chat.read":"deny"}\n',
  });
  r.commit({
    'backend/test/fixtures/claudeAdapterGolden/turn.json': '{"events":[1]}\n',
    'frontend/src/__snapshots__/sum.test.ts.snap': 'exports[`a`] = `2`;\n',
    'runtime/test/fixtures/acp/turn.json': null,
    'backend/test/fixtures/dataDbSchema.golden.txt': 'CREATE TABLE a (id, b);\n',
    'backend/test/fixtures/permissionMatrix.json': '{"chat.read":"allow"}\n',
    // New goldens pin new behaviour, like the schema snapshot P1.2 added; they need no approval.
    'backend/test/fixtures/mcpToolCatalog.golden.json': '{"tools":[]}\n',
    'frontend/src/__snapshots__/new.test.ts.snap': 'exports[`b`] = `1`;\n',
  }, 'chore: Update fixtures');
  const golden = [
    'golden backend/test/fixtures/claudeAdapterGolden/turn.json changed without a commit line "Golden-Change: approved <reason>"',
    'golden backend/test/fixtures/dataDbSchema.golden.txt changed without a commit line "Golden-Change: approved <reason>"',
    'golden backend/test/fixtures/permissionMatrix.json changed without a commit line "Golden-Change: approved <reason>"',
    'golden frontend/src/__snapshots__/sum.test.ts.snap changed without a commit line "Golden-Change: approved <reason>"',
    'golden runtime/test/fixtures/acp/turn.json deleted without a commit line "Golden-Change: approved <reason>"',
  ];
  assert.deepEqual(found(check(r)), golden);
  r.commit({}, 'chore: Note\n\nGolden-Change: approved');
  assert.deepEqual(found(check(r)), golden, 'an approval needs a reason');
  r.commit({}, 'chore: Approve\n\nGolden-Change: approved the SDK renamed the init event');
  const report = check(r);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.goldenApprovals.map((a) => a.reason), ['the SDK renamed the init event']);
  assert.equal(report.golden.length, 5);
});

test('flags every new baseline entry and known failure, even in a swap, but not shrinking, moves or comments', (t) => {
  const route = 'backend/src/routes/a.ts';
  const r = repo(t, { [route]: 'export const route = 1;\n' });
  const edges = BASE['backend/test/fixtures/dependencyRules/edges.txt'];
  const moved = edges.replace(route, 'backend/src/routes/c.ts');
  // One knip key fixed and another accepted: the count holds, the new key is still reported.
  const swapped = r.commit({
    'scripts/knip-baseline.json': `${JSON.stringify({ production: ['exports\tsrc/b.ts\tbar'], default: [] }, null, 2)}\n`,
    [route]: null,
    'backend/src/routes/c.ts': 'export const route = 1;\n',
    'backend/test/fixtures/dependencyRules/edges.txt': `# another comment\n${moved}`,
  });
  const swap = check(r, r.base);
  assert.deepEqual(swap.violations.map((v) => [v.file, v.message, v.text]), [
    ['scripts/knip-baseline.json', '[production] adds an entry', 'exports\tsrc/b.ts\tbar'],
  ]);
  assert.deepEqual(swap.baselines.map(({ file, section, before, after, added }) => [file, section, before, after, added]), [
    ['scripts/knip-baseline.json', 'production', 1, 1, ['exports\tsrc/b.ts\tbar']],
    ['scripts/knip-baseline.json', 'default', 1, 0, []],
  ]);
  assert.match(formatReport(swap), /baseline scripts\/knip-baseline\.json {2}\[production\] adds an entry: exports src\/b\.ts bar/);
  r.commit({
    'scripts/knip-baseline.json': `${JSON.stringify({ production: ['exports\tsrc/b.ts\tbar', 'exports\tsrc/c.ts\tbaz'], default: [] }, null, 2)}\n`,
    'backend/test/fixtures/dependencyRules/edges.txt': `${moved}routes-to-db\tbackend/src/routes/b.ts\tbackend/src/services/db.ts\n`,
    'backend/test/fixtures/runtimeBoundary/runtime-ids.txt': BASE['backend/test/fixtures/runtimeBoundary/runtime-ids.txt'].replace('\t2', '\t3'),
    'docs/validation/known-failures.json': `${JSON.stringify([{ id: 'e2e-a' }, { id: 'e2e-b' }])}\n`,
  });
  assert.deepEqual(found(check(r, swapped)), [
    'baseline backend/test/fixtures/dependencyRules/edges.txt adds an entry',
    "baseline backend/test/fixtures/runtimeBoundary/runtime-ids.txt raises an entry's count from 2 to 3",
    'baseline docs/validation/known-failures.json adds known failure e2e-b',
    'baseline scripts/knip-baseline.json [production] adds an entry',
  ]);
});

test('compares with the merge base, so newer commits on the base branch do not count', (t) => {
  const r = repo(t);
  git(r.root, 'checkout', '-q', '-b', 'feature');
  r.commit({ 'src/app.ts': 'export const x = 3;\n' });
  git(r.root, 'checkout', '-q', 'dev');
  r.commit({ 'frontend/src/sum.test.ts': VITEST.replace("  it.skip('is pending', () => {});\n", '') });
  git(r.root, 'checkout', '-q', 'feature');
  const report = testIntegrity({ root: r.root, base: 'dev' });
  assert.equal(report.mergeBase, r.base);
  assert.deepEqual(report.violations, []);
});

test('exits 0 in report mode, 1 with --strict on a violation and 2 on usage or ref errors', (t) => {
  const r = repo(t);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: r.root, encoding: 'utf8' });
  assert.equal(run('--strict', r.base).status, 0, 'an empty range passes strict mode');
  r.commit({ 'frontend/src/sum.test.ts': VITEST.replace("it('adds'", "it.only('adds'") });
  const report = run(r.base);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /violations: 1 \(report mode; --strict exits 1 on these\)\n {2}skip {5}frontend\/src\/sum\.test\.ts:3 {2}adds \.only/);
  assert.equal(run(r.base, '--strict').status, 1);
  assert.deepEqual(JSON.parse(run(r.base, 'HEAD', '--json').stdout).violations.map((v) => v.rule), ['skip']);
  assert.equal(run().status, 2);
  assert.equal(run(r.base, '--bogus').status, 2);
  const missing = run('no-such-ref');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /not a commit: no-such-ref/);
});
