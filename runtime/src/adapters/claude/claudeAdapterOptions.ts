import type { RuntimeWarning } from 'michi-shared';
import type { RuntimeHost } from '../../contract/host';
import type { ModelInfo, RuntimeSessionOwner, RuntimeToolProfile } from '../../contract/types';
import type { RuntimeModelCache } from '../../core/runtimeModelCache';

/** A tool call of an unrestricted session, as ClaudeAdapterOptions.requireHostApproval sees it. */
export interface ClaudeHostApprovalRequest {
  owner: RuntimeSessionOwner;
  ownerUserId: string | null;
  /** The name Claude reports: `Bash`, `mcp__<server>__<tool>`, a host tool's `mcp____michi_internal____<tool>`. */
  toolName: string;
  /** The bare name of a host tool, or null for any other tool. */
  hostToolName: string | null;
  /** The call's arguments, for a host that decides by what the call does. */
  input?: Record<string, unknown>;
}

/**
 * Lists the models the current account can use. Declared here rather than
 * beside the default probe (claudeModelProbe), whose module uses the SDK's
 * types, so that the declarations of ./adapters/claude reach none of them.
 */
export type ClaudeModelProbe = () => Promise<ModelInfo[]>;

/**
 * Live model catalog wiring. Omitted (tests, legacy callers) → listModels()
 * serves the static CLAUDE_MODEL_CATALOG and never spawns the CLI.
 */
export interface ClaudeModelCatalogOptions {
  /** Persistent snapshot store shared with the other CLI runtimes. */
  cache?: RuntimeModelCache;
  /** Defaults to asking the installed CLI via `initialize`. */
  probe?: ClaudeModelProbe;
}

/** Process and pool limits, read when the runtime and its sessions are created. */
export interface ClaudeLimits {
  /** Claude processes at most, active, warm and starting together (Michi: 15). */
  maxConcurrent: number;
  pool: {
    /** No warm processes: every chat cold-spawns. */
    disabled: boolean;
    /** Warm processes kept per (cwd, model) (Michi: 2). */
    sessionsPerCwd: number;
    /** A chat waits for a warm process still starting instead of cold-spawning (Michi: true). */
    waitForWarm: boolean;
  };
  /** Deadline for system/init after a native restore, in ms: a positive integer up to 2^31 - 1 (Michi: 60000). */
  initTimeoutMs: number;
  /** How long a permission request or question waits for its answer, in ms (Michi: 300000). */
  approveTimeoutMs: number;
  /** Wait for the process to exit after SIGINT before SIGKILL, and for its MCP slot cleanup, in ms (Michi: 2000). */
  disposeTermTimeoutMs: number;
  /** Wait for the exit after SIGKILL, in ms (Michi: 1000). */
  disposeKillTimeoutMs: number;
}

/** Claude Code CLI switches, read at each spawn (humanOrigin at each prompt). */
export interface ClaudeCliFlags {
  /** --bare for chats (Agent Runs always run bare, the Stop-hook POC never does). */
  bare: boolean;
  /** --strict-mcp-config for chats too: only the host's MCP server (Agent Runs always have it). */
  strictMcp: boolean;
  /** --forward-subagent-text, for the live subagent roster. */
  forwardSubagentText: boolean;
  /** Mark prompts a person typed as human-origin, which gates the CLI's prompt keywords. */
  humanOrigin: boolean;
}

/**
 * Wording the Claude adapter adds for the host. It has no members since the
 * follow-ups Stop-hook POC, whose instruction was its only one, was removed;
 * the adapter reads nothing from it.
 */
export interface ClaudeHostText {}

/** What the Claude adapter takes from the application that embeds it. */
export interface ClaudeAdapterOptions {
  /**
   * The host's ports. ClaudeRuntime requires backgroundTurns, workflows and
   * backgroundSubagents besides the mandatory ones.
   */
  host: RuntimeHost;
  /**
   * Live model catalog. Any object turns it on, an empty one included; when
   * absent, listModels serves the static catalog and never probes the CLI.
   */
  modelCatalog?: ClaudeModelCatalogOptions;
  /**
   * The environment every claude process starts from, read at each spawn,
   * auth preflight and model probe. The adapter only checks its credentials
   * (ANTHROPIC_API_KEY, the Bedrock and Vertex switches, AWS and Google
   * credentials) for presence and hands them to the child, and takes its
   * CLAUDE_CONFIG_DIR as the profile when configDir sets none.
   */
  spawnEnv: () => NodeJS.ProcessEnv;
  /**
   * Claude's config directory override; undefined keeps the environment's
   * CLAUDE_CONFIG_DIR, then ~/.claude. Auth preflight, spawn, the model probe
   * and the projects path all read this one function, or transcript reads
   * point at another profile's history. Default: no override.
   */
  configDir?: (userId?: string | null) => string | undefined;
  /** An explicit claude executable, read at the first lookup; else PATH and the usual install locations. */
  binaryPath: () => string | undefined;
  limits: ClaudeLimits;
  cli: () => ClaudeCliFlags;
  /**
   * A warning for what a claude process wrote to stderr, or undefined. A
   * session shows each warning message once.
   */
  stderrWarning?: (stderr: string) => RuntimeWarning | undefined;
  /**
   * Verdict on a tool call of a restricted session (SessionProfilePort.isRestricted);
   * `hostToolName` is the bare name of a host tool, or null for any other tool.
   * Default: deny every call.
   *
   * `profile` is the calling session's own tool profile (its
   * NewAgentSessionOptions.toolProfile): a host should allow only what that
   * profile allows (`allowedToolNames`), never the union of every restricted
   * profile it has (DESIGN-v2 §2.5). Absent when the session has none, and
   * from adapters that predate it: deny what cannot be placed. W1-A makes
   * ClaudeSession pass it at both call sites; W2-E's Michi host narrows to it.
   */
  restrictedToolApproval?: (hostToolName: string | null, profile?: RuntimeToolProfile) => 'allow' | 'deny';
  /**
   * Whether a tool call of an unrestricted session must be answered by the
   * host's approval (canUseTool, where the permission port decides) whatever
   * the CLI would decide first. Such a session loads the user's, project's
   * and local settings: their allow rules, and a PreToolUse hook of the
   * user's that allows, approve a call before canUseTool is asked, as
   * bypassPermissions (YOLO) approves every call. true: the session's
   * PreToolUse hook answers `ask`, so the CLI skips its allow rules, the
   * permission mode and other hooks' allow, and asks canUseTool; its deny
   * and ask rules still apply. Read at every call; a callback that throws
   * counts as true. Absent, or false: the CLI's own permission flow, as
   * before. Restricted, maintenance and Run-broker sessions are decided in
   * the hook already and never consult it. Michi: true while the chat's turn
   * holds check-in material (DESIGN-v2 §2.8, D4), except for read-only
   * built-ins and the Michi tools such a turn may run.
   */
  requireHostApproval?: (request: ClaudeHostApprovalRequest) => boolean;
  hostText?: ClaudeHostText;
  /**
   * The host's skill library as a folder with `.claude/skills/<name>`, an
   * additional directory of every session (the SDK's
   * `additionalDirectories`), or null for none. Read at each spawn. Sessions
   * that load the user's settings load its skills under their own names; one
   * whose name a personal or project skill already has is
   * `<folder name>:<skill>`. Isolated and bare sessions do not load them.
   * A session's state leaves them out: the host lists its library itself.
   * A skill there hides a legacy command of its name, so the folder should
   * not carry one named like a personal command (`<config>/commands`); a
   * runtime skill whose row the library's took is sent as its text. The
   * path should not change between calls, so warm processes keep identical
   * spawn arguments. Default: no library.
   */
  skillLibraryDir?: () => string | null;
  /**
   * Calls `listener` after the library's skills change; returns what stops
   * that. Live sessions then reload their skills (the CLI does not notice
   * the library's links change). Default: never.
   */
  subscribeSkillLibraryChanges?: (listener: () => void) => () => void;
  /**
   * Whether a session's state names the skills, plugin commands and MCP
   * prompts the CLI loaded (its / menu), read at each state report. A host
   * that shows no skills of its machine (Michi's cloud mode) says false.
   * Default: true.
   */
  advertiseSkills?: () => boolean;
}

/** The limits claudeAdapterOptions gives a host that sets none, Michi's own. Frozen, pool included. */
export const DEFAULT_CLAUDE_LIMITS: Readonly<Omit<ClaudeLimits, 'pool'>> & { readonly pool: Readonly<ClaudeLimits['pool']> } = Object.freeze({
  maxConcurrent: 15,
  pool: Object.freeze({ disabled: false, sessionsPerCwd: 2, waitForWarm: true }),
  initTimeoutMs: 60_000,
  approveTimeoutMs: 300_000,
  disposeTermTimeoutMs: 2000,
  disposeKillTimeoutMs: 1000,
});

/**
 * The CLI switches claudeAdapterOptions gives a host that sets none, Michi's
 * own: chats neither bare nor strict, so Claude also loads the user's MCP
 * servers (a restricted session is strict whatever this says); subagent text
 * and human-origin prompts on. Frozen.
 */
export const DEFAULT_CLAUDE_CLI_FLAGS: Readonly<ClaudeCliFlags> = Object.freeze({
  bare: false,
  strictMcp: false,
  forwardSubagentText: true,
  humanOrigin: true,
});

/** ClaudeAdapterOptions with only the host and the child's environment required. */
export type ClaudeAdapterOptionsInput =
  Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv'> & Partial<Omit<ClaudeAdapterOptions, 'host' | 'spawnEnv'>>;

/**
 * The adapter's options with every required member defaulted, for
 * `new ClaudeRuntime({ ...claudeAdapterOptions({ host, spawnEnv }), bridge, mcpSlots })`.
 * A required member left out or given as undefined takes its default: limits
 * a copy of DEFAULT_CLAUDE_LIMITS, cli a copy of DEFAULT_CLAUDE_CLI_FLAGS at
 * each call, no explicit binary. An optional member
 * left out or given as undefined stays absent, so the adapter's own default
 * applies. spawnEnv is passed on as given: it decides which credentials the
 * agent sees.
 */
export function claudeAdapterOptions(input: ClaudeAdapterOptionsInput): ClaudeAdapterOptions {
  return {
    host: input.host,
    ...(input.modelCatalog !== undefined ? { modelCatalog: input.modelCatalog } : {}),
    spawnEnv: input.spawnEnv,
    binaryPath: input.binaryPath ?? (() => undefined),
    limits: input.limits ?? { ...DEFAULT_CLAUDE_LIMITS, pool: { ...DEFAULT_CLAUDE_LIMITS.pool } },
    cli: input.cli ?? (() => ({ ...DEFAULT_CLAUDE_CLI_FLAGS })),
    ...(input.stderrWarning !== undefined ? { stderrWarning: input.stderrWarning } : {}),
    ...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
    ...(input.restrictedToolApproval !== undefined ? { restrictedToolApproval: input.restrictedToolApproval } : {}),
    ...(input.requireHostApproval !== undefined ? { requireHostApproval: input.requireHostApproval } : {}),
    ...(input.hostText !== undefined ? { hostText: input.hostText } : {}),
    ...(input.skillLibraryDir !== undefined ? { skillLibraryDir: input.skillLibraryDir } : {}),
    ...(input.subscribeSkillLibraryChanges !== undefined ? { subscribeSkillLibraryChanges: input.subscribeSkillLibraryChanges } : {}),
    ...(input.advertiseSkills !== undefined ? { advertiseSkills: input.advertiseSkills } : {}),
  };
}
