/**
 * A work conversation's own worktree (design D18, Q26; lane D): a
 * conversation Michi starts in a git workspace opens on its own worktree and
 * branch from HEAD, under the data directory, before its session; every
 * session path of the node opens there (ChatManager, the ensure-session
 * route), so the user's checkout is untouched. A folder that is not a
 * repository, a repository without a commit, cloud mode or a worktree that
 * is gone keep the workspace folder; a start that fails removes the
 * worktree it made. Temp MICHI_DATA_DIR and temp git repositories per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import type { StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import type { ThreadMessagingDeps } from '../src/agents/threadMessageTool';
import { ensureAssistant } from '../src/assistant/store';
import { updateAgentConfig } from '../src/services/agentConfig';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { startConversationTool } from '../src/services/metaAgent/startConversation';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';
import { shutdownDbWorker } from '../src/services/dbWorkerClient';
import { setupMichiRoutes } from '../src/routes/michi';
import {
  createWorkConversationWorktrees, workConversationBranch, workConversationCwd, workConversationWorktrees,
} from '../src/services/workConversationWorktree';

const GIT_ID = ['-c', 'user.name=Michi Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository on `main` with one commit: README.md and app/index.ts. */
function makeRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'committed\n');
  fs.writeFileSync(path.join(dir, 'app', 'index.ts'), 'export {};\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}

let captured: Array<NewAgentSessionOptions & { runtimeId: string }> = [];

function fakeRuntime(id: string): AgentRuntime {
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id,
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: false, supportedReasoningLevels: [], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession(options) {
      captured.push({ ...options, runtimeId: id });
      return {
        id: options.sessionId!, runtimeId: id, currentModelId: options.model ?? null, getHistory: () => [],
        getPendingAssistant: () => undefined, async *send() {}, async cancel() {},
      } as AgentSession;
    },
    async releaseSession() {},
    async shutdown() {},
  };
  return runtime;
}
for (const id of ['claude', 'codex']) registerRuntime(fakeRuntime(id));

function seedWorkspace(id: string, cwd: string): void {
  saveWorkspace({ id, name: `Project ${id}`, cwd, created_at: 1, updated_at: 1, settings: null });
}

function seedChat(id: string, workspaceId: string): void {
  saveTree({ id: `t-${id}`, workspace_id: workspaceId, root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: workspaceId, tree_id: `t-${id}`, kind: 'chat', title: `Title ${id}`, status: 'idle',
    minimized: 0, spawned_by_agent: 0, runtime_id: 'claude', created_at: 1 });
}

function deps(ensureSession: ThreadMessagingDeps['ensureSession']): ThreadMessagingDeps {
  return {
    ensureSession,
    startTurn: async (args): Promise<StartedRequestedSelfTurn> => ({
      turnId: args.turnId, assistantId: `self-${args.nodeId}-${args.turnId}`, done: Promise.resolve(), existing: false,
    }),
    acquireRestoreLock: async () => () => {},
    newTurnId: () => 'turn-new',
    startWaitMs: 50,
  };
}

const approve = async () => ({ approved: true as const });

/** The node's worktree as recorded; null when it has none. */
function workConversationWorktreeOf(nodeId: string) {
  const row = getDb().prepare('SELECT worktree_path, session_cwd, branch, repository_root FROM work_conversation_worktrees WHERE node_id = ?')
    .get(nodeId) as { worktree_path: string; session_cwd: string; branch: string; repository_root: string } | undefined;
  return row ? { worktreePath: row.worktree_path, sessionCwd: row.session_cwd, branch: row.branch, repositoryRoot: row.repository_root } : null;
}

let tmpDir: string;
let dataDir: string;

describe('a work conversation\'s own worktree', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-work-worktree-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir);
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    captured = [];
    clearAllSessions();
    updateAgentConfig({ runtime: 'claude', modelByRuntime: { claude: 'claude-model' } });
  });

  afterEach(async () => {
    clearAllSessions();
    await shutdownDbWorker();
    closeDb();
    delete process.env.MICHI_CLOUD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('start_conversation in a git workspace opens it on its own worktree and branch before its session; the user\'s checkout is untouched', async () => {
    const repo = makeRepo(path.join(tmpDir, 'repo'));
    // The user's uncommitted work stays theirs: it is not in the worktree, and the checkout keeps it.
    fs.writeFileSync(path.join(repo, 'README.md'), 'the user is editing this\n');
    seedWorkspace('ws-git', repo);
    const agent = ensureAssistant();
    let cwdAtSession: string | null = null;
    const result = await startConversationTool(
      { ownerUserId: null, workspaceId: agent.workspaceId, nodeId: agent.nodeId },
      { workspaceId: 'ws-git', text: 'Fix the flaky test\nand report back.' },
      approve,
      deps(async (input) => {
        cwdAtSession = workConversationCwd(input.nodeId);
        return { id: input.nodeId, runtimeId: getNode(input.nodeId)!.runtime_id } as unknown as AgentSession;
      }),
    );
    assert.equal(result.isError, undefined, result.content[0].text);
    const body = JSON.parse(result.content[0].text);
    const nodeId: string = body.conversation.nodeId;
    const worktree = workConversationWorktreeOf(nodeId)!;
    assert.ok(worktree, 'the worktree is recorded');
    assert.equal(worktree.worktreePath, path.join(dataDir, 'worktrees', nodeId));
    assert.equal(worktree.sessionCwd, worktree.worktreePath);
    assert.equal(worktree.repositoryRoot, repo);
    assert.equal(worktree.branch, workConversationBranch('Fix the flaky test', nodeId));
    assert.match(worktree.branch, /^michi\/fix-the-flaky-test-[a-z0-9]{8}$/);
    // Made before the session opened, so the session opens in it.
    assert.equal(cwdAtSession, worktree.sessionCwd);
    assert.deepEqual(body.worktree, { branch: worktree.branch });
    assert.match(body.next, new RegExp(`own branch \`${worktree.branch.replace(/[/.-]/g, '\\$&')}\``));

    assert.equal(git(worktree.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), worktree.branch);
    assert.equal(git(worktree.worktreePath, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(worktree.worktreePath, 'README.md'), 'utf8'), 'committed\n');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'the user is editing this\n');
    assert.equal(git(repo, 'status', '--porcelain'), 'M README.md');
  });

  test('every session path of the node opens in the worktree: ChatManager, and ensure-session whatever folder the client sends', async () => {
    const repo = makeRepo(path.join(tmpDir, 'repo'));
    seedWorkspace('ws-git', repo);
    seedChat('n-work1', 'ws-git');
    const worktree = (await workConversationWorktrees.prepare({ nodeId: 'n-work1', workspaceCwd: repo, title: 'Work' }))!;
    assert.ok(worktree);
    const manager = new ChatManager(undefined, tmpDir);

    const restored = await manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-git', nodeId: 'n-work1' });
    assert.ok(restored);
    assert.equal(fs.realpathSync(captured.at(-1)!.cwd!), fs.realpathSync(worktree.sessionCwd));

    clearAllSessions();
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteAccessMiddleware());
    app.use('/api', setupMichiRoutes(manager));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/nodes/n-work1/ensure-session',
          headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end(JSON.stringify({ workspaceId: 'ws-git', cwd: repo }));
      });
      assert.equal(status, 200);
      assert.equal(fs.realpathSync(captured.at(-1)!.cwd!), fs.realpathSync(worktree.sessionCwd));
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }

    // An ordinary conversation of the same workspace keeps its folder.
    seedChat('n-plain', 'ws-git');
    await manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-git', nodeId: 'n-plain' });
    assert.equal(captured.at(-1)?.cwd, repo);
  });

  test('a workspace folder inside the repository maps into the worktree', async () => {
    const repo = makeRepo(path.join(tmpDir, 'repo'));
    seedWorkspace('ws-sub', path.join(repo, 'app'));
    seedChat('n-sub', 'ws-sub');
    const worktree = (await workConversationWorktrees.prepare({ nodeId: 'n-sub', workspaceCwd: path.join(repo, 'app'), title: 'Sub' }))!;
    assert.equal(worktree.sessionCwd, path.join(worktree.worktreePath, 'app'));
    assert.ok(fs.existsSync(path.join(worktree.sessionCwd, 'index.ts')));
    assert.equal(workConversationCwd('n-sub'), worktree.sessionCwd);
  });

  test('not a repository, a repository with no commit, cloud mode: the workspace folder, nothing recorded', async () => {
    const plain = path.join(tmpDir, 'plain');
    fs.mkdirSync(plain);
    const empty = path.join(tmpDir, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    const repo = makeRepo(path.join(tmpDir, 'repo'));
    for (const [id, cwd] of [['ws-plain', plain], ['ws-empty', empty], ['ws-cloud', repo]] as const) {
      seedWorkspace(id, cwd);
      seedChat(`n-${id}`, id);
    }
    assert.equal(await workConversationWorktrees.prepare({ nodeId: 'n-ws-plain', workspaceCwd: plain, title: 'x' }), null);
    assert.equal(await workConversationWorktrees.prepare({ nodeId: 'n-ws-empty', workspaceCwd: empty, title: 'x' }), null);
    assert.equal(await workConversationWorktrees.prepare({ nodeId: 'n-ws-plain', workspaceCwd: path.join(tmpDir, 'missing'), title: 'x' }), null);
    assert.equal(await workConversationWorktrees.prepare({ nodeId: 'n-ws-plain', workspaceCwd: null, title: 'x' }), null);
    const cloud = createWorkConversationWorktrees({ cloud: () => true });
    assert.equal(await cloud.prepare({ nodeId: 'n-ws-cloud', workspaceCwd: repo, title: 'x' }), null);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM work_conversation_worktrees').get() as { n: number }).n, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'worktrees', 'n-ws-cloud')), false);
    assert.equal(git(repo, 'branch', '--list', 'michi/*'), '');
    for (const id of ['n-ws-plain', 'n-ws-empty', 'n-ws-cloud']) assert.equal(workConversationCwd(id), null);

    // A recorded worktree is never used in cloud mode, whose sandbox decides the folder.
    seedChat('n-local', 'ws-cloud');
    assert.ok(await workConversationWorktrees.prepare({ nodeId: 'n-local', workspaceCwd: repo, title: 'x' }));
    process.env.MICHI_CLOUD = '1';
    assert.equal(workConversationCwd('n-local'), null);
  });

  test('a start whose session does not open removes the worktree and branch it made; discard keeps a branch with commits of its own', async () => {
    const repo = makeRepo(path.join(tmpDir, 'repo'));
    seedWorkspace('ws-git', repo);
    const agent = ensureAssistant();
    let made: string | null = null;
    const failed = await startConversationTool(
      { ownerUserId: null, workspaceId: agent.workspaceId, nodeId: agent.nodeId },
      { workspaceId: 'ws-git', text: 'Try something' },
      approve,
      deps(async (input) => { made = workConversationCwd(input.nodeId); throw new Error('no runtime here'); }),
    );
    assert.equal(failed.isError, true);
    assert.ok(made, 'the worktree existed when the session was asked for');
    assert.equal(fs.existsSync(made!), false);
    assert.equal(git(repo, 'branch', '--list', 'michi/*'), '');
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);

    seedChat('n-kept', 'ws-git');
    const worktree = (await workConversationWorktrees.prepare({ nodeId: 'n-kept', workspaceCwd: repo, title: 'Kept' }))!;
    fs.writeFileSync(path.join(worktree.worktreePath, 'work.txt'), 'done\n');
    git(worktree.worktreePath, 'add', 'work.txt');
    git(worktree.worktreePath, 'commit', '-q', '-m', 'the conversation\'s work');
    await workConversationWorktrees.discard('n-kept');
    assert.equal(fs.existsSync(worktree.worktreePath), false);
    assert.equal(git(repo, 'branch', '--list', worktree.branch).replace(/^[*+ ]+/, ''), worktree.branch);
    assert.equal(workConversationWorktreeOf('n-kept'), null);
  });

  test('a worktree that is gone falls back to the workspace folder; the record goes with its node', async () => {
    const repo = makeRepo(path.join(tmpDir, 'repo'));
    seedWorkspace('ws-git', repo);
    seedChat('n-gone', 'ws-git');
    const worktree = (await workConversationWorktrees.prepare({ nodeId: 'n-gone', workspaceCwd: repo, title: 'Gone' }))!;
    fs.rmSync(worktree.worktreePath, { recursive: true, force: true });
    assert.equal(workConversationCwd('n-gone'), null);
    const manager = new ChatManager(undefined, tmpDir);
    await manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-git', nodeId: 'n-gone' });
    assert.equal(captured.at(-1)?.cwd, repo);

    getDb().prepare('DELETE FROM nodes WHERE id = ?').run('n-gone');
    assert.equal(workConversationWorktreeOf('n-gone'), null);
  });

  test('branch names: the title\'s words and the node id\'s end, always a valid ref', () => {
    assert.equal(workConversationBranch('Fix the flaky test!', 'n-0123abcd-ef45-6789-aaaa-bbbbccccdddd'), 'michi/fix-the-flaky-test-ccccdddd');
    assert.equal(workConversationBranch('修复测试', 'n-12345678'), 'michi/12345678');
    for (const title of ['..', 'a/b\\c', 'x'.repeat(200), '-lead', 'HEAD', '']) {
      const branch = workConversationBranch(title, 'n-9f8e7d6c');
      assert.equal(execFileSync('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' }).trim(), branch, title);
    }
  });
});
