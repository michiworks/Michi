import { ApprovalCoordinator, chatApprovalOptions } from '../../core/approvals';
import { assertPermissionAnswer, nextInteractionRequestId } from '../../core/pendingInteractions';
import { randomUUID } from 'node:crypto';
import type {
  AgentSession,
  AgentTurnInput,
  CancelAck,
  ChatMessage,
  CompactResult,
  MaintenanceExecutionContext,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimeSessionOwner,
  RuntimeToolProfile,
  SkillTurnInvocation,
  SteerResult,
} from '../../contract/types';
import type { NormalizedEvent, UserInputAnswer, UserInputQuestion } from '../../contract/events';
import {
  isTurnMetadataToolTitle,
  mergeSubagentEntry,
  subagentEndOf,
  SUBAGENT_LIMITS,
  SUBAGENT_SESSION_ENDED_ERROR,
  type SubagentEnd,
  type SubagentInfo,
} from 'michi-shared';
import type { McpSlotProvider } from '../../contract/mcp';
import {
  ownerMode,
  type BackgroundSubagentContext, type BackgroundSubagentSink, type RuntimeHost,
  type TurnMetadataTracker,
} from '../../contract/host';
import { assertHostPorts } from '../../core/defaultHost';
import type { AgentToolBridge } from '../../contract/tools';
import { CodexRpcError, type CodexAppServerClient } from './CodexAppServerClient';
import { EventQueue } from '../../core/eventQueue';
import { abortable } from '../../core/runtimeLifecycle';
import { createCodexTranslator } from './codexEventTranslator';
import { resolveShowImage } from '../../core/showImage';
import { hostEventSink } from '../../core/hostEventSink';
import { prepareAttachments } from '../../core/attachments';
import { formElicitationContent, formElicitationFields } from '../../core/formElicitation';
import { codexChatTurnPolicy } from './codexTurnPolicy';
import { CODEX_RESTRICTED_TURN_POLICY } from './codexRestrictedProfile';
import { CODEX_MEMORIES_OFF, CODEX_THREAD_FEATURES_OFF, codexDisableMcpServers, isCodexModeKind } from './codexProtocol';
import { codexSpawnSignal } from './codexCollab';
import type { CodexHostText } from './CodexRuntime';
import { fallbackCodexTitle, generateCodexTitle } from './codexTitleGenerator';
import { buildRunMcpSlotCallbacks } from '../../core/runMcpSlot';
import { interactiveOwner } from '../../contract/types';
import { expandSkillPrompt, skillHistoryText } from '../../core/skills';
import { turnContextPrefix } from '../../core/turnText';
import { sessionOwnerContext } from '../../core/ownerContext';
import { bindMaintenanceTurn, pageAttributionFor } from '../../core/maintenanceTurn';
import { codexSkillMention, type CodexSkillInput } from './codexSkills';
import {
  canonicalToolNameFromMethod,
  codexBrokerDecision,
  codexGrantToolName,
  codexPermissionRequest,
  codexRunAskOptions,
  codexUserInputQuestions,
} from './codexApprovalMapping';
import { codexStartedTurnId, codexTitleText, codexTurnInput, codexTurnStartParams } from './codexTurnRequest';
import {
  codexChildNarration,
  codexChildThreadInfo,
  codexChildToolActivity,
  codexChildTurnEndPatch,
  isCodexChildThreadClosed,
} from './codexChildThreads';

export { canonicalToolNameFromMethod } from './codexApprovalMapping';

const APPROVE_TIMEOUT_MS = 300_000;

/**
 * Why a restricted session's turn ended when Codex started a sub-agent
 * anyway (its thread config refuses spawns; see codexRestrictedProfile).
 */
export const CODEX_RESTRICTED_SUBAGENT_ERROR =
  'The Michi assistant cannot use sub-agents. Codex started one, so Michi stopped this turn and the sub-agent.';

type SessionState = 'idle' | 'in_turn' | 'crashed' | 'disposed';

export interface CodexSessionDeps {
  nodeId: string;
  threadId: string;
  cwd: string;
  workspaceId: string | null;
  parentChatId?: string;
  client: CodexAppServerClient;
  /** The host ports, as the runtime holds them. */
  host: RuntimeHost;
  mcpRegistry: McpSlotProvider;
  bridge: AgentToolBridge;
  ownerUserId?: string | null;
  firstTurnPrefix?: string;
  effort?: string | null;
  model?: string | null;
  generateTitleOnFirstTurn?: boolean;
  /**
   * Cheap model for the pre-turn title thread (e.g. `gpt-5.6-luna`). When
   * null/undefined the title thread uses the session's own model.
   */
  titleModel?: string | null;
  /** Default true. When false, the per-turn follow-up reminder is suppressed. */
  enableFollowUps?: boolean;
  /** Explicit product owner. When omitted, the interactive owner of nodeId (the session's id). */
  owner?: RuntimeSessionOwner;
  /** Immutable hash of the effective runtime profile/capabilities for this session. */
  profileHash?: string | null;
  /** Tool profile for Agent Runs — carries allowed tool names and result collector hook. */
  toolProfile?: RuntimeToolProfile;
  /** Durable permission broker for Agent Runs. Chat sessions omit this. */
  permissionBroker?: RuntimePermissionBroker;
  recover?: (session: CodexSession) => Promise<void>;
  cancelTimeoutMs?: number;
  /** How long a tool approval waits for the user before it is declined. Default 300s. */
  approveTimeoutMs?: number;
  /** The title thread's deadline, read at each title. Default 10s (generateCodexTitle). */
  titleTimeoutMs?: () => number;
  /** Where background subagents are reported (tests); the host's backgroundSubagents port by default. */
  backgroundSubagents?: BackgroundSubagentSink;
  /** The host's wording (CodexAdapterOptions.hostText); none when absent. */
  hostText?: CodexHostText;
  /**
   * The skill input that runs a turn's skill natively in `cwd` (CodexRuntime
   * checks app-server's listing), or null to send the skill as text.
   */
  skillInput?: (skill: SkillTurnInvocation, cwd: string) => Promise<CodexSkillInput | null>;
}

export class CodexSession implements AgentSession {
  public readonly id: string;
  public readonly runtimeId = 'codex';
  private readonly approvals: ApprovalCoordinator;
  public permissionModeForTurn: import('michi-shared').ChatPermissionMode | undefined;
  public readonly parentChatId: string | undefined;
  /** Explicit product owner. Chat sessions default to the interactive owner of their id. */
  public readonly owner: RuntimeSessionOwner;
  /** ownerMode(owner) is 'interactive': a chat, not an Agent Run attempt. */
  private readonly interactive: boolean;
  /** Immutable profile hash used to reject unsafe session reuse. */
  public readonly runtimeProfileHash: string | null;
  /**
   * Runtime-owned resume/transport id (the Codex thread id). Distinct from the
   * public session id, which for a headless owner is `owner.key`.
   */
  public readonly nativeSessionId: string | null;
  /**
   * The Codex collaboration mode this session chose (setMode), sent with every
   * turn once set; null leaves the thread's own mode untouched.
   */
  public currentModeId: string | null = null;
  public currentModelId: string | null;
  /** Assistant text accumulated during the in-flight turn, exposed via
   *  getPendingAssistant() for auto-branch ancestor "in progress" stitching.
   *  Non-null only between turn start and the finally block. */
  private pendingAssistantBuf: string[] | null = null;
  public readonly threadId: string;
  public readonly workspaceId: string | null;
  public readonly effort: string | null;

  public readonly cwd: string;
  private readonly client: CodexAppServerClient;
  private readonly host: RuntimeHost;
  private readonly mcpRegistry: McpSlotProvider;
  private readonly bridge: AgentToolBridge;
  private readonly ownerUserId: string | null;
  private readonly generateTitleOnFirstTurn: boolean;
  private readonly titleModel: string | null;
  public readonly enableFollowUps: boolean;
  /** Tool profile for Agent Runs. Undefined for chat sessions. */
  private readonly toolProfile: RuntimeToolProfile | undefined;
  /** Durable permission broker for Agent Runs. Undefined for chat sessions. */
  private readonly permissionBroker: RuntimePermissionBroker | undefined;

  /** A restricted session (the Michi assistant): read-only sandbox, every approval declined (host profile). */
  get isAssistant(): boolean {
    return this.host.profile.isRestricted(this.toolProfile);
  }

  /** Either Meta agent toolset: read-only offline turns, every approval declined (assistant/policy.ts). */
  get isMetaAgent(): boolean {
    return this.host.profile.isRestricted(this.toolProfile);
  }

  get isMaintenance(): boolean {
    return this.host.profile.isMaintenance?.(this.toolProfile) === true;
  }

  get metaAgentToolProfile(): RuntimeToolProfile | undefined {
    return this.isMetaAgent || this.toolProfile?.assistant ? this.toolProfile : undefined;
  }

  private state: SessionState = 'idle';
  private slotId: string | null = null;

  private queue: EventQueue;
  private readonly history: ChatMessage[] = [];
  private markTranslatorTurnStart: (() => void) | null = null;
  private unsubscribeNotification: (() => void) | null = null;

  // ---- Child subagent thread tracking ----------------------------------------
  private unsubGlobalNotification: (() => void) | null = null;
  private readonly childThreadInfos = new Map<string, SubagentInfo>();
  /** Parent turn each child was last published in (see pushChild). */
  private readonly childPublishedTurn = new Map<string, number>();
  /** Increments per parent send(); children outliving a turn are carried. */
  private parentTurnSeq = 0;
  /**
   * Background children that finished while the parent was idle, whose
   * frames were dropped. Each parent turn reports their full entry until
   * its stream has yielded it (see publishIdleChildCompletions).
   */
  private readonly idleChildCompletions = new Set<string>();
  /**
   * Idle completions already ended in the registry (stored on the rosters,
   * sent to renderers): no longer background work, still reported into the
   * next parent turn's message (see endIdleChildCompletion).
   */
  private readonly idleChildEnded = new Set<string>();
  private readonly backgroundSubagents: BackgroundSubagentSink;
  /** This session's reports to the registry (unique per session object). */
  private readonly backgroundSubagentSource = `codex:${randomUUID()}`;
  private reportedBackground: string[] = [];
  private readonly childNotificationUnsubs = new Map<string, () => void>();

  private firstTurnPrefix: string;
  private firstTurnPrefixConsumed = false;
  private titleGenerationAttempted = false;
  private readonly activeTurnThreadIds = new Set<string>();
  private cancelRequested = false;
  private activeNativeTurnId: string | null = null;
  private readonly nativeTurnIds = new Map<string, string>();
  private readonly interrupts = new Map<string, Promise<boolean>>();
  private readonly completedTurnIds = new Set<string>();
  private nativeSettled = true;
  private settleNativeTurn: (() => void) | null = null;
  private turnAbort: AbortController | null = null;
  private activePageTurnAttribution: { turnId: string; assistantId: string } | null = null;
  private activeMaintenanceExecutionContext: MaintenanceExecutionContext | null = null;
  private interactionAbort = new AbortController();
  private transportAbort = new AbortController();
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly recover?: CodexSessionDeps['recover'];
  private readonly cancelTimeoutMs: number;
  private readonly approveTimeoutMs: number;
  private readonly titleTimeoutMs: (() => number) | undefined;
  private readonly hostText: CodexHostText | undefined;
  private readonly skillInput: CodexSessionDeps['skillInput'];
  public requiresRestart = false;
  /** Native thread/fork id only — never becomes a Michi node id. */
  private alignedForkThreadId: string | null = null;

  private readonly turnMetadata: TurnMetadataTracker;
  private readonly hiddenInternalToolCallIds = new Set<string>();

  // Turn mutex
  private lastUsedAt = Date.now();
  /** Last frame from a child thread (see isBackgroundIdleExpired). */
  private lastChildActivityAt = 0;
  private turnLock: Promise<void> | null = null;
  private turnLockRelease: (() => void) | null = null;

  // Permission state — Michi request ids (NOT JSON-RPC ids)
  /** Exposed for test inspection (security contract tests). Do not mutate externally. */
  public readonly pendingPermissions = new Map<
    number,
    { resolve: (optionId: string | null) => void; timer: NodeJS.Timeout; toolName?: string }
  >();

  // User input state — same pattern as permissions
  private readonly pendingUserInputs = new Map<
    number,
    { resolve: (answers: UserInputAnswer[] | null) => void; timer: NodeJS.Timeout }
  >();

  /** Called when a tool is granted always-allow, with the canonical tool name. */
  public onAlwaysAllow: ((canonicalTool: string) => void) | null = null;

  /** MCP servers of the user's config this thread disables (CodexRuntime.openThread); the title thread disables them too. */
  public userMcpServers: string[] = [];

  // ---- Restricted sessions: sub-agents are stopped on sight -------------------
  /** This turn already stopped for a sub-agent. */
  private subagentBlocked = false;
  /** Child threads a restricted turn started; each of their turns is interrupted. */
  private readonly blockedChildThreads = new Set<string>();
  private readonly interruptedChildTurns = new Set<string>();

  constructor(deps: CodexSessionDeps) {
    this.id = deps.nodeId;
    this.threadId = deps.threadId;
    this.cwd = deps.cwd;
    this.workspaceId = deps.workspaceId;
    this.parentChatId = deps.parentChatId;
    this.client = deps.client;
    this.host = deps.host;
    this.approvals = new ApprovalCoordinator({ permissions: this.host.permissions, canonicalize: codexGrantToolName });
    this.mcpRegistry = deps.mcpRegistry;
    this.bridge = deps.bridge;
    this.ownerUserId = deps.ownerUserId ?? null;
    if (!deps.backgroundSubagents) assertHostPorts(this.host, ['backgroundSubagents'], 'CodexSession');
    this.backgroundSubagents = deps.backgroundSubagents ?? this.host.backgroundSubagents!;
    this.generateTitleOnFirstTurn = deps.generateTitleOnFirstTurn ?? false;
    this.titleModel = deps.titleModel ?? null;
    this.enableFollowUps = deps.enableFollowUps !== false && !this.host.profile.isRestricted(deps.toolProfile) && !deps.toolProfile?.assistant;
    this.turnMetadata = this.host.prompt.turnMetadata('sentinel');
    this.firstTurnPrefix = deps.firstTurnPrefix ?? '';
    this.effort = deps.effort ?? null;
    this.currentModelId = deps.model ?? null;

    // Run-specific fields
    this.owner = deps.owner ?? interactiveOwner(deps.nodeId);
    this.interactive = ownerMode(this.owner) === 'interactive';
    this.runtimeProfileHash = deps.profileHash ?? null;
    this.nativeSessionId = deps.threadId || null;
    this.toolProfile = deps.toolProfile;
    this.permissionBroker = deps.permissionBroker;
    this.recover = deps.recover;
    this.cancelTimeoutMs = deps.cancelTimeoutMs ?? 5_000;
    this.approveTimeoutMs = deps.approveTimeoutMs ?? APPROVE_TIMEOUT_MS;
    this.titleTimeoutMs = deps.titleTimeoutMs;
    this.hostText = deps.hostText;
    this.skillInput = deps.skillInput;

    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'in_turn') {
        this.queue.push({ kind: 'heartbeat', idleMs });
      }
    });
  }

  // ---- Public AgentSession interface ----------------------------------------

  getOwnerUserId(): string | null { return this.ownerUserId; }

  /** Whether this session's threads may read and write Codex's own memories (RuntimeConfigPort.features.nativeMemory). */
  keepsNativeMemory(): boolean {
    return this.host.config.features.nativeMemory?.(this.runtimeId, this.ownerUserId) !== false;
  }

  getHistory(): ChatMessage[] {
    return this.history;
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
      maintenance: this.isMaintenance, owner: this.owner, workspaceId: this.workspaceId,
      expectedOwnerUserId: this.host.principal.resolve(this.ownerUserId), runtimeLabel: 'Codex',
    });
  }

  /**
   * A skill turn's own text, and the skill input when Codex can run the skill
   * itself: then `$name` goes before what the user wrote and app-server
   * injects the SKILL.md. Otherwise the skill is expanded into the text.
   */
  private async buildSkillTurn(skill: SkillTurnInvocation, text: string, signal: AbortSignal): Promise<{ text: string; input: CodexSkillInput | null }> {
    const input = this.skillInput ? await abortable(this.skillInput(skill, this.cwd), signal) : null;
    if (!input) return { text: expandSkillPrompt(skill, text), input: null };
    const mention = codexSkillMention(input.name);
    if (!mention) return { text, input };
    return { text: text ? `${mention} ${text}` : mention, input };
  }

  async *send(text: string, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
    if (this.state === 'disposed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }
    const maintenanceContext = this.maintenanceContextForSend(input);
    await this.acquireTurnLock();
    const controller = new AbortController();
    this.turnAbort = controller;
    const pageTurnAttribution = pageAttributionFor(input, this.owner);
    const turnEventGate = { acceptTitle: true };
    try {
      this.activePageTurnAttribution = pageTurnAttribution;
      this.activeMaintenanceExecutionContext = maintenanceContext;
      this.cancelRequested = false;
      this.subagentBlocked = false;
      if (this.state === 'crashed') {
        if (!this.recover) throw new Error('Codex session needs native recovery before another turn.');
        yield { kind: 'retry_start', detail: 'Restoring original Codex session' };
        await abortable(this.recover(this), controller.signal);
        yield { kind: 'retry_end' };
      }
      controller.signal.throwIfAborted();
      const skillTurn = input?.skill ? await this.buildSkillTurn(input.skill, text, controller.signal) : null;
      const turnPrefix = this.firstTurnPrefixConsumed || !this.firstTurnPrefix ? '' : `${this.firstTurnPrefix}\n\n---\n\n`;
      const outgoingText = turnPrefix + (skillTurn?.text ?? text);
      this.firstTurnPrefixConsumed = true;

      // Append follow-up reminder for the model only — history stays clean.
      const userTurnCount = this.history.filter(m => m.role === 'user').length + 1;
      const reminder = this.host.prompt.followUpsTurnReminder(userTurnCount, this.interactive, 'sentinel', this.enableFollowUps);
      // `localImage` is the only attachment input variant Michi sends, so
      // non-image attachments are named by path instead of dropped silently.
      const { images: imageAttachments, promptNote } = prepareAttachments(input?.attachments, outgoingText);
      // Spaces chat and maintenance do not participate in ordinary chat
      // metadata, and a skill turn follows the skill's own output rules.
      const textForModel = turnContextPrefix(this.host.profile.maintenancePromptPrefix?.(maintenanceContext) ?? '', input)
        + outgoingText
        + promptNote
        + (this.isMetaAgent || maintenanceContext ? '' : input?.skill ? (this.host.prompt.skillTurnNote?.() ?? '') : (reminder || '')
        + (this.interactive ? (this.hostText?.turnMetadataInstruction?.('sentinel', this.enableFollowUps) ?? '') : ''));

      this.state = 'in_turn';
      this.interactionAbort = new AbortController();
      const shouldGenerateTitle =
        this.generateTitleOnFirstTurn
        && !this.titleGenerationAttempted
        && this.history.every((message) => message.role !== 'user');
      let titlePromise: Promise<string> | null = null;
      if (shouldGenerateTitle) {
        this.titleGenerationAttempted = true;
        let titleThreadId: string | null = null;
        const source = input?.skill ? undefined : input?.titleSource;
        const titleText = source?.text ?? codexTitleText(input?.skill, text);
        titlePromise = generateCodexTitle({
          client: this.client,
          cwd: this.cwd,
          model: this.titleModel ?? this.currentModelId,
          instructions: this.hostText?.titleInstructions?.() ?? '',
          userText: titleText,
          ...(source && this.hostText?.titleInput ? { input: this.hostText.titleInput(source.text, source.context) } : {}),
          timeoutMs: this.titleTimeoutMs?.(),
          config: codexDisableMcpServers({
            features: { ...CODEX_THREAD_FEATURES_OFF }, ...(this.keepsNativeMemory() ? {} : { memories: { ...CODEX_MEMORIES_OFF } }),
          }, this.userMcpServers),
          onThreadStarted: (threadId) => {
            titleThreadId = threadId;
            if (this.turnAbort === controller && !controller.signal.aborted) {
              this.activeTurnThreadIds.add(threadId);
            }
          },
          signal: controller.signal,
          onTurnStarted: (threadId, turnId) => {
            if (this.turnAbort !== controller) {
              void this.client.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => {});
              return;
            }
            this.nativeTurnIds.set(threadId, turnId);
            if (controller.signal.aborted) void this.interruptThread(threadId);
          },
        }).catch((err) => {
          if (!this.cancelRequested) {
            this.host.observability.log('warn', 'chat', 'codex pre-turn title generation failed; using fallback', {
              nodeId: this.id,
              threadId: this.threadId,
              error: (err as Error).message,
            });
          }
          return fallbackCodexTitle(titleText);
        }).finally(() => {
          if (titleThreadId) this.activeTurnThreadIds.delete(titleThreadId);
        });
      }

      if (!this.isMetaAgent && !input?.skill) this.armTurnMetadata(userTurnCount);
      this.history.push({ role: 'user', content: input?.skill ? turnPrefix + skillHistoryText(input.skill, text) : outgoingText });
      this.markTranslatorTurnStart?.();

      const turnInput = codexTurnInput(textForModel, skillTurn?.input, imageAttachments);

      // Start the real turn immediately. Title and response events share the
      // queue and are delivered in whichever order they actually complete.
      this.activeTurnThreadIds.add(this.threadId);
      this.parentTurnSeq += 1;
      this.nativeSettled = false;
      this.publishIdleChildCompletions();
      const nativeCompletion = new Promise<{ ok: true }>((resolve) => {
        this.settleNativeTurn = () => resolve({ ok: true });
      });
      if (this.interactive) this.permissionModeForTurn = this.host.permissions.mode(this.owner, this.ownerUserId);
      const mainTurnStart = this.client.request('turn/start', codexTurnStartParams({
        // The Michi assistant runs read-only and offline whatever the chat's mode.
        policy: this.isAssistant ? CODEX_RESTRICTED_TURN_POLICY
          : this.interactive ? codexChatTurnPolicy(this.permissionModeForTurn!, this.cwd) : {},
        threadId: this.threadId,
        input: turnInput,
        effort: this.effort,
        modeId: this.currentModeId,
        modelId: this.currentModelId,
      })).then(
        (result) => {
          const turnId = codexStartedTurnId(result);
          if (turnId && this.turnAbort === controller && !this.nativeSettled) {
            this.activeNativeTurnId = turnId;
            this.nativeTurnIds.set(this.threadId, turnId);
            if (this.cancelRequested) void this.interruptThread(this.threadId);
          }
          return { ok: true as const };
        },
        (error: unknown) => ({ ok: false as const, error }),
      );

      const mainStartResult = await abortable(
        Promise.race([mainTurnStart, nativeCompletion]),
        this.transportAbort.signal,
      );
      if (this.cancelRequested) {
        turnEventGate.acceptTitle = false;
        if (mainStartResult.ok) {
          // Consume the terminal marker even after an error, so it cannot end
          // the next turn when this native completion races with turn/start.
          for await (const _ev of this.queue.drainUntilTurnEnd()) { /* drain */ }
        }
        yield { kind: 'turn_end', stopReason: 'cancelled' };
        return;
      }
      if (!mainStartResult.ok) {
        turnEventGate.acceptTitle = false;
        // The app-server answered: it refused the turn, so no native turn
        // runs and there is nothing to stop or recover. A timeout or a dead
        // connection leaves that unknown, and the session restarts as before.
        if (mainStartResult.error instanceof CodexRpcError) this.nativeSettled = true;
        await Promise.all(
          [...this.activeTurnThreadIds]
            .filter((threadId) => threadId !== this.threadId)
            .map((threadId) => this.interruptThread(threadId)),
        );
        throw mainStartResult.error;
      }

      if (titlePromise) {
        void titlePromise.then((title) => {
          if (!turnEventGate.acceptTitle) return;
          if (!this.cancelRequested) {
            // Method is `thread/name/set` (ThreadSetNameParams), not
            // `thread/setName` — the latter does not exist in the app-server
            // ClientRequest union and every call silently failed here.
            void this.client.request('thread/name/set', { threadId: this.threadId, name: title }).catch((err) => {
              this.host.observability.log('debug', 'chat', 'codex thread/name/set failed after pre-turn title generation', {
                nodeId: this.id,
                threadId: this.threadId,
                error: (err as Error).message,
              });
            });
          }
          this.queue.push({ kind: 'title', title });
        });
      }

      const assistantChunks: string[] = [];
      this.pendingAssistantBuf = assistantChunks;
      let titleDelivered = titlePromise === null;
      let pendingTurnEnd: Extract<NormalizedEvent, { kind: 'turn_end' }> | null = null;
      while (true) {
        const ev = await this.queue.pull();
        if (ev === null) break;
        if (ev.kind === 'runtime_error') {
          // Consumers such as ChatHub stop iterating as soon as they see the
          // error. Consume its terminal marker first, so it cannot leak into
          // the next turn, and do not wait for an unrelated title task.
          turnEventGate.acceptTitle = false;
          for await (const terminal of this.queue.drainUntilTurnEnd()) {
            if (terminal.kind === 'turn_end') pendingTurnEnd = terminal;
          }
          yield ev;
          break;
        }
        if (ev.kind === 'turn_end') {
          pendingTurnEnd = ev;
          const stateAtTurnEnd = this.state as SessionState;
          if (this.cancelRequested || stateAtTurnEnd === 'crashed' || stateAtTurnEnd === 'disposed') {
            turnEventGate.acceptTitle = false;
            titleDelivered = true;
          }
          if (titleDelivered) break;
          continue;
        }
        if (ev.kind === 'title') titleDelivered = true;
        if (ev.kind === 'chunk') assistantChunks.push(ev.text);
        // Yielded below: an idle completion is reported once it reaches the
        // consumer, not when it was queued (a cancel drains the queue).
        if (ev.kind === 'subagent_list_update' && this.idleChildCompletions.size > 0) {
          for (const entry of ev.subagents) {
            this.idleChildCompletions.delete(entry.sessionId);
            this.idleChildEnded.delete(entry.sessionId);
          }
          this.syncBackgroundSubagents();
        }
        if (!(this.cancelRequested && ev.kind === 'title')) yield ev;
        if (pendingTurnEnd && titleDelivered) break;
      }
      // A turn stopped for a sub-agent ended as interrupted; it failed.
      if (pendingTurnEnd && this.subagentBlocked && pendingTurnEnd.stopReason === 'cancelled') {
        pendingTurnEnd = { kind: 'turn_end', stopReason: 'error' };
      }
      if (pendingTurnEnd) yield pendingTurnEnd;
      if (assistantChunks.length > 0) {
        this.history.push({ role: 'assistant', content: assistantChunks.join('') });
      }
      const stateAfterDrain = this.state as SessionState;
      if (stateAfterDrain !== 'crashed' && stateAfterDrain !== 'disposed') {
        this.state = 'idle';
      }
    } catch (error) {
      if (!this.cancelRequested && !controller.signal.aborted) throw error;
      yield { kind: 'turn_end', stopReason: 'cancelled' };
    } finally {
      const finalState = this.state as SessionState;
      if (!this.nativeSettled && finalState !== 'crashed' && finalState !== 'disposed') {
        this.requiresRestart = true;
        this.markCrashed('Codex turn ended locally before native completion. Original thread retained.');
      }
      this.clearInteractions();
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
      controller.abort();
      if (this.turnAbort === controller) this.turnAbort = null;
      if (this.activePageTurnAttribution === pageTurnAttribution) this.activePageTurnAttribution = null;
      if (this.activeMaintenanceExecutionContext === maintenanceContext) this.activeMaintenanceExecutionContext = null;
      this.settleNativeTurn = null;
      this.pendingAssistantBuf = null;
      turnEventGate.acceptTitle = false;
      this.activeTurnThreadIds.clear();
      this.nativeTurnIds.clear();
      this.interrupts.clear();
      this.activeNativeTurnId = null;
      this.cancelRequested = false;
      if (this.state === 'in_turn') this.state = 'idle';
      this.finishTurnMetadata();
      this.touch();
      this.releaseTurnLock();
    }
  }

  async cancel(): Promise<CancelAck> {
    if (!this.turnAbort && this.state !== 'in_turn' && this.activeTurnThreadIds.size === 0) {
      return { acknowledged: false };
    }
    this.cancelRequested = true;
    this.turnAbort?.abort();
    this.clearInteractions();
    if (!this.nativeSettled && !this.cancelTimer) {
      this.cancelTimer = setTimeout(() => {
        this.requiresRestart = true;
        this.markCrashed('Codex cancellation timed out. Original thread retained for native recovery.');
      }, this.cancelTimeoutMs);
    }
    const threadIds = this.activeTurnThreadIds.size > 0
      ? [...this.activeTurnThreadIds]
      : [this.threadId];
    const results = await Promise.all(threadIds.map((threadId) => this.interruptThread(threadId)));
    // turn/interrupt is a real request with a response, so this ack is native.
    return {
      acknowledged: results.length > 0 && results.every(Boolean),
      source: 'native',
      confidence: 'native',
      nativeMethod: 'turn/interrupt',
    };
  }

  /**
   * Chooses a Codex collaboration mode (`default` or `plan`) for the next
   * turns. Codex keeps a thread's last mode, so the choice is sent with every
   * turn from the next one on; a running turn keeps its mode.
   */
  async setMode(modeId: string): Promise<void> {
    if (!isCodexModeKind(modeId)) throw new Error(`Unknown Codex collaboration mode: ${modeId}`);
    if (this.isAssistant) throw new Error('The Michi assistant runs in Codex\'s default mode');
    if (!this.currentModelId) throw new Error('Codex collaboration modes need the session\'s model');
    this.currentModeId = modeId;
  }

  async steer(text: string): Promise<SteerResult> {
    if (this.state !== 'in_turn') return { accepted: false, reason: 'not_in_turn' };
    const expectedTurnId = this.activeNativeTurnId ?? this.threadId;
    try {
      const result = await this.client.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId,
        input: [{ type: 'text', text }],
      });
      const turnId = result && typeof result === 'object' && typeof (result as { turnId?: unknown }).turnId === 'string'
        ? (result as { turnId: string }).turnId
        : expectedTurnId;
      return { accepted: true, pending: true, turnId };
    } catch (err) {
      this.host.observability.log('warn', 'chat', 'codex turn/steer failed', {
        nodeId: this.id,
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { accepted: false, reason: 'steer_rpc_failed' };
    }
  }

  async compact(): Promise<CompactResult> {
    try {
      await this.client.request('thread/compact/start', { threadId: this.threadId });
      return { started: true };
    } catch (err) {
      this.host.observability.log('warn', 'chat', 'codex thread/compact/start failed', {
        nodeId: this.id,
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { started: false };
    }
  }

  /**
   * Aligns a native Codex thread/fork id onto this session. Does not create
   * a Michi node — conversation fork remains the node/edge graph.
   */
  async alignNativeFork(): Promise<{ threadId?: string }> {
    try {
      const result = await this.client.request('thread/fork', { threadId: this.threadId });
      const forked = result && typeof result === 'object' && typeof (result as { thread?: { id?: unknown } }).thread === 'object'
        ? (result as { thread: { id?: unknown } }).thread.id
        : (result as { threadId?: unknown } | null)?.threadId;
      if (typeof forked === 'string' && forked) {
        this.alignedForkThreadId = forked;
        return { threadId: forked };
      }
      return {};
    } catch (err) {
      this.host.observability.log('warn', 'chat', 'codex thread/fork align failed', {
        nodeId: this.id,
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  describeNativeState(): Record<string, unknown> {
    return {
      threadId: this.threadId,
      alignedForkThreadId: this.alignedForkThreadId,
      activeNativeTurnId: this.activeNativeTurnId,
      michiNodeId: this.id,
    };
  }

  private async interruptThread(threadId: string): Promise<boolean> {
    const turnId = this.nativeTurnIds.get(threadId);
    if (!turnId) return false;
    const key = `${threadId}:${turnId}`;
    const pending = this.interrupts.get(key);
    if (pending) return pending;
    const work = this.client.request('turn/interrupt', { threadId, turnId }, this.cancelTimeoutMs).then(() => true, () => false);
    this.interrupts.set(key, work);
    return work;
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

  respondToUserInput(requestId: number, answers: UserInputAnswer[]): void {
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

  async askUserInput(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const currentTurn = this.controlIsCurrent(params);
    const isCurrent = () => currentTurn() && !signal?.aborted;
    if (!isCurrent()) { respond({ answers: {} }); return; }
    const parsedQuestions = codexUserInputQuestions(params);
    if (!parsedQuestions) {
      respond({ answers: {} });
      return;
    }

    const answers = await this.requestUserInput(parsedQuestions, signal);

    if (answers && isCurrent()) {
      // Keep this matching in CodexSession.ts: the Codex contract mutation hook
      // (backend/test/contracts/codex/mutation-hook.cjs) mutates it in this file.
      const responseObj: Record<string, { answers: string[] }> = Object.create(null);
      for (const a of answers) {
        if (!a || typeof a.answer !== 'string') continue;
        const matches = parsedQuestions.filter((q) => a.id !== undefined ? q.id === a.id : q.question === a.question);
        // Older renderers and Run brokers send labels. Only accept an unambiguous
        // label; duplicate wording must never cross-answer two distinct questions.
        if (matches.length === 1) responseObj[matches[0].id!] = { answers: [a.answer] };
      }
      respond({ answers: responseObj });
    } else {
      respond({ answers: {} });
    }
  }

  private async requestUserInput(
    questions: UserInputQuestion[],
    signal?: AbortSignal,
  ): Promise<UserInputAnswer[] | null> {
    const isCurrent = this.controlIsCurrent();
    if (!isCurrent()) return null;
    const requestId = nextInteractionRequestId();
    this.queue.push({ kind: 'user_input_request', requestId, questions });

    const answers = await new Promise<UserInputAnswer[] | null>((resolve) => {
      const onAbort = () => this.skipUserInput(requestId);
      const finish = (value: UserInputAnswer[] | null) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.pendingUserInputs.delete(requestId);
        finish(null);
      }, this.approveTimeoutMs);
      this.pendingUserInputs.set(requestId, { resolve: finish, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });

    if (!isCurrent()) return null;
    this.queue.push({ kind: 'user_input_resolved', requestId, answers: answers ?? [] });
    return answers;
  }

  /**
   * A typed form from one of the user's MCP servers, in a chat, is asked on
   * Michi's user-input card under the server's name; the answers are kept
   * like any other card's. URL and verification flows, untyped forms and
   * Runs are declined.
   */
  async askMcpElicitation(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const currentTurn = this.controlIsCurrent(params);
    const isCurrent = () => currentTurn() && !signal?.aborted;
    if (!isCurrent()) { respond({ action: 'cancel', content: null, _meta: null }); return; }
    const fields = this.interactive && !this.isMetaAgent && params.mode === 'form' ? formElicitationFields(params) : [];
    if (!fields.length) { respond({ action: 'decline', content: null, _meta: null }); return; }
    const serverName = typeof params.serverName === 'string' && params.serverName ? params.serverName : undefined;
    const answers = await this.requestUserInput(fields.map((field) => ({ ...field.question, ...(serverName ? { header: serverName } : {}) })), signal);
    respond(answers && isCurrent()
      ? { action: 'accept', content: formElicitationContent(fields, answers), _meta: null }
      : { action: 'cancel', content: null, _meta: null });
  }

  // ---- Approval handling (called by CodexRuntime) ---------------------------

  /**
   * Handle an approval request for this session. For headless owners, the
   * request is delegated to the Run permission broker — never to the
   * workspace policy resolver or grant persistence. Chat sessions retain
   * the existing user-facing permission request flow.
   */
  async askPermission(
    method: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const currentTurn = this.controlIsCurrent(params);
    const isCurrent = () => currentTurn() && !signal?.aborted;
    if (!isCurrent()) { respond({ decision: 'decline' }); return; }
    const toolName = canonicalToolNameFromMethod(method);

    // Agent Run owner: delegate to the immutable Run permission broker.
    // MUST NOT consult the chat policy or write a chat grant.
    if (!this.interactive && this.permissionBroker) {
      let decision: RuntimePermissionDecision;
      try {
        decision = await abortable(this.permissionBroker.requestPermission({
          owner: this.owner,
          ownerUserId: this.ownerUserId,
          workspaceId: this.workspaceId,
          toolName,
          input: params,
        }), signal ? AbortSignal.any([this.interactionAbort.signal, signal]) : this.interactionAbort.signal);
      } catch {
        respond({ decision: 'decline' });
        return;
      }
      if (!isCurrent()) { respond({ decision: 'decline' }); return; }

      const brokered = codexBrokerDecision(decision);
      if (brokered) {
        respond({ decision: brokered });
        return;
      }
      // Broker said "ask" → present as a user-facing permission request
      // using the standard approval flow (which routes through Run
      // interactions), but still never persist a grant.
      const requestId = nextInteractionRequestId();
      this.queue.push(codexPermissionRequest(requestId, method, params, toolName, codexRunAskOptions()));
      const result = await this.awaitPermission(requestId, signal);
      if (!isCurrent()) { respond({ decision: 'decline' }); return; }
      // As for Claude and Pi, allow_always approves only this request.
      if (result === 'allow_once' || result === 'allow_always') {
        respond({ decision: 'accept' });
        return;
      }
      respond({ decision: 'decline' });
      return;
    }

    // The one chat decision for this request, with this session's own user:
    // grants are evaluated for every request, including later tools in this turn.
    const policy = this.approvals.policy(this.owner, this.ownerUserId, toolName, true, this.permissionModeForTurn);
    if (policy === 'allow') {
      respond({ decision: 'accept' });
      return;
    }
    if (policy === 'deny') {
      respond({ decision: 'decline' });
      return;
    }

    // Chat session: existing user-facing permission request flow.
    const requestId = nextInteractionRequestId();

    this.queue.push(codexPermissionRequest(requestId, method, params, toolName, chatApprovalOptions(toolName)));

    const result = await this.awaitPermission(requestId, signal, toolName);

    if (!isCurrent()) { respond({ decision: 'decline' }); return; }

    if (this.approvals.accept(result, this.owner, toolName, this.ownerUserId)) {
      for (const [id, request] of this.pendingPermissions) {
        if (this.approvals.covers(result, toolName, request.toolName)) this.respondToPermission(id, 'allow_once');
      }
      respond({ decision: 'accept' });
      return;
    }
    respond({ decision: 'decline' });
  }

  private awaitPermission(requestId: number, signal?: AbortSignal, toolName?: string): Promise<string | null> {
    // The queue the request was pushed on, so the resolution reaches its turn.
    const queue = this.queue;
    return new Promise<string | null>((resolve) => {
      const onAbort = () => this.cancelPermission(requestId);
      const finish = (value: string | null) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        // Unanswered: the request is declined. Say so, as ACP does, so the
        // host clears the pending request and no late answer is offered.
        queue.push({ kind: 'permission_resolved', requestId });
        finish(null);
      }, this.approveTimeoutMs);
      this.pendingPermissions.set(requestId, { resolve: finish, timer, toolName });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /**
   * Terminate all pending approvals and push a terminal event pair.
   * Called by CodexRuntime when the daemon exits unexpectedly.
   */
  markCrashed(reason: string): void {
    if (this.state === 'crashed' || this.state === 'disposed') return;
    this.state = 'crashed';
    this.transportAbort.abort(new Error(reason));
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = null;

    this.clearInteractions();

    // Clean up child thread tracking. The children ran in the daemon that
    // exited: nothing will report the background ones.
    const ends = this.backgroundSubagentEnds();
    this.unsubGlobalNotification?.();
    this.unsubGlobalNotification = null;
    for (const [, unsub] of this.childNotificationUnsubs) unsub();
    this.childNotificationUnsubs.clear();
    this.childThreadInfos.clear();
    this.childPublishedTurn.clear();
    this.idleChildCompletions.clear();
    this.idleChildEnded.clear();
    this.endBackgroundSubagents(ends);

    this.queue.push({ kind: 'runtime_error', error: reason });
    this.queue.push({ kind: 'turn_end', stopReason: 'error' });
    this.queue.dispose();
  }

  private clearInteractions(): void {
    this.interactionAbort.abort();
    for (const entries of [this.pendingPermissions, this.pendingUserInputs]) {
      for (const entry of entries.values()) { clearTimeout(entry.timer); entry.resolve(null); }
      entries.clear();
    }
  }

  isBusy(): boolean { return this.state === 'in_turn' || (this.state !== 'crashed' && !!this.turnLock); }
  touch(): void { this.lastUsedAt = Date.now(); }
  isIdleExpired(now: number, ttlMs: number): boolean {
    // A terminal notification can mark the state idle before send() finishes.
    // Keep the session until its consumer has drained and released the turn lock.
    return this.state === 'idle' && !this.turnLock && now - this.lastUsedAt >= ttlMs;
  }

  /**
   * For a session holding background work: idle for `ttlMs` since its own
   * last use and its children's last frame (a child still working keeps
   * it), or for `capMs` since its own last use whatever the children do.
   */
  isBackgroundIdleExpired(now: number, ttlMs: number, capMs: number): boolean {
    if (this.state !== 'idle' || this.turnLock) return false;
    if (now - this.lastUsedAt >= capMs) return true;
    return now - Math.max(this.lastUsedAt, this.lastChildActivityAt) >= ttlMs;
  }
  needsRecovery(): boolean { return this.state === 'crashed'; }
  acceptsControl(params: Record<string, unknown>): boolean {
    if (this.state !== 'in_turn' || this.nativeSettled || !this.turnAbort || this.turnAbort.signal.aborted) return false;
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return false;
    return typeof params.turnId !== 'string' || params.turnId === this.activeNativeTurnId;
  }

  private controlIsCurrent(params: Record<string, unknown> = {}): () => boolean {
    const turn = this.turnAbort;
    return () => this.turnAbort === turn && this.acceptsControl(params);
  }

  async prepareNativeResume(): Promise<string> {
    await this.disposeMcpSlot();
    return this.createMcpSlot();
  }

  completeNativeResume(): void {
    if (this.state === 'disposed') throw new Error('Codex session was disposed during recovery');
    this.queue.dispose();
    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'in_turn') this.queue.push({ kind: 'heartbeat', idleMs });
    });
    this.transportAbort = new AbortController();
    this.nativeSettled = true;
    this.requiresRestart = false;
    this.state = 'idle';
    this.wireNotifications();
  }

  // ---- MCP slot setup -------------------------------------------------------

  private armTurnMetadata(userTurnCount: number): void {
    this.turnMetadata.begin();
    this.host.observability.log('debug', 'chat', 'codex turn metadata armed', {
      nodeId: this.id,
      threadId: this.threadId,
      userTurnCount,
    });
  }

  private suppressFollowUpsInternalEvent(ev: NormalizedEvent): boolean {
    return this.turnMetadata.suppressOutput(ev.kind);
  }

  /** Michi's turn-metadata calls; a tool of another MCP server is never one, whatever its name. */
  private suppressInternalMetadataToolEvent(ev: NormalizedEvent): boolean {
    if ((ev.kind === 'tool_call' || ev.kind === 'tool_call_update') && ev.hostTool === false) return false;
    if (ev.kind === 'tool_call') {
      if (!isTurnMetadataToolTitle(ev.title)) return false;
      if (ev.toolCallId) this.hiddenInternalToolCallIds.add(ev.toolCallId);
      return true;
    }
    if (ev.kind !== 'tool_call_update') return false;
    if (
      !this.hiddenInternalToolCallIds.has(ev.toolCallId)
      && !isTurnMetadataToolTitle(ev.title)
    ) return false;
    if (ev.toolCallId) this.hiddenInternalToolCallIds.add(ev.toolCallId);
    return true;
  }

  private observeFollowUpsSentinelEvent(ev: NormalizedEvent): void {
    if (ev.kind !== 'chunk') return;
    this.turnMetadata.observeChunk(ev.text, this.enableFollowUps);
  }

  private finishTurnMetadata(): void {
    this.hiddenInternalToolCallIds.clear();
    const suppressed = this.turnMetadata.finish();
    if (suppressed.chunks > 0 || suppressed.thoughts > 0) {
      this.host.observability.log('debug', 'chat', 'codex hidden metadata output suppressed', {
        nodeId: this.id,
        threadId: this.threadId,
        ...suppressed,
      });
    }
  }

  /**
   * Create an MCP slot for this session. For headless owners, uses the
   * owner-aware `buildRunMcpSlotCallbacks` factory so the slot carries the
   * immutable owner identity, exposed tool allow-list, and
   * `submit_agent_result` hook. Chat sessions use the existing callback path.
   */
  createMcpSlot(): string {
    // A Meta agent slot is marked (its catalog needs the mark, and the
    // assistant's the database too) and carries its allow-list.
    const metaAgentAllowed = this.isMetaAgent ? this.toolProfile?.allowedToolNames : undefined;
    const chatCallbacks = {
      owner: this.owner,
      getActivePageTurnAttribution: () => this.getActivePageTurnAttribution(),
      ...(this.isMaintenance ? { maintenance: true as const, getActiveMaintenanceExecutionContext: () => this.getActiveMaintenanceExecutionContext() } : {}),
      ...(this.isAssistant ? { restricted: true } : {}),
      ...(metaAgentAllowed ? { exposedToolNames: new Set(metaAgentAllowed) as ReadonlySet<string> } : {}),
      // The host's tools report their effect (branches, artifacts, images) here.
      sink: hostEventSink((event) => this.queue.push(event)),
      // One callback for each business effect the bridge has: one it lacks offers no tool.
      ...(this.bridge.spawnBranches ? {
        onSpawnBranches: async (topics: Array<{ title: string; prompt: string }>) => this.bridge.spawnBranches!({
          parentChatId: this.id,
          cwd: this.cwd,
          enableFollowUps: this.enableFollowUps,
          ownerUserId: this.ownerUserId,
          topics,
        }),
      } : {}),
      ...(this.bridge.saveContext ? {
        onSaveArtifact: (name: string, body: string | undefined, path?: string) =>
          this.bridge.saveContext!({ cwd: this.cwd, chatId: this.id, ownerUserId: this.ownerUserId, name, body, path }),
      } : {}),
      ...(this.bridge.updateContext ? {
        onUpdateArtifact: (name: string, body: string) =>
          this.bridge.updateContext!({ cwd: this.cwd, chatId: this.id, ownerUserId: this.ownerUserId, name, body }),
      } : {}),
      onShowImage: (inputPath: string) => {
        const r = resolveShowImage(this.cwd, inputPath);
        if (!r.ok) return { error: r.error };
        return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
      },
      onAskUser: async (questions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect: boolean;
      }>) => {
        const answers = await this.requestUserInput(questions);
        if (!answers) return null;
        const result: Record<string, string> = {};
        for (const answer of answers) {
          result[answer.question] = answer.answer;
        }
        return result;
      },
      ...(!this.isMetaAgent && this.interactive ? {
        onSetBranchOverview: (overview: string) => {
          const result = this.turnMetadata.setOverview(overview);
          if (!result) return;
          const cleaned = result.overview;
          this.host.observability.log('debug', 'mcp', 'codex set_branch_overview received', {
            nodeId: this.id,
            threadId: this.threadId,
            length: cleaned.length,
          });
          this.queue.push({ kind: 'host_event', type: 'branch_overview', payload: { overview: cleaned } });
        },
      } : {}),
    };

    // Agent Run owner: use the Run MCP slot factory with owner metadata,
    // exposed tool allow-list, and submit_agent_result hook.
    if (!this.interactive && this.toolProfile) {
      const runCallbacks = buildRunMcpSlotCallbacks({
        owner: this.owner,
        workspaceId: this.workspaceId,
        ownerUserId: this.ownerUserId,
        toolProfile: this.toolProfile,
        chatCallbacks,
      });

      const slot = this.mcpRegistry.create(
        this.id,
        this.cwd,
        this.ownerUserId,
        runCallbacks,
        { nodeId: null, workspaceId: this.workspaceId },
      );
      this.slotId = slot.slotId;
      return slot.slotId;
    }

    // Chat session: existing MCP slot creation path.
    const slot = this.mcpRegistry.create(
      this.id,
      this.cwd,
      this.ownerUserId,
      chatCallbacks,
      { nodeId: this.id, workspaceId: this.workspaceId },
    );
    this.slotId = slot.slotId;
    return slot.slotId;
  }

  // ---- Translator wiring ----------------------------------------------------

  wireNotifications(): void {
    this.unsubscribeNotification?.();
    this.unsubGlobalNotification?.();
    const translator = createCodexTranslator((ev) => {
      this.observeFollowUpsSentinelEvent(ev);
      if (this.suppressInternalMetadataToolEvent(ev)) return;
      if (this.suppressFollowUpsInternalEvent(ev)) return;
      if ((ev.kind === 'turn_end' || ev.kind === 'runtime_error') && this.state === 'in_turn') {
        this.state = 'idle';
      }
      // A spawnAgent hand-off names its child threads directly; thread/started
      // is not guaranteed for them, so track children from the roster too.
      if (ev.kind === 'subagent_list_update') {
        for (const entry of ev.subagents) {
          const known = this.childThreadInfos.get(entry.sessionId);
          if (known) this.childThreadInfos.set(entry.sessionId, mergeSubagentEntry(known, entry));
          else this.trackChildThread(entry.sessionId, mergeSubagentEntry(undefined, entry), false);
          this.childPublishedTurn.set(entry.sessionId, this.parentTurnSeq);
        }
        this.syncBackgroundSubagents();
      }
      this.queue.push(ev);
    });
    this.markTranslatorTurnStart = translator.startTurn;

    this.unsubscribeNotification = this.client.onNotification(
      this.threadId,
      (method, params) => {
        if (this.state === 'crashed' || this.state === 'disposed' || this.nativeSettled) return;
        const turn = params.turn as { id?: string; status?: string } | undefined;
        const turnId = typeof params.turnId === 'string' ? params.turnId : turn?.id;
        if (turnId && (this.completedTurnIds.has(turnId) || (this.activeNativeTurnId && this.activeNativeTurnId !== turnId))) return;
        if (turnId) {
          this.activeNativeTurnId = turnId;
          this.nativeTurnIds.set(this.threadId, turnId);
        }
        if (this.isAssistant && method === 'item/started') {
          const signal = codexSpawnSignal((params['item'] ?? {}) as Record<string, unknown>);
          if (signal) this.blockRestrictedSubagent(signal.childThreadId);
        }
        if (method === 'turn/completed') {
          this.markBackgroundChildren();
          this.nativeSettled = true;
          this.settleNativeTurn?.();
          if (turnId) this.completedTurnIds.add(turnId);
          if (this.completedTurnIds.size > 100) this.completedTurnIds.delete(this.completedTurnIds.values().next().value!);
          if (this.cancelTimer) clearTimeout(this.cancelTimer);
          this.cancelTimer = undefined;
          this.clearInteractions();
        }
        translator.feed(method, params);
        if (method === 'turn/started' && this.cancelRequested) void this.interruptThread(this.threadId);
      },
    );

    // ---- Child subagent thread discovery via global notification handler -----
    this.unsubGlobalNotification = this.client.onGlobalNotification((method, params) => {
      if (this.isAssistant) this.stopRestrictedChildTurn(method, params);
      if (method === 'thread/started') {
        this.handleChildThreadStarted(params);
      } else if (method === 'thread/status/changed' || method === 'thread/closed') {
        this.handleChildThreadLifecycle(method, params);
      }
    });
  }

  // ---- Restricted sessions: sub-agent guard -------------------------------------

  /**
   * A restricted turn started a sub-agent (its thread config makes Codex
   * refuse spawns, so this is the fallback): report the error once, stop the
   * turn, and stop the child's turns. Interrupting the parent does not stop
   * a running child (codex 0.165), so each child turn is interrupted too
   * (stopRestrictedChildTurn). A parent turn Codex will not stop is
   * recovered by restarting app-server, which ends the child as well.
   */
  private blockRestrictedSubagent(childThreadId: string | null): void {
    if (childThreadId && childThreadId !== this.threadId) this.blockedChildThreads.add(childThreadId);
    if (this.subagentBlocked || this.state !== 'in_turn' || this.nativeSettled) return;
    this.subagentBlocked = true;
    this.host.observability.log('warn', 'chat', 'codex restricted session started a sub-agent; stopping the turn', {
      nodeId: this.id, threadId: this.threadId, childThreadId,
    });
    this.queue.push({
      kind: 'runtime_error', error: CODEX_RESTRICTED_SUBAGENT_ERROR,
      code: 'codex_subagent_blocked', category: 'terminal', retryable: false,
    });
    const stopFailed = () => {
      if (this.nativeSettled) return;
      this.requiresRestart = true;
      this.markCrashed('Codex did not stop a turn that started a sub-agent. Original thread retained for native recovery.');
    };
    void this.interruptThread(this.threadId).then((ok) => { if (!ok) stopFailed(); });
    if (!this.cancelTimer) this.cancelTimer = setTimeout(stopFailed, this.cancelTimeoutMs);
  }

  /**
   * Interrupts every turn of a child this restricted session started: a
   * thread it already blocked, or one whose turn descends from this thread's
   * turn (`rootTurnId`), which also blocks the parent turn.
   */
  private stopRestrictedChildTurn(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : null;
    if (!threadId || threadId === this.threadId) return;
    const turn = params['turn'] as { id?: unknown; rootTurnId?: unknown } | undefined;
    const turnId = typeof params['turnId'] === 'string' ? params['turnId'] : typeof turn?.id === 'string' ? turn.id : null;
    if (!turnId) return;
    const root = typeof turn?.rootTurnId === 'string' ? turn.rootTurnId : null;
    const descends = method === 'turn/started' && root !== null && root !== turnId
      && (root === this.activeNativeTurnId || this.completedTurnIds.has(root));
    if (!this.blockedChildThreads.has(threadId) && !descends) return;
    if (descends) this.blockRestrictedSubagent(threadId);
    if (method === 'turn/completed') return;
    const key = `${threadId}:${turnId}`;
    if (this.interruptedChildTurns.has(key)) return;
    this.interruptedChildTurns.add(key);
    if (this.interruptedChildTurns.size > 200) this.interruptedChildTurns.delete(this.interruptedChildTurns.values().next().value!);
    void this.client.request('turn/interrupt', { threadId, turnId }, this.cancelTimeoutMs).catch((err: unknown) => {
      this.host.observability.log('warn', 'chat', 'codex could not interrupt a restricted session\'s sub-agent', {
        nodeId: this.id, childThreadId: threadId, error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ---- Child subagent thread handling ----------------------------------------

  private handleChildThreadStarted(params: Record<string, unknown>): void {
    const thread = (params['thread'] ?? params) as Record<string, unknown>;
    const parentId = typeof thread['parentThreadId'] === 'string' ? thread['parentThreadId'] : null;
    if (parentId !== this.threadId) return; // Not our child

    const childId = typeof thread['id'] === 'string' ? thread['id'] : '';
    if (this.isAssistant && childId) this.blockRestrictedSubagent(childId);
    if (!childId || this.childThreadInfos.has(childId)) return; // Already tracked

    this.trackChildThread(childId, codexChildThreadInfo(thread, childId), true);
  }

  /**
   * Track one child thread: publish its roster entry (when it is new to the
   * stream) and translate its notifications into the child's activity, its
   * final answer (`result`) and its outcome. Child frames only flow while the
   * parent turn is open; afterwards they would leak into the next turn.
   */
  /**
   * Parent turn ending while a child still works: its spawning message
   * records it as running in the background.
   */
  private markBackgroundChildren(): void {
    for (const [childId, info] of this.childThreadInfos) {
      if (info.status !== 'working' || this.childPublishedTurn.get(childId) !== this.parentTurnSeq) continue;
      if (this.blockedChildThreads.has(childId)) continue;
      const updated = { ...info, background: true };
      this.childThreadInfos.set(childId, updated);
      this.queue.push({ kind: 'subagent_list_update', subagents: [{ sessionId: childId, background: true }] });
    }
    this.syncBackgroundSubagents();
  }

  /**
   * Background children this session still tracks: running after the
   * parent turn that launched them, or finished while the parent was idle
   * and not yet reported (idleChildCompletions).
   */
  private backgroundSubagentIds(): string[] {
    const ids = new Set([...this.idleChildCompletions].filter((id) => !this.idleChildEnded.has(id)));
    for (const [childId, info] of this.childThreadInfos) {
      if (info.background && info.status === 'working' && !this.blockedChildThreads.has(childId)) ids.add(childId);
    }
    return [...ids];
  }

  /** Disposing this session now would lose a background child or its completion. */
  hasBackgroundWork(): boolean {
    return this.state !== 'crashed' && this.state !== 'disposed' && this.backgroundSubagentIds().length > 0;
  }

  /**
   * Tell the registry which background children this session tracks (chat
   * sessions only). A crashed or disposed session tracks none.
   */
  private syncBackgroundSubagents(): void {
    const context = this.backgroundSubagentContext();
    if (!context) return;
    const ids = this.state === 'crashed' || this.state === 'disposed' ? [] : this.backgroundSubagentIds();
    if (ids.length === this.reportedBackground.length && ids.every((id, index) => id === this.reportedBackground[index])) return;
    this.reportedBackground = ids;
    this.backgroundSubagents.report(context, this.backgroundSubagentSource, ids);
  }

  /** Chat sessions only. */
  private backgroundSubagentContext(): BackgroundSubagentContext | null {
    if (!this.interactive) return null;
    return sessionOwnerContext(this.host.principal, this.ownerUserId, this.workspaceId, this.owner);
  }

  /**
   * How each background child this session still tracks ends now that
   * Michi stops listening to it: the outcome it finished with while the
   * parent was idle, else stopped. Read before the tracking is cleared.
   */
  private backgroundSubagentEnds(): SubagentEnd[] {
    const now = Date.now();
    return this.backgroundSubagentIds().map((childId) =>
      subagentEndOf(this.childThreadInfos.get(childId) ?? { sessionId: childId }, SUBAGENT_SESSION_ENDED_ERROR, now));
  }

  /** The session ended (crash, dispose): withdraw its background children and record `ends`. */
  private endBackgroundSubagents(ends: readonly SubagentEnd[]): void {
    const context = this.backgroundSubagentContext();
    // Nothing tracked and nothing reported (a dispose after a crash): nothing to end.
    if (!context || (ends.length === 0 && this.reportedBackground.length === 0)) return;
    this.reportedBackground = [];
    this.backgroundSubagents.end(context, this.backgroundSubagentSource, ends);
  }

  /**
   * Parent turn start: background children that finished while the parent
   * was idle report into this turn with their full entry (outcome, result),
   * as Claude's carried agents do. Codex starts no turn of its own, so this
   * is the next send(). Queued inside the turn; nothing goes out between
   * turns.
   */
  private publishIdleChildCompletions(): void {
    for (const childId of this.idleChildCompletions) {
      const info = this.childThreadInfos.get(childId);
      if (!info) {
        this.idleChildCompletions.delete(childId);
        continue;
      }
      this.childPublishedTurn.set(childId, this.parentTurnSeq);
      this.queue.push({ kind: 'subagent_list_update', subagents: [{ ...info }] });
    }
  }

  /**
   * A background child finished with an outcome while the parent is idle.
   * Codex starts no parent turn to report it, so without this the badge
   * would show it running until the user's next message. End it in the
   * registry now (stored on the rosters, sent to open renderers), once; the
   * next parent turn still reports its full entry. A closure without an
   * outcome (thread idle before its turn/completed) waits for one.
   */
  private endIdleChildCompletion(childId: string, info: SubagentInfo): void {
    if (this.idleChildEnded.has(childId)) return;
    const context = this.backgroundSubagentContext();
    if (!context || this.state === 'crashed' || this.state === 'disposed') return;
    this.idleChildEnded.add(childId);
    // end() withdraws all of this source's; syncBackgroundSubagents (the
    // caller) reports the ones still running again.
    this.reportedBackground = [];
    this.backgroundSubagents.end(context, this.backgroundSubagentSource, [subagentEndOf(info, SUBAGENT_SESSION_ENDED_ERROR, Date.now())]);
  }

  /**
   * Queue a child frame for the open parent turn. A child carried over from
   * an earlier turn first republishes its full entry, so this turn's roster
   * knows it (activity for an unknown agent is dropped by the fold).
   * Frames between turns are dropped: they would open no turn of their own.
   */
  private pushChild(childId: string, ev: NormalizedEvent): void {
    const info = this.childThreadInfos.get(childId);
    if (this.nativeSettled) {
      // The caller recorded the child's state first: a background child
      // that ended here reports into the next parent turn.
      if (info?.background && info.status === 'terminated') {
        this.idleChildCompletions.add(childId);
        if (info.outcome) this.endIdleChildCompletion(childId, info);
      }
      this.syncBackgroundSubagents();
      return;
    }
    if (info && this.childPublishedTurn.get(childId) !== this.parentTurnSeq) {
      this.childPublishedTurn.set(childId, this.parentTurnSeq);
      this.queue.push({ kind: 'subagent_list_update', subagents: [{ ...info }] });
    }
    this.queue.push(ev);
    this.syncBackgroundSubagents();
  }

  private trackChildThread(childId: string, info: SubagentInfo, publish: boolean): void {
    if (!childId || this.childThreadInfos.has(childId)) return;
    this.childThreadInfos.set(childId, { ...info, source: 'codex' });
    const tracked = (): SubagentInfo => this.childThreadInfos.get(childId) ?? info;
    this.host.observability.log('debug', 'chat', 'codex child subagent thread tracked', {
      nodeId: this.id,
      parentThreadId: this.threadId,
      childThreadId: childId,
      agentName: info.agentName,
    });
    const pushChild = (ev: NormalizedEvent) => this.pushChild(childId, ev);
    if (publish) pushChild({ kind: 'subagent_list_update', subagents: [{ ...tracked() }] });

    // Earlier agent messages are narration; the last one is the result.
    let answer = '';
    let narrationSeq = 0;
    let childError: string | undefined;
    const flushNarration = () => {
      const text = answer.replace(/\s+/g, ' ').trim();
      answer = '';
      if (!text) return;
      narrationSeq += 1;
      pushChild(codexChildNarration(childId, narrationSeq, text));
    };
    const childTranslator = createCodexTranslator((ev) => {
      if (ev.kind === 'tool_call' || ev.kind === 'tool_call_update') {
        pushChild(codexChildToolActivity(childId, ev));
      } else if (ev.kind === 'chunk') {
        if (answer.length < SUBAGENT_LIMITS.result) answer += ev.text;
      } else if (ev.kind === 'runtime_error') {
        childError = ev.error;
      } else if (ev.kind === 'turn_end') {
        const patch = codexChildTurnEndPatch(childId, ev.stopReason, answer, childError);
        this.childThreadInfos.set(childId, mergeSubagentEntry(tracked(), patch));
        pushChild({ kind: 'subagent_list_update', subagents: [patch] });
        answer = '';
        childError = undefined;
      }
    });
    childTranslator.startTurn();

    const unsub = this.client.onNotification(childId, (childMethod, childParams) => {
      this.lastChildActivityAt = Date.now();
      if (childMethod === 'item/started') {
        const item = (childParams['item'] ?? childParams) as Record<string, unknown>;
        if (item['type'] === 'agentMessage') flushNarration();
      }
      childTranslator.feed(childMethod, childParams);
    });
    this.childNotificationUnsubs.set(childId, unsub);
  }

  private handleChildThreadLifecycle(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : '';
    const info = this.childThreadInfos.get(threadId);
    if (!info) return;

    if (isCodexChildThreadClosed(method, params) && info.status !== 'terminated') {
      this.childThreadInfos.set(threadId, { ...info, status: 'terminated' });
      this.host.observability.log('debug', 'chat', 'codex child subagent thread terminated', {
        nodeId: this.id,
        childThreadId: threadId,
      });
      this.pushChild(threadId, { kind: 'subagent_list_update', subagents: [{ sessionId: threadId, status: 'terminated' }] });
    }
  }

  // ---- Dispose --------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.turnAbort?.abort();
    this.transportAbort.abort(new Error('Codex session disposed'));
    if (this.cancelTimer) clearTimeout(this.cancelTimer);

    this.clearInteractions();

    // Unsubscribe notification handler
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = null;

    // Unsubscribe global + child thread notification handlers
    const ends = this.backgroundSubagentEnds();
    this.unsubGlobalNotification?.();
    this.unsubGlobalNotification = null;
    for (const [, unsub] of this.childNotificationUnsubs) unsub();
    this.childNotificationUnsubs.clear();
    this.childThreadInfos.clear();
    this.childPublishedTurn.clear();
    this.idleChildCompletions.clear();
    this.idleChildEnded.clear();
    // Michi stops listening to the children: their outcome will not arrive.
    this.endBackgroundSubagents(ends);

    // Best-effort thread/unsubscribe (skip if crashed)
    try {
      await this.client.request('thread/unsubscribe', { threadId: this.threadId }, 2_000);
    } catch {
      // Ignore — daemon may be gone
    }

    this.queue.dispose();
    this.markTranslatorTurnStart = null;

    await this.disposeMcpSlot();
  }

  private async disposeMcpSlot(): Promise<void> {
    if (!this.slotId) return;
    const slotId = this.slotId;
    this.slotId = null;
    await this.mcpRegistry.dispose(slotId).catch(() => {});
  }

  // ---- Turn mutex -----------------------------------------------------------

  private async acquireTurnLock(): Promise<void> {
    if (this.turnLock) {
      throw Object.assign(new Error('Session is busy with an in-flight turn'), {
        code: 'ESESSION_BUSY',
      });
    }
    this.touch();
    let release!: () => void;
    this.turnLock = new Promise<void>((r) => {
      release = r;
    });
    this.turnLockRelease = release;
  }

  private releaseTurnLock(): void {
    if (this.turnLockRelease) {
      const r = this.turnLockRelease;
      this.turnLock = null;
      this.turnLockRelease = null;
      r();
    }
  }
}
