import { hostSkillsPrefix } from '../../core/skills';
import fs from 'node:fs';
import path from 'node:path';
import { assertToolCatalog, catalogUnavailable, guardError } from '../../core/restrictedCatalog';
import { CODEX_META_AGENT_UNREMOVABLE_TOOLS, codexMetaAgentCatalog } from './codexToolCatalog';
import type { RuntimeToolProfile } from '../../contract/types';
import { RuntimeModelCatalog } from '../../core/modelCatalog';
import { PendingSessionAcquisitions, assertSessionReusable, sessionIdentity } from '../../core/sessionAcquisition';
import { isReasoningLevel, sanitizeReasoningLevels } from 'michi-shared';
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  ForkAgentSessionOptions,
  ListRuntimeSkillsOptions,
  LoadAgentSessionOptions,
  ModelInfo,
  NativeSessionDiscardInput,
  NativeSessionDiscardResult,
  NewAgentSessionOptions,
  RuntimeAvailability,
  RuntimeId,
  RuntimeResumeBinding,
  RuntimeSessionOwner,
  RuntimeSkillListing,
  SessionMode,
  SkillTurnInvocation,
  StructuredCompletion,
  StructuredCompletionOptions,
} from '../../contract/types';
import { assertReleaseOwnership } from '../../core/release';
import { abortable, withDeadline } from '../../core/runtimeLifecycle';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import { CODEX_RUNTIME_DESCRIPTOR } from './codexDescriptor';
import type { AgentToolBridge } from '../../contract/tools';
import type { McpSlotProvider } from '../../contract/mcp';
import { ownerMode, type FollowUpsExperimentMode, type RuntimeHost } from '../../contract/host';
import { assertHostPorts } from '../../core/defaultHost';
import { CodexAppServerClient, CodexRpcError } from './CodexAppServerClient';
import {
  CODEX_EPHEMERAL_APP_SERVER_ARGS, codexEphemeralConfigToml, prepareCodexEphemeralHome, removeCodexEphemeralHome,
} from './codexEphemeralHome';
import type { CodexCollaborationModeMask, CodexModel, CodexSkillsListing } from './codexProtocol';
import {
  buildCodexMcpConfig, CODEX_COLLABORATION_MODE_LIST, CODEX_MEMORIES_OFF, CODEX_SERVER_REQUESTS, CODEX_SKILLS_CHANGED,
  CODEX_SKILLS_EXTRA_ROOTS_SET, CODEX_SKILLS_LIST, CODEX_STRUCTURED_BASE_INSTRUCTIONS, CODEX_STRUCTURED_CONFIG_OFF,
  CODEX_STRUCTURED_FEATURES_OFF, CODEX_THREAD_FEATURES_OFF, codexAccountLoginMissing, codexConfiguredMcpServers,
  codexDisableMcpServers, codexOpenUserMcpServers, codexSkillsListing, isCodexModeKind,
} from './codexProtocol';
import { codexRuntimeSkills, codexSkillInput, hostSkillFolders, type CodexSkillInput } from './codexSkills';
import { CodexSession } from './CodexSession';
import { completeCodexStructured } from './codexStructured';
import {
  CODEX_RESTRICTED_TURN_POLICY, codexRestrictedMcpCheck, codexRestrictedThreadConfig, codexThreadSandbox,
} from './codexRestrictedProfile';
import { CodexAuthMissingError, configureCodexBinaryCache, findCodexBinary, preflightCodexAuth } from './codexBinary';
import { NativeResumeUnavailableError } from '../../contract/errors';
import type { RuntimeModelCache } from '../../core/runtimeModelCache';
import { CODEX_METADATA_OUTPUT_MODE } from './codexTurnMetadata';

// ---- Errors ------------------------------------------------------------------

export class CodexConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexConcurrencyError';
  }
}
export class CodexSessionNotResumableError extends NativeResumeUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSessionNotResumableError';
  }
}

// ---- Capabilities ------------------------------------------------------------

const CODEX_CAPABILITIES: AgentCapabilities = {
  // Codex collaboration modes (Default, Plan), from collaborationMode/list.
  modes: true,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
  apiKeys: false,
  warmSessions: false,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

// ---- Approval alias map (spec §5.1) -----------------------------------------
//
// CRITICAL for security: only these methods are allowed to consult the chat
// tool policy (which allows any tool in Trust and YOLO). Any method NOT in this map must
// use its own protocol handler or return an unsupported-method error.

const CODEX_APPROVAL_ALIASES: Record<string, string> = {
  [CODEX_SERVER_REQUESTS.commandApproval]: 'bash',
  [CODEX_SERVER_REQUESTS.fileChangeApproval]: 'edit',
};

const RECOVERY_TIMEOUT_MS = 20_000;
/** An idle chat session is released after this long; the next message resumes its thread. */
export const CODEX_IDLE_TTL_MS = 5 * 60_000;
/**
 * A session that holds background children (CodexSession.hasBackgroundWork)
 * is released once they have been quiet this long (CodexSession.isBackgroundIdleExpired)…
 */
export const CODEX_BACKGROUND_IDLE_TTL_MS = 2 * 60 * 60_000;
/** …or this long after its own last use, whatever they do (matches Claude's reclaim protection). */
export const CODEX_BACKGROUND_IDLE_CAP_MS = 6 * 60 * 60_000;
const RECOVERY_TIMEOUT_MESSAGE = 'Codex native recovery exceeded 20 seconds. Original thread retained; please retry.';
/** skills/list and skills/extraRoots/set: well under the RPC default, so neither holds up a start or a recovery for long. */
const SKILLS_RPC_TIMEOUT_MS = 10_000;
/** How long a skill turn waits for the listing that says whether Codex can run the skill itself. */
const SKILL_LOOKUP_TIMEOUT_MS = 5_000;

/** app-server does not know `method` (an older Codex): it answers -32600 "unknown variant", or JSON-RPC's -32601. */
function codexMethodMissing(error: unknown, method: string): boolean {
  return error instanceof CodexRpcError
    && (error.code === -32601 || error.rpcMessage.includes(`unknown variant \`${method}\``));
}

/** What the agent menu says about each Codex collaboration mode (collaborationMode/list names them only). */
const CODEX_MODE_DESCRIPTIONS: Record<string, string> = {
  default: 'Codex works on the request directly.',
  plan: 'Codex explores and proposes a plan instead of changing files.',
};

/** A restricted thread config without its sub-agent thread limit, for app-servers that reject the table. */
function restrictedConfig(config: Record<string, unknown>, subagentLimit: boolean): Record<string, unknown> {
  if (subagentLimit) return config;
  const features = config.features && typeof config.features === 'object' ? config.features as Record<string, unknown> : {};
  return { ...config, features: { ...features, multi_agent_v2: false } };
}

// ---- CodexRuntime ------------------------------------------------------------

/** Wording the Codex adapter adds for the host. Each absent member adds nothing. */
export interface CodexHostText {
  /** Turn-metadata rules: appended to an interactive session's developer instructions and to each of its turns. */
  turnMetadataInstruction?(mode: FollowUpsExperimentMode, enableFollowUps?: boolean): string;
  /** Developer instructions of the title thread; the user's message is sent as its turn. */
  titleInstructions?(): string;
  /** The title thread's turn for AgentTurnInput.titleSource. Default: its text. */
  titleInput?(text: string, context?: string): string;
}

/**
 * How the host configures the Codex adapter (Michi: codexAdapterOptions in
 * runtimeFactories.ts, which reads the environment). The adapter reads no
 * environment itself; unset options take the defaults noted here.
 */
export interface CodexAdapterOptions {
  /** The host ports; CodexRuntime asserts the ones it uses at construction. */
  host: RuntimeHost;
  /** Persistent model catalog shared with the other dynamic runtimes. */
  modelCache?: RuntimeModelCache;
  /** The Codex CLI to run when that file exists, before PATH and the standard locations. */
  binaryPath?: string;
  /**
   * A JSON file remembering where the Codex CLI was found, so later starts
   * skip the search while that file still exists. Default: none (searched
   * once per process).
   */
  binaryCacheFile?: string;
  /** The user's Codex home, holding auth.json. Default: ~/.codex. */
  codexHome?: string;
  /**
   * The app-server child's environment, called once at construction (provider
   * env_keys come from it). The host must pass it: without it the child gets
   * an empty environment, with no PATH or HOME.
   */
  spawnEnv?: () => NodeJS.ProcessEnv;
  /** Per JSON-RPC request. Default: 30s. */
  rpcTimeoutMs?: number;
  /** The app-server initialize handshake. Default: 30s. */
  initTimeoutMs?: number;
  /** How long a tool approval waits for the user before it is declined. Default: 300s. */
  approveTimeoutMs?: number;
  /** The title thread's deadline, read at each title. Default: the host's titleModel deadline. */
  titleTimeoutMs?: () => number;
  /** Live and pending sessions allowed at once; anything but a positive safe integer means no cap. */
  maxConcurrent?: number;
  hostText?: CodexHostText;
  /**
   * Absolute folders of the host's own skills for app-server to scan beside
   * its own (Michi: the flat mount of its skill library), read at each
   * app-server start and on `onSkillRootsChanged`. app-server keeps one such
   * list per process and forgets it on exit, so it is sent after every start
   * (skills/extraRoots/set). Their skills are left out of listSkills, which
   * reports the runtime's own; a library skill turn runs them natively.
   */
  skillRoots?: () => readonly string[];
  /**
   * Subscribes to changes of those folders or the skills in them; returns
   * an unsubscribe. The running app-server then gets the roots again, which
   * makes it re-scan them, and the next listing re-reads every folder.
   */
  onSkillRootsChanged?: (listener: () => void) => () => void;
  /**
   * Where ephemeral sessions (NewAgentSessionOptions.ephemeral, a Companion
   * check-in) get their own Codex homes, one directory per session
   * (codexEphemeralHome.ts). Default: `<host data dir>/codex-ephemeral-homes`.
   */
  ephemeralHomeRoot?: string;
}

/** What CodexRuntime is built from: the adapter's options plus the host's tool effects and MCP slots. */
export interface CodexRuntimeOptions extends CodexAdapterOptions {
  /** Business effects of the host's tools (spawn branches, save/update artifacts). */
  bridge: AgentToolBridge;
  /** The host's MCP slots; every Codex session's host tools go through them. */
  mcpSlots: McpSlotProvider;
}

/** @internal Not covered by the v1 contract. */
export interface CodexRuntimeTestSeams {
  client?: CodexAppServerClient;
  /** As if the Codex home had no auth.json: sessions ask app-server (account/read) first. */
  authFileMissing?: string;
  /** false: restricted threads omit the sub-agent thread limit, leaving only the session's spawn guard. */
  restrictedSubagentLimit?: boolean;
  /** The app-server client of an ephemeral session, given its home and the app-server arguments it would get. */
  ephemeralClient?: (home: string, extraArgs: readonly string[]) => CodexAppServerClient;
}

/** An ephemeral session's own app-server and home (codexEphemeralHome.ts). */
interface CodexEphemeralServer {
  client: CodexAppServerClient;
  home: string;
}

/** Every port the adapter reads. */
const CODEX_HOST_PORTS = [
  'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title', 'backgroundSubagents',
] as const;

export class CodexRuntime implements AgentRuntime {
  public readonly id: RuntimeId = 'codex';
  public readonly label = 'Codex';
  public readonly capabilities = CODEX_CAPABILITIES;
  public readonly descriptor: RuntimeDescriptor = CODEX_RUNTIME_DESCRIPTOR;

  private readonly client: CodexAppServerClient;
  private readonly bridge: AgentToolBridge;
  private readonly mcpRegistry: McpSlotProvider;
  private readonly host: RuntimeHost;
  private readonly concurrencyCap: number;
  private readonly idleSweep: ReturnType<typeof setInterval>;
  private readonly binaryPath: string | undefined;
  private readonly approveTimeoutMs: number | undefined;
  private readonly titleTimeoutMs: (() => number) | undefined;
  /** The title thread's deadline: the adapter option, else the host's titleModel deadline. */
  private readonly titleDeadlineMs = (): number => this.titleTimeoutMs?.() ?? this.host.config.titleModel(this.id).timeoutMs;
  private readonly hostText: CodexHostText | undefined;

  private readonly sessions = new Map<string, CodexSession>();
  private readonly threadToSession = new Map<string, CodexSession>();
  private readonly pendingSessions = new PendingSessionAcquisitions<AgentSession>();
  private readonly releasingSessions = new Map<string, Promise<void>>();
  private recovery: Promise<void> | null = null;
  private daemonDisconnected = false;

  private readonly modelCatalog: RuntimeModelCatalog<Record<string, unknown>>;
  /** No auth.json in the Codex home: whether Codex has credentials is asked of app-server. */
  private readonly authFileMissing: string | undefined;
  /** The running app-server answered account/read for this process. */
  private nativeAuthChecked = false;
  /** app-server reported a missing login (account/read), surfaced by checkAvailability. */
  private authError: string | undefined;
  private modeCatalog: SessionMode[] | null = null;
  private readonly restrictedSubagentLimit: boolean;
  /** Everything an ephemeral session's app-server needs (CodexAdapterOptions.ephemeralHomeRoot). */
  private readonly ephemeralSetup: {
    root: string;
    codexHome: string | undefined;
    spawnEnv: NodeJS.ProcessEnv;
    rpcTimeoutMs: number | undefined;
    initTimeoutMs: number | undefined;
    client?: CodexRuntimeTestSeams['ephemeralClient'];
  };
  /** Ephemeral sessions' app-servers by public id, from open until release. */
  private readonly ephemeralServers = new Map<string, CodexEphemeralServer>();

  private readonly skillRoots: (() => readonly string[]) | undefined;
  private readonly unsubscribeSkillRoots: (() => void) | undefined;
  /** The roots last given to an app-server; kept after it exits, since cached listings still hold their skills. */
  private skillRootsSent: string[] = [];
  /** How the running app-server took them; null while none runs or before it is initialized. */
  private skillRootsOnDaemon: 'pending' | 'applied' | 'failed' | 'unsupported' | null = null;
  private extraRootsMissingLogged = false;
  /** skills/list answers per cwd, until app-server reports a change (skills/changed) or the host's roots change. */
  private readonly skillListings = new Map<string, Promise<CodexSkillsListing>>();
  /** The next skills/list re-reads skills from disk: the host's skills changed, and app-server misses edits in linked folders. */
  private skillsReloadPending = false;
  private unwatchSkills: (() => void) | null = null;

  /**
   * Binary lookup, plus the login state app-server last reported. A missing
   * auth.json alone does not make Codex unavailable (a provider such as
   * Amazon Bedrock manages its own credentials); the first session asks
   * app-server and a missing login is reported from then on.
   * findCodexBinary caches, so this is filesystem-only per call.
   */
  checkAvailability(): RuntimeAvailability {
    try {
      findCodexBinary(this.binaryPath);
    } catch (err) {
      return { available: false, detail: (err as Error).message };
    }
    if (this.authError) return { available: false, detail: this.authError };
    return { available: true };
  }

  constructor(options: CodexRuntimeOptions);
  /** @internal Not covered by the v1 contract. */
  constructor(options: CodexRuntimeOptions, testSeams?: CodexRuntimeTestSeams);
  constructor(options: CodexRuntimeOptions, testSeams?: CodexRuntimeTestSeams) {
    // tsc cannot see untyped (JS or require'd) callers of the old positional
    // form, nor members left undefined.
    if (typeof options !== 'object' || options === null || options.host == null || options.bridge == null || options.mcpSlots == null) {
      throw new TypeError('CodexRuntime takes one options object { host, bridge, mcpSlots, … } (runtime contract v1)');
    }
    assertHostPorts(options.host, CODEX_HOST_PORTS, 'CodexRuntime');
    this.bridge = options.bridge;
    this.mcpRegistry = options.mcpSlots;
    this.host = options.host;
    this.binaryPath = options.binaryPath;
    if (options.binaryCacheFile !== undefined) configureCodexBinaryCache(options.binaryCacheFile);
    this.approveTimeoutMs = options.approveTimeoutMs;
    this.titleTimeoutMs = options.titleTimeoutMs;
    this.hostText = options.hostText;
    const configuredCap = options.maxConcurrent;
    this.concurrencyCap = configuredCap !== undefined && Number.isSafeInteger(configuredCap) && configuredCap > 0
      ? configuredCap : Infinity;


    let authFileMissing = testSeams?.authFileMissing;
    if (testSeams?.client) {
      this.client = testSeams.client;
    } else {
      // No auth.json is only a hint: app-server is asked before the first thread.
      try {
        preflightCodexAuth(options.codexHome);
      } catch (err) {
        authFileMissing = (err as Error).message;
      }
      this.client = new CodexAppServerClient({
        spawnEnv: { ...options.spawnEnv?.() },
        binaryPath: options.binaryPath,
        rpcTimeoutMs: options.rpcTimeoutMs,
        initTimeoutMs: options.initTimeoutMs,
      });
    }
    this.ephemeralSetup = {
      root: path.resolve(options.ephemeralHomeRoot ?? path.join(this.host.config.dataDir(), 'codex-ephemeral-homes')),
      codexHome: options.codexHome,
      // The user's environment without CODEX_HOME, which the session's own home replaces.
      spawnEnv: { ...options.spawnEnv?.() },
      rpcTimeoutMs: options.rpcTimeoutMs,
      initTimeoutMs: options.initTimeoutMs,
      client: testSeams?.ephemeralClient,
    };
    this.authFileMissing = authFileMissing;
    this.restrictedSubagentLimit = testSeams?.restrictedSubagentLimit !== false;
    this.modelCatalog = new RuntimeModelCatalog({
      initial: options.modelCache?.load(this.id),
      probe: async () => {
        await this.client.ensureStarted();
        return await this.client.request('model/list', {}) as Record<string, unknown>;
      },
      normalize: (result) => {
        const raw = Array.isArray(result['data']) ? (result['data'] as CodexModel[]) : [];
        return raw.filter((m) => !m.hidden).map((m) => ({
          id: m.id,
          label: m.displayName || m.id,
          description: m.description || undefined,
          isDefault: m.isDefault || undefined,
          ...(Array.isArray(m.supportedReasoningEfforts) ? {
            supportedReasoningLevels: sanitizeReasoningLevels(m.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)),
            supportsReasoning: m.supportedReasoningEfforts.length > 0,
          } : {}),
          ...(isReasoningLevel(m.defaultReasoningEffort) ? { defaultReasoning: m.defaultReasoningEffort } : {}),
        }));
      },
      persist: (models) => options.modelCache?.save(this.id, models),
    });

    this.idleSweep = setInterval(() => {
      void this.releaseIdleSessions().catch((err: unknown) => {
        console.warn('[CodexRuntime] idle session cleanup failed:', err);
      });
    }, 60_000);
    this.idleSweep.unref();

    this.wireServerRequests(this.client);

    // When daemon exits unexpectedly, crash all live sessions.
    this.client.onExit(() => {
      this.daemonDisconnected = true;
      this.nativeAuthChecked = false;
      this.skillsDaemonStopped();
      for (const session of this.sessions.values()) {
        if (this.ephemeralServers.has(session.id)) continue;
        session.markCrashed('codex app-server exited unexpectedly');
      }
    });

    this.skillRoots = options.skillRoots;
    if (this.skillRoots) {
      this.client.onStarted(() => this.applySkillRoots(true));
      this.unsubscribeSkillRoots = options.onSkillRootsChanged?.(() => this.skillRootsChanged());
    }
  }

  /** The server-request (approval, question) handler of an app-server; shared by every session on it. */
  private wireServerRequests(client: CodexAppServerClient): void {
    client.onServerRequest((method, params, respond, context) => {
      if (method === CODEX_SERVER_REQUESTS.requestUserInput) {
        this.handleUserInputRequest(params, respond, context?.signal);
        return;
      }
      if (method === CODEX_SERVER_REQUESTS.mcpElicitation) {
        this.handleMcpElicitationRequest(params, respond, context?.signal);
        return;
      }
      if (method === CODEX_SERVER_REQUESTS.permissionsApproval) {
        // A tool approval is not a sandbox permission profile. Until the UI can
        // present the requested scopes faithfully, grant no extra permissions.
        respond({ permissions: {}, scope: 'turn' });
        return;
      }
      if (method === CODEX_SERVER_REQUESTS.currentTime) {
        respond({ currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(CODEX_APPROVAL_ALIASES, method)) {
        this.handleApprovalRequest(method, params, respond, context?.signal);
        return;
      }
      context.reject(-32601, 'Server request is not supported by Michi');
    });
  }

  // ---- warm ----------------------------------------------------------------

  async warm(_cwd: string, _opts?: { model?: string | null }): Promise<void> {
    // Codex has no warm pool (warmSessions: false).
    // Ensure the daemon is started as an optimization.
    try {
      await this.client.ensureStarted();
    } catch {
      // Ignore — warm is best-effort
    }
  }

  /**
   * Starts app-server and, when the Codex home has no auth.json, asks it
   * whether the configured provider still needs a login (once per process).
   * Throws CodexAuthMissingError before any thread is opened when it does.
   */
  private async startClient(timeoutMs?: number): Promise<void> {
    await this.client.ensureStarted(timeoutMs);
    if (!this.authFileMissing || this.nativeAuthChecked) return;
    let result: unknown;
    try {
      result = await this.client.request('account/read', { refreshToken: false }, timeoutMs);
    } catch (err) {
      // Older app-servers may not answer; the thread itself will report a real auth failure.
      this.host.observability.log('warn', 'chat', 'codex account/read failed; continuing without an auth check', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.nativeAuthChecked = true;
      return;
    }
    this.nativeAuthChecked = true;
    if (codexAccountLoginMissing(result)) {
      this.authError = `Codex needs a login for its configured provider (${this.authFileMissing}). Run \`codex login\`, or set CODEX_HOME if your credentials are stored elsewhere.`;
      throw new CodexAuthMissingError(this.authError);
    }
    this.authError = undefined;
  }

  // ---- modes ---------------------------------------------------------------

  /**
   * Codex collaboration modes (collaborationMode/list, experimental API),
   * the same for every session. Empty when this app-server has none.
   */
  async listModes(_sessionId: string): Promise<SessionMode[]> {
    if (this.modeCatalog) return this.modeCatalog;
    await this.client.ensureStarted();
    let result: { data?: unknown } | undefined;
    try {
      result = await this.client.request(CODEX_COLLABORATION_MODE_LIST, {}) as { data?: unknown } | undefined;
    } catch (err) {
      this.host.observability.log('warn', 'chat', 'codex collaborationMode/list failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const masks = Array.isArray(result?.data) ? result.data as CodexCollaborationModeMask[] : [];
    const modes = masks.filter((mask) => isCodexModeKind(mask?.mode)).map((mask): SessionMode => ({
      id: mask.mode!,
      label: typeof mask.name === 'string' && mask.name ? mask.name : mask.mode!,
      description: CODEX_MODE_DESCRIPTIONS[mask.mode!],
    }));
    this.modeCatalog = modes;
    return modes;
  }

  // ---- skills --------------------------------------------------------------

  /**
   * The skills app-server loads for `cwd` (skills/list, no thread): repo,
   * user, system, admin and plugin skills, without the host's own from
   * `skillRoots`. Cached per cwd; `refresh` re-reads them from disk.
   */
  async listSkills(opts: ListRuntimeSkillsOptions): Promise<RuntimeSkillListing> {
    const pending = this.codexSkills(opts.cwd, opts.refresh === true);
    const listing = await (opts.signal ? abortable(pending, opts.signal) : pending);
    return codexRuntimeSkills(listing, await hostSkillFolders(this.skillRootsSent));
  }

  private codexSkills(cwd: string, refresh: boolean, timeoutMs = SKILLS_RPC_TIMEOUT_MS): Promise<CodexSkillsListing> {
    const cached = refresh ? undefined : this.skillListings.get(cwd);
    if (cached) return cached;
    this.unwatchSkills ??= this.client.onGlobalNotification((method) => {
      if (method === CODEX_SKILLS_CHANGED) this.skillListings.clear();
    });
    const reloadPending = this.skillsReloadPending;
    this.skillsReloadPending = false;
    const listing = (async () => {
      await this.client.ensureStarted();
      const result = await this.client.request(CODEX_SKILLS_LIST, { cwds: [cwd], forceReload: refresh || reloadPending }, timeoutMs);
      return codexSkillsListing(result, cwd);
    })();
    this.skillListings.set(cwd, listing);
    listing.catch(() => {
      if (this.skillListings.get(cwd) === listing) this.skillListings.delete(cwd);
      if (reloadPending) this.skillsReloadPending = true;
    });
    return listing;
  }

  /**
   * The skill input that runs `skill` in a thread at `cwd`, or null to send
   * it as text. Library skills need the host's roots on this app-server.
   */
  private async skillInputFor(skill: SkillTurnInvocation, cwd: string): Promise<CodexSkillInput | null> {
    try {
      const listing = await this.codexSkills(cwd, false, SKILL_LOOKUP_TIMEOUT_MS);
      return await codexSkillInput(skill, listing, this.skillRootsOnDaemon === 'applied' ? this.skillRootsSent : []);
    } catch (err) {
      this.host.observability.log('warn', 'chat', 'codex skills/list failed; sending the skill as text', {
        cwd, skill: skill.name, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Gives the running app-server the host's skill roots. `fresh`: a new
   * app-server (onStarted). Never throws; an app-server without the method
   * (an older Codex) is noted once, and library skills then run as text.
   */
  private async applySkillRoots(fresh: boolean): Promise<void> {
    if (fresh) this.skillRootsOnDaemon = 'pending';
    const roots = [...(this.skillRoots?.() ?? [])];
    let outcome: 'applied' | 'failed' | 'unsupported' = 'applied';
    try {
      await this.client.request(CODEX_SKILLS_EXTRA_ROOTS_SET, { extraRoots: roots }, SKILLS_RPC_TIMEOUT_MS);
    } catch (err) {
      outcome = codexMethodMissing(err, CODEX_SKILLS_EXTRA_ROOTS_SET) ? 'unsupported' : 'failed';
      if (outcome === 'failed') {
        this.host.observability.log('warn', 'chat', 'codex skills/extraRoots/set failed; library skills run as text', {
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
      } else if (!this.extraRootsMissingLogged) {
        this.extraRootsMissingLogged = true;
        this.host.observability.log('info', 'chat', 'this Codex has no skills/extraRoots/set; library skills run as text');
      }
    }
    // That app-server exited meanwhile; the next one gets the roots when it starts.
    if (this.skillRootsOnDaemon === null) return;
    this.skillRootsOnDaemon = outcome;
    if (outcome === 'applied') this.skillRootsSent = roots;
  }

  /** app-server stopped: the next one starts without the host's roots, and its listings may differ. */
  private skillsDaemonStopped(): void {
    this.skillRootsOnDaemon = null;
    this.skillListings.clear();
  }

  private skillRootsChanged(): void {
    this.skillsReloadPending = true;
    this.skillListings.clear();
    // Setting the roots again makes app-server re-scan them (it misses edits and removals in linked folders).
    if (this.skillRootsOnDaemon === 'applied' || this.skillRootsOnDaemon === 'failed') void this.applySkillRoots(false);
  }

  // ---- newSession ----------------------------------------------------------

  async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    return this.acquireSession(opts, () => this.createSession(opts));
  }

  private async acquireSession(
    opts: NewAgentSessionOptions | LoadAgentSessionOptions,
    create: () => Promise<AgentSession>,
  ): Promise<AgentSession> {
    if (!opts.sessionId) throw new Error('sessionId is required for CodexRuntime');
    const { owner, id } = sessionIdentity(opts.owner, opts.sessionId);
    const compatible = (session: AgentSession): AgentSession => assertSessionReusable(session,
      { owner, ownerUserId: opts.ownerUserId, profileHash: opts.profileHash }, (s) => (s as CodexSession).getOwnerUserId());
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    while (this.recovery) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(RECOVERY_TIMEOUT_MESSAGE);
      await withDeadline(this.recovery.catch(() => {}), remaining, RECOVERY_TIMEOUT_MESSAGE);
    }
    const releasing = this.releasingSessions.get(id);
    if (releasing) await withDeadline(releasing, Math.max(1, deadline - Date.now()), RECOVERY_TIMEOUT_MESSAGE);
    await this.pendingSessions.waitForRelease(id);
    const pending = this.pendingSessions.get(id);
    if (pending) return compatible(await pending);
    const existing = this.sessions.get(id);
    if (existing) return compatible(existing);
    const pendingCount = [...this.pendingSessions.keys()].filter((key) => !this.sessions.has(key)).length;
    if (this.sessions.size + pendingCount >= this.concurrencyCap) {
      throw new CodexConcurrencyError(`Codex concurrency cap (${this.concurrencyCap}) reached.`);
    }
    return this.pendingSessions.acquire(id, create, compatible);
  }

  async forkSession(opts: ForkAgentSessionOptions): Promise<AgentSession> {
    // Codex thread/fork always copies the parent's latest rollout; an anchor
    // older than the tail must use the exact text prefix instead.
    if (opts.anchorMessageId) {
      throw new NativeResumeUnavailableError('Codex native fork cannot stop at a historical branch anchor');
    }
    return this.acquireSession(opts, () => this.createSession({ ...opts, branchContext: undefined }, opts.sourceNativeSessionId));
  }

  private async createSession(opts: NewAgentSessionOptions, forkFrom?: string): Promise<AgentSession> {
    const nodeId = opts.sessionId ?? (() => { throw new Error('sessionId is required for CodexRuntime'); })();

    // Resolve the owner. A headless owner's session id is its key; a chat's
    // is the id it was opened under.
    const { owner, id: publicId } = sessionIdentity(opts.owner, nodeId);
    const interactive = ownerMode(owner) === 'interactive';

    // Double-load guard
    const existing = this.sessions.get(publicId);
    if (existing) return existing;
    if (opts.ephemeral && forkFrom) throw new NativeResumeUnavailableError('An ephemeral Codex session is never forked');

    await this.startClient();

    // Resolve model — fall back to isDefault from model/list if empty
    let modelId = opts.model ?? this.host.config.defaultModel(this.id);
    if (!modelId) {
      const models = await this.listModels();
      const def = models.find((m) => m.isDefault);
      modelId = def?.id ?? '';
    }

    // Ancestor chain for preamble (chat sessions only). A server-resolved
    // branch prefix replaces the live chain so the cut is honored.
    const ancestorChain: AgentSession[] = [];
    if (!forkFrom && !opts.branchContext && interactive && opts.parentChatId) {
      this.host.sessions.ensureAncestorChainLoaded(opts.parentChatId);
      const parent = this.host.sessions.getSession(opts.parentChatId);
      if (parent) {
        ancestorChain.push(...this.host.sessions.getAncestors(opts.parentChatId), parent);
      }
    }

    const workspaceInstructions = opts.workspaceId && !this.host.profile.isMaintenance?.(opts.toolProfile)
      ? this.host.prompt.workspaceInstructions(opts.workspaceId)
      : null;

    const branchContextText = opts.branchContext
      ? this.host.prompt.renderBranchContext(opts.branchContext)
      : null;
    // For a headless owner, bootstrapInstructions come from its host; for chat,
    // build from ancestor chain and context, with the chat's own bootstrap
    // (a primary Agent's after it, the Michi assistant's ahead), as Claude does.
    const firstTurnPrefix = !interactive
      ? (opts.bootstrapInstructions ?? '')
      : this.host.profile.composeFirstTurnPrefix(this.host.prompt.firstTurnPrefix({
          cwd: opts.cwd,
          contextManifest: opts.contextManifest,
          ...(opts.artifactCount !== undefined ? { artifactCount: opts.artifactCount } : {}),
          extraContexts: opts.extraContexts,
          ancestors: ancestorChain,
          mergeContexts: [
            ...(branchContextText ? [branchContextText] : []),
            ...(opts.mergeContexts ?? []),
          ],
          workspaceInstructions,
          ...(forkFrom && opts.parentChatId ? { nativeForkParentNodeId: opts.parentChatId } : {}),
          ...(opts.toolProfile ? { toolProfile: opts.toolProfile } : {}),
          // The host's library is one of app-server's extra skill roots when it gives them.
          ...hostSkillsPrefix(this.host.profile, { interactive, toolProfile: opts.toolProfile, librarySkillsLoaded: this.skillRoots !== undefined }),
        }), opts.bootstrapInstructions, opts.toolProfile);

    const effort = opts.reasoning !== undefined ? opts.reasoning : this.host.config.defaultReasoning(this.id, opts.ownerUserId) ?? null;
    const enableFollowUps = opts.enableFollowUps !== false && !this.host.profile.isRestricted(opts.toolProfile);
    // Resolved on the main app-server before an ephemeral one starts.
    const titleModel = await this.resolveTitleModel();
    // An ephemeral session runs on an app-server of its own, on a new home.
    // Once it runs, any failure before the session is registered stops it.
    const client = opts.ephemeral ? await this.openEphemeralServer(publicId, opts.cwd) : this.client;
    let session: CodexSession;
    let slotId: string;
    try {
      // Create MCP slot (session pre-wires the callbacks but MCP slot created here)
      // We construct the session first so it can own the slot.
      session = new CodexSession({
        nodeId: publicId,
        threadId: '', // will be set below after thread/start
        cwd: opts.cwd,
        workspaceId: opts.workspaceId ?? null,
        parentChatId: interactive ? opts.parentChatId : undefined,
        client,
        host: this.host,
        mcpRegistry: this.mcpRegistry,
        bridge: this.bridge,
        ownerUserId: opts.ownerUserId ?? null,
        firstTurnPrefix,
        effort: effort ? String(effort) : null,
        model: modelId || null,
        // The title thread is a separate thread outside the assistant's lockdown
        // (shell, plugins, the user's MCP servers); the assistant's title is fixed.
        generateTitleOnFirstTurn: interactive && !this.host.profile.isRestricted(opts.toolProfile)
          && this.host.title.enabled(this.id),
        titleModel,
        enableFollowUps,
        approveTimeoutMs: this.approveTimeoutMs,
        titleTimeoutMs: this.titleDeadlineMs,
        hostText: this.hostText,
        owner,
        profileHash: opts.profileHash,
        toolProfile: opts.toolProfile,
        permissionBroker: opts.permissionBroker,
        // An ephemeral thread has no rollout to resume: its turn fails instead.
        recover: opts.ephemeral
          ? async () => { throw new Error('This Codex session keeps no native record and is not restored after its app-server stopped.'); }
          : (s) => this.recoverSession(s),
        // The main app-server's skill listing does not describe an ephemeral
        // session's own app-server (another home, no host roots): its skill
        // turns send the skill as text.
        ...(opts.ephemeral ? {} : { skillInput: (skill: SkillTurnInvocation, cwd: string) => this.skillInputFor(skill, cwd) }),
      });

      // A native fork copies the parent's history, and with it the mode Codex
      // keeps for the thread; carry the live parent's mode so its turns say so.
      if (forkFrom && opts.parentChatId) {
        const parentMode = this.host.sessions.getSession(opts.parentChatId)?.currentModeId;
        if (isCodexModeKind(parentMode)) session.currentModeId = parentMode;
      }

      slotId = session.createMcpSlot();
    } catch (error) {
      if (opts.ephemeral) await this.closeEphemeralServer(publicId);
      throw error;
    }

    // Start the thread on codex app-server
    try {
      await this.openThread(session, slotId, opts.cwd, (config) => client.request(forkFrom ? 'thread/fork' : 'thread/start', {
        ...(forkFrom ? { threadId: forkFrom } : {}),
        model: modelId || undefined,
        cwd: opts.cwd,
        developerInstructions: this.buildDeveloperInstructions(enableFollowUps, owner, opts.toolProfile),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: codexThreadSandbox(this.host.profile.isRestricted(opts.toolProfile)),
        config,
        ...(effort ? { reasoningEffort: String(effort) } : {}),
        // Not materialized on disk (P3: no rollout, path null). Its memory
        // mode cannot be set (P3: "ephemeral thread does not support
        // metadata updates"); the app-server has memories off instead.
        ...(opts.ephemeral ? { ephemeral: true } : {}),
      }) as Promise<Record<string, unknown>>, (threadStartResult) => {
        const thread = threadStartResult['thread'] as Record<string, unknown> | undefined;
        const started = (thread?.['id'] as string | undefined) ?? (threadStartResult['threadId'] as string | undefined);
        if (!started || started === forkFrom) {
          throw new Error(`codex ${forkFrom ? 'thread/fork' : 'thread/start'} did not return an independent threadId`);
        }
        // Rebind session's threadId (the session was constructed with '' as placeholder)
        (session as any).threadId = started;
        // Update nativeSessionId after threadId is known
        (session as any).nativeSessionId = started;
        // An app-server that ignored `ephemeral` (said false, or nothing)
        // would keep a rollout: only an explicit `true` is accepted.
        if (opts.ephemeral && thread?.['ephemeral'] !== true) {
          throw new Error('codex thread/start did not open an ephemeral thread');
        }
      }, client);
    } catch (error) {
      await session.dispose();
      if (opts.ephemeral) await this.closeEphemeralServer(publicId);
      if (forkFrom && /no rollout found for thread id|method not found/i.test(error instanceof Error ? error.message : '')) {
        throw new NativeResumeUnavailableError('Codex native fork is unavailable');
      }
      throw error;
    }
    const threadId = session.threadId;

    // Wire notifications before registering
    session.wireNotifications();

    // The route/Executor commits the complete binding atomically. Publishing
    // an external ID here would overwrite the old binding before that commit.

    this.sessions.set(publicId, session);
    this.threadToSession.set(threadId, session);
    this.host.sessions.registerSession(session, opts.ownerUserId, owner);

    return session;
  }

  // ---- loadSession ---------------------------------------------------------

  async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    return this.acquireSession(opts, () => this.restoreSession(opts));
  }

  /** A chat binding resumes its Codex thread: the external session id, else the legacy ACP column. */
  resumeTokenFromBinding(binding: RuntimeResumeBinding | null | undefined): string | null {
    return binding?.external_session_id ?? binding?.acp_session_id ?? null;
  }

  private async restoreSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    const { owner, id: publicId } = sessionIdentity(opts.owner, opts.sessionId);

    // Double-load guard
    const existing = this.sessions.get(publicId);
    if (existing) return existing;

    // Resolve the native thread id.
    // Agent Run: from nativeResumeToken — NEVER read nodes.external_session_id.
    // Chat: from the node row (existing behavior).
    let threadId: string | null = null;
    let nodeWorkspaceId: string | null = null;
    if (ownerMode(owner) === 'headless') {
      threadId = typeof opts.nativeResumeToken === 'string' ? opts.nativeResumeToken : null;
      if (!threadId) {
        throw new CodexSessionNotResumableError(
          `Attempt ${publicId} has no nativeResumeToken — cannot resume codex agent_run session`,
        );
      }
    } else {
      const node = this.host.bindings.nodeBinding(publicId);
      if (node?.runtime_id && node.runtime_id !== 'codex') {
        throw new Error(`Node ${publicId} belongs to runtime ${node.runtime_id}, not Codex. Original binding retained.`);
      }
      threadId = this.resumeTokenFromBinding(node);
      nodeWorkspaceId = node?.workspace_id ?? null;
      if (!threadId) {
        throw new CodexSessionNotResumableError(
          `Node ${publicId} has no native session binding - cannot resume codex session`,
        );
      }
    }

    await this.startClient();

    let modelId = opts.model ?? this.host.config.defaultModel(this.id);
    if (!modelId) {
      const models = await this.listModels();
      const def = models.find((m) => m.isDefault);
      modelId = def?.id ?? '';
    }

    const effort = opts.reasoning !== undefined ? opts.reasoning : this.host.config.defaultReasoning(this.id, opts.ownerUserId) ?? null;

    const session = new CodexSession({
      nodeId: publicId,
      threadId,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? nodeWorkspaceId ?? null,
      client: this.client,
      host: this.host,
      mcpRegistry: this.mcpRegistry,
      bridge: this.bridge,
      ownerUserId: opts.ownerUserId ?? null,
      effort: effort ? String(effort) : null,
      model: modelId || null,
      enableFollowUps: opts.enableFollowUps !== false && !this.host.profile.isRestricted(opts.toolProfile),
      approveTimeoutMs: this.approveTimeoutMs,
      titleTimeoutMs: this.titleDeadlineMs,
      hostText: this.hostText,
      owner,
      profileHash: opts.profileHash,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      recover: (s) => this.recoverSession(s),
      skillInput: (skill, cwd) => this.skillInputFor(skill, cwd),
    });

    const slotId = session.createMcpSlot();

    // Resume the thread
    try {
      await this.openThread(session, slotId, opts.cwd, (config) => this.client.request('thread/resume', {
        threadId,
        model: modelId || undefined,
        cwd: opts.cwd,
        developerInstructions: this.buildDeveloperInstructions(session.enableFollowUps, owner, opts.toolProfile),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: codexThreadSandbox(this.host.profile.isRestricted(opts.toolProfile)),
        config,
        ...(effort ? { reasoningEffort: String(effort) } : {}),
      }) as Promise<Record<string, unknown>>, (resumeResult) => {
        // Validate that the server echoed back the same threadId
        const resumeThread = resumeResult['thread'] as Record<string, unknown> | undefined;
        const echoedThreadId = (resumeThread?.['id'] as string | undefined) ?? (resumeResult['threadId'] as string | undefined);
        if (echoedThreadId !== threadId) throw new Error('Codex native resume returned a different thread identity');
        // Rebind in case the threadId came back different (treat original as canonical)
        (session as any).threadId = threadId;
        // Codex keeps a thread's last collaboration mode; a resumed Plan thread stays in Plan.
        const resumedMode = (resumeResult['collaborationMode'] as { mode?: unknown } | null | undefined)?.mode;
        if (resumedMode === 'plan') session.currentModeId = resumedMode;
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      await session.dispose();
      if ((err instanceof CodexRpcError ? err.rpcMessage : msg) === `no rollout found for thread id ${threadId}`) {
        throw new CodexSessionNotResumableError(
          `codex thread/resume failed: ${msg}`,
        );
      }
      throw err;
    }
    await this.disableResumedThreadMemory(session);

    session.wireNotifications();

    this.sessions.set(publicId, session);
    this.threadToSession.set(threadId, session);
    this.host.sessions.registerSession(session, opts.ownerUserId, owner);

    return session;
  }

  private async recoverSession(session: CodexSession): Promise<void> {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error(RECOVERY_TIMEOUT_MESSAGE);
      return ms;
    };
    while (this.recovery) {
      await withDeadline(this.recovery.catch(() => {}), remaining(), RECOVERY_TIMEOUT_MESSAGE);
    }
    remaining();
    if (!session.needsRecovery()) return;
    const assertRegistered = () => {
      if (this.sessions.get(session.id) !== session) throw new Error('Codex session was released during recovery');
    };
    // Reserve ownership before any recovery work can yield or call external code.
    const work = Promise.resolve().then(async () => {
      assertRegistered();
      let replacedDaemon = this.daemonDisconnected || !this.client.isRunning();
      if (session.requiresRestart && this.client.isRunning() && !this.daemonDisconnected) {
        const unhealthy = new Set([...this.sessions.values()].filter((s) => s.needsRecovery()).map((s) => s.threadId));
        if (this.pendingSessions.size || [...this.sessions.values()].some((s) => s !== session && s.isBusy()) || this.client.hasPendingRequests(unhealthy)) {
          throw new Error('Codex recovery is waiting for other tasks to finish. Their work was not interrupted; retry this message afterward.');
        }
        // Ephemeral sessions run on app-servers of their own, which keep running.
        for (const peer of this.sessions.values()) {
          if (!this.ephemeralServers.has(peer.id)) peer.markCrashed('Codex connection is restarting; native threads retained.');
        }
        this.skillsDaemonStopped();
        await this.client.shutdown();
        // shutdown only succeeds after exit is confirmed. Every old native turn
        // is now stopped, even though each peer still needs its own thread resume.
        for (const peer of this.sessions.values()) peer.requiresRestart = false;
        replacedDaemon = true;
      }
      await this.startClient(remaining());
      remaining();
      if (replacedDaemon) {
        for (const peer of this.sessions.values()) {
          if (peer.needsRecovery()) peer.requiresRestart = false;
        }
        this.daemonDisconnected = false;
      }
      assertRegistered();
      const slotId = await session.prepareNativeResume();
      await this.openThread(session, slotId, session.cwd, (config) => this.client.request('thread/resume', {
        threadId: session.threadId, cwd: session.cwd,
        model: session.currentModelId || undefined,
        developerInstructions: this.buildDeveloperInstructions(session.enableFollowUps, session.owner, session.metaAgentToolProfile),
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: codexThreadSandbox(session.isAssistant),
        config,
        ...(session.effort ? { reasoningEffort: session.effort } : {}),
      }, remaining()) as Promise<{ thread?: { id?: string }; threadId?: string }>, (result) => {
        if ((result.thread?.id ?? result.threadId) !== session.threadId) throw new Error('Codex native recovery returned a different thread identity. Original binding retained.');
      });
      await this.disableResumedThreadMemory(session, Math.min(5_000, remaining()));
      remaining();
      assertRegistered();
      session.completeNativeResume();
    });
    this.recovery = work;
    // A caller can time out without releasing another operation's native work.
    // Later callers still have bounded waits, and late work checks its deadline.
    void work.finally(() => { if (this.recovery === work) this.recovery = null; }).catch(() => {});
    await withDeadline(work, remaining(), RECOVERY_TIMEOUT_MESSAGE);
  }

  private buildDeveloperInstructions(enableFollowUps: boolean, owner: RuntimeSessionOwner, toolProfile?: RuntimeToolProfile | null): string {
    // Run workers keep their Executor-owned tool profile and metadata behavior.
    // The profile goes along so the host's tool notes name only the tools the Run has.
    if (ownerMode(owner) === 'headless') {
      return this.host.prompt.stableSystemPrompt(
        this.host.prompt.followUpsMetadataOutputMode(false, 'sentinel'),
        enableFollowUps,
        undefined,
        undefined,
        toolProfile ?? undefined,
      );
    }
    const assistant = this.host.profile.isRestricted(toolProfile) || toolProfile?.assistant === true;
    // A restricted session gets the host's short tool note for its profile.
    return this.host.prompt.stableSystemPrompt(CODEX_METADATA_OUTPUT_MODE, enableFollowUps, false, assistant, toolProfile ?? undefined)
      + (assistant ? '' : this.hostText?.turnMetadataInstruction?.('sentinel', enableFollowUps) ?? '');
  }

  private buildThreadConfig(slotId: string, nativeMemory: boolean): Record<string, unknown> {
    return {
      ...buildCodexMcpConfig(this.mcpRegistry.endpoint(slotId)),
      features: { ...CODEX_THREAD_FEATURES_OFF },
      ...(nativeMemory ? {} : { memories: { ...CODEX_MEMORIES_OFF } }),
    };
  }

  /**
   * A resumed thread keeps the memory mode it was started with whatever its
   * config says (CODEX_MEMORIES_OFF), so a session that keeps no native memory
   * sets it off. Best effort: app-servers before codex 0.167 lack the method.
   */
  private async disableResumedThreadMemory(session: CodexSession, timeoutMs = 5_000): Promise<void> {
    if (session.keepsNativeMemory()) return;
    try {
      await this.client.request('thread/memoryMode/set', { threadId: session.threadId, mode: 'disabled' }, timeoutMs);
    } catch (error) {
      this.host.observability.log('warn', 'chat', 'codex kept the resumed thread\'s own memory mode', {
        nodeId: session.id, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Starts or resumes a thread through `open`, with this session's thread
   * config, and has `bind` check the answer and bind the thread id. Every
   * thread disables the MCP servers of the user's effective config
   * (config/read for the cwd) by name, keeping only the host's; spec §2
   * meant `-c mcp_servers={}` to do this, but codex 0.165 merges that empty
   * table instead. For an ordinary session this is best effort: a server
   * still open afterwards (mcpServerStatus/list) is logged, not refused.
   * A restricted session (the Michi assistant) also turns off Codex's
   * shell, plugins, sub-agents and other tools (codexRestrictedThreadConfig);
   * then the thread's own MCP server list must show only the host's enabled
   * (codexRestrictedMcpCheck). A server config/read did not report is
   * disabled on one more try (a new open); anything else fails closed.
   */
  private async openThread<T>(
    session: CodexSession,
    slotId: string,
    cwd: string,
    open: (config: Record<string, unknown>) => Promise<T>,
    bind: (result: T) => void,
    client: CodexAppServerClient = this.client,
  ): Promise<void> {
    const base = this.buildThreadConfig(slotId, session.keepsNativeMemory());
    const profile = session.metaAgentToolProfile;
    const toolset = this.host.profile.toolset?.(profile) ?? 'restricted';
    if (!session.isAssistant) {
      await this.openIsolatedThread(session, cwd, base, open, bind, client);
      return;
    }
    const disable = codexConfiguredMcpServers(await client.request('config/read', { cwd }));
    session.userMcpServers = [...disable];
    const refused = (stillOpen: string[], detail: string) => guardError(this.host, {
      runtimeId: this.id, toolset, unexpectedTools: stillOpen.map((name) => `mcp_server:${name}`), detail,
    });
    let retried: string[] = [];
    let subagentLimit = this.restrictedSubagentLimit;
    for (let attempt = 1; ; attempt += 1) {
      let opened: T;
      try {
        opened = await open(restrictedConfig(codexRestrictedThreadConfig(base, disable), subagentLimit));
      } catch (error) {
        // An app-server that rejects the multi_agent_v2 table gets the plain
        // switch; CodexSession still stops any child that starts.
        if (subagentLimit && error instanceof CodexRpcError && /multi_agent_v2/.test(error.rpcMessage)) {
          this.host.observability.log('warn', 'chat', 'codex rejected the restricted sub-agent limit; relying on the session\'s spawn guard', {
            nodeId: session.id, error: error.rpcMessage,
          });
          subagentLimit = false;
          attempt -= 1;
          continue;
        }
        // Codex turns off only servers its config defines (one a plugin adds has no transport to name).
        if (retried.length === 0) throw error;
        throw refused(retried, `Codex would not turn off ${retried.join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
      }
      bind(opened);
      const statuses = await this.threadMcpServers(session.threadId, client);
      const check = codexRestrictedMcpCheck(statuses);
      if (check.ok) {
        assertToolCatalog(this.host, {
          runtimeId: this.id, profile, observed: codexMetaAgentCatalog(statuses ?? []), extraAllowed: CODEX_META_AGENT_UNREMOVABLE_TOOLS,
        });
        return;
      }
      const fresh = check.open.filter((name) => !disable.includes(name));
      if (check.fatal || attempt >= 2 || fresh.length === 0) throw refused(check.open, check.reason);
      // Let this thread go; the next open disables those servers too.
      await client.request('thread/unsubscribe', { threadId: session.threadId }, 2_000).catch(() => {});
      disable.push(...fresh);
      session.userMcpServers = [...disable];
      retried = fresh;
    }
  }

  /**
   * An ordinary session's open: the user's MCP servers disabled by name. Each
   * step only warns when it fails. Codex refusing that configuration (a
   * definite JSON-RPC configuration error, never a timeout) opens the thread
   * without it.
   */
  private async openIsolatedThread<T>(
    session: CodexSession,
    cwd: string,
    base: Record<string, unknown>,
    open: (config: Record<string, unknown>) => Promise<T>,
    bind: (result: T) => void,
    client: CodexAppServerClient = this.client,
  ): Promise<void> {
    const warn = (msg: string, data: Record<string, unknown>) =>
      this.host.observability.log('warn', 'chat', msg, { nodeId: session.id, cwd, ...data });
    let disable: string[] = [];
    try {
      disable = codexConfiguredMcpServers(await client.request('config/read', { cwd }));
    } catch (error) {
      warn('codex config/read failed; the user\'s MCP servers stay enabled in this thread', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let opened: T;
    try {
      opened = await open(codexDisableMcpServers(base, disable));
    } catch (error) {
      if (!(error instanceof CodexRpcError) || !/configuration|mcp_servers/i.test(error.rpcMessage)
        || codexDisableMcpServers(base, disable) === base) throw error;
      warn('codex refused the thread config that disables the user\'s MCP servers; opening the thread with them', {
        servers: disable, error: error.rpcMessage,
      });
      disable = [];
      opened = await open(base);
    }
    bind(opened);
    session.userMcpServers = disable;
    try {
      const statuses = await this.threadMcpServers(session.threadId, client);
      const stillOpen = statuses ? codexOpenUserMcpServers(statuses) : [];
      if (stillOpen.length > 0) {
        warn('codex thread still runs MCP servers outside Michi', { threadId: session.threadId, servers: stillOpen });
      }
    } catch (error) {
      warn('codex mcpServerStatus/list failed; could not check the thread\'s MCP servers', {
        threadId: session.threadId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The thread's MCP servers as mcpServerStatus/list reports them; null when it answers without a list. */
  private async threadMcpServers(
    threadId: string, client: CodexAppServerClient = this.client,
  ): Promise<Array<{ name?: unknown; runtimeStatus?: unknown; tools?: unknown }> | null> {
    const statuses: Array<{ name?: unknown; runtimeStatus?: unknown; tools?: unknown }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.request('mcpServerStatus/list', {
        threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}),
      }) as { data?: unknown; nextCursor?: unknown } | undefined;
      if (!Array.isArray(result?.data)) return null;
      statuses.push(...result.data as Array<{ name?: unknown; runtimeStatus?: unknown; tools?: unknown }>);
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) return statuses;
    }
    return null;
  }

  private async releaseIdleSessions(): Promise<void> {
    if (this.recovery) return;
    const now = Date.now();
    const releases: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      // Agent Runs own their lifecycle through the Executor. Chat bindings stay
      // persisted; the next message resumes the original native thread.
      if (ownerMode(session.owner) !== 'interactive' || this.pendingSessions.has(session.id)) continue;
      // A background child still runs, or its completion waits for the next
      // turn: releasing would stop listening to it and lose its outcome. Kept
      // until its children have been quiet for CODEX_BACKGROUND_IDLE_TTL_MS,
      // and at most CODEX_BACKGROUND_IDLE_CAP_MS, so a child that never
      // reports cannot hold the session forever.
      const expired = session.hasBackgroundWork()
        ? session.isBackgroundIdleExpired(now, CODEX_BACKGROUND_IDLE_TTL_MS, CODEX_BACKGROUND_IDLE_CAP_MS)
        : session.isIdleExpired(now, CODEX_IDLE_TTL_MS);
      if (expired) {
        // The release barrier prevents acquisition from reusing a session
        // while native unsubscribe and MCP cleanup are still pending.
        releases.push(this.releaseSession(session.id));
      }
    }
    await Promise.all(releases);
  }

  // ---- releaseSession ------------------------------------------------------

  /**
   * Release a live Codex session. When `expectedOwner` is provided, ownership
   * is verified first — a stale Attempt cannot release a session that has been
   * rebound to a different owner.
   */
  async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    return this.pendingSessions.release(sessionId, () => this.disposeSession(sessionId, expectedOwner));
  }

  private async disposeSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.releasingSessions.get(sessionId);
      return;
    }

    // Ownership guard: reject if expectedOwner doesn't match.
    if (expectedOwner) {
      assertReleaseOwnership(session.owner, expectedOwner);
    }

    const threadId = session.threadId;
    this.sessions.delete(sessionId);
    if (threadId) this.threadToSession.delete(threadId);
    this.host.sessions.dropSession(sessionId);
    // A subsequent resume must wait for the old thread/unsubscribe and MCP
    // cleanup, otherwise that cleanup can detach the newly resumed thread.
    const releasing = session.dispose().finally(() => this.closeEphemeralServer(sessionId));
    this.releasingSessions.set(sessionId, releasing);
    try { await releasing; } finally { this.releasingSessions.delete(sessionId); }
  }

  // ---- ephemeral sessions ---------------------------------------------------

  /**
   * Starts the app-server of an ephemeral session on a new Codex home
   * (codexEphemeralHome.ts): the user's auth.json linked in, and the model
   * and provider keys of the user's effective config (the main app-server's
   * config/read for this cwd) as its config.toml. Its exit crashes only that
   * session, which is then not restored.
   */
  private async openEphemeralServer(publicId: string, cwd: string): Promise<CodexAppServerClient> {
    const setup = this.ephemeralSetup;
    const read = await this.client.request('config/read', { cwd });
    const home = prepareCodexEphemeralHome({
      root: setup.root, sessionId: publicId, codexHome: setup.codexHome, configToml: codexEphemeralConfigToml(read),
    });
    const client = setup.client?.(home, CODEX_EPHEMERAL_APP_SERVER_ARGS) ?? new CodexAppServerClient({
      spawnEnv: { ...setup.spawnEnv, CODEX_HOME: home },
      binaryPath: this.binaryPath,
      rpcTimeoutMs: setup.rpcTimeoutMs,
      initTimeoutMs: setup.initTimeoutMs,
      extraArgs: CODEX_EPHEMERAL_APP_SERVER_ARGS,
    });
    this.wireServerRequests(client);
    client.onExit(() => {
      if (this.ephemeralServers.get(publicId)?.client !== client) return;
      this.sessions.get(publicId)?.markCrashed('This Codex session\'s app-server exited; it keeps no native record and is not restored.');
    });
    this.ephemeralServers.set(publicId, { client, home });
    try {
      await client.ensureStarted();
    } catch (error) {
      await this.closeEphemeralServer(publicId);
      throw error;
    }
    return client;
  }

  /** Stops an ephemeral session's app-server; its home stays until discardNativeSession. */
  private async closeEphemeralServer(publicId: string): Promise<void> {
    const server = this.ephemeralServers.get(publicId);
    if (!server) return;
    this.ephemeralServers.delete(publicId);
    await server.client.shutdown().catch((error: unknown) => {
      this.host.observability.log('warn', 'chat', 'codex ephemeral app-server did not stop cleanly', {
        sessionId: publicId, error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Removes a released session's native record (DESIGN-v2 §3.2): its
   * ephemeral home, and with it everything its app-server wrote. Without a
   * home, a native id the main app-server persisted is deleted there with
   * `thread/delete` (rollout and state rows; P3), and an id it does not have
   * answers `absent`. `deferred` while the session is live or opening.
   */
  async discardNativeSession(input: NativeSessionDiscardInput): Promise<NativeSessionDiscardResult> {
    if (this.sessions.has(input.sessionId) || this.pendingSessions.has(input.sessionId) || this.releasingSessions.has(input.sessionId)) {
      return 'deferred';
    }
    await this.closeEphemeralServer(input.sessionId);
    if (removeCodexEphemeralHome(this.ephemeralSetup.root, input.sessionId)) return 'discarded';
    if (!input.nativeSessionId) return 'absent';
    await this.startClient();
    try {
      await this.client.request('thread/delete', { threadId: input.nativeSessionId });
      return 'discarded';
    } catch (error) {
      const message = error instanceof CodexRpcError ? error.rpcMessage : '';
      if (/^no rollout found for thread id|^thread is not persisted/.test(message)) return 'absent';
      throw error;
    }
  }

  // ---- listModels ----------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCatalog.cached) {
      void this.refreshModels().catch((err: unknown) => {
        console.warn('[CodexRuntime] model refresh failed; using cached catalog:', (err as Error).message);
      });
      return this.modelCatalog.cached;
    }
    return this.refreshModels();
  }

  /**
   * Cheap model for the pre-turn title thread. Only returned when the account's
   * catalog actually lists it, otherwise the title thread stays on the
   * session's own model rather than failing on an unknown model id.
   */
  private async resolveTitleModel(): Promise<string | null> {
    const configured = this.host.config.titleModel(this.id).model;
    if (!configured) return null;
    try {
      const models = await this.listModels();
      return models.some((m) => m.id === configured) ? configured : null;
    } catch {
      return null;
    }
  }

  async refreshModels(): Promise<ModelInfo[]> {
    return this.modelCatalog.refresh();
  }

  // ---- completeStructured ----------------------------------------------------

  /**
   * One structured answer on an ephemeral thread (codexStructured.ts), in a
   * neutral folder, with the user's MCP servers, Codex's memories, its tools
   * and its instruction blocks off and a short base prompt
   * (codexProtocol.CODEX_STRUCTURED_*). Without a model named: the title
   * model when the account lists it, else the user's default.
   */
  async completeStructured(opts: StructuredCompletionOptions): Promise<StructuredCompletion> {
    opts.signal?.throwIfAborted();
    await this.startClient();
    const cwd = path.join(this.host.config.dataDir(), 'structured-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const model = opts.model?.trim() || await this.resolveTitleModel() || this.host.config.defaultModel(this.id, opts.ownerUserId) || null;
    let disable: string[] = [];
    try {
      disable = codexConfiguredMcpServers(await this.client.request('config/read', { cwd }));
    } catch (error) {
      this.host.observability.log('warn', 'chat', 'codex config/read failed; a structured answer keeps the user\'s MCP servers configured', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const effort = opts.reasoning && (CODEX_CAPABILITIES.supportedReasoningLevels as readonly string[] | undefined)?.includes(opts.reasoning)
      ? opts.reasoning : 'low';
    return completeCodexStructured({
      client: this.client, cwd, model, system: opts.system, prompt: opts.prompt, schema: opts.schema, effort,
      baseInstructions: CODEX_STRUCTURED_BASE_INSTRUCTIONS,
      config: codexDisableMcpServers({
        ...CODEX_STRUCTURED_CONFIG_OFF, features: { ...CODEX_STRUCTURED_FEATURES_OFF }, memories: { ...CODEX_MEMORIES_OFF },
      }, disable),
      timeoutMs: opts.timeoutMs, signal: opts.signal,
    });
  }

  // ---- shutdown ------------------------------------------------------------

  async shutdown(): Promise<void> {
    clearInterval(this.idleSweep);
    this.unsubscribeSkillRoots?.();
    this.unwatchSkills?.();
    this.unwatchSkills = null;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      await this.releaseSession(session.id);
    }
    await Promise.all(this.releasingSessions.values());
    await Promise.all([...this.ephemeralServers.keys()].map((id) => this.closeEphemeralServer(id)));
    this.skillsDaemonStopped();
    await this.client.shutdown();
  }

  // ---- User input handler ---------------------------------------------------

  private handleUserInputRequest(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    signal?: AbortSignal,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    const session = threadId ? this.threadToSession.get(threadId) : null;
    if (!session || !session.acceptsControl(params)) {
      respond({ answers: {} });
      return;
    }
    // A restricted session's thread has Codex's question tool off
    // (CODEX_RESTRICTED_TOOLS_OFF). One that asks anyway gets no answers and
    // shows no question, as its elicitations are declined: its turns may run
    // with no one to answer, and the question's wording is the model's.
    if (session.isMetaAgent) {
      this.host.observability.log('warn', 'chat', 'codex restricted session asked the user a question; answered with none', {
        nodeId: session.id, threadId,
      });
      respond({ answers: {} });
      return;
    }
    void session.askUserInput(params, respond, signal);
  }

  private handleMcpElicitationRequest(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    signal?: AbortSignal,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    const session = threadId ? this.threadToSession.get(threadId) : null;
    // The Meta agent's own tools never elicit; anything else is declined.
    if (!session || !session.acceptsControl(params) || session.isMetaAgent) {
      respond({ action: 'decline', content: null, _meta: null });
      return;
    }
    void session.askMcpElicitation(params, respond, signal);
  }

  // ---- Approval handler ----------------------------------------------------

  private handleApprovalRequest(
    method: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    signal?: AbortSignal,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    const session = threadId ? this.threadToSession.get(threadId) : null;
    if (!session || !session.acceptsControl(params)) { respond({ decision: 'decline' }); return; }

    // The Michi assistant never runs a command or changes a file, whatever the chat's mode.
    if (session.isAssistant) { respond({ decision: 'decline' }); return; }

    // The session decides, once. A headless owner (Agent Run) delegates to its
    // permission broker and MUST NOT consult the chat policy or write a chat
    // grant; an ordinary chat decides with the turn's mode and its own user's
    // revocable chat grants, and asks the user when they do not cover the
    // request. Only methods in CODEX_APPROVAL_ALIASES reach here.
    void session.askPermission(method, params, respond, signal);
  }
}
