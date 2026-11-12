import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The living docs (AGENTS.md, READMEs, docs/*.md, docs/features/*.md and the
// in-app help) are what agents follow, and stale pointers fixed in them by hand
// came back within days. This checks what can be checked mechanically:
// backticked repo paths, relative links, `npm run` script names, no `npm exec`
// of node, and that every root scripts test runs under some package.json
// script. Dated records keep the paths and commands of their day.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFileSync(join(root, file), 'utf8');

// Paths a living doc names on purpose although the repository has none; an
// entry also covers what is below it, and `doc` limits it to one doc. Each needs
// a reason, and an entry that matches nothing any more fails.
const ABSENT_PATHS = [
  { path: 'backend/dist', reason: 'npm run backend:build writes the bundled backend there' },
  { path: 'frontend/build', reason: 'npm run frontend:build writes the Vite build there' },
  { path: 'shared/dist', reason: 'npm run shared:build writes it' },
  { path: 'backend/.env', reason: 'the user creates it from backend/.env.example' },
  { path: 'frontend/.env.local', reason: 'the user creates it from frontend/.env.example' },
];

// Benchmark READMEs record a run against a fixed source baseline.
const DATED = [/^docs\/validation\//, /^docs\/investigations\//, /^docs\/superpowers\//, /^docs\/architecture\/review-[^/]+\//, /^benchmarks\//, /(?:^|\/)\d{4}-\d{2}-\d{2}\//];

// Tracked files plus new ones not ignored yet, minus files deleted from the tree.
const fileSet = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter((file) => file && existsSync(join(root, file))));
const files = [...fileSet];
const dirSet = new Set(files.flatMap((file) => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
const topDirs = new Set(files.filter((file) => file.includes('/')).map((file) => file.split('/')[0]));

const livingDocs = files.filter((file) => (
  file === 'AGENTS.md'
  || posix.basename(file) === 'README.md'
  || /^docs\/[^/]+\.md$/.test(file)
  || /^docs\/features\/[^/]+\.md$/.test(file)
  || /^backend\/src\/docs\/[^/]+\.md$/.test(file)
) && !DATED.some((pattern) => pattern.test(file))).sort();

const rootPackage = JSON.parse(read('package.json'));
const packages = new Map([['', rootPackage], ...rootPackage.workspaces.map((dir) => [dir, JSON.parse(read(`${dir}/package.json`))])]);
const packageDirByName = new Map([...packages].map(([dir, pkg]) => [pkg.name, dir]));

function globRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function pathExists(path) {
  const clean = path.replace(/\/+$/, '');
  if (!/[*?]/.test(clean)) return fileSet.has(clean) || dirSet.has(clean);
  const pattern = globRegExp(clean);
  return files.some((file) => pattern.test(file)) || [...dirSet].some((dir) => pattern.test(dir));
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const blank = (text) => text.replace(/[^\n]/g, ' ');

/** Splits Markdown into code (fenced blocks and inline spans, with offsets) and
 *  prose with all code blanked, so offsets stay valid for line numbers. */
function splitMarkdown(text) {
  const code = [];
  let prose = '';
  let fence = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
      else code.push({ text: line, offset });
      prose += blank(line);
    } else if (marker) {
      fence = marker;
      prose += blank(line);
    } else {
      prose += line;
    }
    offset += line.length;
  }
  prose = prose.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (match, ticks, body, index) => {
    code.push({ text: body, offset: index + ticks.length });
    return blank(match);
  });
  return { code, prose };
}

/** Parses `npm ...` up to the end of its shell command into the package
 *  directories it targets, the npm command and its positional arguments. */
function parseNpm(tail, cwd) {
  const words = tail.split(/\s+/).filter(Boolean);
  const dirs = [];
  const positionals = [];
  let unknown = null;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') { positionals.push(...words.slice(i)); break; }
    const flag = /^(-w|--workspace|--prefix)(?:=(.*))?$/.exec(word);
    if (flag) {
      const value = flag[2] ?? words[++i] ?? '';
      const dir = flag[1] === '--prefix'
        ? posix.normalize(posix.join(cwd, value)).replace(/\/+$/, '')
        : packageDirByName.get(value) ?? posix.normalize(posix.join(cwd, value)).replace(/\/+$/, '');
      if (packages.has(dir)) dirs.push(dir); else unknown = value;
    } else if (word === '-ws' || word === '--workspaces') {
      return null;
    } else if (!word.startsWith('-')) {
      positionals.push(word);
    }
  }
  if (!dirs.length) dirs.push(cwd);
  return { dirs, unknown, command: positionals[0], args: positionals.slice(1) };
}

/** Every `npm` invocation in a text, with the line it starts on. A
 *  `cd <dir> &&` just before it is the same as `-w <dir>`. */
function npmCommands(text) {
  const joined = text.replace(/\\\n/g, '  ');
  const starts = lineStarts(text);
  const found = [];
  for (const match of joined.matchAll(/(?<![\w./-])npm\s+/g)) {
    const before = joined.slice(joined.lastIndexOf('\n', match.index) + 1, match.index).split('`').pop();
    const cd = /\bcd\s+(\S+)\s*&&\s*(?:[A-Za-z_]\w*=\S*\s+)*$/.exec(before)?.[1];
    if (cd && (/[$~]/.test(cd) || cd.startsWith('/') || cd.startsWith('..'))) continue;
    const cwd = cd ? posix.normalize(cd).replace(/\/+$/, '').replace(/^\.$/, '') : '';
    const tail = joined.slice(match.index + match[0].length).split(/[`\n;|)]|&&/)[0];
    const parsed = parseNpm(tail, cwd);
    if (parsed) found.push({ line: lineAt(starts, match.index), cwd, ...parsed });
  }
  return found;
}

const SCRIPT_COMMANDS = new Map([['run', null], ['run-script', null], ['test', 'test'], ['t', 'test'], ['start', 'start'], ['stop', 'stop'], ['restart', 'restart']]);

function missingScripts(text) {
  const missing = [];
  for (const { line, cwd, dirs, unknown, command, args } of npmCommands(text)) {
    if (!SCRIPT_COMMANDS.has(command)) continue;
    const name = SCRIPT_COMMANDS.get(command) ?? args[0]?.replace(/[.,:;]+$/, '');
    if (!name || name === '--' || !/^[a-z][\w:.-]*$/.test(name)) continue;
    if (unknown !== null) { missing.push({ line, ref: `-w ${unknown} (no such workspace)` }); continue; }
    if (!packages.has(cwd)) { missing.push({ line, ref: `cd ${cwd} (no package.json)` }); continue; }
    for (const dir of dirs) {
      if (!packages.get(dir).scripts?.[name]) missing.push({ line, ref: `${dir || 'root'}: npm run ${name}` });
    }
  }
  return missing;
}

/** `npm exec node` installs the `node` package from the registry when the
 *  workspace has no node binary of its own, and runs that instead. */
function npmExecNode(text) {
  return npmCommands(text)
    .filter(({ command, args }) => command === 'exec' && args.find((arg) => arg !== '--') === 'node')
    .map(({ line }) => line);
}

function checkDoc(doc, text) {
  const { code, prose } = splitMarkdown(text);
  const starts = lineStarts(text);
  const dir = posix.dirname(doc);
  const paths = [];
  for (const span of code) {
    // A directory tree names each entry relative to the one above it.
    if (/^[\s|`]*(?:[|`]--|[├└]──)/.test(span.text)) continue;
    for (const word of span.text.matchAll(/\S+/g)) {
      const path = word[0]
        .replace(/^[("'[]+/, '')
        .replace(/[#?].*$/, '')
        .replace(/:\d+(?:[-:]\d+)?$/, '')
        .replace(/[.,;:)'"\]]+$/, '');
      if (!path.includes('/') || !topDirs.has(path.split('/')[0]) || /[<>{}$%@]|\.\.\.|…|YYYY/.test(path)) continue;
      if (pathExists(path) || pathExists(posix.join(dir, path))) continue;
      paths.push({ line: lineAt(starts, span.offset + word.index), ref: path.replace(/\/+$/, '') });
    }
  }
  const links = [];
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)|^\s*\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) {
    const href = match[1] ?? match[2];
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#')) continue;
    const raw = href.replace(/[#?].*$/, '');
    let target = raw;
    try { target = decodeURIComponent(raw); } catch { /* a malformed escape stays literal and fails to resolve */ }
    const resolved = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(dir, target)).replace(/\/+$/, '');
    if (!resolved.startsWith('..') && (resolved === '.' || pathExists(resolved))) continue;
    links.push({ line: lineAt(starts, match.index), ref: href });
  }
  return { paths, links, scripts: missingScripts(text), npmExecNode: npmExecNode(text) };
}

const results = livingDocs.map((doc) => ({ doc, ...checkDoc(doc, read(doc)) }));
const findings = (kind) => results.flatMap(({ doc, [kind]: found }) => found.map((finding) => ({ doc, ...finding })));
const report = (list) => list.map(({ doc, line, ref }) => `${doc}:${line} ${ref}`);
const absentEntry = ({ doc, ref }) => ABSENT_PATHS.find((entry) => (!entry.doc || entry.doc === doc) && (ref === entry.path || ref.startsWith(`${entry.path}/`)));

test('the living docs are found and the dated records are not', () => {
  for (const doc of ['AGENTS.md', 'README.md', 'docs/user-guide.md', 'docs/features/README.md', 'backend/src/docs/help.md']) {
    assert.ok(livingDocs.includes(doc), doc);
  }
  assert.deepEqual(livingDocs.filter((doc) => DATED.some((pattern) => pattern.test(doc))), []);
});

test('backticked repo paths in the living docs exist', () => {
  const missing = report(findings('paths').filter((finding) => !absentEntry(finding)));
  assert.deepEqual(missing, [], 'Fix the path, or add it to ABSENT_PATHS with the reason the repository has none.');
});

test('every ABSENT_PATHS entry has a reason and still matches a path a living doc names', () => {
  const used = new Set(findings('paths').map(absentEntry));
  for (const entry of ABSENT_PATHS) {
    assert.ok(entry.reason?.trim(), `${entry.path} needs a reason`);
    assert.ok(used.has(entry), `${entry.path}: no living doc names it any more; remove the entry`);
  }
});

test('relative links in the living docs resolve', () => {
  assert.deepEqual(report(findings('links')), []);
});

test('`npm run` commands in the living docs name scripts of that package', () => {
  assert.deepEqual(report(findings('scripts')), [], '`npm run x -w ws` and `cd ws && npm run x` need x in ws/package.json; plain `npm run x` needs it in the root.');
});

test('no living doc or package.json script runs node through npm exec', () => {
  const docs = results.flatMap(({ doc, npmExecNode: lines }) => lines.map((line) => `${doc}:${line}`));
  const scripts = [...packages].flatMap(([dir, pkg]) => Object.entries(pkg.scripts ?? {})
    .filter(([, command]) => npmExecNode(command).length)
    .map(([name]) => `${dir || 'root'}/package.json: ${name}`));
  assert.deepEqual([...docs, ...scripts], [], 'Use `npm run test:file -w backend -- <files>`, or `cd backend && node ...`.');
});

test('every scripts/**/*.test.mjs runs under some package.json script', () => {
  const referenced = [...packages].flatMap(([dir, pkg]) => Object.values(pkg.scripts ?? {})
    .flatMap((command) => command.split(/\s+/))
    .map((word) => posix.normalize(posix.join(dir, word))));
  const orphans = files.filter((file) => /^scripts\/.+\.test\.mjs$/.test(file))
    .filter((file) => !referenced.some((word) => word === file || (/[*?]/.test(word) && globRegExp(word).test(file))));
  assert.deepEqual(orphans, [], 'Add each to test:contracts, or to a narrower test:* script.');
});

test('the checks catch a missing path, a broken link, an unknown script and npm exec node', () => {
  const doc = [
    'See `scripts/no-such-file.mjs:12` and `docs/features/README.md`.',
    'Read [the guide](user-guide.md), [nothing](no-such-doc.md) and [the web](https://example.com/x.md).',
    '```bash',
    'npm run no-such-script',
    'npm run typecheck -w frontend',
    'npm run typecheck -w michi-shared',
    'cd backend && npm run test:file -- test/x.test.ts',
    'cd frontend && npm run test:file',
    'MICHI_X=1 \\',
    '  npm exec -w backend -- node --require ts-node/register test/x.live.ts',
    '```',
    '`backend/.env` is local.',
    '```text',
    '|-- backend/',
    '|   |-- scripts/build.mjs',
    '```',
  ].join('\n');
  const found = checkDoc('docs/example.md', doc);
  assert.deepEqual(found.paths, [{ line: 1, ref: 'scripts/no-such-file.mjs' }, { line: 12, ref: 'backend/.env' }]);
  assert.ok(absentEntry({ doc: 'docs/example.md', ref: 'backend/.env' }));
  assert.ok(absentEntry({ doc: 'docs/example.md', ref: 'backend/dist/server.js' }));
  assert.equal(absentEntry({ doc: 'docs/example.md', ref: 'shared/project-work.ts' }), undefined);
  assert.deepEqual(found.links, [{ line: 2, ref: 'no-such-doc.md' }]);
  assert.deepEqual(found.scripts, [
    { line: 4, ref: 'root: npm run no-such-script' },
    { line: 6, ref: 'shared: npm run typecheck' },
    { line: 8, ref: 'frontend: npm run test:file' },
  ]);
  assert.deepEqual(found.npmExecNode, [10]);
});
