import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_RESTRICTED_FEATURES_OFF,
  CODEX_RESTRICTED_TOOLS_OFF,
  CODEX_RESTRICTED_TURN_POLICY,
  codexRestrictedMcpCheck,
  codexRestrictedThreadConfig,
  codexThreadSandbox,
} from '../src/adapters/codex/codexRestrictedProfile';
import { buildCodexMcpConfig, CODEX_HOST_MCP_SERVER } from '../src/adapters/codex/codexProtocol';
import { CODEX_META_AGENT_UNREMOVABLE_TOOLS } from '../src/adapters/codex/codexToolCatalog';

describe('Codex restricted profile', () => {
  it('runs a restricted turn read-only and offline', () => {
    assert.deepEqual(CODEX_RESTRICTED_TURN_POLICY, { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    assert.ok(Object.isFrozen(CODEX_RESTRICTED_TURN_POLICY) && Object.isFrozen(CODEX_RESTRICTED_TURN_POLICY.sandboxPolicy));
  });

  it('starts a thread read-only exactly when the host restricts it', () => {
    assert.equal(codexThreadSandbox(true), 'read-only');
    assert.equal(codexThreadSandbox(false), 'workspace-write');
  });

  it("names the host's MCP server as the session config does", () => {
    assert.equal(CODEX_HOST_MCP_SERVER, '__michi_internal__');
    const config = buildCodexMcpConfig({ url: 'http://127.0.0.1:1/mcp', headers: {} } as never);
    assert.deepEqual(Object.keys(config.mcp_servers as object), [CODEX_HOST_MCP_SERVER]);
  });

  it('turns features and web search off and disables every MCP server but the host\'s', () => {
    const host = { url: 'http://127.0.0.1:1/mcp' };
    const base = { mcp_servers: { [CODEX_HOST_MCP_SERVER]: host }, features: { hooks: true }, hooks: { Stop: [] } };
    const config = codexRestrictedThreadConfig(base, ['user-server', CODEX_HOST_MCP_SERVER]);
    assert.deepEqual(config, {
      ...base,
      features: { hooks: true, ...CODEX_RESTRICTED_FEATURES_OFF },
      tools: { ...CODEX_RESTRICTED_TOOLS_OFF },
      web_search: 'disabled',
      mcp_servers: { 'user-server': { enabled: false }, [CODEX_HOST_MCP_SERVER]: host },
    });
    // Every switch off; multi_agent_v2 is the off table with a one-thread limit, so spawns fail.
    const { multi_agent_v2: multiAgentV2, ...switches } = CODEX_RESTRICTED_FEATURES_OFF;
    assert.ok(Object.values(switches).every((value) => value === false));
    assert.deepEqual(multiAgentV2, { enabled: false, max_concurrent_threads_per_session: 1 });
    assert.equal(CODEX_RESTRICTED_FEATURES_OFF.shell_tool, false);
  });

  it('turns off every built-in tool a switch removes: view_image, request_user_input and the ones a user\'s config can add', () => {
    // Probed on codex 0.156.1 and 0.166.0-alpha.5 (each key removes the tool named beside it).
    const features: Record<string, string> = {
      view_image: 'view_image (reads any local image)',
      image_generation: 'image_gen (reads referenced local images)',
      default_mode_request_user_input: 'request_user_input in default mode',
      request_permissions_tool: 'request_permissions',
      send_message_to_user_async: 'send_message_to_user_async',
      deferred_executor: 'wait_for_environment',
      token_budget: 'new_context, get_context_remaining',
      current_time_reminder: 'clock.curr_time',
      sleep_tool: 'clock.sleep',
      multi_env_copy_file: 'multi_env_copy_file',
      executor_capability_discovery_v2: 'skills.*',
      goals: 'get_goal, create_goal, update_goal',
    };
    for (const [key, tool] of Object.entries(features)) assert.equal(CODEX_RESTRICTED_FEATURES_OFF[key], false, `${key} (${tool})`);
    assert.deepEqual(CODEX_RESTRICTED_TOOLS_OFF, {
      experimental_request_user_input: { enabled: false },
      update_plan: { enabled: false },
    });
    assert.ok(Object.isFrozen(CODEX_RESTRICTED_TOOLS_OFF) && Object.values(CODEX_RESTRICTED_TOOLS_OFF).every(Object.isFrozen));
    // A [tools] entry already in the base config stays, but cannot turn one of these back on.
    const config = codexRestrictedThreadConfig({
      tools: { web_search: { context_size: 'low' }, experimental_request_user_input: { enabled: true }, update_plan: { enabled: true } },
    }, []);
    assert.deepEqual(config.tools, {
      web_search: { context_size: 'low' }, experimental_request_user_input: { enabled: false }, update_plan: { enabled: false },
    });
    // The launch check admits no built-in besides the allow-list.
    assert.deepEqual([...CODEX_META_AGENT_UNREMOVABLE_TOOLS], []);
  });

  it('passes a thread only when the host\'s server is listed and every other one is disabled', () => {
    const own = { name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'connected' };
    assert.deepEqual(codexRestrictedMcpCheck([own, { name: 'user-server', runtimeStatus: 'disabled' }]), { ok: true });
    const open = codexRestrictedMcpCheck([own, { name: 'user-server', runtimeStatus: 'connected' }]);
    assert.deepEqual(open, { ok: false, open: ['user-server'], fatal: false, reason: 'MCP servers Michi could not turn off: user-server' });
    for (const statuses of [null, [], [{ name: 'user-server', runtimeStatus: 'disabled' }]]) {
      const check = codexRestrictedMcpCheck(statuses);
      assert.equal(check.ok, false);
      assert.equal(!check.ok && check.fatal, true);
    }
  });
});
