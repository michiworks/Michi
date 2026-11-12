import { abortable } from '../runtimeLifecycle';

/**
 * Model-fallback wrapper that returns a real AssistantMessageEventStream
 * (has both `[Symbol.asyncIterator]` AND `.result()`), satisfying
 * pi-agent-core's `StreamFn` contract.
 *
 * Pattern: synchronously return an outer EventStream, drive it from an
 * async IIFE — identical to pi-ai's own faux/lazyStream pattern.
 */
export function streamSimpleWithFallback(
    piMod: any,
    upstreamProvider: string,
    models: any[],
    context: any,
    options: any,
    /** Bedrock: an auth error before any output refreshes credentials and retries the same model once. */
    authRetry?: { isAuthError(ev: any): boolean; refresh(): Promise<boolean> },
): any /* AssistantMessageEventStream */ {
    const outer = piMod.createAssistantMessageEventStream();
    const attempts = models.length > 0 ? models : [undefined];
    let authRetried = false;
    const fail = (error: unknown, modelId = '') => {
        const aborted = options?.signal?.aborted || (error as { name?: string })?.name === 'AbortError';
        outer.push({
            type: 'error',
            reason: aborted ? 'aborted' : 'error',
            error: {
                role: 'assistant', content: [], api: '', provider: upstreamProvider, model: modelId,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: aborted ? 'aborted' : 'error',
                errorMessage: error instanceof Error ? error.message : String(error),
                timestamp: Date.now(),
            },
        });
    };

    void (async () => {
        let lastError: any;

        for (let i = 0; i < attempts.length; i += 1) {
            const model = attempts[i];
            const modelId = model?.id;
            let yieldedAny = false;
            let retrySameModel = false;

            try {
                options?.signal?.throwIfAborted();
                const inner = piMod.streamSimple(model, context, options);
                let terminalSeen = false;
                for await (const ev of inner) {
                    if (ev?.type === 'error' && (options?.signal?.aborted || ev.reason === 'aborted' || ev.error?.stopReason === 'aborted')) {
                        outer.push({ ...ev, reason: 'aborted', error: { ...ev.error, stopReason: 'aborted' } });
                        return;
                    }
                    if (ev?.type === 'error' && !yieldedAny && authRetry && !authRetried && authRetry.isAuthError(ev)) {
                        authRetried = true;
                        const refresh = authRetry.refresh();
                        retrySameModel = options?.signal ? await abortable(refresh, options.signal) : await refresh;
                        if (retrySameModel) break;
                    }
                    // Still no output + error + more models to try → switch
                    if (ev?.type === "error" && !yieldedAny && i < attempts.length - 1) {
                        lastError = ev;
                        break;
                    }
                    yieldedAny = true;
                    outer.push(ev);
                    terminalSeen ||= ev?.type === 'done' || ev?.type === 'error';
                    // push of done/error event auto-resolves outer.result()
                }
                if (retrySameModel) {
                    i -= 1;
                    continue;
                }
                if (terminalSeen) return;
                if (yieldedAny) throw new Error('Pi provider stream ended without a terminal event');
            } catch (err) {
                if (options?.signal?.aborted || (err as { name?: string })?.name === 'AbortError' || yieldedAny || i === attempts.length - 1) {
                    fail(err, modelId);
                    return;
                }
                lastError = err;
            }
        }

        // All attempts exhausted without yielding any content
        if (lastError && typeof lastError === "object" && "type" in lastError) {
            outer.push(lastError);
        } else {
            fail(lastError ?? new Error('All model attempts failed'));
        }
    })().catch((error) => fail(error));

    return outer;
}
