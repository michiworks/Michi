/**
 * michi_skills: the Michi skill library as agents read it, over MCP (the CLI
 * runtimes and the Crew relay) and in process (Pi).
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listEnabledBuiltinTools } from '../src/agents/builtinTools';
import { buildPiTools } from '../src/agents/pi/piTools';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';
import { closeDb, initDb } from '../src/services/db';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import { setBuiltinSkillsForTests } from '../src/services/skills/builtin';
import { michiSkillsTool } from '../src/services/skills/michiSkillsTool';
import { skillLibraryRoot, skillStatePath } from '../src/services/skills/paths';
import { updateSkillsState } from '../src/services/skills/state';

let tmp: string;

const skillFile = (name: string, extra = '') => `---\nname: ${name}\ndescription: About ${name}\n${extra}---\n\nDo ${name}.\n`;

function librarySkill(name: string, extra = ''): string {
  const dir = path.join(skillLibraryRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillFile(name, extra));
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-skills-tool-'));
  process.env.MICHI_DATA_DIR = path.join(tmp, 'data');
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  fs.rmSync(skillLibraryRoot(), { recursive: true, force: true });
  fs.rmSync(skillStatePath(), { force: true });
  const alpha = librarySkill('alpha');
  fs.mkdirSync(path.join(alpha, 'refs'));
  fs.writeFileSync(path.join(alpha, 'refs', 'guide.md'), 'Guide');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(alpha, 'outside.txt'));
  librarySkill('beta');
  librarySkill('gamma', 'disable-model-invocation: true\n');
  librarySkill('delta');
  updateSkillsState((state) => ({ ...state, library: { delta: { enabled: false } } }));
});

afterEach(() => {
  setBuiltinSkillsForTests();
  closeDb();
  delete process.env.MICHI_CLOUD;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP lists the enabled library skills and reads files inside a skill folder only', async (t) => {
  const slot = new McpSlotRegistry().create('skills-chat', tmp, null, { exposedToolNames: new Set(['michi_skills']) });
  const server = buildMcpServerForSlot(slot, 'session-a');
  const client = new Client({ name: 'skills-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a);
  await client.connect(b);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['michi_skills']);
  assert.equal(tools[0].annotations?.readOnlyHint, true);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'michi_skills', arguments: { ...args, session_id: 'session-a' } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, text, json: result.isError ? null : JSON.parse(text) };
  };
  const names = async () => (await call({ action: 'list' })).json.skills.map((skill: { name: string }) => skill.name);

  assert.deepEqual(await names(), ['alpha', 'beta'], 'every skill that is on, but not user-only ones');

  const read = (await call({ action: 'read', name: 'alpha' })).json;
  assert.deepEqual([read.file, read.text, read.files, read.baseDir], ['SKILL.md', skillFile('alpha'), ['refs/guide.md'], path.join(skillLibraryRoot(), 'alpha')]);
  assert.equal((await call({ action: 'read', name: 'alpha', file: 'refs/guide.md' })).json.text, 'Guide');
  assert.equal((await call({ action: 'read', name: 'gamma' })).isError, false, 'a skill the user runs can still be read, for its files');
  for (const args of [
    { action: 'read', name: 'delta' }, { action: 'read', name: '../alpha' },
    { action: 'read', name: 'alpha', file: '../beta/SKILL.md' }, { action: 'read', name: 'alpha', file: path.join(tmp, 'secret.txt') },
    { action: 'read', name: 'alpha', file: 'outside.txt' }, { action: 'write' },
  ]) {
    const result = await call(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.text.includes('"text"'), false, JSON.stringify(args));
  }
});

test('lists the built-in skills a model may load after the library, and reads one by name, or with builtin beside a library skill of its name', () => {
  const builtinFile = (name: string, extra = '') => `---\nname: ${name}\ndescription: Built-in ${name}\n${extra}---\n\nBuilt-in body.\n`;
  setBuiltinSkillsForTests([['alpha', builtinFile('alpha')], ['solo', builtinFile('solo')], ['quiet', builtinFile('quiet', 'disable-model-invocation: true\n')], ['off', builtinFile('off')]]);
  updateSkillsState((state) => ({ ...state, builtin: { off: { enabled: false } } }));
  const run = (args: Record<string, unknown>) => {
    const result = michiSkillsTool(args);
    return { isError: result.isError === true, text: result.content[0].text, json: result.isError ? null : JSON.parse(result.content[0].text) };
  };
  assert.deepEqual(run({ action: 'list' }).json.skills.map((skill: { name: string; builtin?: boolean }) => [skill.name, skill.builtin === true]),
    [['alpha', false], ['beta', false], ['alpha', true], ['solo', true]]);
  assert.equal(run({ action: 'read', name: 'alpha' }).json.text, skillFile('alpha'), 'a library skill keeps its name');
  const builtin = run({ action: 'read', name: 'alpha', builtin: true }).json;
  assert.deepEqual([builtin.builtin, builtin.file, builtin.text, builtin.files, builtin.baseDir], [true, 'SKILL.md', builtinFile('alpha'), [], undefined]);
  assert.equal(run({ action: 'read', name: 'solo' }).json.text, builtinFile('solo'));
  for (const args of [
    { action: 'read', name: 'solo', file: 'refs/x.md' }, { action: 'read', name: 'quiet' }, { action: 'read', name: 'off' },
    { action: 'read', name: 'beta', builtin: true }, { action: 'read', name: 'solo', builtin: 'yes' },
  ]) assert.equal(run(args).isError, true, JSON.stringify(args));
});

test('Pi offers the same tool', async (t) => {
  const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null };
  const agentConfig = { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined };
  configureRuntimeDeps({ historyStore: store as any, agentConfig: agentConfig as any, dataDir: tmp });
  t.after(() => __resetRuntimeDeps());
  const Type: any = new Proxy({}, { get: () => (..._args: unknown[]) => ({}) });
  const tool = buildPiTools({
    bridge: {} as any, cwd: tmp, parentChatId: 'p', workspaceId: null, enableFollowUps: true,
    imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type,
  }).find((candidate: { name: string }) => candidate.name === 'michi_skills');
  assert.ok(tool);
  const listed = JSON.parse((await tool.execute('skills-list', { __tool_use_purpose: 'find a skill' })).content[0].text);
  assert.deepEqual(listed.skills.map((skill: { name: string }) => skill.name), ['alpha', 'beta']);
});

test('cloud mode offers no skill library tool', () => {
  process.env.MICHI_CLOUD = '1';
  assert.equal(listEnabledBuiltinTools().some((tool) => tool.name === 'michi_skills'), false);
  assert.equal(michiSkillsTool({ action: 'list' }).isError, true);
});
