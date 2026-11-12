import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatSkillFile } from 'michi-shared';
import { expandSkillPrompt } from 'michi-runtime';
import { PiSession, type PiSessionDeps } from '../src/agents/pi/PiSession';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import type { PiSdkFeatures } from '../src/agents/pi/piSdkHarness';
import type { AgentTurnInput, SkillTurnInvocation } from '../src/agents/types';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { followUpReminder, SKILL_TURN_NOTE } from '../src/agents/preamble';
import { skillLibraryRoot } from '../src/services/skills/paths';
import { chatOwner } from './helpers/owners';
import { restrictedChatProfile } from './helpers/restrictedChatProfile';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const restores: Array<() => void> = [];

function patch(modulePath: string, key: string, value: unknown): void {
  const mod = require(modulePath);
  const original = mod[key];
  mod[key] = value;
  restores.push(() => { mod[key] = original; });
}

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  __resetRuntimeDeps();
  delete process.env.MICHI_CLOUD;
  fs.rmSync(skillLibraryRoot(), { recursive: true, force: true });
});

/** Pi on the agent-core engine with a recording Agent and tool builder. */
function stubPi(): { prompts: string[]; toolOpts: any[] } {
  const seen = { prompts: [] as string[], toolOpts: [] as any[] };
  configureRuntimeDeps({
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'pi-model', resolveReasoning: () => undefined,
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patch(require.resolve('../src/agents/pi/piTools'), 'buildPiTools', (opts: any) => { seen.toolOpts.push(opts); return []; });
  patch(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  const piAi = require.resolve('../src/agents/pi/piAi');
  patch(piAi, 'loadPiAi', async () => ({
    Type: {}, clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: () => ({ contextWindow: 1000 }), streamSimple: () => { throw new Error('unused'); },
  }));
  patch(piAi, 'loadPiAgentCore', async () => ({
    Agent: class {
      state = { messages: [] };
      private subscriber: ((event: any) => void) | undefined;
      subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
      async prompt(text: string) { seen.prompts.push(text); this.subscriber?.({ type: 'agent_end' }); }
    },
  }));
  return seen;
}

class RecordingPiSession extends PiSession {
  features: PiSdkFeatures | undefined;
  protected override async createHarness(core: any, options: any, features: PiSdkFeatures): Promise<any> {
    this.features = features;
    return super.createHarness(core, options, features);
  }
}

function newSession(id: string, deps: Partial<PiSessionDeps> = {}): RecordingPiSession {
  return new RecordingPiSession(id, {
    bridge, preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: chatOwner(id), ...deps,
  });
}

async function drain(session: PiSession, text: string, input?: AgentTurnInput): Promise<void> {
  for await (const event of session.send(text, input)) { if (event.kind === 'turn_end') break; }
}

function writeLibrarySkill(name: string): void {
  const dir = path.join(skillLibraryRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), formatSkillFile({ name, description: `About ${name}`, body: 'Body' }));
}

test('a skill turn opens the person\'s text with Pi\'s skill block, after Michi\'s context, and ends with the note instead of the format glue', async () => {
  const seen = stubPi();
  const session = newSession('pi-skill-turn', { firstUserGlue: 'FORMAT-GLUE', enableFollowUps: true });
  const skill: SkillTurnInvocation = {
    id: 'runtime:pi:example:notes', name: 'notes', origin: 'runtime',
    path: '/example/skills/notes/SKILL.md', body: 'Write notes about $ARGUMENTS.\n', args: 'the build',
  };
  await drain(session, 'the build', { skill, memoryContext: 'MEMORY-BLOCK', pageContext: 'PAGE-MANIFEST' });
  await drain(session, 'plain question');
  await drain(session, 'the build again', { skill });
  assert.ok(followUpReminder(3, true), 'a third ordinary turn would get the reminder');
  assert.deepEqual(seen.prompts, [
    `MEMORY-BLOCK\n\n---\n\nPAGE-MANIFEST\n\n---\n\n${expandSkillPrompt(skill, 'the build')}${SKILL_TURN_NOTE}`,
    `plain question${followUpReminder(2, true)}`,
    `${expandSkillPrompt(skill, 'the build again')}${SKILL_TURN_NOTE}`,
  ]);
  assert.deepEqual(session.getHistory().filter((message) => message.role === 'user').map((message) => message.content),
    ['/notes the build', 'plain question', '/notes the build'], 'the host history keeps the command, not the skill body');
});

test('ordinary Pi chats get the library skills and read their folders; the assistant and cloud mode get neither', async () => {
  const seen = stubPi();
  writeLibrarySkill('notes');
  const library = skillLibraryRoot();

  const chat = newSession('pi-skill-chat');
  await drain(chat, 'hello');
  assert.deepEqual(chat.features?.skillPaths, [path.join(library, 'notes')]);
  const chatRoots = seen.toolOpts.at(-1).skillReadRoots;
  assert.deepEqual(chatRoots(), [library]);
  await drain(chat, 'the diff', { skill: {
    id: 'runtime:pi:example:review', name: 'review', origin: 'runtime', path: '/example/skills/review/SKILL.md', body: 'Review.', args: 'the diff',
  } });
  assert.deepEqual(chatRoots(), [library, '/example/skills/review'], 'a skill run in the chat opens its folder');

  const assistant = newSession('pi-skill-assistant', { toolProfile: restrictedChatProfile() });
  await drain(assistant, 'hello');
  assert.deepEqual(assistant.features?.skillPaths, []);
  assert.deepEqual(seen.toolOpts.at(-1).skillReadRoots(), []);

  process.env.MICHI_CLOUD = '1';
  const cloud = newSession('pi-skill-cloud', { ownerUserId: 'user-1' });
  await drain(cloud, 'hello');
  assert.deepEqual(cloud.features?.skillPaths, []);
  assert.deepEqual(seen.toolOpts.at(-1).skillReadRoots(), []);
});

test('Pi leaves native discovery empty; the library supplies public skills', async () => {
  const runtime = new PiRuntime(bridge);
  assert.deepEqual(await runtime.listSkills({ cwd: process.cwd() }), { skills: [] });
  process.env.MICHI_CLOUD = '1';
  assert.deepEqual(await runtime.listSkills({ cwd: process.cwd() }), { skills: [] });
});
