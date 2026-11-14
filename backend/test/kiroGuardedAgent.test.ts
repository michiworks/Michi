/**
 * Lane D, Q26 (user choice 2026-11-12): a Kiro chat turn Michi guards runs on
 * a copy of the chat's agent that pre-approves only reads, so every other
 * call reaches Michi's approval; the next unguarded turn goes back. The
 * copies (agents/kiro/kiroGuardedAgent.ts) and the switch
 * (AcpAgentSession.reconcileGuardedAgent) with a runtime stand-in; no
 * kiro-cli, no database.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime, KiroGuardedAgentOptions } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { ChatPermissionMode } from 'michi-shared';
import type { HostTurnGuard } from 'michi-runtime';
import { kiroGuardedFallbacks } from 'michi-runtime/internal/adapters/kiro/kiroGuardedFallbacks';
import {
  ensureKiroGuardedAgent, isKiroGuardedAgent, kiroAgentPreApproves, kiroGuardedAgentBase, kiroGuardedAgentConfig, kiroGuardedAgentName,
  prepareKiroGuardedAgents,
} from '../src/agents/kiro/kiroGuardedAgent';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner } from './helpers/owners';

/** Fictional agent configuration exercising pre-approved tools and permission rules. */
const PRE_APPROVING = {
  name: 'sample-builder',
  description: 'Builder agent',
  prompt: 'Be helpful.',
  tools: ['@builtin', '@example-tools'],
  allowedTools: ['fs_read', 'glob', 'grep', '@example-tools/ReadWebsites', '@example-docs/*'],
  toolsSettings: {
    shell: { autoAllowReadonly: true, allowedCommands: ['^git status$'], deniedCommands: ['rm -rf .*'] },
    fs_write: { allowedPaths: ['src/**'] },
  },
  permissions: { rules: [
    { capability: 'fs_read', effect: 'allow' },
    { capability: 'mcp', effect: 'allow', match: ['example-tools/ReadWebsites'] },
    { capability: 'skill', match: ['example-build'] },
    { capability: 'shell', effect: 'deny', match: ['git push.*'] },
  ] },
  mcpServers: { local: { command: 'node', args: ['server.js'] } },
  resources: ['file://README.md'],
  hooks: { agentSpawn: [{ command: 'echo hi' }] },
  useLegacyMcpJson: false,
};

const READS_ONLY = { name: 'reader', tools: ['*'], allowedTools: ['fs_read', 'grep'], permissions: { rules: [{ capability: 'fs_read', effect: 'allow' }] } };

describe('Kiro guarded agent copies', () => {
  let root: string;
  let agentsDir: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-guarded-'));
    agentsDir = path.join(root, 'kiro-home', 'agents');
    cwd = path.join(root, 'project');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = () => fs.readdirSync(agentsDir).sort();
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(agentsDir, `${name}.json`), 'utf8'));

  it('names: a copy per agent, recognised by prefix, read back as its base', () => {
    assert.equal(kiroGuardedAgentName('sample-builder'), 'michi-guarded--sample-builder');
    assert.equal(kiroGuardedAgentName(null), 'michi-guarded');
    assert.equal(isKiroGuardedAgent('michi-guarded--sample-builder'), true);
    assert.equal(isKiroGuardedAgent('sample-builder'), false);
    assert.equal(kiroGuardedAgentBase('michi-guarded--sample-builder'), 'sample-builder');
    assert.equal(kiroGuardedAgentBase('michi-guarded'), null);
    assert.throws(() => kiroGuardedAgentName('a b/c'), /cannot be copied/);
    assert.throws(() => kiroGuardedAgentName('michi-guarded--x'), /cannot be copied/);
  });

  it('what pre-approves: tools, allow settings and allow rules beyond reads', () => {
    assert.equal(kiroAgentPreApproves(PRE_APPROVING), true);
    assert.equal(kiroAgentPreApproves(READS_ONLY), false);
    assert.equal(kiroAgentPreApproves({ allowedTools: ['@example-credentials'] }), true);
    assert.equal(kiroAgentPreApproves({ toolsSettings: { shell: { autoAllowReadonly: true } } }), true);
    assert.equal(kiroAgentPreApproves({ toolsSettings: { shell: { deniedCommands: ['x'] } } }), false);
    assert.equal(kiroAgentPreApproves({ permissions: { rules: [{ capability: 'skill', match: ['example-build'] }] } }), true, 'a rule with no effect allows');
  });

  it('the copy keeps the agent but pre-approves only reads, and keeps its denies', () => {
    const copy = kiroGuardedAgentConfig(PRE_APPROVING, 'michi-guarded--sample-builder', 'sample-builder');
    assert.equal(copy.name, 'michi-guarded--sample-builder');
    assert.deepEqual(copy.allowedTools, ['fs_read', 'glob', 'grep']);
    assert.deepEqual(copy.toolsSettings, { shell: { deniedCommands: ['rm -rf .*'] }, fs_write: {} });
    assert.deepEqual((copy.permissions as { rules: unknown[] }).rules, [
      { capability: 'fs_read', effect: 'allow' },
      { capability: 'shell', effect: 'deny', match: ['git push.*'] },
    ]);
    for (const key of ['prompt', 'tools', 'mcpServers', 'resources', 'hooks', 'useLegacyMcpJson'] as const) {
      assert.deepEqual(copy[key], PRE_APPROVING[key], key);
    }
    assert.equal(kiroAgentPreApproves(copy), false);
  });

  it('ensure writes only a prefixed copy, finds the agent by its name field, and leaves the user\'s files as they were', () => {
    const userFile = path.join(agentsDir, 'ExampleCapabilities-sample-builder.json');
    const userText = `${JSON.stringify(PRE_APPROVING, null, 2)}\n`;
    fs.writeFileSync(userFile, userText);
    assert.equal(ensureKiroGuardedAgent('sample-builder', cwd, agentsDir), 'michi-guarded--sample-builder');
    assert.deepEqual(files(), ['ExampleCapabilities-sample-builder.json', 'michi-guarded--sample-builder.json']);
    assert.equal(fs.readFileSync(userFile, 'utf8'), userText);
    assert.deepEqual(read('michi-guarded--sample-builder').allowedTools, ['fs_read', 'glob', 'grep']);
    // Kept as it is on a second call.
    const before = fs.statSync(path.join(agentsDir, 'michi-guarded--sample-builder.json')).mtimeMs;
    ensureKiroGuardedAgent('sample-builder', cwd, agentsDir);
    assert.equal(fs.statSync(path.join(agentsDir, 'michi-guarded--sample-builder.json')).mtimeMs, before);
  });

  it('no copy for built-ins and agents that pre-approve only reads: the turn keeps them', () => {
    fs.writeFileSync(path.join(agentsDir, 'reader.json'), JSON.stringify(READS_ONLY));
    assert.equal(ensureKiroGuardedAgent('reader', cwd, agentsDir), null);
    assert.equal(ensureKiroGuardedAgent('kiro_default', cwd, agentsDir), null);
    // v3's bundled modes probed on kiro-cli 3.2.1 (its default chat runs on vibe); an unprobed one still gets a stand-in.
    for (const bundled of ['vibe', 'default-v2', 'spec', 'bug-fix']) assert.equal(ensureKiroGuardedAgent(bundled, cwd, agentsDir), null, bundled);
    assert.equal(ensureKiroGuardedAgent('autonomous', cwd, agentsDir), 'michi-guarded--autonomous');
    // With the runtime's fallback (v3), a mode without a file runs on it: no stand-in is written.
    assert.equal(ensureKiroGuardedAgent('plan', cwd, agentsDir, 'vibe'), 'vibe');
    assert.equal(ensureKiroGuardedAgent(null, cwd, agentsDir), null, 'no default agent set: Kiro\'s own');
    assert.deepEqual(files(), ['michi-guarded--autonomous.json', 'reader.json']);
  });

  it('an unreported agent is the user\'s default agent; a project agent wins over the user\'s', () => {
    fs.mkdirSync(path.join(agentsDir, '..', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, '..', 'settings', 'cli.json'), JSON.stringify({ 'chat.defaultAgent': 'sample-builder' }));
    fs.writeFileSync(path.join(agentsDir, 'sample-builder.json'), JSON.stringify(PRE_APPROVING));
    assert.equal(ensureKiroGuardedAgent(null, cwd, agentsDir), 'michi-guarded--sample-builder');
    fs.mkdirSync(path.join(cwd, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.kiro', 'agents', 'sample-builder.json'), JSON.stringify({ ...PRE_APPROVING, prompt: 'Project prompt.' }));
    ensureKiroGuardedAgent('sample-builder', cwd, agentsDir);
    assert.equal(read('michi-guarded--sample-builder').prompt, 'Project prompt.');
  });

  it('an agent with no readable file gets a stand-in that pre-approves only reads; a broken one fails closed', () => {
    assert.equal(ensureKiroGuardedAgent('projected-agent', cwd, agentsDir), 'michi-guarded--projected-agent');
    const standIn = read('michi-guarded--projected-agent');
    assert.deepEqual(standIn.tools, ['*']);
    assert.equal(kiroAgentPreApproves(standIn), false);
    fs.writeFileSync(path.join(agentsDir, 'broken.json'), '{ not json');
    assert.throws(() => ensureKiroGuardedAgent('broken', cwd, agentsDir));
  });

  it('prepare writes the default agent\'s copy and refreshes copies already made; it never throws', () => {
    fs.mkdirSync(path.join(agentsDir, '..', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, '..', 'settings', 'cli.json'), JSON.stringify({ 'chat.defaultAgent': 'sample-builder' }));
    fs.writeFileSync(path.join(agentsDir, 'sample-builder.json'), JSON.stringify(PRE_APPROVING));
    fs.writeFileSync(path.join(agentsDir, 'other.json'), JSON.stringify({ ...PRE_APPROVING, name: 'other' }));
    fs.writeFileSync(path.join(agentsDir, 'michi-guarded--other.json'), '{"name":"michi-guarded--other","stale":true}');
    prepareKiroGuardedAgents(cwd, agentsDir);
    assert.ok(files().includes('michi-guarded--sample-builder.json'));
    assert.equal(read('michi-guarded--other').stale, undefined, 'refreshed from its base');
    prepareKiroGuardedAgents(cwd, path.join(root, 'missing', 'agents'));
  });
});

// ---------------------------------------------------------------------------
// The switch, through the session
// ---------------------------------------------------------------------------

interface Harness {
  session: AcpAgentSession;
  prompts: string[];
  setModes: string[];
  reopens: Array<readonly string[]>;
  mode: () => string | null;
}

function harness(opts: {
  guard: () => HostTurnGuard;
  mode?: ChatPermissionMode;
  start?: string | null;
  copyFor?: (base: string | null, fallback?: string) => string | null;
  setModeFails?: (modeId: string) => boolean;
  presets?: readonly string[];
  /** Where the fallback record lives (a restart is a new harness on the same folder); a new folder by default. */
  fallbackDir?: string;
}): Harness {
  const fallbackDir = opts.fallbackDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-fallbacks-'));
  const host = michiTestHost();
  host.permissions.mode = () => opts.mode ?? 'trust';
  host.permissions.approveForMe = () => false;
  host.permissions.turnGuard = () => opts.guard();
  let current: string | null = opts.start === undefined ? 'sample-builder' : opts.start;
  let presets = opts.presets ?? [];
  const prompts: string[] = [];
  const setModes: string[] = [];
  const reopens: Array<readonly string[]> = [];
  const guarded: KiroGuardedAgentOptions = {
    ensure: (base, _cwd, fallback) => (opts.copyFor ? opts.copyFor(base, fallback) : base ? `michi-guarded--${base}` : null),
    isGuarded: isKiroGuardedAgent,
    baseOf: kiroGuardedAgentBase,
  };
  const client = {
    policyPresets: () => presets,
    needsSessionRecovery: () => false,
    hasOpenWorkflowRuns: () => false,
    reopenWithPolicyPresets: async (_sid: string, next: readonly string[]) => { reopens.push(next); presets = next; },
    async *prompt(_sid: string, text: string) {
      prompts.push(text);
      yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
    },
    getSessionState: () => ({ runtimeId: 'kiro', currentModeId: current, availableModes: [{ id: 'sample-builder' }, { id: 'michi-guarded--sample-builder' }] }),
  };
  const runtime = {
    host,
    engine: 'v3',
    approveForMe: true,
    guardedAgent: guarded,
    guardedFallbacks: kiroGuardedFallbacks(() => fallbackDir),
    guardedFallbackAgent: 'vibe',
    policyPresetsFor: () => [],
    withoutGuardedModes: (modes: Array<{ id?: string }>) => modes.filter((mode) => !isKiroGuardedAgent(mode.id ?? '')),
    ensureClient: async () => client,
    getClient: () => client,
    getCurrentMode: () => current ?? undefined,
    getCurrentModel: () => null,
    getDefaultModeId: () => 'kiro_default',
    setMode: async (_sid: string, modeId: string) => {
      setModes.push(modeId);
      if (opts.setModeFails?.(modeId)) throw new Error(`Kiro did not select requested agent ${modeId}`);
      current = modeId;
    },
  } as unknown as AcpAgentRuntime;
  const session = new AcpAgentSession('node-1', 'sid-1', runtime, '/tmp', { owner: chatOwner('node-1') });
  return { session, prompts, setModes, reopens, mode: () => current };
}

async function send(session: AcpAgentSession): Promise<void> {
  for await (const _event of session.send('hi')) { /* drain */ }
}

describe('AcpAgentSession guarded agent', () => {
  it('a guarded turn runs on the copy; the next unguarded turn goes back to the agent', async () => {
    let guard: HostTurnGuard = 'work';
    const h = harness({ guard: () => guard });
    await send(h.session);
    assert.deepEqual(h.setModes, ['michi-guarded--sample-builder']);
    assert.equal(h.prompts.length, 1);
    await send(h.session);
    assert.deepEqual(h.setModes, ['michi-guarded--sample-builder'], 'already on the copy');
    guard = 'none';
    await send(h.session);
    assert.deepEqual(h.setModes, ['michi-guarded--sample-builder', 'sample-builder']);
    assert.equal(h.prompts.length, 3);
  });

  it('an egress guard switches too; an unguarded chat never touches its agent', async () => {
    const egress = harness({ guard: () => 'egress' });
    await send(egress.session);
    assert.deepEqual(egress.setModes, ['michi-guarded--sample-builder']);
    const plain = harness({ guard: () => 'none' });
    await send(plain.session);
    assert.deepEqual(plain.setModes, []);
  });

  it('an agent that needs no copy keeps running; a chat left on an old copy goes back to it', async () => {
    const keeps = harness({ guard: () => 'work', copyFor: () => null });
    await send(keeps.session);
    assert.deepEqual(keeps.setModes, []);
    const stale = harness({ guard: () => 'work', copyFor: () => null, start: 'michi-guarded--sample-builder' });
    await send(stale.session);
    assert.deepEqual(stale.setModes, ['sample-builder']);
  });

  it('a guarded turn whose copy cannot be selected does not run (fail closed)', async () => {
    const h = harness({ guard: () => 'work', setModeFails: (modeId) => isKiroGuardedAgent(modeId) });
    await assert.rejects(send(h.session), /could not switch this chat to michi-guarded--sample-builder/);
    assert.equal(h.prompts.length, 0);
    const broken = harness({ guard: () => 'work', copyFor: () => { throw new Error('bad agent file'); } });
    await assert.rejects(send(broken.session), /Could not prepare a copy.*bad agent file/);
    assert.equal(broken.prompts.length, 0);
  });

  it('going back that fails leaves the copy and still runs the turn', async () => {
    const h = harness({ guard: () => 'none', start: 'michi-guarded--sample-builder', setModeFails: () => true });
    await send(h.session);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.mode(), 'michi-guarded--sample-builder');
  });

  it('the chat shows the agent, not the copy, and never offers the copy', async () => {
    const h = harness({ guard: () => 'work' });
    await send(h.session);
    assert.equal(h.mode(), 'michi-guarded--sample-builder');
    assert.equal(h.session.currentModeId, 'sample-builder');
    const state = h.session.getSessionState() as { currentModeId: string; availableModes: Array<{ id: string }> };
    assert.equal(state.currentModeId, 'sample-builder');
    assert.deepEqual(state.availableModes.map((mode) => mode.id), ['sample-builder']);
  });

  /** As the host answers for v3's bundled modes without an agent file: the runtime's fallback. */
  const bundled = (base: string | null, fallback?: string) => (base === 'autonomous' ? fallback ?? null : base ? `michi-guarded--${base}` : null);

  it('a mode without an agent file (autonomous) runs a guarded turn on vibe and goes back for the next; the chat still shows autonomous', async () => {
    let guard: HostTurnGuard = 'work';
    const h = harness({ guard: () => guard, start: 'autonomous', copyFor: bundled });
    await send(h.session);
    assert.deepEqual(h.setModes, ['vibe']);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.session.currentModeId, 'autonomous', 'the recorded mode stays the user\'s');
    assert.equal((h.session.getSessionState() as { currentModeId: string }).currentModeId, 'autonomous');
    await send(h.session);
    assert.deepEqual(h.setModes, ['vibe'], 'still guarded: stays on vibe');
    guard = 'none';
    await send(h.session);
    assert.deepEqual(h.setModes, ['vibe', 'autonomous'], 'back before the unguarded turn');
    assert.equal(h.session.currentModeId, 'autonomous');
    assert.equal(h.prompts.length, 3);
  });

  it('the mode a fallback left survives a restart: the next session on that native session goes back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-fallbacks-'));
    const before = harness({ guard: () => 'work', start: 'autonomous', copyFor: bundled, fallbackDir: dir });
    await send(before.session);
    assert.deepEqual(before.setModes, ['vibe']);
    // A new backend: a new runtime and session object on the same native session, which Kiro reopened on vibe.
    const after = harness({ guard: () => 'none', start: 'vibe', copyFor: bundled, fallbackDir: dir });
    assert.equal(after.session.currentModeId, 'autonomous');
    await send(after.session);
    assert.deepEqual(after.setModes, ['autonomous']);
    assert.equal(kiroGuardedFallbacks(() => dir).get('sid-1'), undefined, 'the record goes once it is back');
    // And a guarded turn after the restart stays on vibe, still going back to autonomous.
    const guardedAfter = harness({ guard: () => 'work', start: 'vibe', copyFor: bundled, fallbackDir: dir });
    kiroGuardedFallbacks(() => dir).set('sid-1', 'autonomous');
    await send(guardedAfter.session);
    assert.deepEqual(guardedAfter.setModes, []);
    assert.deepEqual(kiroGuardedFallbacks(() => dir).get('sid-1'), { base: 'autonomous' });
  });

  it('a fallback switch that fails does not run the turn, and keeps no record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-fallbacks-'));
    const h = harness({ guard: () => 'work', start: 'autonomous', copyFor: bundled, fallbackDir: dir, setModeFails: (modeId) => modeId === 'vibe' });
    await assert.rejects(send(h.session), /could not switch this chat to vibe, which asks before commands and writes, so nothing ran/);
    assert.equal(h.prompts.length, 0);
    assert.equal(kiroGuardedFallbacks(() => dir).get('sid-1'), undefined);
  });

  it('a mode the user picks while on the fallback replaces the one it left', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-fallbacks-'));
    let guard: HostTurnGuard = 'work';
    const h = harness({ guard: () => guard, start: 'autonomous', copyFor: bundled, fallbackDir: dir });
    await send(h.session);
    await h.session.setMode('spec');
    assert.equal(kiroGuardedFallbacks(() => dir).get('sid-1'), undefined);
    guard = 'none';
    await send(h.session);
    assert.deepEqual(h.setModes, ['vibe', 'spec'], 'no switch back to autonomous');
  });

  it('a guarded Trust turn drops Approve for me, whose classifier would approve before Michi\'s rules', async () => {
    const h = harness({ guard: () => 'egress', mode: 'trust', presets: ['approve-for-me'] });
    await send(h.session);
    assert.deepEqual(h.reopens, [[]]);
    const plain = harness({ guard: () => 'none', mode: 'trust', presets: ['approve-for-me'] });
    await send(plain.session);
    assert.deepEqual(plain.reopens, [], 'unguarded Trust leaves the session as it is');
  });
});
