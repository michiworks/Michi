/**
 * Cloud-mode per-user workspace sandbox: the per-user sandbox root, the cwd
 * prefix check, and the owned-workspace cwd derivation used by routes and
 * services. These read Michi's data dir and workspace store. The generic path
 * containment helpers stay in agents/tools/pathSandbox.ts.
 */

import path from "node:path";
import fs from "node:fs";
import { getRuntimeDeps } from "../agents/runtimeDeps";
import { isWithinRoot, normalizeWorkspaceCwd, PathSandboxError } from "michi-runtime/internal/core/pathSandbox";
import { log } from "./logger";

/**
 * Returns the per-user sandbox root in cloud mode.
 * e.g. /data/user-cwds/<userId>
 *
 * MICHI_DATA_DIR defaults to ~/.michi on desktop (where this function is
 * never called in practice because all callers gate on MICHI_CLOUD=1).
 */
export function getUserSandboxRoot(userId: string): string {
    return path.join(getRuntimeDeps().dataDir, "user-cwds", userId);
}

/**
 * Throw (PathSandboxError) if `cwd` is not inside the per-user sandbox root.
 * Call only when `process.env.MICHI_CLOUD === '1'`.
 *
 * The sandbox dir does not need to exist on disk — this is a prefix check,
 * not a stat. Creating the directory is P1.10's responsibility.
 */
export function assertCwdAllowed(cwd: string, userId: string): void {
    const root = getUserSandboxRoot(userId);
    const abs = path.resolve(cwd);
    if (!isWithinRoot(abs, root)) {
        throw new PathSandboxError(abs, root);
    }
}

/**
 * Typed error thrown when workspaceId is not found or not owned by userId.
 * Callers should catch and return HTTP 404.
 */
export class NotFoundError extends Error {
    constructor(public readonly workspaceId: string) {
        super(`workspace not found: ${workspaceId}`);
        this.name = "NotFoundError";
    }
}

/**
 * Derive a trusted, user-owned cwd from a workspaceId in cloud mode.
 *
 * - Verifies workspace exists and is owned by `userId` (via getWorkspace with userId).
 * - Returns `<getUserSandboxRoot(userId)>/ws-<workspaceId>`, creating the directory.
 * - Throws NotFoundError on ownership mismatch or missing workspace.
 *
 * Only call in cloud mode (MICHI_CLOUD === '1'). Desktop callers continue to
 * trust the client-supplied cwd.
 */
export function deriveSandboxCwd(userId: string, workspaceId: string): string {
    const row = getRuntimeDeps().historyStore.getWorkspace(workspaceId, userId);
    if (!row || row.owner_user_id !== userId) {
        throw new NotFoundError(workspaceId);
    }
    const dir = path.join(getUserSandboxRoot(userId), `ws-${workspaceId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * The folder a session of this workspace runs in, for callers that open one
 * without a request. Cloud: the owner's sandbox, never the row's cwd, which a
 * client can write; without an owner it throws NotFoundError. Desktop: the
 * workspace's folder, or `fallbackCwd` when it has none.
 */
export function workspaceSessionCwd(
    workspace: { id: string; cwd?: string | null },
    ownerUserId: string | null | undefined,
    fallbackCwd: string,
): string {
    if (process.env.MICHI_CLOUD === "1") {
        if (!ownerUserId) throw new NotFoundError(workspace.id);
        return deriveSandboxCwd(ownerUserId, workspace.id);
    }
    return normalizeWorkspaceCwd(workspace.cwd ?? fallbackCwd);
}

/**
 * A route's cloud cwd: the owned workspace's sandbox (deriveSandboxCwd), or
 * the status and error to answer with. Each route picks its own workspaceId.
 */
export function ownedSandboxCwd(userId: string, workspaceId: string): { cwd: string } | { status: 404 | 500; error: string } {
    let cwd: string;
    try {
        cwd = deriveSandboxCwd(userId, workspaceId);
    } catch (err) {
        if (err instanceof NotFoundError) return { status: 404, error: "workspace not found" };
        // The message names the server's sandbox path: log it, do not send it.
        log.error("workspace", "workspace sandbox folder could not be prepared", { workspaceId, error: (err as Error).message });
        return { status: 500, error: "Could not prepare the workspace folder" };
    }
    // Defense in depth: the derived cwd is the user's sandbox.
    assertCwdAllowed(cwd, userId);
    return { cwd };
}

/**
 * deriveSandboxCwd for a caller that reads files under the sandbox on the
 * user's behalf (the cloud file routes, search_artifacts): the directory
 * must also be the user's own on disk. Every path check below it resolves
 * against the root's real path, so a sandbox replaced by a symlink into
 * another user's sandbox (an agent's shell runs inside the sandbox and can
 * write its parent) would make that user's files pass as this workspace's.
 * Neither the user's sandbox root nor the workspace's directory may be a
 * symlink, and their real paths must be `<real user-cwds>/<userId>` and
 * `.../ws-<workspaceId>`. Returns the same path as deriveSandboxCwd; throws
 * NotFoundError otherwise, as for a workspace that is not the user's.
 */
export function deriveVerifiedSandboxCwd(userId: string, workspaceId: string): string {
    return verifySandbox(userId, workspaceId).dir;
}

/**
 * deriveVerifiedSandboxCwd plus the sandbox's real path as it was verified.
 * A caller that checks paths again later must compare them with `realDir`,
 * not with a fresh realpath of `dir`: the directory can be swapped for a
 * symlink after this check, and a fresh realpath would follow it.
 */
export function verifySandbox(userId: string, workspaceId: string): { dir: string; realDir: string } {
    const dir = deriveSandboxCwd(userId, workspaceId);
    const userRoot = getUserSandboxRoot(userId);
    let realDir: string | null = null;
    try {
        const realUserRoot = path.join(fs.realpathSync(path.join(getRuntimeDeps().dataDir, "user-cwds")), userId);
        const expected = path.join(realUserRoot, `ws-${workspaceId}`);
        const owned = !fs.lstatSync(userRoot).isSymbolicLink() && !fs.lstatSync(dir).isSymbolicLink()
            && fs.realpathSync(userRoot) === realUserRoot
            && fs.realpathSync(dir) === expected;
        if (owned) realDir = expected;
    } catch {
        // Gone or unreadable: not the user's directory either.
    }
    if (!realDir) throw new NotFoundError(workspaceId);
    return { dir, realDir };
}
