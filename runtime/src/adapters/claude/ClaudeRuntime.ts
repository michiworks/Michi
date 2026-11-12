import { hostSkillsPrefix } from '../../core/skills';
import { RuntimeModelCatalog } from '../../core/modelCatalog';
import type { AgentCommand } from 'michi-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as claudeProjectsPath from './claudeProjectsPath';
import { getClaudeJsonlPath } from './claudeProjectsPath';
import type {
  AgentCapabilities,
  AgentRuntime,
  AgentSession,
  ForkAgentSessionOptions,
  GenerateTitleOptions,
  ListRuntimeSkillsOptions,
  LoadAgentSessionOptions,
  ModelInfo,
  NativeSessionDiscardInput,
  NativeSessionDiscardResult,
  NewAgentSessionOptions,
  RuntimeAvailability,
  RuntimeResumeBinding,
  RuntimeSessionOwner,
  RuntimeId,
  RuntimeSkillListing,
  SessionMode,
  StructuredCompletion,
  StructuredCompletionOptions,
} from '../../contract/types';
import type { AgentToolBridge } from '../../contract/tools';
import type { McpSlotProvider } from '../../contract/mcp';
import { ownerMode, type BackgroundTurnConsumer, type RuntimeHost } from '../../contract/host';
import { sessionIdentity } from '../../core/sessionAcquisition';
import { assertHostPorts } from '../../core/defaultHost';
import type { ClaudeAdapterOptions, ClaudeModelCatalogOptions } from './claudeAdapterOptions';
import { CLAUDE_MODEL_CATALOG, resolveClaudeCliModelId, setDiscoveredClaudeModels } from './claudeModelCatalog';
import { probeClaudeModels } from './claudeModelProbe';
import { findClaudeBinary, preflightClaudeAuth } from './claudeBinary';
import { ClaudeSessionManager, ClaudeConcurrencyError } from './ClaudeSessionManager';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import { CLAUDE_RUNTIME_DESCRIPTOR } from './claudeDescriptor';
import { CLAUDE_MODES } from './claudeModes';
import { NativeResumeUnavailableError } from '../../contract/errors';
import { forkClaudeHistory } from './claudeSdkHistory';
import { cheapClaudeModel, completeClaudeStructured } from './claudeStructured';
import { normalizeWorkspaceCwd } from '../../core/pathSandbox';
import { abortable } from '../../core/runtimeLifecycle';
import { listClaudeSkills } from './claudeSkillProbe';
import { claudeHostCommands } from './claudeSkills';
import * as claudeTitles from './claudeTitleGenerator';

// ---- Errors ------------------------------------------------------------------

export { ClaudeConcurrencyError };

export class ClaudeSessionNotResumableError extends NativeResumeUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSessionNotResumableError';
  }
}

// ---- Capabilities ------------------------------------------------------------

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  // Work modes for chats: Default and Plan (claudeModes.ts).
  modes: true,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  // claude --effort accepts: low | medium | high | xhigh | max
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  apiKeys: false,
  warmSessions: true,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
  // Applied in place (flag settings), so it is not a native resume setting.
  ultracode: true,
};

// ---- ClaudeRuntime -----------------------------------------------------------

export type { ClaudeAdapterOptions, ClaudeModelCatalogOptions };

/** What ClaudeRuntime is built from: the adapter's options plus the host's tool effects and MCP slots. */
export interface ClaudeRuntimeOptions extends ClaudeAdapterOptions {
  /** Business effects of the host's tools (spawn branches, save/update artifacts, Agent Run tools). */
  bridge: AgentToolBridge;
  /** The host's MCP slots; every Claude session's host tools go through them. */
  mcpSlots: McpSlotProvider;
}

/** Every host port the Claude adapter calls. */
const CLAUDE_HOST_PORTS = [
  'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title',
  'backgroundTurns', 'workflows', 'backgroundSubagents',
] as const;

export class ClaudeRuntime implements AgentRuntime {
  public readonly id: RuntimeId = 'claude';
  public readonly label = 'Claude';
  public readonly capabilities = CLAUDE_CAPABILITIES;
  public readonly descriptor: RuntimeDescriptor = CLAUDE_RUNTIME_DESCRIPTOR;

  private readonly manager: ClaudeSessionManager;
  /** Stops following the host's default model (host.config.onDefaultModelChanged). */
  private readonly unsubscribeDefaultModel: () => void;
  /** Auth pre-flight failure from construction, surfaced by checkAvailability. */
  private authError: string | undefined;
  private readonly modelCatalog?: RuntimeModelCatalog;
  /** Never start another expensive CLI probe merely because a picker reopened. */
  private listProbeAttempted = false;
  /** Each listing starts a CLI (claudeSkillProbe): the one running per folder and profile, shared. */
  private readonly skillProbes = new Map<string, Promise<RuntimeSkillListing>>();
  /** Sidebar titles; with the warm pool on, it keeps one started title CLI. */
  private readonly titles: claudeTitles.ClaudeTitleGenerator;

  /**
   * Both halves of Claude's readiness were already computed and then discarded:
   * the binary lookup throws ClaudeBinaryNotFoundError, and the auth pre-flight
   * result went to console.warn. Report them instead of hardcoding available.
   * findClaudeBinary caches internally, so this stays cheap per status poll.
   */
  checkAvailability(): RuntimeAvailability {
    try {
      findClaudeBinary(this.options.binaryPath());
    } catch (err) {
      return { available: false, detail: (err as Error).message };
    }
    if (this.authError) return { available: false, detail: this.authError };
    return { available: true };
  }

  private readonly host: RuntimeHost;
  private readonly options: ClaudeAdapterOptions;
  /** The host's owner of self-started turns, also asked by the native fork guard (asserted present). */
  private readonly backgroundTurns: BackgroundTurnConsumer;

  constructor(options: ClaudeRuntimeOptions) {
    // tsc cannot see untyped (JS or require'd) callers of the old positional
    // form, nor members left undefined.
    if (typeof options !== 'object' || options === null || options.host == null || options.bridge == null || options.mcpSlots == null) {
      throw new TypeError('ClaudeRuntime takes one options object { host, bridge, mcpSlots, … } (runtime contract v1)');
    }
    const { bridge, mcpSlots: mcpRegistry } = options;
    // Besides the mandatory ports: self-turns and the native fork guard need
    // backgroundTurns (without it the guard would pass every fork); the
    // workflow tap and background subagents report to their sinks.
    assertHostPorts(options.host, CLAUDE_HOST_PORTS, 'ClaudeRuntime');
    this.host = options.host;
    this.options = options;
    this.backgroundTurns = options.host.backgroundTurns!;
    const modelCatalog = options.modelCatalog;
    if (modelCatalog) {
      this.modelCatalog = new RuntimeModelCatalog({
        initial: modelCatalog.cache?.load(this.id),
        probe: modelCatalog.probe ?? (() => probeClaudeModels(this.options)),
        normalize: (models) => models,
        persist: (models) => modelCatalog.cache?.save(this.id, models),
        onUpdate: setDiscoveredClaudeModels,
        fallback: staticClaudeModels,
      });
    }
    const { maxConcurrent: concurrencyCap, pool } = options.limits;
    // Pre-flight auth check at construction — fail fast if credentials are absent
    // rather than letting the first spawn hang on a stdin auth prompt. The
    // result is also retained (it used to be discarded into console.warn) so
    // checkAvailability can report it instead of claiming the runtime is ready.
    try {
      preflightClaudeAuth(options.configDir?.(), options.spawnEnv());
    } catch (err) {
      this.authError = (err as Error).message;
      console.warn('[ClaudeRuntime] Auth pre-flight warning:', this.authError);
    }

    this.manager = new ClaudeSessionManager({
      bridge,
      mcpRegistry,
      options,
      concurrencyCap,
      currentModel: this.host.config.defaultModel(this.id),
      poolDisabled: pool.disabled,
      waitForWarm: pool.waitForWarm,
      sessionsPerSlot: pool.sessionsPerCwd,
      onSelfTurn: (info) => this.backgroundTurns.consume(info),
    });
    this.titles = new claudeTitles.ClaudeTitleGenerator({ config: options, spare: !pool.disabled });

    // Keep the pool's model_set aligned with the user's global model choice.
    this.unsubscribeDefaultModel = this.host.config.onDefaultModelChanged((evt) => {
      if (evt.runtime !== 'claude') return;
      void this.manager.notifyModelChange(evt.model);
    });
  }

  async warm(cwd: string, opts?: { model?: string | null }): Promise<void> {
    try {
      await this.manager.warm(cwd, opts?.model ?? this.host.config.defaultModel(this.id));
    } finally {
      // After the chat's own process, so the two starts do not compete.
      const title = this.titleModel();
      if (title) this.titles.warm(title.model);
    }
  }

  async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
    return this.createSession(opts);
  }

  resumeTokenFromBinding(binding: RuntimeResumeBinding | null | undefined): string | null {
    return ClaudeRuntime.resumeTokenFromBinding(binding);
  }

  /**
   * Claude's native session id in a stored binding: external_session_id, else
   * the legacy ACP column. Claude has no native identity until init; the
   * node's own id, the placeholder that occupies the ACP column until then,
   * is not a resumable CLI session.
   */
  static resumeTokenFromBinding(binding: RuntimeResumeBinding | null | undefined): string | null {
    const id = binding?.external_session_id ?? binding?.acp_session_id ?? null;
    return id === binding?.id ? null : id;
  }

  async forkSession(opts: ForkAgentSessionOptions): Promise<AgentSession> {
    if (opts.ephemeral) throw new NativeResumeUnavailableError('An ephemeral Claude session is never forked');
    if (!opts.sessionId || !opts.parentChatId || (opts.owner && ownerMode(opts.owner) === 'headless')) {
      throw new NativeResumeUnavailableError('Only chat children can inherit Claude native history');
    }
    // Cloud history helpers currently namespace by owner, while the CLI's
    // native resume still reads its ordinary project directory. Until those
    // layouts are aligned, use the caller's exact text fallback rather than
    // publishing a child native identity the CLI cannot actually restore.
    if (this.host.principal.enforceUserOwnership()) {
      throw new NativeResumeUnavailableError('Claude cloud native fork is unavailable');
    }
    // An assistant conversation's native history stays with the assistant's
    // lockdown: never forked into an ordinary chat, nor an ordinary chat's
    // into the assistant (assistant/policy.ts).
    if (this.host.profile.isRestricted(opts.toolProfile) || this.host.profile.isRestrictedWorkspace(opts.workspaceId)) {
      throw new NativeResumeUnavailableError('The Michi assistant does not fork native Claude history');
    }
    const { owner } = sessionIdentity(opts.owner, opts.sessionId);
    await this.manager.waitForRelease(opts.sessionId);
    const existing = this.manager.getCompatible(opts.sessionId, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;
    const parent = this.host.bindings.nodeBinding(opts.parentChatId);
    const child = this.host.bindings.nodeBinding(opts.sessionId);
    const workspace = parent ? this.host.bindings.workspace(parent.workspace_id) : undefined;
    if (!parent || !child || ownerMode(owner) !== 'interactive' || owner.key !== child.id
      || child.parent_node_id !== parent.id || child.id === parent.id
      || parent.kind !== 'chat' || child.kind !== 'chat' || parent.runtime_id !== 'claude'
      || parent.workspace_id !== child.workspace_id || parent.tree_id !== child.tree_id
      || parent.workspace_id !== opts.workspaceId || this.host.profile.isRestrictedWorkspace(parent.workspace_id)
      || parent.deleted_at || parent.purged_at
      || child.deleted_at || child.purged_at || this.resumeTokenFromBinding(parent) !== opts.sourceNativeSessionId
      || !workspace || workspace.deleted_at || workspace.archived_at
      || !this.host.principal.workspaceOwnerMatches(workspace.owner_user_id ?? null, this.host.principal.resolve(opts.ownerUserId))
      || normalizeWorkspaceCwd(workspace.cwd ?? process.cwd()) !== normalizeWorkspaceCwd(opts.cwd)
      || parent.status === 'streaming' || this.backgroundTurns.isActive(parent.id)
      || this.backgroundTurns.isOwnerTurnActive(parent.id) || this.backgroundTurns.hasPendingSelfTurn(parent.id)) {
      throw new NativeResumeUnavailableError('Claude parent history is not available to this child');
    }
    if (opts.anchorMessageId) {
      const nativeMessageId = this.host.bindings.forkAnchors.readClaudeForkAnchor({
        nodeId: opts.parentChatId, nativeSessionId: opts.sourceNativeSessionId,
        messageId: opts.anchorMessageId, workspaceId: opts.workspaceId, ownerUserId: opts.ownerUserId,
      });
      if (!nativeMessageId) {
        throw new NativeResumeUnavailableError('No native Claude anchor for the selected historical message');
      }
      const forkId = await forkClaudeHistory(this.options, {
        cwd: opts.cwd, sourceNativeSessionId: opts.sourceNativeSessionId,
        nativeMessageId, ownerUserId: opts.ownerUserId,
      });
      return this.createSession({ ...opts, branchContext: undefined }, undefined, forkId);
    }
    const file = getClaudeJsonlPath(this.options, opts.cwd, opts.sourceNativeSessionId, opts.ownerUserId);
    if (!fs.existsSync(file)) throw new NativeResumeUnavailableError('Claude parent session file is unavailable');
    return this.createSession({ ...opts, branchContext: undefined }, opts.sourceNativeSessionId);
  }

  private async createSession(opts: NewAgentSessionOptions, forkFrom?: string, resumeFrom?: string): Promise<AgentSession> {
    const { owner, id } = sessionIdentity(opts.owner, opts.sessionId);

    // Invariant 9: double-load guard
    await this.manager.waitForRelease(id);
    const existing = this.manager.getCompatible(id, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;

    const cwd = opts.cwd;

    // Ancestor chain is needed by the per-chat preamble regardless of warm
    // hit vs cold spawn — except when the server resolved an exact branch
    // prefix, which must replace the live chain rather than duplicate it.
    const ancestorChain: AgentSession[] = [];
    if (!forkFrom && !resumeFrom && !opts.branchContext && ownerMode(owner) === 'interactive' && opts.parentChatId) {
      this.host.sessions.ensureAncestorChainLoaded(opts.parentChatId);
      const parent = this.host.sessions.getSession(opts.parentChatId);
      if (parent) {
        ancestorChain.push(...this.host.sessions.getAncestors(opts.parentChatId), parent);
      }
    }

    // Per-chat preamble is prepended to the first real user message by
    // ClaudeSession.send(). This is what carries cwd files, ancestor history,
    // merged contexts.
    const workspaceInstructions = opts.workspaceId && !this.host.profile.isMaintenance?.(opts.toolProfile)
      ? this.host.prompt.workspaceInstructions(opts.workspaceId)
      : null;

    const branchContextText = opts.branchContext
      ? this.host.prompt.renderBranchContext(opts.branchContext)
      : null;
    const firstTurnPrefix = this.host.prompt.firstTurnPrefix({
      cwd,
      ...(opts.toolProfile ? { toolProfile: opts.toolProfile } : {}),
      contextManifest: opts.contextManifest,
      ...(opts.artifactCount !== undefined ? { artifactCount: opts.artifactCount } : {}),
      extraContexts: opts.extraContexts,
      ancestors: ancestorChain,
      mergeContexts: [
        ...(branchContextText ? [branchContextText] : []),
        ...(opts.mergeContexts ?? []),
      ],
      workspaceInstructions,
      // forkSession reaches here only with forkFrom (latest state) or
      // resumeFrom (an anchored fork's copy).
      ...((forkFrom || resumeFrom) && opts.parentChatId ? { nativeForkParentNodeId: opts.parentChatId } : {}),
      // The host's library is an additional directory of every session given one.
      ...hostSkillsPrefix(this.host.profile, {
        interactive: ownerMode(owner) === 'interactive', toolProfile: opts.toolProfile, librarySkillsLoaded: this.options.skillLibraryDir !== undefined,
      }),
    });
    const effectiveFirstTurnPrefix = this.host.profile.composeFirstTurnPrefix(firstTurnPrefix, opts.bootstrapInstructions, opts.toolProfile);

    if (resumeFrom) {
      if (opts.ephemeral) throw new NativeResumeUnavailableError('An ephemeral Claude session is never resumed');
      const session = await this.manager.loadSession({
        id, owner, cwd, parentChatId: opts.parentChatId, workspaceId: opts.workspaceId ?? null,
        model: opts.model ?? undefined, externalSessionId: resumeFrom,
        ownerUserId: opts.ownerUserId ?? null, bootstrapInstructions: effectiveFirstTurnPrefix,
        replayHistory: opts.replayHistory, toolProfile: opts.toolProfile,
        permissionBroker: opts.permissionBroker, profileHash: opts.profileHash ?? null,
        reasoning: opts.reasoning ?? null,
      });
      if (opts.enableFollowUps === false) session.setEnableFollowUps(false);
      return session;
    }

    return this.manager.createSession({
      forkFromNativeSessionId: forkFrom,
      id,
      owner,
      cwd,
      parentChatId: ownerMode(owner) === 'interactive' ? opts.parentChatId : undefined,
      workspaceId: opts.workspaceId ?? null,
      model: opts.model ?? undefined,
      firstTurnPrefix: effectiveFirstTurnPrefix,
      ownerUserId: opts.ownerUserId ?? null,
      enableFollowUps: opts.enableFollowUps,
      replayHistory: opts.replayHistory,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      profileHash: opts.profileHash ?? null,
      reasoning: opts.reasoning ?? null,
      ...(opts.ephemeral ? { ephemeral: true } : {}),
    });
  }

  async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
    const { owner } = sessionIdentity(opts.owner, opts.nodeId ?? opts.sessionId);
    // Invariant 9: double-load guard
    await this.manager.waitForRelease(opts.sessionId);
    const existing = this.manager.getCompatible(opts.sessionId, owner, opts.profileHash ?? null, opts.ownerUserId ?? null);
    if (existing) return existing;

    // Chat sessions resolve their native id from the node. Run attempts carry
    // the opaque resume token explicitly and never query a nodes row.
    const node = ownerMode(owner) === 'interactive' ? this.host.bindings.nodeBinding(owner.key) : null;
    const explicitResumeToken = typeof opts.nativeResumeToken === 'string'
      ? opts.nativeResumeToken
      : null;
    const externalSessionId = ownerMode(owner) === 'headless'
      ? explicitResumeToken
      : this.resumeTokenFromBinding(node);
    if (!externalSessionId) {
      throw new ClaudeSessionNotResumableError(
        `Node ${opts.sessionId} has no external_session_id — cannot resume claude session`,
      );
    }
    // Without its transcript in any project directory (deleted, or never
    // written), `--resume` can only fail: say so, and the session is rebuilt
    // from Michi's history instead of failing every retry.
    if (!(await claudeProjectsPath.claudeTranscriptFindable(this.options, opts.cwd, externalSessionId, opts.ownerUserId))) {
      throw new ClaudeSessionNotResumableError(`Claude session ${externalSessionId} has no transcript to resume`);
    }

    return this.manager.loadSession({
      id: opts.sessionId,
      owner,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId ?? node?.workspace_id ?? null,
      model: opts.model ?? undefined,
      externalSessionId,
      ownerUserId: opts.ownerUserId ?? null,
      replayHistory: opts.replayHistory,
      bootstrapInstructions: opts.bootstrapInstructions,
      toolProfile: opts.toolProfile,
      permissionBroker: opts.permissionBroker,
      profileHash: opts.profileHash ?? null,
      reasoning: opts.reasoning ?? null,
      enableFollowUps: opts.enableFollowUps,
    });
  }

  async releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
    await this.manager.releaseSession(sessionId, expectedOwner);
  }

  /**
   * Removes a released session's native files (DESIGN-v2 §3.2):
   * discardClaudeNativeFiles under the cwd it ran in, nothing else.
   * `deferred` while a session under that id is still live or opening.
   * An ephemeral session wrote no transcript, so this normally answers
   * `absent`; it also clears what an older or crashed one left.
   */
  async discardNativeSession(input: NativeSessionDiscardInput): Promise<NativeSessionDiscardResult> {
    if (this.manager.holds(input.sessionId)) return 'deferred';
    return claudeProjectsPath.discardClaudeNativeFiles(this.options, {
      cwd: input.cwd, nativeSessionId: input.nativeSessionId, ownerUserId: input.ownerUserId,
    });
  }

  async listModes(_sessionId: string): Promise<SessionMode[]> {
    return CLAUDE_MODES.map((mode) => ({ ...mode }));
  }

  /**
   * Personal, project and plugin skills and legacy commands, as a chat in
   * `cwd` would load them, without the host's library folder. The profile
   * is the one sessions spawn with.
   */
  async listSkills(opts: ListRuntimeSkillsOptions): Promise<RuntimeSkillListing> {
    const request = { cwd: path.resolve(opts.cwd), configDir: this.options.configDir?.() };
    const key = `${request.cwd}\u0000${request.configDir ?? ''}`;
    let probe = this.skillProbes.get(key);
    if (!probe) {
      const started = Date.now();
      const running = listClaudeSkills(this.options, request);
      probe = running;
      this.skillProbes.set(key, running);
      running.then(
        (listing) => this.host.observability.log('info', 'chat', 'claude skills listed', {
          cwd: request.cwd, durationMs: Date.now() - started, skills: listing.skills.length,
        }),
        (error) => this.host.observability.log('warn', 'chat', 'claude skills could not be listed', {
          cwd: request.cwd, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error),
        }),
      ).finally(() => { if (this.skillProbes.get(key) === running) this.skillProbes.delete(key); });
    }
    // A caller that stops waiting leaves the probe to the others.
    return opts.signal ? abortable(probe, opts.signal) : probe;
  }

  hostCommands(): AgentCommand[] {
    return claudeHostCommands();
  }

  async listModels(): Promise<ModelInfo[]> {
    // Serve the snapshot without re-probing: a probe is a full CLI start-up,
    // and listModels runs on every picker open. server.ts calls
    // refreshModels() once per backend start to update the snapshot.
    if (this.modelCatalog?.cached) return this.modelCatalog.cached;
    if (this.modelCatalog && (!this.listProbeAttempted || this.modelCatalog.refreshing)) {
      try {
        return await this.refreshModels();
      } catch (err) {
        this.host.observability.log('warn', 'chat', 'claude model probe failed; using static catalog', { error: (err as Error).message });
      }
    }
    return staticClaudeModels();
  }

  /**
   * Ask the CLI for the account's current model list and persist it. A failed
   * or empty probe keeps the previous snapshot. No-op (static list) when the
   * runtime was built without live catalog wiring.
   */
  async refreshModels(): Promise<ModelInfo[]> {
    if (!this.modelCatalog) return staticClaudeModels();
    this.listProbeAttempted = true;
    return this.modelCatalog.refresh();
  }

  /** Legacy aliases (`opus`, `sonnet`, …) map onto the concrete ids the CLI lists. */
  canonicalModelId(modelId: string): string {
    return resolveClaudeCliModelId(modelId);
  }

  /**
   * One structured answer from an isolated Agent SDK query (claudeStructured.ts).
   * Without a model named: a Haiku model the account lists, else the user's
   * default, else the CLI's.
   */
  async completeStructured(opts: StructuredCompletionOptions): Promise<StructuredCompletion> {
    const model = opts.model?.trim() || cheapClaudeModel(this.modelCatalog?.cached)
      || this.host.config.defaultModel(this.id, opts.ownerUserId) || null;
    return completeClaudeStructured(this.options, opts, model);
  }

  /**
   * A sidebar title from the host's title model, on a CLI of its own. Never
   * throws: a failure here must not affect the chat turn it runs beside.
   */
  async generateTitle(opts: GenerateTitleOptions): Promise<string | null> {
    const title = this.titleModel();
    if (!title) return null;
    try {
      const text = await this.titles.generate({
        prompt: this.host.title.prompt(opts.userText, opts.contextText),
        model: title.model,
        timeoutMs: title.timeoutMs,
        signal: opts.signal,
      });
      return text || null;
    } catch (err) {
      this.host.observability.log('warn', 'chat', 'claude title generation failed', { error: (err as Error).message });
      return null;
    }
  }

  /** The CLI model and deadline for titles, or null when this runtime generates none. */
  private titleModel(): { model: string; timeoutMs: number } | null {
    if (this.authError || !this.host.title.enabled(this.id)) return null;
    const { model, timeoutMs } = this.host.config.titleModel(this.id);
    return model ? { model: claudeTitles.claudeTitleModelId(model, this.modelCatalog?.cached), timeoutMs } : null;
  }

  async shutdown(): Promise<void> {
    this.unsubscribeDefaultModel();
    this.titles.shutdown();
    await this.manager.shutdown();
  }
}

function staticClaudeModels(): ModelInfo[] {
  return Object.entries(CLAUDE_MODEL_CATALOG).map(([id, entry]) => ({
    id,
    label: id,
    description: `Context: ${(entry.contextWindow / 1000).toFixed(0)}K tokens`,
    supportsReasoning: entry.supportsReasoning,
    supportedReasoningLevels: entry.supportedReasoningLevels,
    defaultReasoning: entry.defaultReasoning,
  }));
}
