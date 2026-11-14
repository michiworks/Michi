import { assertToolCatalog, catalogUnavailable, guardError } from '../../core/restrictedCatalog';
import { ApprovalCoordinator, chatApprovalOptions, forcedApprovalOptions } from '../../core/approvals';
import { assertPermissionAnswer, nextInteractionRequestId } from '../../core/pendingInteractions';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentSession,
  AgentTurnInput,
  CancelAck,
  ChatMessage,
  CompactResult,
  LoadAgentSessionOptions,
  NewAgentSessionOptions,
  RuntimePermissionBroker,
  RuntimeSessionOwner,
  RuntimeToolProfile,
  MaintenanceExecutionContext,
  SkillTurnInvocation,
  SteerResult,
} from '../../contract/types';
import type { NormalizedEvent } from '../../contract/events';
import { interactiveOwner, sameOwner } from '../../contract/types';
import type { McpSlotCallbacks, McpSlotProvider } from '../../contract/mcp';
import {
  ownerMode,
  RuntimeHostConfigError,
  type BackgroundSubagentContext, type BackgroundSubagentSink, type FollowUpsExperimentMode, type RuntimeHost, type RuntimePerf,
} from '../../contract/host';
import { isHeadlessOwner, isInteractiveOwner } from './claudeOwner';
import { resolveSubmitCallback } from '../../core/runMcpSlot';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { claudeSpawnPolicy, restrictedToolApproval } from './claudeRestrictedProfile';
import {
  AGENT_RUN_TOOL_NAMES,
  resolveAgentRunToolsForSession,
  type AgentRunToolName,
  type AgentToolBridge,
  type RunWorkerToolProfile,
} from '../../contract/tools';
import { createClaudeSdkTransport, type ClaudePreToolUseVerdict, type ClaudeSdkTransport } from './claudeSdkTransport';
import type { SDKUserMessage, PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_MODES, isClaudeWorkMode, type ClaudeWorkMode } from './claudeModes';
import { resolveClaudeCliModelId } from './claudeModelCatalog';
import { createTranslator, type ClaudeCompaction } from './claudeEventTranslator';
import { getClaudeJsonlPath } from './claudeProjectsPath';
import {
  buildClaudeMcpConfig, claudeInitCatalog, claudeLacksRestrictedFlag, claudeLacksToolsFlag, CLAUDE_UP_FRONT_TOOL_META, michiMcpToolName,
} from './claudeMcpConfig';
import { resolveShowImage } from '../../core/showImage';
import { hostEventSink } from '../../core/hostEventSink';
import { imageMimeType, prepareAttachments, type ResolvedAttachment } from '../../core/attachments';
import { canonicalClaudeToolName } from './claudeToolNames';
import type { AgentReasoning } from '../../contract/types';
import { formatTokenCount, resolveReasoningOptions, subagentEndOf, SUBAGENT_SESSION_ENDED_ERROR, type SubagentInfo } from 'michi-shared';
import { getClaudeReasoningCapabilities } from './claudeModelCatalog';
import { EventQueue } from '../../core/eventQueue';
import { NativeResumeUnavailableError } from '../../contract/errors';
import { killProcessTree } from '../../core/processTree';
import { abortable, withDeadline } from '../../core/runtimeLifecycle';
import { AsyncGate } from '../../core/asyncGate';
import { createClaudeWorkflowTap, type ClaudeWorkflowTap } from '../../core/workflows/claudeWorkflowTap';
import { sessionOwnerContext } from '../../core/ownerContext';
import { bindMaintenanceTurn, pageAttributionFor } from '../../core/maintenanceTurn';
import { expandSkillPrompt, skillContextText, skillHistoryText } from '../../core/skills';
import { turnContextPrefix } from '../../core/turnText';
import { firstString, permissionDetail, permissionDetailLine } from '../../core/permissionPrompt';
import {
  claudeHostCommands, claudeLibraryCommand, claudeLibraryRow, claudeRunsOwnCommand, claudeSkillCommands, NO_CLAUDE_SKILL_LIBRARY,
  parseClaudeSlashCommands, readClaudeSkillLibrary, withoutClaudeLibraryRows, type ClaudeSkillLibrary, type ClaudeSlashCommand,
} from './claudeSkills';

// claude --effort accepts low|medium|high|xhigh|max. Pi's "minimal" tier
// has no claude equivalent, so it maps to the next-lowest claude level.
function reasoningToClaudeEffort(
  r: AgentReasoning | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!r) return undefined;
  if (r === 'minimal') return 'low';
  return r;
}

// ---- Constants ---------------------------------------------------------------

// Native restore's system/init deadline, the approval wait and the disposal
// deadlines are the adapter options' limits (ClaudeLimits).
// Bound host control waits; a timeout quarantines the process before reuse.
const SDK_CONTROL_TIMEOUT_MS = 10_000;
const ASSISTANT_TOOL_DENIAL = 'The Michi assistant does not edit files, run commands or use other tools';
const ASSISTANT_UNVERIFIED = 'The Michi assistant\'s tools are unavailable: Claude Code has not reported a safe setup for this session';
/**
 * Turns off Claude Code's auto memory (the project's memory directory, read
 * into each session and written from it, and its background consolidation)
 * whatever the settings files say; CLAUDE.md and rules still load. For a host
 * whose RuntimeConfigPort.features.nativeMemory is false.
 */
const AUTO_MEMORY_OFF_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
// The PreToolUse hook's reason when the host requires its own approval (ClaudeAdapterOptions.requireHostApproval).
const HOST_APPROVAL_REQUIRED = 'This tool call needs the user\'s approval in this turn';

// Session-state versions keep rising across sessions and backend restarts,
// so a renderer never takes a newer session's state for an older one.
let lastStateVersion = Date.now();
function nextStateVersion(): number {
  lastStateVersion = Math.max(Date.now(), lastStateVersion + 1);
  return lastStateVersion;
}

// Reviewing a plan (ExitPlanMode) is the user's decision in every approval
// mode: no policy, grant or session trust answers it.
const PLAN_REVIEW_OPTIONS = [
  { optionId: 'reject_once', name: 'Keep planning', kind: 'reject_once' as const },
  { optionId: 'allow_once', name: 'Approve plan', kind: 'allow_once' as const },
];
const PLAN_REJECTED = 'The user did not approve the plan. Stay in plan mode and wait for their feedback before continuing.';

// ---- Session state -----------------------------------------------------------

type SessionState = 'spawning' | 'idle' | 'in_turn' | 'crashed' | 'disposed';

/**
 * Who holds the session's one turn (takeTurn). `self` is the idle pump
 * running a turn Claude started on its own; every other owner parks the pump
 * while it holds the turn.
 */
type TurnOwner = 'send' | 'warm' | 'compact' | 'model' | 'command' | 'self';

export interface ClaudeSessionDeps {
  nodeId: string;
  cwd: string;
  workspaceId: string | null;
  parentChatId?: string;
  model?: string | null;
  /** Text appended to claude's system prompt via --append-system-prompt.
   *  Populated by ClaudeRuntime.newSession with the michi preamble (ancestor
   *  chain, context manifest, [TITLE:]/[FOLLOW-UPS:] sentinels). */
  systemPromptAppend?: string;
  mcpRegistry: McpSlotProvider;
  bridge: AgentToolBridge;
  /** The adapter's options, as ClaudeRuntime received them; their host serves every port the session uses. */
  options: ClaudeAdapterOptions;
  /** Cloud-mode owner. Used to namespace the Claude project history directory
   *  so two users sharing the same cwd slug don't collide. Desktop: null. */
  ownerUserId?: string | null;
  owner?: RuntimeSessionOwner;
  profileHash?: string | null;
  replayHistory?: ChatMessage[];
  toolProfile?: RuntimeToolProfile;
  permissionBroker?: RuntimePermissionBroker;
  reasoning?: AgentReasoning | null;
  /** Anonymous warm processes have no durable node until handoff. */
  persistNativeIdentity?: boolean;
  /**
   * NewAgentSessionOptions.ephemeral (DESIGN-v2 §3.2): the CLI keeps no
   * transcript (persistSession false) and starts without telemetry
   * (claudeEphemeralEnv); a crashed process is never restored with --resume:
   * the turn fails.
   */
  ephemeral?: boolean;
  /** Where background subagents are reported (tests); the host's backgroundSubagents by default. */
  backgroundSubagents?: BackgroundSubagentSink;
}

export type SelfTurnIterator = AsyncIterableIterator<NormalizedEvent>;

export interface SelfTurnInfo {
  chatId: string;
  owner: RuntimeSessionOwner;
  ownerUserId: string | null;
  events: SelfTurnIterator;
}

export type SelfTurnCallback = (info: SelfTurnInfo) => void;

// ---- ClaudeSession -----------------------------------------------------------

export class ClaudeSession implements AgentSession {
  // `id` and `nodeId` are mutable so a warm-pool session (spawned with an
  // anonymous UUID before any chat exists) can adopt the real chat's
  // identifier at handoff via rebindIdentity(). After rebindIdentity has
  // run once, the firstTurnPrefixConsumed gate prevents further mutation.
  public id: string;
  public owner: RuntimeSessionOwner;
  public runtimeProfileHash: string | null;
  public readonly runtimeId = 'claude';
  public readonly parentChatId: string | undefined;

  /** The work mode (claudeModes.ts) of a chat that has modes; null otherwise. */
  get currentModeId(): ClaudeWorkMode | null {
    return this.supportsModes() ? this.workMode : null;
  }

  /** Model currently bound to this session (reflects setModel). */
  get currentModelId(): string | null {
    return this.model ?? null;
  }

  get nativeSessionId(): string | null {
    return this.externalSessionId;
  }

  /** Assistant text accumulated during the in-flight turn, exposed via
   *  getPendingAssistant() for auto-branch ancestor "in progress" stitching.
   *  Non-null only between turn start and the finally block. */
  private pendingAssistantBuf: string[] | null = null;

  /** Whether to request and emit follow-ups. Bound per chat after spawn so
   *  warm-pool spawn args remain stable; reminders and metadata callbacks
   *  consult the current setting when the turn runs. */
  private enableFollowUps = true;

  /**
   * Chat approvals over the host's permission policy, comparing tool names
   * by the host's grant key: in Michi, Claude's write and exec tool names
   * share theirs with the canonical tool, so one grant answers both.
   */
  private readonly approvals: ApprovalCoordinator;
  private turnPermissionMode: import('michi-shared').ChatPermissionMode | undefined;
  /** The SDK permission mode the CLI runs under, as last set or reported. */
  private nativePermissionMode: PermissionMode = 'default';
  /**
   * Default or Plan. Plan sets the SDK mode to 'plan'; Default uses the mode
   * the approval policy maps to (policyNativeMode). The CLI leaves plan mode
   * on its own when the user approves a plan, and enters it when the model
   * calls EnterPlanMode: its reported mode keeps this in step.
   */
  private workMode: ClaudeWorkMode = 'default';
  /** SDK permission-mode changes, one at a time. */
  private nativeModeOp: Promise<void> = Promise.resolve();
  /**
   * Ultracode (RuntimeConfigPort.features.ultracode): the chat's choice as
   * last read, what the live process was told (null: unknown, as after a
   * failed change) and what the CLI last reported of it (get_settings).
   */
  private ultracodeWanted = false;
  private nativeUltracode: boolean | null = null;
  private ultracodeReported: { active: boolean; available: boolean } | null = null;
  /** The live process runs with --bare, which skips Ultracode's reminders. */
  private spawnedBare = false;
  /** Ultracode changes of the live process, one at a time. */
  private nativeUltracodeOp: Promise<void> = Promise.resolve();
  private readonly stateListeners = new Set<() => void>();
  private stateVersion = nextStateVersion();
  private nodeId: string;
  private readonly cwd: string;
  private workspaceId: string | null;
  /** Updated only after the SDK acknowledges an in-session model change. */
  private model: string | undefined;
  private ownerUserId: string | null;
  private toolProfile: RuntimeToolProfile | undefined;
  private permissionBroker: RuntimePermissionBroker | undefined;
  private reasoning: AgentReasoning | null;
  private readonly systemPromptAppend: string | undefined;
  private readonly mcpRegistry: McpSlotProvider;
  private readonly bridge: AgentToolBridge;
  private readonly options: ClaudeAdapterOptions;
  private readonly host: RuntimeHost;
  /** The host's perf marks (observability port). */
  private readonly perf: RuntimePerf;

  private state: SessionState = 'spawning';
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: ClaudeSdkTransport | null = null;
  private settleInterrupt: (() => void) | null = null;
  private cancellation: Promise<CancelAck> | null = null;
  private retirement: Promise<void> | null = null;
  private turnAbort: AbortController | null = null;
  private activePageTurnAttribution: { turnId: string; assistantId: string } | null = null;
  private activeMaintenanceExecutionContext: MaintenanceExecutionContext | null = null;
  private resumePending = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private exitPromise: Promise<void> = Promise.resolve();
  private slotId: string | null = null;
  private externalSessionId: string | null = null;
  private persistNativeIdentity: boolean;
  /** ClaudeSessionDeps.ephemeral: no transcript, no telemetry, never restored. */
  readonly ephemeral: boolean;
  private lastUsedAt = Date.now();
  private readonly stderrWarningsSent = new Set<string>();
  /** The host's follow-up protocol, fixed at construction. */
  private readonly followUpsExperimentMode: FollowUpsExperimentMode;

  private queue: EventQueue;
  private readonly history: ChatMessage[] = [];
  private getNativeForkAnchor: (() => string | null) | null = null;
  private markTranslatorTurnStart: (() => void) | null = null;
  /** The live process's background subagents (see hasBackgroundWork). */
  private translatorHasBackgroundSubagents: (() => boolean) | null = null;
  /** Them as roster entries (see endBackgroundSubagents). */
  private translatorPendingBackgroundSubagents: (() => SubagentInfo[]) | null = null;
  /** The live translator's last native compaction (see compact()). */
  private takeTranslatorCompaction: (() => ClaudeCompaction | null) | null = null;
  /**
   * Steers (SDK user messages sent during a turn) the CLI has not started
   * yet, by uuid. Its command_lifecycle frames say when it does: folded into
   * the running turn, or as its own turn right after it, which the host's
   * turn then waits for (TranslatorOptions.holdTurnEnd).
   */
  private readonly pendingSteers = new Set<string>();
  /** Every steer sent during the current turn, started or not. */
  private readonly turnSteers = new Set<string>();
  /**
   * A result of this turn was held for a pending steer and no CLI turn has
   * started since: the CLI is between that result and the steer's turn.
   */
  private heldTurnEnd = false;
  /** Ends a held turn when no CLI turn follows (see heldTurnEnd). */
  private releaseHeldTurn: (() => void) | null = null;
  /** The CLI's protocol capabilities, from system/init. */
  private nativeCapabilities: ReadonlySet<string> = new Set();
  /**
   * The CLI's command table (its initialize answer, then each
   * commands_changed push) and the transport it describes. A skill turn
   * runs the skill as a command only when that transport is the live one
   * and the table has it.
   */
  private nativeCommands: readonly ClaudeSlashCommand[] = [];
  private nativeCommandsOf: ClaudeSdkTransport | null = null;
  /** The library folder the live process was given (ClaudeAdapterOptions.skillLibraryDir). */
  private spawnedSkillDir: string | null = null;
  /** The library as the CLI had it when it sent nativeCommands: which of its rows are the library's. */
  private nativeLibrary: ClaudeSkillLibrary = NO_CLAUDE_SKILL_LIBRARY;
  /** The library as the CLI loaded it at its start or a reload, for the next table it sends. */
  private nextLibrary: ClaudeSkillLibrary | null = null;
  /** Tables observed: whether a reload's own push came before its answer. */
  private nativeTables = 0;
  /** Stops the live process's reloads on library changes. */
  private stopSkillLibraryUpdates: (() => void) | null = null;
  /** The library changed during a turn: reload once it ends. */
  private skillReloadPending = false;
  /**
   * The CLI reported an authentication_failed retry and no model output has
   * arrived since. The first such retry is the CLI renewing expired
   * credentials (Bedrock's hourly STS rotation); a second one fails the process.
   */
  private authRetryPending = false;
  private readonly backgroundSubagents: BackgroundSubagentSink;
  /** This session's reports to the registry (unique per session object). */
  private readonly backgroundSubagentSource = `claude:${randomUUID()}`;

  // Per-chat preamble — set by ClaudeRuntime.newSession after pulling the
  // session out of the warm pool (or right after spawnFresh on a cold spawn).
  // Prepended to the first real send() text, then discarded. The warm-init
  // turn does NOT consume the prefix — it's specifically for the first user
  // turn AFTER warm.
  private firstTurnPrefix: string = '';
  private firstTurnPrefixConsumed: boolean = false;

  // Per-turn perf instrumentation. Reset in send() before writeStdin; read by
  // the envelope parser callback to time the first init/model envelope after
  // we write a user prompt. All no-cost when metrics are off.
  private stdinWriteAt = 0;
  private initSeenThisTurn = false;
  private firstModelEnvelopeThisTurn = false;
  /**
   * The Michi assistant's process passed the init check (only its Michi
   * tools, only Michi's MCP server, default mode). Until then, and once the
   * process has failed, none of its tools run: not through the SDK's gates,
   * not through its MCP slot. Reset on every spawn.
   */
  private assistantInitVerified = false;
  /** Why this spawn's process failed, kept until the next spawn. */
  private lastFailure: string | null = null;
  private lastGuardError: Error | null = null;

  /**
   * The session's one turn, null when it is free. `nativeEnded`: the CLI's
   * result for it arrived while its owner still drains the events, so the
   * CLI runs nothing of it. Only takeTurn, releaseTurn and the result
   * handler change it.
   */
  private turn: { owner: TurnOwner; nativeEnded: boolean } | null = null;

  // Permission state
  private readonly pendingPermissions = new Map<
    number,
    { resolve: (optionId: string | null) => void; timer: NodeJS.Timeout; toolName?: string; forced?: boolean }
  >();
  private readonly pendingUserInputs = new Map<
    number,
    { resolve: (answers: Array<{ question: string; answer: string }> | null) => void; timer: NodeJS.Timeout }
  >();

  // Disposed callback
  private disposedCallback: (() => void) | undefined;
  private disposedCallbackFired = false;
  // Idle pump: drains self-initiated turns when no send() is active
  private readonly idleGate = new AsyncGate();
  private selfTurnCallback: SelfTurnCallback | null = null;
  private idlePumpRunning = false;
  /** Background workflows (the `Workflow` tool) reported outside turns. */
  private readonly workflowTap: ClaudeWorkflowTap;

  constructor(id: string, deps: ClaudeSessionDeps) {
    this.id = id;
    this.nodeId = deps.nodeId;
    this.cwd = deps.cwd;
    this.workspaceId = deps.workspaceId;
    this.parentChatId = deps.parentChatId;
    this.model = deps.model ?? undefined;
    this.ownerUserId = deps.ownerUserId ?? null;
    this.owner = deps.owner ?? interactiveOwner(deps.nodeId);
    this.runtimeProfileHash = deps.profileHash ?? null;
    this.toolProfile = deps.toolProfile;
    this.permissionBroker = deps.permissionBroker;
    this.reasoning = deps.reasoning ?? null;
    this.persistNativeIdentity = deps.persistNativeIdentity ?? true;
    this.ephemeral = deps.ephemeral === true;
    this.systemPromptAppend = deps.systemPromptAppend;
    this.mcpRegistry = deps.mcpRegistry;
    this.bridge = deps.bridge;
    this.options = deps.options;
    this.host = deps.options.host;
    // ClaudeRuntime asserts both ports; a session built directly is checked
    // here (its subagent sink may come with its deps instead).
    const backgroundSubagents = deps.backgroundSubagents ?? this.host.backgroundSubagents;
    const workflows = this.host.workflows;
    if (!workflows || !backgroundSubagents) {
      throw new RuntimeHostConfigError('ClaudeSession', [
        ...(workflows ? [] : ['workflows'] as const),
        ...(backgroundSubagents ? [] : ['backgroundSubagents'] as const),
      ]);
    }
    this.perf = this.host.observability.perf;
    this.approvals = new ApprovalCoordinator({
      permissions: this.host.permissions,
      canonicalize: (toolName) => this.host.permissions.grantKey?.(toolName) ?? toolName,
    });
    this.followUpsExperimentMode = this.host.prompt.followUpsExperimentMode();
    this.backgroundSubagents = backgroundSubagents;

    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'idle' || this.state === 'in_turn') {
        this.queue.push({ kind: 'heartbeat', idleMs });
      }
    });
    this.history.push(...(deps.replayHistory ?? []).map((message) => ({ ...message })));
    this.workflowTap = createClaudeWorkflowTap({
      hub: workflows,
      context: () => sessionOwnerContext(this.host.principal, this.ownerUserId, this.workspaceId, this.owner),
      stopTask: (taskId) => this.stopTask(taskId),
    });
  }

  /**
   * Background work lives in this CLI process (do not reclaim it): a
   * workflow, or a background subagent that still runs or finished while
   * idle with no turn yet reporting its outcome.
   */
  hasBackgroundWork(): boolean {
    return this.workflowTap.hasOpenRuns() || this.translatorHasBackgroundSubagents?.() === true;
  }

  /**
   * Stop one background task (a running Workflow) through the SDK control
   * channel. Unlike a prompt write, a failure here rejects instead of
   * tearing the session down.
   */
  async stopTask(taskId: string): Promise<void> {
    const transport = this.transport;
    if (!transport || this.state === 'crashed' || this.state === 'disposed') throw new Error('Claude is not running');
    await withDeadline(transport.query.stopTask(taskId), SDK_CONTROL_TIMEOUT_MS, 'Claude did not confirm the stop request');
  }

  /**
   * Tell the registry which background subagents this session's process
   * tracks (chat sessions only); an empty list withdraws them.
   */
  private reportBackgroundSubagents(ids: readonly string[]): void {
    const context = this.backgroundSubagentContext();
    if (context) this.backgroundSubagents.report(context, this.backgroundSubagentSource, ids);
  }

  /** Chat sessions only. */
  private backgroundSubagentContext(): BackgroundSubagentContext | null {
    if (ownerMode(this.owner) !== 'interactive') return null;
    return sessionOwnerContext(this.host.principal, this.ownerUserId, this.workspaceId, this.owner);
  }

  /**
   * The process is going: its background agents end with it and nothing
   * will report them. Withdraw them and record how each ended: stopped,
   * or the outcome it finished with while idle that no turn reported.
   */
  private endBackgroundSubagents(): void {
    const context = this.backgroundSubagentContext();
    if (!context) return;
    const now = Date.now();
    const ends = (this.translatorPendingBackgroundSubagents?.() ?? [])
      .map((entry) => subagentEndOf(entry, SUBAGENT_SESSION_ENDED_ERROR, now));
    this.backgroundSubagents.end(context, this.backgroundSubagentSource, ends);
  }

  // ---- Public AgentSession interface ----------------------------------------

  getHistory(): ChatMessage[] {
    return this.history;
  }

  /**
   * True iff the underlying claude CLI process is still usable for a turn.
   * Returns false on `disposed` (explicit teardown) or `crashed` (process
   * exited unexpectedly). The warm pool uses this to skip dead entries on
   * `take()` instead of handing them to a chat that would error on first send.
   */
  isAlive(): boolean {
    return this.state !== 'disposed' && this.state !== 'crashed';
  }

  getState(): SessionState {
    return this.state;
  }

  getLastUsedAt(): number {
    return this.lastUsedAt;
  }

  getPendingAssistant(): string | undefined {
    return this.pendingAssistantBuf?.join('');
  }

  getActivePageTurnAttribution(): { turnId: string; assistantId: string } | null {
    return this.owner.mode === 'interactive' ? this.activePageTurnAttribution : null;
  }

  getActiveMaintenanceExecutionContext(): MaintenanceExecutionContext | null {
    return this.activeMaintenanceExecutionContext;
  }

  private maintenanceContextForSend(input?: AgentTurnInput): MaintenanceExecutionContext | null {
    return bindMaintenanceTurn(input, {
      maintenance: this.host.profile.isMaintenance?.(this.toolProfile) === true, owner: this.owner, workspaceId: this.workspaceId,
      expectedOwnerUserId: this.host.principal.resolve(this.ownerUserId), runtimeLabel: 'Claude',
    });
  }

  async *send(text: string, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
    if (this.state === 'disposed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }

    const tSendIn = this.perf.now();
    this.perf.mark('claude:send_entered', { sid: this.id, textLen: text.length, state: this.state });
    const maintenanceContext = this.maintenanceContextForSend(input);
    // Claiming the turn must be the first mutating step. A losing send must
    // leave the active owner (foreground or idle-pump self-turn) entirely
    // alone: takeTurn throws before it touches the gate or the queue.
    this.takeTurn('send');
    const controller = new AbortController();
    this.turnAbort = controller;
    const pageTurnAttribution = pageAttributionFor(input, this.owner);
    this.perf.measure('claude:send_lock_acquired', tSendIn, { sid: this.id });
    try {
      this.activePageTurnAttribution = pageTurnAttribution;
      this.activeMaintenanceExecutionContext = maintenanceContext;
      if (this.cancellation) await abortable(this.cancellation, controller.signal);
      this.lastUsedAt = Date.now();
      if (this.resumePending && this.state !== 'crashed') {
        yield { kind: 'retry_start', detail: 'Restoring original Claude session' };
      }
      if (this.retirement) {
        yield { kind: 'retry_start', detail: 'Waiting for previous Claude task to stop' };
        await abortable(this.retirement, controller.signal);
      }
      this.turnPermissionMode = this.host.permissions.mode(this.owner, this.ownerUserId);
      const desiredPermissionMode = this.desiredNativeMode();
      if (this.child && desiredPermissionMode !== this.nativePermissionMode) {
        yield { kind: 'retry_start', detail: 'Applying permission mode' };
        if (!this.transport) throw new Error('Claude SDK transport is unavailable');
        try {
          await abortable(this.applyNativeMode(desiredPermissionMode), controller.signal);
        } catch (error) {
          this.workflowTap.expectStop('Stopped by a permission-mode change: the Claude session restarted');
          await this.retireProcess();
          throw error;
        }
        yield { kind: 'retry_end' };
      }
      // Before the crash check: a CLI that dies while this waits on it is
      // restored below, like one that died before the turn began.
      await this.reconcileUltracode(controller.signal);
      if (this.state === 'crashed') {
        // An ephemeral session has no transcript to resume from, by design.
        if (this.ephemeral) {
          if (this.lastGuardError) throw this.lastGuardError;
          throw new Error(this.lastFailure
            ? `Claude stopped during a session Michi keeps no record of: ${this.lastFailure} It is not restored.`
            : 'Claude stopped during a session Michi keeps no record of. It is not restored.');
        }
        if (!this.externalSessionId) {
          // Keep the reason: the turn that saw it may be long gone.
          if (this.lastGuardError) throw this.lastGuardError;
          throw new Error(this.lastFailure
            ? `Claude stopped before its native session was initialized: ${this.lastFailure} No replacement session was created.`
            : 'Claude stopped before its native session was initialized. No replacement session was created.');
        }
        yield { kind: 'retry_start', detail: 'Restoring original Claude session' };
        const tResume = this.perf.now();
        if (this.child) await abortable(this.retireProcess(), controller.signal);
        await this.spawnResume(this.externalSessionId);
        this.perf.measure('claude:send_spawn_resume', tResume, { sid: this.id });
      }
      controller.signal.throwIfAborted();

      const skill = input?.skill;
      const skillCommand = skill ? await this.nativeSkillCommand(skill, controller.signal) : null;
      // That may have waited for a process that has died since.
      if (skill && ((this.state as SessionState) === 'crashed' || (this.state as SessionState) === 'disposed')) {
        throw this.lastGuardError ?? new Error(this.lastFailure ?? 'Claude stopped before the skill could run.');
      }

      this.state = 'in_turn';

      // Inject per-chat preamble on the first real turn, then mark consumed.
      // Empty prefix is a no-op. The warm-init turn does NOT pass through
      // this branch — it uses its own envelope path in warmInit().
      const turnPrefix = this.firstTurnPrefixConsumed || !this.firstTurnPrefix ? '' : `${this.firstTurnPrefix}\n\n---\n\n`;
      this.firstTurnPrefixConsumed = true;
      // A skill the CLI does not run itself reaches the model as its text, then the turn's.
      const outgoingText = turnPrefix + (skill && !skillCommand ? expandSkillPrompt(skill, text) : text);

      // Append follow-up reminder for the model only — keep history clean so
      // fork/branch transcripts don't accumulate reminder noise. A skill
      // turn follows the skill's own output rules instead.
      const userTurnCount = this.history.filter(m => m.role === 'user').length + 1;
      const reminder = skill ? (this.host.prompt.skillTurnNote?.() ?? '')
        : (this.host.profile.isRestricted(this.toolProfile) || this.toolProfile?.assistant) ? '' : this.host.prompt.followUpsTurnReminder(
          userTurnCount,
          false,
          this.followUpsExperimentMode,
          this.enableFollowUps,
        );
      // Non-image attachments have no stream-json block type, so name them by
      // path rather than dropping them silently; the CLI can Read them itself.
      const { images: imageAttachments, promptNote } = prepareAttachments(input?.attachments, text);
      const modelPrefix = turnContextPrefix(this.host.profile.maintenancePromptPrefix?.(maintenanceContext) ?? '', input);
      const textForModel = modelPrefix + (reminder ? outgoingText + reminder : outgoingText) + promptNote;

      // History keeps a skill turn as its command: the skill's text is the model's.
      const skillContext = skill ? skillContextText(text, skill.args) : '';
      this.history.push({ role: 'user', content: skill ? turnPrefix + skillHistoryText(skill, text) : outgoingText });
      this.markTranslatorTurnStart?.();
      this.pendingSteers.clear();
      this.turnSteers.clear();
      this.heldTurnEnd = false;
      this.initSeenThisTurn = false;
      this.firstModelEnvelopeThisTurn = false;
      this.stdinWriteAt = this.perf.now();
      const tStdin = this.stdinWriteAt;
      const imageBlocks = buildClaudeImageBlocks(imageAttachments);
      if (this.resumePending) {
        this.initTimer = setTimeout(() => this.failProcess(new Error(
          `Claude native restore did not initialize within ${this.options.limits.initTimeoutMs / 1000} seconds. Original session retained; please retry.`,
        )), this.options.limits.initTimeoutMs);
      }
      const human = ownerMode(this.owner) === 'interactive' && input?.humanOrigin === true && this.options.cli().humanOrigin;
      const outgoingMessage = skillCommand
        ? userMessage(skillCommandContent(skillContextBlock(modelPrefix + turnPrefix, skillContext, reminder + promptNote),
          imageBlocks, skillCommand), human)
        : userEnvelope(textForModel, imageBlocks, human);
      const nativeUserMessageId = outgoingMessage.uuid;
      this.sendInput(outgoingMessage);
      this.perf.measure('claude:write_stdin', tStdin, { sid: this.id });

      // tStdin → first event is the claude CLI + Anthropic black-box TTFT.
      const tAfterStdin = this.perf.now();
      let firstEventSeen = false;
      let firstChunkSeen = false;
      const assistantChunks: string[] = [];
      this.pendingAssistantBuf = assistantChunks;
      for await (const ev of this.queue.drainUntilTurnEnd()) {
        if (!firstEventSeen) {
          firstEventSeen = true;
          this.perf.measure('claude:stdin_to_first_event', tAfterStdin, { sid: this.id, kind: ev.kind });
        }
        if (ev.kind === 'chunk') {
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            this.perf.measure('claude:stdin_to_first_chunk', tAfterStdin, { sid: this.id });
          }
          assistantChunks.push(ev.text);
        }
        if (ev.kind === 'turn_end' && this.cancellation) await this.cancellation;
        if (ev.kind === 'turn_end' && ev.stopReason === 'end_turn' && !controller.signal.aborted
          && ownerMode(this.owner) === 'interactive' && input?.assistantMessageId && this.externalSessionId) {
          const nativeMessageId = this.getNativeForkAnchor?.();
          if (nativeMessageId) {
            try {
              this.host.bindings.forkAnchors.saveClaudeForkAnchor({
                nodeId: this.owner.key, nativeSessionId: this.externalSessionId,
                assistantMessageId: input.assistantMessageId, userMessageId: input.userMessageId,
                nativeMessageId, nativeUserMessageId,
              });
            } catch (error) {
              this.host.observability.log('warn', 'chat', 'Claude fork anchor could not be persisted', {
                nodeId: this.owner.key, error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        yield ev;
      }
      if (assistantChunks.length > 0) {
        this.history.push({ role: 'assistant', content: assistantChunks.join('') });
      }
      const stateAfterDrain = this.state as SessionState;
      if (stateAfterDrain === 'crashed' && this.lastGuardError) throw this.lastGuardError;
      if (stateAfterDrain !== 'crashed' && stateAfterDrain !== 'disposed') {
        this.state = 'idle';
      }
      this.lastUsedAt = Date.now();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (this.retirement) await this.retirement.catch(() => {});
      yield { kind: 'turn_end', stopReason: 'cancelled' };
    } finally {
      if (this.initTimer) clearTimeout(this.initTimer);
      this.initTimer = undefined;
      if (this.state === 'in_turn') {
        controller.abort();
        await this.retireProcess().catch(() => {});
      }
      if (this.cancellation) await this.cancellation;
      if (this.turnAbort === controller) this.turnAbort = null;
      if (this.activePageTurnAttribution === pageTurnAttribution) this.activePageTurnAttribution = null;
      if (this.activeMaintenanceExecutionContext === maintenanceContext) this.activeMaintenanceExecutionContext = null;
      this.pendingAssistantBuf = null;
      this.releaseTurn();
    }
  }

  /** Native identity learned from init or supplied for resume, never a spawn placeholder. */
  getExternalSessionId(): string | null {
    return this.externalSessionId;
  }

  /**
   * Rebind this session's public id + internal nodeId. Used exclusively
   * when a warm-pool session is handed off to a real chat that has a
   * stable michi-side nodeId.
   *
   * Idempotent until first user send is consumed; throws after to prevent
   * silent identity changes that would corrupt the session directory / db state.
   */
  rebindIdentity(
    newId: string,
    newNodeId: string,
    opts?: {
      workspaceId?: string | null;
      ownerUserId?: string | null;
      owner?: RuntimeSessionOwner;
      profileHash?: string | null;
      toolProfile?: RuntimeToolProfile;
      permissionBroker?: RuntimePermissionBroker;
      reasoning?: AgentReasoning | null;
      replayHistory?: ChatMessage[];
    },
  ): void {
    if (this.firstTurnPrefixConsumed) {
      throw new Error('rebindIdentity called after first turn already sent');
    }
    // A warm process was spawned without any restriction: a tool profile or
    // permission broker cannot be attached to it after the fact.
    if (opts?.toolProfile || opts?.permissionBroker) {
      throw new Error('A warm Claude session cannot take a tool profile or permission broker');
    }
    this.id = newId;
    this.nodeId = newNodeId;
    this.persistNativeIdentity = true;
    if (opts && 'workspaceId' in opts) this.workspaceId = opts.workspaceId ?? null;
    if (opts && 'ownerUserId' in opts) this.ownerUserId = opts.ownerUserId ?? null;
    if (opts?.owner) this.owner = opts.owner;
    if (opts && 'profileHash' in opts) this.runtimeProfileHash = opts.profileHash ?? null;
    if (opts && 'toolProfile' in opts) this.toolProfile = opts.toolProfile;
    if (opts && 'permissionBroker' in opts) this.permissionBroker = opts.permissionBroker;
    if (opts && 'reasoning' in opts) this.reasoning = opts.reasoning ?? null;
    if (opts?.replayHistory) {
      this.history.splice(0, this.history.length, ...opts.replayHistory.map((message) => ({ ...message })));
    }
    this.syncMcpSlotBinding();
    // A warm process was spawned before it knew the chat: take its Ultracode
    // choice now rather than at the first turn (which checks it again).
    this.ultracodeWanted = this.desiredUltracode();
    if (this.transport) this.syncNativeUltracode(this.transport);
  }

  matchesOwner(owner: RuntimeSessionOwner): boolean {
    return sameOwner(this.owner, owner);
  }

  getOwnerUserId(): string | null {
    return this.ownerUserId;
  }

  /** Rebinds the live slot to this session's identity; every field is set, so undefined clears an optional one. */
  private syncMcpSlotBinding(): void {
    if (!this.slotId || !this.mcpRegistry.get(this.slotId)) return;
    this.mcpRegistry.rebind(this.slotId, {
      owner: this.owner,
      exposedToolNames: this.toolProfile?.allowedToolNames ? new Set(this.toolProfile.allowedToolNames) : undefined,
      parentChatId: this.id,
      nodeId: ownerMode(this.owner) === 'interactive' ? this.nodeId : null,
      workspaceId: this.workspaceId,
      ownerUserId: this.ownerUserId,
      agentRuns: this.resolveAgentRunTools(),
      agentRunToolNames: this.allowedAgentRunToolNames(),
      onSubmitAgentResult: this.submitAgentResultCallback(),
    });
  }

  private resolveAgentRunTools() {
    return resolveAgentRunToolsForSession(this.bridge, {
      runtimeId: this.runtimeId,
      sessionId: this.id,
      owner: this.owner,
      ownerUserId: this.ownerUserId,
      workspaceId: this.workspaceId,
      nodeId: ownerMode(this.owner) === 'interactive' ? this.nodeId : null,
    }) ?? undefined;
  }

  /**
   * An Agent Run's submit_agent_result, bound to its attempt's collector.
   * Only a Run session gets one, and its owner never changes (a warm chat
   * process is the only session rebound, and never to a Run profile).
   */
  private submitAgentResultCallback(): ((payload: unknown) => ReturnType<RunWorkerToolProfile['runWorkerTools']['submitAgentResult']>) | undefined {
    if (!isHeadlessOwner(this.owner) || !this.toolProfile) return undefined;
    return resolveSubmitCallback(this.owner, this.toolProfile);
  }

  private allowedAgentRunToolNames(): AgentRunToolName[] {
    return AGENT_RUN_TOOL_NAMES.filter((name) => this.isToolAllowed(name));
  }

  /** The assistant's slot also carries its allow-list, should the slot's database lookup ever miss. */
  private assistantSlotExposure(): Pick<McpSlotCallbacks, 'restricted' | 'maintenance' | 'exposedToolNames' | 'isServing' | 'getActiveMaintenanceExecutionContext'> {
    if (!this.host.profile.isRestricted(this.toolProfile)) return {};
    const allowed = this.toolProfile?.allowedToolNames;
    return {
      restricted: true,
      ...(this.host.profile.isMaintenance?.(this.toolProfile) ? { maintenance: true as const } : {}),
      ...(allowed ? { exposedToolNames: new Set(allowed) } : {}),
      ...(this.host.profile.isMaintenance?.(this.toolProfile) ? { getActiveMaintenanceExecutionContext: () => this.getActiveMaintenanceExecutionContext() } : {}),
      // Checked on every call, so a failed process stops being served at
      // once, not when its child has exited and the slot is disposed.
      isServing: () => this.assistantToolsAvailable(),
    };
  }

  /** Whether the assistant's tools may run now (see assistantInitVerified). */
  private assistantToolsAvailable(): boolean {
    return this.assistantInitVerified && this.state !== 'crashed' && this.state !== 'disposed';
  }

  /**
   * Attach a per-chat preamble to be prepended to the first real send().
   *
   * Idempotent until first send consumes it; throws on later calls so the
   * caller can't silently lose context by re-setting after a turn.
   * Called by ClaudeRuntime.newSession once it has the chat's
   * NewAgentSessionOptions in hand.
   */
  setFirstTurnPrefix(prefix: string): void {
    if (this.firstTurnPrefixConsumed) {
      throw new Error('setFirstTurnPrefix called after first turn already sent / consumed');
    }
    this.firstTurnPrefix = prefix;
  }

  /**
   * Honor opts.enableFollowUps from newSession. Safe to call after warm-pool
   * handoff (before the first send): it gates per-turn reminders and metadata
   * follow-ups while preserving the byte-identical spawn args.
   */
  setEnableFollowUps(enableFollowUps: boolean): void {
    this.enableFollowUps = enableFollowUps;
  }

  /**
   * Trigger system/init without invoking the model.
   *
   * Writes a stream-json user envelope with `shouldQuery: false`. Claude
   * pays the ~7s cli init cost (auth, system-prompt parsing, internal state
   * setup), then closes the turn with `result/success` — no `assistant`
   * envelope is emitted and no Anthropic API call is made.
   *
   * Used by ClaudeWarmPool to pre-warm sessions in the background so the
   * user's first real message hits a session that has already paid init.
   *
   * Resolves when the synthetic `turn_end` arrives. Rejects only if called
   * on a disposed or crashed session.
   */
  async warmInit(): Promise<void> {
    if (this.state === 'disposed' || this.state === 'crashed') {
      throw new Error(`warmInit on ${this.state} session`);
    }

    // See send(): a concurrent warm-init that loses leaves the active owner alone.
    this.takeTurn('warm');
    try {
      this.lastUsedAt = Date.now();
      this.state = 'in_turn';
      this.markTranslatorTurnStart?.();

      // Direct stream-json envelope (not via userEnvelope helper) because we
      // need the `shouldQuery: false` field. Verified empirically: claude
      // emits system/init + result/success with NO assistant envelope.
      const envelope: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: '__michi:warm__' },
        shouldQuery: false,
        parent_tool_use_id: null,
        session_id: this.externalSessionId ?? '',
        uuid: randomUUID(),
      };
      this.sendInput(envelope);

      // Drain until the synthetic turn_end the translator emits from
      // result/success. Every event is discarded — warm produces no visible
      // output, and the dummy turn intentionally does not write to history.
      for await (const ev of this.queue.drainUntilTurnEnd()) {
        void ev;
      }

      const stateAfterWarm = this.state as SessionState;
      if (stateAfterWarm !== 'crashed' && stateAfterWarm !== 'disposed') {
        this.state = 'idle';
      }
      this.lastUsedAt = Date.now();
    } finally {
      this.releaseTurn();
    }
  }

  /** Keep the process only after both native interrupt acknowledgment and the
   * terminal result. A control ACK alone does not establish a turn boundary. */
  cancel(): Promise<CancelAck> {
    if (this.cancellation) return this.cancellation;
    if (!this.turnAbort && this.state !== 'in_turn') {
      return Promise.resolve({ acknowledged: false, source: 'inferred', confidence: 'unknown' });
    }
    const work = this.cancelActiveTurn();
    this.cancellation = work;
    void work.finally(() => { if (this.cancellation === work) this.cancellation = null; }).catch(() => {});
    return work;
  }

  private async cancelActiveTurn(): Promise<CancelAck> {
    if (this.turn?.nativeEnded && this.state === 'idle') {
      // The CLI already answered: only the turn's last events are still
      // being drained. Nothing runs that an interrupt could stop, and the
      // process (with its background work) stays.
      this.turnAbort?.abort();
      return { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: 'SDK result' };
    }
    const canInterrupt = this.transport && this.state === 'in_turn' && !this.resumePending;
    this.turnAbort?.abort();
    this.clearInteractions();
    if (canInterrupt) {
      const settled = new Promise<void>((resolve) => { this.settleInterrupt = resolve; });
      try {
        // A steer the CLI has not started survives an interrupt and would
        // run as a turn of its own after the Stop: withdraw it first.
        const steers = this.pendingSteers.size > 0 ? await this.withdrawPendingSteers() : 'withdrawn';
        if (steers === 'failed') throw new Error('Claude did not withdraw the queued steer');
        if (steers === 'withdrawn' && this.heldTurnEnd) {
          // The CLI is idle between the held result and the withdrawn
          // steer's turn: nothing runs that an interrupt could stop.
          this.heldTurnEnd = false;
          this.releaseHeldTurn?.();
          await withDeadline(settled, SDK_CONTROL_TIMEOUT_MS, 'Claude turn did not settle');
          return { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: 'SDK cancel_async_message' };
        }
        const [receipt] = await withDeadline(Promise.all([this.transport!.query.interrupt(), settled]), SDK_CONTROL_TIMEOUT_MS, 'Claude interrupt did not settle');
        // interrupt_receipt_v1: a steer of this turn listed as still queued will run.
        if (receipt?.still_queued?.some((uuid) => this.turnSteers.has(uuid))) throw new Error('A steer survived the interrupt');
        return { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: 'SDK interrupt + result' };
      } catch { /* Retire the owned process if the SDK cannot confirm a boundary. */ }
      finally { this.settleInterrupt = null; }
    }
    // Only a retired process takes its background workflows with it; a
    // confirmed SDK interrupt keeps the process.
    this.workflowTap.expectStop('Stopped with the chat reply: Claude ends background workflows when a turn is stopped');
    try { await this.retireProcess(); }
    catch { return { acknowledged: false, source: 'inferred', confidence: 'unknown' }; }
    return { acknowledged: true, source: 'inferred', confidence: 'unknown', nativeMethod: 'SIGINT/SIGKILL' };
  }

  /**
   * Withdraw the steers the CLI has not started (cancel_async_message).
   * `dequeued`: one was already taken for a turn, which the caller's
   * interrupt then stops. `failed`: the SDK has no such control or did not
   * answer, so one may still run.
   */
  private async withdrawPendingSteers(): Promise<'withdrawn' | 'dequeued' | 'failed'> {
    const uuids = [...this.pendingSteers];
    if (uuids.length === 0) return 'withdrawn';
    const cancelAsyncMessage = this.sdkCancelAsyncMessage();
    if (!cancelAsyncMessage) return 'failed';
    try {
      const removed = await withDeadline(Promise.all(uuids.map((uuid) => cancelAsyncMessage(uuid))),
        SDK_CONTROL_TIMEOUT_MS, 'Claude did not confirm withdrawing the steer');
      uuids.forEach((uuid, index) => { if (removed[index] === true) this.pendingSteers.delete(uuid); });
      return removed.every((value) => value === true) ? 'withdrawn' : 'dequeued';
    } catch (error) {
      this.host.observability.log('warn', 'chat', 'claude steer could not be withdrawn', {
        nodeId: this.nodeId, error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  /**
   * The SDK's cancel_async_message control. Query implements it in the
   * pinned SDK (0.3.306) without declaring it in its types, so it is
   * feature-detected: without it, steering is not offered.
   */
  private sdkCancelAsyncMessage(): ((uuid: string) => Promise<boolean>) | null {
    const query = this.transport?.query as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> } | undefined;
    return typeof query?.cancelAsyncMessage === 'function' ? (uuid) => query.cancelAsyncMessage!(uuid) : null;
  }

  /**
   * Same-turn steer: an SDK user message sent while a turn runs. The CLI
   * folds it into that turn at its next model call (between tool rounds).
   * When the turn makes no further call, the CLI runs it as its own turn
   * right after, and this Michi turn goes on until that one ends
   * (holdTurnEnd), so the reply still belongs to it. command_lifecycle
   * frames (msg_lifecycle_v1) say which happened; Stop withdraws a steer the
   * CLI has not started. Chats only: Agent Runs take input on the next turn.
   */
  async steer(text: string): Promise<SteerResult> {
    if (!text.trim()) return { accepted: false, reason: 'empty' };
    // A slash command would run as a command, not as input to this turn.
    if (text.trimStart().startsWith('/')) return { accepted: false, reason: 'not_queued' };
    if (ownerMode(this.owner) !== 'interactive' || this.host.profile.isRestricted(this.toolProfile) || this.permissionBroker) {
      return { accepted: false, reason: 'unsupported' };
    }
    const transport = this.transport;
    if (this.state !== 'in_turn' || !transport || !this.turnAbort || this.turnAbort.signal.aborted
      || this.cancellation || this.retirement || this.resumePending) {
      return { accepted: false, reason: 'no_active_turn' };
    }
    if (!this.nativeCapabilities.has('msg_lifecycle_v1') || !this.sdkCancelAsyncMessage()) {
      return { accepted: false, reason: 'unsupported' };
    }
    const message: SDKUserMessage = { ...userEnvelope(text), priority: 'next' };
    const uuid = message.uuid!;
    this.pendingSteers.add(uuid);
    this.turnSteers.add(uuid);
    try {
      this.sendInput(message);
    } catch (error) {
      this.pendingSteers.delete(uuid);
      this.turnSteers.delete(uuid);
      return { accepted: false, reason: error instanceof Error ? error.message : 'not_queued' };
    }
    this.history.push({ role: 'user', content: text });
    return { accepted: true, pending: true };
  }

  /**
   * Native compaction: Claude Code's /compact, sent as an SDK user message
   * between turns. Resolves when its result arrives, with the context size
   * before and after from compact_boundary.
   */
  async compact(instructions?: string): Promise<CompactResult> {
    if (this.host.profile.isRestricted(this.toolProfile) || ownerMode(this.owner) !== 'interactive') {
      return { started: false, detail: 'unsupported' };
    }
    if (this.turn || this.state === 'in_turn') {
      return { started: false, detail: 'Wait for the active turn to finish before compacting.' };
    }
    if (this.resumePending) {
      return { started: false, detail: 'Send a message first: Claude restores this conversation on its next turn.' };
    }
    if (this.state !== 'idle' || !this.transport || !this.externalSessionId) {
      return { started: false, detail: 'Claude has no conversation to compact yet.' };
    }
    this.takeTurn('compact');
    try {
      this.lastUsedAt = Date.now();
      this.state = 'in_turn';
      this.markTranslatorTurnStart?.();
      this.takeTranslatorCompaction?.();
      const text = instructions?.trim() ? `/compact ${instructions.trim().replace(/\s+/g, ' ')}` : '/compact';
      this.sendInput(userEnvelope(text));
      let stopReason: string | undefined;
      // Compaction is no conversation turn: its frames are not shown.
      for await (const ev of this.queue.drainUntilTurnEnd()) {
        if (ev.kind === 'turn_end') stopReason = ev.stopReason;
      }
      const compaction = this.takeTranslatorCompaction?.() ?? null;
      const stateAfter = this.state as SessionState;
      if (stateAfter !== 'crashed' && stateAfter !== 'disposed') this.state = 'idle';
      this.lastUsedAt = Date.now();
      if (stopReason !== 'end_turn' || compaction?.result === 'failed' || compaction?.postTokens === undefined) {
        return { started: false, detail: compaction?.error ? `Compaction failed: ${compaction.error}` : 'Claude did not compact the conversation.' };
      }
      return { started: true, completed: true,
        detail: compaction.preTokens !== undefined
          ? `Compacted ${formatTokenCount(compaction.preTokens)} → ${formatTokenCount(compaction.postTokens)} tokens.`
          : `Compacted to ${formatTokenCount(compaction.postTokens)} tokens.` };
    } finally {
      this.releaseTurn();
    }
  }

  private clearInteractions(): void {
    for (const entries of [this.pendingPermissions, this.pendingUserInputs]) {
      for (const entry of entries.values()) { clearTimeout(entry.timer); entry.resolve(null); }
      entries.clear();
    }
  }

  private signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.pid) killProcessTree(child.pid, signal);
    else { try { child.kill(signal); } catch { /* unspawned test/process */ } }
  }

  private retireProcess(): Promise<void> {
    if (this.retirement) return this.retirement;
    const child = this.child;
    const transport = this.transport;
    const queue = this.queue;
    const exit = this.exitPromise;
    if (this.state !== 'disposed') this.state = 'crashed';
    this.clearInteractions();
    // Steers the process had not started go with it.
    this.pendingSteers.clear();
    this.heldTurnEnd = false;
    // Background agents run inside the process and end with it; nothing
    // will report their outcome (the tracker goes with the translator), so
    // they are recorded as ended before the synthetic turn_end below.
    this.endBackgroundSubagents();
    // Publish the barrier before signaling: a child can report exit immediately.
    const work = Promise.resolve().then(async () => {
      try {
        if (child) {
          this.signalProcess(child, 'SIGINT');
          const exited = await withDeadline(exit.then(() => true), this.options.limits.disposeTermTimeoutMs, 'exit timeout').catch(() => false);
          // Kill descendants too, even when their parent handled SIGINT and exited.
          this.signalProcess(child, 'SIGKILL');
          if (!exited) await withDeadline(exit, this.options.limits.disposeKillTimeoutMs, 'Claude process exit could not be confirmed. Original session retained; retry after it stops.');
        }
        transport?.close();
        await this.disposeSlot();
        if (this.child === child) {
          this.transport = null;
          this.child = null;
          this.stopSkillLibraryUpdates?.();
          this.stopSkillLibraryUpdates = null;
          this.skillReloadPending = false;
          this.markTranslatorTurnStart = null;
          this.getNativeForkAnchor = null;
          this.translatorHasBackgroundSubagents = null;
          this.translatorPendingBackgroundSubagents = null;
          this.takeTranslatorCompaction = null;
          this.releaseHeldTurn = null;
        }
        if (this.state === 'disposed') this.fireDisposedCallback();
      } finally {
        queue.push({ kind: 'turn_end', stopReason: this.turnAbort?.signal.aborted ? 'cancelled' : 'error' });
        queue.dispose();
      }
    });
    this.retirement = work;
    void work.finally(() => { if (this.retirement === work) this.retirement = null; }).catch(() => {});
    return work;
  }

  private failProcess(error: Error): void {
    // Before anything else: a failed assistant process runs no more tools.
    this.assistantInitVerified = false;
    if (this.state === 'disposed' || this.state === 'crashed') return;
    this.lastFailure = error.message;
    this.lastGuardError = this.host.profile.isGuardError?.(error) ? error : null;
    this.host.observability.log('error', 'chat', 'claude process failed', {
      nodeId: this.nodeId,
      sessionId: this.id,
      nativeSessionId: this.externalSessionId,
      pid: this.child?.pid,
      resumePending: this.resumePending,
      error: error.message,
    });
    this.queue.push({ kind: 'runtime_error', error: error.message });
    void this.retireProcess().catch(() => {});
  }

  /** Switch models without discarding the native process or session. */
  async setModel(modelId: string): Promise<void> {
    if (this.turn || this.state === 'in_turn') {
      throw new Error('Cannot switch model during an active turn — cancel the turn first');
    }
    if (this.state === 'disposed') {
      throw new Error('Cannot switch model on a disposed session');
    }
    if (!modelId || modelId === this.model) {
      this.model = modelId || this.model;
      return;
    }
    this.takeTurn('model');
    try {
      if (this.retirement) await this.retirement;
      if (this.transport && this.state !== 'crashed') {
        try {
          await withDeadline(this.transport.query.setModel(resolveClaudeCliModelId(modelId)), SDK_CONTROL_TIMEOUT_MS, 'Claude model change timed out');
        } catch (error) {
          // A late ACK after a timeout must not leave native model and durable
          // binding disagreeing. Explicit rejections leave the current model.
          if (error instanceof Error && error.message.includes('timed out')) {
            this.workflowTap.expectStop('Stopped by a model switch: the Claude session restarted');
            await this.retireProcess();
          }
          throw error;
        }
      }
      this.model = modelId;
      // Only an unused, uninitialized process may be replaced without resume.
      if (!this.transport && !this.externalSessionId && !this.firstTurnPrefixConsumed) {
        await this.spawnFresh();
      } else if (this.transport && this.state !== 'crashed') {
        // Whether Ultracode can run depends on the model (xhigh effort).
        void this.refreshUltracodeReport(this.transport);
      }
    } finally {
      this.releaseTurn();
    }
  }

  getSessionState(): import('michi-shared').AgentSessionState {
    const modes = this.supportsModes();
    return { runtimeId: 'claude', nativeEngine: 'agent-sdk', version: this.stateVersion, modelId: this.currentModelId,
      currentModeId: this.currentModeId,
      availableModes: modes ? CLAUDE_MODES.map(({ id, label, description }) => ({ id, name: label, description })) : [],
      commands: [...claudeHostCommands(), ...this.advertisedSkills()],
      ...(this.supportsUltracode() ? { ultracode: this.ultracodeState() } : {}) };
  }

  /**
   * A restricted session (the Michi assistant) takes no skill turns, so its
   * menu offers none; nor does a host that shows no host skills.
   */
  private advertisedSkills(): import('michi-shared').AgentCommand[] {
    if (this.host.profile.isRestricted(this.toolProfile) || this.options.advertiseSkills?.() === false) return [];
    // The host lists its library itself.
    return claudeSkillCommands(withoutClaudeLibraryRows(this.nativeCommands, this.nativeLibrary));
  }

  /** The CLI's command table for `transport`: its initialize answer, or a later push, which replaces it. */
  private observeNativeCommands(transport: ClaudeSdkTransport, value: unknown, pushed: boolean): void {
    if (this.transport !== transport || (!pushed && this.nativeCommandsOf === transport)) return;
    const commands = parseClaudeSlashCommands(value);
    if (!commands) return;
    const before = JSON.stringify(this.advertisedSkills());
    this.nativeCommands = commands;
    this.nativeCommandsOf = transport;
    this.nativeTables += 1;
    if (this.nextLibrary) {
      this.nativeLibrary = this.nextLibrary;
      this.nextLibrary = null;
    }
    if (JSON.stringify(this.advertisedSkills()) !== before) this.publishSessionState();
  }

  /** The library a reload loaded, with the table its push has already brought. */
  private applyReloadedLibrary(library: ClaudeSkillLibrary): void {
    const before = JSON.stringify(this.advertisedSkills());
    this.nativeLibrary = library;
    this.nextLibrary = null;
    if (JSON.stringify(this.advertisedSkills()) !== before) this.publishSessionState();
  }

  /**
   * The command line that runs a skill as the CLI's own command, or null
   * when the live process does not list it under that name: the CLI would
   * send an unknown command to the model as text, a turn spent on nothing.
   * A library skill is `<folder>:<name>` where a personal or project skill
   * has its name, else `<name>` (claudeLibraryCommand). A runtime skill
   * whose row is the library skill's (a project command it hides) is sent
   * as its text.
   */
  private async nativeSkillCommand(skill: SkillTurnInvocation, signal: AbortSignal): Promise<string | null> {
    // The host's built-in skills are never mounted: a CLI command of their name is another one.
    if (skill.origin === 'builtin') return null;
    const library = skill.origin === 'library' && !skill.nativeName;
    if (library && !this.spawnedSkillDir) return null;
    const transport = this.transport;
    if (!transport) return null;
    if (this.nativeCommandsOf !== transport) {
      // A process that has just started may not have answered initialize yet.
      // Without an answer the skill is expanded instead.
      const answered = Promise.resolve(transport.initialized).then(() => undefined, () => undefined);
      await abortable(withDeadline(answered, SDK_CONTROL_TIMEOUT_MS, 'Claude did not list its commands').catch(() => undefined), signal);
    }
    if (this.transport !== transport || this.nativeCommandsOf !== transport) return null;
    const own = skill.nativeName ?? skill.name;
    const name = library ? claudeLibraryCommand(this.nativeCommands, this.nativeLibrary, skill.name)
      : claudeRunsOwnCommand(this.nativeCommands, own) && !claudeLibraryRow(this.nativeCommands, this.nativeLibrary, own) ? own : null;
    if (!name) return null;
    return `/${name}${skill.args ? ` ${skill.args}` : ''}`;
  }

  /**
   * The library changed. The CLI does not notice its links change: reload
   * the skills of an idle process now and of a busy one once its turn ends,
   * so a running turn keeps the listing it started with.
   */
  private onSkillLibraryChanged(transport: ClaudeSdkTransport): void {
    if (this.transport !== transport) return;
    if (this.state === 'in_turn') this.skillReloadPending = true;
    else this.reloadNativeSkills(transport);
  }

  /**
   * Its commands_changed push updates the command table. The library is
   * read just before, as the CLI is about to load it, and goes with the
   * reloaded table: CLI 2.1.319 pushes that just before it answers; from a
   * CLI that answers first, the next push brings it. Until then the old
   * names stand, so a skill added meanwhile is sent as its text. Failures
   * leave the old skills.
   */
  private reloadNativeSkills(transport: ClaudeSdkTransport): void {
    this.skillReloadPending = false;
    if (this.transport !== transport || this.state === 'crashed' || this.state === 'disposed') return;
    const query = transport.query as Partial<Pick<typeof transport.query, 'reloadSkills'>>;
    const reloadSkills = query.reloadSkills;
    if (typeof reloadSkills !== 'function') return;
    const dir = this.spawnedSkillDir;
    void (async () => {
      const library = dir ? await readClaudeSkillLibrary(dir) : NO_CLAUDE_SKILL_LIBRARY;
      if (this.transport !== transport) return;
      const tables = this.nativeTables;
      await withDeadline(reloadSkills.call(transport.query), SDK_CONTROL_TIMEOUT_MS, 'Claude skill reload timed out');
      if (this.transport !== transport) return;
      if (this.nativeTables !== tables) this.applyReloadedLibrary(library);
      else this.nextLibrary = library;
    })()
      .catch((error) => {
        if (this.transport !== transport) return;
        this.host.observability.log('warn', 'chat', 'claude skills could not be reloaded', {
          nodeId: this.nodeId, error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  onSessionState(notify: () => void): () => void {
    this.stateListeners.add(notify);
    return () => { this.stateListeners.delete(notify); };
  }

  // ---- Work modes (Default / Plan) -------------------------------------------

  /** Chats have modes; Agent Runs, Run brokers and restricted sessions do not. */
  private supportsModes(): boolean {
    return ownerMode(this.owner) === 'interactive' && !this.host.profile.isRestricted(this.toolProfile) && !this.permissionBroker;
  }

  /** The SDK mode the approval policy maps to (Default work mode). */
  private policyNativeMode(): 'default' | 'bypassPermissions' {
    const permissionMode = (this.turnAbort ? this.turnPermissionMode : undefined) ?? this.host.permissions.mode(this.owner, this.ownerUserId);
    return claudeSpawnPolicy(this.host.profile.isRestricted(this.toolProfile), {
      ownerMode: ownerMode(this.owner), permissionMode, toolProfile: this.toolProfile,
    }).permissionMode;
  }

  private desiredNativeMode(): PermissionMode {
    return this.supportsModes() && this.workMode === 'plan' ? 'plan' : this.policyNativeMode();
  }

  /** Set the SDK permission mode of the live process, after any earlier change. */
  private applyNativeMode(target: PermissionMode): Promise<void> {
    const run = this.nativeModeOp.catch(() => {}).then(async () => {
      const transport = this.transport;
      if (!transport || this.nativePermissionMode === target) return;
      await withDeadline(transport.query.setPermissionMode(target), SDK_CONTROL_TIMEOUT_MS, 'Claude permission mode change timed out');
      if (this.transport === transport) this.nativePermissionMode = target;
    });
    this.nativeModeOp = run;
    return run;
  }

  /**
   * The CLI reported its permission mode. It leaves plan mode itself when
   * the user approves a plan (restoring the mode it had before planning)
   * and enters it when the model calls EnterPlanMode. The work mode follows;
   * on leaving plan mode the approval policy's mode is restored, so a
   * change of policy during planning, or a respawn in plan, still applies.
   */
  private observeNativeMode(mode: PermissionMode): void {
    this.nativePermissionMode = mode;
    if (!this.supportsModes()) return;
    const next: ClaudeWorkMode = mode === 'plan' ? 'plan' : 'default';
    if (next === this.workMode) return;
    this.workMode = next;
    this.publishSessionState();
    if (next === 'default') {
      const policy = this.policyNativeMode();
      // If this fails the next turn applies it (send compares the modes).
      if (mode !== policy) void this.applyNativeMode(policy).catch((error) => {
        this.host.observability.log('warn', 'chat', 'claude permission mode could not be restored after planning', {
          nodeId: this.nodeId, mode, policy, error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  // ---- Ultracode ---------------------------------------------------------------

  /**
   * Only an ordinary chat runs Ultracode: it has the Workflow tool. Agent
   * Runs, brokered and restricted sessions and chats with a tool profile (the
   * assistant, custom agents) never do; their spawns pin it off.
   */
  private supportsUltracode(): boolean {
    return this.supportsModes() && !this.toolProfile;
  }

  /** The chat's Ultracode choice, read from the host; off for other sessions. */
  private desiredUltracode(): boolean {
    if (!this.supportsUltracode()) return false;
    try {
      return this.host.config.features.ultracode?.(this.owner, this.ownerUserId) === true;
    } catch (error) {
      this.host.observability.log('warn', 'chat', 'claude ultracode choice could not be read; leaving it off', {
        nodeId: this.nodeId, error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private ultracodeState(): import('michi-shared').SessionUltracodeState {
    const reported = this.ultracodeReported;
    return {
      requested: this.ultracodeWanted,
      ...(reported ? { active: reported.active && !this.spawnedBare, available: reported.available && !this.spawnedBare } : {}),
    };
  }

  /**
   * Bring the live process to the chat's Ultracode choice before a turn: a
   * warm process was spawned before it knew the chat, and an earlier change
   * may have failed. A failure leaves the turn to run as the CLI is.
   */
  private async reconcileUltracode(signal: AbortSignal): Promise<void> {
    // Changes still in flight first: compare with the process as they leave it.
    await abortable(this.nativeUltracodeOp, signal);
    const wanted = this.desiredUltracode();
    const changed = wanted !== this.ultracodeWanted;
    this.ultracodeWanted = wanted;
    const transport = this.transport;
    if (transport && this.state !== 'crashed' && this.nativeUltracode !== wanted
      && await abortable(this.applyNativeUltracode(wanted), signal)) {
      // What took effect is for the indicator: the prompt does not wait for it.
      void this.refreshUltracodeReport(transport);
    }
    if (changed) this.publishSessionState();
  }

  /**
   * Set Ultracode in the live process (the SDK flag-settings layer), after any
   * earlier change. Resolves whether it changed the process; never rejects:
   * a failure is logged and the next turn tries again.
   */
  private applyNativeUltracode(enabled: boolean): Promise<boolean> {
    const run = this.nativeUltracodeOp.then(async () => {
      const transport = this.transport;
      if (!transport || this.state === 'crashed' || this.state === 'disposed' || this.nativeUltracode === enabled) return false;
      const query = transport.query as Partial<Pick<typeof transport.query, 'applyFlagSettings'>>;
      if (typeof query.applyFlagSettings !== 'function') return false;
      try {
        await withDeadline(query.applyFlagSettings.call(transport.query, { ultracode: enabled }), SDK_CONTROL_TIMEOUT_MS,
          'Claude Ultracode change timed out');
        if (this.transport !== transport) return false;
        this.nativeUltracode = enabled;
        return true;
      } catch (error) {
        if (this.transport === transport) this.nativeUltracode = null;
        this.host.observability.log('warn', 'chat', 'claude ultracode could not be applied; the next turn retries', {
          nodeId: this.nodeId, enabled, error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
    this.nativeUltracodeOp = run.then(() => undefined);
    return run;
  }

  /** Apply the wanted choice in the background, then read what took effect. */
  private syncNativeUltracode(transport: ClaudeSdkTransport): void {
    if (this.nativeUltracode === this.ultracodeWanted) return;
    void this.applyNativeUltracode(this.ultracodeWanted).then((applied) => {
      if (applied) void this.refreshUltracodeReport(transport);
    });
  }

  /**
   * What the CLI reports of Ultracode (get_settings `applied`): in effect only
   * when requested, with workflows enabled and a model that supports it. The
   * SDK implements getSettings without declaring it. The response carries
   * every settings source (env, hooks): read `applied` and log none of it.
   */
  private async refreshUltracodeReport(transport: ClaudeSdkTransport): Promise<void> {
    if (!this.supportsUltracode()) return;
    const query = transport.query as unknown as { getSettings?: () => Promise<unknown> };
    if (typeof query.getSettings !== 'function') return;
    let applied: Record<string, unknown> | null;
    try {
      applied = asRecord(asRecord(await withDeadline(query.getSettings.call(transport.query), SDK_CONTROL_TIMEOUT_MS,
        'Claude settings read timed out'))?.applied);
    } catch (error) {
      this.host.observability.log('debug', 'chat', 'claude ultracode state could not be read', {
        nodeId: this.nodeId, error: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    if (this.transport !== transport || !applied || typeof applied.ultracodeAvailable !== 'boolean') return;
    const next = { active: applied.ultracode === true, available: applied.ultracodeAvailable };
    const previous = this.ultracodeReported;
    if (previous?.active === next.active && previous.available === next.available) return;
    this.ultracodeReported = next;
    this.publishSessionState();
  }

  /**
   * The chat's Ultracode choice changed (the host has saved it): apply it to
   * the live process now, so a self-turn before the next message (a workflow
   * completing) already runs under it. Without a process the next spawn reads it.
   */
  async setUltracode(enabled: boolean): Promise<void> {
    if (!this.supportsUltracode()) {
      if (!enabled) return;
      throw new Error('Ultracode is available only in Claude chats without a custom agent or tool profile');
    }
    if (this.state === 'disposed') return;
    if (this.ultracodeWanted !== enabled) {
      this.ultracodeWanted = enabled;
      this.publishSessionState();
    }
    // Outside a turn, so the caller (the toggle) gets what took effect.
    const transport = this.transport;
    if (transport && this.state !== 'crashed' && await this.applyNativeUltracode(enabled)) await this.refreshUltracodeReport(transport);
  }

  /** A changed mode reaches the running turn's stream and every state listener. */
  private publishSessionState(): void {
    this.stateVersion = nextStateVersion();
    const state = this.getSessionState();
    // Outside a turn a queued event would open a self-turn; listeners carry it.
    if (this.state === 'in_turn' && this.turnAbort && !this.turnAbort.signal.aborted) {
      this.queue.push({ kind: 'session_state', state });
    }
    for (const notify of [...this.stateListeners]) {
      try { notify(); } catch { /* a listener's failure is its own */ }
    }
  }

  /**
   * Switch the work mode. Plan is a chat feature: an Agent Run (or a
   * restricted session) accepts only Default. With a live process the SDK
   * mode changes at once, also during a turn; otherwise the next spawn uses it.
   */
  async setMode(modeId: string): Promise<void> {
    if (!isClaudeWorkMode(modeId)) throw new Error(`Unknown Claude mode: ${modeId}`);
    if (!this.supportsModes()) {
      if (modeId === 'default') return;
      throw new Error('Plan mode is available only in Claude chats, not in Agent Runs or restricted sessions');
    }
    if (this.state === 'disposed') throw new Error('Cannot switch mode on a disposed session');
    if (modeId === this.workMode) return;
    const previous = this.workMode;
    this.workMode = modeId;
    try {
      if (this.transport && this.state !== 'crashed') await this.applyNativeMode(this.desiredNativeMode());
    } catch (error) {
      this.workMode = previous;
      throw error;
    }
    this.publishSessionState();
  }

  /** Host command bridge over official SDK controls; these are not TUI pages. */
  async executeCommand(command: string, args?: Record<string, unknown>): Promise<{ success: boolean; message?: string; data?: unknown }> {
    if (this.turn || this.state === 'in_turn') throw new Error('Wait for the active turn to finish before executing a command.');
    if (this.state !== 'idle' || !this.transport) return { success: false, message: 'Claude session is not connected.' };
    const query = this.transport.query;
    if (command === 'model' && typeof args?.value === 'string' && args.value.trim()) {
      await this.setModel(args.value.trim());
      return { success: true, message: `Model changed to ${this.currentModelId}.` };
    }
    this.takeTurn('command');
    try {
      if (command === 'status') return { success: true, message: 'Claude session status', data: {
        engine: 'Claude Agent SDK', state: this.state, sessionId: this.externalSessionId,
        model: this.currentModelId, permissionMode: this.nativePermissionMode,
        mcp: await withDeadline(query.mcpServerStatus(), SDK_CONTROL_TIMEOUT_MS, 'Claude status timed out'),
      } };
      if (command === 'model') return { success: true, data: { current: this.currentModelId,
        models: await withDeadline(query.supportedModels(), SDK_CONTROL_TIMEOUT_MS, 'Claude model list timed out') } };
      if (command === 'context') return { success: true, data: await withDeadline(query.getContextUsage({ detail: 'summary' }), SDK_CONTROL_TIMEOUT_MS, 'Claude context timed out') };
      if (command === 'mcp') return { success: true, data: await withDeadline(query.mcpServerStatus(), SDK_CONTROL_TIMEOUT_MS, 'Claude MCP status timed out') };
      return { success: false, message: `/${command} is not available through the Claude SDK command bridge.` };
    } finally { this.releaseTurn(); }
  }

  respondToPermission(requestId: number, optionId: string): void {
    assertPermissionAnswer(this.owner, optionId);
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(requestId);
    entry.resolve(optionId);
  }

  cancelPermission(requestId: number): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(requestId);
    entry.resolve(null);
  }

  respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>): void {
    const entry = this.pendingUserInputs.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingUserInputs.delete(requestId);
    entry.resolve(answers);
  }

  skipUserInput(requestId: number): void {
    const entry = this.pendingUserInputs.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingUserInputs.delete(requestId);
    entry.resolve(null);
  }

  async dispose(): Promise<void> {
    // A prior disposal may have timed out with the process still owned here.
    if (this.disposedCallbackFired) return;
    this.state = 'disposed';
    this.idleGate.open(); // Unblock idle pump so it can check state and exit
    this.queue.dispose();
    this.markTranslatorTurnStart = null;
    this.translatorHasBackgroundSubagents = null;

    // Reject pending permissions
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingPermissions.clear();

    // Reject pending user inputs
    for (const [, entry] of this.pendingUserInputs) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingUserInputs.clear();

    this.turnAbort?.abort();
    await this.retireProcess();

    await this.disposeSlot();

    this.fireDisposedCallback();
  }

  onDisposed(cb: () => void): void {
    this.disposedCallback = cb;
    if (this.disposedCallbackFired) cb();
  }

  /**
   * Register a callback invoked when the session receives a self-initiated
   * turn (e.g. a background task-notification completion). The callback
   * receives an async iterator of NormalizedEvents for the self-turn.
   */
  onSelfTurn(cb: SelfTurnCallback): void {
    this.selfTurnCallback = cb;
  }

  // ---- Idle pump -------------------------------------------------------------

  /**
   * Background loop that drains events pushed to the queue while the session
   * is idle (no active send/warmInit). When it detects the start of a
   * self-initiated turn, it emits the events via selfTurnCallback.
   *
   * Coordination with every other turn owner (takeTurn):
   *   - claiming the turn closes idleGate and wakes a pump waiting in pull()
   *   - idlePump awaits idleGate.wait() before each pull()
   *   - releasing the turn opens idleGate again
   *
   * The pump auto-stops when the session is disposed or crashed.
   */
  private startIdlePump(): void {
    if (this.idlePumpRunning) return;
    this.idlePumpRunning = true;

    const run = async () => {
      while (this.state !== 'disposed' && this.state !== 'crashed') {
        await this.idleGate.wait();
        if ((this.state as SessionState) === 'disposed' || (this.state as SessionState) === 'crashed') break;
        // Re-check gate: due to microtask ordering, the gate may have been
        // re-closed between wait() resolving and this continuation running.
        if (!this.idleGate.isOpen) continue;

        const ev = await this.queue.pull();
        if ((this.state as SessionState) === 'disposed' || (this.state as SessionState) === 'crashed') break;
        if (ev === null) {
          // null means either queue disposed or send() interrupted us.
          // If queue is disposed, exit. Otherwise loop back to gate.wait().
          if (this.queue.isDisposed) break;
          continue;
        }

        // Heartbeats in idle are noise — skip
        if (ev.kind === 'heartbeat') continue;

        // A real event arrived while idle → self-initiated turn. Claim the
        // session's turn before yielding the first frame, synchronously, so a
        // racing send() cannot interrupt the self iterator's queue waiter.
        try {
          this.takeTurn('self');
        } catch {
          // Race: another owner claimed the turn between our pull() and this
          // point. Push the event back so its owner can drain it, then loop
          // back to gate.wait(), which blocks: that owner closed the gate.
          this.queue.pushFront(ev);
          continue;
        }
        const controller = this.turnAbort ?? new AbortController();
        this.turnAbort = controller;
        let completed = false;
        try {
          this.state = 'in_turn';
          this.lastUsedAt = Date.now();
          this.turnPermissionMode = this.host.permissions.mode(this.owner, this.ownerUserId);

          // Build an async iterator that yields this first event + rest of
          // turn. The pump MUST await full consumption before releasing the
          // mutex — EventQueue has a single waiter slot.
          let drainResolve!: () => void;
          const drainDone = new Promise<void>((r) => { drainResolve = r; });
          const firstEvent = ev;
          const queue = this.queue;
          // A native result can arrive before the SDK's interrupt ACK. Keep
          // the self-turn owned until both settle, just as send() does, so a
          // later send/cancel cannot accidentally operate on this cancellation.
          const settleTerminal = async (event: Extract<NormalizedEvent, { kind: 'turn_end' }>): Promise<NormalizedEvent> => {
            if (this.cancellation) await this.cancellation;
            completed = true;
            return controller.signal.aborted ? { ...event, stopReason: 'cancelled' } : event;
          };
          async function* selfTurnIterator(): AsyncIterableIterator<NormalizedEvent> {
            try {
              yield firstEvent.kind === 'turn_end' ? await settleTerminal(firstEvent) : firstEvent;
              if (firstEvent.kind === 'turn_end') return;
              for await (const next of queue.drainUntilTurnEnd()) {
                yield next.kind === 'turn_end' ? await settleTerminal(next) : next;
              }
            } finally {
              drainResolve();
            }
          }

          const events = selfTurnIterator();
          if (!this.selfTurnCallback) {
            for await (const discard of events) void discard;
          } else {
            try {
              this.selfTurnCallback({
                chatId: this.id,
                owner: this.owner,
                ownerUserId: this.ownerUserId,
                events,
              });
            } catch (err) {
              // A synchronous callback failure must still release the pump's
              // single waiter; consume the already-claimed runtime turn.
              for await (const discard of events) void discard;
              throw err;
            }
            await drainDone;
          }

          this.lastUsedAt = Date.now();
        } finally {
          // A consumer can return early after durable cancellation/failure.
          // It does not prove that the native self-turn stopped.
          const stateAfterDrain = this.state as SessionState;
          if (!completed && stateAfterDrain !== 'crashed' && stateAfterDrain !== 'disposed') {
            controller.abort();
            await this.retireProcess().catch(() => {});
          }
          if (this.cancellation) await this.cancellation;
          if (this.turnAbort === controller) this.turnAbort = null;
          if (completed && this.state === 'in_turn') this.state = 'idle';
          this.releaseTurn();
        }
      }
      this.idlePumpRunning = false;
    };

    run().catch((err) => {
      console.warn('[ClaudeSession] idle pump error:', err);
      this.idlePumpRunning = false;
    });
  }

  // ---- Spawn ------------------------------------------------------------------

  async spawnFresh(forkFrom?: string): Promise<void> {
    if (this.retirement) await this.retirement;
    if (this.child) await this.retireProcess();
    this.turnAbort?.signal.throwIfAborted();
    if (this.state === 'disposed') throw new Error('Claude session was disposed during startup');
    const tSpawnFresh = this.perf.now();
    this.perf.mark('claude:spawn_fresh_start', { sid: this.id });
    const slot = this.mcpRegistry.create(this.id, this.cwd, this.ownerUserId ?? null, {
      owner: this.owner,
      getActivePageTurnAttribution: () => this.getActivePageTurnAttribution(),
      exposedToolNames: this.toolProfile?.allowedToolNames ? new Set(this.toolProfile.allowedToolNames) : undefined,
      // The host's tools report their effect (branches, artifacts, images) here.
      sink: hostEventSink((event) => this.queue.push(event)),
      ...this.bridgeSlotCallbacks(),
      onShowImage: (inputPath) => {
        if (!this.isToolAllowed('show_image')) return { error: 'show_image is not enabled for this session' };
        const r = resolveShowImage(this.cwd, inputPath);
        if (!r.ok) return { error: r.error };
        return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
      },
      onAskUser: this.makeOnAskUser(),
      agentRuns: this.resolveAgentRunTools(),
      agentRunToolNames: this.allowedAgentRunToolNames(),
      onSubmitAgentResult: this.submitAgentResultCallback(),
      ...this.assistantSlotExposure(),
      // Tools the host marks loadUpFront (Michi's memory tools) skip Claude Code's tool search: the model sees their descriptions.
      upFrontToolMeta: CLAUDE_UP_FRONT_TOOL_META,
    }, {
      nodeId: ownerMode(this.owner) === 'interactive' ? this.nodeId : null,
      workspaceId: this.workspaceId,
    });
    this.slotId = slot.slotId;

    const mcpConfig = buildClaudeMcpConfig(this.mcpRegistry.endpoint(slot.slotId), {
      // The assistant has no ToolSearch to load deferred tools: its Michi tools load up front.
      alwaysLoad: ownerMode(this.owner) === 'headless' || this.host.profile.isRestricted(this.toolProfile),
    });
    // claude --session-id requires UUID format; michi nodeIds don't conform.
    // The placeholder is overwritten when system/init reports the real session_id.
    const sessionId = randomUUID();
    // Pin the CHILD identity before init, never the source token. Forking must
    // not repair, append to, or publish the parent's JSONL as the child's state.
    if (forkFrom) this.externalSessionId = sessionId;
    await this.doSpawn({ sessionId, resumeSessionId: forkFrom, forkSession: !!forkFrom, mcpConfig });
    this.perf.measure('claude:spawn_fresh', tSpawnFresh, { sid: this.id });
  }

  async spawnResume(externalSessionId: string): Promise<void> {
    if (this.ephemeral) throw new NativeResumeUnavailableError('An ephemeral Claude session is never resumed');
    if (this.retirement) await this.retirement;
    if (this.child) await this.retireProcess();
    this.turnAbort?.signal.throwIfAborted();
    if (this.state === 'disposed') throw new Error('Claude session was disposed during startup');
    // The caller supplied a validated opaque resume token. Retain it before
    // the CLI emits its next system/init envelope so crash/cancel recovery can
    // immediately describe the native state.
    this.externalSessionId = externalSessionId;
    // Invariant 4: JSONL tail integrity check
    this.checkAndRepairJsonl(this.cwd, externalSessionId, this.ownerUserId);

    // Dispose the old slot before creating a new one (each process needs a fresh slot).
    await this.disposeSlot();
    this.turnAbort?.signal.throwIfAborted();
    if (this.getState() === 'disposed') throw new Error('Claude session was disposed during startup');

    const slot = this.mcpRegistry.create(this.id, this.cwd, this.ownerUserId ?? null, {
      owner: this.owner,
      getActivePageTurnAttribution: () => this.getActivePageTurnAttribution(),
      exposedToolNames: this.toolProfile?.allowedToolNames ? new Set(this.toolProfile.allowedToolNames) : undefined,
      // The host's tools report their effect (branches, artifacts, images) here.
      sink: hostEventSink((event) => this.queue.push(event)),
      ...this.bridgeSlotCallbacks(),
      onShowImage: (inputPath) => {
        if (!this.isToolAllowed('show_image')) return { error: 'show_image is not enabled for this session' };
        const r = resolveShowImage(this.cwd, inputPath);
        if (!r.ok) return { error: r.error };
        return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
      },
      onAskUser: this.makeOnAskUser(),
      agentRuns: this.resolveAgentRunTools(),
      agentRunToolNames: this.allowedAgentRunToolNames(),
      onSubmitAgentResult: this.submitAgentResultCallback(),
      ...this.assistantSlotExposure(),
      // Tools the host marks loadUpFront (Michi's memory tools) skip Claude Code's tool search: the model sees their descriptions.
      upFrontToolMeta: CLAUDE_UP_FRONT_TOOL_META,
    }, {
      nodeId: ownerMode(this.owner) === 'interactive' ? this.nodeId : null,
      workspaceId: this.workspaceId,
    });
    this.slotId = slot.slotId;

    const mcpConfig = buildClaudeMcpConfig(this.mcpRegistry.endpoint(slot.slotId), {
      // The assistant has no ToolSearch to load deferred tools: its Michi tools load up front.
      alwaysLoad: ownerMode(this.owner) === 'headless' || this.host.profile.isRestricted(this.toolProfile),
    });
    await this.doSpawn({ resumeSessionId: externalSessionId, mcpConfig });
  }

  // ---- Private helpers -------------------------------------------------------

  private async doSpawn(opts: { sessionId?: string; resumeSessionId?: string; forkSession?: boolean; mcpConfig: string }): Promise<void> {
    this.turnAbort?.signal.throwIfAborted();
    if (this.state === 'disposed') throw new Error('Claude session was disposed during startup');
    this.state = 'spawning';
    this.resumePending = !!opts.resumeSessionId;
    this.assistantInitVerified = false;
    this.lastFailure = null;
    this.lastGuardError = null;

    // Reset queue for new spawn
    this.queue.dispose();
    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'idle' || this.state === 'in_turn') {
        this.queue.push({ kind: 'heartbeat', idleMs });
      }
    });
    const queue = this.queue;
    const isCurrent = () => this.queue === queue && this.state !== 'crashed' && this.state !== 'disposed';

    const translator = createTranslator((ev) => {
      if (!isCurrent()) return;
      if (this.turnAbort?.signal.aborted && (ev.kind === 'mcp_server_error'
        || (ev.kind === 'warning' && (ev.source === 'anthropic-api' || ev.source === 'claude-cli')))) return;
      // Drive the idle transition from the claude process's own end-of-turn
      // signal (the `result` envelope, which the translator turns into
      // turn_end) rather than from whether the HTTP consumer drains the
      // generator. The /chats/:id/message route breaks its for-await on
      // turn_end, which invokes the generator's .return() and unwinds straight
      // to send()'s finally — skipping the post-loop `state = 'idle'`
      // assignment. That left every finished session pinned in `in_turn`
      // forever, and reclaimActiveSession only reclaims idle/crashed/disposed,
      // so the slots were never reclaimable (→ ClaudeConcurrencyError 503s with
      // only a few sessions actually busy). Flipping here decouples liveness
      // from the consumer. Guarded on `in_turn` so synthetic turn_ends pushed
      // on crash/exit (state already 'crashed') don't get clobbered to idle.
      if (ev.kind === 'turn_end' && this.state === 'in_turn') {
        this.state = 'idle';
        this.lastUsedAt = Date.now();
        if (this.turn) this.turn.nativeEnded = true;
      }
      if (ev.kind === 'turn_end' && this.skillReloadPending && this.transport) this.reloadNativeSkills(this.transport);
      if (ev.kind === 'turn_end') this.settleInterrupt?.();
      if (ev.kind === 'turn_end') {
        this.heldTurnEnd = false;
        // A turn that failed with a steer still queued: withdraw it rather
        // than let it start a turn of its own (Stop withdraws it itself).
        if (this.pendingSteers.size > 0 && !this.turnAbort?.signal.aborted) void this.withdrawPendingSteers();
      }
      this.queue.push(ev.kind === 'turn_end' && this.turnAbort?.signal.aborted
        ? { ...ev, stopReason: 'cancelled' } : ev);
    }, {
      // Background agents live in this process; retireProcess withdraws them.
      onBackgroundSubagents: (ids) => { if (isCurrent()) this.reportBackgroundSubagents(ids); },
      // A steer the CLI has not started when this result arrives runs as its
      // own CLI turn next; the host's turn goes on until that one ends.
      holdTurnEnd: () => {
        const hold = isCurrent() && this.state === 'in_turn' && this.pendingSteers.size > 0
          && !!this.turnAbort && !this.turnAbort.signal.aborted;
        if (hold) this.heldTurnEnd = true;
        return hold;
      },
    });
    this.markTranslatorTurnStart = translator.startTurn;
    this.getNativeForkAnchor = translator.getForkAnchor;
    this.translatorHasBackgroundSubagents = translator.hasBackgroundSubagents;
    this.translatorPendingBackgroundSubagents = translator.pendingBackgroundSubagents;
    this.takeTranslatorCompaction = translator.takeCompaction;
    this.releaseHeldTurn = translator.releaseHeldTurn;
    this.pendingSteers.clear();
    this.turnSteers.clear();
    this.heldTurnEnd = false;
    this.nativeCapabilities = new Set();
    this.authRetryPending = false;

    const onMessage = (envelope: Record<string, unknown>) => {
        if (!isCurrent()) return;
        // msg_lifecycle_v1: the CLI reports each uuid-stamped user message
        // as queued, started (taken into a turn), completed or cancelled.
        if (envelope.type === 'command_lifecycle') {
          const uuid = envelope.command_uuid;
          if (typeof uuid !== 'string' || envelope.state === 'queued' || !this.pendingSteers.delete(uuid)) return;
          if (envelope.state === 'started') this.heldTurnEnd = false;
          // The CLI dropped the steer a held turn was waiting for: no CLI
          // turn follows, so the held result ends the host's turn after all.
          else if (this.heldTurnEnd && this.pendingSteers.size === 0 && !this.turnAbort?.signal.aborted) {
            this.heldTurnEnd = false;
            translator.releaseHeldTurn();
          }
          return;
        }
        // The whole command table again, after skills or plugins changed.
        if (envelope.type === 'system' && envelope.subtype === 'commands_changed') {
          if (this.transport) this.observeNativeCommands(this.transport, envelope.commands, true);
          return;
        }
        if (envelope.type === 'system' && envelope.subtype === 'api_retry' && envelope.error === 'authentication_failed') {
          // Let the CLI's first retry renew expired credentials unseen; fail
          // fast if its credentials are still rejected, rather than back off.
          if (this.authRetryPending) {
            this.failProcess(new Error('Claude authentication failed. Refresh the CLI credentials and retry; the original session is retained.'));
            return;
          }
          this.authRetryPending = true;
          this.host.observability.log('info', 'chat', 'claude authentication retry', {
            nodeId: this.nodeId,
            sessionId: this.id,
            attempt: typeof envelope.attempt === 'number' ? envelope.attempt : undefined,
          });
          return;
        }
        if (['assistant', 'stream_event', 'result'].includes(String(envelope.type))) this.authRetryPending = false;
        const isInit = envelope['type'] === 'system' && envelope['subtype'] === 'init';
        if (this.resumePending && !isInit) {
          if (['assistant', 'stream_event', 'result'].includes(String(envelope['type']))) {
            this.failProcess(new Error('Claude native restore produced output before confirming its session identity. Original session retained; please retry.'));
          }
          return;
        }
        // The Michi assistant's process may not answer before its init has
        // been checked: on a new spawn as on a restore.
        if (!isInit && this.host.profile.isRestricted(this.toolProfile) && !this.assistantInitVerified) {
          if (['assistant', 'stream_event', 'result'].includes(String(envelope['type']))) {
            this.failProcess(catalogUnavailable(this.host, this.runtimeId, this.host.profile.toolset?.(this.toolProfile) ?? 'restricted',
              'Claude Code answered before reporting its tools and settings'));
          }
          return;
        }
        // Invariant 6: persist external_session_id on init before forwarding events
        if (isInit) {
          if (!this.initSeenThisTurn && this.stdinWriteAt) {
            this.initSeenThisTurn = true;
            this.perf.measure('claude:stdin_to_cli_init', this.stdinWriteAt, { sid: this.id });
          }
          const sessionId = envelope['session_id'];
          if (typeof sessionId !== 'string' || !sessionId.trim()) {
            this.failProcess(new Error('Claude initialization did not provide a valid session identity. Original session retained; please retry.'));
            return;
          }
          if (this.externalSessionId && this.externalSessionId !== sessionId) {
            this.failProcess(new Error('Claude native resume returned a different session identity. Original binding retained; please retry.'));
            return;
          }
          // A Meta agent process must report only its toolset's Michi tools,
          // Michi's MCP server alone and no bypass (assistant/policy.ts).
          // Init leads the first turn's output; any tool call that turn makes
          // meanwhile is denied by the PreToolUse hook and canUseTool anyway.
          if (this.host.profile.isRestricted(this.toolProfile)) {
            try {
              assertToolCatalog(this.host, { runtimeId: this.runtimeId, profile: this.toolProfile, observed: claudeInitCatalog(envelope) });
            } catch (error) {
              this.failProcess(error as Error);
              return;
            }
            this.assistantInitVerified = true;
          }
          // Keep the native token available for retry even when its DB write fails.
          this.externalSessionId = sessionId;
          const capabilities = envelope['capabilities'];
          if (Array.isArray(capabilities)) {
            this.nativeCapabilities = new Set(capabilities.filter((value): value is string => typeof value === 'string'));
          }
          // Recorded synchronously, before this envelope reaches the
          // translator: a throw stops the process before any event of it.
          if (this.persistNativeIdentity && isInteractiveOwner(this.owner)) {
            try {
              this.host.bindings.recordNativeSessionId(this.owner, sessionId);
            } catch (err) {
              this.failProcess(new Error(`Claude session identity could not be persisted: ${err instanceof Error ? err.message : String(err)}. Native identity retained in memory; please retry.`));
              return;
            }
          }
          if (this.initTimer) clearTimeout(this.initTimer);
          this.initTimer = undefined;
          if (this.resumePending) {
            this.host.observability.log('info', 'chat', 'claude native restore initialized', {
              nodeId: this.nodeId,
              sessionId: this.id,
              nativeSessionId: sessionId,
              durationMs: Math.round(this.perf.now() - this.stdinWriteAt),
            });
          }
          if (this.resumePending) queue.push({ kind: 'retry_end' });
          this.resumePending = false;
        } else if (!this.firstModelEnvelopeThisTurn && this.stdinWriteAt) {
          // First non-system envelope after stdin write — Anthropic actually responded.
          this.firstModelEnvelopeThisTurn = true;
          this.perf.measure('claude:stdin_to_first_model_envelope', this.stdinWriteAt, {
            sid: this.id,
            type: envelope['type'] as string | undefined,
          });
        }
        // Workflow progress goes to the workflow hub, never the turn queue.
        this.workflowTap.observe(envelope);
        // The CLI's own permission mode: on init (each turn) and on status
        // when it changes (EnterPlanMode, an approved plan, a set mode).
        if (envelope['type'] === 'system' && (envelope['subtype'] === 'init' || envelope['subtype'] === 'status')
          && typeof envelope['permissionMode'] === 'string') {
          this.observeNativeMode(envelope['permissionMode'] as PermissionMode);
        }
        translator.feed(envelope);
    };

    const systemPromptAppend = this.systemPromptAppend || '';

    const tCliSpawn = this.perf.now();
    let child: ChildProcessWithoutNullStreams;
    let transportReady = false;
    let startupError: Error | undefined;
    let skillDir: string | null = null;
    let skillLibrary = NO_CLAUDE_SKILL_LIBRARY;
    try {
      const permissionMode = (this.turnAbort ? this.turnPermissionMode : undefined) ?? this.host.permissions.mode(this.owner, this.ownerUserId);
      // A restricted session (the Michi assistant) never bypasses, has no
      // built-in tools, loads no MCP server but the host's and none of the
      // user's settings (claudeRestrictedProfile.ts).
      const assistant = this.host.profile.isRestricted(this.toolProfile);
      const spawnPolicy = claudeSpawnPolicy(assistant, { ownerMode: ownerMode(this.owner), permissionMode, toolProfile: this.toolProfile });
      // A respawn during planning (a restore, a recovered Stop) keeps planning.
      const spawnMode = this.supportsModes() && this.workMode === 'plan' ? 'plan' as const : spawnPolicy.permissionMode;
      this.nativePermissionMode = spawnMode;
      // Session-scoped in the CLI: every spawn, a resume too, passes it again.
      // Off is sent as well, so a settings file cannot turn it on unseen.
      const ultracode = this.desiredUltracode();
      this.ultracodeWanted = ultracode;
      this.nativeUltracode = ultracode;
      this.ultracodeReported = null;
      const bare = ownerMode(this.owner) === 'headless' ? true : this.options.cli().bare;
      this.spawnedBare = bare === true;
      skillDir = this.skillLibraryDir();
      // What the CLI is about to load, for the table it answers initialize with.
      if (skillDir) skillLibrary = await readClaudeSkillLibrary(skillDir);
      // A Stop or dispose while the library was read starts no process.
      this.turnAbort?.signal.throwIfAborted();
      if ((this.state as SessionState) === 'disposed') throw new Error('Claude session was disposed during startup');
      const transport = await createClaudeSdkTransport({
        onMessage,
        onError: (error) => { if (!transportReady) startupError = error; else if (isCurrent()) this.failProcess(error); },
        onStderr: (chunk) => this.handleStderr(chunk),
        spawnEnv: this.options.spawnEnv(),
        binaryPath: this.options.binaryPath(),
        log: (...args) => this.host.observability.log(...args),
        authorize: (name, input, id, signal) => this.authorizeSdkTool(name, input, id, signal),
        preToolUse: (name, input, id, signal) => this.enforceSdkPolicy(name, input, id, signal),
        cwd: this.cwd,
        tools: spawnPolicy.tools ? [...spawnPolicy.tools] : this.sdkBuiltinTools(),
        ...(spawnPolicy.disallowedTools ? { disallowedTools: [...spawnPolicy.disallowedTools] } : {}),
        // Restricted: mandatory host hooks, and no YOLO switch to bypassPermissions later.
        restricted: assistant || ownerMode(this.owner) === 'headless'
          || (!!this.toolProfile && (!this.toolProfile.assistant || !!this.toolProfile.allowedToolNames)) || !!this.permissionBroker,
        // The user's own settings, hooks, plugins and skills never reach the
        // assistant; nor do the library's (addDirs below).
        ...(spawnPolicy.isolateSettings ? { isolateSettings: true } : {}),
        ...(spawnPolicy.restrictedMode ? { restrictedMode: true } : {}),
        sessionId: opts.sessionId,
        resumeSessionId: opts.resumeSessionId,
        forkSession: opts.forkSession,
        ...(this.ephemeral ? { persistSession: false, quietTelemetry: true } : {}),
        permissionMode: spawnMode,
        mcpConfigInline: opts.mcpConfig,
        ultracode,
        includeHookEvents: false,
        // Surface in-session Task subagents as a live roster (subagent_list_update /
        // subagent_tool_activity) instead of an opaque "Used N tools" chip.
        forwardSubagentText: this.options.cli().forwardSubagentText,
        // Default: let claude auto-discover the user's own MCP servers
        // (~/.claude/settings.json, project .mcp.json, plugin MCPs). __michi_internal__
        // is still injected via --mcp-config so the agent↔Michi protocol (approve,
        // save_artifact, spawn_branches) is always available. The strictMcp flag
        // locks a chat to ONLY __michi_internal__ as well.
        strictMcpConfig: ownerMode(this.owner) === 'headless' || spawnPolicy.strictMcpConfig === true
          || this.options.cli().strictMcp,
        // Bare mode skips SessionStart hooks, plugins, skills, MCP auto-discovery
        // (see ClaudeCliFlags.bare); an Agent Run never needs them.
        bare,
        model: this.model,
        effort: reasoningToClaudeEffort(resolveReasoningOptions(
          { reasoning: true }, getClaudeReasoningCapabilities(this.model ?? 'sonnet'), undefined,
          this.reasoning ?? this.host.config.defaultReasoning('claude', this.ownerUserId ?? undefined),
        ).value),
        // Opt-in override for multi-profile setups (Michi: agent.claudeConfigDir
        // in ~/.michi/config.json). Undefined for everyone else — claude keeps
        // its ~/.claude default.
        configDir: this.options.configDir?.(),
        systemPromptAppend,
        ...(this.host.config.features.nativeMemory?.('claude', this.ownerUserId) === false ? { env: { ...AUTO_MEMORY_OFF_ENV } } : {}),
        // Library skills load with the user's settings. Isolated and bare
        // processes do not load them: the assistant has no library at all,
        // and bare chats and Agent Runs reach it through michi_skills where
        // their tools include it; a skill turn sends the skill's text. One
        // path in every mode, so warm processes keep identical arguments.
        ...(skillDir ? { addDirs: [skillDir] } : {}),
      });
      this.transport = transport;
      child = transport.child;
    } catch (error) {
      await this.retireProcess();
      throw error;
    }
    this.child = child;
    this.host.observability.log('info', 'chat', 'claude process spawned', {
      nodeId: this.nodeId,
      sessionId: this.id,
      nativeSessionId: this.externalSessionId,
      pid: child.pid,
      resume: !!opts.resumeSessionId,
      initTimeoutMs: this.options.limits.initTimeoutMs,
    });
    this.perf.measure('claude:cli_spawn_call', tCliSpawn, {
      sid: this.id,
      pid: child.pid,
      bare: this.options.cli().bare,
    });

    let exitResolve!: () => void;
    this.exitPromise = new Promise<void>((r) => { exitResolve = r; });

    child.on('error', (error: Error) => {
      if (!child.pid) exitResolve();
      if (this.child === child) this.failProcess(error);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitResolve();
      this.host.observability.log('info', 'chat', 'claude process exited', {
        nodeId: this.nodeId,
        sessionId: this.id,
        pid: child.pid,
        code,
        signal,
        current: this.child === child,
      });
      // Background workflows run inside the CLI process and end with it.
      this.workflowTap.release('The Claude session ended before this workflow finished');
      if (this.child !== child) return;
      // Keep the captured group owned until descendants and MCP are retired.
      // This barrier also gates a native respawn after an unexpected exit.
      void this.retireProcess().catch(() => {});
    });

    transportReady = true;
    if (startupError || child.exitCode != null || child.signalCode != null || this.turnAbort?.signal.aborted || (this.state as SessionState) === 'disposed') {
      await this.retireProcess();
      throw startupError ?? new Error('Claude SDK startup ended before the session was ready');
    }
    // SDK control initialization is separate from native system/init. The
    // latter arrives with the first user message; binding persistence remains
    // gated on that validated identity rather than an allocated placeholder.
    this.state = 'idle';
    this.startIdlePump();
    // Whether this process can run Ultracode (model, workflows) is the CLI's
    // to say; the session state carries it to the chat's indicator.
    // A choice changed while the process started (setUltracode found none) is
    // applied once it is up.
    const spawned = this.transport;
    if (spawned && this.supportsUltracode()) {
      void Promise.resolve(spawned.initialized).then(() => {
        if (this.transport !== spawned) return;
        this.syncNativeUltracode(spawned);
        void this.refreshUltracodeReport(spawned);
      }, () => {});
    }
    if (spawned) {
      this.spawnedSkillDir = skillDir;
      this.nextLibrary = skillLibrary;
      // The skills the chat's menu offers, and which a skill turn runs as a command.
      void Promise.resolve(spawned.initialized).then(
        (answer) => this.observeNativeCommands(spawned, (answer as { commands?: unknown } | undefined)?.commands, false), () => {});
      try {
        this.stopSkillLibraryUpdates?.();
        this.stopSkillLibraryUpdates = this.options.subscribeSkillLibraryChanges?.(() => this.onSkillLibraryChanged(spawned)) ?? null;
      } catch (error) {
        this.stopSkillLibraryUpdates = null;
        this.host.observability.log('warn', 'chat', 'claude session cannot follow skill library changes', {
          nodeId: this.nodeId, error: error instanceof Error ? error.message : String(error),
        });
      }
      // A change while the process started came before the subscription: reload for it.
      if (skillDir) {
        const names = (library: ClaudeSkillLibrary) => [...library.names].sort().join('\n');
        void readClaudeSkillLibrary(skillDir).then((now) => {
          if (this.transport === spawned && names(now) !== names(skillLibrary)) this.onSkillLibraryChanged(spawned);
        }, () => {});
      }
    }
  }

  /** The host's library folder for a new process; a failure only leaves the library out. */
  private skillLibraryDir(): string | null {
    try {
      return this.options.skillLibraryDir?.() ?? null;
    } catch (error) {
      this.host.observability.log('warn', 'chat', 'claude skill library is unavailable for this process', {
        nodeId: this.nodeId, error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private checkAndRepairJsonl(cwd: string, claudeSessionId: string, ownerUserId?: string | null): void {
    const jsonlPath = getClaudeJsonlPath(this.options, cwd, claudeSessionId, ownerUserId);
    if (!fs.existsSync(jsonlPath)) return;

    try {
      const stat = fs.statSync(jsonlPath);
      if (stat.size === 0) return;

      const readSize = Math.min(4096, stat.size);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      } finally {
        fs.closeSync(fd);
      }

      const tail = buf.toString('utf8');
      const lines = tail.split('\n');
      const lastLine = lines[lines.length - 1];

      // If last line is non-empty (no trailing newline) or fails JSON.parse, truncate
      if (lastLine.trim()) {
        try {
          JSON.parse(lastLine);
          // Parses OK — file is fine
        } catch {
          // Truncate to the last complete newline
          const lastNewline = tail.lastIndexOf('\n');
          if (lastNewline >= 0) {
            const truncateAt = stat.size - readSize + lastNewline + 1;
            console.warn(
              `[ClaudeSession] JSONL tail repair: truncating ${jsonlPath} to ${truncateAt} bytes`,
            );
            fs.truncateSync(jsonlPath, truncateAt);
          }
        }
      }
    } catch (err) {
      console.warn(`[ClaudeSession] JSONL tail check failed for ${jsonlPath}:`, err);
    }
  }

  private sendInput(message: SDKUserMessage): void {
    if (!this.transport) throw new Error('Claude SDK input connection is unavailable. Original session retained.');
    this.transport.send({ ...message, session_id: this.externalSessionId ?? '' });
  }

  private handleStderr(chunk: string): void {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    this.host.observability.log('warn', 'chat', 'claude stderr', {
      nodeId: this.nodeId, sessionId: this.id, pid: this.child?.pid,
      resumePending: this.resumePending, stderr: trimmed.slice(0, 2_000),
    });
    if (this.host.profile.isRestricted(this.toolProfile) && claudeLacksToolsFlag(trimmed)) {
      this.failProcess(new Error('This Claude Code has no --tools option, which the Michi assistant needs to run without built-in tools. Update Claude Code, or choose Codex or Pi for the assistant.'));
      return;
    }
    if (this.host.profile.isRestricted(this.toolProfile) && claudeLacksRestrictedFlag(trimmed)) {
      this.failProcess(new Error('This Claude Code has no --restricted option, which the Michi assistant runs with. Update Claude Code, or choose Codex or Pi for the assistant.'));
      return;
    }
    const warning = this.options.stderrWarning?.(trimmed);
    if (warning && !this.stderrWarningsSent.has(warning.message)) {
      this.stderrWarningsSent.add(warning.message);
      this.queue.push({ kind: 'warning', ...warning });
    }
  }

  /**
   * The Michi assistant's verdict on an SDK tool call, ahead of every other
   * policy and taken on the name as Claude reports it: nothing runs until the
   * process has passed its init check, nor once it has failed; then only the
   * assistant's own Michi tools run (mcp____michi_internal____<tool>), and
   * they enforce their own scope and optional approvals
   * or leave receipts. Built-in tools, other MCP servers' tools and Michi
   * tools outside the list are denied. Undefined for every other session.
   */
  private assistantSdkVerdict(name: string, input: Record<string, unknown>, signal: AbortSignal): PermissionResult | undefined {
    if (!this.host.profile.isRestricted(this.toolProfile) || this.host.profile.isMaintenance?.(this.toolProfile)) return undefined;
    if (!this.assistantToolsAvailable()) return { behavior: 'deny', message: ASSISTANT_UNVERIFIED };
    if (signal.aborted || this.turnAbort?.signal.aborted) return { behavior: 'deny', message: 'Turn cancelled' };
    return restrictedToolApproval(this.options, michiMcpToolName(name), this.toolProfile) === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: ASSISTANT_TOOL_DENIAL };
  }

  /** A maintenance turn has no native tools and may call only its dedicated MCP catalog. */
  private maintenanceSdkVerdict(name: string, input: Record<string, unknown>, signal: AbortSignal): PermissionResult | undefined {
    if (!this.host.profile.isMaintenance?.(this.toolProfile)) return undefined;
    if (!this.assistantToolsAvailable()) return { behavior: 'deny', message: 'Maintenance tools are unavailable until Claude reports a verified restricted setup.' };
    if (signal.aborted || this.turnAbort?.signal.aborted) return { behavior: 'deny', message: 'Turn cancelled' };
    const toolName = michiMcpToolName(name);
    return toolName && this.isToolAllowed(toolName)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'This Claude session may run only dedicated maintenance tools.' };
  }

  /**
   * Whether the host wants this call of an unrestricted session answered by
   * canUseTool, whatever the CLI's own settings and mode would decide
   * (ClaudeAdapterOptions.requireHostApproval). A callback that throws asks:
   * the approval policy then decides.
   */
  private hostRequiresApproval(name: string, input: Record<string, unknown>): boolean {
    const check = this.options.requireHostApproval;
    if (!check) return false;
    try {
      return check({ owner: this.owner, ownerUserId: this.ownerUserId, toolName: name, hostToolName: michiMcpToolName(name), input }) === true;
    } catch (error) {
      this.host.observability.log('warn', 'chat', 'claude host approval check failed; the call asks', {
        nodeId: this.nodeId, toolName: name, error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  /** Apply mandatory Run restrictions before native auto-approval. Ordinary
   * chat policy still handles native permission requests through canUseTool;
   * a call the host requires approval for asks it even where the user's
   * settings or the mode would approve it. */
  private async enforceSdkPolicy(name: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<ClaudePreToolUseVerdict | undefined> {
    const assistant = this.assistantSdkVerdict(name, input, signal);
    if (assistant) return assistant;
    const maintenance = this.maintenanceSdkVerdict(name, input, signal);
    if (maintenance) return maintenance;
    const toolName = name.replace(/^mcp____michi_internal____/, '');
    if (signal.aborted || this.turnAbort?.signal.aborted) return { behavior: 'deny', message: 'Turn cancelled' };
    if (!this.isToolAllowed(toolName)) return { behavior: 'deny', message: 'tool is not enabled for this Agent Run' };
    if (toolName === 'ToolSearch' && this.toolProfile && !this.host.profile.isMaintenance?.(this.toolProfile)) return { behavior: 'allow', updatedInput: input };
    if (this.permissionBroker) return this.authorizeSdkTool(toolName, input, id, signal);
    if (this.hostRequiresApproval(name, input)) return { behavior: 'ask', message: HOST_APPROVAL_REQUIRED };
    return undefined;
  }

  private async authorizeSdkTool(toolName: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<PermissionResult> {
    const assistant = this.assistantSdkVerdict(toolName, input, signal);
    if (assistant) return assistant;
    const maintenance = this.maintenanceSdkVerdict(toolName, input, signal);
    if (maintenance) return maintenance;
    // The host's policy is told the name was its own server's, since it sees it without the prefix.
    const hostTool = michiMcpToolName(toolName) !== null;
    toolName = toolName.replace(/^mcp____michi_internal____/, '');
    if (signal.aborted || this.turnAbort?.signal.aborted) return { behavior: 'deny', message: 'Turn cancelled' };
    if (!this.isToolAllowed(toolName)) return { behavior: 'deny', message: 'tool is not enabled for this Agent Run' };
    // Native AskUserQuestion uses the same durable interaction UI as ask_user.
    if (toolName === 'AskUserQuestion') {
      // A question asked while idle opens a self-turn. A tool approval decides
      // that itself (makeOnApprove): while a workflow runs, the run carries it.
      this.ensureSelfTurnController();
      const questionTurn = this.turnAbort;
      // A native question is still subject to the Run's mandatory host policy.
      // Do not let the interaction shortcut bypass an explicit broker denial.
      if (this.permissionBroker) {
        const permission = await this.makeOnApprove()({ toolName, input, toolUseId }, signal);
        if (permission.behavior === 'deny') return permission;
      }
      if (!Array.isArray(input.questions)) return { behavior: 'deny', message: 'Invalid user questions' };
      const answers = await this.makeOnAskUser()(input.questions as Parameters<ReturnType<ClaudeSession['makeOnAskUser']>>[0], signal);
      return answers && !signal.aborted && !questionTurn?.signal.aborted && this.turnAbort === questionTurn
        ? { behavior: 'allow', updatedInput: { ...input, answers } } : { behavior: 'deny', message: 'User input cancelled' };
    }
    const result = await this.makeOnApprove()({ toolName, input, toolUseId, ...(hostTool ? { hostTool } : {}) }, signal);
    return result.behavior === 'allow' ? { behavior: 'allow', updatedInput: (result.updatedInput ?? input) as Record<string, unknown> } : result;
  }

  private async disposeSlot(): Promise<void> {
    if (!this.slotId) return;
    const slotId = this.slotId;
    await withDeadline(this.mcpRegistry.dispose(slotId), this.options.limits.disposeTermTimeoutMs,
      'Claude tool connection cleanup timed out. Original session retained; please retry.');
    if (this.slotId === slotId) this.slotId = null;
  }

  private fireDisposedCallback(): void {
    if (this.disposedCallbackFired) return;
    this.disposedCallbackFired = true;
    this.disposedCallback?.();
  }

  // ---- Turn mutex ------------------------------------------------------------

  /**
   * Take the session's one turn for `owner`, or throw ESESSION_BUSY without
   * changing anything when another owner holds it. Every owner but the idle
   * pump then parks the pump: the gate closes and a pump waiting in pull()
   * gets null. A frame that arrives meanwhile stays queued until the turn is
   * released. A pump left running would take it, fail to claim the turn,
   * hand it back and take it again without ever yielding to the event loop.
   */
  private takeTurn(owner: TurnOwner): void {
    if (this.turn) {
      throw Object.assign(new Error('Session is busy with an in-flight turn'), { code: 'ESESSION_BUSY' });
    }
    this.turn = { owner, nativeEnded: false };
    if (owner === 'self') return;
    this.idleGate.close();
    this.queue.interruptWaiter();
  }

  private releaseTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.owner !== 'self') this.idleGate.open();
  }

  /** An interaction can be the first frame of a native background turn. Its
   * callbacks and the idle pump must capture the same cancellation identity. */
  private ensureSelfTurnController(): AbortController | null {
    if (!this.turnAbort && !this.turn && this.state === 'idle') {
      this.turnAbort = new AbortController();
    }
    return this.turnAbort;
  }

  // ---- Permission handling ---------------------------------------------------

  private makeOnApprove() {
    // hostTool: toolName is a tool of Michi's MCP server, its prefix removed (authorizeSdkTool).
    return async (params: { toolName: string; input: unknown; toolUseId: string; hostTool?: boolean }, signal?: AbortSignal): Promise<
      { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }
    > => {
      // No chat turn is running or claimed: the asker is background work.
      // While workflows run, they carry its chat approval (below) instead of
      // a self-turn, so it gets a self-turn identity only if asked in the chat.
      const viaWorkflowPossible = !this.turnAbort && this.turn?.owner !== 'self'
        && !this.permissionBroker && !this.host.profile.isRestricted(this.toolProfile) && this.workflowTap.hasOpenRuns();
      // The self-turn identity is created only when a request is queued in the
      // chat: one answered by policy must not leave an idle controller behind,
      // which would send later workflow approvals to the chat.
      let permissionTurn = viaWorkflowPossible ? null : this.turnAbort;
      const isActive = () => !signal?.aborted && !permissionTurn?.signal.aborted
        && this.turnAbort === permissionTurn && this.state !== 'disposed' && this.state !== 'crashed';
      if (!isActive()) return { behavior: 'deny', message: 'permission request is no longer active' };
      if (this.host.profile.isRestricted(this.toolProfile) && !this.host.profile.isMaintenance?.(this.toolProfile)) {
        // Only the assistant's own Michi tools, which enforce their own approvals.
        return restrictedToolApproval(this.options, michiMcpToolName(params.toolName), this.toolProfile) === 'allow'
          ? { behavior: 'allow', updatedInput: params.input }
          : { behavior: 'deny', message: ASSISTANT_TOOL_DENIAL };
      }
      const maintenance = this.maintenanceSdkVerdict(params.toolName, params.input as Record<string, unknown>, signal ?? new AbortController().signal);
      if (maintenance) return maintenance;
      if (!this.isToolAllowed(params.toolName)) {
        return { behavior: 'deny', message: 'tool is not enabled for this Agent Run' };
      }
      if (this.permissionBroker) {
        const decision = await this.permissionBroker.requestPermission({
          owner: this.owner,
          ownerUserId: this.ownerUserId,
          workspaceId: this.workspaceId,
          toolName: canonicalClaudeToolName(params.toolName),
          input: params.input,
          toolCallId: params.toolUseId,
        });
        if (!isActive()) return { behavior: 'deny', message: 'permission request is no longer active' };
        if (decision === 'deny') return { behavior: 'deny', message: 'denied by Run permission policy' };
        if (decision !== 'ask') return { behavior: 'allow', updatedInput: params.input };
        // Ask uses the same runtime-native request queue as chat permissions,
        // but the resulting event is projected into a durable Run interaction.
        if (!permissionTurn) permissionTurn = this.ensureSelfTurnController();
        if (!isActive()) return { behavior: 'deny', message: 'permission request is no longer active' };
        const requestId = nextInteractionRequestId();
        this.queue.push({
          kind: 'permission_request',
          requestId,
          title: `Approve ${params.toolName}?`,
          detail: formatPermissionDetail(params.toolName, params.input),
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ],
          source: 'claude_prompt_tool',
        });
        const answer = await this.awaitPermission(requestId, params.toolName, signal);
        return isActive() && answer?.startsWith('allow')
          ? { behavior: 'allow', updatedInput: params.input }
          : { behavior: 'deny', message: 'denied by Run permission policy' };
      }
      // The user reviews a plan in every approval mode (Ask, Trust, YOLO):
      // no policy, grant, session trust or workflow answers ExitPlanMode.
      // The CLI hands it to canUseTool even under bypassPermissions.
      if (params.toolName === 'ExitPlanMode') {
        if (!permissionTurn) permissionTurn = this.ensureSelfTurnController();
        if (!isActive()) return { behavior: 'deny', message: 'permission request is no longer active' };
        const requestId = nextInteractionRequestId();
        this.queue.push({
          kind: 'permission_request',
          requestId,
          title: 'Approve the plan?',
          detail: formatPermissionDetail(params.toolName, params.input),
          options: PLAN_REVIEW_OPTIONS.map((option) => ({ ...option })),
          source: 'claude_prompt_tool',
        });
        const answer = await this.awaitPermission(requestId, params.toolName, signal);
        if (!isActive()) return { behavior: 'deny', message: 'permission request is no longer active' };
        return answer?.startsWith('allow') ? { behavior: 'allow', updatedInput: params.input } : { behavior: 'deny', message: PLAN_REJECTED };
      }

      // A turn decides under the mode it started with. Background work asking
      // between turns (a workflow agent) follows the chat's current mode, so
      // moving the chat to Ask holds a running workflow's next tool call.
      const call = { input: params.input };
      const policy = this.approvals.policy(this.owner, this.ownerUserId, params.toolName, true,
        this.turn ? this.turnPermissionMode : undefined, params.hostTool === true, call);
      if (policy === 'allow') return { behavior: 'allow', updatedInput: params.input };
      if (policy === 'deny') return { behavior: 'deny', message: 'policy denied' };

      // 'ask': push permission_request, await user decision. A forced ask (the
      // host's consequence rules) approves this one call only.
      const forced = this.approvals.forcedAsk(this.owner, this.ownerUserId, params.toolName, true, params.hostTool === true, call);
      const options = forced ? forcedApprovalOptions() : chatApprovalOptions(params.toolName);
      const title = `Approve ${params.toolName}?`;
      const formatted = formatPermissionDetail(params.toolName, params.input);
      const detail = forced ? [forced.reason, formatted].filter(Boolean).join('\n\n') : formatted;

      // Queuing a background asker's request would open a self-turn that
      // holds the chat until the workflow ends, so the running workflows
      // carry it instead.
      const viaWorkflow = viaWorkflowPossible
        ? this.workflowTap.requestApproval({ title, ...(detail ? { detail } : {}), options, toolName: params.toolName }, this.options.limits.approveTimeoutMs)
        : null;
      let result: string | null = null;
      let askInChat = !viaWorkflow;
      if (viaWorkflow) {
        const outcome = await viaWorkflow;
        if (signal?.aborted || this.state === 'disposed' || this.state === 'crashed') {
          return { behavior: 'deny', message: 'permission request is no longer active' };
        }
        if (outcome.kind === 'answered') result = outcome.optionId;
        // Every workflow showing it completed while the asker still waits:
        // it was not a workflow agent, so ask in the chat.
        else if (outcome.kind === 'unhosted') askInChat = true;
        // Nobody answered (timeout, a stopped run, the CLI went away).
        else return { behavior: 'deny', message: 'permission request is no longer active' };
      }
      if (askInChat) {
        // The request may be the first frame of a self-turn (see ensureSelfTurnController).
        if (!permissionTurn) permissionTurn = this.ensureSelfTurnController();
        if (!isActive()) return { behavior: 'deny', message: 'permission request is no longer active' };
        const requestId = nextInteractionRequestId();
        this.queue.push({
          kind: 'permission_request',
          requestId,
          title,
          detail,
          options,
          source: 'claude_prompt_tool',
        });
        result = await this.awaitPermission(requestId, params.toolName, signal, forced !== null);
        if (!isActive()) {
          return { behavior: 'deny', message: 'permission request is no longer active' };
        }
      }

      if (this.approvals.accept(result, this.owner, params.toolName, this.ownerUserId)) {
        for (const [id, request] of this.pendingPermissions) {
          // A grant never answers a plan review.
          if (request.toolName === 'ExitPlanMode') continue;
          if (this.approvals.covers(result, params.toolName, request.toolName, request.forced === true)) this.respondToPermission(id, 'allow_once');
        }
        this.workflowTap.answerCovered((toolName) => this.approvals.covers(result, params.toolName, toolName), 'allow_once');
        return { behavior: 'allow', updatedInput: params.input };
      }
      return { behavior: 'deny', message: 'denied by user' };
    };
  }

  private sdkBuiltinTools(): string[] | undefined {
    if (this.host.profile.isMaintenance?.(this.toolProfile)) return [];
    const allowed = this.toolProfile?.allowedToolNames;
    if (!allowed) return undefined;
    const names: Record<string, string[]> = { read: ['Read'], find: ['Glob'], grep: ['Grep'],
      bash: ['Bash'], write: ['Write'], edit: ['Edit', 'MultiEdit', 'NotebookEdit'] };
    const native = new Set(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      'Agent', 'Task', 'TaskOutput', 'TaskStop', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite']);
    return [...new Set(['ToolSearch', ...allowed.flatMap(name => names[name] ?? (native.has(name) ? [name] : []))])];
  }

  private isToolAllowed(toolName: string): boolean {
    const allowed = this.toolProfile?.allowedToolNames;
    if (!allowed) return true;
    toolName = toolName.replace(/^mcp____michi_internal____/, '');
    // ToolSearch only discovers the permitted MCP server's schemas; actual
    // execution still passes the profile check and broker.
    // The assistant has no built-in tools at all, ToolSearch included.
    if (toolName === 'ToolSearch') return !this.host.profile.isRestricted(this.toolProfile);
    const canonical = canonicalClaudeToolName(toolName);
    return allowed.includes(toolName) || allowed.includes(canonical);
  }

  /**
   * The slot callbacks of the bridge's business effects, one for each method
   * the bridge has: a tool whose effect the bridge lacks is not offered.
   */
  private bridgeSlotCallbacks(): Pick<McpSlotCallbacks, 'onSpawnBranches' | 'onSaveArtifact' | 'onUpdateArtifact'> {
    return {
      ...(this.bridge.spawnBranches ? {
        onSpawnBranches: async (topics: Array<{ title: string; prompt: string }>) => {
          if (!this.isToolAllowed('spawn_branches')) throw new Error('spawn_branches is not enabled for this session');
          return this.bridge.spawnBranches!({
            parentChatId: this.id,
            cwd: this.cwd,
            enableFollowUps: this.enableFollowUps,
            ownerUserId: this.ownerUserId,
            topics,
          });
        },
      } : {}),
      ...(this.bridge.saveContext ? {
        onSaveArtifact: (name: string, body: string | undefined, path?: string) => {
          if (!this.isToolAllowed('save_artifact')) return null;
          return this.bridge.saveContext!({ cwd: this.cwd, chatId: this.id, ownerUserId: this.ownerUserId, name, body, path });
        },
      } : {}),
      ...(this.bridge.updateContext ? {
        onUpdateArtifact: (name: string, body: string) => {
          if (!this.isToolAllowed('update_artifact')) return null;
          return this.bridge.updateContext!({ cwd: this.cwd, chatId: this.id, ownerUserId: this.ownerUserId, name, body });
        },
      } : {}),
    };
  }

  private awaitPermission(requestId: number, toolName?: string, signal?: AbortSignal, forced = false): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const abort = () => this.cancelPermission(requestId);
    signal?.addEventListener('abort', abort, { once: true });
    // The queue the request was pushed on, so the resolution reaches its turn.
    const queue = this.queue;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        // Unanswered: the tool is denied. Say so, as ACP does, so the host
        // clears the pending request and no late answer is offered.
        queue.push({ kind: 'permission_resolved', requestId });
        resolve(null);
      }, this.options.limits.approveTimeoutMs);
      this.pendingPermissions.set(requestId, { resolve, timer, toolName, ...(forced ? { forced } : {}) });
    }).finally(() => signal?.removeEventListener('abort', abort));
  }

  // ---- User input handling (ask_user MCP tool) ------------------------------

  private makeOnAskUser() {
    return async (questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>, signal?: AbortSignal): Promise<Record<string, string> | null> => {
      if (signal?.aborted || this.turnAbort?.signal.aborted) return null;
      const questionTurn = this.ensureSelfTurnController();
      const queue = this.queue;
      const requestId = nextInteractionRequestId();

      const abort = () => this.skipUserInput(requestId);
      signal?.addEventListener('abort', abort, { once: true });
      const answers = await new Promise<Array<{ question: string; answer: string }> | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingUserInputs.delete(requestId);
          resolve(null);
        }, this.options.limits.approveTimeoutMs);
        this.pendingUserInputs.set(requestId, { resolve, timer });
        queue.push({ kind: 'user_input_request', requestId, questions });
      }).finally(() => signal?.removeEventListener('abort', abort));

      if (answers && !signal?.aborted && !questionTurn?.signal.aborted && this.turnAbort === questionTurn && this.queue === queue) {
        queue.push({ kind: 'user_input_resolved', requestId, answers });
        const result: Record<string, string> = {};
        for (const a of answers) result[a.question] = a.answer;
        return result;
      }

      queue.push({ kind: 'user_input_resolved', requestId, answers: [] });
      return null;
    };
  }
}

// ---- Helpers -----------------------------------------------------------------

interface ClaudeImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/**
 * When there are image attachments, send the turn as a stream-json content
 * array (text block + image blocks) instead of a plain string. The claude CLI
 * accepts the same content-block schema as the Messages API. With no images,
 * the plain-string form is preserved so nothing changes for text-only turns.
 */
function userEnvelope(text: string, imageBlocks: ClaudeImageBlock[] = [], human = false): SDKUserMessage {
  const content = imageBlocks.length > 0
    ? [{ type: 'text' as const, text }, ...imageBlocks]
    : text;
  return userMessage(content, human);
}

type ClaudeUserContent = string | Array<{ type: 'text'; text: string } | ClaudeImageBlock>;

function userMessage(content: ClaudeUserContent, human: boolean): SDKUserMessage {
  // A person typed this prompt (and ClaudeCliFlags.humanOrigin is on). The CLI
  // gates prompt keywords that launch background work (e.g. `ultracode` →
  // Workflow) on a human origin.
  const origin: Pick<SDKUserMessage, 'origin'> = human ? { origin: { kind: 'human' } } : {};
  return { type: 'user', message: { role: 'user', content: content as SDKUserMessage['message']['content'] }, parent_tool_use_id: null, session_id: '', uuid: randomUUID(), ...origin };
}

/**
 * The CLI runs a message as a command when its last content block is text
 * starting with '/' (no leading whitespace). Anything after the command
 * would become the skill's arguments, so the turn's other text and its
 * images come first: they reach the model in the same turn as the skill.
 */
function skillCommandContent(context: string, imageBlocks: ClaudeImageBlock[], command: string): ClaudeUserContent {
  if (!context && imageBlocks.length === 0) return command;
  return [...(context ? [{ type: 'text' as const, text: context }] : []), ...imageBlocks, { type: 'text' as const, text: command }];
}

/**
 * The text a skill turn sends before its command: the model prefix and
 * first-turn preamble, the turn's own text other than the skill's
 * arguments, then the reminder and attachment note. Each prefix part ends
 * in a separator, which leads into nothing when the turn has no text of
 * its own.
 */
function skillContextBlock(prefix: string, context: string, suffix: string): string {
  return ((context ? prefix + context : prefix.replace(/\n\n---\n\n$/, '')) + suffix).trim();
}

/** Read local image attachments into base64 stream-json image blocks. Mirrors
 *  Codex's localImage forwarding. Paths are pre-validated by
 *  partitionAttachments; a file that vanished since then is skipped. */
function buildClaudeImageBlocks(images: ResolvedAttachment[]): ClaudeImageBlock[] {
  const blocks: ClaudeImageBlock[] = [];
  for (const attachment of images) {
    const mediaType = imageMimeType(attachment.absPath);
    if (!mediaType) continue;
    try {
      const data = fs.readFileSync(attachment.absPath).toString('base64');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    } catch {
      // Unreadable attachment — skip rather than fail the turn.
    }
  }
  return blocks;
}

function formatPermissionDetail(toolName: string, input: unknown): string | undefined {
  if (toolName !== 'ExitPlanMode') return permissionDetail(canonicalClaudeToolName(toolName), input);
  const args = asRecord(input);
  return args ? permissionDetailLine('Plan', firstString(args, ['plan', 'planFilePath']), 6000) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
