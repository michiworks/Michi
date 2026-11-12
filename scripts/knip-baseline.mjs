#!/usr/bin/env node
// knip ratchet: the committed baseline of unused files, exports and dependencies only shrinks.
//
//   node scripts/knip-baseline.mjs                         check; exit 1 on issues missing from
//                                                          scripts/knip-baseline.json or entries knip no longer reports
//   node scripts/knip-baseline.mjs --prune                 drop baseline entries knip no longer reports; never adds
//   node scripts/knip-baseline.mjs --accept-new "<reason>" add the current new issues; put the reason in the commit body
//   node scripts/knip-baseline.mjs --write                 deprecated alias of --prune
//
// knip has no baseline mode of its own. Two passes run with the repository's knip.config.ts:
//   production  `knip --production`: files, exports and dependencies reachable only from production
//               entries (marked `!`), so code that only tests import counts as unused.
//   default     `knip --files --dependencies`: also covers root scripts/ and e2e/, which have no
//               production entries, for dead scripts and undeclared imports.
// Issues are keyed by type, file and name (not line), so moving code does not change the baseline.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATCHET_FLAGS, formatAccepted, parseRatchetArgs, pruneHint, writeDeprecation } from './lib/ratchet-args.cjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts/knip-baseline.json');
const knipBin = join(dirname(createRequire(import.meta.url).resolve('knip')), '..', 'bin', 'knip.js');
const common = ['--reporter', 'json', '--no-progress', '--no-config-hints', '--no-exit-code'];
const PASSES = {
  production: ['--production'],
  default: ['--files', '--dependencies'],
};
const COMMAND = 'node scripts/knip-baseline.mjs';

const byteCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const nameOf = (item) => (Array.isArray(item) ? item.map((entry) => entry.name).join('|') : item.name);

export function issueKeys(report) {
  const keys = (report.files ?? []).map((file) => `files\t${file}`);
  for (const issue of report.issues ?? []) {
    for (const [type, value] of Object.entries(issue)) {
      if (type === 'file' || type === 'owners' || type === 'files') continue;
      if (Array.isArray(value)) {
        for (const item of value) keys.push(`${type}\t${issue.file}\t${nameOf(item)}`);
      } else if (value && typeof value === 'object') {
        for (const [parent, members] of Object.entries(value)) {
          for (const item of members) keys.push(`${type}\t${issue.file}\t${parent}.${nameOf(item)}`);
        }
      }
    }
  }
  return [...new Set(keys)].sort(byteCompare);
}

function runKnip(pass) {
  const output = execFileSync(process.execPath, [knipBin, ...PASSES[pass], ...common], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return issueKeys(JSON.parse(output));
}

/** Per pass: issues missing from the baseline (`added`) and baseline entries knip no longer reports (`stale`). */
export function compareBaseline(baseline, current) {
  return Object.fromEntries(Object.keys(PASSES).map((pass) => {
    const allowed = new Set(baseline[pass] ?? []);
    const now = new Set(current[pass]);
    return [pass, {
      added: current[pass].filter((key) => !allowed.has(key)),
      stale: [...allowed].filter((key) => !now.has(key)),
    }];
  }));
}

/** The baseline without entries knip no longer reports. Never adds. */
export function pruneBaseline(baseline, current) {
  return Object.fromEntries(Object.keys(PASSES).map((pass) => {
    const now = new Set(current[pass]);
    return [pass, (baseline[pass] ?? []).filter((key) => now.has(key))];
  }));
}

/** The baseline plus the current new issues. */
export function acceptNewIssues(baseline, current) {
  return Object.fromEntries(Object.keys(PASSES).map((pass) => (
    [pass, [...new Set([...(baseline[pass] ?? []), ...current[pass]])].sort(byteCompare)]
  )));
}

/**
 * @param {string[]} argv
 * @param {{ runPass?: (pass: string) => string[], baselinePath?: string, log?: Function, error?: Function }} [io]
 *   Tests pass fake knip results and a temporary baseline.
 */
export function main(argv, io = {}) {
  const { runPass = runKnip, baselinePath: file = baselinePath, log = console.log, error = console.error } = io;
  const args = parseRatchetArgs(argv);
  if (args.error || args.rest.length) {
    error(`${args.error ?? `Unknown argument: ${args.rest[0]}`}\nUsage: ${COMMAND} ${RATCHET_FLAGS}`);
    return 2;
  }
  if (args.deprecatedWrite) error(writeDeprecation(COMMAND));

  const current = Object.fromEntries(Object.keys(PASSES).map((pass) => [pass, runPass(pass)]));
  const text = readFileSync(file, 'utf8');
  const baseline = JSON.parse(text);
  let next = baseline;
  if (args.prune) next = pruneBaseline(next, current);
  if (args.acceptNew) next = acceptNewIssues(next, current);
  const label = relative(root, file) || file;
  if (args.prune || args.acceptNew) {
    const before = compareBaseline(baseline, current);
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    if (nextText !== text) writeFileSync(file, nextText);
    if (args.prune) {
      const pruned = Object.values(before).reduce((total, { stale }) => total + stale.length, 0);
      log(`knip: pruned ${pruned} entr${pruned === 1 ? 'y' : 'ies'} knip no longer reports from ${label}`);
    }
    if (args.acceptNew) {
      log(formatAccepted(label, args.acceptNew, Object.values(before).flatMap(({ added }) => added)));
    }
  }

  const comparison = compareBaseline(next, current);
  for (const pass of Object.keys(PASSES)) {
    const { added, stale } = comparison[pass];
    log(`knip ${pass}: ${current[pass].length} issues, ${(next[pass] ?? []).length} in baseline, ${added.length} new, ${stale.length} stale`);
    if (stale.length) error(`  Stale baseline entries (knip no longer reports them):\n    ${stale.join('\n    ')}`);
    if (added.length) error(`  New knip issues (type, file, name):\n    ${added.join('\n    ')}`);
  }
  const anyStale = Object.values(comparison).some(({ stale }) => stale.length > 0);
  const anyAdded = Object.values(comparison).some(({ added }) => added.length > 0);
  if (anyStale) error(`\nThe baseline only shrinks. ${pruneHint(COMMAND)}`);
  if (anyAdded) error('\nDelete the unused code, use it, or declare the dependency. If knip is wrong, fix knip.config.ts rather than the baseline.');
  return anyStale || anyAdded ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
