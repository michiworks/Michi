import type {
    AcpHandlerContext, AcpIncomingRequest, AcpPermissionRequest, AcpProfile, AcpSessionInfo, AcpUpdate,
} from '../acp/types';
import { formElicitationContent, formElicitationFields } from '../../core/formElicitation';
import { kiroArgs, kiroEnv, kiroSessionMeta, normalizeSessionInfo, type AcpSessionOptions, type KiroEngine } from './kiroProtocol';

/**
 * Launch override for an ACP agent that speaks Kiro's protocol but is not
 * kiro-cli (e.g. the Kiro Crew adapter). `args` receives the cold-start model.
 */
export interface AcpLaunch {
    bin: string;
    args: (model?: string) => string[];
    /** Cancel watchdog for this agent. Defaults to 5 seconds for kiro-cli. */
    cancelTimeoutMs?: number;
    /** A v2-compatible adapter with standard session/fork (kiro-cli v2 uses rewind). */
    standardFork?: boolean;
    /**
     * The agent speaks standard ACP only, none of kiro-cli's extensions
     * (`_kiro.dev/*`, `_kiro/*`, `_session/*`), e.g. Antigravity's `agy acp`.
     * Then no extension is sent: commands, compaction and steering answer as
     * unsupported; the model and reasoning go through the session's `model`
     * and `thought_level` config options; session/load is preceded by a
     * session/list check; a released session gets session/close; and the
     * prompt result's `usage` becomes a token usage summary. Default false.
     */
    standardAcp?: boolean;
    /**
     * The agent's environment, read at each start and passed as it is (no
     * kiroEnv entries: those are kiro-cli's). Absent: the child inherits this
     * process's environment; the host's spawnEnv is kiro-cli's base only.
     */
    env?: () => NodeJS.ProcessEnv;
}

export interface KiroAcpProfileOptions {
    extraArgs?: string[];
    childEnv?: NodeJS.ProcessEnv;
    /** kiro-cli, or the launch override's binary. */
    binaryPath: string;
    cwd: string;
    model?: string;
    engine?: KiroEngine;
    /** Replaces kiro-cli's argv (and binary: pass launch.bin as binaryPath). */
    launch?: AcpLaunch;
    /** Id of the owning runtime instance ("crew" for Kiro Crew). */
    runtimeId?: string;
    /** See AcpProcessOptions.preloadTools. */
    preloadTools?: () => boolean;
    /** The agent's name in user-visible errors, for a standardAcp launch only. Default (and otherwise): Kiro. */
    displayName?: string;
    /** See AcpProcessOptions.telemetryOff: kiro-cli exports no agent telemetry. Ignored for a standardAcp launch. */
    telemetryOff?: boolean;
}

/** Elicitation questions take user-input ids from here up, apart from the runtime's own ask_user ids. */
export const ELICITATION_REQUEST_ID_BASE = 1_000_000_000;

/**
 * Kiro's ACP personality: kiro-cli (or a launch override such as Kiro Crew's
 * adapter) spoken to with protocol version 1, Michi's client info, no client
 * capabilities (but a telemetry opt-out where asked) and no authenticate
 * step. Crew keeps Kiro's log label and
 * name, so its logs and errors read like Kiro's. A standardAcp launch
 * advertises form elicitation and answers it with Michi's user-input card.
 */
export class KiroAcpProfile implements AcpProfile {
    readonly runtimeId: string;
    readonly logLabel = 'kiro';
    readonly displayName: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    readonly engine: KiroEngine;
    /** Both engine generations speak ACP protocol version 1, and nothing else is accepted. */
    readonly protocolVersion = 1;
    readonly requireProtocolVersion = true;
    readonly clientInfo = { name: 'michi', version: '1.0.0' };
    readonly clientCapabilities: Record<string, unknown>;
    /** Kiro takes Michi's MCP slot whatever initialize advertises. */
    readonly mcpAttach = 'always' as const;
    readonly cancelTimeoutMs: number;
    /**
     * Only for a standardAcp launch: without the hook the client refuses an
     * agent's request at once, as it always has for kiro-cli.
     */
    readonly handleIncomingRequest?: (msg: AcpIncomingRequest, ctx: AcpHandlerContext) => Promise<boolean>;
    private readonly launch?: AcpLaunch;
    private readonly extraArgs: string[];
    private readonly childEnv?: NodeJS.ProcessEnv;
    private readonly preloadTools?: () => boolean;

    constructor(options: KiroAcpProfileOptions) {
        this.runtimeId = options.runtimeId ?? 'kiro';
        this.binaryPath = options.binaryPath;
        this.cwd = options.cwd;
        this.model = options.model;
        this.engine = options.engine ?? 'v2';
        this.launch = options.launch;
        this.extraArgs = options.extraArgs ?? [];
        this.childEnv = options.childEnv;
        this.preloadTools = options.preloadTools;
        this.cancelTimeoutMs = options.launch?.cancelTimeoutMs ?? 5_000;
        const standardAcp = options.launch?.standardAcp === true;
        this.displayName = standardAcp && options.displayName ? options.displayName : 'Kiro';
        // kiro-cli reads `_meta.kiro.telemetryEnabled` once, at initialize (probe P1b).
        this.clientCapabilities = standardAcp ? { elicitation: { form: {} } }
            : options.telemetryOff ? { _meta: { kiro: { telemetryEnabled: false } } } : {};
        if (standardAcp) {
            this.handleIncomingRequest = async (msg, ctx) => {
                if (msg.method !== 'elicitation/create') return false;
                await answerElicitation(msg, ctx);
                return true;
            };
        }
    }

    /** A launch override resolves its argv at every start. */
    get spawnArgs(): string[] {
        return this.launch ? this.launch.args(this.model) : [...kiroArgs(this.engine, this.model), ...this.extraArgs];
    }

    /** kiroEnv on the host's environment; a launch override's own env, else ours inherited. */
    spawnEnvironment(hostEnv: (() => NodeJS.ProcessEnv) | undefined): NodeJS.ProcessEnv | undefined {
        if (this.launch) return this.launch.env?.();
        if (this.childEnv) return this.childEnv;
        return hostEnv ? kiroEnv(this.engine, hostEnv(), this.preloadTools?.() ?? true) : undefined;
    }

    /** v3's additional directories and `_meta.kiro` (model, agent, workflows), then the caller's metadata in `_meta`. */
    sessionParams(kind: 'new' | 'load', options: AcpSessionOptions): Record<string, unknown> {
        const directories = this.engine === 'v3' && options.additionalDirectories?.length
            ? { additionalDirectories: [...options.additionalDirectories] } : {};
        if (kind === 'new') return {
            ...directories,
            ...kiroSessionMeta(this.engine, { modelId: this.model, ...options }),
            ...(options.metadata ? { _meta: { ...(kiroSessionMeta(this.engine, options)._meta as object), ...options.metadata } } : {}),
        };
        return { ...directories, ...kiroSessionMeta(this.engine, options), ...(options.metadata ? { _meta: { ...(kiroSessionMeta(this.engine, options)._meta as object), ...options.metadata } } : {}) };
    }

    /** v3's config options also answer as modes and models. */
    normalizeSessionInfo(info: AcpSessionInfo): AcpSessionInfo {
        return normalizeSessionInfo(info);
    }

    /**
     * v3 reports its own usage summary (source kiro-v3); v2's metering usage
     * takes the core's default. A standardAcp agent's prompt result carries
     * token counts (source acp), whatever its stop reason.
     */
    usageSummary(buffered: Record<string, any> | undefined, promptResult?: Record<string, any>): AcpUpdate | undefined {
        if (this.launch?.standardAcp) return promptTokenUsage(promptResult?.usage);
        return this.engine === 'v3' && buffered?.source === 'kiro-v3' ? { ...buffered, sessionUpdate: 'usage_summary' } : undefined;
    }

    /** v3 consent of an "always" answer, kept to this session and the exact resource. */
    permissionResultMeta(pending: AcpPermissionRequest, optionId: string): Record<string, unknown> {
        const option = pending.options?.find((option) => option.optionId === optionId);
        const consent = pending.meta?.kiro?.consent;
        if (this.engine !== 'v3' || !consent || !['allow_always', 'reject_always'].includes(option?.kind)) return {};
        // Limit provider persistence to this session and the exact triggering
        // resource, never infer a wildcard grant from a tool's display title.
        return { _meta: { kiro: { consent: { capability: consent.capability, scope: 'session',
            resource: consent.triggeringResource ?? consent.resource, workspaceRoot: consent.workspaceRoot,
        } } } };
    }
}

/** ACP's prompt-result usage names, by the usage_summary field each fills. */
const PROMPT_USAGE_FIELDS = {
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    cachedInputTokens: 'cachedReadTokens',
    reasoningOutputTokens: 'thoughtTokens',
    totalTokens: 'totalTokens',
} as const;

function promptTokenUsage(usage: unknown): AcpUpdate | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const tokens: Record<string, number> = {};
    for (const [field, name] of Object.entries(PROMPT_USAGE_FIELDS)) {
        const value = (usage as Record<string, unknown>)[name];
        if (typeof value === 'number' && Number.isFinite(value)) tokens[field] = value;
    }
    return Object.keys(tokens).length ? { sessionUpdate: 'usage_summary', source: 'acp', ...tokens } : undefined;
}

/**
 * ACP `elicitation/create` in form mode (agy's ask_question): shown as
 * Michi's user-input card, answered `accept` with the chosen values (typed
 * text in `<key>_other` when the form has one), or `cancel` when the user
 * skips it, the turn ends, or nothing can show it.
 */
async function answerElicitation(msg: AcpIncomingRequest, ctx: AcpHandlerContext): Promise<void> {
    const params = msg.params ?? {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const fields = params.mode === undefined || params.mode === 'form' ? formElicitationFields(params) : [];
    if (!sessionId || !ctx.hasSession(sessionId) || fields.length === 0) {
        ctx.reply(msg.id, { action: 'cancel' });
        return;
    }
    const requestId = ELICITATION_REQUEST_ID_BASE + ctx.nextUserInputRequestId();
    ctx.pushUpdate(sessionId, { sessionUpdate: 'user_input_request', requestId, questions: fields.map((field) => field.question) });
    const answers = await ctx.waitForUserInput(requestId, sessionId);
    ctx.pushUpdate(sessionId, { sessionUpdate: 'user_input_resolved', requestId, answers: answers ?? [] });
    ctx.reply(msg.id, answers ? { action: 'accept', content: formElicitationContent(fields, answers) } : { action: 'cancel' });
}
