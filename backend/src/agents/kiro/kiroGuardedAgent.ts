/**
 * Guarded copies of the user's Kiro agents (lane D, Q26, user choice
 * 2026-11-12: "Michi 自己的 Kiro agent"). kiro-cli runs without asking
 * whatever an agent's `allowedTools`, `toolsSettings` allow keys and
 * permission `allow` rules pre-approve, so those calls never reach Michi's
 * approval. A turn Michi guards (permissionPolicy.chatTurnGuard: Michi drove
 * it, or it holds outside content) runs on a copy of the chat's agent that
 * pre-approves only reads; the adapter switches to it with session/set_mode
 * and back on the next unguarded turn (AcpAgentSession.reconcileGuardedAgent).
 *
 * Copies are `michi-guarded--<agent>.json` in the user's Kiro agents folder
 * (`$KIRO_HOME/agents`, default `~/.kiro/agents`): the one folder kiro-cli
 * reads for every project, where other tools keep generated agents too.
 * Michi writes only files with that prefix and never changes the user's own.
 * A copy is written only for an agent that pre-approves more than reads, when
 * a guarded turn needs it and before a chat kiro-cli starts for the user's
 * default agent and every agent already copied (kiro-cli lists its agents when
 * it starts).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KiroGuardedAgentOptions } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { writeFileAtomicSync } from 'michi-runtime/internal/core/atomicFile';
import { agentSpawnEnv } from '../agentSpawnEnv';

export const KIRO_GUARDED_AGENT_PREFIX = 'michi-guarded';
const SEPARATOR = '--';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;
/** Agents to scan per folder when finding one by name; folders hold a few dozen. */
const MAX_AGENT_FILES = 400;

/**
 * Kiro's built-in agents, which have no file and pre-approve no more than
 * reads. v3's bundled modes are agents too (its default chat runs on vibe);
 * those here were probed on kiro-cli 3.2.1 (2026-11-12): vibe and default-v2
 * asked before a command and a file write, spec and bug-fix before a command
 * and wrote nothing unasked. A copy written after a folder's kiro-cli started
 * is one v3 does not list, so a stand-in for these would fail the turn for
 * nothing. Others without a file (autonomous) run a guarded turn on the
 * runtime's fallback on v3, vibe, and go back after it; v2 gets a stand-in.
 */
const BUILTIN_AGENTS: ReadonlySet<string> = new Set(['kiro_default', 'default', 'kiro_planner', 'kiro_guide', 'kiro_help',
  'vibe', 'default-v2', 'spec', 'bug-fix']);

/** Tools and capabilities that only read: a copy keeps pre-approving them, or every read would ask. */
const READ_TOOLS: ReadonlySet<string> = new Set(['fs_read', 'read', 'glob', 'grep', 'ls', 'code', 'introspect', 'todo_list', 'thinking', 'knowledge']);

type AgentConfig = Record<string, unknown>;

/**
 * The user's Kiro agents folder, as the kiro-cli Michi starts sees it. Under
 * node --test without a KIRO_HOME of its own (NODE_TEST_CONTEXT, as
 * services/usageTelemetry.ts reads it), a folder of the test process instead,
 * so no test writes into the developer's ~/.kiro.
 */
export function kiroUserAgentsDir(env: NodeJS.ProcessEnv = agentSpawnEnv()): string {
  const configured = env.KIRO_HOME?.trim();
  if (!configured && process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `michi-test-kiro-home-${process.pid}`, 'agents');
  return path.join(configured || path.join(os.homedir(), '.kiro'), 'agents');
}

function kiroSettingsFile(agentsDir: string): string {
  return path.join(path.dirname(agentsDir), 'settings', 'cli.json');
}

export function isKiroGuardedAgent(modeId: string): boolean {
  return modeId === KIRO_GUARDED_AGENT_PREFIX || modeId.startsWith(`${KIRO_GUARDED_AGENT_PREFIX}${SEPARATOR}`);
}

/** The agent a copy was made from; null for the copy of Kiro's default. */
export function kiroGuardedAgentBase(modeId: string): string | null {
  if (!isKiroGuardedAgent(modeId)) return modeId;
  const base = modeId.slice(KIRO_GUARDED_AGENT_PREFIX.length + SEPARATOR.length);
  return base || null;
}

/** The copy's name for `base`; throws for a name Kiro could not take as a file name. */
export function kiroGuardedAgentName(base: string | null): string {
  if (base === null) return KIRO_GUARDED_AGENT_PREFIX;
  if (!SAFE_NAME.test(base) || isKiroGuardedAgent(base)) throw new Error(`the Kiro agent "${base}" cannot be copied under a file name`);
  return `${KIRO_GUARDED_AGENT_PREFIX}${SEPARATOR}${base}`;
}

function readJson(file: string): AgentConfig | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not an agent config`);
  return parsed as AgentConfig;
}

/** An agent by name in one folder: `<name>.json`, else the file whose `name` it is. Throws on a matching file it cannot read. */
function findAgent(dir: string, name: string): AgentConfig | null {
  const direct = readJson(path.join(dir, `${name}.json`));
  if (direct && (direct.name === undefined || direct.name === name)) return direct;
  let files: string[];
  try { files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).slice(0, MAX_AGENT_FILES); } catch { return null; }
  for (const file of files) {
    if (file.startsWith(KIRO_GUARDED_AGENT_PREFIX)) continue;
    let config: AgentConfig | null;
    try { config = readJson(path.join(dir, file)); } catch { continue; }
    if (config?.name === name) return config;
  }
  return null;
}

/** The base agent's config: the project's (`<cwd>/.kiro/agents`), else the user's; null when it has no file. */
function baseAgentConfig(base: string, cwd: string, agentsDir: string): AgentConfig | null {
  return findAgent(path.join(cwd, '.kiro', 'agents'), base) ?? findAgent(agentsDir, base);
}

const ALLOW_SETTING = /^(allowed|autoAllow|allow|trusted)/i;

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== false && value !== undefined && value !== null && value !== '';
}

function readTool(entry: unknown): boolean {
  return typeof entry === 'string' && READ_TOOLS.has(entry.replace(/^@builtin\//, ''));
}

/** A permission rule that approves without asking: `allow`, or no effect (Kiro's default for a rule is to allow). */
function approvingRule(rule: unknown): boolean {
  if (!rule || typeof rule !== 'object') return false;
  const effect = (rule as { effect?: unknown }).effect;
  return effect === undefined || effect === 'allow';
}

function readRule(rule: unknown): boolean {
  const capability = (rule as { capability?: unknown }).capability;
  return typeof capability === 'string' && READ_TOOLS.has(capability) && (rule as { match?: unknown }).match === undefined;
}

function rulesOf(config: AgentConfig): unknown[] {
  const permissions = config.permissions;
  const rules = permissions && typeof permissions === 'object' ? (permissions as { rules?: unknown }).rules : undefined;
  return Array.isArray(rules) ? rules : [];
}

/** Whether an agent pre-approves more than reads: a tool, a setting's allow list, or a permission rule. */
export function kiroAgentPreApproves(config: AgentConfig): boolean {
  const allowed = Array.isArray(config.allowedTools) ? config.allowedTools : [];
  if (allowed.some((entry) => !readTool(entry))) return true;
  const settings = config.toolsSettings && typeof config.toolsSettings === 'object' ? config.toolsSettings as Record<string, unknown> : {};
  for (const value of Object.values(settings)) {
    if (!value || typeof value !== 'object') continue;
    if (Object.entries(value as Record<string, unknown>).some(([key, setting]) => ALLOW_SETTING.test(key) && hasValue(setting))) return true;
  }
  return rulesOf(config).some((rule) => approvingRule(rule) && !readRule(rule));
}

/**
 * The guarded copy of an agent config: the same prompt, tools, MCP servers,
 * resources and hooks, pre-approving only reads. Deny settings and rules stay.
 */
export function kiroGuardedAgentConfig(config: AgentConfig, name: string, base: string): AgentConfig {
  const settings = config.toolsSettings && typeof config.toolsSettings === 'object' ? config.toolsSettings as Record<string, unknown> : {};
  const toolsSettings = Object.fromEntries(Object.entries(settings).map(([tool, value]) => [tool,
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !ALLOW_SETTING.test(key)))
      : value]));
  const copy: AgentConfig = {
    ...config,
    name,
    description: `Michi's copy of ${base} without pre-approved tools: Michi runs a chat on it while it asks before anything leaves this machine. Pick ${base} itself to use it.`,
    allowedTools: (Array.isArray(config.allowedTools) ? config.allowedTools : []).filter(readTool),
    toolsSettings,
  };
  if (config.permissions && typeof config.permissions === 'object') {
    copy.permissions = { ...(config.permissions as Record<string, unknown>), rules: rulesOf(config).filter((rule) => !approvingRule(rule) || readRule(rule)) };
  }
  return copy;
}

/** An agent Kiro knows that has no file Michi can read (a projected or markdown one): all tools, nothing pre-approved but reads. */
function genericGuardedConfig(name: string, base: string): AgentConfig {
  return {
    name,
    description: `Michi's stand-in for ${base} without pre-approved tools: Michi runs a chat on it while it asks before anything leaves this machine.`,
    tools: ['*'],
    allowedTools: ['fs_read'],
    toolsSettings: {},
    includeMcpJson: true,
    resources: ['file://AGENTS.md', 'file://README.md', 'file://.kiro/steering/**/*.md'],
  };
}

function writeCopy(agentsDir: string, name: string, config: AgentConfig): void {
  if (!isKiroGuardedAgent(name) || config.name !== name) throw new Error(`refusing to write ${name}: not one of Michi's guarded agent copies`);
  fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const file = path.join(agentsDir, `${name}.json`);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  let current: string | null = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }
  if (current !== text) writeFileAtomicSync(file, text);
}

/**
 * The copy a guarded turn of a chat on `base` (null: Kiro's default) runs
 * on, written or kept; null when `base` pre-approves only reads (a built-in
 * agent, or one whose config pre-approves nothing more): the turn keeps it.
 * Throws when the base's config cannot be read or the copy cannot be written.
 */
export function ensureKiroGuardedAgent(requested: string | null, cwd: string, agentsDir: string = kiroUserAgentsDir(), fallback?: string): string | null {
  // A session whose agent Kiro did not report runs on the user's default agent.
  const base = requested ?? userDefaultAgent(agentsDir);
  if (base === null || BUILTIN_AGENTS.has(base)) return null;
  const name = kiroGuardedAgentName(base);
  const config = baseAgentConfig(base, cwd, agentsDir);
  if (config && !kiroAgentPreApproves(config)) return null;
  // No file to copy (v3's bundled modes): the runtime's fallback, which Kiro lists, rather than a stand-in it does not.
  if (!config && fallback) return fallback;
  writeCopy(agentsDir, name, config ? kiroGuardedAgentConfig(config, name, base) : genericGuardedConfig(name, base));
  return name;
}

/** The default agent the user's kiro-cli starts chats on (`chat.defaultAgent`), or null. */
function userDefaultAgent(agentsDir: string): string | null {
  try {
    const settings = readJson(kiroSettingsFile(agentsDir));
    const agent = settings?.['chat.defaultAgent'];
    return typeof agent === 'string' && agent.trim() ? agent.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Before a chat kiro-cli starts in `cwd`: the copies it should list, written
 * or refreshed: the user's default agent's (a conversation Michi starts runs
 * on it, guarded from its first turn) and every copy already made. Never throws.
 */
export function prepareKiroGuardedAgents(cwd: string, agentsDir: string = kiroUserAgentsDir()): void {
  const bases = new Set<string>();
  const fallback = userDefaultAgent(agentsDir);
  if (fallback) bases.add(fallback);
  try {
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.json') || !file.startsWith(`${KIRO_GUARDED_AGENT_PREFIX}${SEPARATOR}`)) continue;
      const base = kiroGuardedAgentBase(file.slice(0, -'.json'.length));
      if (base) bases.add(base);
    }
  } catch { /* no folder yet */ }
  for (const base of bases) {
    try { ensureKiroGuardedAgent(base, cwd, agentsDir); } catch { /* the turn that needs it fails closed */ }
  }
}

/** Michi's guarded agents for the Kiro adapter (KiroAdapterOptions.guardedAgent). */
export const michiKiroGuardedAgent: KiroGuardedAgentOptions = {
  ensure: (base, cwd, fallback) => ensureKiroGuardedAgent(base, cwd, undefined, fallback),
  isGuarded: isKiroGuardedAgent,
  baseOf: kiroGuardedAgentBase,
  prepare: (cwd) => prepareKiroGuardedAgents(cwd),
};
