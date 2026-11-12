import type { PhraseVerb } from './phraseText';
import { NBSP, basename, clip } from './phraseText';

/** A command line without its leading env assignments (`E2E_PORT=1 npm test` → `npm test`). */
export const stripEnv = (command: string) => command.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');

/** A shell command as a base verb + object: `git diff --stat` → list "changed files".
 *  `generic` marks objects that say little ("tests", "the project"): the
 *  agent's own purpose, when it has one, says more. */
export interface CommandPhrase { verb: PhraseVerb; object: string; generic?: boolean }

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** A file or ref as an object, unless it is a shell variable, a glob or a brace list that names nothing. */
const plain = (arg: string | undefined) => (arg && !/[$`*{}]/.test(arg) ? basename(arg) : undefined);
const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

function testsPhrase(args: readonly string[]): CommandPhrase {
  const files = args.filter((a) => TEST_FILE.test(a));
  if (files.length === 1) return { verb: 'run', object: basename(files[0]) };
  return files.length > 1 ? { verb: 'run', object: `${files.length}${NBSP}test files` } : { verb: 'run', object: 'tests', generic: true };
}

/** `git merge` options that take the next word as their value (`-m "msg"`). */
const MERGE_VALUE_OPTION = /^(?:-[mFsX]|--(?:message|file|strategy|strategy-option|into-name))$/;

/**
 * A ref as an object. A shell expansion (`$b`, `"$(…)"`) names nothing and a
 * commit hash means nothing to a reader: both are generic, so the agent's
 * purpose, when stated, says it instead; a hash is cut to 7 characters.
 */
function refPhrase(verb: PhraseVerb, ref: string | undefined, fallback: string, prefix = ''): CommandPhrase {
  if (!ref || /[$`]/.test(ref)) return { verb, object: fallback, generic: true };
  if (/^(?=[a-f]*\d)[0-9a-f]{7,40}$/i.test(ref)) return { verb, object: `${prefix}${ref.slice(0, 7)}`, generic: true };
  return { verb, object: `${prefix}${ref}` };
}

function gitPhrase(args: string[]): CommandPhrase | null {
  while (args.length && /^(?:-C|-c|--git-dir|--work-tree)$/.test(args[0])) args = args.slice(2);
  while (args.length && /^--(?:no-pager|git-dir=|work-tree=)/.test(args[0])) args = args.slice(1);
  const [sub, ...rest] = args;
  const pos = rest.filter((a, i) => !a.startsWith('-') && !(sub === 'merge' && i > 0 && MERGE_VALUE_OPTION.test(rest[i - 1])));
  const flags = rest.filter((a) => a.startsWith('-'));
  const last = pos[pos.length - 1];
  switch (sub) {
    case 'diff':
      return flags.some((f) => /^--(?:stat|name-only|name-status|shortstat|numstat)$/.test(f))
        ? { verb: 'list', object: 'changed files', generic: true }
        : { verb: 'review', object: 'the diff', generic: true };
    case 'log': return { verb: 'view', object: 'recent commits', generic: true };
    case 'show': return { verb: 'view', object: plain(pos[0]) ? `commit ${pos[0].slice(0, 12)}` : 'the last commit', generic: !plain(pos[0]) };
    case 'status': return { verb: 'check', object: 'git status', generic: true };
    case 'fetch': return refPhrase('fetch', pos[0] ?? 'origin', 'changes');
    case 'pull': return refPhrase('pull', last, 'changes');
    case 'merge': return pos[0] ? refPhrase(flags.includes('--ff-only') ? 'fast-forward' : 'merge', pos[0], 'changes') : null;
    case 'rebase': return refPhrase('rebase', pos[0], 'the branch', 'onto ');
    case 'push': return refPhrase('push', pos.length > 1 ? last : undefined, 'changes');
    case 'commit': return { verb: 'commit', object: 'changes' };
    case 'checkout':
    case 'switch': return pos.length ? refPhrase('switch', last, 'branches', 'to ') : null;
    case 'add': return { verb: 'stage', object: (pos.length === 1 && pos[0] !== '.' && plain(pos[0])) || 'changes' };
    case 'stash': return { verb: 'stash', object: 'changes' };
    case 'branch': return flags.some((f) => /^-[dD]$/.test(f)) && pos[0] ? refPhrase('delete', pos[0], 'a branch', 'branch ') : null;
    default: return null;
  }
}

function packagePhrase(args: string[]): CommandPhrase | null {
  let ws: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-w' || a === '--workspace') { ws = args[++i]; continue; }
    if (a.startsWith('--workspace=')) { ws = a.slice(12); continue; }
    if (a === '--') continue;
    if (!a.startsWith('-')) pos.push(a);
  }
  let [sub, ...rest] = pos;
  if (sub === 'run' || sub === 'run-script') [sub, ...rest] = rest;
  const target = ws ? basename(ws) : 'the project';
  const generic = !ws;
  if (!sub) return null;
  if (/^test:e2e/.test(sub)) {
    const spec = rest.find((a) => TEST_FILE.test(a));
    return spec ? { verb: 'run', object: `${basename(spec).replace(TEST_FILE, '')} E2E` } : { verb: 'run', object: 'E2E tests', generic: true };
  }
  if (sub === 'test' || sub === 't' || /^test[:-]/.test(sub)) return testsPhrase(rest);
  if (sub === 'typecheck' || sub === 'tsc') return { verb: 'typecheck', object: target, generic };
  if (sub === 'lint') return { verb: 'lint', object: target, generic };
  if (sub === 'build') return { verb: 'build', object: target, generic };
  if (sub === 'install' || sub === 'i' || sub === 'ci') return { verb: 'install', object: rest.length ? rest.join(' ') : 'dependencies' };
  return null;
}

/** Parentheses and brackets close in order (escapes aside). */
function balanced(p: string): boolean {
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') { i++; continue; }
    if (p[i] === '(' || p[i] === '[') depth++;
    else if (p[i] === ')' || p[i] === ']') { if (--depth < 0) return false; }
  }
  return depth === 0;
}

/** A regex's first alternative at the top level: `a\\|b` and `a|b` → `a`; `^(x|y)` stays whole. */
function firstAlternative(pattern: string): string {
  const group = /^\(((?:\?:)?)(.*)\)$/.exec(pattern);
  if (group && balanced(group[2])) return firstAlternative(group[2]);
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && pattern[i + 1] === '|' && depth === 0) return pattern.slice(0, i);
    if (c === '\\') { i++; continue; }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === '|' && depth === 0) return pattern.slice(0, i);
  }
  return pattern;
}

/**
 * A search pattern as a reader would put it: its first top-level alternative,
 * without quotes, anchors or regex escapes ("^# (tests|pass)" → "# (tests|pass)",
 * "\\.cancel\\(\\)" → ".cancel()", "API_URL\\s*=" → "API_URL =").
 */
export function readablePattern(pattern: string): string {
  const p = firstAlternative(pattern.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .replace(/\\[bB]/g, '')
    .replace(/\\s[*+?]?/g, ' ')
    .replace(/\\([.()[\]{}|\-/"'*+?^$])/g, '$1')
    .replace(/^\^/, '')
    .replace(/(?<!\\)\$$/, '')
    // Quotes the pattern itself carried ('"milestones"'), once its escapes are gone.
    .replace(/^(['"])(.*)\1$/, '$2')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return p || pattern.trim();
}

function segmentPhrase(segment: string): CommandPhrase | null {
  // A quoted argument is one word: `-m "Merge x into dev"` is an option and its value.
  // Words, without redirects (and their targets) or a background `&` / subshell `)`.
  const tokens = segment.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (/^\d*(?:>>?|<)$/.test(w)) { i++; continue; }
    if (/^\d*(?:>>?|<)/.test(w) || /^\d*>&\d*$/.test(w) || /^[&;()]+$/.test(w)) continue;
    words.push(unquote(w.replace(/\)+$/, '')));
  }
  const [cmd, ...args] = words;
  const pos = args.filter((a) => !a.startsWith('-'));
  switch (cmd) {
    case 'git': return gitPhrase(args);
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return packagePhrase(args);
    case 'npx': case 'vitest': case 'jest':
      if (cmd === 'npx' && pos[0] === 'tsc') return { verb: 'typecheck', object: 'the project', generic: true };
      return cmd === 'npx' && !/^(?:vitest|jest|playwright)$/.test(pos[0] ?? '') ? null : testsPhrase(args);
    case 'tsc': return { verb: 'typecheck', object: 'the project', generic: true };
    case 'ls': return { verb: 'list', object: plain(pos[0]) ?? 'files', generic: !plain(pos[0]) };
    case 'cat': case 'head': case 'tail': case 'less': case 'sed': {
      const target = /(?:^|\s)>>?\s*(\S+)/.exec(segment)?.[1];
      if (target && cmd === 'cat') return { verb: 'create', object: basename(unquote(target)) };
      if (cmd === 'sed' && args.some((a) => /^-i/.test(a))) return pos.length > 1 ? { verb: 'edit', object: basename(pos[pos.length - 1]) } : null;
      const file = plain(pos[pos.length - 1]);
      return file && (cmd !== 'sed' || pos.length > 1) ? { verb: 'read', object: file } : null;
    }
    case 'tee': return pos[0] ? { verb: 'create', object: basename(pos[0]) } : null;
    case 'rg': case 'grep': {
      const pattern = pos[0] ? readablePattern(pos[0]) : undefined;
      return pattern ? { verb: 'search', object: `for ${clip(pattern, 40)}` } : null;
    }
    case 'curl': case 'wget': {
      const url = pos.find((a) => /^https?:\/\//.test(a));
      try { return url ? { verb: 'fetch', object: new URL(url).host } : null; } catch { return null; }
    }
    case 'rm': return { verb: 'remove', object: (pos.length === 1 && plain(pos[0])) || 'files', generic: !(pos.length === 1 && plain(pos[0])) };
    case 'mkdir': return pos[0] ? { verb: 'create', object: plain(pos[0]) ?? 'directories', generic: !plain(pos[0]) } : null;
    default: return null;
  }
}

/** The first simple command of a line that says something ("cd x && npm test" → run "tests").
 *  Only a pipeline's first stage counts: `packagebuild … | grep x` filters output, it does not search. */
export function commandPhrase(command: string): CommandPhrase | null {
  for (const segment of commandSegments(command, { pipeHeads: true })) {
    const p = segmentPhrase(segment);
    if (p) return p;
  }
  return null;
}

/** Output filters after a pipe, which do not change what a line did. */
const FILTER = /^(?:tail|head|grep|rg|sed|awk|sort|uniq|wc|cut|tr|jq|less|cat|column|xargs\s+-0?\s*echo)\b/;

/** A command line's program and its plain arguments ("node 02-basics.mjs", "packagebuild vs printpackages"),
 *  stopping at a flag, a quote, a variable or a redirect. */
export function commandHead(command: string): string {
  const first = commandSegments(command).find((s) => !/^(?:cd|for|do|done|while|if|then|fi|\[)\b/.test(s) && /^[\w./@+-]+(?:\s|$)/.test(s) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(s));
  if (!first) return 'a command';
  const words = first.split(/\s+/);
  const plain = [words[0]];
  for (const w of words.slice(1, 3)) { if (!/^[\w./:@+-]+$/.test(w) || w.startsWith('-')) break; plain.push(w); }
  return clip(plain.join(' '), 48);
}

/** One command, give or take `cd x &&`, env assignments, redirects and output filters. */
export function isSimpleCommand(command: string): boolean {
  if (/<<|\bfor\b|\bwhile\b|\bif\b|\$\(/.test(command)) return false;
  const parts = splitShell(command, false)
    .map((p) => ({ ...p, text: stripEnv(p.text.trim()) }))
    .filter((p) => p.text && !/^cd\s/.test(p.text) && !(p.afterPipe && FILTER.test(p.text)));
  return parts.length === 1;
}

/** The part of a command line that says what it does, as typed: `git merge --ff-only 66fac81`, not `MAIN=…; [ … ] &&`. */
export function commandGist(command: string): string {
  const line = stripHeredocs(command).split('\n').map((l) => l.trim()).filter(Boolean).join(' ⏎ ');
  const typed = line
    .replace(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?![$"'`(])\S*\s*;?\s*)|(?:cd\s+\S+\s*(?:&&|;)\s*)|(?:⏎\s*))+/, '')
    // Guards before the work (`[ "$(git rev-parse dev)" = … ] &&`) are not what it does.
    .replace(/^(?:(?:\[\[?|test)\s(?:[^&]|&(?!&))*?\]?\]?\s*&&\s*)+/, '')
    .replace(/\bgit\s+-C\s+\S+\s+/g, 'git ')
    .replace(/\b([0-9a-f]{7})[0-9a-f]{5,33}\b/g, '$1');
  return clip(typed || line, 72);
}

const WRAPPER = /^(?:[({]\s*|(?:sudo|command|time|exec|nohup|nice)\s+|timeout\s+(?:-\S+\s+)*\S+\s+|env(?:\s+-u\s+\S+|\s+-i)*\s+)/;
/** A simple command without what wraps it: env assignments, `sudo`, `nohup`, `timeout 90`, `env -u X`, a subshell's `(`. */
function unwrap(segment: string): string {
  let s = stripEnv(segment.trim());
  for (let next = s.replace(WRAPPER, ''); next !== s; next = s.replace(WRAPPER, '')) s = stripEnv(next);
  return s.trim();
}

/** A command line without its heredoc bodies: `cat > a <<'EOF'` stays, the lines up to EOF go. */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const tag = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(lines[i])?.[1];
    if (!tag) continue;
    while (i + 1 < lines.length && lines[i + 1].trim() !== tag) i++;
    i++;
  }
  return out.join('\n');
}

/** Splits on && || ; | and newlines outside quotes. `pipes` keeps each pipeline whole. */
function splitShell(command: string, pipes: boolean): Array<{ text: string; afterPipe: boolean }> {
  const out: Array<{ text: string; afterPipe: boolean }> = [];
  let cur = ''; let quote: string | null = null; let afterPipe = false;
  const push = (nextAfterPipe: boolean) => { out.push({ text: cur, afterPipe }); cur = ''; afterPipe = nextAfterPipe; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]; const two = command.slice(i, i + 2);
    if (quote) { if (c === '\\' && quote === '"') { cur += c + (command[i + 1] ?? ''); i++; continue; } if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (two === '&&' || two === '||') { push(false); i++; continue; }
    if (c === ';' || c === '\n') { push(false); continue; }
    if (c === '|' && !pipes) { push(true); continue; }
    if (c === '|' && pipes) { out.push({ text: cur, afterPipe }); cur = '\u0000'; afterPipe = true; continue; }
    cur += c;
  }
  push(false);
  // With `pipes`, a stage after `|` was marked by NUL: keep only each pipeline's head.
  return out.filter((p) => !p.text.startsWith('\u0000'));
}

/** A command line's simple commands, with env assignments and wrappers stripped.
 *  `pipeHeads` keeps only each pipeline's first stage, dropping its filters. */
export function commandSegments(command: string, opts: { pipeHeads?: boolean } = {}): string[] {
  const parts = splitShell(stripHeredocs(command), !!opts.pipeHeads).map((p) => p.text);
  return parts
    .map((s) => unwrap(s))
    .filter(Boolean);
}
