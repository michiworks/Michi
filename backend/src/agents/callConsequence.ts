/**
 * What a tool call does to the world (design D19, Q26: Michi asks by
 * consequence, not by whether the turn read outside content). One verdict
 * per call, the same for every runtime that brings the call to Michi's
 * policy (permissionPolicy.ts):
 *
 * - read: reads this machine or Michi's own data; nothing changes;
 * - local: changes this machine or Michi's own state (files, commands,
 *   Pages, a message to another conversation, which has its own gates);
 * - network_read: fetches from outside without sending anything of the
 *   user's (a web page, `git fetch`, `npm install`, a read-only MCP tool);
 * - credential_read: reads secrets (`~/.aws`, `~/.ssh`, `~/.auth`, `.env`,
 *   `gh auth token`);
 * - unclear: Michi cannot tell (`sh -c` it cannot read, inline code that
 *   reaches for the network, another agent CLI, an unknown MCP tool);
 * - egress: leaves the machine: push, merge or comment on a remote,
 *   release, deploy, send a message or email, upload, a write through a
 *   third-party MCP server.
 *
 * Shell commands are judged from their argv (design choice B, 2026-11-12):
 * known egress asks, known local runs, and what cannot be read asks. This
 * is not a sandbox: a script the agent writes and then runs, or a git alias,
 * reads as local. Codex keeps its network-off sandbox underneath.
 */

import { michiBareToolName, michiToolEffect } from '../assistant/toolEffects';

export type CallConsequence = 'read' | 'local' | 'network_read' | 'credential_read' | 'unclear' | 'egress';

export interface CallVerdict {
  consequence: CallConsequence;
  /** Why, in a few words, for the approval card ("git push leaves this machine"). */
  why?: string;
}

/** MCP tool annotations as a runtime or Michi's MCP client reports them. */
export interface CallAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface CallDescription {
  /** The runtime's name for the tool: `Bash`, `mcp__<server>__<tool>`, `@server/tool`, a Michi tool's. */
  toolName: string;
  /** The call's arguments, as the runtime sent them. */
  input?: unknown;
  /** The adapter knows the tool is one of Michi's own (PermissionDecisionRequest.hostTool). */
  hostTool?: boolean;
  /** The call's ACP tool kind (read, edit, execute, fetch, ...), when the runtime gives one. */
  kind?: string;
  annotations?: CallAnnotations;
}

const RANK: Record<CallConsequence, number> = { read: 0, local: 1, network_read: 2, credential_read: 3, unclear: 4, egress: 5 };

const verdict = (consequence: CallConsequence, why?: string): CallVerdict => (why ? { consequence, why } : { consequence });
const READ = verdict('read');
const LOCAL = verdict('local');

/** The stronger of two verdicts (egress over everything, read under everything). */
function worse(a: CallVerdict, b: CallVerdict): CallVerdict {
  return RANK[b.consequence] > RANK[a.consequence] ? b : a;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'execute_bash', 'run_command', 'PowerShell', 'Monitor', 'exec_command']);
const FILE_READ_TOOLS = new Set(['Read', 'read', 'fs_read', 'view_file', 'read_file', 'NotebookRead', 'Glob', 'Grep', 'LS', 'ls',
  'grep', 'find', 'glob', 'list_dir', 'find_by_name', 'grep_search', 'LSP']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit', 'fs_write', 'apply_patch',
  'write_file', 'replace_file_content', 'multi_replace_file_content']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch', 'WebBrowser', 'web_fetch', 'web_search', 'fetch_content', 'fetch']);
/** Runtime built-ins that plan, ask the user, keep a todo list or run a subagent (whose own calls are judged as they come). */
const QUIET_TOOLS = new Set(['TodoWrite', 'todo', 'todo_list', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'thinking', 'think',
  'Task', 'Agent', 'delegate', 'use_subagent', 'subagent', 'summary', 'ToolSearch', 'Skill', 'SlashCommand', 'TaskStop', 'TaskCreate',
  'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'BashOutput', 'KillShell', 'switch_mode']);

/** What a tool call does; the call's input decides for shells, file paths and AWS calls. */
export function callConsequence(call: CallDescription): CallVerdict {
  const name = typeof call.toolName === 'string' ? call.toolName.trim() : '';
  const input = record(call.input);

  const bare = michiBareToolName(name);
  if (bare) {
    const effect = michiToolEffect(bare);
    if (effect === 'command') return shellConsequence(commandOf(input));
    if (effect === 'local_write') return writeConsequence(input);
    if (effect === 'egress') return verdict('egress', `${bare} opens something outside this machine`);
    if (effect === 'outside_read') return verdict('network_read', `${bare} reads from outside`);
    if (effect === 'read' || effect === 'channel') return pathsRead(input);
    return LOCAL;
  }

  if (SHELL_TOOLS.has(name)) return shellConsequence(commandOf(input));
  if (FILE_READ_TOOLS.has(name)) return pathsRead(input);
  if (FILE_WRITE_TOOLS.has(name)) return writeConsequence(input);
  if (WEB_TOOLS.has(name)) return verdict('network_read', 'reads the web');
  if (QUIET_TOOLS.has(name)) return READ;
  if (name === 'use_aws') return awsConsequence([String(input.service_name ?? ''), String(input.operation_name ?? '')]);

  const mcp = mcpToolOf(name);
  if (mcp) return mcpConsequence(mcp.server, mcp.tool, call.annotations, call.kind);

  return kindConsequence(call.kind, input);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The command a shell call runs: a string, or an argv array (Codex), or nothing readable (''). */
function commandOf(input: Record<string, unknown>): string | readonly string[] {
  for (const key of ['command', 'cmd', 'script', 'commandLine']) {
    const value = input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value as string[];
  }
  return '';
}

/** Every path-like string field of a file tool's input, nested operations included. */
function pathsOf(input: unknown, depth = 0): string[] {
  if (depth > 3 || !input || typeof input !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string' && /path|file|dir|notebook/i.test(key)) found.push(value);
    else if (Array.isArray(value)) for (const item of value) {
      if (typeof item === 'string' && /path|file/i.test(key)) found.push(item);
      else found.push(...pathsOf(item, depth + 1));
    } else if (value && typeof value === 'object') found.push(...pathsOf(value, depth + 1));
  }
  return found;
}

function pathsRead(input: Record<string, unknown>): CallVerdict {
  const secret = pathsOf(input).find(isCredentialPath);
  return secret ? verdict('credential_read', `reads ${secret}`) : READ;
}

/** A write to a credential or shell-startup file can grant access or rewrite later commands: Michi cannot tell, so it asks. */
function writeConsequence(input: Record<string, unknown>): CallVerdict {
  const risky = pathsOf(input).find((path) => isCredentialPath(path) || isStartupConfigPath(path));
  return risky ? verdict('unclear', `writes ${risky}`) : LOCAL;
}

function kindConsequence(kind: string | undefined, input: Record<string, unknown>): CallVerdict {
  switch (kind) {
    case 'read': case 'search': return pathsRead(input);
    case 'think': case 'switch_mode': return READ;
    case 'edit': case 'delete': case 'move': return writeConsequence(input);
    case 'fetch': return verdict('network_read', 'reads from outside');
    case 'execute': {
      const command = commandOf(input);
      return command.length > 0 ? shellConsequence(command) : verdict('unclear', 'runs a command Michi cannot read');
    }
    default: return verdict('unclear', 'Michi does not know this tool');
  }
}

// ---------------------------------------------------------------------------
// MCP tools of other servers
// ---------------------------------------------------------------------------

/** `mcp__<server>__<tool>` (Claude, Pi), `@server/tool` (Kiro); Michi's own are judged above. */
function mcpToolOf(name: string): { server: string; tool: string } | null {
  const claude = /^mcp__(.+?)__(.+)$/.exec(name);
  if (claude) return { server: claude[1], tool: claude[2] };
  const acp = /^@([^/\s]+)\/(.+)$/.exec(name);
  return acp ? { server: acp[1], tool: acp[2] } : null;
}

const WRITE_VERBS = new Set(['post', 'send', 'create', 'update', 'delete', 'add', 'remove', 'set', 'put', 'patch', 'edit', 'write',
  'upload', 'publish', 'merge', 'approve', 'comment', 'reply', 'invite', 'share', 'archive', 'move', 'rename', 'schedule', 'submit',
  'run', 'execute', 'exec', 'trigger', 'start', 'stop', 'cancel', 'deploy', 'push', 'react', 'pin', 'unpin', 'mark', 'complete',
  'assign', 'close', 'reopen', 'revert', 'rollback', 'promote', 'release', 'apply', 'insert', 'modify', 'save', 'sync', 'transfer',
  'grant', 'revoke', 'kick', 'leave', 'join', 'subscribe', 'unsubscribe', 'mute', 'unmute', 'restore', 'resolve', 'lock', 'unlock',
  'notify', 'email', 'message', 'invoke', 'call', 'purge', 'clear', 'reset', 'enable', 'disable', 'configure', 'install', 'bulk',
  'draft', 'restart', 'terminate', 'kill', 'tag', 'label', 'vote', 'like', 'follow', 'unfollow', 'block', 'unblock', 'register',
  'delegate', 'checkout']);
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'describe', 'query', 'fetch', 'find', 'view', 'show', 'lookup', 'check',
  'inspect', 'status', 'health', 'count', 'diff', 'explain', 'preview', 'browse', 'retrieve', 'download', 'export', 'scan', 'analyze',
  'summarize', 'resolve_id', 'details', 'info', 'history', 'logs', 'whoami', 'ping', 'validate', 'estimate', 'compare']);

/** A tool name's words: `ReviewAddComment` → review, add, comment; `post_message` → post, message. */
function nameWords(tool: string): string[] {
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
}

/**
 * A third-party MCP tool: its annotations when the runtime or Michi's client
 * knows them (`readOnlyHint` true and not `destructiveHint`: a read, the rule
 * Pages maintenance already uses), else the ACP kind, else its name: a write
 * verb anywhere makes it egress, a read verb a network read, and a name with
 * neither asks. Annotations are the server's own claim; a server that lies
 * about them is not one the user should have installed.
 */
function mcpConsequence(server: string, tool: string, annotations: CallAnnotations | undefined, kind: string | undefined): CallVerdict {
  const label = `${server}/${tool}`;
  if (annotations?.destructiveHint === true) return verdict('egress', `${label} changes something outside`);
  if (annotations?.readOnlyHint === true) return verdict('network_read', `${label} only reads`);
  if (annotations?.readOnlyHint === false) {
    return annotations.openWorldHint === false ? verdict('local', `${label} changes only local state`) : verdict('egress', `${label} changes something outside`);
  }
  if (kind === 'read' || kind === 'search' || kind === 'fetch') return verdict('network_read', `${label} only reads`);
  if (kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'execute') return verdict('egress', `${label} changes something outside`);
  const words = nameWords(tool);
  if (words.some((word) => WRITE_VERBS.has(word))) return verdict('egress', `${label} changes something outside`);
  if (words.some((word) => READ_VERBS.has(word))) return verdict('network_read', `${label} only reads`);
  return verdict('egress', `Michi cannot tell what ${label} changes`);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CREDENTIAL_PATHS: readonly RegExp[] = [
  /(^|\/)\.(aws|ssh|auth|gnupg|password-store)(\/|$)/,
  /(^|\/)\.(netrc|git-credentials|npmrc|pypirc|pgpass|my\.cnf|vault-token)$/,
  /(^|\/)\.kube\/config$/, /(^|\/)\.docker\/config\.json$/, /(^|\/)\.config\/gh\/hosts\.ya?ml$/,
  /(^|\/)\.config\/(gcloud|op|hub)(\/|$)/,
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /\/(credentials|secrets?)(\.[A-Za-z]+)?$/i, /^(credentials|secrets?)\.[A-Za-z]+$/i,
  /^\/proc\/[^/]+\/environ$/, /^\/etc\/(shadow|gshadow|sudoers)$/,
];

/** A path that holds secrets: credential stores, keys, `.env` files. */
export function isCredentialPath(path: string): boolean {
  const value = path.trim().replace(/^['"]|['"]$/g, '');
  return value.length > 0 && CREDENTIAL_PATHS.some((pattern) => pattern.test(value));
}

/** Files every later command or login reads: a write there changes what runs next, outside the task. */
function isStartupConfigPath(path: string): boolean {
  return /(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|zshenv|profile|gitconfig|ssh\/authorized_keys|ssh\/config)$/.test(path.trim())
    || /(^|\/)\.config\/(git\/config|fish\/config\.fish)$/.test(path.trim());
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

interface Segment {
  words: string[];
  /** Redirection targets: `> out`, `< in`. */
  redirects: string[];
  /** A word of it came from `$(…)`, backticks or a `$VAR` expansion. */
  expands: boolean;
  /** Heredoc bodies fed to it. */
  heredocs: string[];
}

interface Parsed { segments: Segment[]; inner: Parsed[]; unreadable: boolean }

const MAX_DEPTH = 6;

/**
 * Splits a command line into simple commands: words with quotes removed,
 * split on `; && || | & newline`, redirections and heredocs set aside, and
 * the commands inside `$(…)` and backticks parsed too. Unbalanced quotes or
 * substitutions make it unreadable.
 */
function parseShell(text: string, depth = 0): Parsed {
  const result: Parsed = { segments: [], inner: [], unreadable: depth > MAX_DEPTH };
  if (result.unreadable) return result;
  let segment: Segment = { words: [], redirects: [], expands: false, heredocs: [] };
  let word = '';
  let inWord = false;
  let redirectNext = false;
  const pendingHeredocs: Array<{ delimiter: string; strip: boolean; segment: Segment }> = [];

  const endWord = () => {
    if (!inWord) return;
    if (redirectNext) {
      segment.redirects.push(word);
      redirectNext = false;
    } else segment.words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (segment.words.length > 0 || segment.redirects.length > 0) result.segments.push(segment);
    segment = { words: [], redirects: [], expands: false, heredocs: [] };
  };
  const substitution = (start: number, open: string, close: string): number => {
    let level = 1;
    let index = start;
    let quote: string | null = null;
    while (index < text.length) {
      const char = text[index];
      if (quote) {
        if (char === '\\' && quote === '"') index += 1;
        else if (char === quote) quote = null;
      } else if (char === '\\') index += 1;
      else if (char === "'" || char === '"') quote = char;
      else if (char === open && open !== close) level += 1;
      else if (char === close && (level -= 1) === 0) return index;
      index += 1;
    }
    return -1;
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }
      word += text[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) { result.unreadable = true; break; }
      word += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\') { word += text[j + 1] ?? ''; j += 2; continue; }
        if (c === '"') { closed = true; break; }
        if (c === '`' || (c === '$' && text[j + 1] === '(')) {
          const open = c === '`' ? j + 1 : j + 2;
          const end = c === '`' ? text.indexOf('`', open) : substitution(open, '(', ')');
          if (end < 0) { result.unreadable = true; break; }
          result.inner.push(parseShell(text.slice(open, end), depth + 1));
          segment.expands = true;
          word += '$(…)';
          j = end + 1;
          continue;
        }
        if (c === '$' && /[A-Za-z_{@*#?0-9!-]/.test(text[j + 1] ?? '')) segment.expands = true;
        word += c;
        j += 1;
      }
      if (!closed) { result.unreadable = true; break; }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (char === '`' || (char === '$' && text[i + 1] === '(')) {
      const open = char === '`' ? i + 1 : i + 2;
      const end = char === '`' ? text.indexOf('`', open) : substitution(open, '(', ')');
      if (end < 0) { result.unreadable = true; break; }
      result.inner.push(parseShell(text.slice(open, end), depth + 1));
      segment.expands = true;
      word += '$(…)';
      inWord = true;
      i = end + 1;
      continue;
    }
    if (char === '$' && /[A-Za-z_{@*#?0-9!-]/.test(text[i + 1] ?? '')) segment.expands = true;
    if ((char === '<' || char === '>') && text[i + 1] === '(') {
      // Process substitution: its commands run too.
      const end = substitution(i + 2, '(', ')');
      if (end < 0) { result.unreadable = true; break; }
      result.inner.push(parseShell(text.slice(i + 2, end), depth + 1));
      segment.expands = true;
      i = end + 1;
      continue;
    }
    if (char === '#' && !inWord) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (char === '\n') {
      endSegment();
      i += 1;
      for (const pending of pendingHeredocs.splice(0)) {
        const lines: string[] = [];
        while (i < text.length) {
          const next = text.indexOf('\n', i);
          const line = text.slice(i, next < 0 ? text.length : next);
          i = next < 0 ? text.length : next + 1;
          if ((pending.strip ? line.replace(/^\t+/, '') : line) === pending.delimiter) break;
          lines.push(line);
        }
        pending.segment.heredocs.push(lines.join('\n'));
      }
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')' || char === '{' && !inWord || char === '}' && !inWord) {
      if (char === '&' && text[i + 1] === '>') {
        endWord();
        redirectNext = true;
        i += text[i + 2] === '>' ? 3 : 2;
        continue;
      }
      if (char === '&' && i > 0 && text[i - 1] === '>') { i += 1; continue; }
      endSegment();
      i += 1;
      continue;
    }
    if (char === '<' || char === '>') {
      if (char === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
        // Heredoc: its body starts on the next line.
        endWord();
        let j = i + 2;
        const strip = text[j] === '-';
        if (strip) j += 1;
        while (text[j] === ' ' || text[j] === '\t') j += 1;
        const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(text.slice(j));
        if (!match) { result.unreadable = true; break; }
        pendingHeredocs.push({ delimiter: match[2], strip, segment });
        i = j + match[0].length;
        continue;
      }
      // A file descriptor number before the operator (2>) belongs to it.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
      let j = i + 1;
      while (text[j] === '>' || text[j] === '<' || text[j] === '&' || text[j] === '|') j += 1;
      // `>&2`, `2>&1`: a descriptor, not a file.
      if (text[j - 1] === '&' && /\d/.test(text[j] ?? '')) { i = j + 1; continue; }
      redirectNext = true;
      i = j;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      i += 1;
      continue;
    }
    word += char;
    inWord = true;
    i += 1;
  }
  endSegment();
  if (pendingHeredocs.length > 0) {
    // A heredoc whose body never came: its words are not commands of this line.
    for (const pending of pendingHeredocs) pending.segment.heredocs.push('');
  }
  return result;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrappers that run the command after them; the value is how many leading flags with values they take (rough). */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'command', 'builtin', 'exec',
  'xargs', 'watch', 'caffeinate', 'chronic', 'unbuffer', 'setsid', 'flock', 'strace', 'ltrace', 'firejail', 'chroot',
  'systemd-run', 'proxychains', 'proxychains4', 'torsocks', 'aws-vault', 'with-proxy']);
/** Flags of a wrapper that take a value (so the value is not the command). */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']), ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a']),
  watch: new Set(['-n', '-d']), flock: new Set(['-w', '-E']), stdbuf: new Set(['-i', '-o', '-e']),
};
/** A wrapper's positional operands before the command (timeout's duration, flock's lock file, chroot's root, aws-vault exec's profile). */
const WRAPPER_OPERANDS: Readonly<Record<string, number>> = { timeout: 1, flock: 1, chroot: 1 };

/** The argv a segment runs: assignments and wrappers stripped. */
function commandWords(words: readonly string[]): string[] {
  let rest = [...words];
  for (let guard = 0; guard < 10; guard += 1) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    if (rest.length === 0) return rest;
    const head = baseName(rest[0]);
    if (!WRAPPERS.has(head)) return rest;
    const wrapper = rest[0];
    rest = rest.slice(1);
    if (head === 'aws-vault' && rest[0] === 'exec') {
      rest = rest.slice(2);
      if (rest[0] === '--') rest = rest.slice(1);
      continue;
    }
    const valued = WRAPPER_VALUE_FLAGS[head];
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const flag = rest[0];
      rest = rest.slice(1);
      if (flag === '--') break;
      if (valued?.has(flag) && rest.length > 0) rest = rest.slice(1);
    }
    for (let skip = WRAPPER_OPERANDS[head] ?? 0; skip > 0 && rest.length > 0; skip -= 1) rest = rest.slice(1);
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    // A wrapper with nothing to run is the command itself (`env` prints the environment).
    if (rest.length === 0) return [wrapper];
  }
  return rest;
}

function baseName(word: string): string {
  const slash = word.lastIndexOf('/');
  return (slash >= 0 ? word.slice(slash + 1) : word).toLowerCase();
}

/** Words that name a release step, in a make target, an npm script or a script's file name. */
const EGRESS_WORD = /(^|[-_:./])(deploy|release|publish|push|upload|ship|promote|rollout|submit)([-_:./]|$)/i;

const NETWORK_CODE = /https?:\/\/|urllib|requests\b|\bhttpx?\b|http\.client|fetch\s*\(|XMLHttpRequest|axios|socket|websocket|smtplib|ftplib|paramiko|boto3?|botocore|aws-sdk|@aws-sdk|net\/http|Net::HTTP|LWP::|open-uri|child_process|subprocess|os\.system|os\.popen|\bexecSync\b|\bspawn\b|\bexec\s*\(|curl|wget|Deno\.connect|node:net|node:https?|require\(['"]https?['"]\)/;

const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'deno', 'bun', 'lua', 'rscript',
  'osascript', 'pwsh', 'powershell', 'tclsh', 'jshell', 'groovy', 'kotlinc', 'scala']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'csh', 'tcsh']);
const AGENT_CLIS = new Set(['claude', 'codex', 'kiro-cli', 'kiro', 'q', 'gemini', 'aider', 'cursor-agent', 'opencode', 'goose', 'amp',
  'kirocrew', 'crew']);
const MAILERS = new Set(['mail', 'mailx', 'sendmail', 'mutt', 'msmtp', 'swaks', 'ssmtp', 'neomutt']);
const RAW_NET = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'mosh', 'ftp', 'lftp', 'tftp', 'smbclient',
  'autossh', 'sshpass', 'websocat', 'wscat', 'grpcurl']);
const DNS_TOOLS = new Set(['dig', 'nslookup', 'host', 'ping', 'ping6', 'traceroute', 'mtr', 'whois']);

/** Michi's verdict on one simple command (argv after wrappers). */
function argvConsequence(argv: readonly string[], segment: Segment, depth: number): CallVerdict {
  if (argv.length === 0) return segment.redirects.some(isCredentialPath) ? verdict('credential_read', 'reads a secret file') : LOCAL;
  const cmd = baseName(argv[0]);
  const args = argv.slice(1);
  const sub = firstOperand(args);

  if (SHELLS.has(cmd)) return shellInvocation(args, segment, depth);
  if (cmd === 'eval') return shellConsequence(args.join(' '), depth + 1);
  if (cmd === 'source' || cmd === '.') return LOCAL;
  if (INTERPRETERS.has(cmd) || /^python\d(\.\d+)?$/.test(cmd)) return interpreterInvocation(cmd, args, segment);
  if (AGENT_CLIS.has(cmd)) return verdict('unclear', `${cmd} runs another agent`);
  if (MAILERS.has(cmd)) return verdict('egress', `${cmd} sends email`);
  if (RAW_NET.has(cmd)) return verdict('egress', `${cmd} connects to another machine`);
  if (DNS_TOOLS.has(cmd)) return segment.expands ? verdict('egress', `${cmd} with expanded arguments can carry data out`) : verdict('network_read', `${cmd} reaches the network`);

  switch (cmd) {
    case 'git': return gitConsequence(args);
    case 'gh': return ghConsequence(args);
    case 'glab': return glabConsequence(args);
    case 'curl': return curlConsequence(args, segment);
    case 'wget': return args.some((arg) => /^--(post-data|post-file|body-data|body-file|method)(=|$)/.test(arg))
      ? verdict('egress', 'wget sends data') : segment.expands ? verdict('egress', 'wget with expanded arguments can carry data out') : verdict('network_read', 'wget downloads');
    case 'http': case 'https': case 'xh': case 'xhs': case 'httpie': return httpieConsequence(args, segment);
    case 'rsync': return args.some((arg) => /^[^/\s]+:|^rsync:\/\//.test(arg)) ? verdict('egress', 'rsync copies to or from another machine') : LOCAL;
    case 'rclone': return ['ls', 'lsd', 'lsl', 'lsf', 'cat', 'size', 'about', 'version', 'config', 'listremotes', 'check'].includes(sub)
      ? verdict('network_read', 'rclone reads a remote') : verdict('egress', 'rclone writes to a remote');
    case 's3cmd': return ['ls', 'la', 'get', 'info', 'du'].includes(sub) ? verdict('network_read', 's3cmd reads S3') : verdict('egress', 's3cmd writes to S3');
    case 'gsutil': return ['ls', 'cat', 'du', 'stat', 'version', 'help'].includes(sub) || (sub === 'cp' && !lastOperand(args).startsWith('gs://'))
      ? verdict('network_read', 'gsutil reads Cloud Storage') : verdict('egress', 'gsutil writes to Cloud Storage');
    case 'aws': return awsConsequence(args);
    case 'kinit': case 'klist': return verdict('credential_read', `${cmd} handles credentials`);
    case 'security': return /^find-.*password$|^dump-keychain$|^export$/.test(sub) ? verdict('credential_read', 'reads the keychain') : LOCAL;
    case 'printenv': return verdict('credential_read', 'prints the environment, which can hold secrets');
    case 'env': return args.filter((arg) => !arg.startsWith('-') && !ASSIGNMENT.test(arg)).length === 0
      ? verdict('credential_read', 'prints the environment, which can hold secrets') : LOCAL;
    case 'export': case 'set': case 'declare': case 'typeset':
      return args.length === 0 || (cmd !== 'set' && args.every((arg) => /^-[px]+$/.test(arg)))
        ? verdict('credential_read', 'prints the environment, which can hold secrets') : LOCAL;
    case 'op': return ['read', 'inject', 'item', 'document'].includes(sub) ? verdict('credential_read', '1Password reads a secret') : verdict('network_read', 'op reads 1Password');
    case 'pass': case 'gopass': return verdict('credential_read', `${cmd} reads a secret`);
    case 'vault': return ['read', 'kv', 'login', 'token'].includes(sub) ? verdict('credential_read', 'vault reads a secret') : verdict('egress', 'vault writes a secret');
    case 'gcloud': case 'az': return cloudCliConsequence(cmd, args);
    case 'kubectl': case 'oc': case 'k': return kubectlConsequence(cmd, args);
    case 'helm': return ['list', 'ls', 'status', 'get', 'show', 'template', 'search', 'history', 'version', 'lint', 'env', 'dependency', 'repo'].includes(sub)
      ? verdict('network_read', 'helm reads') : verdict('egress', `helm ${sub} changes a cluster`);
    case 'terraform': case 'tofu': case 'terragrunt': return terraformConsequence(cmd, args);
    case 'pulumi': return ['preview', 'whoami', 'version', 'logs', 'about', 'config', 'stack'].includes(sub) && !args.includes('rm')
      ? verdict('network_read', 'pulumi reads') : verdict('egress', `pulumi ${sub} changes cloud resources`);
    case 'cdk': return ['synth', 'synthesize', 'diff', 'ls', 'list', 'doctor', 'context', 'version', 'notices', 'docs', 'init', 'acknowledge'].includes(sub)
      ? verdict('network_read', 'cdk reads') : verdict('egress', `cdk ${sub} deploys`);
    case 'sam': return ['build', 'validate', 'local', 'init', 'list', 'logs', 'traces'].includes(sub)
      ? verdict('network_read', 'sam builds or reads') : verdict('egress', `sam ${sub} deploys`);
    case 'serverless': case 'sls': return ['deploy', 'remove', 'rollback'].includes(sub) ? verdict('egress', `${cmd} ${sub} deploys`) : verdict('network_read', `${cmd} reads`);
    case 'docker': case 'podman': case 'nerdctl': case 'finch': return dockerConsequence(cmd, args);
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return packageManagerConsequence(cmd, args);
    case 'npx': case 'pnpx': case 'bunx': case 'uvx':
      if (args.some((arg) => EGRESS_WORD.test(arg) || /^(vercel|netlify|wrangler|firebase|surge|gh-pages)$/.test(arg))) return verdict('egress', `${cmd} runs a release command`);
      // A project's own bin (npx vitest) runs locally; asking for a package downloads it.
      return cmd === 'uvx' || args.some((arg) => /^(-y|--yes|-p|--package)(=|$)/.test(arg)) ? verdict('network_read', `${cmd} downloads and runs a package`) : LOCAL;
    case 'pip': case 'pip3': case 'pipx': case 'uv': case 'poetry': case 'pdm': case 'conda': case 'mamba': case 'hatch': case 'rye':
      return args.some((arg) => ['publish', 'upload'].includes(arg)) ? verdict('egress', `${cmd} publishes a package`) : verdict('network_read', `${cmd} may download`);
    case 'twine': return sub === 'upload' || sub === 'register' ? verdict('egress', 'twine uploads a package') : LOCAL;
    case 'cargo': return ['publish', 'yank', 'owner', 'login', 'logout'].includes(sub) ? verdict('egress', `cargo ${sub} talks to the registry`) : verdict('network_read', 'cargo may download crates');
    case 'gem': return ['push', 'yank', 'owner', 'signin', 'signout'].includes(sub) ? verdict('egress', `gem ${sub} talks to the registry`) : verdict('network_read', 'gem may download');
    case 'mvn': case 'mvnw': return args.some((arg) => /^(deploy|release:|site-deploy|deploy:)/.test(arg)) ? verdict('egress', 'mvn deploys') : verdict('network_read', 'mvn may download');
    case 'gradle': case 'gradlew': return args.some((arg) => /publish|upload|release|deploy/i.test(arg)) ? verdict('egress', 'gradle publishes') : verdict('network_read', 'gradle may download');
    case 'go': return ['get', 'install', 'mod', 'build', 'run', 'test'].includes(sub) ? verdict('network_read', 'go may download modules') : LOCAL;
    case 'brew': case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'pacman': case 'apk': case 'snap': case 'port':
      return verdict('network_read', `${cmd} downloads packages`);
    case 'bazel': case 'buck': case 'buck2':
      return args.some((arg) => /^(push|publish|deploy)$/.test(arg) || /snapshot\s+push/.test(arg)) ? verdict('egress', `${cmd} publishes`) : verdict('network_read', `${cmd} may download`);
    case 'toolbox': return ['install', 'update', 'upgrade', 'uninstall', 'rollback', 'clean', 'registry'].includes(sub)
      ? verdict('unclear', `toolbox ${sub} changes installed tools`) : READ;
    case 'open': case 'xdg-open': case 'gio': case 'start': case 'explorer.exe': case 'wslview':
      return args.some((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && !/^file:/i.test(arg)) ? verdict('egress', `${cmd} opens a URL`) : LOCAL;
    case 'crontab': return args.includes('-l') ? READ : verdict('unclear', 'crontab changes what runs later');
    case 'rm': case 'shred': case 'chmod': case 'chown': case 'chgrp': {
      // Undoable work stays in the conversation's folder; a recursive change outside it is not that.
      const recursive = cmd === 'shred' || args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
      const outside = args.filter((arg) => !arg.startsWith('-')).find((arg) => /^(~|\$HOME|\$\{HOME\})(\/|$)|^\/(?!tmp\/)/.test(arg) || /(^|\/)\.\.(\/|$)/.test(arg));
      return recursive && outside ? verdict('unclear', `${cmd} changes ${outside}, outside the working folder`) : LOCAL;
    }
    case 'dd': case 'mkfs': case 'fdisk': case 'parted': case 'diskutil': return verdict('unclear', `${cmd} writes to a disk`);
    case 'systemctl': case 'launchctl':
      return /^(status|is-active|is-enabled|is-failed|list|list-units|list-unit-files|list-timers|show|cat|print|blame)$/.test(sub) ? READ : verdict('unclear', `${cmd} changes what runs later`);
    case 'at': case 'batch': return verdict('unclear', `${cmd} changes what runs later`);
    case 'make': case 'gmake': case 'just': case 'task': case 'rake': case 'invoke': case 'nx': case 'turbo': case 'gulp': case 'grunt': case 'mage':
      return args.some((arg) => !arg.startsWith('-') && EGRESS_WORD.test(arg)) ? verdict('egress', `${cmd} runs a release target`) : LOCAL;
    default:
      break;
  }
  // A script that names a release step (./deploy.sh, scripts/release).
  if (argv[0].includes('/') && EGRESS_WORD.test(baseName(argv[0]).replace(/\.(sh|bash|py|js|ts|rb)$/, ''))) {
    return verdict('egress', `${baseName(argv[0])} looks like a release script`);
  }
  return LOCAL;
}

/** The first argument that is not a flag. */
function firstOperand(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith('-')) ?? '';
}

function lastOperand(args: readonly string[]): string {
  const operands = args.filter((arg) => !arg.startsWith('-'));
  return operands[operands.length - 1] ?? '';
}

function shellInvocation(args: readonly string[], segment: Segment, depth: number): CallVerdict {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c' || (/^-[a-z]*c[a-z]*$/.test(arg) && !arg.startsWith('--'))) {
      const script = args[index + 1];
      if (typeof script !== 'string') return verdict('unclear', 'a shell with no script');
      // A script that comes from an expansion is one Michi cannot see.
      if (segment.expands && /\$/.test(script)) return verdict('unclear', 'a shell runs a script Michi cannot see');
      return shellConsequence(script, depth + 1);
    }
    if (!arg.startsWith('-')) {
      // A script file: its contents are not judged; a release-sounding name is.
      return EGRESS_WORD.test(baseName(arg).replace(/\.(sh|bash|zsh)$/, '')) ? verdict('egress', `${baseName(arg)} looks like a release script`) : LOCAL;
    }
  }
  if (segment.heredocs.length > 0) return segment.heredocs.reduce((acc, body) => worse(acc, shellConsequence(body, depth + 1)), LOCAL);
  // An interactive shell, or one reading commands from a pipe Michi cannot see.
  return verdict('unclear', 'a shell reads commands Michi cannot see');
}

function interpreterInvocation(cmd: string, args: readonly string[], segment: Segment): CallVerdict {
  const inlineFlags = new Set(['-c', '-e', '--eval', '-p', '--print', '-r', '-E', '-command', '-Command']);
  const codeParts: string[] = [];
  let script: string | null = null;
  let stdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (inlineFlags.has(arg)) { codeParts.push(args[index + 1] ?? ''); index += 1; continue; }
    if (arg === '-m') {
      const moduleName = args[index + 1] ?? '';
      if (/^(http\.server|SimpleHTTPServer|smtpd|aiosmtpd|ftplib)$/.test(moduleName)) return verdict('egress', `python -m ${moduleName} serves to other machines`);
      if (/^(twine)$/.test(moduleName) && args.includes('upload')) return verdict('egress', 'twine uploads a package');
      if (/^(pip|ensurepip|venv)$/.test(moduleName)) return verdict('network_read', `python -m ${moduleName} may download`);
      return LOCAL;
    }
    if (arg === '-') { stdin = true; continue; }
    if (cmd === 'deno' && arg === 'deploy') return verdict('egress', 'deno deploy deploys');
    if (cmd === 'bun' || cmd === 'deno') {
      if (['run', 'x', 'eval'].includes(arg)) continue;
      if (['install', 'add', 'i', 'update', 'upgrade'].includes(arg)) return verdict('network_read', `${cmd} ${arg} downloads`);
      if (arg === 'publish') return verdict('egress', `${cmd} publishes`);
    }
    if (!arg.startsWith('-') && script === null) { script = arg; break; }
  }
  if (codeParts.length === 0 && (stdin || script === null) && segment.heredocs.length > 0) codeParts.push(...segment.heredocs);
  if (codeParts.length > 0) {
    const code = codeParts.join('\n');
    return NETWORK_CODE.test(code) ? verdict('unclear', `${cmd} inline code reaches for the network or runs commands`) : LOCAL;
  }
  if (script !== null) {
    return EGRESS_WORD.test(baseName(script).replace(/\.[a-z]+$/, '')) ? verdict('egress', `${baseName(script)} looks like a release script`) : LOCAL;
  }
  // A REPL, or code from a pipe Michi cannot see.
  return verdict('unclear', `${cmd} reads code Michi cannot see`);
}

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const GIT_LOCAL = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'reset',
  'stash', 'restore', 'rm', 'mv', 'tag', 'cherry-pick', 'revert', 'worktree', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'describe', 'reflog', 'clean', 'init', 'apply', 'am', 'format-patch', 'shortlog', 'notes', 'bisect', 'sparse-checkout',
  'gc', 'fsck', 'prune', 'archive', 'cat-file', 'show-ref', 'symbolic-ref', 'update-ref', 'update-index', 'merge-base', 'name-rev',
  'range-diff', 'whatchanged', 'check-ignore', 'check-attr', 'difftool', 'mergetool', 'var', 'help', 'version', 'config', 'remote',
  'stage', 'citool', 'gui', 'maintenance', 'repack', 'count-objects', 'for-each-ref', 'hash-object', 'write-tree', 'read-tree',
  'commit-tree', 'mktree', 'diff-tree', 'diff-index', 'diff-files', 'ls-remote-local', 'submodule', 'lfs', 'annotate', 'show-branch',
  'interpret-trailers', 'mailinfo', 'mailsplit', 'patch-id', 'restore', 'verify-commit', 'verify-tag', 'rerere', 'bundle']);
const GIT_FETCH = new Set(['fetch', 'pull', 'clone', 'ls-remote']);
const DEFAULT_BRANCHES = /^(refs\/heads\/)?(main|mainline|master|dev|develop|trunk)$/;
const DEFAULT_REFSPEC = /:(refs\/heads\/)?(main|mainline|master|dev|develop|trunk)$/;

/** git: push and send-email leave; fetching is a network read; moving the default branch is a merge into it and asks. */
function gitConsequence(args: readonly string[]): CallVerdict {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index];
    if (flag === '-c' && /^alias\./i.test(args[index + 1] ?? '')) return verdict('unclear', 'git with an inline alias');
    index += GIT_VALUE_FLAGS.has(flag) ? 2 : 1;
  }
  const sub = args[index] ?? '';
  const rest = args.slice(index + 1);
  if (!sub) return READ;
  if (sub === 'push' || sub === 'send-email' || sub === 'request-pull' || sub === 'svn' && rest[0] === 'dcommit' || sub === 'p4' && rest[0] === 'submit') {
    return verdict('egress', `git ${sub} leaves this machine`);
  }
  if (GIT_FETCH.has(sub) && !(sub === 'fetch' && rest.some((arg) => DEFAULT_REFSPEC.test(arg)))) return verdict('network_read', `git ${sub} downloads`);
  if (sub === 'remote' && ['update', 'prune', 'show'].includes(rest[0] ?? '') || sub === 'submodule' && ['update', 'sync', 'foreach'].includes(rest[0] ?? '')) {
    return verdict('network_read', `git ${sub} ${rest[0]} reaches a remote`);
  }
  if (sub === 'lfs' && ['push'].includes(rest[0] ?? '')) return verdict('egress', 'git lfs push leaves this machine');
  if (sub === 'lfs' && ['pull', 'fetch'].includes(rest[0] ?? '')) return verdict('network_read', `git lfs ${rest[0]} downloads`);
  if (sub === 'config' && rest.some((arg) => /^alias\./i.test(arg) || /^(remote\.|url\.|credential\.|core\.sshCommand|core\.hooksPath)/i.test(arg)) && !rest.includes('--get')) {
    return verdict('unclear', 'git config changes what later git commands do');
  }
  if (sub === 'credential') return verdict('credential_read', 'git credential reads secrets');
  // Moving the user's default branch is merging into it (design D18: merges wait for the user). Merges and resets act on
  // the current branch, which in a work conversation's worktree is its own; switching to the default branch, forcing it
  // or writing its ref is how work lands there.
  const operands = rest.filter((arg) => !arg.startsWith('-'));
  if ((sub === 'checkout' || sub === 'switch') && !rest.includes('--') && !rest.some((arg) => /^-[bBcC]$|^--(orphan|create|force-create)$/.test(arg))
    && DEFAULT_BRANCHES.test(operands[0] ?? '')) {
    return verdict('egress', `git ${sub} ${operands[0]} moves work onto the default branch`);
  }
  if (sub === 'branch' && rest.some((arg) => /^(-f|--force|-M|-m|-D|-d|--delete|--move)$/.test(arg)) && operands.some((arg) => DEFAULT_BRANCHES.test(arg))
    || sub === 'update-ref' && operands.some((arg) => DEFAULT_BRANCHES.test(arg))
    || sub === 'fetch' && operands.some((arg) => DEFAULT_REFSPEC.test(arg))) {
    return verdict('egress', `git ${sub} rewrites the default branch`);
  }
  if (GIT_LOCAL.has(sub)) return LOCAL;
  // An alias or an extension Michi does not know (git-foo).
  return verdict('unclear', `git ${sub} is not a command Michi knows`);
}

function ghConsequence(args: readonly string[]): CallVerdict {
  const [group = '', action = ''] = args.filter((arg) => !arg.startsWith('-'));
  if (group === 'api') {
    const writes = args.some((arg, index) => (/^(-X|--method)$/.test(arg) && !/^(GET|HEAD)$/i.test(args[index + 1] ?? ''))
      || /^--method=(?!GET|HEAD)/i.test(arg) || /^-X(?!GET|HEAD)\w+/.test(arg)
      || /^(-f|-F|--field|--raw-field|--input)$/.test(arg) || /^--(field|raw-field|input)=/.test(arg));
    return writes ? verdict('egress', 'gh api writes to GitHub') : verdict('network_read', 'gh api reads GitHub');
  }
  if (group === 'auth') return action === 'token' || args.includes('--show-token') ? verdict('credential_read', 'gh auth prints a token') : verdict('unclear', 'gh auth changes credentials');
  const reads = new Set(['view', 'list', 'ls', 'diff', 'checks', 'status', 'watch', 'download', 'search', 'browse', 'verify']);
  if (['pr', 'issue', 'release', 'repo', 'run', 'workflow', 'gist', 'label', 'project', 'secret', 'variable', 'cache', 'ruleset', 'codespace', 'org'].includes(group)) {
    if (group === 'repo' && action === 'clone' || group === 'pr' && action === 'checkout' || group === 'repo' && action === 'sync' && !args.includes('--source')) {
      return verdict('network_read', `gh ${group} ${action} downloads`);
    }
    if (group === 'secret' || group === 'variable') return action === 'list' ? verdict('network_read', `gh ${group} list reads`) : verdict('egress', `gh ${group} ${action} changes GitHub`);
    return reads.has(action) ? verdict('network_read', `gh ${group} ${action} reads GitHub`) : verdict('egress', `gh ${group} ${action} changes GitHub`);
  }
  if (group === 'search' || group === 'status' || group === 'browse' || group === 'help' || group === 'version' || group === '') return verdict('network_read', 'gh reads GitHub');
  return verdict('unclear', `gh ${group} is not a command Michi knows`);
}

function glabConsequence(args: readonly string[]): CallVerdict {
  const [group = '', action = ''] = args.filter((arg) => !arg.startsWith('-'));
  if (group === 'api') return args.some((arg) => /^(-X|--method)$/.test(arg) || /^(-f|-F|--field|--raw-field)$/.test(arg)) ? verdict('egress', 'glab api writes') : verdict('network_read', 'glab api reads');
  return ['view', 'list', 'ls', 'diff', 'status', 'checkout', 'clone', 'ci-view', 'trace'].includes(action) || group === 'status'
    ? verdict('network_read', `glab ${group} ${action} reads`) : verdict('egress', `glab ${group} ${action} changes GitLab`);
}

function curlConsequence(args: readonly string[], segment: Segment): CallVerdict {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^--(data|data-binary|data-ascii|data-raw|data-urlencode|form|form-string|upload-file|json|post301|post302|post303)(=|$)/.test(arg)) return verdict('egress', 'curl sends data');
    if (/^--(request|method)(=|$)/.test(arg)) {
      const method = arg.includes('=') ? arg.split('=')[1] : args[index + 1] ?? '';
      if (!/^(GET|HEAD|OPTIONS)$/i.test(method)) return verdict('egress', `curl sends a ${method || 'non-GET'} request`);
    }
    if (arg === '--config' || arg === '-K') return verdict('unclear', 'curl reads its options from a file');
    if (/^-[A-Za-z]+/.test(arg) && !arg.startsWith('--')) {
      const cluster = arg.slice(1);
      if (/[dFT]/.test(cluster)) return verdict('egress', 'curl sends data');
      const x = cluster.indexOf('X');
      if (x >= 0) {
        const method = cluster.slice(x + 1) || args[index + 1] || '';
        if (!/^(GET|HEAD|OPTIONS)$/i.test(method)) return verdict('egress', `curl sends a ${method || 'non-GET'} request`);
      }
      if (cluster.includes('K')) return verdict('unclear', 'curl reads its options from a file');
    }
  }
  if (segment.expands) return verdict('egress', 'curl with expanded arguments can carry data out');
  return verdict('network_read', 'curl downloads');
}

function httpieConsequence(args: readonly string[], segment: Segment): CallVerdict {
  if (args.some((arg) => /^(POST|PUT|PATCH|DELETE)$/i.test(arg) || /^[^=:/\s@-][^=:/\s]*:?=/.test(arg) || /^[^@\s]+@\S/.test(arg) || arg === '--form' || arg === '-f')) {
    return verdict('egress', 'httpie sends data');
  }
  return segment.expands ? verdict('egress', 'httpie with expanded arguments can carry data out') : verdict('network_read', 'httpie downloads');
}

const AWS_READ_OPERATION = /^(describe|list|get|head|batch-get|search|scan|query|lookup|filter|validate|test|estimate|preview|simulate|view|check|detect|discover|wait|help)(-|$)/;
const AWS_CREDENTIAL_OPERATIONS = new Set(['sts get-session-token', 'sts assume-role', 'sts assume-role-with-saml', 'sts assume-role-with-web-identity',
  'sts get-federation-token', 'ecr get-login-password', 'ecr get-authorization-token', 'codeartifact get-authorization-token',
  'configure get', 'configure export-credentials', 'secretsmanager get-secret-value', 'secretsmanager batch-get-secret-value',
  'ssm get-parameter', 'ssm get-parameters', 'ssm get-parameters-by-path', 'iam create-access-key', 'sso get-role-credentials',
  'kms decrypt', 'cognito-identity get-credentials-for-identity', 'rds generate-db-auth-token', 'eks get-token']);

/** aws <service> <operation>: reads are describe/list/get…; credentials have their own class; anything else changes AWS. */
function awsConsequence(args: readonly string[]): CallVerdict {
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && ['--profile', '--region', '--output', '--endpoint-url', '--query', '--cli-input-json', '--color', '--ca-bundle'].includes(arg)) index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const [service = '', operation = ''] = operands.map((operand) => operand.toLowerCase());
  if (!service || service === 'help' || operation === 'help' || service === '--version') return READ;
  const key = `${service} ${operation}`;
  if (AWS_CREDENTIAL_OPERATIONS.has(key)) return verdict('credential_read', `aws ${key} reads credentials or secrets`);
  if (service === 'configure') return operation === 'list' || operation === '' ? READ : LOCAL;
  if (service === 'sts' && operation === 'get-caller-identity') return verdict('network_read', 'aws sts get-caller-identity reads');
  if (service === 's3') {
    if (operation === 'ls') return verdict('network_read', 'aws s3 ls reads S3');
    if (['cp', 'mv', 'sync'].includes(operation)) {
      const destination = operands[operands.length - 1] ?? '';
      return destination.startsWith('s3://') || operation === 'mv' ? verdict('egress', `aws s3 ${operation} writes to S3`) : verdict('network_read', `aws s3 ${operation} downloads from S3`);
    }
    return verdict('egress', `aws s3 ${operation} changes S3`);
  }
  if (service === 'logs' && (operation === 'tail' || operation === 'start-query' || operation === 'filter-log-events')) return verdict('network_read', `aws logs ${operation} reads`);
  if (AWS_READ_OPERATION.test(operation)) return verdict('network_read', `aws ${key} reads`);
  return verdict('egress', `aws ${key} changes AWS`);
}

function cloudCliConsequence(cmd: string, args: readonly string[]): CallVerdict {
  const words = args.filter((arg) => !arg.startsWith('-'));
  if (words.some((word) => /^(print-access-token|print-identity-token|get-access-token|get-credentials)$/.test(word))) return verdict('credential_read', `${cmd} prints a token`);
  if (words.some((word) => /^(list|show|describe|get|get-iam-policy|read|logs|tail|version|help|info)$/.test(word))) return verdict('network_read', `${cmd} reads`);
  return verdict('egress', `${cmd} ${words.slice(0, 2).join(' ')} changes cloud resources`);
}

function kubectlConsequence(cmd: string, args: readonly string[]): CallVerdict {
  const sub = firstOperand(args);
  if (['get', 'describe', 'logs', 'top', 'explain', 'version', 'api-resources', 'api-versions', 'cluster-info', 'diff', 'events', 'wait'].includes(sub)
    || sub === 'config' && ['view', 'get-contexts', 'current-context', 'get-clusters'].includes(args[args.indexOf('config') + 1] ?? '')
    || sub === 'auth' && args.includes('can-i')) {
    return verdict('network_read', `${cmd} ${sub} reads the cluster`);
  }
  if (sub === 'config') return LOCAL;
  return verdict('egress', `${cmd} ${sub} changes the cluster`);
}

function terraformConsequence(cmd: string, args: readonly string[]): CallVerdict {
  const sub = firstOperand(args);
  if (['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock', 'refresh'].includes(sub)) return verdict('egress', `${cmd} ${sub} changes cloud resources`);
  if (sub === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(args[args.indexOf('state') + 1] ?? '')) return verdict('egress', `${cmd} state changes remote state`);
  if (sub === 'login' || sub === 'logout') return verdict('credential_read', `${cmd} ${sub} handles credentials`);
  return verdict('network_read', `${cmd} ${sub} reads`);
}

function dockerConsequence(cmd: string, args: readonly string[]): CallVerdict {
  const words = args.filter((arg) => !arg.startsWith('-'));
  const sub = words[0] ?? '';
  if (sub === 'push' || sub === 'login' || words.includes('push') || args.includes('--push') || sub === 'trust' || sub === 'manifest' && words[1] === 'push') {
    return verdict('egress', `${cmd} pushes or signs in to a registry`);
  }
  if (['pull', 'build', 'buildx', 'compose', 'run', 'create', 'search'].includes(sub)) return verdict('network_read', `${cmd} ${sub} may download images`);
  return LOCAL;
}

function packageManagerConsequence(cmd: string, args: readonly string[]): CallVerdict {
  const operands = args.filter((arg) => !arg.startsWith('-'));
  const sub = operands[0] ?? '';
  if (['publish', 'unpublish', 'deprecate', 'adduser', 'login', 'logout', 'owner', 'access', 'token', 'team', 'star', 'unstar', 'hook', 'org', 'npm-publish'].includes(sub)
    || sub === 'dist-tag' && ['add', 'rm'].includes(operands[1] ?? '')) {
    return verdict('egress', `${cmd} ${sub} talks to the registry`);
  }
  if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
    return operands.slice(1).some((name) => EGRESS_WORD.test(name)) ? verdict('egress', `${cmd} runs a release script`) : LOCAL;
  }
  if (['exec', 'x', 'dlx', 'create', 'init'].includes(sub)) {
    return operands.slice(1).some((name) => EGRESS_WORD.test(name) || /^(vercel|netlify|wrangler|firebase|surge|gh-pages)$/.test(name))
      ? verdict('egress', `${cmd} ${sub} runs a release command`) : verdict('network_read', `${cmd} ${sub} may download`);
  }
  if (['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'outdated', 'view', 'info', 'show', 'search', 'audit', 'fetch', 'dedupe', 'rebuild', 'prune', 'link', 'pack', 'why', 'ls', 'list', 'doctor'].includes(sub)
    || sub === '' && (cmd === 'yarn' || cmd === 'pnpm' || cmd === 'bun')) {
    return verdict('network_read', `${cmd} ${sub || 'install'} may download`);
  }
  if (['test', 't', 'start', 'build', 'lint', 'typecheck', 'version', 'config', 'help', 'cache', 'root', 'prefix', 'bin', 'pkg', 'set', 'get', 'explain', 'query'].includes(sub)) return LOCAL;
  // yarn <script>, pnpm <script>, bun <script>: a package script.
  return EGRESS_WORD.test(sub) ? verdict('egress', `${cmd} runs a release script`) : LOCAL;
}


/**
 * A shell command line: every simple command in it, inside substitutions
 * and `sh -c` too, judged and the worst kept. A network command whose
 * arguments are expanded (`curl …$(cat key)`) may be carrying something
 * out, so it counts as egress. A line Michi cannot parse is unclear.
 */
export function shellConsequence(command: string | readonly string[], depth = 0): CallVerdict {
  if (typeof command !== 'string') {
    if (command.length === 0) return verdict('unclear', 'runs a command Michi cannot read');
    // An argv array (Codex): a shell wrapper's script is parsed; anything else is judged as given.
    const [head, ...rest] = command;
    if (SHELLS.has(baseName(head)) && (rest[0] === '-c' || rest[0] === '-lc' || rest[0] === '-cl')) return shellConsequence(rest[1] ?? '', depth + 1);
    const segment: Segment = { words: [...command], redirects: [], expands: false, heredocs: [] };
    return finish([argvConsequence(commandWords(command), segment, depth)], command.join(' '));
  }
  const text = command.trim();
  if (!text) return verdict('unclear', 'runs a command Michi cannot read');
  if (depth > MAX_DEPTH) return verdict('unclear', 'a command nested too deep to read');
  const parsed = parseShell(text, depth);
  if (parsed.unreadable) return verdict('unclear', 'a command Michi cannot parse');
  const verdicts: CallVerdict[] = [];
  const collect = (tree: Parsed) => {
    if (tree.unreadable) verdicts.push(verdict('unclear', 'a command Michi cannot parse'));
    for (const segment of tree.segments) {
      verdicts.push(argvConsequence(commandWords(segment.words), segment, depth));
      const secretWord = [...segment.words, ...segment.redirects].find(isCredentialPath);
      if (secretWord) verdicts.push(verdict('credential_read', `reads ${secretWord}`));
    }
    for (const inner of tree.inner) collect(inner);
  };
  collect(parsed);
  return finish(verdicts, text);
}

function finish(verdicts: readonly CallVerdict[], text: string): CallVerdict {
  let result: CallVerdict = verdicts.length > 0 ? verdicts[0] : LOCAL;
  for (const next of verdicts.slice(1)) result = worse(result, next);
  if (/\/dev\/(tcp|udp)\//.test(text)) return verdict('egress', 'opens a network socket');
  return result;
}
