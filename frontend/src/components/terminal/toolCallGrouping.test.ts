import { describe, expect, it } from 'vitest';
import { extractToolUsePurpose } from 'michi-shared';
import { isHiddenInternalTool, isRunningStatus, prettifyToolTitle, toolDisplayTitle, toolRowDetail } from './toolCallGrouping';
import type { ToolCallState } from '../../state/chatTypes';

describe('status predicates', () => {
  it('isRunningStatus: running/in_progress/pending/empty are running', () => {
    expect(isRunningStatus('running')).toBe(true);
    expect(isRunningStatus('in_progress')).toBe(true);
    expect(isRunningStatus('pending')).toBe(true);
    expect(isRunningStatus('')).toBe(true);
    expect(isRunningStatus(undefined)).toBe(true);
  });
});

// `partsToGroups` was deleted in step 5: parts/pendingParts are gone, and
// adjacent-tool grouping moved into `weaveToolCalls` in streamingProjection.ts
// (covered by streamingProjection.test.ts).

import { summarizeTools, summarizeToolsBase } from './toolCallGrouping';

function t(id: string, title: string, kind: string | undefined, status = 'completed'): ToolCallState {
  return { id, title, status, kind };
}

describe('summarizeTools', () => {
  it('mixed: one failed appends · 1 failed', () => {
    expect(
      summarizeTools([
        t('1', 'Read a', 'read', 'completed'),
        t('2', 'Read b', 'read', 'error'),
        t('3', 'Bash x', 'bash', 'completed'),
      ]),
    ).toBe('read 2 files, ran 1 command · 1 failed');
  });

  it('no kind, no title falls back to generic', () => {
    expect(
      summarizeTools([
        { id: '1', title: '', status: 'completed' },
        { id: '2', title: '', status: 'completed' },
      ]),
    ).toBe('used 2 tools');
  });

  it('single SubAgent — failed status renders the failed label', () => {
    const detail = JSON.stringify({
      description: 'Explore Michi project structure',
      subagent_type: 'Explore',
    });
    expect(
      summarizeTools([{ id: '1', title: 'Agent', status: 'error', kind: 'tool', detail }]),
    ).toBe('SubAgent · Explore · failed');
  });

  it('a lone SubAgent takes a given status word; other summaries ignore it', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', run_in_background: true });
    const agent: ToolCallState = { id: '1', title: 'Agent', status: 'completed', kind: 'tool', detail };
    expect(summarizeToolsBase([agent], 'in background')).toBe('SubAgent · Explore · in background');
    expect(summarizeToolsBase([agent])).toBe('SubAgent · Explore · completed');
    expect(summarizeToolsBase([agent, { ...agent, id: '2' }], 'in background')).toBe('2 SubAgents · completed');
    expect(summarizeToolsBase([t('r', 'Read package.json', 'read')], 'stopped')).toBe('Read package.json');
  });
});

import { subagentTitleMatches } from './toolCallGrouping';
import type { SubagentInfo } from '../../state/chatTypes';

function sub(partial: Partial<SubagentInfo>): SubagentInfo {
  return {
    sessionId: partial.sessionId ?? 'sub-1',
    sessionName: partial.sessionName ?? 'sub-1',
    agentName: partial.agentName ?? 'Explore',
    initialQuery: partial.initialQuery ?? 'Explore Michi project structure',
    status: partial.status ?? 'working',
    group: partial.group ?? 'default',
    dependsOn: partial.dependsOn ?? [],
    currentTool: partial.currentTool,
    statusMessage: partial.statusMessage,
    ...(partial.activity ? { activity: partial.activity } : {}),
  };
}

describe('subagentTitleMatches', () => {
  it('does not match a non-subagent tool', () => {
    const tool = { id: 't1', title: 'Bash', status: 'completed', kind: 'bash' };
    expect(subagentTitleMatches(tool, sub({}))).toBe(false);
  });

  it('does not match when agentType differs and no text overlap', () => {
    const detail = JSON.stringify({ subagent_type: 'Planner', description: 'Build a roadmap' });
    const tool = { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail };
    expect(
      subagentTitleMatches(tool, sub({ agentName: 'Explore', initialQuery: 'something else' })),
    ).toBe(false);
  });
});

import { findOwningSubagent } from './toolCallGrouping';

function bashTool(id: string, status = 'completed'): ToolCallState {
  return { id, title: `Bash cmd-${id}`, status, kind: 'bash' };
}

describe('findOwningSubagent', () => {
  it('returns undefined for a Bash tool-call', () => {
    const subagents = [sub({})];
    expect(findOwningSubagent(bashTool('t1'), subagents)).toBeUndefined();
  });
});

import { filterSubagentRelayedTools } from './toolCallGrouping';

function subagentTool(
  id: string,
  agentType = 'Explore',
  description = 'Explore Michi project structure',
  status = 'in_progress',
): ToolCallState {
  const detail = JSON.stringify({ subagent_type: agentType, description });
  return { id, title: 'Agent', status, kind: 'tool', detail };
}

describe('filterSubagentRelayedTools', () => {
  it('removes only tools a subagent reported as its own activity', () => {
    const subagents = [sub({
      agentName: 'Explore',
      activity: [{ id: 't2', kind: 'tool', title: 'Bash ls', status: 'in_progress' }],
    })];
    const tools: ToolCallState[] = [
      subagentTool('t1'),
      bashTool('t2', 'running'),
      { id: 't3', title: 'Glob *.ts', status: 'running', kind: 'glob' },
      { id: 't4', title: 'Read package.json', status: 'completed', kind: 'read' },
    ];
    const result = filterSubagentRelayedTools(tools, subagents);
    // SubAgent card kept, relayed bash hidden, the parent's own glob (still
    // running alongside the subagent) and read kept.
    expect(result.map((t) => t.id)).toEqual(['t1', 't3', 't4']);
  });

  it('keeps the parent\'s running tools while a subagent works without relayed activity', () => {
    const subagents = [sub({ agentName: 'Explore' })];
    const tools = [subagentTool('t1'), bashTool('t2', 'running')];
    expect(filterSubagentRelayedTools(tools, subagents).map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('keeps non-SubAgent tools when subagents is empty', () => {
    const tools = [bashTool('t1'), bashTool('t2')];
    expect(filterSubagentRelayedTools(tools, []).map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('keeps non-SubAgent tools when subagents is undefined', () => {
    const tools = [bashTool('t1')];
    expect(filterSubagentRelayedTools(tools, undefined).map((t) => t.id)).toEqual(['t1']);
  });

  it('always keeps SubAgent tools regardless of subagents arg', () => {
    const tools = [subagentTool('t1'), subagentTool('t2', 'Planner', 'Plan')];
    expect(filterSubagentRelayedTools(tools, []).length).toBe(2);
    expect(filterSubagentRelayedTools(tools, undefined).length).toBe(2);
  });
});

describe('prettifyToolTitle', () => {
  it('leaves a malformed mcp name (no tool segment) untouched', () => {
    expect(prettifyToolTitle('mcp__michi-tools')).toBe('mcp__michi-tools');
  });
});

describe('toolDisplayTitle — Kiro ask_user lifecycle', () => {
  it.each([
    ['', 'Running'],
    ['pending', 'Running'],
    ['in_progress', 'Running'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['error', 'Failed'],
    ['interrupted', 'Interrupted'],
    ['cancelled', 'Interrupted'],
    ['canceled', 'Interrupted'],
    ['custom-status', 'Running'],
  ])('displays %s with the matching known label', (status, prefix) => {
    const raw = Object.freeze({ id: 'ask-1', title: 'Running: @michi/ask_user', status });
    expect(toolDisplayTitle(raw)).toBe(`${prefix}: @michi/ask_user`);
    expect(raw.title).toBe('Running: @michi/ask_user');
  });

  it('preserves arbitrary MCP and model titles, including similarly named tools', () => {
    for (const title of [
      'Running: @other/ask_user', 'Running: @michi/custom_tool',
      'Running: @michi/ask_user extra', 'The model says Running: @michi/ask_user',
      'Running: inspect model output', '@michi/ask_user',
    ]) {
      expect(toolDisplayTitle({ id: 'other', title, status: 'completed' })).toBe(title);
    }
    expect(toolDisplayTitle({ id: 'mcp', title: 'mcp__other__custom_tool', status: 'completed' })).toBe('custom_tool');
  });

  it('uses the same display label in the single-tool summary', () => {
    expect(summarizeTools([{ id: 'ask-1', title: 'Running: @michi/ask_user', status: 'completed' }])).toBe('Completed: @michi/ask_user');
  });
});

describe('summarizeTools — MCP tool (regression)', () => {
  it('renders a completed MCP tool by its prettified name, not as a SubAgent', () => {
    const detail = JSON.stringify([{ type: 'text', text: '40 threads.' }]);
    expect(
      summarizeTools([
        { id: '1', title: 'mcp__michi-tools__list_threads', status: 'completed', kind: 'tool', detail },
      ]),
    ).toBe('list_threads');
  });
});

describe('extractToolUsePurpose', () => {
  it('reads the field from an object, a JSON string, and a truncated JSON string', () => {
    const obj = { __tool_use_purpose: 'Inspect workspace root', path: '/tmp' };
    expect(extractToolUsePurpose(obj)).toBe('Inspect workspace root');
    expect(extractToolUsePurpose(JSON.stringify(obj))).toBe('Inspect workspace root');
    expect(extractToolUsePurpose('{"__tool_use_purpose":"Inspect workspace root","path":"/tm')).toBe(
      'Inspect workspace root',
    );
  });

  it('returns undefined for commands, paths, and result dumps', () => {
    expect(extractToolUsePurpose({ command: 'npm test' })).toBeUndefined();
    expect(extractToolUsePurpose({ file_path: '/tmp/a.ts' })).toBeUndefined();
    expect(extractToolUsePurpose('{"data":"file contents"}')).toBeUndefined();
  });
});

describe('toolRowDetail — Kiro operations', () => {
  it('uses a path-like detail as the row argument when inputJson is missing', () => {
    expect(
      toolRowDetail({
        id: '1',
        title: 'Read',
        status: 'completed',
        kind: 'read',
        detail: '/workspace/example-app/package.json',
      }),
    ).toBe('/workspace/example-app/package.json');
  });
});

import { summarizeWork } from './toolCallGrouping';
import { ownGroupTools } from './subagents/subagentPresentation';

describe('summarizeWork — agent block header', () => {
  it('leads with changes, then commands, then lookups, regardless of stream order', () => {
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        t('2', 'Read b', 'read'),
        t('3', 'Bash x', 'bash'),
        t('4', 'Edit c', 'edit'),
      ]),
    ).toEqual({ text: 'Edited 1 file, ran 1 command, read 2 files', failed: 0 });
  });

  it('caps the phrase list and counts the remaining tools', () => {
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        t('2', 'Glob *', 'glob'),
        t('3', 'Grep x', 'grep'),
        t('4', 'Bash x', 'bash'),
        t('5', 'Edit c', 'edit'),
        t('6', 'Read b', 'read'),
      ]).text,
    ).toBe('Edited 1 file, ran 1 command, searched 1 pattern, +3 more');
  });

  it('ignores hidden metadata tools in phrases and failure counts', () => {
    expect(
      summarizeWork(ownGroupTools([
        t('1', 'Read a', 'read'),
        t('2', 'set_branch_overview', undefined, 'error'),
      ], undefined)),
    ).toEqual({ text: 'Read 1 file', failed: 0 });
  });

  it('counts failures among visible tools', () => {
    expect(
      summarizeWork([t('1', 'Bash a', 'bash', 'error'), t('2', 'Bash b', 'bash')]),
    ).toEqual({ text: 'Ran 2 commands', failed: 1 });
  });

  it('names a lone unrecognized tool instead of saying "used 1 tool"', () => {
    expect(
      summarizeWork([{ id: '1', title: 'mcp__michi-tools__list_threads', status: 'completed', kind: 'tool' }]).text,
    ).toBe('list_threads');
  });

  it('gives SubAgents their own phrase in a mixed run', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Look around' });
    expect(
      summarizeWork([
        t('1', 'Read a', 'read'),
        { id: '2', title: 'Agent', status: 'completed', kind: 'tool', detail },
      ]).text,
    ).toBe('Ran 1 SubAgent, read 1 file');
  });

  it('returns empty text when no visible tools remain', () => {
    expect(summarizeWork(ownGroupTools([t('1', 'set_title', undefined)], undefined))).toEqual({ text: '', failed: 0 });
  });
});

/* ── Outcome-first copy (the 'line' chrome) ── */

import {
  changesState,
  findRecoveries,
  formatDurationMs,
  formatElapsedMs,
  isSimpleCommand,
  readablePattern,
  spokenDurationMs,
  stepDetail,
  stepName,
  stepView,
  summarizeOutcome,
  commandPhrase,
  joinSentence,
  capPhrases,
  sentenceOf,
  thoughtConclusion,
  thoughtPreview,
  toolErrorLine,
  toolOutcomeIcon,
  toolPhrase,
  toolRecord,
} from './toolCallGrouping';
import { michiToolName } from './michiToolCopy';

const NB = '\u00A0';
function bash(id: string, command: string, description?: string, status = 'completed', output?: string, ms?: number): ToolCallState {
  return {
    id, title: 'Bash', kind: 'bash', status, inputJson: JSON.stringify({ command, ...(description ? { description } : {}) }),
    ...(output ? { output } : {}), ...(ms != null ? { startedAt: 0, endedAt: ms } : {}),
  };
}
function file(id: string, kind: 'read' | 'edit' | 'write', path: string, status = 'completed', output?: string): ToolCallState {
  return { id, title: kind === 'read' ? 'Read' : kind === 'edit' ? 'Edit' : 'Write', kind, status, inputJson: JSON.stringify({ file_path: path }), ...(output ? { output } : {}) };
}
function grep(id: string, pattern: string): ToolCallState {
  return { id, title: 'Grep', kind: 'grep', status: 'completed', inputJson: JSON.stringify({ pattern, path: 'frontend/src' }) };
}
const DENIED = 'Permission to use Bash with command rm -rf /tmp/x has been denied.';

describe('the agent\'s words', () => {
  it('are shown as written: never conjugated, whatever the first word', () => {
    const said = (description: string) => bash('s', 'packagebuild-build release', description);
    for (const d of ['Fast-forward shared dev to the merge commit', 'Final frontend typecheck', 'Git status of the repo', 'Crop toolbar region and sample pixel colors']) {
      expect(toolPhrase(said(d)).text).toBe(d);
      expect(stepName(said(d)).text).toBe(d);
      expect(stepView({ ...said(d), status: 'running' }, false).lead).toBe(`${d}…`);
    }
    // Only a closing period goes.
    expect(toolPhrase(said('Run related unit tests.')).text).toBe('Run related unit tests');
  });
});

describe('step rows', () => {
  it('name a call by the agent\'s words, else Michi\'s fact in the base form', () => {
    expect(stepName(bash('1', 'npm run typecheck -w frontend', 'Typecheck frontend')).text).toBe('Typecheck frontend');
    expect(stepName(bash('2', 'git push origin dev')).text).toBe('Push dev');
    expect(stepName(file('3', 'read', 'frontend/src/components/terminal/TPane.tsx')).text).toBe('Read TPane.tsx');
    expect(stepName(file('4', 'edit', 'frontend/src/index.css')).text).toBe('Edit index.css');
    expect(stepName(file('5', 'write', 'notes.md')).text).toBe('Create notes.md');
    expect(stepName(grep('6', 'send-motion')).text).toBe('Search for send-motion');
    // A call cut off before its input arrived still reads as words.
    expect(stepName({ id: '7', title: 'Bash', kind: 'bash', status: 'interrupted' }).text).toBe('Run a command');
    // Running: the same name with an ellipsis.
    expect(stepView({ ...bash('8', 'git push origin dev'), status: 'running' }, false).lead).toBe('Push dev…');
  });

  it('show what a step touched: the command as typed, a path, an edit\'s changed lines', () => {
    const ff = bash('1', 'MAIN=/repo; [ "$(git -C $MAIN rev-parse dev)" = 462012ed ] && git -C $MAIN merge --ff-only -q 66fac8159dd576f0209488d62252f170a1aae944');
    expect(stepDetail(ff)).toBe('git merge --ff-only -q 66fac81');
    const heredoc = bash('2', "cat > /tmp/q.mjs <<'EOF'\nimport { DatabaseSync } from 'node:sqlite';\nEOF\nnode /tmp/q.mjs");
    expect(stepDetail(heredoc)).toBe("cat > /tmp/q.mjs <<'EOF' ⏎ node /tmp/q.mjs");
    const edit: ToolCallState = { id: '3', title: 'Edit', kind: 'edit', status: 'completed', inputJson: JSON.stringify({ file_path: '/r/frontend/src/a/b.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }) };
    expect(stepDetail(edit)).toBe('+2 −1 · …/src/a/b.ts');
    // Kiro's edits say oldStr / newStr.
    expect(stepDetail({ ...edit, inputJson: JSON.stringify({ path: 'x.ts', oldStr: 'a', newStr: 'a\nb' }) })).toBe('+1 · x.ts');
  });

  it('say how a step ended: an exit code, a rerun, a denial, a stop', () => {
    const e2e = bash('1', 'npm run test:e2e', 'Run send-scroll E2E', 'failed', 'Exit code 1\nError: http://localhost:4173 is already used\nmore');
    expect(stepView(e2e, false)).toMatchObject({ lead: 'Run send-scroll E2E', rest: 'http://localhost:4173 is already used', restKind: 'error', frag: { tone: 'danger', text: `exit${NB}1` }, loud: true });
    expect(stepView(e2e, true)).toMatchObject({ rest: 'npm run test:e2e', restKind: 'cmd', frag: { tone: 'calm', text: 'rerun passed' }, loud: false });
    // Declined: it did not run, and nothing failed.
    expect(stepView(bash('2', 'rm -rf /tmp/x', 'Remove the scratch dir', 'failed', DENIED), false))
      .toMatchObject({ lead: 'Remove the scratch dir', rest: 'rm -rf /tmp/x', restKind: 'cmd', frag: { tone: 'calm', text: 'denied' }, loud: false });
    expect(stepView(bash('3', 'sleep 60', 'Wait', 'interrupted'), false).frag).toEqual({ tone: 'calm', text: 'stopped' });
    const edit = file('4', 'edit', 'frontend/src/components/terminal/MessageBlock.tsx', 'failed', 'Error: old_string not found in file');
    expect(stepView(edit, false)).toMatchObject({ lead: 'Edit MessageBlock.tsx', rest: 'old_string not found in file', frag: { tone: 'danger', text: 'failed' } });
    // The red error line already says it failed: the bare word is left to screen
    // readers. An exit code adds information and stays shown, as does "failed"
    // when there is no error line to say it.
    expect(stepView(edit, false).frag).toEqual({ tone: 'danger', text: 'failed', srOnly: true });
    expect(stepView(e2e, false).frag).toEqual({ tone: 'danger', text: `exit${NB}1` });
    expect(stepView(file('4b', 'edit', 'a.ts', 'failed'), false).frag).toEqual({ tone: 'danger', text: 'failed' });
    // Kiro wraps output as JSON.
    expect(toolErrorLine(bash('5', 'ls /nope', undefined, 'failed', '{"output":"ls: cannot access /nope: No such file\\nmore"}'))).toBe('ls: cannot access /nope: No such file');
    // An error that opens JSON goes on to say what was wrong.
    expect(toolErrorLine(bash('6', 'x', undefined, 'failed', 'Invalid arguments for tool write_page: [\n  {\n    "path": ["ops", 0]\n  }\n]')))
      .toBe('Invalid arguments for tool write_page: [ { "path": ["ops", 0] } ]');
  });
});

describe('call phrases', () => {
  it('say a fact for structured tools and simple changes or checks, the agent\'s words for looks and compound lines', () => {
    expect(toolPhrase(bash('1', 'npm run typecheck -w frontend', 'Typecheck frontend')).text).toBe('Typechecked frontend');
    expect(toolPhrase(bash('2', 'git push origin dev')).text).toBe('Pushed dev');
    expect(toolPhrase(bash('2b', './scripts/deploy.sh --fast now please')).text).toBe('Ran ./scripts/deploy.sh');
    // A look says why in the agent's words; without them, its fact.
    expect(toolPhrase(bash('2c', 'git diff --stat dev...origin/dev', 'Show files origin/dev changed')).text).toBe('Show files origin/dev changed');
    expect(toolPhrase(bash('2d', 'git diff --stat dev...origin/dev')).text).toBe('Listed changed files');
    // A compound line would be a guess: the agent's words say it.
    const push = bash('2e', 'git add -A && git commit -q -m "x" && git push origin dev', 'Commit the fix and push it');
    expect(toolPhrase(push).text).toBe('Commit the fix and push it');
    expect(toolPhrase(bash('2f', 'cd /tmp && timeout 90 packagebuild vs printpackages')).text).toBe('Ran packagebuild vs printpackages');
    // A heredoc's body is not arguments: this writes q.mjs, it reads nothing.
    expect(toolPhrase(bash('2g', "cat > /tmp/q.mjs <<'EOF'\nimport x from 'node:sqlite'\nEOF")).text).toBe('Created q.mjs');
    expect(toolPhrase(file('3', 'read', 'frontend/src/components/terminal/TPane.tsx')).text).toBe('Read TPane.tsx');
    expect(toolPhrase(file('4', 'edit', 'frontend/src/index.css')).text).toBe('Edited index.css');
    expect(toolPhrase(grep('5', 'send-motion')).text).toBe('Searched for send-motion');
  });

  it('tells one simple command from a compound line', () => {
    expect(isSimpleCommand('cd frontend && npm test -- a.test.ts 2>&1 | tail -20')).toBe(true);
    expect(isSimpleCommand('E2E_PORT=1 npm run test:e2e')).toBe(true);
    expect(isSimpleCommand('git add -A && git commit -m x')).toBe(false);
    expect(isSimpleCommand("python3 - <<'EOF'\nprint(1)\nEOF")).toBe(false);
    expect(isSimpleCommand('for f in a b; do echo $f; done')).toBe(false);
  });

  it('knows which calls change state, including git -C and npm i', () => {
    expect(changesState(bash('1', 'git merge origin/dev --no-edit'))).toBe(true);
    expect(changesState(bash('2', 'git -C ../michi push origin dev'))).toBe(true);
    expect(changesState(bash('3', 'cd frontend && npm i'))).toBe(true);
    expect(changesState(bash('4', 'git add -A && git commit -m "x"'))).toBe(true);
    expect(changesState(bash('5', 'rm -rf build'))).toBe(true);
    expect(changesState(bash('5b', 'git branch -q -D fix/x'))).toBe(true);
    expect(changesState(file('6', 'edit', 'a.ts'))).toBe(true);
    expect(changesState(bash('7', 'git status && git diff --stat'))).toBe(false);
    expect(changesState(bash('8', 'npm run test -w frontend'))).toBe(false);
    expect(changesState(file('9', 'read', 'a.ts'))).toBe(false);
  });

  it('picks the hanging icon from the call', () => {
    expect(toolOutcomeIcon(bash('1', 'git merge origin/dev'))).toBe('merge');
    expect(toolOutcomeIcon(bash('2', 'npm test && git push'))).toBe('push');
    expect(toolOutcomeIcon(bash('3', 'git -C x commit -m y'))).toBe('commit');
    expect(toolOutcomeIcon(bash('4', 'ls'))).toBe('terminal');
    expect(toolOutcomeIcon(file('5', 'read', 'a.ts'))).toBe('file');
    expect(toolOutcomeIcon(grep('6', 'x'))).toBe('search');
    expect(toolOutcomeIcon(file('7', 'write', 'a.ts'))).toBe('edit');
  });
});

describe('commandPhrase', () => {
  it('says what common commands did, through git -C, ENV= and pipes', () => {
    const cases: Array<[string, string | null]> = [
      ['git diff --stat dev...origin/dev -- frontend/src', 'list changed files'],
      ['git -C ../michi log --oneline -5', 'view recent commits'],
      ['git status --short', 'check git status'],
      ['git fetch origin dev 2>&1 | tail -2; git rev-list --count dev..origin/dev', 'fetch origin'],
      ['git merge origin/dev --no-edit', 'merge origin/dev'],
      ['git push origin dev', 'push dev'],
      ['git commit -m "x"', 'commit changes'],
      ['git switch feat/x', 'switch to feat/x'],
      ['cd frontend && npm test -- src/a.test.ts', 'run a.test.ts'],
      ['npm test -w frontend -- a.test.ts b.test.ts', `run 2${NB}test files`],
      ['npm run typecheck -w frontend', 'typecheck frontend'],
      ['E2E_PORT=4317 npm run test:e2e -- e2e/specs/send-scroll.spec.ts', 'run send-scroll E2E'],
      ['npm run lint -w frontend', 'lint frontend'],
      ['npm install', 'install dependencies'],
      ['ls -la frontend/src', 'list src'],
      ['sed -n 1,40p frontend/src/index.css', 'read index.css'],
      ['rg -n "send-motion|data" frontend/src', 'search for send-motion'],
      ['curl -s https://registry.npmjs.org/gsap/latest', 'fetch registry.npmjs.org'],
      ['./scripts/deploy.sh', null],
      // A pipe's later stages filter output; they do not say what the line did.
      ["packagebuild vs printpackages --versionset X | grep -iE 'Renderer|Parser' | head -20", null],
      ['cat a.log | grep error', 'read a.log'],
      // A hash is cut short, a shell expansion names nothing, a message is no ref.
      ['git -C $MAIN merge --ff-only -q 66fac8159dd576f0209488d62252f170a1aae944', 'fast-forward 66fac81'],
      ['git branch -q -D $b', 'delete a branch'],
      ['git worktree remove --force "$WT"; git branch -D fix/x', 'delete branch fix/x'],
      ['git merge --no-ff -m "Merge fix/remote-transport into dev" fix/remote-transport', 'merge fix/remote-transport'],
      ['git push origin "$BRANCH"', 'push changes'],
      ['git add $F', 'stage changes'],
      ['ls -la $KC', 'list files'],
      ['mkdir -p mocks/x/{a,b,site}', 'create directories'],
      // Quotes and escapes are the shell's, not the object's.
      ['grep -rn "\\"milestones\\"\\|keyvalue" shared/src', 'search for milestones'],
      ["grep -rnE '(warmSessions|\\.warm\\()' runtime/src", 'search for warmSessions'],
      ["sed -i 's/a/b/' frontend/src/x.css", 'edit x.css'],
      ['tee /tmp/out.log < in.txt', 'create out.log'],
      // Wrappers and subshells go: this installs.
      ['(nohup npm install > /tmp/npm.log 2>&1 &)', 'install dependencies'],
      ['env -u MICHI_DATA_DIR timeout 300 npm run typecheck -w backend', 'typecheck backend'],
    ];
    for (const [command, expected] of cases) {
      const p = commandPhrase(command);
      expect(p ? `${p.verb} ${p.object}` : null, command).toBe(expected);
    }
  });

  it('lets the stated purpose speak for a hash or a shell variable', () => {
    const ff = bash('m1', 'MAIN=/repo; [ "$(git -C $MAIN rev-parse dev)" = 462012ed ] && git -C $MAIN merge --ff-only -q 66fac8159dd576f0209488d62252f170a1aae944 && git -C $MAIN log --oneline -4',
      'Fast-forward shared dev to the merge commit');
    const cleanup = bash('m2', 'for b in fix/a fix/b; do [ "$(git -C $MAIN rev-parse $b)" = d81a017 ] && git -C $MAIN branch -q -D $b && echo "deleted $b"; done',
      'Remove temporary worktrees and empty branches safely');
    expect(stepName(ff).text).toBe('Fast-forward shared dev to the merge commit');
    expect(summarizeOutcome([ff, cleanup]).lead)
      .toBe(`Fast-forward shared dev to the merge commit${NB}· Remove temporary worktrees and empty branches safely`);
    // Without a purpose, the hash is short.
    expect(toolPhrase(bash('m3', 'git merge --ff-only 66fac8159dd576f0209488d62252f170a1aae944')).text).toBe('Fast-forwarded 66fac81');
  });

  it('reads a search pattern as a person would type it', () => {
    expect(readablePattern('send-motion|data-send-motion')).toBe('send-motion');
    expect(readablePattern('openScheduledHome\\|metaAgent')).toBe('openScheduledHome');
    expect(readablePattern('^# (tests|pass|fail)')).toBe('# (tests|pass|fail)');
    expect(readablePattern('\\.cancel\\(\\)')).toBe('.cancel()');
    expect(readablePattern('API_BASE_URL\\s*=')).toBe('API_BASE_URL =');
    expect(readablePattern('fetchMetaAgent\\b')).toBe('fetchMetaAgent');
  });
});

describe("Michi's own tools", () => {
  const michi = (id: string, title: string, input: Record<string, unknown> = {}, extra: Partial<ToolCallState> = {}): ToolCallState =>
    ({ id, title, kind: 'tool', status: 'completed', inputJson: JSON.stringify(input), ...extra });

  it('are known by every runtime\'s spelling of their name', () => {
    for (const title of ['mcp____michi_internal____read_node', '@michi/read_node', 'Running: @michi/read_node', 'mcp__michi-tools__read_node', 'michi_internal____read_node', 'read_node']) {
      expect(michiToolName(title), title).toBe('read_node');
    }
    for (const title of ['mcp__github__read_node', 'mcp__michigan__read_node', '@michigan/read_node', 'set_title', 'read', 'Bash']) {
      expect(michiToolName(title), title).toBeUndefined();
    }
  });

  it("hide their turn metadata under every runtime's spelling, and never another server's tool of that name", () => {
    for (const title of [
      'set_branch_overview', 'mcp____michi_internal____set_follow_ups', 'mcp__michi-tools__validate_follow_ups',
      '@michi/validate_turn_metadata', 'Running: @michi/set_branch_overview', 'michi_internal____set_branch_overview',
      // Removed from Michi's tools; old history still has it.
      'set_title', 'mcp____michi_internal____set_title',
    ]) expect(isHiddenInternalTool(title), title).toBe(true);
    for (const title of [
      'mcp__notion__set_title', '@notion/set_title', 'Running: @notion/set_title', 'notion____set_title',
      'mcp__michigan__set_follow_ups', 'notion.set_title', 'set_titles',
    ]) expect(isHiddenInternalTool(title), title).toBe(false);
  });

  it('name preview_page in their own words', () => {
    expect(toolPhrase(michi('p', 'mcp____michi_internal____preview_page', { pageId: 'pg-1' })).text).toBe('Opened a page preview');
  });

  it('say what they do in their own words, never an id', () => {
    const save = michi('a', 'mcp____michi_internal____save_artifact', { name: 'plan', body: '# Plan' });
    expect(toolPhrase(save).text).toBe('Saved @plan');
    expect(stepView({ ...save, status: 'running' }, false).lead).toBe('Save @plan…');
    expect(stepView({ ...save, status: 'failed' }, false)).toMatchObject({ lead: 'Save @plan', frag: { tone: 'danger', text: 'failed' } });
    const read = michi('b', '@michi/read_node', { nodeId: 'n-ada5b167-f36e-446b' }, { kind: 'other' });
    expect(toolPhrase(read).text).toBe('Read a thread');
    expect(toolPhrase(michi('c', 'mcp____michi_internal____search_messages', { query: 'deploy', scope: 'all' })).text).toBe('Searched messages for “deploy”');
    expect(toolPhrase(michi('d', '@michi/ask_user', { questions: [{}, {}] })).text).toBe('Asked you 2 questions');
    // Pi names them bare, with kind "execute": not a shell command.
    expect(toolPhrase(michi('e', 'read_node', { nodeId: 'n-1' }, { kind: 'execute' })).text).toBe('Read a thread');
  });

  it('leave a step row to the agent\'s words, and a run\'s sentence to their facts', () => {
    const purpose = (title: string, input: Record<string, unknown>) => michi('p', title, { ...input, __tool_use_purpose: 'Look up the deploy thread' });
    expect(stepName(purpose('@michi/search_messages', { query: 'deploy' })).text).toBe('Look up the deploy thread');
    expect(toolPhrase(purpose('@michi/search_messages', { query: 'deploy' })).text).toBe('Searched messages for “deploy”');
    expect(toolPhrase(purpose('@michi/read_node', { nodeId: 'n-1' })).text).toBe('Read a thread');
    // A run of Pi's page edits, each with a purpose, still counts what it did.
    const edits = ['1', '2', '3'].map((n) => ({ ...purpose('edit_page', { pageId: `pg-${n}` }), id: `e${n}`, kind: 'execute' }));
    expect(summarizeOutcome(edits).lead).toBe(`Edited 3${NB}pages`);
  });

  it('name other tools without a runtime\'s prefixes, and leave plumbing out of a sentence', () => {
    const mcp = (id: string, title: string) => michi(id, title, { query: 'Conduit access' }, { kind: 'other' });
    expect(summarizeOutcome([mcp('1', 'Running: @docs/search'), mcp('2', 'Running: @docs/search'), mcp('3', 'mcp__docs__read_page')]).lead)
      .toBe(`Used search 2${NB}times and read_page`);
    expect(stepName(mcp('4', 'Running: @docs/search')).text).toBe('Use search');
    const load = michi('5', 'ToolSearch', { query: 'select:a,b,c' });
    expect(stepName(load).text).toBe('Load 3 tools');
    expect(summarizeOutcome([load, file('6', 'read', 'a.ts')]).lead).toBe('Read a.ts');
    // Kiro's task list changes its title every call; its input says what it is.
    const tasks = michi('7', 'Completing #1', { command: 'complete', completed_task_ids: ['1'] }, { kind: 'other' });
    expect(stepName(tasks).text).toBe('Update the plan');
    expect(summarizeOutcome([tasks, file('8', 'read', 'b.ts')]).lead).toBe('Read b.ts');
  });

  it('count their repeats by what they did', () => {
    const reads = ['1', '2', '3'].map((n) => michi(`r${n}`, 'mcp____michi_internal____read_node', { nodeId: `n-${n}` }));
    const search = michi('s', 'mcp____michi_internal____search_messages', { query: 'deploy' });
    expect(summarizeOutcome([search, ...reads]).lead).toBe(`Read 3${NB}threads and searched messages for “deploy”`);
    const lists = ['1', '2'].map((n) => michi(`l${n}`, '@michi/list_threads'));
    expect(summarizeOutcome(lists).lead).toBe('Listed threads 2 times');
  });
});

describe('findRecoveries', () => {
  it('recovers a failure by a later success on the same command, ignoring ENV= prefixes', () => {
    const failed = bash('t10', 'npm run test:e2e -- e2e/specs/send-scroll.spec.ts', 'Run send-scroll E2E', 'failed');
    const rerun = bash('t11', 'E2E_PORT=4317 npm run test:e2e -- e2e/specs/send-scroll.spec.ts', 'Rerun send-scroll E2E');
    expect([...findRecoveries([failed, bash('x', 'ls'), rerun])]).toEqual([['t10', 't11']]);
  });

  it('recovers a file call by the same path, and never by an earlier or failed call', () => {
    const before = file('e0', 'edit', 'a.ts');
    const failed = file('e1', 'edit', 'a.ts', 'failed');
    const again = file('e2', 'edit', 'a.ts', 'failed');
    expect(findRecoveries([before, failed, again]).size).toBe(0);
    expect([...findRecoveries([failed, file('r', 'read', 'a.ts'), file('e3', 'edit', 'a.ts')])]).toEqual([['e1', 'e3']]);
    expect(findRecoveries([bash('b1', 'npm test', undefined, 'failed'), bash('b2', 'npm run lint')]).size).toBe(0);
  });
});

describe('summarizeOutcome', () => {
  const explore = [
    bash('t2', 'git diff --stat dev...origin/dev', 'Show files origin/dev changed'),
    file('t3', 'read', 'frontend/src/components/terminal/TPane.tsx'),
    grep('t4', 'send-motion'),
    file('t5', 'read', 'frontend/src/index.css'),
    file('t6', 'read', 'e2e/specs/send-scroll.spec.ts'),
    bash('t7', 'git merge origin/dev --no-edit', 'Merge origin/dev'),
  ];
  const verify = [
    bash('t8', 'npm run typecheck -w frontend', 'Typecheck frontend'),
    bash('t9', 'npm test -w frontend -- a.test.ts', 'Run related unit tests'),
    bash('t10', 'npm run test:e2e -- e2e/specs/send-scroll.spec.ts', 'Run send-scroll E2E', 'failed', 'Exit code 1\nError: port in use'),
  ];

  it('says what a run looked at, then changed; how its checks went', () => {
    expect(summarizeOutcome(explore)).toMatchObject({
      lead: `Explored 3${NB}files, 1${NB}search and 1${NB}command, then merged origin/dev`,
      rest: '',
      restKind: 'record',
      icon: 'merge',
      failed: 0,
    });
    expect(summarizeOutcome([bash('a', 'E2E_PORT=1 npm run test:e2e', 'Rerun send-scroll E2E'), bash('b', 'git push origin dev', 'Push dev')]))
      .toMatchObject({ lead: 'Pushed dev; E2E tests passed', rest: '', icon: 'push' });
    // A file read and then edited is said once, by the edit.
    expect(summarizeOutcome([file('r', 'read', 'src/a.ts'), file('e', 'edit', 'src/a.ts')]).lead).toBe('Edited a.ts');
  });

  it('keeps the sentence when the run went on after a failure: a failed check says so, other failed calls say nothing', () => {
    const missing = file('r2', 'read', 'docs/dreaming.md', 'failed', 'Error: ENOENT: no such file or directory');
    expect(summarizeOutcome([grep('g1', 'dreaming'), file('r1', 'read', 'src/memoryStore.ts'), missing, file('e1', 'edit', 'src/memoryStore.ts')])).toMatchObject({
      lead: 'Searched for dreaming, then edited memoryStore.ts', restKind: 'record', icon: 'edit', failed: 1, unrecovered: 1,
    });
    expect(summarizeOutcome([verify[2], verify[0]])).toMatchObject({
      lead: 'Send-scroll E2E failed, typecheck passed', restKind: 'record', icon: 'terminal', unrecovered: 1,
    });
  });

  it('leads with a failure the run ended on and its first error line, then returns to the outcome once recovered', () => {
    // The step's name leads; AgentLineBlocks shows its exit code beside it.
    expect(summarizeOutcome(verify)).toMatchObject({
      lead: 'Run send-scroll E2E', rest: 'port in use', restKind: 'error', icon: 'fail', failed: 1, unrecovered: 1,
    });
    expect(summarizeOutcome(verify, new Set(['t10']))).toMatchObject({
      lead: 'Typecheck, a.test.ts and send-scroll E2E passed', rest: '', restKind: 'record', icon: 'terminal', failed: 1, unrecovered: 0,
    });
  });

  it('says a declined call apart from failures: by its name when the run ended on it, else counted', () => {
    const denied = bash('d', 'git push origin dev', 'Push dev to origin', 'failed', DENIED);
    expect(summarizeOutcome([verify[0], denied])).toMatchObject({ lead: 'Push dev to origin', rest: '', restKind: 'record', icon: 'push', failed: 0, unrecovered: 0, denied: 1, endedDenied: true });
    const after = summarizeOutcome([denied, file('e', 'edit', 'a.ts')]);
    expect(after).toMatchObject({ lead: 'Edited a.ts', failed: 0, unrecovered: 0, denied: 1 });
    expect(after.endedDenied).toBeUndefined();
  });

  it('tallies what it looked at beside changes and checks, and drops that first when fitting', () => {
    const many = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => file(`r${i}`, 'read', `src/${n}.ts`)),
      grep('g1', 'one'), grep('g2', 'two'), grep('g3', 'three'),
      bash('d1', 'git diff --stat'), bash('l1', 'git log --oneline -20'),
      file('e1', 'edit', 'frontend/src/components/terminal/TPane.tsx'), file('e2', 'edit', 'frontend/src/index.css'),
      bash('t1', 'npm test -w frontend -- src/a.test.ts src/b.test.tsx'),
    ];
    const out = summarizeOutcome(many);
    expect(out.lead).toBe(`Explored 6${NB}files, 3${NB}searches and 2${NB}commands, then edited TPane.tsx and index.css; 2${NB}test files passed`);
    expect(out.sentence).toMatchObject({ dropped: 0, phrases: [{ rank: 0 }, { rank: 2, join: ', then ' }, { rank: 1, join: '; ' }] });
    expect(out.icon).toBe('edit');
    const { kept, dropped } = capPhrases(out.sentence!.phrases, 2);
    expect(sentenceOf(kept, dropped)).toBe(`Edited TPane.tsx and index.css; 2${NB}test files passed${NB}+1`);
  });

  it('names what a run that only looked at, up to three of each kind, in the order they began', () => {
    expect(summarizeOutcome([grep('g1', 'send-motion'), file('r1', 'read', 'src/TPane.tsx'), file('r2', 'read', 'src/index.css')]).lead)
      .toBe('Searched for send-motion, read TPane.tsx and index.css');
    // More than three files: the two read most, then a count.
    const reads = ['TPane', 'index', 'TPane', 'MessageBlock', 'chatStore'].map((n, i) => file(`f${i}`, 'read', `src/${n}.tsx`));
    expect(summarizeOutcome(reads).lead).toBe(`Read TPane.tsx, index.tsx and 2${NB}more files`);
    // More than three commands: the slowest one with an instruction, then a count.
    const commands = [
      bash('c1', 'npm ls --depth=0 | head -15', 'Check package versions in the project', 'completed', undefined, 1_100),
      bash('c2', 'npm ls --all', 'Grep key package versions', 'completed', undefined, 2_400),
      bash('c3', 'npm outdated', 'Compare key package versions against the published versions', 'completed', undefined, 14_000),
      bash('c4', 'npm ls --depth=0', 'Print dependency versions', 'completed', undefined, 5_800),
    ];
    expect(summarizeOutcome(commands).lead).toBe(`Compare key package versions against the published versions${NB}· 3${NB}more commands`);
    const mcp = (id: string): ToolCallState => ({ id, title: 'mcp__docs__read_page', status: 'completed', inputJson: '{"url":"https://docs.example.com/x"}' });
    expect(summarizeOutcome([mcp('m1'), mcp('m2'), mcp('m3')]).lead).toBe(`Used read_page 3${NB}times`);
  });

  it('reports checks by result: passed, or only run when a pipe hides the exit code', () => {
    expect(summarizeOutcome([bash('a', 'npm run typecheck -w frontend', 'Typecheck frontend'), bash('b', 'npm run typecheck -w backend', 'Typecheck backend')]).lead)
      .toBe('Frontend and backend typecheck passed');
    expect(summarizeOutcome([bash('a', 'npm run typecheck -w frontend', 'Typecheck frontend'), bash('b', 'npm test -w backend 2>&1 | tail -20', 'Run backend tests')]).lead)
      .toBe('Typecheck passed, ran tests');
    expect(summarizeOutcome([bash('a', 'npm test -w frontend -- src/a.test.ts'), bash('b', 'npm test -w backend -- test/chatHub.replay.test.ts')]).lead)
      .toBe('a.test.ts and chatHub.replay.test.ts passed');
  });

  it('joins with one "and", and drops the lowest rank first when fitting', () => {
    expect(joinSentence(['Read a.ts', 'Ran tests'])).toBe('Read a.ts and ran tests');
    expect(joinSentence(['Read a.ts', 'Edited b.ts and c.ts', 'Ran tests'])).toBe('Read a.ts, edited b.ts and c.ts, ran tests');
    expect(joinSentence(['Merged origin/dev'], 3)).toBe(`Merged origin/dev${NB}+3`);
    const phrases = [{ text: 'Read 3 files', rank: 0 }, { text: 'Ran tests', rank: 1 }, { text: 'Searched x', rank: 0 }, { text: 'Pushed dev', rank: 2 }];
    expect(capPhrases(phrases, 2)).toEqual({ kept: [phrases[1], phrases[3]], dropped: 2 });
    expect(capPhrases(phrases, 0).kept).toEqual([phrases[3]]);
  });

  it('names two objects of one verb and counts three or more; one call is its own phrase', () => {
    expect(toolRecord([file('1', 'read', 'a.ts'), file('2', 'read', 'b.ts')])).toBe('read a.ts and b.ts');
    expect(toolRecord([file('1', 'read', 'a.ts'), file('2', 'read', 'b.ts'), file('3', 'read', 'c.ts')])).toBe(`read 3${NB}files`);
    expect(summarizeOutcome([bash('1', 'ls -la', 'List the workspace')])).toMatchObject({ lead: 'List the workspace', rest: '' });
  });

  it('folds counted groups of one kind into one phrase, whatever their verbs', () => {
    const searches = ['a', 'b', 'c'].map((x) => bash(`s${x}`, `./find.sh ${x}`, `Search for ${x}`));
    const prints = ['a', 'b', 'c', 'd'].map((x) => bash(`p${x}`, `./print.sh ${x}`, `Print ${x}`));
    const reads = [file('r1', 'read', 'a.ts'), file('r2', 'read', 'b.ts')];
    expect(toolRecord([...searches, ...reads, ...prints])).toBe(`ran 7${NB}commands, read a.ts and b.ts`);
    // The agent's words are counted with their kind past two, named as said up to two.
    expect(toolRecord([...searches, ...prints.slice(0, 2)])).toBe(`ran 5${NB}commands`);
    expect(toolRecord([...reads, ...prints.slice(0, 2)])).toBe(`read a.ts and b.ts${NB}· Print a${NB}· Print b`);
  });

  it('skips hidden plumbing tools', () => {
    const hidden: ToolCallState = { id: 'h', title: 'mcp____michi_internal____set_follow_ups', status: 'completed' };
    expect(summarizeOutcome([hidden, file('1', 'read', 'a.ts')])).toMatchObject({ lead: 'Read a.ts', rest: '' });
  });
});

describe('thought sentences', () => {
  it('previews the sentence being written, per finished clause, never mid-token', () => {
    expect(thoughtPreview('用户要把它合进 dev 再 push。先确认 origin/dev 有没有新提交')).toBe('用户要把它合进 dev 再 push。');
    expect(thoughtPreview('用户要把它合进 dev 再 push。先确认 origin/dev 有没有新提交——如果有，得先')).toBe('先确认 origin/dev 有没有新提交——如果有');
    expect(thoughtPreview('Check the merge first, then')).toBe('Check the merge first');
    expect(thoughtPreview('Version 3.5 is')).toBeUndefined();
    expect(thoughtPreview('**Planning**\n\nLook at')).toBe('Planning');
  });

  it('concludes with the last sentence unless it is a question', () => {
    expect(thoughtConclusion('先确认 origin/dev。测试只挑和发送动效有关的：typecheck、send-scroll E2E。')).toBe('测试只挑和发送动效有关的：typecheck、send-scroll E2E。');
    expect(thoughtConclusion('First merge. Then run the tests')).toBe('Then run the tests');
    expect(thoughtConclusion('Merged cleanly. Should I push now?')).toBeUndefined();
  });
});

describe('durations', () => {
  it('spells durations out for screen readers and keeps live time in whole seconds', () => {
    expect(spokenDurationMs(3_800)).toBe('3.8 seconds');
    expect(spokenDurationMs(131_000)).toBe('2 minutes 11 seconds');
    expect(spokenDurationMs(12_900, true)).toBe('12 seconds');
    expect(formatElapsedMs(12_900)).toBe('12s');
    expect(formatElapsedMs(72_000)).toBe('1m 12s');
  });

  it('never carries a rounded second into 60s', () => {
    expect(formatDurationMs(119_600)).toBe('2m');
    expect(spokenDurationMs(119_600)).toBe('2 minutes');
    expect(formatDurationMs(59_600)).toBe('1m');
    expect(formatDurationMs(9_960)).toBe('10s');
    expect(formatDurationMs(3_900_000)).toBe('1h 5m');
  });
});

/* ── One classifier for every chrome ── */

import { payloadSubject, toolKind } from './toolCallGrouping';

describe('toolKind', () => {
  // Shapes as the runtimes send them: Kiro's File Search (kind search, {query}),
  // Pi's tools (kind execute for every tool, the tool's name as title).
  const kiroSearch = (id: string, query: string): ToolCallState =>
    ({ id, title: 'File Search', kind: 'search', status: 'completed', inputJson: JSON.stringify({ explanation: 'Look', query }) });
  const pi = (id: string, title: string, input: Record<string, unknown>): ToolCallState =>
    ({ id, title, kind: 'execute', status: 'completed', inputJson: JSON.stringify(input) });

  it('classifies a call the same way for its words, its counts and its icon', () => {
    expect(toolKind(kiroSearch('1', '.json'))).toBe('grep');
    expect(toolKind(pi('2', 'ls', { path: 'src' }))).toBe('glob');
    expect(toolKind(pi('3', 'web_search', { query: 'vitest' }))).toBe('unknown');
    expect(toolKind(pi('4', 'bash', { command: 'git status' }))).toBe('bash');
    expect(toolKind({ id: '5', title: 'Creating a.ts', kind: 'edit', status: 'completed', inputJson: JSON.stringify({ command: 'create', path: 'a.ts', content: 'x' }) })).toBe('write');
  });

  it('counts calls by the kind their words use', () => {
    expect(summarizeWork([kiroSearch('1', '.json'), kiroSearch('2', 'note.md')]).text).toBe('Searched 2 patterns');
    expect(summarizeWork([pi('1', 'web_search', { query: 'a' }), pi('2', 'web_search', { query: 'b' }), pi('3', 'web_search', { query: 'c' })]).text).toBe('Used 3 tools');
    expect(summarizeToolsBase([pi('1', 'ls', { path: 'src' }), pi('2', 'find', { path: '.', pattern: '*.ts' })])).toBe('listed 2 paths');
  });

  it('sees a later listing of the same path recover a failed one', () => {
    const failed: ToolCallState = { ...pi('1', 'ls', { path: 'src' }), status: 'error' };
    expect([...findRecoveries([failed, pi('2', 'ls', { path: 'src' })])]).toEqual([['1', '2']]);
  });
});

describe('payloadSubject', () => {
  it('names what a call touched by its kind', () => {
    expect(payloadSubject({ id: '1', title: 'Bash', kind: 'tool', status: 'completed', inputJson: JSON.stringify({ command: 'ls -la' }) }))
      .toEqual({ kind: 'command', text: 'ls -la' });
    expect(payloadSubject({ id: '2', title: 'File Search', kind: 'search', status: 'completed', inputJson: JSON.stringify({ query: '.json', path: 'src' }) }))
      .toEqual({ kind: 'pattern', text: '.json', within: 'src' });
    expect(payloadSubject({ id: '3', title: 'Reading a.ts', kind: 'read', status: 'completed', inputJson: JSON.stringify({ operations: [{ mode: 'Line', path: '/r/a.ts' }] }) }))
      .toEqual({ kind: 'path', text: '/r/a.ts' });
  });

  it('never calls a query or a URL a path', () => {
    expect(payloadSubject({ id: '1', title: 'WebSearch', kind: 'tool', status: 'completed', inputJson: JSON.stringify({ query: 'vitest fake timers' }) }))
      .toEqual({ kind: 'detail', text: 'vitest fake timers' });
    expect(payloadSubject({ id: '2', title: 'web_search', kind: 'execute', status: 'completed', inputJson: JSON.stringify({ query: 'react 19' }) }))
      .toEqual({ kind: 'detail', text: 'react 19' });
  });
});
