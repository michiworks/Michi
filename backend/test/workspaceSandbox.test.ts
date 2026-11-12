// backend/test/workspaceSandbox.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import {
  assertCwdAllowed,
  deriveSandboxCwd,
  deriveVerifiedSandboxCwd,
  getUserSandboxRoot,
  NotFoundError,
  ownedSandboxCwd,
  workspaceSessionCwd,
} from "../src/services/workspaceSandbox";
import { resolveWorkspaceFileRoot } from "../src/services/workspaceFiles";
import * as pathSandbox from "../src/agents/tools/pathSandbox";
import { log } from "../src/services/logger";
import type { HistoryStore } from "../src/agents/ports";

const store: HistoryStore = {
  getNode: () => null, listMessages: () => [],
  getWorkspace: (id, userId) => (id === "ws1" ? { owner_user_id: userId ?? "u1" } : null),
  getWorkspaceInstructions: () => null,
};
const cfg = { getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => "", resolveReasoning: () => undefined };

describe("workspaceSandbox with injected deps", () => {
  afterEach(() => __resetRuntimeDeps());

  test("deriveSandboxCwd throws NotFoundError on unknown workspace", () => {
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir: "/tmp/agent-runtime-sbx" });
    assert.throws(() => deriveSandboxCwd("u1", "nope"), NotFoundError);
  });

  test("deriveSandboxCwd creates ws-<id> under the user's sandbox root", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "michi-workspace-sandbox-"));
    try {
      configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir });
      const root = getUserSandboxRoot("u1");
      assert.equal(root, path.join(dataDir, "user-cwds", "u1"));
      const cwd = deriveSandboxCwd("u1", "ws1");
      assert.equal(cwd, path.join(root, "ws-ws1"));
      assert.ok(fs.statSync(cwd).isDirectory());
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("ownedSandboxCwd answers 404 for another's workspace and 500 without the path when the folder cannot be made", (t) => {
    t.mock.method(log, "error", () => {});
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "michi-owned-sandbox-"));
    try {
      configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir });
      assert.deepEqual(ownedSandboxCwd("u1", "ws1"), { cwd: path.join(dataDir, "user-cwds", "u1", "ws-ws1") });
      assert.deepEqual(ownedSandboxCwd("u1", "nope"), { status: 404, error: "workspace not found" });
      fs.writeFileSync(path.join(dataDir, "user-cwds", "u2"), "not a folder");
      assert.deepEqual(ownedSandboxCwd("u2", "ws1"), { status: 500, error: "Could not prepare the workspace folder" });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("assertCwdAllowed accepts the sandbox root and its children only", () => {
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir: "/tmp/agent-runtime-sbx" });
    const root = getUserSandboxRoot("u1");
    assert.doesNotThrow(() => assertCwdAllowed(root, "u1"));
    assert.doesNotThrow(() => assertCwdAllowed(path.join(root, "ws-ws1", "sub"), "u1"));
    assert.throws(() => assertCwdAllowed(`${root}x`, "u1"), pathSandbox.PathSandboxError);
    assert.throws(() => assertCwdAllowed(getUserSandboxRoot("u2"), "u1"), pathSandbox.PathSandboxError);
  });

  test("workspaceSessionCwd roots cloud sessions in the owner's sandbox and desktop ones in the folder or fallback", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "michi-workspace-session-cwd-"));
    const priorCloud = process.env.MICHI_CLOUD;
    try {
      configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir });
      const sandbox = path.join(dataDir, "user-cwds", "u1", "ws-ws1");
      const folder = fs.mkdtempSync(path.join(dataDir, "folder-"));
      const fallback = fs.mkdtempSync(path.join(dataDir, "fallback-"));
      process.env.MICHI_CLOUD = "1";
      for (const cwd of [null, undefined, "/etc", folder]) {
        assert.equal(workspaceSessionCwd({ id: "ws1", cwd }, "u1", fallback), sandbox, `cloud ignores cwd ${cwd}`);
      }
      for (const owner of [null, undefined, ""]) {
        assert.throws(() => workspaceSessionCwd({ id: "ws1", cwd: folder }, owner, fallback), NotFoundError);
      }
      assert.throws(() => workspaceSessionCwd({ id: "nope", cwd: folder }, "u1", fallback), NotFoundError);
      delete process.env.MICHI_CLOUD;
      assert.equal(workspaceSessionCwd({ id: "ws1", cwd: folder }, "u1", fallback), fs.realpathSync.native(folder));
      assert.equal(workspaceSessionCwd({ id: "ws1", cwd: null }, null, fallback), fs.realpathSync.native(fallback));
      assert.equal(workspaceSessionCwd({ id: "nope" }, undefined, fallback), fs.realpathSync.native(fallback));
    } finally {
      if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("agents/tools/pathSandbox keeps only the path containment helpers", () => {
    for (const name of ["getUserSandboxRoot", "assertCwdAllowed", "deriveSandboxCwd", "NotFoundError"]) {
      assert.equal(name in pathSandbox, false, `${name} belongs to services/workspaceSandbox`);
    }
  });

  test("a sandbox or user root replaced by a symlink is not the user's: the cloud file root refuses it", (t) => {
    const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "michi-workspace-sandbox-")));
    const cloud = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = "1";
    t.after(() => {
      if (cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = cloud;
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir });
    const req = { user: { id: "u1" } } as never;
    // The user's own directory: accepted, by both.
    const own = deriveSandboxCwd("u1", "ws1");
    assert.equal(deriveVerifiedSandboxCwd("u1", "ws1"), own);
    assert.equal(resolveWorkspaceFileRoot(req, "ws1"), own);
    // The sandbox swapped for a symlink into another user's sandbox.
    const other = path.join(dataDir, "user-cwds", "u2", "ws-ws9");
    fs.mkdirSync(other, { recursive: true });
    fs.rmSync(own, { recursive: true });
    fs.symlinkSync(other, own);
    assert.throws(() => deriveVerifiedSandboxCwd("u1", "ws1"), NotFoundError);
    assert.throws(() => resolveWorkspaceFileRoot(req, "ws1"), NotFoundError);
    assert.throws(() => resolveWorkspaceFileRoot(req, "ws1", { allocate: true }), NotFoundError);
    // The user's whole root swapped for a symlink to a lookalike folder.
    fs.rmSync(own);
    const userRoot = getUserSandboxRoot("u1");
    fs.rmSync(userRoot, { recursive: true });
    const lookalike = path.join(dataDir, "elsewhere");
    fs.mkdirSync(path.join(lookalike, "ws-ws1"), { recursive: true });
    fs.symlinkSync(lookalike, userRoot);
    assert.throws(() => deriveVerifiedSandboxCwd("u1", "ws1"), NotFoundError);
    assert.throws(() => resolveWorkspaceFileRoot(req, "ws1"), NotFoundError);
  });
});
