import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeHost } from 'michi-runtime';
import {
  DEFAULT_CLAUDE_CLI_FLAGS, DEFAULT_CLAUDE_LIMITS, claudeAdapterOptions,
  type ClaudeAdapterOptions, type ClaudeCliFlags, type ClaudeHostApprovalRequest, type ClaudeLimits, type ClaudeModelCatalogOptions,
} from 'michi-runtime/internal/adapters/claude/claudeAdapterOptions';
import { claudeConfigRoot } from 'michi-runtime/internal/adapters/claude/claudeBinary';
import * as agentConfig from '../services/agentConfig';
import * as assistantPolicy from '../assistant/policy';
import * as skillMounts from '../services/skills/mounts';
import * as skillEvents from '../services/skills/events';
import * as skillPaths from '../services/skills/paths';
import { claudeStderrWarning } from './hostText/claude';
import { agentSpawnEnv } from './agentSpawnEnv';
import { approveTimeoutMs } from './approveTimeout';
import * as permissionPolicy from './permissionPolicy';

/**
 * The Claude adapter's options in Michi, through the package's
 * claudeAdapterOptions: the runtime host's ports, the live model catalog for
 * the runtime the factory registers, Michi's environment settings, read here
 * so the adapter reads none itself (an unset one takes the package's
 * default), and Michi's config directory, assistant tool verdicts, the
 * approval gate of a guarded turn, skill library and
 * product text. Each setting is read when the adapter used to read it: the
 * limits now, the other functions on every call. Calls go through the module
 * objects, so test stubs of those functions (t.mock.method) still apply.
 * Tests that build a Claude runtime or session directly use this too, so
 * they run with what production passes.
 */
export function michiClaudeAdapterOptions(host: RuntimeHost, modelCatalog?: ClaudeModelCatalogOptions): ClaudeAdapterOptions {
  return claudeAdapterOptions({
    host,
    modelCatalog,
    // The live environment less the backend's own: credentials stay in the child's env.
    spawnEnv: () => agentSpawnEnv(),
    binaryPath: () => process.env.CLAUDE_CLI_BIN,
    limits: michiClaudeLimits(),
    cli: () => michiClaudeCliFlags(),
    stderrWarning: claudeStderrWarning,
    configDir: (userId) => agentConfig.resolveClaudeConfigDir(userId ?? undefined),
    // A check-in's own Michi tools: only its session profile's allow-list (assistant/policy.ts, DESIGN-v2 §2.5).
    restrictedToolApproval: (hostToolName, profile) => assistantPolicy.claudeAssistantApproval(hostToolName, profile),
    // In a guarded turn, what leaves the machine asks Michi, whatever the user's Claude settings allow (D19, D4).
    requireHostApproval: (request) => claudeCallNeedsMichiApproval(request),
    // The library as the additional folder `michi`, at one path for every process; none in cloud mode.
    skillLibraryDir: () => skillMounts.skillMountRoot('claude', 'claude-add-dir', { leaveOut: claudePersonalCommandNames }),
    subscribeSkillLibraryChanges: (listener) => skillEvents.onSkillLibraryChanged(listener),
    // Cloud mode shows no skills of this machine, so no chat's state names them.
    advertiseSkills: () => skillPaths.skillsAvailable(),
  });
}

/**
 * The user's own Claude commands (`<Claude config>/commands/<name>.md`, the
 * profile sessions spawn with; cloud mode, which has per-user profiles,
 * mounts no library). A skill in an additional folder hides a command of
 * its name (CLI 2.1.319), so the library's folder leaves such skills out:
 * the user's `/name` keeps running their command, and the library skill
 * runs through Michi's expansion. A project's commands depend on the
 * chat's folder, which one folder for every process cannot follow.
 */
function claudePersonalCommandNames(): string[] {
  const root = claudeConfigRoot(agentConfig.resolveClaudeConfigDir(), agentSpawnEnv());
  try {
    return fs.readdirSync(path.join(root, 'commands')).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length));
  } catch {
    return [];
  }
}

/**
 * ClaudeAdapterOptions.requireHostApproval for Michi (D19, Q26; DESIGN-v2
 * §2.8, D4): in a guarded turn (services/turnGuard.ts: Michi drove it, or it
 * holds outside content), a call Michi's consequence rules force to ask
 * (permissionPolicy.forcedChatDecision: it leaves the machine, Michi cannot
 * read it, or it reads the network or credentials in work that started from
 * someone else's content) goes through Michi's approval. A Claude chat loads
 * the user's own Claude settings, whose allow rules and PreToolUse hooks
 * would otherwise approve Bash, WebFetch or Write before canUseTool, Michi's
 * policy, is asked (YOLO's bypassPermissions skips it too). Every other call
 * keeps the CLI's own flow. turnTrust.companionRuntimeGateAuthoritative
 * relies on this.
 */
export function claudeCallNeedsMichiApproval(request: ClaudeHostApprovalRequest): boolean {
  const hostTool = request.hostToolName !== null;
  const toolName = request.hostToolName ?? request.toolName;
  const detail = { input: request.input };
  // A check-in's refusal goes through canUseTool too, where the policy denies it.
  return permissionPolicy.forcedChatDecision(request.owner, toolName, detail, true, hostTool) !== null
    || permissionPolicy.backgroundRefusal(request.owner, toolName, detail, true, hostTool) !== null;
}

/** A switch in the environment: `unset` while the variable is unset, else what `read` makes of its value. */
function envSwitch(name: string, unset: boolean, read: (value: string) => boolean): boolean {
  const value = process.env[name];
  return value === undefined ? unset : read(value);
}

/** MICHI_CLAUDE_* limits, parsed as ClaudeRuntime and ClaudeSession parsed them; unset, the package's defaults. */
function michiClaudeLimits(): ClaudeLimits {
  const defaults = DEFAULT_CLAUDE_LIMITS;
  // Default 60s — claude's SessionStart hooks can take 10-20s on heavily-loaded
  // configs (financial-services, superpowers, etc). 5s was too aggressive in
  // real-world envs. Native restore uses the same deadline. Invalid values
  // fall back to the default.
  const configuredInitTimeoutMs = Number(process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS ?? String(defaults.initTimeoutMs));
  return {
    maxConcurrent: parseInt(process.env.MICHI_CLAUDE_MAX_CONCURRENT ?? String(defaults.maxConcurrent), 10),
    pool: {
      disabled: envSwitch('MICHI_CLAUDE_POOL_DISABLED', defaults.pool.disabled, (value) => value === '1'),
      sessionsPerCwd: parseInt(process.env.MICHI_CLAUDE_POOL_SESSIONS_PER_CWD ?? String(defaults.pool.sessionsPerCwd), 10),
      waitForWarm: envSwitch('MICHI_CLAUDE_WAIT_FOR_WARM', defaults.pool.waitForWarm,
        (value) => !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())),
    },
    initTimeoutMs: Number.isInteger(configuredInitTimeoutMs)
      && configuredInitTimeoutMs > 0 && configuredInitTimeoutMs <= 2_147_483_647
      ? configuredInitTimeoutMs : defaults.initTimeoutMs,
    approveTimeoutMs: approveTimeoutMs(),
    disposeTermTimeoutMs: parseInt(process.env.MICHI_CLAUDE_DISPOSE_TERM_TIMEOUT_MS ?? String(defaults.disposeTermTimeoutMs), 10),
    disposeKillTimeoutMs: parseInt(process.env.MICHI_CLAUDE_DISPOSE_KILL_TIMEOUT_MS ?? String(defaults.disposeKillTimeoutMs), 10),
  };
}

/** MICHI_CLAUDE_* CLI switches, read at each spawn; unset, the package's defaults. */
function michiClaudeCliFlags(): ClaudeCliFlags {
  const defaults = DEFAULT_CLAUDE_CLI_FLAGS;
  return {
    // Bare mode skips SessionStart hooks, plugins, skills, MCP auto-discovery.
    // Without it, configs with many plugins (financial-services, superpowers)
    // take 10-20s to emit system/init. Tests / CI / smoke runs opt in.
    bare: envSwitch('MICHI_CLAUDE_BARE', defaults.bare, (value) => value === '1'),
    // Lock chats to Michi's MCP server alone, e.g. for multi-tenant deploys
    // where host MCP must not leak in. Default: Claude auto-discovers the
    // user's own MCP servers.
    strictMcp: envSwitch('MICHI_CLAUDE_STRICT_MCP', defaults.strictMcp, (value) => value === '1'),
    // On by default; 0 disables it (an older binary that rejects the flag,
    // or to keep the parent stream lean).
    forwardSubagentText: envSwitch('MICHI_CLAUDE_SUBAGENT_TEXT', defaults.forwardSubagentText, (value) => value !== '0'),
    humanOrigin: envSwitch('MICHI_CLAUDE_HUMAN_ORIGIN', defaults.humanOrigin, (value) => value !== '0'),
  };
}
