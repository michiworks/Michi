// backend/test/piTools.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import { buildPiTools, piToolResultErrorOverride } from "../src/agents/pi/piTools";
import { SUBMIT_AGENT_RESULT_TOOL } from "../src/agents/runs/runWorkerTools";
import { chatOwner, runOwner } from "./helpers/owners";

const baseCfg = { getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => "", resolveReasoning: () => undefined };
const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null };
// Minimal typebox stand-in: every builder returns a plain object.
const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });
function opts() {
  return { bridge: {} as any, cwd: "/tmp", parentChatId: "p", workspaceId: null, enableFollowUps: true,
    imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type };
}

test('Pi provides the same offline Michi docs without a global context provider', async t => {
  configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: '/tmp/agent-runtime-test' });
  t.after(() => __resetRuntimeDeps());
  const tool = buildPiTools(opts()).find((tool: any) => tool.name === 'michi_docs');
  assert.ok(tool);
  const index = await tool.execute('docs-list', {});
  assert.ok(JSON.parse(index.content[0].text).documents.some((doc: any) => doc.id === 'permissions'));
  const read = await tool.execute('docs-read', { action: 'read', docId: 'permissions' });
  assert.match(read.content[0].text, /Trust this tool/);
  assert.equal((await tool.execute('docs-invalid', { action: 'read', docId: '../config.json' })).isError, true);
});

describe("buildPiTools global-context gating", () => {
  afterEach(() => __resetRuntimeDeps());

  test("includes them when a provider is injected", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test",
      globalContext: { listThreads: () => ({ status: "ok", text: "" }), searchMessages: () => ({ status: "ok", text: "" }), readNode: () => ({ status: "ok", text: "" }), readNodeOverview: () => ({ status: "ok", text: "" }) } });
    const names = buildPiTools(opts() as any).map((t: any) => t.name);
    for (const n of ["list_threads", "search_messages", "read_node", "read_node_overview"]) assert.ok(names.includes(n), `${n} should be present`);
  });
});

describe("buildPiTools bridge gating", () => {
  afterEach(() => __resetRuntimeDeps());

  test("offers a business tool only when the bridge has its effect", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const effects = ["spawn_branches", "save_artifact", "update_artifact"];
    const offered = (bridge: Record<string, unknown>) =>
      buildPiTools({ ...opts(), bridge } as any).map((t: any) => t.name).filter((name: string) => effects.includes(name));
    assert.deepEqual(offered({ spawnBranches: async () => [], saveContext: () => null, updateContext: () => null }), effects);
    assert.deepEqual(offered({ saveContext: () => null }), ["save_artifact"]);
    assert.deepEqual(offered({}), []);
  });
});

describe("buildPiTools send_to_thread", () => {
  afterEach(() => __resetRuntimeDeps());

  test("refuses before asking when the session has no workspace binding", async () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    let asked = 0;
    const tool = buildPiTools({
      ...opts(),
      owner: chatOwner("n-a"),
      requestUserInput: async () => { asked += 1; return []; },
    } as any).find((t: any) => t.name === "send_to_thread");
    const result = await tool.execute("call-1", { nodeId: "n-b", text: "hi" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^SOURCE_UNAVAILABLE/);
    assert.equal(asked, 0);
  });
});

describe("Pi tool result error propagation", () => {
  test("does not override successful or already-failed tool executions", () => {
    assert.equal(piToolResultErrorOverride({ result: { isError: false }, isError: false }), undefined);
    assert.equal(piToolResultErrorOverride({ result: { isError: true }, isError: true }), undefined);
  });
});

describe("Pi session-bound Agent tools", () => {
  afterEach(() => __resetRuntimeDeps());

  test("registers generic Agent tools only from the supplied session invoker", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const invoker = { invoke: async () => ({ ok: true }) };
    const enabled = buildPiTools({ ...opts(), agentRunTools: invoker } as any).map((tool: any) => tool.name);
    const disabled = buildPiTools(opts() as any).map((tool: any) => tool.name);
    assert.ok(enabled.includes("spawn_agent"));
    assert.ok(!disabled.includes("spawn_agent"));
  });

  test("submit_agent_result is Run-only and forwards the exact Attempt owner", async () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const owner = runOwner("run-a", "attempt-a");
    const submissions: any[] = [];
    const profile = {
      allowedToolNames: [SUBMIT_AGENT_RESULT_TOOL],
      runWorkerTools: { submitAgentResult: (actualOwner: unknown, payload: unknown) => {
        submissions.push([actualOwner, payload]);
        return payload;
      } },
    };
    const runTools = buildPiTools({ ...opts(), owner, toolProfile: profile } as any);
    const chatTools = buildPiTools({ ...opts(), owner: chatOwner("node-a"), toolProfile: profile } as any);
    const submit = runTools.find((tool: any) => tool.name === SUBMIT_AGENT_RESULT_TOOL);
    assert.ok(submit);
    assert.equal(chatTools.some((tool: any) => tool.name === SUBMIT_AGENT_RESULT_TOOL), false);
    await submit.execute("tool-call-a", { version: 1, status: "completed" });
    assert.deepEqual(submissions, [[owner, { version: 1, status: "completed" }]]);
  });
});

describe("Pi task tools", () => {
  afterEach(() => __resetRuntimeDeps());

  test("a chat gets open_task_database and list_tasks; opening the task database runs one call at a time", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const tools = buildPiTools({ ...opts(), owner: { mode: "interactive", key: "node-a" } } as any);
    const open = tools.find((tool: any) => tool.name === "open_task_database");
    const list = tools.find((tool: any) => tool.name === "list_tasks");
    assert.ok(tools.find((tool: any) => tool.name === "read_home"));
    assert.equal(tools.find((tool: any) => tool.name === "edit_home")?.executionMode, "sequential");
    for (const name of ["create_database", "configure_database"]) {
      assert.equal(tools.find((tool: any) => tool.name === name)?.executionMode, "sequential");
    }
    assert.ok(open, "open_task_database");
    assert.ok(list, "list_tasks");
    assert.equal(open.executionMode, "sequential");
    assert.equal(list.executionMode, undefined);
  });
});

test('Pi file tools read skill folders outside the workspace but never write them', async (t) => {
  configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: '/tmp/agent-runtime-test' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-roots-'));
  t.after(() => { __resetRuntimeDeps(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const workspace = path.join(tmp, 'workspace');
  const library = path.join(tmp, 'skills');
  const skillFile = path.join(library, 'notes', 'SKILL.md');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '---\nname: notes\ndescription: Notes\n---\nKEEP-NOTES-4512\n');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(workspace, 'own.md'), 'own');
  const seenPaths = new Set<string>();
  const tools = buildPiTools({ ...opts(), cwd: workspace, seenPaths, skillReadRoots: () => [library] });
  const run = (name: string, args: object) => tools.find((tool: any) => tool.name === name).execute(`${name}-call`, args);

  assert.match((await run('read', { path: skillFile })).content[0].text, /KEEP-NOTES-4512/);
  assert.equal(seenPaths.size, 0, 'a skill file read unlocks no write');
  assert.match((await run('ls', { path: path.dirname(skillFile) })).content[0].text, /SKILL\.md/);
  assert.match((await run('grep', { pattern: 'KEEP-NOTES', path: library })).content[0].text, /^notes\/SKILL\.md:5:KEEP-NOTES-4512/);
  assert.match((await run('find', { pattern: '**/SKILL.md', path: library })).content[0].text, /^notes\/SKILL\.md$/);
  await run('read', { path: 'own.md' });
  assert.deepEqual([...seenPaths], [path.join(workspace, 'own.md')], 'workspace reads behave as before');

  for (const outside of [path.join(tmp, 'secret.txt'), `${library}/notes/../../secret.txt`]) {
    assert.match((await run('read', { path: outside })).content[0].text, /outside the workspace/);
  }
  assert.match((await run('write', { path: skillFile, content: 'replaced' })).content[0].text, /outside the workspace/);
  assert.match((await run('edit', { path: skillFile, old_string: 'KEEP', new_string: 'LOSE' })).content[0].text, /outside the workspace/);
  assert.match(fs.readFileSync(skillFile, 'utf8'), /KEEP-NOTES-4512/);
});

test('Pi forwards arbitrary artifact paths to the bridge', async (t) => {
  configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: '/tmp/agent-runtime-test' });
  t.after(() => __resetRuntimeDeps());
  let received: any;
  const tool = buildPiTools({ ...opts(), bridge: { saveContext: (args: any) => {
    received = args;
    return { name: args.name, filePath: args.path, size: 5 };
  } } }).find((tool: any) => tool.name === 'save_artifact');
  assert.ok(tool);
  await tool.execute('save-file', { name: 'shot', path: '.attachments/shot.png' });
  assert.equal(received.path, '.attachments/shot.png');
  assert.equal(received.body, undefined);
});
