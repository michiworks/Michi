import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { isWithinRoot, PathSandboxError } from '../agents/tools/pathSandbox';
import { deriveVerifiedSandboxCwd, NotFoundError } from './workspaceSandbox';
import { getWorkspace } from './dbRepository';

export const WORKSPACE_FILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SHARED_UPLOAD_ROOT = '/shared/michi/files';
const execFileAsync = promisify(execFile);

export function desktopUploadRoot(): string {
  try {
    if (fs.statSync(path.dirname(SHARED_UPLOAD_ROOT)).isDirectory()) return SHARED_UPLOAD_ROOT;
  } catch { /* shared volume is optional */ }
  return path.join(os.tmpdir(), 'michi', 'files');
}

function directoryExists(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * One root policy for HTTP files, artifacts, diffs and upload allocation.
 * A saved session cwd wins. Otherwise retain an existing upload directory;
 * legacy Electron scratch directories are used only when no upload exists.
 * Allocation may precede desktop workspace persistence, while reads require a row.
 * Cloud roots always verify ownership, including on allocation, and that the
 * sandbox on disk is the user's own directory, not a symlink to another's.
 */
export function resolveWorkspaceFileRoot(
  req: Pick<Request, 'user'>,
  workspaceId: string,
  options: { allocate?: boolean } = {},
): string {
  if (!WORKSPACE_FILE_ID_RE.test(workspaceId)) throw new NotFoundError(workspaceId);
  if (process.env.MICHI_CLOUD === '1') {
    if (!req.user?.id) throw new NotFoundError(workspaceId);
    return deriveVerifiedSandboxCwd(req.user.id, workspaceId);
  }
  const workspace = getWorkspace(workspaceId);
  if (!workspace && !options.allocate) throw new NotFoundError(workspaceId);
  let root: string;
  if (typeof workspace?.cwd === 'string' && workspace.cwd.trim()) {
    root = workspace.cwd;
  } else {
    const upload = path.join(desktopUploadRoot(), workspaceId);
    const scratch = path.join(os.homedir(), '.michi', 'workspaces', workspaceId);
    root = directoryExists(upload) ? upload : directoryExists(scratch) ? scratch : upload;
  }
  if (options.allocate) fs.mkdirSync(root, { recursive: true });
  return path.resolve(root);
}

/** Message attachments stay out of .contexts/, which the first-turn manifest
 * advertises; anything unrecognised falls back to the legacy .contexts/. */
export function importSubdir(raw: unknown): '.attachments' | '.contexts' {
  return raw === '.attachments' || raw === '.contexts' ? raw : '.contexts';
}

export type WorkspaceFilePlacement =
  | { target: string; file: { name: string; displayName: string; filePath: string } }
  | { status: number; error: string };

/** Sanitise originalName and pick the first free name for it in cwd/subdir,
 * creating the directory. The caller writes the bytes to target. */
export function placeWorkspaceFile(cwd: string, subdir: string, originalName: string): WorkspaceFilePlacement {
  const base = path.basename(originalName);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length).replace(/[^a-zA-Z0-9_-]/g, '_') || 'file';
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '');
  const dir = path.join(cwd, subdir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { status: 500, error: `mkdir ${subdir} failed: ${(err as Error).message}` };
  }
  let name = stem;
  let filename = `${stem}${safeExt}`;
  let attempt = 0;
  // lstat, not existsSync: a dangling link keeps its name, so no write follows it.
  while (fs.lstatSync(path.join(dir, filename), { throwIfNoEntry: false })) {
    attempt += 1;
    name = `${stem}-${attempt}`;
    filename = `${name}${safeExt}`;
    if (attempt > 9999) return { status: 500, error: 'could not allocate unique filename' };
  }
  const target = path.join(dir, filename);
  if (!target.startsWith(dir + path.sep)) return { status: 400, error: `resolved path escapes ${subdir}` };
  return { target, file: { name, displayName: base, filePath: `${subdir}/${filename}` } };
}

function assertContained(candidate: string, root: string): void {
  if (!isWithinRoot(candidate, root)) throw new PathSandboxError(candidate, root);
}

/** HTTP input is already decoded once by Express. Never expand mentions/home,
 * normalize Unicode spaces, decode again, or interpret Windows separators.
 */
export function resolveHttpWorkspacePath(relativePath: string, root: string): string {
  const segments = relativePath.split('/');
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0')
    || /^[a-zA-Z]:/.test(relativePath)
    || segments.some((segment) => !segment || segment.startsWith('~') || segment.startsWith('@'))) {
    throw new PathSandboxError(relativePath, root);
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  assertContained(candidate, resolvedRoot);
  return candidate;
}

/** Resolve the longest existing prefix, also protecting diffs of deleted files. */
export function assertWorkspaceRealpath(candidate: string, root: string): string {
  const realRoot = fs.realpathSync(root);
  let cursor = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = path.join(fs.realpathSync(cursor), ...missing.reverse());
      assertContained(real, realRoot);
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink must not be treated as a merely missing file.
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new PathSandboxError(candidate, root); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function resolveWorkspaceRegularFile(relativePath: string, root: string): { realPath: string; stat: fs.Stats } {
  const realPath = assertWorkspaceRealpath(resolveHttpWorkspacePath(relativePath, root), root);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new PathSandboxError(relativePath, root);
  return { realPath, stat };
}

const SUFFIX_WALK_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__']);
const SUFFIX_WALK_MAX_ENTRIES = 20_000;
const SUFFIX_WALK_MAX_DEPTH = 12;

/** Workspace files relative to root: git's tracked and unignored files, else a bounded walk. */
async function listWorkspaceFilesForSuffix(root: string): Promise<string[]> {
  try {
    // Only root is passed to git; fsmonitor is disabled so repository config cannot run a command.
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
    ], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return stdout.split('\0').filter(Boolean);
  } catch { /* not a git work tree, or git is unavailable */ }
  const files: string[] = [];
  let seen = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > SUFFIX_WALK_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > SUFFIX_WALK_MAX_ENTRIES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile()) files.push(childRel);
      else if (entry.isDirectory() && !entry.name.startsWith('.') && !SUFFIX_WALK_SKIP_DIRS.has(entry.name)) {
        await walk(path.join(dir, entry.name), childRel, depth + 1);
      }
    }
  };
  await walk(root, '', 0);
  return files;
}

/**
 * Chat answers often cite a file by its basename or trailing path
 * (`runtimeCopy.ts`, `settings/runtimeCopy.ts`). Return the one workspace file
 * whose relative path ends with that suffix; none or several return null.
 * Callers must still resolve the result with resolveWorkspaceRegularFile.
 */
export async function findWorkspaceFileBySuffix(root: string, suffix: string): Promise<string | null> {
  const normalized = suffix.replace(/^(?:\.\/)+/, '');
  const segments = normalized.split('/');
  if (!normalized || normalized.includes('\\') || normalized.includes('\0')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const tail = `/${normalized}`;
  let match: string | null = null;
  for (const file of await listWorkspaceFilesForSuffix(root)) {
    if (file !== normalized && !file.endsWith(tail)) continue;
    if (match !== null) return null;
    match = file;
  }
  return match;
}
