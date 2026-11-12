// First: the background service reads ~/.michi/.env before any module reads its settings.
import './bootEnv';
import { startMetaAgentMetrics, stopMetaAgentMetrics } from './services/metaAgentMetrics';
import { nextPerformanceContext, startEventLoopDiagnostics, withPerformanceContext } from './services/performanceDiagnostics';
import { jsonConfigErrorResponse } from "./routes/jsonConfigErrorResponse";
import { persistSessionState } from './services/sessionStatePersistence';
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { createSpawnChild } from './services/spawnChild';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { setupSpaFallback } from './routes/spaFallback';
import { setupMobileAccessRoutes } from './routes/mobileAccess';
import { setupTerminalRoutes } from './routes/terminals';
import { loadNodePty, TerminalHost } from './services/terminalHost';
import { setupSelfUpdateRoutes } from './routes/selfUpdate';
import { SelfUpdater } from './services/selfUpdate';
import { readMobileAccessChoice, readPhoneTerminalChoice, saveMobileAccessChoice, savePhoneTerminalChoice } from './services/mobileAccess';
import { createMobileAccess, defaultMobileAccessProvider } from './services/mobileAccessManager';
import { setupAssistantRoutes } from './routes/assistant';
import { isAssistantWorkspace } from './assistant/identity';
import { currentAssistantNodeId, migrateAssistantV2 } from './assistant/store';
import { createCompanionRouter } from './routes/companion';
import { bootCompanion, type RunningCompanion } from './services/companion/boot';
import { setCompanionCardDeps } from './services/companion/cards';
import { startChatNotices, type RunningChatNotices } from './services/companion/chatNotices';
import { companionEvents } from './services/companion/delivery';
import { CompanionPresence } from './services/companion/presence';
import { createNoopCompanionService, startCompanionDelegation } from './services/companion/service';
import { getCompanionSettings } from './services/companion/settings';
import type { CompanionService } from './services/companion/types';
import { setupMetaAgentRoutes } from './routes/metaAgent';
import { setupMetaAgentOverviewRoutes } from './routes/metaAgentOverview';
import { setupMetaAgentRunNowRoutes } from './routes/metaAgentRunNow';
import { log } from './services/logger';
import { observeAccess } from './services/accessLog';
import { setupMichiRoutes } from './routes/michi';
import { setupDigestRoutes } from './routes/digests';
import { setupPersistenceRoutes } from './routes/persistence';
import { setupPaneInspectionRoutes } from './routes/paneInspection';
import { setupConversationUpdatesRoutes } from './routes/conversationUpdates';
import { setupPagesRoutes } from './routes/pages';
import { setupSpacesHomeRoutes } from './routes/spacesHome';
import { chatHubLiveWait, configureHomeLiveWait } from './services/pages/homeSections';
import { setupHomeCardsRoutes } from './routes/homeCards';
import { setupSpacesHomeRunRoutes } from './routes/spacesHomeRuns';
import { configureHomeCardsSink } from './services/metaAgent/homeCardsGenerator';
import { repositoryHomeCardsSink } from './services/metaAgent/homeCardsSink';
import { chatHubLiveTurn, configureProgressCardLiveTurns } from './services/pages/progressCards';
import { configurePagePreview, createPagePreviewMiddleware } from './services/pages/pagePreview';
import { setupPageHelperRoutes } from './routes/pageHelpers';
import { setupPageComponentRoutes } from './routes/pageComponents';
import { setupPageMaintenanceRoutes } from './routes/pageMaintenance';
import { configurePaneInspectionEventBus } from './services/paneInspectionSubscribe';
import { setupBackupRoutes } from './routes/backup';
import { setupSearchRoutes } from './routes/search';
import { setupVersionRoutes } from './routes/version';
import { setupAdminRoutes } from './routes/admin';
import { setupAgentRoutes } from './routes/agent';
import { setupCustomAgentRoutes } from './routes/customAgents';
import { setupAgentRunRoutes } from './routes/agentRuns';
import { setupWorkflowRunRoutes } from './routes/workflowRuns';
import { setupMultiModelRunRoutes } from './routes/multiModelRuns';
import { configureMultiModelTools } from './agents/multiModelTool';
import { answerChatPermission } from './services/chatPermissionAnswers';
import { createChildThread } from './services/multiModel/childThreads';
import { MultiModelOrchestrator } from './services/multiModel/orchestrator';
import { ReadyModelsService } from './services/multiModel/readyModels';
import { isMultiModelStepTurn, SqliteMultiModelStore } from './services/multiModel/store';
import { threadTurnReceipt } from './services/threadMessageWakeStore';
import { workflowRunHub } from './services/workflowRunHub';
import { backgroundSubagentRegistry } from './services/backgroundSubagentRegistry';
import { endNodeBackgroundSubagents, endOrphanedBackgroundSubagents } from './services/backgroundSubagentEndsRepository';
import { authModeOrigins, createAuthCors, installLocalAccessGuards } from './services/localOrigins';
import { setupUploadsRoutes } from './routes/uploads';
import { setupFilesRoutes } from './routes/files';
import { setupArtifactRoutes } from './routes/artifacts';
import { closeAllArtifactWatchers } from './services/artifactWatcher';
import { setupDiffRoutes } from './routes/diff';
import { setupBackendConnectionRoutes } from './routes/backendConnections';
import { setupHostDirectoryRoutes } from './routes/hostDirectories';
import { publicBuildInfo, runningBuild } from './services/buildInfo';
import { ChatManager } from './services/chatManager';
import { getAuthForHost, runAuthMigrations } from './services/auth';
import { resolveAccessPolicy } from './services/accessPolicy';
import { createSessionAccessMiddleware } from './routes/middleware/sessionAccess';
import { McpSlotRegistry, mountMcp } from './services/mcpServer';
import { JSON_BODY_LIMIT_BYTES } from './services/requestBodyLimit';
import { initDb, getDb, getDbPath, closeDb, closeAuditDb, openExistingAuditDb } from './services/db';
import { initDbWorker, shutdownDbWorker } from './services/dbWorkerClient';
import { auditLogHealth, recordAudit } from './services/audit';
import { installStartupSignalHandlers } from './services/startupSignals';
import { scanGraphIntegrity } from './services/graphIntegrity';
import { getAgentConfig, loadAgentConfig, updateAgentConfig, reconcileRuntimeWithRegistered, resolveModel, resolveReasoning } from './services/agentConfig';
import { setProviderEnvBindings, getProviderApiKey } from './services/secrets';
import { getWarmStatus, markReady, markFailed } from './services/readyState';
import { getRuntime, listRuntimes, registerRuntime } from './agents/registry';
import { findRemoteRuntimeDefault } from './services/remoteRuntimeDefault';
import { getEnabledFactories } from './agents/runtimeFactories';
import { createMichiRuntimeHost } from './agents/michiRuntimeHost';
import { agentRunToolsBindingFor } from './agents/agentRunInvocation';
import { createAgentToolBridge } from './agents/toolBridge';
import type { MichiBackendHealth } from 'michi-shared';
import type { ProviderEnvBinding } from './agents/types';
import * as sessionRegistry from './agents/sessionRegistry';
import type { AgentRuntime } from './agents/types';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { printEnvInfo } from './envDetect';
import { startupMark } from './services/startupTrace';
import { configureRuntimeDeps } from './agents/runtimeDeps';
import { resolveChatPermissionMode, resolveChatApproveForMe, hasChatToolGrant, grantChatTool, chatPermissionResetToken } from './services/chatPermissions';
import { getNode, getNodeSessionBinding, listMessages, getWorkspace, getWorkspaceInstructions, recoverInterruptedTurns, upsertAgentContextMetadata } from './services/dbRepository';
import { sessionPlanSnapshot } from './services/planSnapshot';
import { getMichiDataDir } from './services/dataDir';
import {
  createRemoteAccessMiddleware,
  remoteAccessEnabled,
  remoteAccessToken,
  remoteServerId,
  resolveListenHost,
  selfLoopbackBase,
  validateRemoteAccessConfiguration,
} from './services/remoteAccess';
import { sshTunnelManager } from './services/sshTunnelManager';
import { listThreads, searchMessages, readNode, readNodeOverview } from './services/globalContext';
import { FileRuntimeCatalogCache } from './agents/runtimeModelCache';
import { refreshRuntimeModelsInBackground } from './agents/runtimeModelRefresh';
import { createAgentRunAssembly, type AgentRunAssembly } from './agents/agentRunAssembly';
import { chatHub } from './agents/chatHub';
import { configureThreadMessaging, recoverThreadMessageWakes } from './agents/threadMessageTool';
import { isRegisteredLiveSession } from './agents/requestedTurnStart';
import { chatHubAwaitingUser } from './services/chatAwaitingUser';
import { settleStoppedThreadWakes } from './agents/threadMessageWakes';
import { acquireSessionRestoreLock } from './services/nativeResume';
import { AgentRunAdministrativeLifecycle } from './services/agentRunAdministrativeLifecycle';
import { createStreamTransport } from './services/streamTransport';
import { setupScheduledJobRoutes } from './routes/scheduledJobs';
import { setupMemoryRoutes } from './routes/memories';
import { setupSkillRoutes } from './routes/skills';
import { setupMemoryExtractionRoutes } from './routes/memoryExtraction';
import {
  attachMemoryExtractionScheduler, installMemoryExtractionHooks, migrateRetiredExplicitMode, wakeMemoryExtraction,
} from './services/memory/extractionService';
import { watchConversationSwitches } from './services/memory/typedText';
import { activateLegacyPendingMemories } from './services/memory/activateLegacyPending';
import { indexTurn, startRecallBackfill } from './services/memory/recallIndex';
import { attributeTurn } from './services/memory/replySources';
import { startNativeMemoryImport } from './services/memory/nativeMemoryImport';
import { createMemoryDirectAnswerer } from './services/memory/extractionDirect';
import { markExtractionBoot, watchConversationPresence } from './services/memory/extractionRun';
import { createLocalOriginGuard, isLoopbackListenHost } from './routes/middleware/localControl';
import { ScheduledJobsRepository } from './services/scheduledJobs/repository';
import { ScheduledJobScheduler } from './services/scheduledJobs/scheduler';
import { ChatScheduledJobExecutor, isSchedulableWorkspace } from './services/scheduledJobs/chatExecutor';
import { scheduledJobEvents } from './services/scheduledJobs/events';
import { structureEvents } from './services/structureEvents';
import { createDesktopAppLauncher } from './services/scheduledJobs/appLauncher';
import { scheduledJobsFeatureEnabled } from './services/scheduledJobs/feature';
import { configureScheduledJobTools } from './agents/scheduledJobTools';
import { scheduledJobCreateNeedsApproval } from './services/scheduledJobs/settings';
import { CustomAgentsFeatureGate } from './services/customAgentsFeatureGate';
import { AttentionService } from './services/attention/attentionService';
import { setupAttentionRoutes } from './routes/attention';
import { setupInterruptedTurnRoutes } from './routes/interruptedTurns';
import { subscribeNodeCompletionSeen, subscribePermissionAnswered } from './services/attentionSignals';
import { panePresenceRegistry } from './services/panePresence';
import { AgentRunsRepository } from './services/agentRunsRepository';

// Load backend/.env explicitly. The default `dotenv.config()` looks in
// process.cwd(), but in the electron + monorepo dev loop the cwd is the
// repo root, so `backend/.env` would silently be missed. Resolving from
// __dirname makes us cwd-independent.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
// The background service has read ~/.michi/.env already (./bootEnv).
const SERVICE_MODE = process.env.MICHI_SERVICE_MODE === '1';
// Reject unsupported combinations before opening databases or starting runtimes.
const accessPolicy = resolveAccessPolicy();
const REQUIRE_AUTH = accessPolicy.requireAuth;
startupMark('backend_process_start', { node: process.version, serviceMode: SERVICE_MODE });

function isDirectory(absPath: string | undefined): absPath is string {
  if (!absPath || !path.isAbsolute(absPath)) return false;
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveDefaultCwd(): string {
  const explicit = process.env.MICHI_DEFAULT_CWD;
  if (isDirectory(explicit)) return explicit;

  const launchCwd = process.env.MICHI_LAUNCH_CWD;
  if (isDirectory(launchCwd)) return launchCwd;

  const cwd = process.cwd();
  const parent = path.dirname(cwd);
  if (
    path.basename(cwd) === 'backend' &&
    fs.existsSync(path.join(parent, 'package.json')) &&
    fs.existsSync(path.join(parent, 'backend', 'package.json'))
  ) {
    return parent;
  }

  return cwd;
}

const defaultCwd = resolveDefaultCwd();
validateRemoteAccessConfiguration();

function shouldBootWarm(cwd: string): boolean {
  // Finder-launched packaged apps often inherit "/" as cwd. Warming the
  // filesystem root is wasted work; the renderer will warm the real workspace
  // once hydration discovers it.
  return path.parse(cwd).root !== cwd;
}

log.info('boot', 'backend starting', {
  pid: process.pid,
  node: process.version,
  logDir: log.logDir(),
  defaultCwd,
  processCwd: process.cwd(),
});
const app = express();
const stopEventLoopDiagnostics = startEventLoopDiagnostics();
const port = process.env.PORT || 3000;

// Until the graceful shutdown below is installed, SIGINT/SIGTERM wait instead
// of killing startup mid-snapshot (services/startupSignals.ts).
const releaseStartupSignals = installStartupSignalHandlers();
// Initialize SQLite before anything that might need it
initDb();
openExistingAuditDb();
if (process.env.MICHI_CLOUD !== '1') startMetaAgentMetrics();
// Spin up the async database worker thread. It opens its own WAL connection
// to the same data.db file so writes execute off the main thread. Hot-path
// routes (ensure-session) call dbWorker.* instead of synchronous dbRepository.
void initDbWorker(getDbPath()).catch((err) => {
  log.warn('boot', 'dbWorker failed to initialize; falling back to sync writes', { error: (err as Error).message });
});
// Custom Agents / Agent Runs: on only when MICHI_CUSTOM_AGENTS=1 is in the
// environment at startup. Nothing in the app can change it afterwards.
const customAgentsFeature = new CustomAgentsFeatureGate();
const pendingAgentDeliveryTurnIds = new Set((getDb().prepare(`SELECT requested_turn_id FROM agent_run_watches
    WHERE delivery_status = 'pending' AND requested_turn_id IS NOT NULL`).all() as Array<{ requested_turn_id: string }>)
  .map((row) => row.requested_turn_id));
const interruptedTurns = recoverInterruptedTurns(Date.now(), pendingAgentDeliveryTurnIds);
if (interruptedTurns > 0) {
  log.warn('boot', 'recovered interrupted turns', { count: interruptedTurns });
}
// Server attention (services/attention/): decides notifications once, from
// every turn the hub runs, presence (window focus and visible panes) and the
// view marks that record a completion as seen; every window of the owner
// receives them on the background feed. Subscribed before any turn starts.
const attentionRuns = new AgentRunsRepository();
const attentionService = new AttentionService({
  presence: panePresenceRegistry,
  getRun: (ownerUserId, runId) => attentionRuns.getRun(ownerUserId, runId),
  // A multi-model branch's answer or review notifies nobody; the synthesis does.
  isHandOffTurn: isMultiModelStepTurn,
  // The agent's own conversation speaks under the name the user gave it.
  assistantName: () => getCompanionSettings().displayName,
});
chatHub.subscribeBackground({
  includeForeground: true,
  send: (_chatId, event) => attentionService.observeChatEvent(event),
  close: () => {},
});
panePresenceRegistry.subscribeAttentionSignals((ownerUserId, shown) => attentionService.presenceChanged(ownerUserId, shown));
subscribeNodeCompletionSeen((event) => attentionService.nodeCompletionSeen(event));
subscribePermissionAnswered((event) => attentionService.permissionAnswered(event));
// Approvals that wait only on a workflow run: a Claude workflow agent asking between turns, a Kiro step.
workflowRunHub.subscribe((_ownerUserId, run) => attentionService.observeWorkflowRun(run));
// Trash, archive, moves and purges reach the records of their targets.
structureEvents.subscribe({ send: (frame) => attentionService.structureChanged(frame) });
attentionService.start();
// Before any agent session starts: the background subagents stored as still
// waiting for an outcome ran in processes the previous backend owned, which
// are gone, so their outcome never comes. A failed sweep leaves them as they
// were (the renderer still reads them as interrupted once the live feed says
// no process tracks them).
try {
  const ended = endOrphanedBackgroundSubagents();
  if (ended.subagents > 0) log.info('boot', 'recorded background subagents ended by the restart', { ...ended });
} catch (error) {
  log.warn('boot', 'background subagent sweep failed', { error: (error as Error).message });
}
// Reported, never repaired here: a fix has to know what each window meant.
try {
  const integrity = scanGraphIntegrity();
  if (Object.values(integrity).some((count) => count > 0)) log.warn('boot', 'graph rows break placement invariants', integrity);
} catch (error) {
  log.warn('boot', 'graph integrity scan failed', { error: (error as Error).message });
}
// A session whose process ends with background subagents still running
// records how they ended on the node's stored rosters.
backgroundSubagentRegistry.setEndRecorder((ownerUserId, nodeId, ends) => {
  const recorded = endNodeBackgroundSubagents(ownerUserId, nodeId, ends);
  return recorded ? { workspaceId: recorded.workspaceId } : null;
});
log.info('boot', 'db initialized');

// Load persisted agent runtime/provider/model config (with env overrides)
loadAgentConfig();
log.info('boot', 'agent config loaded');

// Wire Michi's SQLite / secrets / config into the runtime layer's injection
// seam. MUST run before any runtime is constructed or warmed, since the
// runtime modules read getRuntimeDeps() at call-time and throw if unconfigured.
configureRuntimeDeps({
  onSessionStateChanged: persistSessionState,
  chatPermissions: { getMode: resolveChatPermissionMode, getApproveForMe: resolveChatApproveForMe, hasGrant: hasChatToolGrant, grant: grantChatTool, resetToken: chatPermissionResetToken },
  historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions, getPlanSnapshot: sessionPlanSnapshot },
  dataDir: getMichiDataDir(),
  providerKeys: { getProviderApiKey },
  globalContext: { listThreads, searchMessages, readNode, readNodeOverview },
  agentConfig: { getAgentConfig, resolveModel, resolveReasoning },
});

// The listener's address once bound: a host name such as localhost binds one of its addresses.
let boundListenAddress: string | undefined;
const mcpRegistry = new McpSlotRegistry({ mcpPort: Number(port), mcpHost: () => boundListenAddress ?? resolveListenHost() });
const runtimeModelCache = new FileRuntimeCatalogCache(getMichiDataDir());
// One host for every runtime: the adapters read Michi through its ports.
const runtimeHost = createMichiRuntimeHost();
// Before the first runtime registers: the manager reads session ownership from this host.
sessionRegistry.configureRuntimeManager(runtimeHost);

// Register the enabled runtimes (filtered by MICHI_ENABLED_RUNTIMES, or
// all of them locally) through a single factory loop. Each factory
// creates its runtime with a bridge whose createChild opens a
// spawn_branches child (services/spawnChild.ts) in that runtime. Provider
// env bindings are collected here and pushed into secrets.ts after
// registration.
const allEnvBindings: ProviderEnvBinding[] = [];
let kiroRuntime: AcpAgentRuntime | undefined;
let agentRunAssembly: AgentRunAssembly | null = null;
for (const factory of getEnabledFactories()) {
    let runtime!: AgentRuntime;
    const bridge = createAgentToolBridge({
        createChild: (args) => createSpawnChild(runtime, args),
        persistContext: ({ chatId, ownerUserId, name, filePath, size }) => {
            const userId = ownerUserId ?? undefined;
            const binding = getNodeSessionBinding(chatId, userId);
            if (!binding) {
                log.warn('bridge', 'context metadata skipped (chat has no durable binding)', { chatId, name });
                return false;
            }
            return upsertAgentContextMetadata({
                workspaceId: binding.workspaceId,
                nodeId: binding.nodeId,
                name,
                filePath,
                size,
                userId,
            });
        },
        agentRunToolsForSession: (binding) => {
            // Null while Custom Agents is off, so ordinary chats are not handed
            // spawn_agent & co. at all.
            if (!agentRunAssembly) return null;
            const caller = agentRunToolsBindingFor(binding);
            return caller ? agentRunAssembly.toolInvokerForSession(caller) : null;
        },
    });
    runtime = factory.create({
      bridge,
      mcpRegistry,
      mcpPort: Number(port),
      defaultCwd,
      modelCache: runtimeModelCache,
      host: runtimeHost,
    });
    registerRuntime(runtime);
    if (factory.id === 'kiro') kiroRuntime = runtime as AcpAgentRuntime;
    if (factory.envBindings) allEnvBindings.push(...factory.envBindings);
    log.info('boot', 'runtime registered', { id: runtime.id });
}
setProviderEnvBindings(allEnvBindings);
reconcileRuntimeWithRegistered(listRuntimes().map((r) => r.id));

// The Companion v2 merge (DESIGN-v2 §7): the assistant's conversations become
// the one conversation V, once, synchronously, before any route opens or any
// agent session starts. It reads the registered runtimes and the agent config,
// so it runs after both; reading the registry earlier would claim the runtime
// manager before configureRuntimeManager. The assistant exists only in the
// desktop app.
if (process.env.MICHI_CLOUD !== '1') {
  try {
    const merged = migrateAssistantV2();
    log.info('boot', 'assistant v2 merge', { mergedAt: merged.mergedAt });
  } catch (error) {
    log.error('boot', 'assistant v2 merge failed', { error: (error as Error).message });
  }
}

// kiroRuntime may be undefined in Pi-only / Claude-only deployments;
// ChatManager guards its Kiro-specific methods accordingly.
const chatManager = new ChatManager(kiroRuntime, defaultCwd);
configureThreadMessaging({
  ensureSession: (input) => chatManager.ensureParentSession(input),
  startTurn: (args) => chatHub.startRequestedSelfTurn(args),
  acquireRestoreLock: acquireSessionRestoreLock,
  isLiveSession: isRegisteredLiveSession,
  newTurnId: () => randomUUID(),
  startWaitMs: 3_000,
  awaitingUser: (chatId) => chatHubAwaitingUser(chatHub, chatId),
  isShuttingDown: () => chatHub.isShuttingDown(),
});
// A Stop ends the send_to_thread wake chain the stopped turn is part of.
chatHub.onCancel(({ turnId }) => settleStoppedThreadWakes(turnId));
// Multi-model plans (services/multiModel/): proposed by a chat agent, run by
// the backend once the user presses Start.
const multiModelStore = new SqliteMultiModelStore();
const multiModel = new MultiModelOrchestrator({
  hub: workflowRunHub,
  store: multiModelStore,
  chat: chatHub,
  ensureSession: (input) => chatManager.ensureParentSession(input),
  acquireRestoreLock: acquireSessionRestoreLock,
  isLiveSession: isRegisteredLiveSession,
  hasLiveSession: (nodeId) => !!sessionRegistry.peekLiveSession(nodeId),
  createChild: (input) => createChildThread(input, { defaultCwd, store: multiModelStore }),
  answerPermission: answerChatPermission,
  subscribePermissionAnswered,
  turnError: (turnId) => threadTurnReceipt(turnId)?.error ?? null,
  readyModels: new ReadyModelsService({ catalogCache: runtimeModelCache }),
});
configureMultiModelTools(multiModel);
// A branch deleted, restored or archived after its run ended updates the run's rows (branchGone).
structureEvents.subscribe({ send: (frame) => multiModel.structureChanged(frame) });
agentRunAssembly = createAgentRunAssembly({
  isEnabled: () => customAgentsFeature.isEnabled(),
  chatManager,
  defaultCwd,
  dataDir: getMichiDataDir(),
  // Watches in notify mode become attention records (finished/failed per Run).
  notifier: attentionService.agentRunNotifier,
});

const agentRunLifecycle = new AgentRunAdministrativeLifecycle({
  quiesceRun: async (ownerUserId, runId) => {
    await agentRunAssembly!.coordinator.quiesceForAdministrativeDeletion(ownerUserId, runId);
  },
  cleanupRun: async (runId, resources) => {
    const cleaner = agentRunAssembly!.resourceCleaner;
    if (!cleaner.cleanupResources) {
      throw new Error('Agent Run resource cleaner cannot clean captured resources');
    }
    await cleaner.cleanupResources(runId, resources);
  },
  auditCleanupFailure: ({ ownerUserId, runId, message }) => {
    log.warn('boot', 'Agent Run administrative cleanup will retry', { ownerUserId, runId, message });
  },
});

let agentRunCleanupPass: Promise<void> | null = null;
const retryAgentRunCleanup = (): void => {
  if (agentRunCleanupPass) return;
  agentRunCleanupPass = agentRunLifecycle.retryPendingCleanup().then((result) => {
    if (result.cleanedRunIds.length || result.failed.length) {
      log.info('boot', 'Agent Run administrative cleanup pass complete', {
        cleaned: result.cleanedRunIds.length,
        failed: result.failed.length,
      });
    }
  }).catch((error) => {
    log.warn('boot', 'Agent Run administrative cleanup pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    agentRunCleanupPass = null;
  });
};
retryAgentRunCleanup();
const agentRunCleanupTimer = setInterval(retryAgentRunCleanup, 60_000);
agentRunCleanupTimer.unref();

// Idle Kiro chats give their live session back (ChatManager.releaseIdleSessions);
// the next message resumes it. One pass at a time.
let idleSessionPass: Promise<unknown> | null = null;
const idleSessionTimer = setInterval(() => {
  if (idleSessionPass) return;
  idleSessionPass = chatManager.releaseIdleSessions()
    .catch((error) => log.warn('chat', 'idle session sweep failed', { error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { idleSessionPass = null; });
}, 60_000);
idleSessionTimer.unref();

const agentRunRecoveryPromise = agentRunAssembly.start()
  .then((summary) => {
    if (customAgentsFeature.isEnabled()) {
      agentRunAssembly!.completeFeatureEnable();
      log.info('boot', 'Agent Run recovery audit complete', { ...summary });
    }
    const remaining = recoverInterruptedTurns(Date.now(), new Set([
      ...chatHub.activeDurableTurnIds(),
      ...pendingAgentDeliveryTurnIds,
    ]));
    if (remaining > 0) log.warn('boot', 'recovered deferred interrupted turns', { count: remaining });
    return summary;
  });

// The Meta agent chat window checks its tools inside each turn on some runtimes.

// Scheduled Jobs run prompts headlessly as ordinary durable chat turns. They
// are a desktop feature: cloud deployments have per-user owners and no local
// notification path, so the scheduler stays off there.
const SCHEDULED_JOBS_ENABLED = scheduledJobsFeatureEnabled();
// The one launcher that wakes a quit app to show what it missed (only the
// macOS background service may: createDesktopAppLauncher). The scheduler and
// the Companion's notices share it, so one wake a minute between them
// (DESIGN-v2 §5.1).
const appLauncher = createDesktopAppLauncher();
const scheduledJobExecutor = SCHEDULED_JOBS_ENABLED
  ? new ChatScheduledJobExecutor({
      chatHub,
      ensureSession: (input) => chatManager.ensureParentSession(input),
      releaseMaintenanceSession: (input) => chatManager.releaseMaintenanceSession(input),
      isLiveSession: isRegisteredLiveSession,
    })
  : null;
const scheduledJobScheduler = scheduledJobExecutor
  ? new ScheduledJobScheduler({
      repository: new ScheduledJobsRepository(),
      executor: scheduledJobExecutor,
      events: scheduledJobEvents,
      // A hidden system workspace (the Michi assistant's) is not a place a
      // job may run in: to the scheduler it does not exist. Automatic memory
      // still reads V there, with direct calls only (extractionRun's hold).
      workspaceExists: (id) => isSchedulableWorkspace(getWorkspace(id)),
      maintenanceWorkspaceExists: (id) => isAssistantWorkspace(id),
      workspaceArchived: (id) => getWorkspace(id)?.archived_at != null,
      runtimeExists: (id) => !!getRuntime(id),
      launcher: appLauncher,
      serviceMode: SERVICE_MODE,
      // Automatic memory answers with one direct structured call where the Meta agent's runtime has one.
      memoryDirect: createMemoryDirectAnswerer({ runtime: (id) => getRuntime(id) }),
    })
  : null;
// Tombstones for deleted/rejected memories are written on every backend; extraction runs only with the scheduler.
installMemoryExtractionHooks();
// Memory is on for everyone and nothing waits for approval: once per database, the retired explicit-only mode
// becomes auto and the pending memories older versions left become active. After the tombstone hook above,
// before the scheduler and the HTTP listener start; a failure is retried at the next start.
try {
  const moved = migrateRetiredExplicitMode();
  if (moved?.length) log.info('boot', 'memory: explicit-only mode moved to auto', { owners: moved.length });
} catch (error) {
  log.warn('boot', 'memory: explicit-only mode migration failed', { error: (error as Error).message });
}
try {
  const activated = activateLegacyPendingMemories();
  if (activated && (activated.activated || activated.merged)) log.info('boot', 'memory: activated legacy pending memories', { ...activated });
} catch (error) {
  log.warn('boot', 'memory: legacy pending activation failed', { error: (error as Error).message });
}
// Each completed human turn becomes searchable for recall in other conversations.
chatHub.onTurnFinalized(indexTurn);
// Then what its reply repeated of the memories and past chats it was given is stored for the line under it.
chatHub.onTurnFinalized((turn) => { attributeTurn(turn); });
// Automatic extraction reads a conversation once it is quiet, or once the user left it (no window shows it, or
// they typed in another one); what waited when the last process stopped is read now.
markExtractionBoot(Date.now());
// V shows in the Companion panel, which reports no pane presence: the panel's own beacons (fed below, at the Companion
// routes) say when it has focus, and V counts as shown while it does, as a visible pane for any other conversation.
const companionPanel = new CompanionPresence(Date.now());
watchConversationPresence((nodeId) => panePresenceRegistry.getPresence({ kind: 'node', nodeId }).views.some((view) => view.visible)
  || (companionPanel.isPanelFocused(Date.now()) && nodeId === currentAssistantNodeId()));
// Leaving a conversation wakes extraction at once rather than at its next check: no window shows it any more, or the
// user typed in another one.
panePresenceRegistry.subscribeConversationsLeft(() => wakeMemoryExtraction());
watchConversationSwitches(() => wakeMemoryExtraction());
if (scheduledJobScheduler) attachMemoryExtractionScheduler(scheduledJobScheduler);
configureScheduledJobTools(scheduledJobScheduler && scheduledJobExecutor
  ? {
      scheduler: scheduledJobScheduler,
      isScheduledRunNode: (nodeId) => scheduledJobExecutor.isRunningOn(nodeId),
      workspaceName: (id) => getWorkspace(id)?.name ?? null,
      createNeedsApproval: scheduledJobCreateNeedsApproval,
    }
  : null);
// Resolved once the HTTP listener is bound (see app.listen below).
let markListening!: () => void;
const listeningPromise = new Promise<void>((resolve) => { markListening = resolve; });

// The Companion's engine (services/companion/boot.ts): the desktop app only,
// never with MICHI_DISABLE_COMPANION=1. It starts with the scheduler below and
// ticks only while this process holds the scheduler lease (DESIGN R2.14), so
// without a scheduler (MICHI_SCHEDULED_JOBS=0) it does not start at all. Until
// it runs, the Companion's routes answer from storage (createNoopCompanionService).
let companion: RunningCompanion | null = null;
// The conversations' notices while no window is open (services/companion/chatNotices.ts); the desktop app only.
let chatNotices: RunningChatNotices | null = null;
function startCompanionEngine(): void {
  const scheduler = scheduledJobScheduler;
  if (process.env.MICHI_CLOUD === '1' || process.env.MICHI_DISABLE_COMPANION === '1' || !scheduler || shuttingDown || companion) return;
  try {
    companion = bootCompanion({ chatHub, chatManager, isLeaseHolder: () => scheduler.status().active });
    log.info('boot', 'companion started');
  } catch (error) {
    log.warn('boot', 'companion did not start', { err: error instanceof Error ? error.message : String(error) });
  }
}

// Start after interrupted-turn recovery so a run never races boot repair, and
// only once this process is reachable: a backend that failed to bind must not
// hold the scheduler lease and run jobs (or the Companion) no window can see.
void Promise.all([agentRunRecoveryPromise.catch(() => undefined), listeningPromise])
  .then(() => {
    scheduledJobScheduler?.start();
    if (scheduledJobScheduler) log.info('boot', 'scheduled jobs started', { serviceMode: SERVICE_MODE });
    startCompanionEngine();
  });
// Memories and conversations from before the recall index: indexed once per database, in the background.
void listeningPromise
  .then(() => startRecallBackfill())
  .catch((error) => {
    log.warn('boot', 'memory recall index backfill failed', { error: error instanceof Error ? error.message : String(error) });
  });
// What Claude Code, Codex and Kiro remember in their own files (read, never written) becomes Michi memories, and again as they change.
void listeningPromise.then(() => startNativeMemoryImport());
// Thread-message wakes the previous process left open (send_to_thread wake)
// start their reply turns in the scheduler's order: after interrupted-turn
// recovery, and once this process is reachable.
void Promise.all([agentRunRecoveryPromise.catch(() => undefined), listeningPromise])
  .then(() => recoverThreadMessageWakes())
  .then((summary) => {
    if (summary.delivered || summary.undeliverable || summary.open || summary.failed) {
      log.info('boot', 'thread message wakes recovered', { ...summary });
    }
  })
  .catch((error) => {
    log.warn('boot', 'thread message wake recovery failed', { error: error instanceof Error ? error.message : String(error) });
  });

async function warmConfiguredRuntime(): Promise<void> {
  if (remoteAccessEnabled()) {
    const selected = await findRemoteRuntimeDefault(listRuntimes(), getAgentConfig().runtime);
    if (!selected) {
      log.info('boot', 'remote machine ready; no configured runtime to warm');
      return;
    }
    if (selected.id !== getAgentConfig().runtime) updateAgentConfig({ runtime: selected.id });
  }
  if (!shouldBootWarm(defaultCwd)) {
    log.info('boot', 'warm skipped', { defaultCwd, reason: 'filesystem_root' });
    startupMark('chat_warm_skipped', { defaultCwd, reason: 'filesystem_root' });
    return;
  }
  const cfg = getAgentConfig();
  const runtime = getRuntime(cfg.runtime);
  if (!runtime?.capabilities.warmSessions) return;
  await runtime.warm(defaultCwd, { model: resolveModel(cfg.runtime) });
}

// Fire warm BEFORE app.listen so the active runtime spawn overlaps express
// setup, route mounting, and (in cloud mode) auth middleware
// initialization. Must remain after setProviderEnvBindings (above)
// because Pi/Claude warm hooks read provider env.
const tWarm = Date.now();
startupMark('chat_warm_start');
const warmPromise = Promise.all([warmConfiguredRuntime(), agentRunRecoveryPromise])
  .then(() => {
    log.info('boot', 'warm complete', { durMs: Date.now() - tWarm });
    startupMark('chat_warm_done', { durMs: Date.now() - tWarm });
    markReady();
  })
  .catch((err: Error) => {
    log.warn('boot', 'warm failed (will retry on first request)', { err: err.message });
    startupMark('chat_warm_failed', { durMs: Date.now() - tWarm, error: err.message });
    markFailed(err);
  });
// Suppress unhandled-rejection: state is captured via markFailed.
warmPromise.catch(() => {});

// Dynamic catalogs use stale-while-revalidate: runtime constructors load the
// previous disk snapshot synchronously, while this refresh asks each CLI for
// the current catalog without delaying Express readiness.
refreshRuntimeModelsInBackground(listRuntimes().filter(runtime => runtime.id === getAgentConfig().runtime), (runtimeId, err) => {
  log.warn('boot', 'runtime model refresh failed; using cached catalog', {
    runtimeId,
    err: err.message,
  });
});

// Session auth supports isolated cloud hosting and explicitly selected local
// single-account access. Desktop/dev keep their origin-protected local mode:
// no session middleware and no /api/auth/* handler; origin and host guards
// keep other web pages out (services/localOrigins.ts).

if (REQUIRE_AUTH) {
  app.use(createAuthCors(authModeOrigins()));

  // Better-Auth handler must be mounted BEFORE express.json() — its
  // internal node-handler reads the raw request stream itself, and a
  // pre-parsed body breaks the OAuth callback's form post.
  // Routes covered: /api/auth/sign-in/social, /sign-out, /get-session,
  // /callback/google, etc.
  //
  // Per-host dispatch: getAuthForHost(req.headers.host) returns the Auth
  // instance whose baseURL matches the incoming origin. This lets the
  // same service serve multiple domains (e.g. a custom domain plus the
  // Railway-default fallback) where OAuth callbacks must round-trip back
  // to the originating host. Each instance owns its own cookies, so
  // sessions don't leak across origins; users are still unified at the
  // DB layer.
  //
  // We rebuild the toNodeHandler wrapper per request rather than caching
  // it — toNodeHandler is cheap, and caching one per host doesn't save
  // anything because the Auth instance itself is already cached.
  //
  // Auth event recording: after the auth handler responds we inspect the
  // URL path + status to emit an audit record. We use res.on('finish')
  // to observe the final status code without interfering with the stream.
  app.all('/api/auth/*splat', (req, res) => {
    const inst = getAuthForHost(req.headers.host);
    const ip = ((req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()) ?? req.ip ?? null;
    const ua = (req.headers['user-agent'] as string | undefined) ?? null;
    res.on('finish', () => {
      const status = res.statusCode;
      const urlPath = req.path; // e.g. /api/auth/sign-in/social
      // Derive actor: better-auth attaches user after sign-in; may be null for failures
      const actor = req.user ? { id: req.user.id, email: req.user.email } : null;
      if (req.method === 'POST' && urlPath.includes('/sign-in/')) {
        if (status < 400) {
          recordAudit({ action: 'auth.sign_in.success', actor, ip, ua });
        } else {
          recordAudit({ action: 'auth.sign_in.failure', actor: null, ip, ua });
        }
      } else if (req.method === 'POST' && urlPath.includes('/sign-out') && status < 400) {
        recordAudit({ action: 'auth.sign_out', actor, ip, ua });
      } else if (urlPath.includes('/callback/') && status < 400) {
        // OAuth callback completes the sign-in; also record sign_up for new users.
        // We can't distinguish new vs returning here without a DB lookup — omit
        // duplicate sign_in.success (the /sign-in route already recorded it).
        // Record sign_up via a session check post-callback if user createdAt is recent.
        try {
          getAuthForHost(req.headers.host).api.getSession({ headers: fromNodeHeaders(req.headers) })
            .then((session: any) => {
              if (session?.user) {
                const createdTs = session.user.createdAt
                  ? new Date(session.user.createdAt).getTime()
                  : 0;
                if (Date.now() - createdTs < 30_000) {
                  // Created within the last 30 s — this is a sign_up
                  recordAudit({
                    action: 'auth.sign_up',
                    actor: { id: session.user.id, email: session.user.email },
                    ip,
                    ua,
                  });
                }
              }
            })
            .catch(() => { /* best-effort */ });
        } catch { /* best-effort */ }
      }
    });
    return toNodeHandler(inst)(req, res);
  });
} else {
  // Desktop/dev: the API has no user sessions, so the origin and host decide
  // which pages may use it. One rule (services/localOrigins.ts) serves CORS,
  // this guard stack and the /api guard below: Michi's own UI (same origin),
  // the dev renderers (MICHI_DEV_RENDERER, MICHI_RENDERER_URL) and configured
  // origins (MICHI_CORS_ORIGINS, MICHI_LOCAL_CONTROL_ORIGINS). Other sites get
  // no CORS headers, and any request they send is refused before a route runs
  // (CORS alone would still run a simple POST's handler). A wildcard here
  // would let any web page read this API while Michi is running — and with
  // the background service, Michi is always running. Without remote access's
  // token, a DNS name that is not loopback or listed is DNS rebinding.
  installLocalAccessGuards(app, { remoteAccess: remoteAccessEnabled() });
  log.info('auth', 'MICHI_REQUIRE_AUTH not set — auth middleware disabled');
}

app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

// A server explicitly launched for remote control is protected by a shared
// bearer token. Desktop/dev remain unchanged unless MICHI_REMOTE_ACCESS=1.
// Page preview links (loopback, one page, reads only) come first: they open
// with their own ticket and mark the reads the token check lets through.
if (!REQUIRE_AUTH) app.use('/api', createPagePreviewMiddleware());
app.use('/api', createRemoteAccessMiddleware());

if (!REQUIRE_AUTH) {
  // Behind installLocalAccessGuards and with the same origin and host rules,
  // also reject cross-site browser requests that carry no Origin before any
  // /api route runs. Token-authenticated remote requests are exempt.
  app.use('/api', createLocalOriginGuard({ loopbackListener: isLoopbackListenHost(resolveListenHost()) }));
}

if (REQUIRE_AUTH) {
  // Every protected /api/* path needs a valid session. The shared gate attaches
  // req.authUser and req.session; only cloud mode also sets req.user as the data
  // owner. Authenticated desktop requests retain the local data identity.
  //
  // IMPORTANT: when this middleware is mounted under app.use('/api', ...),
  // Express strips the '/api' prefix from req.path inside the handler,
  // so match against the post-strip path: '/health' and '/auth/...'.
  app.use('/api', createSessionAccessMiddleware(accessPolicy,
    req => getAuthForHost(req.headers.host).api.getSession({ headers: fromNodeHeaders(req.headers) }),
    err => log.warn('auth', 'getSession failed', { err: (err as Error).message }),
  ));
}

// Single-line access log per request — first signal that the frontend
// actually reached the backend, and useful when chasing 4xx/5xx in the
// field. SSE routes log just the request kickoff (status fires after
// `res.end()` regardless).
const ACCESS_LOG_SILENT_2XX = [
  /^(?:\/api)?\/health$/,                    // health checks
  /^(?:\/api)?\/ready$/,                     // cold-start readiness poll (250ms until warm)
  /^(?:\/api)?\/agent\/status$/,             // runtime capability probe
  /^(?:\/api)?\/agent\/models$/,             // model picker / sanitized-model probe
  /^(?:\/api)?\/mcp\/[^/]+$/,                // MCP slot calls (per-turn, very noisy)
  /^(?:\/api)?\/mcp-session\/[^/]+$/,        // MCP session-group calls (Kiro's shared catalog)
  /^(?:\/api)?\/nodes\/[^/]+\/ensure-session$/, // lazy session binding before send
  /^(?:\/api)?\/workspaces$/,                // lightweight workspace index load
  /^(?:\/api)?\/workspaces\/all$/,           // full workspace hydration
  /^(?:\/api)?\/workspaces\/[^/]+\/sync$/,   // bulk chat sync (frequent client poll)
  /^(?:\/api)?\/chats\/[^/]+\/heartbeat$/,   // compatibility heartbeat from older renderers
];
// MCP slot and group ids in a path are capabilities: log only their first 4 hex chars.
const redactCapabilityIds = (path: string) =>
  path.replace(/(?<=\/)[0-9a-f]{32}(?=\/|$)/g, (id) => `${id.slice(0, 4)}…`);
app.use((req, res, next) => {
  const requestId = nextPerformanceContext();
  observeAccess(req, res, requestId, (line) => log[line.level]('http', `${req.method} ${redactCapabilityIds(req.path)}`, line.meta));
  withPerformanceContext(requestId, next);
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'michi-backend',
    connectionProtocol: 1,
    build: publicBuildInfo(runningBuild),
    serverId: remoteServerId(),
    // Lets the desktop app tell its background service apart from a forked
    // child and restart the service after an app update.
    serviceMode: SERVICE_MODE,
    serviceBuild: SERVICE_MODE ? process.env.MICHI_SERVICE_BUILD ?? null : null,
    ...auditLogHealth(),
  } satisfies MichiBackendHealth);
});

// Auth-config probe — frontend hits this on boot to decide whether to
// gate the UI behind a sign-in flow. Public (no session required) so the
// landing page can render before the user has a cookie.
app.get('/api/auth-config', (_req, res) => {
  res.json({ requireAuth: REQUIRE_AUTH });
});

// Diagnostics — exposes log paths so the user can find logs without
// guessing. Frontend's settings/help can show these and a "Open log
// folder" button (Electron preload bridges shell.showItemInFolder).
app.get('/api/diagnostics', (_req, res) => {
  res.json({
    logDir: log.logDir(),
    backendLog: log.backendLogPath(),
    kiroCliLog: log.kiroCliLogPath(),
    pid: process.pid,
    nodeVersion: process.version,
  });
});

// Boot readiness probe — frontend polls this on cold-start instead of
// paying the exponential backoff on /agent/status. Public (no session
// required) so the landing page can render before sign-in. The handler
// MUST NOT call into AgentRuntime methods — it reads only the
// readyState module variable so it stays sub-millisecond regardless
// of how slow warm() is taking.
app.get('/api/ready', (_req, res) => {
  res.json(getWarmStatus());
});

const mcpRouter = express.Router();
const streamTransport = createStreamTransport();
app.use('/api', streamTransport.router);
mountMcp(mcpRouter, mcpRegistry);
app.use('/api', mcpRouter);

const customAgentsControl = {
  isEnabled: () => customAgentsFeature.isEnabled(),
};
app.use('/api', setupAgentRoutes({ catalogCache: runtimeModelCache, customAgents: customAgentsControl }));
app.use('/api', setupCustomAgentRoutes({
  service: agentRunAssembly.definitionService,
  isEnabled: customAgentsControl.isEnabled,
}));
app.use('/api', setupAgentRunRoutes({
  service: agentRunAssembly.routeService,
  sse: agentRunAssembly.sse,
  isEnabled: customAgentsControl.isEnabled,
}));
// Workflow runs are independent of custom agents: any Claude/Kiro chat can
// launch one.
// Runs a previous process left open lost their runtime with it.
workflowRunHub.recover();
// Multi-model runs re-attach (proposed) or settle (running) over what recover() wrote.
multiModel.start();
app.use('/api', setupWorkflowRunRoutes({ hub: workflowRunHub, backgroundSubagents: backgroundSubagentRegistry }));
app.use('/api', setupMultiModelRunRoutes({ orchestrator: multiModel, hub: workflowRunHub }));
const mobileAccessChoice = path.join(getMichiDataDir(), 'mobile-access.json');
const mobileAccess = createMobileAccess({
  target: () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Michi is not listening yet');
    const base = selfLoopbackBase(address.address, address.port);
    if (!base) throw new Error('Phone access needs Michi to listen on loopback or on every interface.');
    return base;
  },
  token: () => remoteAccessEnabled() ? remoteAccessToken() : null,
  unavailableReason: () => REQUIRE_AUTH || process.env.MICHI_CLOUD === '1'
    ? 'Mobile tunnels are available on personal Michi backends.'
    : !selfLoopbackBase(boundListenAddress ?? resolveListenHost(), Number(port))
      ? 'Phone access needs Michi to listen on loopback or on every interface.'
    : !servingFrontend
      ? 'Build the web UI with npm run build, then restart this backend before enabling phone access.' : null,
});
// Terminals for windows without Electron's PTY: phones, browsers and the
// desktop's remote workspaces. Electron's local terminals stay on IPC.
const ptyModule = loadNodePty();
if ('error' in ptyModule) log.info('boot', 'terminals unavailable: node-pty did not load', { error: ptyModule.error });
const terminalHost = new TerminalHost({
  spawn: 'spawn' in ptyModule ? ptyModule.spawn : null,
  unsupportedReason: 'Terminals need node-pty, which is not built on this machine. Run npm rebuild node-pty in its Michi folder, then restart Michi.',
});
const phoneTerminalChoice = path.join(getMichiDataDir(), 'phone-terminal.json');
let phoneTerminalEnabled = readPhoneTerminalChoice(phoneTerminalChoice);
const phoneTerminal = {
  enabled: () => phoneTerminalEnabled,
  set(enabled: boolean) {
    savePhoneTerminalChoice(phoneTerminalChoice, enabled);
    phoneTerminalEnabled = enabled;
    if (!enabled) terminalHost.disconnectPhones();
  },
};
app.use('/api', setupTerminalRoutes(terminalHost, {
  hosted: REQUIRE_AUTH || process.env.MICHI_CLOUD === '1',
  phoneAllowed: phoneTerminal.enabled,
}));
// The choice belongs to this personal backend, including the desktop host.
app.use('/api', setupMobileAccessRoutes(mobileAccess, {
  remember: (enabled, provider) => {
    try { saveMobileAccessChoice(mobileAccessChoice, enabled, provider); }
    catch (error) { log.warn('http', 'could not save phone access choice', { error: (error as Error).message }); }
  },
  terminal: phoneTerminal,
}));
// Settings → Update: a remote backend replaces itself with the latest main branch.
// Elsewhere the status explains why it cannot, and nothing runs.
app.use('/api', setupSelfUpdateRoutes(new SelfUpdater({
  repoRoot: path.resolve(__dirname, '../..'),
  dataDir: getMichiDataDir(),
  current: publicBuildInfo(runningBuild),
  remoteAccess: remoteAccessEnabled() && !REQUIRE_AUTH && process.env.MICHI_CLOUD !== '1',
})));
// Saved credentials belong to the desktop gateway, not execution backends.
if (!remoteAccessEnabled()) {
  app.use('/api', setupBackendConnectionRoutes());
} else if (process.env.MICHI_CLOUD !== '1') {
  // The desktop that connects to this remote browses its folders through the
  // tunnel. Requests reaching it already passed the bearer-token middleware.
  app.use('/api', setupHostDirectoryRoutes());
}
if (REQUIRE_AUTH) {
  // Admin routes — gated by MICHI_ADMIN_EMAILS env var (requireAdmin).
  // requireSession is already applied globally above for all /api/* paths
  // not in SESSION_PUBLIC_PATHS, so the login principal is populated here.
  app.use('/api/admin', setupAdminRoutes({ agentRunLifecycle }));
}
app.use('/api', setupUploadsRoutes());
app.use('/api', setupFilesRoutes());
app.use('/api', setupArtifactRoutes());
app.use('/api', setupDiffRoutes());
app.use('/api', setupMichiRoutes(chatManager));
app.use('/api', setupDigestRoutes(chatManager));
app.use('/api', setupPersistenceRoutes());
app.use('/api', setupAttentionRoutes(attentionService));
app.use('/api', setupInterruptedTurnRoutes());
configurePaneInspectionEventBus(agentRunAssembly.enabled ? agentRunAssembly.coordinator.events : undefined);
app.use('/api', setupPaneInspectionRoutes({ agentRunEvents: agentRunAssembly.enabled ? agentRunAssembly.coordinator.events : undefined }));
app.use('/api', setupConversationUpdatesRoutes());
app.use('/api', setupPagesRoutes());
app.use('/api', setupSpacesHomeRoutes({ liveWait: (nodeId) => chatHubLiveWait(chatHub, nodeId) }));
app.use('/api', setupHomeCardsRoutes());
app.use('/api', setupPageHelperRoutes());
app.use('/api', setupPageComponentRoutes());
configureHomeCardsSink(repositoryHomeCardsSink);
configureProgressCardLiveTurns((nodeId) => chatHubLiveTurn(chatHub, nodeId));
configureHomeLiveWait((nodeId) => chatHubLiveWait(chatHub, nodeId));
app.use('/api', setupSpacesHomeRunRoutes({ scheduler: scheduledJobScheduler }));
// Before the local-only /meta-agent routes: a remote connection's Update reaches its own Meta agent.
app.use('/api', setupMetaAgentRunNowRoutes({ scheduler: scheduledJobScheduler }));
app.use('/api', setupPageMaintenanceRoutes({ scheduler: scheduledJobScheduler }));
app.use('/api', setupBackupRoutes());
app.use('/api', setupSearchRoutes());
app.use('/api', setupVersionRoutes());
// Assistant and Meta agent controls belong to this backend's owner,
// including authenticated remote access. Cloud owners remain isolated.
if (process.env.MICHI_CLOUD !== '1') {
  app.use('/api', setupAssistantRoutes());
  app.use('/api', setupMetaAgentRoutes());
  app.use('/api', setupMetaAgentOverviewRoutes({ scheduler: scheduledJobScheduler }));
  // The Companion's storage and streams. The running engine's service once it
  // started (startCompanionEngine, after the listener and the scheduler);
  // until then, or when it does not run here, the no-op one stands in. Only
  // the scheduler lease holder runs the Companion (DESIGN R2.14).
  const idleCompanionService = createNoopCompanionService({
    conversationBusy: (nodeId) => chatHub.isActive(nodeId) || chatHub.isOwnerTurnActive(nodeId) || chatHub.hasPendingSelfTurn(nodeId),
    holdsSchedulerLease: () => scheduledJobScheduler?.status().active === true,
  });
  // An applied conversation.start card starts its conversation as the Meta agent's start_conversation does.
  setCompanionCardDeps({ startConversation: startCompanionDelegation });
  app.use('/api', createCompanionRouter({
    service: (): CompanionService => {
      const service = companion?.service ?? idleCompanionService;
      // Every beacon also tells automatic memory whether the panel still shows V (companionPanel); leaving it wakes extraction.
      return { ...service, onPresence: (input) => {
        if (companionPanel.update(input, Date.now()).leftPanel) wakeMemoryExtraction();
        return service.onPresence(input);
      } };
    },
    // The tray's "<name> is waiting for you": V's running turn asks for an approval or an answer.
    conversationWaiting: (nodeId) => chatHub.getPendingPermission(nodeId) !== null || chatHub.getPendingUserInput(nodeId) !== null,
  }));
  // A notice stored while no notifier has been connected for 30 s wakes the quit app (DESIGN-v2 §5.1).
  companionEvents.configureWake({ launcher: appLauncher });
  // While no window is open, conversations' approvals, questions and replies are notified from here (DESIGN-v2 §5.2).
  // The attention service's records of the same events keep it to one OS notification each: what a window raised
  // is not notified here, and what is notified here no window raises again.
  chatNotices = startChatNotices({
    hub: chatHub,
    isScheduledRun: (nodeId) => scheduledJobExecutor?.isRunningOn(nodeId) ?? false,
    attention: attentionService,
  });
}
app.use('/api', setupScheduledJobRoutes({ scheduler: scheduledJobScheduler, events: scheduledJobEvents }));
app.use('/api', setupMemoryRoutes());
app.use('/api', setupSkillRoutes());
app.use('/api', setupMemoryExtractionRoutes({ scheduler: scheduledJobScheduler }));

const frontendBuild = path.join(__dirname, '../../frontend/build');
const indexHtml = path.join(frontendBuild, 'index.html');

const servingFrontend = fs.existsSync(indexHtml);
if (servingFrontend) {
  setupSpaFallback(app, frontendBuild);
}

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(err); return; }
  const configError = jsonConfigErrorResponse(err);
  if (configError) {
    log.error('http', 'configuration request failed', { path: req.path, code: configError.body.code, err: err.message });
    res.status(configError.status).json(configError.body);
    return;
  }
  log.error('http', 'unhandled error', { path: req.path, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Something broke!' });
});

const listenHost = resolveListenHost();
startupMark('express_listen_start', { port: Number(port), host: listenHost });
const server = app.listen(Number(port), listenHost, (error?: Error) => {
  if (error) {
    // Express 5 hands bind errors (e.g. EADDRINUSE) to this callback instead
    // of throwing. Without a listener the process would keep its runtimes
    // running while every request goes to whoever holds the port, so exit.
    const code = (error as NodeJS.ErrnoException).code;
    log.error('boot', 'listen failed; exiting', {
      port: Number(port),
      host: listenHost,
      code,
      err: code === 'EADDRINUSE' ? `port ${port} is already in use on ${listenHost}` : error.message,
    });
    void gracefulShutdown().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }
  log.info('boot', 'listening', { port: Number(port), host: listenHost });
  markListening();
  const bound = server.address();
  if (bound && typeof bound !== 'string') boundListenAddress = bound.address;
  const selfBase = bound && typeof bound !== 'string' ? selfLoopbackBase(bound.address, bound.port) : null;
  if (!selfBase) {
    log.warn('boot', 'not listening on loopback: agents get no Michi tools, and phone access and page previews are off', { host: listenHost });
  }
  // Preview links point at this backend over loopback; the page view itself
  // is the built UI here, or the dev renderer under `npm run dev`.
  const devRenderer = process.env.MICHI_RENDERER_URL?.trim()
    || (process.env.MICHI_DEV_RENDERER === '1' ? 'http://localhost:3001' : '');
  configurePagePreview(REQUIRE_AUTH || process.env.MICHI_CLOUD === '1' || !selfBase
    || (!servingFrontend && !devRenderer)
    ? null
    : { apiBase: selfBase, renderer: servingFrontend ? '' : devRenderer });
  if (process.env.MICHI_MOBILE_ACCESS === '1' || readMobileAccessChoice(mobileAccessChoice, defaultMobileAccessProvider())) void mobileAccess.start().catch(error => log.warn('boot', 'mobile access start failed', { error: (error as Error).message }));
  startupMark('express_listen_ready', { port: Number(port) });
  printEnvInfo(Number(port));

  // Auth schema migration — idempotent, runs only when MICHI_REQUIRE_AUTH
  // is set so dev/Electron mode never touches auth.sqlite. Fire-and-forget
  // because the very first /api/auth/* request will fail until tables
  // exist anyway, and we don't want migration errors to block listening.
  if (REQUIRE_AUTH) {
    const tMig = Date.now();
    runAuthMigrations().then(() => {
      log.info('auth', 'migrations applied', { durMs: Date.now() - tMig });
    }).catch((err) => {
      log.error('auth', 'migrations failed', { err: (err as Error).message });
    });
  }
});

streamTransport.attach(server);

let shuttingDown = false;
const gracefulShutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopEventLoopDiagnostics();
  log.info('boot', 'shutting down');
  // First, so no poll or hidden turn starts any more; its MCP connections
  // close alongside the rest, and its last writes land before the DB closes.
  const companionStopped = companion?.stop().catch((error) => {
    log.warn('boot', 'companion stop failed', { err: error instanceof Error ? error.message : String(error) });
  });
  chatNotices?.stop();
  chatNotices = null;
  companionEvents.configureWake(null);
  chatHub.prepareForShutdown();
  // Decides pending notifications while the database is open; ignores teardown.
  attentionService.stop();
  streamTransport.close();
  clearInterval(agentRunCleanupTimer);
  clearInterval(idleSessionTimer);
  await agentRunCleanupPass;
  await idleSessionPass;
  // Record in-flight scheduled runs as interrupted while the DB is open.
  await scheduledJobScheduler?.stop().catch(() => {});
  scheduledJobExecutor?.dispose();
  await agentRunAssembly?.shutdown();
  sessionRegistry.clearAllSessions();
  // runtime.shutdown() disposes each session, which SIGTERM/SIGKILLs the
  // underlying claude/kiro child. Skipping this orphans those children: they
  // keep POSTing to /api/mcp/:slotId on the old port and the next backend
  // instance 404s them ("unknown mcp slot").
  await Promise.allSettled(listRuntimes().map((runtime) => runtime.shutdown()));
  await mobileAccess.stop();
  terminalHost.dispose();
  sshTunnelManager.shutdown();
  closeAllArtifactWatchers();
  // Coalesced workflow snapshots would otherwise lose their last revisions.
  workflowRunHub.flush();
  await stopMetaAgentMetrics();
  await companionStopped;
  closeDb();
  closeAuditDb();
  await shutdownDbWorker();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // server.close() only stops accepting new connections; it then WAITS for
    // every in-flight connection to drain. An ACP subprocess (kiro-cli) holds a
    // persistent keep-alive connection to /api/mcp/:slotId that never closes on
    // its own, so close() would hang indefinitely (its callback never fires) —
    // which is exactly what left orphaned backend + kiro-cli processes holding
    // the port on every dev restart. Force those sockets shut so close()
    // completes. runtime.shutdown() above has already signalled the children.
    server.closeAllConnections();
  });
};

// SIGINT/SIGTERM → terminate (Ctrl-C, container stop, Railway redeploy).
const shutdownAndExit = () => {
  void gracefulShutdown().finally(() => {
    log.info('boot', 'server closed; exiting');
    process.exit(0);
  });
  // Watchdog: never hang forever on a stuck server.close() or child.
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', shutdownAndExit);
process.on('SIGTERM', shutdownAndExit);
// After the listeners above, so a signal that arrived during startup reaches them.
releaseStartupSignals();

// SIGUSR2 → nodemon's dev-restart signal. Node's default action for an
// unhandled SIGUSR2 is to terminate immediately, which orphaned the claude
// children on every code save. Clean up first, then re-raise SIGUSR2 so
// nodemon performs the actual restart. `once` so the re-raised signal falls
// through to the default action instead of looping back into this handler.
if (process.platform !== 'win32') {
  process.once('SIGUSR2', () => {
    void gracefulShutdown().finally(() => {
      process.kill(process.pid, 'SIGUSR2');
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
