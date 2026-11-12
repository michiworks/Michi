/**
 * Tests for michiGrantKey — the key chat always-allow grants are stored
 * under, which Michi's permission port gives adapters as grantKey — and for
 * which of Michi's own tools a chat runs without a prompt, and for the chat
 * policy while a turn holds check-in or collector material (DESIGN-v2 §2.8):
 * the mode reads Ask, grants and session trust (through the port's reset
 * token) are not honoured, and only reads and Michi's own internal writes
 * still run. The rest of chat policy is covered by chatPermissionRuntimes and
 * chatApprovalState; the names each adapter sends by permissionToolNames,
 * each runtime's decisions end to end by permissionMatrix, and V's routes by
 * companionTrustBoundary.
 */

import { afterEach, beforeEach, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';

import { chatApproveForMe, chatPermissionMode, michiGrantKey, resolveChatPolicy } from '../src/agents/permissionPolicy';
import { michiPermissionPolicy } from '../src/agents/chatApprovalState';
import { BUILTIN_TOOLS } from '../src/agents/builtinTools';
import { CHECKIN_TOOL_NAMES, MAIN_TOOL_NAMES } from '../src/assistant/policy';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { closeDb, getDb, initDb } from '../src/services/db';
import { clearCarriedCompanionTaint, recordCompanionTaint } from '../src/services/turnTrust';
import { chatOwner, runOwner } from './helpers/owners';
import { activeTurnRow } from './helpers/checkinNodes';
import { registerLiveSession } from './helpers/liveSession';
import { clearAllSessions } from '../src/agents/sessionRegistry';

for (const [label, grantKey] of [['michiGrantKey', michiGrantKey], ['michiPermissionPolicy.grantKey', michiPermissionPolicy.grantKey!]] as const) {
    describe(label, () => {
        // Regression guard: a grant for Claude's PascalCase write/exec tools must
        // share the key of the canonical tool, or "Trust this tool" never matches.
        test('Claude PascalCase write/exec tools share the canonical grant key', () => {
            const expected: Record<string, string> = { Bash: 'bash', Edit: 'edit', Write: 'write', MultiEdit: 'edit', NotebookEdit: 'edit' };
            for (const [tool, key] of Object.entries(expected)) assert.equal(grantKey(tool), key, tool);
        });

        test('every other name is its own key, including read-only Claude tools', () => {
            for (const tool of ['bash', 'edit', 'write', 'read', 'Read', 'Glob', 'Grep', 'fs_write', 'execute_bash',
                'mcp__probe__echo_tool', 'mcp____michi_internal____read_node', '@michi/send_to_thread']) {
                assert.equal(grantKey(tool), tool, tool);
            }
        });
    });
}

// Michi's own tools a chat runs without a prompt in every mode: reads of
// Michi's data, what Michi records about the turn, its question card, thread
// messages, Memory, Artifact reads, multi-model plans (the plan card is the
// consent), delete_artifact, whose own card asks every time (hostApproval),
// and the agent's own tools, which gate themselves. Every other Michi tool
// asks in Ask. A new Michi tool fails the catalog test below until it is
// placed in one of the two lists.
const SELF_SCOPED = new Set([
    'michi_docs', 'michi_skills', 'list_workspaces', 'list_threads', 'search_messages', 'read_node', 'read_node_overview',
    'read_conversation_updates', 'list_panes', 'inspect_pane', 'read_pane_output', 'wait_pane',
    'read_home', 'list_pages', 'read_page', 'read_database', 'list_page_components', 'read_page_component', 'list_tasks',
    'list_scheduled_jobs', 'list_agents', 'check_agent', 'wait_agent', 'list_artifacts', 'search_artifacts', 'delete_artifact',
    'set_branch_overview', 'set_follow_ups', 'report_conversation_no_change',
    'ask_user', 'send_to_thread', 'memory_search', 'memory_save', 'memory_update', 'memory_delete',
    'list_ready_models', 'propose_multi_model_plan',
    'companion_items', 'companion_item', 'companion_check_now', 'companion_update_item', 'companion_save_notes',
    'companion_goal_progress', 'companion_edit_goal', 'companion_propose', 'companion_publish_brief', 'companion_set_name',
    'companion_read', 'companion_session_send',
    'nothing_to_do',
]);
// Writes of pages, artifacts and jobs, a page preview's link, the web, links, images, branches and Agent Runs.
const ASKS = new Set([
    'configure_database', 'configure_database_view', 'create_database', 'create_page', 'edit_database', 'edit_home',
    'edit_page', 'preview_page', 'save_page_component', 'open_task_database', 'layout_rules', 'start_conversation',
    'create_scheduled_job', 'update_scheduled_job', 'run_scheduled_job', 'delete_scheduled_job',
    'open_url', 'show_image', 'spawn_branches', 'save_artifact', 'update_artifact', 'web_search', 'fetch_content',
    'spawn_agent', 'send_agent_input', 'cancel_agent', 'watch_agent_runs', 'update_agent_watch', 'submit_agent_result',
]);
/** Pi's file and shell tools: runtime built-ins, judged by READ_TOOLS and native rules (chatPermissionRuntimes). */
const PI_FILE_TOOLS = new Set(['read', 'ls', 'grep', 'find', 'write', 'edit', 'bash']);

/**
 * Every Michi tool a runtime can call: each reviewed MCP catalog (V's
 * included), Pi's built-ins, the Agent Run tools, and V's and a check-in's
 * catalogs (the golden has no check-in slot).
 */
function michiTools(): string[] {
    const catalogs = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mcpToolCatalog.golden.json'), 'utf8')) as
        Record<string, { tools: Array<{ name: string }> }>;
    const names = new Set([...Object.values(catalogs).flatMap((catalog) => catalog.tools.map((tool) => tool.name)),
        ...BUILTIN_TOOLS.map((tool) => tool.name), ...AGENT_RUN_TOOL_NAMES, ...MAIN_TOOL_NAMES, ...CHECKIN_TOOL_NAMES]);
    return [...names].filter((name) => !PI_FILE_TOOLS.has(name)).sort();
}

/** A Michi tool as each runtime's request names it: Pi's and Claude's (prefix stripped), the MCP name, Kiro's and Crew's. */
const runtimeNames = (tool: string) => [tool, `mcp____michi_internal____${tool}`, `@michi/${tool}`];

describe("Michi's own tools in a chat", () => {
    afterEach(__resetRuntimeDeps);
    function configure() {
        const grants: string[] = [];
        configureRuntimeDeps({
            dataDir: '/tmp/michi-permission-policy-tests',
            historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
            agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
            chatPermissions: { getMode: () => 'ask', hasGrant: () => false, grant: (_id, tool) => { grants.push(tool); } },
        });
        return grants;
    }

    test('every Michi tool is either self-scoped or asks in Ask, under every runtime\'s name for it', () => {
        const grants = configure();
        const tools = michiTools();
        for (const tool of tools) {
            assert.ok(SELF_SCOPED.has(tool) !== ASKS.has(tool), `${tool}: classify it as self-scoped (permissionPolicy) or asking`);
            for (const name of runtimeNames(tool)) {
                // A bare native name is Claude's, which says it stripped Michi's prefix (hostTool).
                assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, true, 'ask', name === tool), SELF_SCOPED.has(tool) ? 'allow' : 'ask', `native ${name}`);
            }
        }
        for (const tool of SELF_SCOPED) {
            assert.ok(tools.includes(tool), `${tool} is a Michi tool`);
            for (const name of runtimeNames(tool)) assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, false, 'ask'), 'allow', `Pi ${name}`);
        }
        assert.deepEqual(grants, [], 'no decision writes a grant');
    });

    test("Crew's relay listing is a read; the relay call itself, unnamed, asks", () => {
        configure();
        for (const name of runtimeNames('michi_list_tools')) assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, true, 'ask'), 'allow', name);
        // A call whose input names no Michi tool keeps the Gateway's name for it.
        assert.equal(resolveChatPolicy(chatOwner('n-a'), null, 'michi_call_tool', true, 'ask'), 'ask');
    });

    test('another server\'s tool of the same name, and any Agent Run, still asks', () => {
        configure();
        for (const name of ['mcp__github__read_node', 'mcp__michi_internal__read_node', '@github/read_node', 'github::read_node',
            '@michi-crew-runtime:michi/read_node', '@michi/read node', 'Read_node']) {
            assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, true, 'ask'), 'ask', name);
        }
        // Agent Runs answer through their own broker; the chat's self-scoped tools are a chat's.
        for (const tool of SELF_SCOPED) {
            for (const name of runtimeNames(tool)) assert.equal(resolveChatPolicy(runOwner('r', 'a'), null, name, true, 'ask'), 'ask', name);
        }
    });
});

describe('the chat policy while a turn holds check-in or collector material', () => {
    let tmpDir: string;
    const grants = new Set<string>();
    const node = 'n-chat';
    const owner = chatOwner(node);

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-permission-policy-'));
        process.env.MICHI_DATA_DIR = tmpDir;
        closeDb();
        initDb();
        grants.clear();
        getDb().prepare("INSERT INTO workspaces (id, name, cwd, created_at, updated_at) VALUES ('ws-1', 'W', ?, 1, 1)").run(tmpDir);
        getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES (?, 'ws-1', 'chat', 'idle', 1)").run(node);
        configureRuntimeDeps({
            dataDir: path.join(tmpDir, 'runtime'),
            historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
            agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }) as never, resolveModel: () => '', resolveReasoning: () => undefined },
            chatPermissions: {
                getMode: () => 'yolo', getApproveForMe: () => true, resetToken: () => 'token-1',
                hasGrant: (id, tool) => grants.has(`${id}:${tool}`), grant: (id, tool) => { grants.add(`${id}:${tool}`); },
            },
        });
    });

    afterEach(() => {
        __resetRuntimeDeps();
        closeDb();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('mode, approve-for-me, grants and the reset token as the user set them until the turn takes it in; then Ask', () => {
        activeTurnRow(node, 'turn-p', 'a-p');
        grants.add(`${node}:bash`);
        assert.equal(chatPermissionMode(owner, null), 'yolo');
        assert.equal(chatApproveForMe(owner, null), true);
        assert.equal(resolveChatPolicy(owner, null, 'Bash', true, 'ask'), 'allow', 'the grant');
        assert.equal(michiPermissionPolicy.resetToken!(owner, null), 'token-1');

        recordCompanionTaint({ nodeId: node, turnId: 'turn-p' }, 'read_page', 'checkin');
        assert.equal(chatPermissionMode(owner, null), 'ask');
        assert.equal(chatApproveForMe(owner, null), false);
        for (const mode of ['ask', 'trust', 'yolo'] as const) {
            for (const tool of ['Bash', 'bash', 'Write', 'WebFetch', 'mcp__github__create_issue', '@michi/start_conversation']) {
                assert.equal(resolveChatPolicy(owner, null, tool, true, mode), 'ask', `${mode} ${tool}`);
            }
        }
        for (const mode of ['trust', 'yolo'] as const) {
            for (const tool of ['Read', 'Grep', 'mcp____michi_internal____read_page', '@michi/edit_page', 'companion_read']) {
                assert.equal(resolveChatPolicy(owner, null, tool, true, mode), 'allow', `${mode} ${tool}`);
            }
        }
        // Michi's self-scoped tools, which run in every mode otherwise, hold to it too: its reads, Memory and
        // reply metadata (Michi-internal writes) still run; thread messages and the question card ask.
        for (const mode of ['ask', 'trust', 'yolo'] as const) {
            for (const tool of ['@michi/read_node', 'memory_search', 'mcp____michi_internal____memory_save', 'memory_delete', 'set_follow_ups']) {
                assert.equal(resolveChatPolicy(owner, null, tool, true, mode), 'allow', `${mode} ${tool}`);
            }
            for (const tool of ['send_to_thread', 'mcp____michi_internal____ask_user']) {
                assert.equal(resolveChatPolicy(owner, null, tool, true, mode), 'ask', `${mode} ${tool}`);
            }
        }
        // Each read is a new token, so trust given for the session never matches while it holds.
        const tokens = new Set([michiPermissionPolicy.resetToken!(owner, null), michiPermissionPolicy.resetToken!(owner, null)]);
        assert.equal(tokens.size, 2);
        assert.ok(!tokens.has('token-1'));
    });

    test('w3-fix D17: an ordinary chat\'s next turn holds it too, through every port a runtime reads, until it is cleared', (t) => {
        // The chat's live session, which took in what its turn read.
        registerLiveSession(node);
        t.after(() => clearAllSessions());
        activeTurnRow(node, 'turn-s1', 'a-s1');
        recordCompanionTaint({ nodeId: node, turnId: 'turn-s1' }, 'read_page', 'checkin');
        getDb().prepare("UPDATE turns SET status = 'completed' WHERE node_id = ?").run(node);
        activeTurnRow(node, 'turn-s2', 'a-s2');
        grants.add(`${node}:bash`);
        assert.equal(michiPermissionPolicy.mode(owner, null), 'ask');
        assert.equal(michiPermissionPolicy.approveForMe!(owner, null), false, 'no Kiro classifier preset (K-review #4)');
        assert.equal(michiPermissionPolicy.decide({ owner, ownerUserId: null, toolName: 'Bash', nativeRequest: true, mode: 'yolo' }), 'ask', 'the grant is not honoured');
        assert.notEqual(michiPermissionPolicy.resetToken!(owner, null), 'token-1');
        clearCarriedCompanionTaint(node);
        getDb().prepare("UPDATE turns SET status = 'completed' WHERE node_id = ?").run(node);
        activeTurnRow(node, 'turn-s3', 'a-s3');
        assert.equal(michiPermissionPolicy.mode(owner, null), 'yolo');
        assert.equal(michiPermissionPolicy.approveForMe!(owner, null), true);
        assert.equal(michiPermissionPolicy.resetToken!(owner, null), 'token-1');
    });
});
