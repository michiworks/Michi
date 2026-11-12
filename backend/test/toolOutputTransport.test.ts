import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatStreamEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveMessage, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { chatHub } from '../src/agents/chatHub';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import {
  FILE_MUTATION_WORDS, PARSED_INPUT_TOOLS, PARSED_OUTPUT_TOOLS, TOOL_NAME_SEPARATORS, TOOL_OUTPUT_TRANSPORT_LIMIT, WHOLE_INPUT_KEYS,
  WRAPPER_TOOLS, createToolOutputStreamProjector, headTailOutput, isParsedInputTool, isParsedOutputTool,
  projectMessageRowsForTransport, projectToolInput, projectToolOutput,
} from '../src/routes/toolOutputTransport';

const MARKER = /\n… \[(\d+) chars omitted\] …\n/;
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(30_000, 4)]).toString('base64');
/** A Claude Read output as the 16 KB cap stored it: cut inside the image, not valid JSON. */
const CUT_IMAGE = `[{"type":"image","source":{"type":"base64","data":"${PNG}`.slice(0, 16 * 1024);
const IMAGE_PLACEHOLDER_OUTPUT = '[{"type":"image","source":{"type":"base64","data":"[image image/png omitted]"}}]';
const LONG_LOG = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
const PAGE_RECEIPT = JSON.stringify({ michiPageWrite: { resourceKind: 'page', resourceId: 'pg', changes: Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, seq: i })) } });
const WORKFLOW_INPUT = JSON.stringify({ name: 'review', script: LONG_LOG, args: [{ note: LONG_LOG, n: 1 }, 'short'], dryRun: false });
const WRITE_INPUT = JSON.stringify({ file_path: '/repo/a.ts', content: LONG_LOG });
const BASH_INPUT = JSON.stringify({ command: LONG_LOG, description: 'd'.repeat(3000) });

describe('head + tail projection', () => {
  test('leaves outputs up to the limit alone and cuts longer ones at nearby newlines', () => {
    const atLimit = 'a'.repeat(TOOL_OUTPUT_TRANSPORT_LIMIT);
    assert.equal(headTailOutput(atLimit), atLimit);
    const projected = headTailOutput(LONG_LOG);
    const [head, tail] = projected.split(MARKER.exec(projected)![0]);
    assert.ok(LONG_LOG.startsWith(head) && LONG_LOG.endsWith(tail));
    assert.ok(head.length <= 1024 && head.length > 1024 - 256);
    assert.ok(tail.length <= 1024 && tail.length > 1024 - 256);
    assert.ok(LONG_LOG.slice(head.length).startsWith('\n') && LONG_LOG.at(-tail.length - 1) === '\n', 'whole lines on both sides');
    assert.equal(Number(MARKER.exec(projected)![1]), LONG_LOG.length - head.length - tail.length);
  });

  test('cuts a text without newlines at 1 KB each side and never splits a surrogate pair', () => {
    const plain = 'b'.repeat(5000);
    assert.equal(headTailOutput(plain), `${'b'.repeat(1024)}\n… [2952 chars omitted] …\n${'b'.repeat(1024)}`);
    // One leading or trailing ASCII character puts a pair across each 1 KB cut.
    const parts = (text: string) => { const projected = headTailOutput(text); return { projected, cut: projected.split(MARKER.exec(projected)![0]) }; };
    const lead = parts(`a${'😀'.repeat(3000)}`);
    assert.equal(lead.cut[0], `a${'😀'.repeat(511)}`);
    assert.equal(lead.cut[1], '😀'.repeat(512));
    const trail = parts(`${'😀'.repeat(3000)}a`);
    assert.equal(trail.cut[0], '😀'.repeat(512));
    assert.equal(trail.cut[1], `${'😀'.repeat(511)}a`);
    for (const { projected } of [lead, trail]) {
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(projected), 'no lone surrogate');
    }
  });

  test('recognizes the parsed tools under every title form the runtimes store', () => {
    for (const title of ['edit_page', 'mcp__michi_internal__edit_page', 'mcp____michi_internal____spawn_branches__edit_page',
      'mcp____michi_internal____edit_page', '@michi/edit_page', 'Running: @michi/edit_page', 'michi.edit_page', 'michi:edit_page',
      ' Edit_Page ', 'mcp__michi_internal__create_scheduled_job', '@michi/start_conversation',
      'mcp____michi_internal____propose_multi_model_plan', 'Completed: @michi/propose_multi_model_plan', 'propose_multi_model_plan']) {
      assert.equal(isParsedOutputTool(title), true, title);
    }
    for (const title of ['Read', 'Bash', 'edit_page_v2', 'my_edit_page', 'edit page', '', undefined, 42, 'Running: ls']) {
      assert.equal(isParsedOutputTool(title), false, String(title));
    }
  });

  test('projects images first, then length, and passes parsed tools whole', () => {
    assert.equal(projectToolOutput(CUT_IMAGE, ['Read']), IMAGE_PLACEHOLDER_OUTPUT);
    assert.match(projectToolOutput(LONG_LOG, ['Bash']), MARKER);
    assert.equal(projectToolOutput(PAGE_RECEIPT, ['mcp__michi_internal__edit_page']), PAGE_RECEIPT);
    assert.equal(projectToolOutput(PAGE_RECEIPT, ['', 'edit_page']), PAGE_RECEIPT, 'any of its names counts');
    assert.equal(projectToolOutput('short', ['Bash']), 'short');
  });

  test("passes Crew's michi_call_tool whole only when it wraps a parsed tool or does not name one", () => {
    const crew = 'mcp:michi-crew-runtime:michi_call_tool';
    const wraps = (tool: string) => JSON.stringify({ tool, arguments: { id: 'x' } });
    assert.equal(projectToolOutput(PAGE_RECEIPT, [crew], wraps('propose_multi_model_plan')), PAGE_RECEIPT);
    assert.equal(projectToolOutput(PAGE_RECEIPT, ['michi_call_tool'], wraps('edit_page')), PAGE_RECEIPT);
    assert.match(projectToolOutput(LONG_LOG, [crew], wraps('wait_agent')), MARKER);
    assert.match(projectToolOutput(LONG_LOG, [crew], wraps('michi_skills')), MARKER);
    assert.match(projectToolOutput(LONG_LOG, [crew], `{"tool":"memory_search","arguments":{"q":"${'y'.repeat(100)}`), MARKER, 'a capped input still names it');
    assert.equal(projectToolOutput(PAGE_RECEIPT, [crew], `{"tool":"read_page","arguments":{"q":"${'y'.repeat(100)}`), PAGE_RECEIPT);
    assert.equal(projectToolOutput(LONG_LOG, [crew]), LONG_LOG, 'without an input the frontend matches the wrapper itself');
    assert.match(projectToolOutput(LONG_LOG, ['Bash'], wraps('edit_page')), MARKER, 'only a wrapper is unwrapped');
  });
});

describe('input projection', () => {
  test('cuts long string values and keeps keys, structure and short values: still valid JSON', () => {
    const projected = projectToolInput(WORKFLOW_INPUT, ['Workflow'], 'tool');
    const input = JSON.parse(projected) as { name: string; script: string; args: [{ note: string; n: number }, string]; dryRun: boolean };
    assert.equal(input.name, 'review');
    assert.equal(input.script, headTailOutput(LONG_LOG));
    assert.match(input.script, MARKER);
    assert.deepEqual(input.args, [{ note: headTailOutput(LONG_LOG), n: 1 }, 'short']);
    assert.equal(input.dryRun, false);
    assert.ok(projected.length < WORKFLOW_INPUT.length / 2);
  });

  test('passes whole: short or invalid JSON, file writes and edits, the parsed tools', () => {
    const atLimit = JSON.stringify({ script: 'a'.repeat(TOOL_OUTPUT_TRANSPORT_LIMIT - 20) });
    assert.equal(projectToolInput(atLimit, ['Workflow']), atLimit);
    const cut = WORKFLOW_INPUT.slice(0, 4000);
    assert.equal(projectToolInput(cut, ['Workflow']), cut, 'a capped, unparseable input stays as stored');
    for (const title of ['Write', 'Write a.ts', 'Writing quicksort.py', 'Edit', 'Edit 3 files', 'Editing Topbar.tsx', ' edit ',
      'MultiEdit', 'NotebookEdit', 'mcp__michi_internal__edit_page', '@michi/save_page_component']) {
      assert.equal(projectToolInput(WRITE_INPUT, [title], 'tool'), WRITE_INPUT, title);
    }
    for (const kind of ['edit', 'write', ' Edit ']) assert.equal(projectToolInput(WRITE_INPUT, ['Creating a.ts'], kind), WRITE_INPUT, kind);
    assert.equal(projectToolInput(WRITE_INPUT, ['', 'Write'], undefined), WRITE_INPUT, 'any of its names counts');
    assert.notEqual(projectToolInput(WRITE_INPUT, ['Read'], 'read'), WRITE_INPUT);
    for (const title of ['Bash', 'Workflow', 'Writer', 'rewrite', 'Task', '', undefined]) assert.equal(isParsedInputTool(title, 'tool'), false, String(title));
  });

  test("passes Crew's michi_call_tool input whole only when it wraps a parsed tool or does not name one", () => {
    const crew = 'mcp:michi-crew-runtime:michi_call_tool';
    const wraps = (tool: string) => JSON.stringify({ tool, arguments: { content: LONG_LOG } });
    for (const tool of ['create_page', 'propose_multi_model_plan']) assert.equal(projectToolInput(wraps(tool), [crew]), wraps(tool), tool);
    const bare = JSON.stringify({ arguments: { content: LONG_LOG } });
    assert.equal(projectToolInput(bare, ['michi_call_tool']), bare, 'without a tool the frontend matches the wrapper itself');
    const cut = JSON.parse(projectToolInput(wraps('wait_agent'), [crew]));
    assert.equal(cut.tool, 'wait_agent', 'the frontend still finds the wrapped tool');
    assert.match(cut.arguments.content, MARKER);
    assert.notEqual(projectToolInput(wraps('create_page'), ['Workflow']), wraps('create_page'), 'only a wrapper is unwrapped');
  });

  test('keeps a command and an unparsed raw input whole in any tool', () => {
    const projected = JSON.parse(projectToolInput(BASH_INPUT, ['Bash'], 'execute')) as { command: string; description: string };
    assert.equal(projected.command, LONG_LOG, 'the window shows and copies the command as typed');
    assert.match(projected.description, MARKER);
    const codex = JSON.stringify({ cmd: LONG_LOG });
    assert.equal(projectToolInput(codex, ['npm test']), codex);
    const raw = JSON.stringify({ __unparsedToolInput: { raw: `{"command":"${'x'.repeat(4000)}` } });
    assert.equal(projectToolInput(raw, ['Bash']), raw);
  });
});

describe('frontend parser contract', () => {
  const frontendSrc = path.resolve(__dirname, '..', '..', 'frontend', 'src');
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
  const strings = (text: string) => [...text.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)].map((m) => m[1] ?? m[2]);

  test('every tool a frontend parser names by normalizeTurnToolName/toolMatch/michiToolNamed is passed whole', () => {
    const named = new Map<string, string>();
    let calls = 0;
    for (const file of sources(frontendSrc)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const call of text.matchAll(/\b(?:normalizeTurnToolName|toolMatch|michiToolNamed)\(\s*[\w.?]+\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*\)/g)) {
        calls++;
        const arg = call[1];
        let list: string;
        if (arg.startsWith('[')) list = arg;
        else {
          const declaration = new RegExp(`\\bconst ${arg}\\b[^=]*=\\s*(\\[[\\s\\S]*?\\])`).exec(text);
          // turnPageReceipt's own normalizeTurnToolName passes its `names` parameter through.
          if (!declaration && arg === 'names' && file.endsWith(path.join('lib', 'turnPageReceipt.ts'))) continue;
          assert.ok(declaration, `${path.relative(frontendSrc, file)}: cannot resolve tool names ${arg}`);
          list = declaration[1];
        }
        for (const name of strings(list)) named.set(name, path.relative(frontendSrc, file));
      }
    }
    assert.ok(calls >= 8, `found only ${calls} parser call sites; did the matcher change?`);
    for (const expected of ['edit_page', 'open_task_database', 'save_page_component', 'start_conversation', 'layout_rules', 'create_scheduled_job']) {
      assert.ok(named.has(expected), `expected the parsers to name ${expected}`);
    }
    for (const [name, file] of named) {
      // A wrapper is unwrapped by its input: its output passes whole only for a parsed tool it wraps.
      assert.ok(PARSED_OUTPUT_TOOLS.has(name) || WRAPPER_TOOLS.has(name), `${file} parses ${name}'s output; add it to PARSED_OUTPUT_TOOLS`);
      if (!WRAPPER_TOOLS.has(name)) assert.ok(isParsedOutputTool(`mcp__michi_internal__${name}`));
    }
  });

  test("the title rule matches the frontend's toolMatch", () => {
    const text = fs.readFileSync(path.join(frontendSrc, 'lib', 'turnPageReceipt.ts'), 'utf8');
    const body = /function toolMatch\([\s\S]*?\n}/.exec(text)?.[0] ?? '';
    assert.match(body, /normalized === name/);
    assert.match(body, /\.trim\(\)\.toLowerCase\(\)/);
    const separators = [...body.matchAll(/endsWith\(`([^`$]*)\$\{name\}`\)/g)].map((m) => m[1]);
    assert.ok(separators.length >= 4);
    for (const separator of separators) {
      assert.ok(TOOL_NAME_SEPARATORS.some((ours) => separator.endsWith(ours)), `frontend separator ${separator}`);
    }
    for (const ours of TOOL_NAME_SEPARATORS) assert.ok(separators.includes(ours), `backend separator ${ours}`);
  });

  test('every tool a parser of tool inputs names is passed whole', () => {
    let files = 0;
    for (const file of sources(frontendSrc)) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/\binputJson\b/.test(text)) continue;
      for (const call of text.matchAll(/\b(?:normalizeTurnToolName|toolMatch|michiToolNamed)\(\s*[\w.?]+\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*\)/g)) {
        const arg = call[1];
        const list = arg.startsWith('[') ? arg : new RegExp(`\\bconst ${arg}\\b[^=]*=\\s*(\\[[\\s\\S]*?\\])`).exec(text)?.[1];
        if (!list) continue;
        files++;
        for (const name of strings(list)) {
          // A wrapper is unwrapped by its input: its input passes whole only for a parsed tool it wraps.
          if (WRAPPER_TOOLS.has(name)) continue;
          assert.ok(PARSED_INPUT_TOOLS.has(name), `${path.relative(frontendSrc, file)} reads ${name}'s input; add it to PARSED_INPUT_TOOLS`);
          assert.ok(isParsedInputTool(`mcp__michi_internal__${name}`));
        }
      }
    }
    assert.ok(files >= 1, 'found no parser of tool inputs; did the matcher change?');
    for (const name of PARSED_OUTPUT_TOOLS) assert.ok(PARSED_INPUT_TOOLS.has(name), name);
  });

  test('file writes and edits are named by the rules of the diff receipt and the step lines', () => {
    const receipt = fs.readFileSync(path.join(frontendSrc, 'lib', 'turnDiffReceipt.ts'), 'utf8');
    const mutation = /function mutationKind\([\s\S]*?\n}/.exec(receipt)?.[0] ?? '';
    const words = [...mutation.matchAll(/t === '(\w+)'|t\.startsWith\('(\w+) '\)/g)].map((m) => m[1] ?? m[2]);
    assert.ok(words.length >= 6, `mutationKind words: ${words.join(', ')}`);
    for (const word of words) assert.ok(FILE_MUTATION_WORDS.has(word), `turnDiffReceipt counts lines of ${word}; add it to FILE_MUTATION_WORDS`);
    const grouping = ['toolStep.ts', 'toolKind.ts'].map((file) => fs.readFileSync(path.join(frontendSrc, 'components', 'terminal', 'toolCallGrouping', file), 'utf8')).join('\n');
    const step = /export function stepDetail\([\s\S]*?\n}/.exec(grouping)?.[0] ?? '';
    const kinds = [...step.matchAll(/kind === '(\w+)'/g)].map((m) => m[1]);
    assert.ok(step.includes('editLineDelta(') && kinds.includes('edit') && kinds.includes('write'), 'stepDetail counts edit and write lines');
    for (const kind of ['edit', 'write']) {
      assert.ok(FILE_MUTATION_WORDS.has(kind));
      assert.match(grouping, new RegExp(`\\b${kind}:\\s*\\{ verb:`), `BUCKETS still holds ${kind}`);
    }
  });

  test('the input keys a window reads whole travel whole', () => {
    const grouping = fs.readFileSync(path.join(frontendSrc, 'components', 'terminal', 'toolCallGrouping', 'toolInput.ts'), 'utf8');
    const command = /export function toolCommand\([\s\S]*?\n}/.exec(grouping)?.[0] ?? '';
    const keys = [...command.matchAll(/obj\?\.(\w+)/g)].map((m) => m[1]);
    assert.ok(keys.length >= 2, `toolCommand keys: ${keys.join(', ')}`);
    for (const key of keys) assert.ok(WHOLE_INPUT_KEYS.has(key), `toolCommand reads ${key}; add it to WHOLE_INPUT_KEYS`);
    const unparsed = /obj\?\.(__\w+)/.exec(/function inputField\([\s\S]*?\n}/.exec(grouping)?.[0] ?? '')?.[1];
    assert.ok(unparsed && WHOLE_INPUT_KEYS.has(unparsed), `inputField parses ${unparsed} itself`);
  });
});

describe('stream projector', () => {
  const frame = (event: 'tool_call' | 'tool_call_update', data: Record<string, unknown>) =>
    ({ event, data: { chatId: 'n', status: 'completed', ...data } }) as ChatStreamEvent;

  test('remembers each call title, so an untitled update with output is projected by its tool', () => {
    const project = createToolOutputStreamProjector();
    const events = [
      frame('tool_call', { toolCallId: 'bash', title: 'Bash' }),
      frame('tool_call_update', { toolCallId: 'bash', title: '', output: LONG_LOG }),
      frame('tool_call', { toolCallId: 'page', title: 'mcp__michi_internal__edit_page' }),
      frame('tool_call_update', { toolCallId: 'page', title: '', output: PAGE_RECEIPT }),
      frame('tool_call_update', { toolCallId: 'unseen', title: '', output: LONG_LOG }),
      frame('tool_call_update', { toolCallId: 'image', title: '', output: CUT_IMAGE }),
      { event: 'chunk', data: { chatId: 'n', text: LONG_LOG } } as ChatStreamEvent,
    ];
    const copies = structuredClone(events);
    const out = events.map(project);
    assert.deepEqual(events, copies, 'the hub event is never mutated');
    const outputOf = (i: number) => (out[i].data as { output?: string }).output;
    assert.match(outputOf(1)!, MARKER);
    assert.equal(out[3], events[3], 'a parsed tool passes whole');
    assert.equal(out[4], events[4], 'a call whose title the stream never saw passes whole');
    assert.equal(outputOf(5), IMAGE_PLACEHOLDER_OUTPUT, 'images are always replaced');
    assert.equal(out[6], events[6]);
  });

  test("unwraps Crew's michi_call_tool by the input the call or an update carried", () => {
    const project = createToolOutputStreamProjector();
    const crew = 'mcp:michi-crew-runtime:michi_call_tool';
    const outputOf = (event: ChatStreamEvent) => (project(event).data as { output?: string }).output;
    project(frame('tool_call', { toolCallId: 'wait', title: crew, inputJson: JSON.stringify({ tool: 'wait_agent', arguments: {} }) }));
    assert.match(outputOf(frame('tool_call_update', { toolCallId: 'wait', title: crew, output: LONG_LOG }))!, MARKER);
    project(frame('tool_call', { toolCallId: 'plan', title: crew }));
    project(frame('tool_call_update', { toolCallId: 'plan', title: '', inputJson: JSON.stringify({ tool: 'propose_multi_model_plan', arguments: {} }) }));
    assert.equal(outputOf(frame('tool_call_update', { toolCallId: 'plan', title: '', output: PAGE_RECEIPT })), PAGE_RECEIPT);
    project(frame('tool_call', { toolCallId: 'bare', title: crew }));
    assert.equal(outputOf(frame('tool_call_update', { toolCallId: 'bare', title: crew, output: LONG_LOG })), LONG_LOG, 'no input yet: whole');
    const inputOf = (event: ChatStreamEvent) => (project(event).data as { inputJson?: string }).inputJson;
    const page = JSON.stringify({ tool: 'create_page', arguments: { content: LONG_LOG } });
    assert.equal(inputOf(frame('tool_call', { toolCallId: 'page', title: crew, inputJson: page })), page, 'a wrapped parsed tool keeps its input');
    const wait = JSON.stringify({ tool: 'wait_agent', arguments: { note: LONG_LOG } });
    assert.match(JSON.parse(inputOf(frame('tool_call_update', { toolCallId: 'wait', title: '', inputJson: wait }))!).arguments.note, MARKER);
  });

  test('projects inputs by the call\'s remembered title and kind', () => {
    const project = createToolOutputStreamProjector();
    const inputOf = (event: ChatStreamEvent) => (event.data as { inputJson?: string }).inputJson;
    const workflow = project(frame('tool_call', { toolCallId: 'wf', title: 'Workflow', inputJson: WORKFLOW_INPUT }));
    assert.match(JSON.parse(inputOf(workflow)!).script, MARKER);
    const later = project(frame('tool_call_update', { toolCallId: 'wf', title: '', inputJson: WORKFLOW_INPUT }));
    assert.match(JSON.parse(inputOf(later)!).script, MARKER, 'an untitled update of a known call');
    const write = frame('tool_call', { toolCallId: 'w', title: 'Write', inputJson: WRITE_INPUT });
    assert.equal(project(write), write);
    const kiro = frame('tool_call', { toolCallId: 'k', title: 'Creating a.ts', kind: 'edit', inputJson: WRITE_INPUT });
    assert.equal(project(kiro), kiro);
    project(frame('tool_call', { toolCallId: 'late-kind', title: 'Creating b.ts' }));
    const edit = frame('tool_call_update', { toolCallId: 'late-kind', title: '', kind: 'edit', inputJson: WRITE_INPUT });
    assert.equal(project(edit), edit, 'a kind that arrives later still counts');
    const unseen = frame('tool_call_update', { toolCallId: 'unseen', title: '', inputJson: WORKFLOW_INPUT });
    assert.equal(project(unseen), unseen, 'a call whose title the stream never saw passes whole');
  });

  test('keys calls by chat, so the background feed keeps chats apart', () => {
    const project = createToolOutputStreamProjector();
    project(frame('tool_call', { chatId: 'a', toolCallId: 't1', title: 'mcp__michi_internal__read_page' }));
    project(frame('tool_call', { chatId: 'b', toolCallId: 't1', title: 'Bash' }));
    assert.equal((project(frame('tool_call_update', { chatId: 'a', toolCallId: 't1', title: '', output: LONG_LOG })).data as { output: string }).output, LONG_LOG);
    assert.match((project(frame('tool_call_update', { chatId: 'b', toolCallId: 't1', title: '', output: LONG_LOG })).data as { output: string }).output, MARKER);
  });
});

describe('HTTP writers', () => {
  let server: Server;
  let base: string;
  const toolCalls = JSON.stringify([
    { id: 'img', title: 'Read', status: 'completed', output: CUT_IMAGE },
    { id: 'log', title: 'Bash', status: 'completed', inputJson: LONG_LOG, output: LONG_LOG },
    { id: 'page', title: 'mcp____michi_internal____edit_page', status: 'completed', output: PAGE_RECEIPT },
    { id: 'short', title: 'Bash', status: 'completed', output: 'ok' },
    { id: 'object', title: 'Bash', status: 'completed', output: { kept: true } },
    { id: 'workflow', title: 'Workflow', kind: 'tool', status: 'completed', inputJson: WORKFLOW_INPUT },
    { id: 'write', title: 'Write', kind: 'tool', status: 'completed', inputJson: WRITE_INPUT },
    { id: 'bash-long', title: 'Bash', kind: 'tool', status: 'completed', inputJson: BASH_INPUT },
  ]);
  const storedRows = () => JSON.stringify(getDb().prepare('SELECT * FROM messages ORDER BY id').all());
  let stored: string;

  before(async () => {
    closeDb(); initDb();
    saveWorkspace({ id: 'ws', name: 'ws', created_at: 1, updated_at: 1 });
    saveTree({ id: 'tree', workspace_id: 'ws', root_node_id: 'node', last_active_at: 1, created_at: 1 });
    saveNode({ id: 'node', workspace_id: 'ws', tree_id: 'tree', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    saveMessage({ id: 'm-user', node_id: 'node', role: 'user', content: 'go', seq: 0, created_at: 1 });
    saveMessage({ id: 'm-tools', node_id: 'node', role: 'assistant', content: 'done', tool_calls: toolCalls, seq: 1, created_at: 2 });
    saveMessage({ id: 'm-small', node_id: 'node', role: 'assistant', content: 'x', tool_calls: '[{"id":"a","title":"Bash","output":"hi"}]', seq: 2, created_at: 3 });
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, assistant_message_id, status, last_seq, started_at, completed_at, updated_at)
      VALUES ('turn-1', 'node', 'm-tools', 'completed', 4, 1, 2, 2)`).run();
    stored = storedRows();
    const app = express(); app.use(express.json());
    app.use('/api', setupPersistenceRoutes());
    app.use('/api', setupMichiRoutes({} as ChatManager));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
  });

  function assertProjected(messages: Array<{ id: string; tool_calls?: string | null }>) {
    const row = messages.find((m) => m.id === 'm-tools')!;
    assert.equal(typeof row.tool_calls, 'string', 'tool_calls stays an encoded JSON string');
    const calls = JSON.parse(row.tool_calls!) as Array<Record<string, unknown>>;
    assert.equal(calls[0].output, IMAGE_PLACEHOLDER_OUTPUT);
    assert.match(calls[1].output as string, MARKER);
    assert.equal(calls[1].inputJson, LONG_LOG, 'an input that is not JSON is untouched');
    assert.equal(calls[2].output, PAGE_RECEIPT);
    assert.equal(calls[3].output, 'ok');
    assert.deepEqual(calls[4].output, { kept: true });
    assert.match(JSON.parse(calls[5].inputJson as string).script, MARKER);
    assert.equal(calls[6].inputJson, WRITE_INPUT, 'a write keeps its content for the diff receipt');
    assert.equal(JSON.parse(calls[7].inputJson as string).command, LONG_LOG);
    assert.equal(messages.find((m) => m.id === 'm-small')!.tool_calls, '[{"id":"a","title":"Bash","output":"hi"}]');
  }

  test('tree messages (snapshot and paged), the full workspace and /workspaces/all send projected outputs; stored rows stay whole', async () => {
    const snapshot = await (await fetch(`${base}/workspaces/ws/trees/tree/messages`)).json() as { messages: Array<{ id: string; tool_calls: string }> };
    assertProjected(snapshot.messages);
    const page = await (await fetch(`${base}/workspaces/ws/trees/tree/messages?limit=50`)).json() as { messages: Array<{ id: string; tool_calls: string }>; pages: unknown[] };
    assertProjected(page.messages);
    assert.equal(page.pages.length, 1);
    const workspace = await (await fetch(`${base}/workspaces/ws`)).json() as { messages: Array<{ id: string; tool_calls: string }> };
    assertProjected(workspace.messages);
    const all = await (await fetch(`${base}/workspaces/all`)).json() as { workspaces: Array<{ messages: Array<{ id: string; tool_calls: string }> }> };
    assertProjected(all.workspaces[0].messages);
    const turn = await (await fetch(`${base}/chats/node/turns/turn-1`)).json() as { message: { id: string; tool_calls: string } };
    assertProjected([turn.message, { id: 'm-small', tool_calls: '[{"id":"a","title":"Bash","output":"hi"}]' }]);
    assert.equal(storedRows(), stored, 'no stored row changes');
  });

  test('message rows without long outputs are returned as they are', () => {
    const rows = [{ id: 'a', tool_calls: null }, { id: 'b', tool_calls: '[{"output":"hi"}]' }, { id: 'c', tool_calls: `not json ${'x'.repeat(3000)}` }];
    const projected = projectMessageRowsForTransport(rows);
    rows.forEach((row, i) => assert.equal(projected[i], row));
  });

  async function readUntil(response: Response, marker: string): Promise<string> {
    const reader = response.body!.getReader();
    let body = '';
    while (!body.includes(marker)) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      body += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return body;
  }
  const frames = (body: string) => body.trim().split('\n\n').map((frame) => {
    const [event, data] = frame.split('\n');
    return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) };
  });
  const tool = (event: 'tool_call' | 'tool_call_update', toolCallId: string, title: string, output?: string) =>
    ({ event, data: { chatId: 'node', nodeId: 'node', turnId: 'turn-1', seq: 1, toolCallId, title, status: 'completed', ...(output ? { output } : {}) } }) as ChatStreamEvent;

  test('the background feed projects its self-turn frames and foreground envelopes, not the hub events', async (t) => {
    const sent = [
      tool('tool_call', 'bash', 'Bash'), tool('tool_call_update', 'bash', '', LONG_LOG),
      tool('tool_call', 'page', '@michi/edit_page'), tool('tool_call_update', 'page', '', PAGE_RECEIPT),
      tool('tool_call_update', 'img', 'Read', CUT_IMAGE),
    ];
    const copies = structuredClone(sent);
    const subscribe = t.mock.method(chatHub, 'subscribeBackground', (sub: Parameters<typeof chatHub.subscribeBackground>[0]) => {
      sent.forEach((event, i) => sub.send('node', event, i % 2 === 0));
      sub.send('node', { event: 'chunk', data: { chatId: 'node', nodeId: 'node', turnId: 'turn-1', seq: 2, text: 'end-of-test' } }, true);
      return () => {};
    });
    t.after(() => subscribe.mock.restore());
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${base}/chats/background/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeForeground: true, cursors: {} }), signal: controller.signal,
    });
    const received = frames(await readUntil(response, 'end-of-test'));
    assert.deepEqual(sent, copies);
    const update = (i: number) => (received[i].event === 'foreground_event' ? received[i].data.data : received[i].data) as { output?: string };
    assert.equal(received[1].event, 'foreground_event');
    assert.match(update(1).output!, MARKER);
    assert.equal(update(3).output, PAGE_RECEIPT);
    assert.equal(update(4).output, IMAGE_PLACEHOLDER_OUTPUT);
  });

  test('the turn replay stream projects the frames it writes', async (t) => {
    const subscribe = t.mock.method(chatHub, 'subscribeTurn', (_nodeId: string, _turnId: string, sub: { send: (ev: ChatStreamEvent) => void }) => {
      sub.send(tool('tool_call', 'bash', 'Bash'));
      sub.send(tool('tool_call_update', 'bash', '', LONG_LOG));
      sub.send(tool('tool_call_update', 'later', '', LONG_LOG));
      sub.send({ event: 'done', data: { chatId: 'node', nodeId: 'node', turnId: 'turn-1', seq: 3 } } as ChatStreamEvent);
      return () => {};
    });
    t.after(() => subscribe.mock.restore());
    const response = await fetch(`${base}/chats/node/stream?fromTurnId=turn-1&fromSeq=0`);
    assert.equal(response.status, 200);
    const received = frames(await response.text()).filter((frame) => frame.event === 'tool_call_update');
    assert.match(received[0].data.output, MARKER);
    assert.equal(received[1].data.output, LONG_LOG, 'its title came before this replay began');
  });
});
