import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueKeys, main } from './knip-baseline.mjs';

test('knip issues are keyed by type, file and name, not by position', () => {
  const report = {
    files: ['frontend/src/b.ts', 'frontend/src/a.ts'],
    issues: [
      {
        file: 'backend/src/x.ts',
        exports: [{ name: 'unused', line: 3, col: 1, pos: 10 }],
        types: [],
        duplicates: [[{ name: 'A', line: 1 }, { name: 'default', line: 9 }]],
        enumMembers: { Color: [{ name: 'Red', line: 4 }] },
      },
      { file: 'package.json', dependencies: [{ name: 'left-pad', line: 20 }], unlisted: [] },
    ],
  };
  const moved = structuredClone(report);
  moved.issues[0].exports[0].line = 300;
  assert.deepEqual(issueKeys(report), [
    'dependencies\tpackage.json\tleft-pad',
    'duplicates\tbackend/src/x.ts\tA|default',
    'enumMembers\tbackend/src/x.ts\tColor.Red',
    'exports\tbackend/src/x.ts\tunused',
    'files\tfrontend/src/a.ts',
    'files\tfrontend/src/b.ts',
  ]);
  assert.deepEqual(issueKeys(moved), issueKeys(report));
});

// Fake knip results: what each pass reports on the "current tree".
const CURRENT = {
  production: ['exports\ta.ts\tkept', 'exports\ta.ts\tnew'],
  default: ['files\tscripts/kept.mjs'],
};

/** Runs main() against a temporary baseline; never runs knip. */
function ratchet(argv, baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'michi-knip-baseline-'));
  const file = join(dir, 'knip-baseline.json');
  const before = `${JSON.stringify(baseline, null, 2)}\n`;
  writeFileSync(file, before);
  const out = [];
  const err = [];
  let knipRuns = 0;
  try {
    const code = main(argv, {
      runPass: (pass) => { knipRuns += 1; return CURRENT[pass]; },
      baselinePath: file,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { code, before, after: readFileSync(file, 'utf8'), stdout: out.join('\n'), stderr: err.join('\n'), knipRuns };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MATCHING = { production: ['exports\ta.ts\tkept', 'exports\ta.ts\tnew'], default: ['files\tscripts/kept.mjs'] };
const WITH_STALE = {
  production: ['exports\ta.ts\tgone', 'exports\ta.ts\tkept'],
  default: ['files\tscripts/gone.mjs', 'files\tscripts/kept.mjs'],
};
const PRUNED = { production: ['exports\ta.ts\tkept'], default: ['files\tscripts/kept.mjs'] };

test('--prune on an unchanged tree leaves the baseline byte-identical', () => {
  const result = ratchet(['--prune'], MATCHING);
  assert.equal(result.code, 0);
  assert.equal(result.after, result.before);
});

test('a baseline entry knip no longer reports fails the check and names the prune command', () => {
  const result = ratchet([], { ...MATCHING, default: ['files\tscripts/gone.mjs', 'files\tscripts/kept.mjs'] });
  assert.equal(result.code, 1);
  assert.equal(result.after, result.before, 'the check never writes');
  assert.match(result.stderr, /Stale baseline entries[^\n]*\n {4}files\tscripts\/gone\.mjs/);
  assert.match(result.stderr, /`node scripts\/knip-baseline\.mjs --prune`/);
});

test('--prune drops stale entries, never adds new ones, and still fails on the new ones', () => {
  const result = ratchet(['--prune'], WITH_STALE);
  assert.deepEqual(JSON.parse(result.after), PRUNED);
  assert.equal(result.code, 1, 'exports a.ts new is still new');
  assert.match(result.stderr, /New knip issues[^\n]*\n {4}exports\ta\.ts\tnew/);
});

test('--write is a deprecated alias of --prune', () => {
  const pruned = ratchet(['--prune'], WITH_STALE);
  const written = ratchet(['--write'], WITH_STALE);
  assert.equal(written.after, pruned.after);
  assert.equal(written.code, pruned.code);
  assert.match(written.stderr, /--write is deprecated and now means --prune/);
  assert.match(written.stderr, /Usage: node scripts\/knip-baseline\.mjs \[--prune\] \[--accept-new "<reason>"\]/);
});

test('--accept-new without a non-empty reason is refused before knip runs', () => {
  for (const argv of [['--accept-new'], ['--accept-new', ''], ['--accept-new', '   '], ['--accept-new='], ['--accept-new', '--prune']]) {
    const result = ratchet(argv, PRUNED);
    assert.equal(result.code, 2, argv.join(' '));
    assert.equal(result.after, result.before);
    assert.equal(result.knipRuns, 0);
    assert.match(result.stderr, /--accept-new needs a non-empty reason/);
  }
});

test('--accept-new adds the new issues and prints the reason for the commit body', () => {
  const result = ratchet(['--accept-new', 'kept until the editor migration lands'], PRUNED);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.after), MATCHING);
  assert.match(result.stdout, /Reason: kept until the editor migration lands\n {4}exports\ta\.ts\tnew/);
});
