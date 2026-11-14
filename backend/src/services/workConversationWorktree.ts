/**
 * A work conversation's own git worktree (design D18, Q26; lane D,
 * 2026-11-12): a conversation Michi starts (start_conversation from V, or an
 * applied conversation.start card) in a workspace whose folder is a git
 * repository opens on a worktree of that repository, on a new branch from
 * its current HEAD, under Michi's data directory. Its changes stay off the
 * user's checkout; a merge or push of them waits for the user (the
 * consequence rules: agents/callConsequence.ts).
 *
 * Every session of the node opens in that folder, on every runtime and after
 * a restart (workConversationCwd: chatManager, the ensure-session and load
 * routes, a Kiro context reset). A workspace that is not a repository, has
 * no commit, runs in cloud mode, or whose worktree cannot be made, keeps
 * today's behaviour: the conversation runs in the workspace folder.
 *
 * Not here yet: removing a worktree once its conversation is done (only a
 * start that failed removes the one it made), and bringing the branch back.
 *
 * The worktree is a checkout of HEAD: the user's uncommitted changes and
 * untracked files (node_modules included) are not in it.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, openDbOrNull } from './db';
import { getMichiDataDir } from './dataDir';
import { log } from './logger';

export type WorktreeGitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export interface WorkConversationWorktree {
  /** The worktree's root. */
  worktreePath: string;
  /** Where the conversation's sessions open: the worktree root, or the workspace's folder within it. */
  sessionCwd: string;
  branch: string;
  repositoryRoot: string;
  baseCommit: string;
}

export interface WorkConversationWorktreePort {
  /** Makes the node's worktree and records it; null when the conversation keeps the workspace folder. Never throws. */
  prepare(input: { nodeId: string; workspaceCwd: string | null | undefined; title: string }): Promise<WorkConversationWorktree | null>;
  /** Removes the worktree a start made, when the start failed: its branch only while it has no commit of its own. Never throws. */
  discard(nodeId: string): Promise<void>;
}

const GIT_TIMEOUT_MS = 30_000;
const SAFE_NODE_ID = /^[A-Za-z0-9_-]{1,160}$/;

function defaultGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, shell: false, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) { resolve(String(stdout)); return; }
        reject(new Error(`git ${args[0] ?? ''} failed: ${String(stderr || error.message).slice(0, 2_000)}`));
      });
  });
}

/** `michi/<words of the title>-<the node id's last characters>`: a valid, unique branch name. */
export function workConversationBranch(title: string, nodeId: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  const suffix = nodeId.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'work';
  return `michi/${slug ? `${slug}-` : ''}${suffix}`;
}

interface WorktreeRow {
  worktree_path: string;
  session_cwd: string;
  branch: string;
  repository_root: string;
  base_commit: string;
}

function rowOf(nodeId: string): WorktreeRow | null {
  const db = openDbOrNull();
  if (!db) return null;
  const row = db.prepare('SELECT worktree_path, session_cwd, branch, repository_root, base_commit FROM work_conversation_worktrees WHERE node_id = ?')
    .get(nodeId) as unknown as WorktreeRow | undefined;
  return row ?? null;
}

/**
 * The folder every session of this node opens in when it is a work
 * conversation with its own worktree; null otherwise (the workspace's folder
 * applies), and in cloud mode. A worktree that is gone is logged and the
 * workspace's folder applies. Never throws.
 */
export function workConversationCwd(nodeId: string | null | undefined): string | null {
  if (process.env.MICHI_CLOUD === '1' || typeof nodeId !== 'string' || !SAFE_NODE_ID.test(nodeId)) return null;
  try {
    const row = rowOf(nodeId);
    if (!row) return null;
    if (!fs.existsSync(row.session_cwd)) {
      log.warn('workspace', 'work conversation worktree is gone; the conversation runs in the workspace folder', { nodeId, path: row.session_cwd });
      return null;
    }
    return row.session_cwd;
  } catch (error) {
    log.warn('workspace', 'work conversation worktree not read; the conversation runs in the workspace folder', {
      nodeId, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function createWorkConversationWorktrees(deps: {
  dataDir?: () => string;
  git?: WorktreeGitRunner;
  cloud?: () => boolean;
  now?: () => number;
} = {}): WorkConversationWorktreePort {
  const git = deps.git ?? defaultGit;
  const dataDir = deps.dataDir ?? getMichiDataDir;
  const cloud = deps.cloud ?? (() => process.env.MICHI_CLOUD === '1');
  const now = deps.now ?? Date.now;

  async function prepare(input: { nodeId: string; workspaceCwd: string | null | undefined; title: string }): Promise<WorkConversationWorktree | null> {
    const { nodeId } = input;
    const folder = typeof input.workspaceCwd === 'string' ? input.workspaceCwd.trim() : '';
    if (cloud() || !folder || !SAFE_NODE_ID.test(nodeId)) return null;
    let workspaceFolder: string;
    try {
      workspaceFolder = fs.realpathSync(folder);
    } catch {
      return null;
    }
    let repositoryRoot: string;
    try {
      repositoryRoot = fs.realpathSync((await git(workspaceFolder, ['rev-parse', '--show-toplevel'])).trim());
    } catch {
      // Not a git repository: the conversation works in the workspace folder, as before.
      return null;
    }
    const warn = (message: string, error?: unknown) => {
      log.warn('workspace', `work conversation keeps the workspace folder: ${message}`, {
        nodeId, repositoryRoot, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      });
      return null;
    };
    let baseCommit: string;
    try {
      baseCommit = (await git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    } catch (error) {
      return warn('the repository has no commit to branch from', error);
    }
    const branch = workConversationBranch(input.title, nodeId);
    const root = path.join(dataDir(), 'worktrees');
    const worktreePath = path.join(root, nodeId);
    if (fs.existsSync(worktreePath)) return warn(`${worktreePath} already exists`);
    try {
      fs.mkdirSync(root, { recursive: true });
      await git(repositoryRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
    } catch (error) {
      return warn('git worktree add failed', error);
    }
    const relative = path.relative(repositoryRoot, workspaceFolder);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const sessionCwd = inside ? path.join(worktreePath, relative) : worktreePath;
    try {
      fs.mkdirSync(sessionCwd, { recursive: true });
      getDb().prepare(`INSERT INTO work_conversation_worktrees
          (node_id, worktree_path, session_cwd, branch, repository_root, base_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(nodeId, worktreePath, sessionCwd, branch, repositoryRoot, baseCommit, now());
    } catch (error) {
      await removeWorktree(repositoryRoot, worktreePath, branch, baseCommit);
      return warn('the worktree could not be recorded', error);
    }
    return { worktreePath, sessionCwd, branch, repositoryRoot, baseCommit };
  }

  async function removeWorktree(repositoryRoot: string, worktreePath: string, branch: string, baseCommit: string): Promise<void> {
    await git(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
    // Only a branch still at its base: one with commits of its own is the conversation's work.
    const tip = await git(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]).then((out) => out.trim(), () => null);
    if (tip === baseCommit) await git(repositoryRoot, ['branch', '-D', branch]).catch(() => undefined);
  }

  async function discard(nodeId: string): Promise<void> {
    try {
      const row = rowOf(nodeId);
      if (!row) return;
      await removeWorktree(row.repository_root, row.worktree_path, row.branch, row.base_commit);
      getDb().prepare('DELETE FROM work_conversation_worktrees WHERE node_id = ?').run(nodeId);
    } catch (error) {
      log.warn('workspace', 'work conversation worktree not removed', { nodeId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { prepare, discard };
}

/** Michi's: git on PATH, worktrees under the data directory. */
export const workConversationWorktrees: WorkConversationWorktreePort = createWorkConversationWorktrees();
