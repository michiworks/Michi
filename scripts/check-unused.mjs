#!/usr/bin/env node
// Reports unused locals and imports: npm run check:unused (which builds shared first).
//
// Runs tsc on the check-only tsconfig.unused.json of shared, runtime, backend and electron
// (noUnusedLocals and noFallthroughCasesInSwitch; builds never read these files), then
// frontend's own check:unused script. Every step runs even when an earlier one fails.
// Backend's program also checks the runtime sources it imports, so each diagnostic is printed
// once, with its path from the repository root, under the first step that reported it.
// Exit 1 on any diagnostic or failed step. Report-only: npm run check does not run it, and
// Report consumers may count its `error TS` lines.
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const tscStep = (name) => ({ name, cwd: name, argv: [process.execPath, tsc, '-p', 'tsconfig.unused.json', '--pretty', 'false'] });
const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['npm'];
const STEPS = [
  tscStep('shared'),
  tscStep('runtime'),
  tscStep('backend'),
  tscStep('electron'),
  // npm runs a workspace script in the workspace directory, so its paths are relative to frontend/.
  { name: 'frontend', cwd: 'frontend', spawnCwd: '.', argv: [...npm, 'run', 'check:unused', '-w', 'frontend'] },
];
const DIAGNOSTIC = /^(.+?)\((\d+,\d+)\): (error TS\d+:.*)$/;

const seen = new Set();
const summary = [];
let failed = false;
for (const step of STEPS) {
  const [command, ...args] = step.argv;
  const result = spawnSync(command, args, { cwd: join(root, step.spawnCwd ?? step.cwd), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`.split('\n');
  const diagnostics = [];
  const other = [];
  for (const line of lines) {
    const match = DIAGNOSTIC.exec(line);
    if (match) {
      const file = relative(root, resolve(root, step.cwd, match[1])).split('\\').join('/');
      diagnostics.push(`${file}(${match[2]}): ${match[3]}`);
    } else if (/^\s+\S/.test(line) && diagnostics.length) {
      diagnostics[diagnostics.length - 1] += `\n${line}`; // continuation of a chained message
    } else if (line.trim() && !line.startsWith('> ')) {
      other.push(line); // config errors without a location, npm errors
    }
  }
  const fresh = diagnostics.filter((text) => !seen.has(text));
  for (const text of fresh) seen.add(text);
  const status = result.status ?? 1;
  if (status !== 0 && diagnostics.length === 0) failed = true;
  console.log(`== ${step.name}: ${fresh.length} found${diagnostics.length > fresh.length ? ` (+${diagnostics.length - fresh.length} already listed)` : ''}${status === 0 ? '' : `, exit ${status}`}`);
  for (const text of [...fresh, ...other]) console.log(text);
  summary.push(`${step.name} ${fresh.length}`);
}
console.log(`check:unused: ${seen.size} in total (${summary.join(', ')})`);
process.exit(seen.size || failed ? 1 : 0);
