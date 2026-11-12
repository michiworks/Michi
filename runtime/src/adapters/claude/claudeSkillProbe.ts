import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeSkill, RuntimeSkillListing } from '../../contract/types';
import { scanSkillRoots } from '../../core/skills';
import { withDeadline } from '../../core/runtimeLifecycle';
import { killProcessTree, spawnAgentProcess } from '../../core/processTree';
import { claudeChildEnv, claudeConfigRoot, findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { InputQueue, loadClaudeSdk, type ClaudeSdkModule } from './claudeSdkTransport';
import { parseClaudeSlashCommands, type ClaudeSlashCommand } from './claudeSkills';

/**
 * Which skills Claude Code loads for a folder, asked without a chat: a CLI
 * started the way a chat in that folder starts (user, project and local
 * settings, the user's plugins) answers `initialize` with its command table.
 * One message that asks for no model call then brings system/init, which
 * says where each plugin was loaded from (plugins can load in place, not
 * from the plugin cache). The host's own library folder is not loaded: the
 * host lists the library itself.
 *
 * Cost, measured on CLI 2.1.318 in an isolated profile: about 0.5 s for
 * initialize and 50 ms for system/init; research measured 1.4-2.4 s with a
 * real profile of six plugins. The host keeps the listings; ClaudeRuntime
 * runs one probe at a time per folder.
 */

const CLAUDE_SKILL_PROBE_TIMEOUT_MS = 20_000;

/** A plugin the CLI loaded, as system/init names it. */
export interface ClaudeLoadedPlugin {
  name: string;
  /** Where it loaded from; 'builtin' for plugins inside the CLI. */
  path: string;
  /** `name@marketplace`. */
  source?: string;
}

export interface ClaudeSkillProbeResult {
  commands: ClaudeSlashCommand[];
  /** Absent when system/init did not come in time: plugin skills then have no path. */
  plugins?: ClaudeLoadedPlugin[];
  /** Plugins that failed to load, as display text. */
  pluginErrors?: string[];
}

/** The adapter options the probe reads. */
export type ClaudeSkillProbeConfig = Pick<ClaudeAdapterOptions, 'spawnEnv' | 'binaryPath'>;

export interface ClaudeSkillProbeOptions {
  cwd: string;
  /** See ClaudeAdapterOptions.configDir. */
  configDir?: string;
  timeoutMs?: number;
  /** Test seam: no hand-written wire implementation in production. */
  sdk?: Pick<ClaudeSdkModule, 'query'>;
}

function parsePlugins(value: unknown): ClaudeLoadedPlugin[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name || typeof raw.path !== 'string' || !raw.path) return [];
    return [{ name: raw.name, path: raw.path, ...(typeof raw.source === 'string' && raw.source ? { source: raw.source } : {}) }];
  });
}

function parsePluginErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.message !== 'string' || !raw.message) return [];
    return [`Claude plugin ${typeof raw.plugin === 'string' && raw.plugin ? raw.plugin : '(unnamed)'}: ${raw.message}`];
  });
}

/** The first system/init of the probe's output, or null when its turn ends without one. */
async function firstSystemInit(query: Query): Promise<Record<string, unknown> | null> {
  for await (const message of query) {
    const raw = message as unknown as Record<string, unknown>;
    if (raw.type === 'system' && raw.subtype === 'init') return raw;
    if (raw.type === 'result') return null;
  }
  return null;
}

export async function probeClaudeSkills(config: ClaudeSkillProbeConfig, opts: ClaudeSkillProbeOptions): Promise<ClaudeSkillProbeResult> {
  const spawnEnv = config.spawnEnv();
  preflightClaudeAuth(opts.configDir, spawnEnv);
  const binary = findClaudeBinary(config.binaryPath());
  const sdk = opts.sdk ?? await loadClaudeSdk();
  const timeoutMs = opts.timeoutMs ?? CLAUDE_SKILL_PROBE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const input = new InputQueue();
  let child: ChildProcessWithoutNullStreams | undefined;
  let query: Query | undefined;
  try {
    query = sdk.query({ prompt: input, options: {
      cwd: opts.cwd,
      pathToClaudeCodeExecutable: binary,
      persistSession: false,
      // Not bare: bare mode hides personal and project skills.
      settingSources: ['user', 'project', 'local'],
      // Only the command table is wanted: none of the user's hooks run, and
      // none of their MCP servers start.
      settings: { disableAllHooks: true },
      mcpServers: {},
      strictMcpConfig: true,
      env: claudeChildEnv(spawnEnv, opts.configDir),
      spawnClaudeCodeProcess: (args) => {
        child = spawnAgentProcess(args.command, args.args, { cwd: args.cwd, env: args.env, signal: args.signal });
        return child;
      },
    } });
    const answer = await withDeadline(query.initializationResult(), timeoutMs, `claude skill probe timed out after ${timeoutMs}ms`);
    const commands = parseClaudeSlashCommands((answer as { commands?: unknown }).commands) ?? [];
    // system/init comes with a user message; without the plugin paths it
    // brings, plugin skills are still listed, without files.
    input.push({
      type: 'user', message: { role: 'user', content: '__michi:skills__' }, shouldQuery: false,
      parent_tool_use_id: null, session_id: '', uuid: randomUUID(),
    });
    const init = await withDeadline(firstSystemInit(query), Math.max(1, deadline - Date.now()), 'no system/init').catch(() => null);
    if (!init) return { commands };
    const pluginErrors = parsePluginErrors(init.plugin_errors);
    return { commands, plugins: parsePlugins(init.plugins), ...(pluginErrors.length ? { pluginErrors } : {}) };
  } finally {
    input.close();
    try { query?.close(); } finally {
      if (child?.pid) killProcessTree(child.pid, 'SIGKILL');
    }
  }
}

// ---- Listing ------------------------------------------------------------------

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/** The CLI's description without what it adds: `(plugin) ` before, ` (user)` or ` (project…)` after. */
function plainDescription(description: string, pluginName?: string): string {
  const prefix = pluginName ? `(${pluginName}) ` : '';
  const text = prefix && description.startsWith(prefix) ? description.slice(prefix.length) : description;
  // Test only the last parenthesis: an unanchored search would rescan a long description at every " (".
  const open = text.lastIndexOf(' (');
  return open >= 0 && /^ \((?:user|project)(?::[^)]*)?\)$/.test(text.slice(open)) ? text.slice(0, open) : text;
}

function folderOf(skill: RuntimeSkill): string | undefined {
  return skill.path ? path.basename(path.dirname(skill.path)) : undefined;
}

/**
 * The scanned SKILL.md a row was loaded from: by its name, its folder or an
 * alias. Never a model-only skill, which the CLI leaves out of its table.
 */
function fileFor(scanned: readonly RuntimeSkill[], name: string, aliases: readonly string[] = []): RuntimeSkill | undefined {
  const names = [name, ...aliases];
  const runnable = scanned.filter((skill) => skill.userInvocable !== false);
  return runnable.find((skill) => names.includes(skill.name)) ?? runnable.find((skill) => names.includes(folderOf(skill) ?? ''));
}

export interface ClaudeSkillFolders {
  /** The workspace folder (project skills: `<cwd>/.claude/skills`). */
  cwd: string;
  /** Claude's config dir (personal skills: `<configRoot>/skills`). */
  configRoot: string;
}

/**
 * The probe's command table as runtime skills, with each one's SKILL.md
 * where its folder says (best effort): scope user, project or plugin, or
 * command for a legacy command file. Built-in rows and MCP prompts are not
 * skills. Skills only the model may use are not in the table; they are
 * added from the same folders.
 */
export async function claudeSkillListing(probe: ClaudeSkillProbeResult, folders: ClaudeSkillFolders): Promise<RuntimeSkillListing> {
  const errors: string[] = [...(probe.pluginErrors ?? [])];
  const scan = async (dir: string, scope: string, managedBy?: string) => {
    const result = await scanSkillRoots([{ dir, scope, ...(managedBy ? { managedBy } : {}) }]);
    errors.push(...(result.errors ?? []));
    return result.skills;
  };
  const personal = await scan(path.join(folders.configRoot, 'skills'), 'user');
  const project = await scan(path.join(folders.cwd, '.claude', 'skills'), 'project');
  const plugins = new Map<string, { plugin: ClaudeLoadedPlugin; managedBy: string; skills: RuntimeSkill[] }>();
  for (const plugin of probe.plugins ?? []) {
    if (!path.isAbsolute(plugin.path) || plugins.has(plugin.name)) continue;
    const managedBy = 'Claude plugin';
    plugins.set(plugin.name, { plugin, managedBy, skills: await scan(path.join(plugin.path, 'skills'), 'plugin', managedBy) });
  }

  const skills: RuntimeSkill[] = [];
  /** Names the CLI runs, so a row it lists twice, or a model-only skill it shadows, is not listed again. */
  const taken = new Set<string>();
  const listedFiles = new Set<RuntimeSkill>();
  const add = (skill: RuntimeSkill) => {
    const key = skill.nativeName ?? skill.name;
    if (taken.has(key)) return;
    taken.add(key);
    skills.push(skill);
  };
  for (const command of probe.commands) {
    if (command.builtin || command.name.startsWith('mcp__')) continue;
    const colon = command.name.indexOf(':');
    const pluginName = colon > 0 ? command.name.slice(0, colon) : undefined;
    const name = pluginName ? command.name.slice(colon + 1) : command.name;
    const loaded = pluginName ? plugins.get(pluginName) : undefined;
    const file = pluginName
      ? (loaded ? fileFor(loaded.skills, name, command.aliases) : undefined)
      : fileFor(personal, name, command.aliases) ?? fileFor(project, name, command.aliases);
    const skillName = file?.name ?? name;
    const shared: Partial<RuntimeSkill> = {
      ...(command.name !== skillName ? { nativeName: command.name } : {}),
      ...(pluginName ? { pluginId: loaded?.plugin.source ?? pluginName, managedBy: loaded?.managedBy ?? 'Claude plugin' } : {}),
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    };
    if (file) {
      listedFiles.add(file);
      add({ ...file, ...shared, description: file.description || plainDescription(command.description, pluginName), userInvocable: true });
      continue;
    }
    // A legacy command file, or a skill from a folder the probe does not know (an added directory).
    const candidates = pluginName
      ? (loaded ? [path.join(loaded.plugin.path, 'commands', `${name}.md`)] : [])
      : [path.join(folders.configRoot, 'commands', `${name}.md`), path.join(folders.cwd, '.claude', 'commands', `${name}.md`)];
    let commandFile: string | undefined;
    for (const candidate of candidates) {
      if (await isFile(candidate)) { commandFile = candidate; break; }
    }
    add({
      name, description: plainDescription(command.description, pluginName), ...shared,
      scope: pluginName ? 'plugin' : 'command', ...(commandFile ? { path: commandFile } : {}),
    });
  }
  const modelOnly = (scanned: readonly RuntimeSkill[]) => scanned.filter((skill) => skill.userInvocable === false && !listedFiles.has(skill));
  for (const skill of [...modelOnly(personal), ...modelOnly(project)]) add(skill);
  for (const { plugin, managedBy, skills: scanned } of plugins.values()) {
    for (const skill of modelOnly(scanned)) {
      add({ ...skill, nativeName: `${plugin.name}:${skill.name}`, pluginId: plugin.source ?? plugin.name, managedBy });
    }
  }
  return { skills, ...(errors.length ? { errors } : {}) };
}

export interface ClaudeSkillListingRequest {
  cwd: string;
  configDir?: string;
}

/** The listing for a folder: the probe's command table with the files behind it. Rejects when the CLI does not answer. */
export async function listClaudeSkills(
  config: ClaudeSkillProbeConfig,
  request: ClaudeSkillListingRequest,
  probe: typeof probeClaudeSkills = probeClaudeSkills,
): Promise<RuntimeSkillListing> {
  const result = await probe(config, { cwd: request.cwd, configDir: request.configDir });
  return claudeSkillListing(result, { cwd: request.cwd, configRoot: claudeConfigRoot(request.configDir, config.spawnEnv()) });
}
