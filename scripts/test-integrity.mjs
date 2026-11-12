#!/usr/bin/env node
// Read-only report of what a branch did to its tests, for cleanup branches (cleanup plan §3.3).
//
//   node scripts/test-integrity.mjs <base> [<head>] [--strict] [--json]
//
// Reads the commits in <base>..<head> (head defaults to HEAD) and diffs <head> against its merge base
// with <base>, like `git diff <base>...<head>`; uncommitted changes are not included. Violations:
//   skip      an added .only/.skip/.todo/fixme: it|test|describe|suite .only/.skip/.skipIf/.runIf/.todo,
//             test.describe.skip, test.fixme(), t.skip(), testInfo.fixme() or a { skip | only | todo } test option,
//             also on its own line of a multi-line options object (`test('x', {` / `skip: true,` / `}, fn)`);
//             or a test config that drops `allowOnly: false` or `forbidOnly: true`. Plan §3.3 allows new tests,
//             so a new file or a test that a hunk adds whole may skip on the platform or the environment:
//             { skip: process.platform === 'win32' }, skipIf(!process.env.LIVE), test.skip(process.env.X !== '1')
//             inside the test, or a t.skip() whose `if` reads them. The condition (a skip option's value, the
//             condition argument, or for a runtime skip an `if` on its line whose branch holds it and the `if`
//             blocks around it in its test) must read process.platform, .arch or .env, import.meta.env or
//             os.platform()/arch()/type(), itself or through a const, let, var or function of the same file
//             (`skip: !enabled` with `const enabled = process.env.LIVE === '1'`). Such a skip anywhere else, on
//             an existing test or as a file- or group-wide test.skip(condition), counts as "a platform/env-gated
//             .skip", which may replace a removed skip. Unconditional skips (it.skip('x'), skip: true, a reason
//             string) and other conditions always count, and so do .only, .todo and fixme
//   timeout   in a file that already existed: a raised timeout ({ timeout: n }, *Timeout = n, it(..., ms),
//             waitForTimeout), a timeout added to a changed line or to a test's options, or a new
//             test.setTimeout(), test.slow(), testTimeout or --test-timeout. 0 means no limit and counts as the
//             largest value, and so does a script that loses its --test-timeout (node --test has none of its
//             own). A test or suite that a hunk adds whole may set its own limit: plan §3.3 allows new tests
//   retry     newly added retries: retry/retries test options and config, --retries
//   golden    a changed or deleted golden fixture, snapshot or reviewed snapshot (permissionMatrix.json), unless
//             a commit in the range has the line `Golden-Change: approved <reason>`; a new one is not a change
//   baseline  a new entry in a ratchet baseline, even when others go: scripts/knip-baseline.json keys per
//             section, dependencyRules/edges.txt and runtimeBoundary/*.txt entries (a raised runtime-id count
//             counts), known-failures.json ids. An entry that follows a file the range renamed is not new
// It also lists every changed test file with +/- line counts for the reviewer. Assertions are not counted.
// Exit 0 in report mode; --strict exits 1 on any violation. Usage and git errors exit 2.
//
// Changed lines are read within their file, so strings, template literals and comments, also across lines,
// do not count. Known limits: options passed through another variable are not seen, nor a skip condition
// that changes only through its binding; a binding or function counts as gated when it reads the platform or
// the environment anywhere (a helper that passes process.env.PATH to a child), and `...process.env` is not
// read; a new test is seen only in a hunk that adds lines only, so one that git's diff joins to a changed
// line next to it counts as an existing one; a regex literal is recognised only where an operand may start
// and when it closes on its line; a `}, ms)` closer, an options object, a new test and the `if` blocks around
// a skip are told apart by indentation, which assumes prettier-style layout.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
const SIDES = ['removed', 'added'];
const USAGE = 'Usage: node scripts/test-integrity.mjs <base> [<head>] [--strict] [--json]';

const GOLDEN = [
  /^backend\/test\/fixtures\/[^/]*golden/i, // claudeAdapterGolden/, mcpToolCatalog.golden.json, dataDbSchema.golden.txt
  /^backend\/test\/fixtures\/permissionMatrix\.json$/, // the reviewed snapshot MICHI_UPDATE_PERMISSION_MATRIX rewrites
  /^backend\/test\/fixtures\/runtimeDescriptors\//,
  /^runtime\/test\/fixtures\//,
  /(^|\/)test\/fixtures\/[^/]*snapshot/i,
  /(^|\/)__snapshots__\/|\.snap$/,
  /\.golden\.[^/]+$/,
];
const GOLDEN_CHANGE = /^Golden-Change:[ \t]*approved[ \t]+(\S.*)$/gm;
const KNIP_BASELINE = 'scripts/knip-baseline.json';
const KNOWN_FAILURES = 'docs/validation/known-failures.json';
const LINE_BASELINE = /^backend\/test\/fixtures\/(dependencyRules\/edges|runtimeBoundary\/[^/]+)\.txt$/;

const TEST_FILE = /(^|\/)(test|tests|__tests__|__snapshots__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/;
const TEST_CONFIG = /(^|\/)(vitest|playwright)\.(config|workspace)\.[cm]?[jt]s$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;

// Not after a dot or inside a name, so /re/.test(s) and obj.it( are not test calls.
const NOT_MEMBER = String.raw`(?<![.\w$])`;
const CALLEE = String.raw`${NOT_MEMBER}(?:it|test|describe|suite|bench)`;
const TEST_CALL = new RegExp(String.raw`${CALLEE}(?:\.\w+)*\s*\(`);
const TEST_CALL_START = new RegExp(String.raw`^\s*(?:await\s+)?${CALLEE}(?:\.\w+)*\s*\(`);
// A test or suite declaration, as opposed to a hook or test.setTimeout(): where a new test starts. It may
// follow a loop header, as in `for (const cell of cells) test(...)`.
const TEST_DECL = new RegExp(String.raw`^\s*(?:for\s*\(.*\)\s*)?(?:await\s+)?${CALLEE}(?:\.(?:only|skip|todo|fixme|fails|concurrent|sequential|`
  + String.raw`shuffle|describe|serial|parallel|each|for|skipIf|runIf)\b(?:\([^)]*\))?)*\s*\(`);
// Playwright's test.skip(condition) and test.fixme(condition) annotate the tests around them; with a title
// first they declare one.
const ANNOTATION_START = /^\s*(?:await\s+)?test\.(?:skip|fixme)\s*\(/;
// A test declaration's marker (it.skip('x'), describe.skipIf(c)), then a runtime one inside a test (t.skip()).
const MARKERS = [
  new RegExp(String.raw`${CALLEE}(?:\.\w+)*?\.(only|skip|skipIf|runIf|todo|fixme)\b`, 'g'),
  new RegExp(String.raw`(?:${NOT_MEMBER}(?:t|ctx|context|testInfo|info)|\binfo\(\))\.(skip|todo|fixme)(?=\s*\()`, 'g'),
];
const MARKER_OPTION = /(?:^|[{,])\s*(only|skip|todo)\s*(?::(?!\s*(?:false|0|null|undefined)\b)|(?=[,}]|$))/g;
// A platform- or environment-gated skip outside a new test; it may take the place of a removed skip.
const GATED_SKIP = 'gated skip';
const MARKER_KINDS = ['only', 'skip', GATED_SKIP, 'todo', 'fixme'];
// What a skip may depend on and still not count, after strings are blanked; a quoted argument is a title or reason.
const PLATFORM_OR_ENV = new RegExp(String.raw`${NOT_MEMBER}process\s*\.\s*(?:platform|arch|env)\b|`
  + String.raw`${NOT_MEMBER}import\s*\.\s*meta\s*\.\s*env\b|${NOT_MEMBER}os\s*\.\s*(?:platform|arch|type)\s*\(`);
const IDENTIFIER = new RegExp(String.raw`${NOT_MEMBER}[A-Za-z_$][\w$]*`, 'g');
const QUOTED = /^\s*(?:''|""|``)/;
const IF_OPEN = new RegExp(String.raw`${NOT_MEMBER}if\s*\(`, 'g');
const IF_BLOCK = /^\s*(?:\}\s*else\s+)?if\s*\(/;
// Test options sit on the test call, right before its callback, or in a `const LIVE = { skip: … }`; a
// property line of a multi-line object is resolved through the line that opens the object.
const OPTIONS_BEFORE_CALLBACK = /\}\s*,\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/;
const OPTIONS_CONST = /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*\{/;
const PROPERTY_LINE = /^\s*[\w$]+\s*(?::|,|$)/;
// Changed lines that can hold a marker, timing or guard; only their files are read in full.
const CANDIDATE = /only|skip|todo|fixme|runif|timeout|retr|slow|\}\s*,\s*\d/i;
const REGEX_MAY_START = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|void|yield|await|delete|throw|new|else|do))\s*$/;

const SET_TIMEOUT = new RegExp(String.raw`(?:${NOT_MEMBER}(?:test|testInfo|info)|\binfo\(\))\.setTimeout\s*\(`, 'g');
const SLOW = new RegExp(String.raw`(?:${NOT_MEMBER}(?:test|testInfo|info)|\binfo\(\))\.slow\s*\(`, 'g');
const WAIT_FOR_TIMEOUT = /\.waitForTimeout\s*\(/g;
const TIMEOUT_KEY = /\b(\w*(?:timeout|Timeout|TIMEOUT)\w*)\s*(?::|=(?![=>]))/g;
const RUNNER_TIMEOUT_KEY = /^(?:testTimeout|hookTimeout|teardownTimeout)$/;
const RETRY_KEY = /\bretr(?:y|ies)\s*:/g;
const CLOSING_ARG = /\}\s*,\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)\s*\)\s*;?\s*$/; // `}, 20_000);` ends a call
const PACKAGE_TIMEOUT = /--(?:test-|hook-|teardown-)?timeout[= ](\d+)|--(?:test|hook|teardown)Timeout[= ](\d+)/g;
const PACKAGE_RETRY = /--retr(?:y|ies)[= ](\d+)/g;
const NODE_TEST_TIMEOUT = /--test-timeout[= ]\d+/g;
const SCRIPT_NAME = /^\s*"((?:[^"\\]|\\.)*)"\s*:/;
// Settings that make a run fail on .only; the value that turns them off does not count as one.
const ONLY_GUARD = /\b(allowOnly|forbidOnly)\s*:\s*([^,}]+)/g;
const ONLY_GUARD_OFF = { allowOnly: 'true', forbidOnly: 'false' };
const ONLY_GUARD_ON = { allowOnly: 'false', forbidOnly: 'true' };
const NUMBER_PRODUCT = /(?<![\w$.])\d[\d_]*(?:\.\d+)?(?:\s*\*\s*\d[\d_]*(?:\.\d+)?)*/g;

function git(root, args, { input, buffer = false } = {}) {
  try {
    return execFileSync(GIT, ['-C', root, '-c', 'core.quotePath=false', ...args], {
      encoding: buffer ? undefined : 'utf8', input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim() || `git ${args[0]} failed`);
  }
}

function commitOf(root, ref) {
  if (ref.startsWith('-')) throw new Error(`not a commit: ${ref}`);
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`not a commit: ${ref}`);
  }
}

// `git cat-file --batch` for `<rev>:<path>` specs; a missing blob maps to null.
function readBlobs(root, specs) {
  const blobs = new Map();
  if (specs.length === 0) return blobs;
  const out = git(root, ['cat-file', '--batch'], { input: specs.map((spec) => `${spec}\n`).join(''), buffer: true });
  let at = 0;
  for (const spec of specs) {
    const end = out.indexOf(10, at);
    const header = out.toString('utf8', at, end).split(' ');
    at = end + 1;
    if (header.length !== 3) {
      blobs.set(spec, null);
      continue;
    }
    const size = Number(header[2]);
    blobs.set(spec, out.toString('utf8', at, at + size));
    at += size + 1;
  }
  return blobs;
}

function parseNameStatus(raw) {
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length - 1;) {
    const status = parts[i++][0];
    if (status === 'R' || status === 'C') files.push({ status, oldPath: parts[i++], newPath: parts[i++] });
    else {
      const path = parts[i++];
      files.push({ status, oldPath: status === 'A' ? null : path, newPath: status === 'D' ? null : path });
    }
  }
  return files;
}

function parseNumstat(raw) {
  const counts = new Map();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    const [added, deleted, ...rest] = parts[i].split('\t');
    let path = rest.join('\t');
    if (path === '') {
      path = parts[i + 2];
      i += 2;
    }
    counts.set(path, { added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) });
  }
  return counts;
}

function patchPath(header) {
  let path = header.slice(4);
  if (path === '/dev/null') return null;
  if (path.startsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, '$1');
  return path.slice(2);
}

// Files of a `git diff -U0` patch with their removed and added lines, numbered on each side.
function parsePatch(raw) {
  const files = [];
  const lines = raw.split('\n');
  let file = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, isNew: false, hunks: [] };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      let [oldLine, oldLeft, newLine, newLeft] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3]), Number(m[4] ?? 1)];
      const hunk = { removed: [], added: [] };
      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const body = lines[++i];
        if (body.startsWith('\\')) continue;
        if (body.startsWith('-')) {
          hunk.removed.push({ line: oldLine++, text: body.slice(1) });
          oldLeft -= 1;
        } else if (body.startsWith('+')) {
          hunk.added.push({ line: newLine++, text: body.slice(1) });
          newLeft -= 1;
        } else {
          [oldLine, newLine, oldLeft, newLeft] = [oldLine + 1, newLine + 1, oldLeft - 1, newLeft - 1];
        }
      }
      file.hunks.push(hunk);
    } else if (line.startsWith('--- ')) {
      file.oldPath = patchPath(line);
    } else if (line.startsWith('+++ ')) {
      file.newPath = patchPath(line);
    } else if (line.startsWith('new file mode')) {
      file.isNew = true;
    }
  }
  return files;
}

const isGolden = (path) => GOLDEN.some((pattern) => pattern.test(path));
const isTestPath = (path) => TEST_FILE.test(path) || TEST_CONFIG.test(path);
const isBaseline = (path) => path === KNIP_BASELINE || path === KNOWN_FAILURES || LINE_BASELINE.test(path);

function scanKind(path) {
  if (PACKAGE_JSON.test(path)) return 'package';
  if (TEST_CONFIG.test(path)) return 'config';
  if (TEST_FILE.test(path) && CODE_FILE.test(path) && !isGolden(path)) return 'test';
  return null;
}

// The index of a regex literal's last flag when the literal starting at `start` closes on its line, else -1.
function regexEnd(line, start) {
  let inClass = false;
  for (let j = start + 1; j < line.length; j += 1) {
    const ch = line[j];
    if (ch === '\\') {
      j += 1;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      while (/[a-z]/i.test(line[j + 1] ?? '')) j += 1;
      return j;
    }
  }
  return -1;
}

// Each line of a file as code, with the contents of strings, template literals (with their ${ }), regex
// literals and comments removed, so quoted or commented markers do not count. Template literals and block
// comments carry across lines; `inside` marks a line that starts in one, whose indentation means nothing.
// A regex literal is recognised where an operand may start, and only when it closes on its line.
function codeLinesOf(text) {
  const result = [];
  const stack = []; // '`' per open template literal, and the brace depth of each ${ } inside one
  let comment = false;
  let recent = ''; // the last characters read as code, to tell a regex literal from a division
  const read = (s) => {
    recent += s;
    if (recent.length > 48) recent = recent.slice(-24);
  };
  for (const line of text.split('\n')) {
    const inside = comment || stack.length > 0;
    let code = '';
    const emit = (s) => {
      if (stack.length === 0) code += s;
      read(s);
    };
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (comment) {
        if (ch === '*' && line[i + 1] === '/') {
          comment = false;
          i += 1;
        }
      } else if (stack.at(-1) === '`') {
        if (ch === '\\') {
          i += 1;
        } else if (ch === '$' && line[i + 1] === '{') {
          stack.push(0);
          i += 1;
        } else if (ch === '`') {
          stack.pop();
          emit('``');
        }
      } else if (ch === '/' && line[i + 1] === '/') {
        break;
      } else if (ch === '/' && line[i + 1] === '*') {
        comment = true;
        i += 1;
      } else if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        emit(ch + ch);
        i = j;
      } else if (ch === '`') {
        stack.push('`');
      } else if (ch === '/' && REGEX_MAY_START.test(recent) && regexEnd(line, i) > 0) {
        emit('/ /');
        i = regexEnd(line, i);
      } else if (ch === '}' && stack.at(-1) === 0) {
        stack.pop();
      } else {
        if (typeof stack.at(-1) === 'number' && (ch === '{' || ch === '}')) stack[stack.length - 1] += ch === '{' ? 1 : -1;
        emit(ch);
      }
    }
    read(' ');
    result.push({ code, indent: line.length - line.trimStart().length, inside });
  }
  return result;
}

// One line read on its own, for a file that could not be read; a leading `*` is taken as a doc comment.
const codeOnly = (line) => (/^\s*\*/.test(line) ? '' : codeLinesOf(line)[0].code);
const indentOf = (line) => line.length - line.trimStart().length;

// The expression starting at `start`, up to a top-level , ; ) ] or }.
function readExpr(code, start) {
  let depth = 0;
  let i = start;
  for (; i < code.length; i += 1) {
    const ch = code[i];
    if ('([{'.includes(ch)) {
      depth += 1;
    } else if (')]}'.includes(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if ((ch === ',' || ch === ';') && depth === 0) {
      break;
    }
  }
  return code.slice(start, i);
}

// The largest numeric literal or literal product (60 * 1000) in an expression, or null.
function numericValue(expr) {
  let max = null;
  for (const m of expr.matchAll(NUMBER_PRODUCT)) {
    const value = m[0].split('*').reduce((product, factor) => product * Number(factor.trim().replaceAll('_', '')), 1);
    if (Number.isFinite(value) && (max === null || value > max)) max = value;
  }
  return max;
}

const isTestOptionsLine = (code) => TEST_CALL.test(code) || OPTIONS_BEFORE_CALLBACK.test(code);
const isSkipOption = ({ kind }) => kind === 'skip' || kind === 'only';

// The first argument of the call that starts at `at`, or null when no call does.
function firstArg(code, at) {
  const open = /^\s*\(/.exec(code.slice(at));
  return open ? readExpr(code, at + open[0].length) : null;
}

// Marker calls (it.only, t.skip()) and skip/only/todo keys on a line of code; the keys count only in a
// test's options, which the caller decides. A call keeps its first argument, a key its value.
const markersOf = (code) => ({
  calls: MARKERS.flatMap((pattern, runtime) => [...code.matchAll(pattern)].map((m) => ({
    kind: m[1], start: m.index, arg: firstArg(code, m.index + m[0].length), runtime: runtime === 1,
  }))),
  options: [...code.matchAll(MARKER_OPTION)].map((m) => ({
    kind: m[1], value: m[0].endsWith(':') ? readExpr(code, m.index + m[0].length) : m[1],
  })),
});

// The initialisers of the consts, lets and vars named `name` in a file, and the bodies of its functions so
// named, each with the lines indented under it.
function declarationsOf(codeLines, name) {
  if (!codeLines) return [];
  const id = name.replaceAll('$', '\\$');
  const declaration = new RegExp(String.raw`^\s*(?:export\s+)?(?:(?:const|let|var)\s+(?:${id}|[{[][^=]*?(?<![\w$])${id}`
    + String.raw`(?![\w$])[^=]*)\s*(?::[^=]*)?=(?![=>])|(?:async\s+)?function\s*\*?\s*${id}\s*\()`);
  const found = [];
  codeLines.forEach(({ code, indent }, i) => {
    const m = declaration.exec(code);
    if (!m) return;
    let text = code.slice(m[0].length);
    for (let j = i + 1; j < codeLines.length; j += 1) {
      const next = codeLines[j];
      if (!next.inside && next.code.trim() !== '' && next.indent <= indent) break;
      text += ` ${next.code}`;
    }
    found.push(text);
  });
  return found;
}

// Whether an expression reads the platform or the environment, itself or through what it names in the file.
function readsPlatformOrEnv(expr, codeLines, seen = new Set()) {
  if (PLATFORM_OR_ENV.test(expr)) return true;
  for (const [name] of expr.matchAll(IDENTIFIER)) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (declarationsOf(codeLines, name).some((text) => readsPlatformOrEnv(text, codeLines, seen))) return true;
  }
  return false;
}

// Whether a skip marker on line `lineNo` is gated on the platform or the environment (see the header). A
// declaration with a quoted first argument, it.skip('x'), has no condition. A runtime skip, t.skip('reason')
// or Playwright's test.skip() inside a test, is also decided by an `if` on its line whose branch holds it
// and by the `if` blocks around it up to its test.
function gatedSkip(code, marker, codeLines, lineNo) {
  const reads = (expr) => readsPlatformOrEnv(expr, codeLines);
  if ('value' in marker) return reads(marker.value);
  const arg = marker.arg?.trim();
  if (arg && !QUOTED.test(arg) && reads(arg)) return true;
  if (!marker.runtime && arg !== '') return false;
  // `if (c) t.skip()` and `if (c) { t.skip(); }` hold the skip; `if (c) return; t.skip()` does not.
  const guards = (m) => {
    const from = m.index + m[0].length;
    const condition = readExpr(code, from);
    const branch = from + condition.length + 1;
    return branch + readExpr(code, branch).length > marker.start && reads(condition);
  };
  if ([...code.slice(0, marker.start).matchAll(IF_OPEN)].some(guards)) return true;
  let indent = codeLines?.[lineNo - 1]?.indent ?? 0;
  for (let i = lineNo - 2; codeLines && i >= 0 && indent > 0; i -= 1) {
    const { code: above, indent: at, inside } = codeLines[i];
    if (inside || above.trim() === '' || at >= indent) continue;
    indent = at;
    if (TEST_CALL_START.test(above)) break;
    const head = IF_BLOCK.exec(above);
    if (head && reads(readExpr(above, head[0].length))) return true;
  }
  return false;
}

// The object a property line sits in, when it is a test call's options (`test('x', {` ... `}, fn)`) or a
// `const LIVE = {` constant, else null. The object opens on the nearest line above with less indentation.
// A constant holds test options when it declares skip or only; its timeouts are then a test's own.
function optionsObject(codeLines, lineNo) {
  if (!codeLines) return null;
  const indent = codeLines[lineNo - 1]?.indent ?? 0;
  for (let i = lineNo - 2; i >= 0; i -= 1) {
    const { code, indent: at, inside } = codeLines[i];
    if (inside || code.trim() === '' || at >= indent) continue;
    if (!code.trimEnd().endsWith('{')) return null;
    if (TEST_CALL_START.test(code)) return { kind: 'call' };
    if (!OPTIONS_CONST.test(code)) return null;
    let skip = false;
    for (let j = i + 1; j < codeLines.length; j += 1) {
      const line = codeLines[j];
      if (!line.inside && line.code.trim() !== '' && line.indent <= at) break;
      if (markersOf(line.code).options.some(isSkipOption)) skip = true;
    }
    return { kind: 'const', skip };
  }
  return null;
}

// Timeouts and retries set on one line of code. `runner` marks a test's or the runner's own limit, as
// opposed to a wait inside a test; `global` marks a runner-wide one (testTimeout), which a new test cannot
// claim as its own. `pending` marks a `}, ms)` closer whose call is looked up in the file.
function timingsOf(code, runnerLine) {
  const found = [];
  const add = (kind, value, runner, extra = {}) => {
    if (value !== null) found.push({ kind, value: kind === 'timeout' && value === 0 ? Infinity : value, runner, ...extra });
  };
  const valueAfter = (m) => numericValue(readExpr(code, m.index + m[0].length));
  for (const m of code.matchAll(SET_TIMEOUT)) add('timeout', valueAfter(m), true);
  for (const m of code.matchAll(SLOW)) add('slow', 1, true);
  for (const m of code.matchAll(WAIT_FOR_TIMEOUT)) add('timeout', valueAfter(m), false);
  for (const m of code.matchAll(TIMEOUT_KEY)) {
    const global = RUNNER_TIMEOUT_KEY.test(m[1]);
    add('timeout', valueAfter(m), runnerLine || global, { global });
  }
  for (const m of code.matchAll(RETRY_KEY)) add('retry', valueAfter(m), runnerLine);
  const closer = CLOSING_ARG.exec(code);
  if (closer && TEST_CALL_START.test(code)) add('timeout', numericValue(closer[1]), true);
  else if (closer && /^\s*\}/.test(code)) add('timeout', numericValue(closer[1]), true, { pending: true });
  return found;
}

// A script's --test-timeout is not `runner`: node --test has no limit by default, so a new script that
// sets one is not a raise; changing an existing script's value still is.
const packageTimingsOf = (text) => [
  ...[...text.matchAll(PACKAGE_TIMEOUT)].map((m) => ({ kind: 'timeout', value: Number(m[1] ?? m[2]) || Infinity, runner: false })),
  ...[...text.matchAll(PACKAGE_RETRY)].map((m) => ({ kind: 'retry', value: Number(m[1]), runner: true })),
];

// Lines of a hunk that only adds lines and that belong to a test or suite it declares. Plan §3.3 allows
// new tests, so a new test's own timeout, test.slow() or platform/env-gated skip is not a raise or a skip.
// A conditional test.skip(condition) at file or group level is not a new test: it skips the ones around it.
function newTestLines(added, lineAt) {
  const lines = new Set();
  const depth = (code) => (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);
  const declares = (code) => {
    const annotation = ANNOTATION_START.exec(code);
    return TEST_DECL.test(code) && (!annotation || QUOTED.test(readExpr(code, annotation[0].length)));
  };
  let open = null; // indentation of the new test being read
  for (const { line, text } of added) {
    const { code, indent, inside } = lineAt(line, text);
    if (inside || code.trim() === '') {
      if (open !== null) lines.add(line);
    } else if (open !== null && indent > open) {
      lines.add(line);
    } else if (declares(code)) {
      lines.add(line);
      open = depth(code) > 0 ? indent : null;
    } else if (open !== null && indent === open) {
      lines.add(line); // its closer: `});` or `}, 20_000);`
      open = null;
    } else {
      open = null;
    }
  }
  return lines;
}

// A script that keeps its name in a hunk but loses a --test-timeout runs node --test without a limit.
function droppedTestTimeouts(hunk, index) {
  const flags = (text) => text.match(NODE_TEST_TIMEOUT)?.length ?? 0;
  const before = new Map();
  for (const { text } of hunk.removed) {
    const name = SCRIPT_NAME.exec(text)?.[1];
    if (name !== undefined) before.set(name, (before.get(name) ?? 0) + flags(text));
  }
  const dropped = [];
  for (const { line, text } of hunk.added) {
    const name = SCRIPT_NAME.exec(text)?.[1];
    for (let n = flags(text); n < (before.get(name) ?? 0); n += 1) {
      dropped.push({ kind: 'timeout', value: Infinity, runner: true, line, text, hunk: index, modifying: true,
        message: 'removes --test-timeout (no limit)' });
    }
  }
  return dropped;
}

// Whether line `lineNo` (a `}, ms)` closer) ends an it/test/describe call: the call starts on the
// nearest line above with the same indentation.
function closesTestCall(codeLines, lineNo) {
  if (!codeLines) return false;
  const indent = codeLines[lineNo - 1]?.indent ?? 0;
  for (let i = lineNo - 2; i >= 0; i -= 1) {
    const { code, indent: at, inside } = codeLines[i];
    if (inside || code.trim() === '') continue;
    if (at < indent) return false;
    if (at === indent) return TEST_CALL_START.test(code);
  }
  return false;
}

// Markers, timings and only-guards on the changed lines of one file. `sideLines(side)` gives that side's
// code lines (null when unread), so a line is read with the strings and comments around it.
function scanFile(file, sideLines) {
  const fileKind = scanKind(file.newPath);
  const scan = { path: file.newPath, isNew: file.isNew || file.oldPath === null,
    markers: { removed: [], added: [] }, timings: { removed: [], added: [] }, guards: { removed: [], added: [] } };
  const codeLines = { removed: sideLines('removed'), added: sideLines('added') };
  file.hunks.forEach((hunk, index) => {
    const modifying = hunk.removed.length > 0 && hunk.added.length > 0;
    if (fileKind === 'package') {
      for (const side of SIDES) {
        for (const { line, text } of hunk[side]) {
          for (const timing of packageTimingsOf(text)) scan.timings[side].push({ ...timing, line, text, hunk: index, modifying });
        }
      }
      scan.timings.added.push(...droppedTestTimeouts(hunk, index));
      return;
    }
    for (const side of SIDES) {
      const lines = codeLines[side];
      const lineAt = (line, text) => lines?.[line - 1] ?? { code: codeOnly(text), indent: indentOf(text), inside: false };
      const fresh = side === 'added' && !modifying && fileKind === 'test' ? newTestLines(hunk.added, lineAt) : new Set();
      for (const { line, text } of hunk[side]) {
        if (!CANDIDATE.test(text)) continue;
        const { code } = lineAt(line, text);
        const { calls, options } = markersOf(code);
        let object = null;
        if (isTestOptionsLine(code)) object = { kind: 'call' };
        else if (OPTIONS_CONST.test(code)) object = { kind: 'const', skip: options.some(isSkipOption) };
        else if (PROPERTY_LINE.test(code)) object = optionsObject(lines, line);
        if (fileKind === 'test') {
          // `todo:` is common event data, so an options constant counts only skip and only.
          const declared = object?.kind === 'call' ? options : object?.kind === 'const' ? options.filter(isSkipOption) : [];
          for (const marker of [...calls, ...declared]) {
            const kind = marker.kind === 'skipIf' || marker.kind === 'runIf' ? 'skip' : marker.kind;
            const gated = kind === 'skip' && gatedSkip(code, marker, lines, line);
            // Plan §3.3 allows new tests: a new file or a test a hunk adds whole may skip on the platform or env.
            if (gated && side === 'added' && (scan.isNew || fresh.has(line))) continue;
            scan.markers[side].push({ kind: gated ? GATED_SKIP : kind, line, text, hunk: index });
          }
        } else {
          for (const m of code.matchAll(ONLY_GUARD)) scan.guards[side].push({ name: m[1], value: m[2].trim(), line, text });
        }
        const runnerLine = fileKind === 'config' || object?.kind === 'call' || Boolean(object?.skip) || /\.configure\s*\(/.test(code);
        for (const timing of timingsOf(code, runnerLine)) {
          if (timing.pending && !closesTestCall(lines, line)) continue;
          scan.timings[side].push({ ...timing, line, text, hunk: index, modifying, fresh: fresh.has(line) });
        }
      }
    }
  });
  return scan;
}

// Added values not covered by a removed value at least as large, smallest first.
function uncovered(added, removedValues) {
  const pool = [...removedValues].sort((a, b) => a - b);
  const left = [];
  let next = 0;
  for (const item of [...added].sort((a, b) => a.value - b.value)) {
    while (next < pool.length && pool[next] < item.value) next += 1;
    if (next < pool.length) next += 1;
    else left.push(item);
  }
  return left;
}

const violation = (rule, file, line, message, text) => ({ rule, file, line, message, ...(text ? { text: text.trim() } : {}) });
const shown = (value) => (value === Infinity ? 'no limit' : String(value));

// Added markers beyond the removed ones of their kind. A gated skip may also take the place of a removed
// unconditional skip that no added one took, since it skips less; one in the hunk that removed it does first.
function markerViolations({ path, removed, added }) {
  const out = [];
  let spareSkips = 0;
  const replacing = new Set(removed.filter((m) => m.kind === 'skip').map((m) => m.hunk));
  for (const kind of MARKER_KINDS) {
    const before = removed.filter((m) => m.kind === kind).map((m) => m.text.trim());
    const now = added.filter((m) => m.kind === kind);
    const excess = now.length - before.length - (kind === GATED_SKIP ? spareSkips : 0);
    if (kind === 'skip') spareSkips = Math.max(0, -excess);
    if (excess <= 0) continue;
    const unmatched = now.filter((m) => {
      const i = before.indexOf(m.text.trim());
      if (i >= 0) before.splice(i, 1);
      return i < 0;
    });
    let reported = unmatched.length >= excess ? unmatched : now;
    if (kind === GATED_SKIP) reported = [...reported.filter((m) => !replacing.has(m.hunk)), ...reported.filter((m) => replacing.has(m.hunk))];
    for (const m of reported.slice(0, excess).sort((a, b) => a.line - b.line)) {
      const message = kind === GATED_SKIP ? 'adds a platform/env-gated .skip to an existing test' : `adds .${kind}`;
      out.push(violation('skip', path, m.line, message, m.text));
    }
  }
  return out;
}

function timingViolations({ path, isNew, removed, added }) {
  const out = [];
  for (const kind of ['timeout', 'retry']) {
    const before = removed.filter((t) => t.kind === kind);
    const now = added.filter((t) => t.kind === kind && (kind === 'timeout' || t.value > 0));
    for (const t of uncovered(now, before.map((r) => r.value))) {
      const counts = kind === 'retry' ? t.runner || (!isNew && t.modifying)
        : !isNew && (t.runner || t.modifying) && !(t.fresh && !t.global);
      if (!counts) continue;
      const replaced = before.filter((r) => r.hunk === t.hunk && r.value < t.value).map((r) => r.value);
      const noun = kind === 'retry' ? 'retries' : 'a timeout';
      const message = t.message ?? (replaced.length > 0
        ? `raises ${noun} from ${shown(Math.max(...replaced))} to ${shown(t.value)}`
        : `adds ${kind === 'retry' ? `retries: ${t.value}` : `a timeout of ${shown(t.value)}`}`);
      out.push(violation(kind, path, t.line, message, t.text));
    }
  }
  const slow = added.filter((t) => t.kind === 'slow');
  const excess = slow.length - removed.filter((t) => t.kind === 'slow').length;
  if (!isNew && excess > 0) {
    for (const t of slow.filter((s) => !s.fresh).slice(-excess)) out.push(violation('timeout', path, t.line, 'adds test.slow()', t.text));
  }
  return out;
}

// A removed allowOnly/forbidOnly setting that still guarded against .only and came back neither as it was
// nor turned fully on.
function guardViolations({ path, removed, added }) {
  const left = [...added];
  const out = [];
  for (const g of removed.filter((r) => r.value !== ONLY_GUARD_OFF[r.name])) {
    const i = left.findIndex((a) => a.name === g.name && (a.value === g.value || a.value === ONLY_GUARD_ON[g.name]));
    if (i >= 0) {
      left.splice(i, 1);
      continue;
    }
    const now = added.find((a) => a.name === g.name);
    const change = now ? `changes ${g.name}: ${g.value} to ${now.value}` : `drops ${g.name}: ${g.value}`;
    out.push(violation('skip', path, now?.line ?? null, `${change}, so .only no longer fails the run`, (now ?? g).text));
  }
  return out;
}

// Baseline entries per section as key -> weight; runtime-id lines weigh their trailing count.
function baselineSections(path, content) {
  const sections = new Map();
  if (content === null || content === undefined) return sections;
  const section = (name) => sections.get(name) ?? sections.set(name, new Map()).get(name);
  const bump = (entries, key, weight = 1) => entries.set(key, (entries.get(key) ?? 0) + weight);
  if (path === KNIP_BASELINE) {
    for (const [name, keys] of Object.entries(JSON.parse(content))) {
      if (Array.isArray(keys)) for (const key of keys) bump(section(name), String(key));
    }
  } else if (path === KNOWN_FAILURES) {
    const entries = section('');
    for (const entry of JSON.parse(content)) bump(entries, typeof entry?.id === 'string' ? entry.id : JSON.stringify(entry));
  } else {
    const entries = section('');
    for (const raw of content.split('\n')) {
      const line = raw.trimEnd();
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      const fields = line.split('\t');
      if (fields.length >= 3 && /^\d+$/.test(fields.at(-1))) bump(entries, fields.slice(0, -1).join('\t'), Number(fields.at(-1)));
      else bump(entries, line);
    }
  }
  return sections;
}

// Every entry that is new or weighs more is a violation, even when others go: fixing two keys does not pay
// for accepting a third (plan §3.7). An entry whose file the range renamed keeps its weight under the new
// path, so a move is not an addition.
function compareBaseline(path, beforeContent, afterContent, renames = new Map()) {
  const rows = [];
  const violations = [];
  let before;
  let after;
  try {
    after = baselineSections(path, afterContent);
  } catch (error) {
    return { rows, violations: [violation('baseline', path, null, `cannot be read at head: ${error.message}`)] };
  }
  try {
    before = baselineSections(path, beforeContent);
  } catch {
    before = new Map();
  }
  const size = (entries) => [...entries.values()].reduce((sum, weight) => sum + weight, 0);
  const renamed = (key) => key.split('\t').map((field) => renames.get(field) ?? field).join('\t');
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name) ?? new Map();
    const now = after.get(name) ?? new Map();
    const moved = new Map();
    for (const [key, weight] of was) moved.set(renamed(key), (moved.get(renamed(key)) ?? 0) + weight);
    const grown = [...now].filter(([key, weight]) => weight > (moved.get(key) ?? 0));
    const added = grown.map(([key]) => key);
    const row = { file: path, section: name || null, before: size(was), after: size(now), added };
    if (row.before === row.after && added.length === 0) continue;
    rows.push(row);
    const where = name ? `[${name}] ` : '';
    for (const [key, weight] of grown) {
      const had = moved.get(key) ?? 0;
      const message = path === KNOWN_FAILURES ? `adds known failure ${key}`
        : had > 0 ? `${where}raises an entry's count from ${had} to ${weight}` : `${where}adds an entry`;
      violations.push(violation('baseline', path, null, message, path === KNOWN_FAILURES ? undefined : key));
    }
  }
  return { rows, violations };
}

export function testIntegrity({ root: cwd = process.cwd(), base, head = 'HEAD' }) {
  const started = Date.now();
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const baseSha = commitOf(root, base);
  const headSha = commitOf(root, head);
  const mergeBase = git(root, ['merge-base', baseSha, headSha]).trim();
  const diffArgs = ['-M', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', mergeBase, headSha];
  const changed = parseNameStatus(git(root, ['diff', '--name-status', '-z', ...diffArgs]));
  const numstat = parseNumstat(git(root, ['diff', '--numstat', '-z', ...diffArgs]));
  const commits = git(root, ['log', '--format=%h%x00%B%x1e', `${mergeBase}..${headSha}`])
    .split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean)
    .map((record) => record.split('\0'));
  const approvals = commits.flatMap(([commit, body]) => [...body.matchAll(GOLDEN_CHANGE)].map((m) => ({ commit, reason: m[1].trim() })));

  const targets = changed.filter((file) => file.newPath && scanKind(file.newPath));
  const pathspecs = [...new Set(targets.flatMap((file) => [file.oldPath, file.newPath]).filter(Boolean))];
  const patch = pathspecs.length === 0 ? '' : git(root, ['diff', '-U0', '--src-prefix=a/', '--dst-prefix=b/', ...diffArgs,
    '--', ...pathspecs.map((path) => `:(literal)${path}`)]);
  const files = parsePatch(patch).filter((file) => file.newPath && scanKind(file.newPath));

  // Test and config files are read in full on each side with a candidate line; baselines always are.
  const blobSpec = (file, side) => (side === 'removed' ? `${mergeBase}:${file.oldPath}` : `${headSha}:${file.newPath}`);
  const baselines = changed.filter((file) => isBaseline(file.newPath ?? file.oldPath));
  const specs = new Set();
  for (const file of files) {
    if (scanKind(file.newPath) === 'package') continue;
    for (const side of SIDES) {
      if (file.hunks.some((hunk) => hunk[side].some(({ text }) => CANDIDATE.test(text)))) specs.add(blobSpec(file, side));
    }
  }
  for (const file of baselines) {
    if (file.oldPath) specs.add(`${mergeBase}:${file.oldPath}`);
    if (file.newPath) specs.add(`${headSha}:${file.newPath}`);
  }
  const blobs = readBlobs(root, [...specs]);

  const violations = [];
  for (const file of files) {
    const scan = scanFile(file, (side) => {
      const blob = specs.has(blobSpec(file, side)) ? blobs.get(blobSpec(file, side)) : null;
      return typeof blob === 'string' ? codeLinesOf(blob) : null;
    });
    violations.push(...markerViolations({ path: scan.path, ...scan.markers }));
    violations.push(...timingViolations({ path: scan.path, isNew: scan.isNew, ...scan.timings }));
    violations.push(...guardViolations({ path: scan.path, ...scan.guards }));
  }

  // A new golden or snapshot pins new behaviour, as a new test does; only changing or deleting one needs approval.
  const golden = changed.filter((file) => file.status !== 'A' && [file.oldPath, file.newPath].some((path) => path && isGolden(path)))
    .map((file) => ({ status: file.status, file: file.newPath ?? file.oldPath }));
  if (approvals.length === 0) {
    for (const { status, file } of golden) {
      violations.push(violation('golden', file, null, `${status === 'D' ? 'deleted' : 'changed'} without a commit line "Golden-Change: approved <reason>"`));
    }
  }

  const baselineRows = [];
  const renames = new Map(changed.filter((file) => file.status === 'R').map((file) => [file.oldPath, file.newPath]));
  for (const file of baselines) {
    const path = file.newPath ?? file.oldPath;
    const before = file.oldPath ? blobs.get(`${mergeBase}:${file.oldPath}`) : null;
    const after = file.newPath ? blobs.get(`${headSha}:${file.newPath}`) : null;
    const result = compareBaseline(path, before, after, renames);
    baselineRows.push(...result.rows);
    violations.push(...result.violations);
  }

  const testFiles = changed.filter((file) => [file.oldPath, file.newPath].some((path) => path && isTestPath(path)))
    .map((file) => {
      const path = file.newPath ?? file.oldPath;
      const counts = numstat.get(path) ?? { added: null, deleted: null };
      return { status: file.status, file: path, ...(file.status === 'R' || file.status === 'C' ? { from: file.oldPath } : {}), ...counts };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    base, head, baseSha, headSha, mergeBase, commits: commits.length, filesChanged: changed.length,
    violations, golden, goldenApprovals: approvals, baselines: baselineRows, testFiles,
    durationMs: Date.now() - started,
  };
}

export function formatReport(report, { strict = false } = {}) {
  const single = (text) => text.replaceAll('\t', ' ');
  const lines = [`test-integrity ${report.base}..${report.head}: ${report.commits} commit(s), ${report.filesChanged} file(s) `
    + `changed since merge base ${report.mergeBase.slice(0, 8)} (${report.durationMs} ms)`];
  if (report.violations.length === 0) {
    lines.push('violations: none');
  } else {
    lines.push(`violations: ${report.violations.length}${strict ? '' : ' (report mode; --strict exits 1 on these)'}`);
    for (const v of report.violations) {
      const text = v.text ? `: ${single(v.text).slice(0, 120)}` : '';
      lines.push(`  ${v.rule.padEnd(9)}${v.file}${v.line ? `:${v.line}` : ''}  ${v.message}${text}`);
    }
  }
  if (report.golden.length > 0 && report.goldenApprovals.length > 0) {
    const reasons = report.goldenApprovals.map((a) => `${a.commit}: ${a.reason}`).join('; ');
    lines.push(`golden changes approved (${reasons}): ${report.golden.map((g) => g.file).join(', ')}`);
  }
  if (report.baselines.length > 0) {
    lines.push('baselines changed:');
    for (const b of report.baselines) {
      const added = b.added.length === 0 ? ''
        : `  new: ${b.added.slice(0, 3).map(single).join(', ')}${b.added.length > 3 ? ` (+${b.added.length - 3} more)` : ''}`;
      lines.push(`  ${b.file}${b.section ? ` [${b.section}]` : ''}  ${b.before} -> ${b.after}${added}`);
    }
  }
  lines.push(`changed test files: ${report.testFiles.length}`);
  for (const f of report.testFiles) {
    const count = (sign, n) => `${sign}${n ?? '?'}`.padStart(6);
    lines.push(`  ${f.status} ${count('+', f.added)} ${count('-', f.deleted)}  ${f.from ? `${f.from} -> ` : ''}${f.file}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith('-'));
  const refs = argv.filter((arg) => !arg.startsWith('-'));
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (flags.some((flag) => flag !== '--strict' && flag !== '--json') || refs.length < 1 || refs.length > 2) {
    console.error(USAGE);
    return 2;
  }
  const strict = flags.includes('--strict');
  let report;
  try {
    report = testIntegrity({ base: refs[0], head: refs[1] ?? 'HEAD' });
  } catch (error) {
    console.error(`test-integrity: ${error.message}`);
    return 2;
  }
  console.log(flags.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report, { strict }));
  return strict && report.violations.length > 0 ? 1 : 0;
}

// Compare real paths: /home/<user> can be a link to /local/home/<user>, and import.meta.url is resolved.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = main(process.argv.slice(2));
